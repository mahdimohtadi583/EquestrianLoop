import { rawPrisma } from './raw-client'

// ---------------------------------------------------------------------------
// The tenant-access boundary.
//
// SECURITY MODEL (read this before changing anything below).
//
// Two earlier versions of this file wrapped `rawPrisma` — the full, wholly
// unrestricted Prisma client — in a `Proxy` whose only trap was `get`, and
// tried to make that trap reject everything outside an allowlist. That shape
// is unsealable, and was broken twice:
//
//   Round 1: the `get` trap forwarded `receiver` (the proxy) into
//            `Reflect.get`, so Prisma's own internals re-entered the trap with
//            `this === proxy`; combined with a blanket `_`-prefix allowance,
//            `prisma._transactionWithCallback({ callback: (tx) =>
//            tx.branch.findMany() })` returned unrestricted tenant rows.
//
//   Round 2: a `get`-only Proxy does not intercept the other fundamental
//            object operations. Per the ECMAScript Proxy semantics, an
//            undefined trap forwards the operation *straight to the target*.
//            With the target being `rawPrisma` itself, that meant:
//              Object.getOwnPropertyDescriptor(prisma, '_originalClient').value
//            handed back the real client (and `_engine` the raw query-engine
//            handle) without the `get` trap ever running. `Reflect.ownKeys`,
//            `in`, and `Object.getPrototypeOf` leaked the same way.
//
// The root cause is structural, not a missing case: when the proxy target is
// the dangerous object, *every* trap you do not write is an open door, and the
// set of fundamental operations (~13) plus whatever future engines/tooling can
// reach is not something an allowlist over a rich object can ever fully cover.
// Enumerating traps is an arms race that only ever draws even.
//
// The fix inverts the relationship: the proxy target is now a **minimal object
// this module constructs**, containing nothing but the explicitly allowed
// values. `rawPrisma` is never the target, is never stored as a property of
// the target, and is not reachable from any value on it. Every un-trapped
// fundamental operation therefore forwards to an object that simply does not
// possess `branch`, `$transaction`, `_engine`, `_originalClient` or any other
// internal — so there is nothing for those operations to leak, independent of
// which traps exist. Leaking a property requires the target to have it; the
// target does not have it.
//
// The `get` trap is retained on top of that minimal target purely so the
// boundary fails *loudly* (a thrown `TenantScopedModelAccessError` naming the
// mistake) instead of silently returning `undefined`. It is no longer the
// thing holding the boundary up.
//
// The same treatment is applied one level down, to the four model delegates.
// `rawPrisma.user` is a real Prisma object with an own `$parent` property that
// is `rawPrisma` itself (verified by identity: `rawPrisma.user.$parent ===
// rawPrisma`), so `prisma.user.$parent.branch.findMany()` and
// `prisma.user.$parent.$transaction(...)` were both live, unrestricted tenant
// queries reachable through an *allowed* access — a bypass entirely
// independent of the outer proxy's trap coverage. Each exposed delegate is
// therefore rebuilt the same way: a minimal, frozen object holding only the
// delegate's own documented query methods (pre-bound to the real delegate) and
// its `fields` metadata. `$parent` is not copied, so it is structurally absent
// rather than merely blocked.
//
// INHERENT LIMIT, stated honestly: this is an in-process, same-realm boundary.
// Code that can already run arbitrary JavaScript in this process can bypass it
// trivially and without touching this file at all (`import { rawPrisma } from
// './raw-client'`, or `fn.constructor('return ...')`). The boundary's purpose
// is to make *accidental* unscoped tenant access impossible — a forgotten
// `withTenantContext` fails loudly at the first line — not to sandbox hostile
// code. Nothing below claims otherwise.
// ---------------------------------------------------------------------------

// `permission` joins this allowlist in Task 3, once the Permission model actually exists in
// schema.prisma (it's a fixed, global catalog — the ~13 permission-key rows seeded once — not
// per-tenant data, and carries no organizationId column for RLS to key on). Referencing it here
// before Task 3 adds the model is a TypeScript compile error against the generated Prisma Client
// type, not just premature — keep this list in lockstep with which models actually exist.
const PLATFORM_MODEL_KEYS = ['user', 'organization', 'subscription', 'auditLog'] as const

// The only non-model members of the client that are exposed. `$transaction` is
// deliberately absent: its callback hands back an unrestricted `tx` that the
// boundary cannot guard, because it is a *returned value*, not a property
// read. Raw-SQL escape hatches ($queryRaw*, $executeRaw*, $runCommandRaw) are
// absent for the same reason they always were — they bypass model scoping
// entirely. Multi-step writes go through Task 9's `withTenantContext`.
const ALSO_ALLOWED_CLIENT_KEYS = ['$connect', '$disconnect'] as const

// Exactly the members the generated `Prisma.<Model>Delegate` interface
// declares (verified against node_modules/.prisma/client/index.d.ts for
// @prisma/client v7.10.0), so the runtime surface and the TypeScript type
// agree with no gap in either direction.
//
// Deliberately NOT copied, even though they exist on the real runtime delegate
// object: `$parent` (IS `rawPrisma` — the bypass this round closes), `$name` /
// `name` (undeclared runtime extras, no reason to expose), and `findRaw` /
// `aggregateRaw` (MongoDB-only raw commands, inert against this Postgres
// datasource, undeclared in the delegate type, and "raw" is outside this
// boundary's sanctioned surface by design).
const DELEGATE_METHOD_KEYS = [
  'findUnique',
  'findUniqueOrThrow',
  'findFirst',
  'findFirstOrThrow',
  'findMany',
  'create',
  'createMany',
  'createManyAndReturn',
  'update',
  'updateMany',
  'updateManyAndReturn',
  'upsert',
  'delete',
  'deleteMany',
  'aggregate',
  'groupBy',
  'count',
] as const

// Non-callable delegate members that are pure schema metadata. `fields` is a
// plain record of FieldRef objects ({ modelName, name, typeName, isList,
// isEnum } — all primitives, prototype carries only `_toGraphQLInputType`),
// so it holds no query capability and no back-reference to any client.
const DELEGATE_DATA_KEYS = ['fields'] as const

const NODE_INSPECT_CUSTOM = Symbol.for('nodejs.util.inspect.custom')

// Well-known symbols that JavaScript/Node itself may probe on *any* object
// (Symbol.toStringTag drives Object.prototype.toString.call(x);
// nodejs.util.inspect.custom drives console.log/util.inspect formatting).
// Reading these must not throw, or routine logging and test-runner diffing
// blow up. They carry no query capability. The values actually served for
// them are defined by this module on the minimal targets below — never
// forwarded from Prisma — so allowing them exposes only strings and a
// string-returning function. Every other symbol, including any Prisma
// internal symbol, is blocked exactly like an unlisted string key. Do NOT
// blanket-allow symbols.
const ALLOWED_SYMBOLS = new Set<symbol>([Symbol.toStringTag, Symbol.iterator, NODE_INSPECT_CUSTOM])

export class TenantScopedModelAccessError extends Error {
  constructor(path: string) {
    super(
      `Blocked access to prisma.${path} — the platform-scoped client exposes only the platform-level ` +
        `models (user, organization, subscription, auditLog) and their standard query methods, plus ` +
        `$connect/$disconnect. Tenant-scoped models, $transaction, raw SQL, and every Prisma internal ` +
        `are structurally absent from this object, not merely hidden. Tenant-scoped access must go ` +
        `through withTenantContext(organizationId, (tx) => ...) from '@/server/tenant/context' so the ` +
        `Postgres RLS session variable is set before the query runs.`
    )
    this.name = 'TenantScopedModelAccessError'
  }
}

type MinimalTarget = Record<string | symbol, unknown>

/**
 * Freeze a constructed minimal object and wrap it in the boundary Proxy.
 *
 * The target is frozen so that the operations this proxy intentionally does
 * not trap (`set`, `defineProperty`, `deleteProperty`, `setPrototypeOf`,
 * `preventExtensions`) forward to a non-extensible, non-writable object and
 * therefore fail, rather than letting a caller graft new properties onto the
 * boundary object. Freezing also forces every exposed value to be resolved
 * eagerly at construction time, which in turn keeps the `get` trap invariant-
 * safe: for a non-configurable, non-writable own data property the trap MUST
 * return the identical value every time, so no per-access re-binding or
 * re-wrapping may happen in here.
 *
 * `pathPrefix` only shapes the error message ('' for the client itself,
 * 'user.' for the user delegate).
 */
function sealMinimalTarget<T>(target: MinimalTarget, pathPrefix: string): T {
  return new Proxy(Object.freeze(target), {
    get(frozenTarget, prop) {
      if (typeof prop === 'symbol') {
        if (!ALLOWED_SYMBOLS.has(prop)) {
          throw new TenantScopedModelAccessError(`${pathPrefix}${prop.toString()}`)
        }
      } else if (!Object.prototype.hasOwnProperty.call(frozenTarget, prop)) {
        // The allowlist and the target are the same thing now: the target was
        // built by copying allowed values one by one, so "does the target own
        // this key" IS the allowlist check. There is no separate list that can
        // drift out of sync with what the object actually holds.
        throw new TenantScopedModelAccessError(`${pathPrefix}${prop}`)
      }
      // Never forward `receiver`: `Reflect.get(t, prop)` defaults the receiver
      // to the target, so nothing can route `this` back through this proxy.
      // (Round 1's fix; preserved. It matters much less now that the target is
      // inert, but costs nothing and keeps the property true by construction.)
      return Reflect.get(frozenTarget, prop)
    },
  }) as T
}

/**
 * Rebuild one Prisma model delegate as a minimal object holding only its
 * documented query methods and `fields`.
 *
 * Every method is pre-bound to the *real* delegate. Two reasons: legitimate
 * calls keep working no matter what `this` the call site supplies (the real
 * delegate's methods happen not to read `this` in v7.10.0, but relying on that
 * would be fragile), and a bound function's `[[BoundThis]]` is not readable
 * from JavaScript and cannot be re-targeted by a further `.call`/`.bind`, so
 * handing out the bound method does not hand out the delegate.
 */
function buildPlatformDelegate(modelKey: string): unknown {
  const realDelegate = (rawPrisma as unknown as Record<string, Record<string, unknown>>)[modelKey]

  const target: MinimalTarget = Object.create(null) as MinimalTarget

  for (const methodKey of DELEGATE_METHOD_KEYS) {
    const method = realDelegate[methodKey]
    if (typeof method !== 'function') {
      // Fail loudly at module load rather than silently exposing a smaller
      // surface: if Prisma renames or drops a delegate method, that is a
      // change this boundary must be re-reviewed against, not absorbed.
      throw new Error(
        `Tenant-access boundary: expected prisma.${modelKey}.${methodKey} to be a function on the generated ` +
          `Prisma delegate, got ${typeof method}. The generated client's delegate surface has changed; ` +
          `re-review src/db/client.ts against it before updating DELEGATE_METHOD_KEYS.`
      )
    }
    target[methodKey] = (method as (...args: unknown[]) => unknown).bind(realDelegate)
  }

  for (const dataKey of DELEGATE_DATA_KEYS) {
    const value = realDelegate[dataKey]
    if (value !== undefined) {
      target[dataKey] = value
    }
  }

  target[Symbol.toStringTag] = `PlatformScopedDelegate(${modelKey})`
  target[NODE_INSPECT_CUSTOM] = () => `[PlatformScopedDelegate: ${modelKey}]`

  return sealMinimalTarget(target, `${modelKey}.`)
}

function buildPlatformScopedClient(): MinimalTarget {
  const target: MinimalTarget = Object.create(null) as MinimalTarget

  for (const modelKey of PLATFORM_MODEL_KEYS) {
    target[modelKey] = buildPlatformDelegate(modelKey)
  }

  for (const clientKey of ALSO_ALLOWED_CLIENT_KEYS) {
    const method = (rawPrisma as unknown as Record<string, unknown>)[clientKey]
    if (typeof method !== 'function') {
      throw new Error(
        `Tenant-access boundary: expected rawPrisma.${clientKey} to be a function, got ${typeof method}.`
      )
    }
    target[clientKey] = (method as (...args: unknown[]) => unknown).bind(rawPrisma)
  }

  target[Symbol.toStringTag] = 'PlatformScopedPrismaClient'
  target[NODE_INSPECT_CUSTOM] = () =>
    '[PlatformScopedPrismaClient: user, organization, subscription, auditLog, $connect, $disconnect]'

  return target
}

type PlatformScopedClient = Pick<
  typeof rawPrisma,
  'user' | 'organization' | 'subscription' | 'auditLog' | '$connect' | '$disconnect'
>

/**
 * The only Prisma handle application code under `src/app` / `src/server` may
 * import. Exposes the four platform-level models and `$connect`/`$disconnect`
 * and literally nothing else — `rawPrisma` is not reachable from this object
 * by any property read, descriptor query, key enumeration, `in` check, or
 * prototype walk.
 */
export const prisma: PlatformScopedClient = sealMinimalTarget<PlatformScopedClient>(
  buildPlatformScopedClient(),
  ''
)
