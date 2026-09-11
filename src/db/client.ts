import { rawPrisma } from './raw-client'

// `permission` joins this allowlist in Task 3, once the Permission model actually exists in
// schema.prisma (it's a fixed, global catalog — the ~13 permission-key rows seeded once — not
// per-tenant data, and carries no organizationId column for RLS to key on). Referencing it here
// before Task 3 adds the model is a TypeScript compile error against the generated Prisma Client
// type, not just premature — keep this list in lockstep with which models actually exist.
const PLATFORM_MODEL_KEYS = new Set(['user', 'organization', 'subscription', 'auditLog'])
const ALSO_ALLOWED = new Set(['$connect', '$disconnect'])

// Well-known symbols that JavaScript/Node itself may probe on *any* object
// (e.g. Symbol.toStringTag affects what Object.prototype.toString.call(x)
// returns; util.inspect's custom-inspect symbol affects console.log output).
// These carry no query or transaction capability, so exposing them is safe.
// Every other symbol-keyed property — including Prisma's own internal
// symbols, if it has any — must be blocked exactly like an unlisted string
// property. Do NOT blanket-allow all symbols; add one here only if you find
// a concrete case that breaks without it.
const ALLOWED_SYMBOLS = new Set<symbol>([Symbol.toStringTag, Symbol.iterator])

export class TenantScopedModelAccessError extends Error {
  constructor(prop: string) {
    super(
      `Blocked direct access to prisma.${prop} — this is not one of the platform-level models ` +
        `(user, organization, subscription, auditLog). Tenant-scoped models, and any ` +
        `transaction or raw SQL, must go through withTenantContext(organizationId, (tx) => ...) from ` +
        `'@/server/tenant/context' so the Postgres RLS session variable is set before the query runs.`
    )
    this.name = 'TenantScopedModelAccessError'
  }
}

type PlatformScopedClient = Pick<typeof rawPrisma, 'user' | 'organization' | 'subscription' | 'auditLog' | '$connect' | '$disconnect'>

export const prisma: PlatformScopedClient = new Proxy(rawPrisma, {
  get(target, prop) {
    if (typeof prop === 'symbol') {
      if (!ALLOWED_SYMBOLS.has(prop)) {
        throw new TenantScopedModelAccessError(prop.toString())
      }
    } else if (!PLATFORM_MODEL_KEYS.has(prop) && !ALSO_ALLOWED.has(prop)) {
      // Deliberately no underscore allowance here (and no receiver passed
      // to Reflect.get below): every underscore-prefixed internal —
      // _request, _transactionWithCallback, _transactionWithArray,
      // _createItxClient, _engine, _originalClient, etc. — is exactly as
      // dangerous as `branch` or `$transaction` and must be blocked the
      // same way. `branch`, `$transaction`, `_request`, and
      // `_transactionWithCallback` all throw here.
      throw new TenantScopedModelAccessError(prop)
    }

    // Read from `target` (the real client), never from `receiver` (the
    // proxy). Prisma's model delegates and $connect/$disconnect are backed
    // by lazy getters / methods that internally touch other internal
    // properties (e.g. _engine) via `this`. If `this` were ever the proxy —
    // which is what passing `receiver` through Reflect.get produces, and
    // what plain `obj.method()` call syntax produces regardless of the
    // trap's receiver — that internal access would recurse back into this
    // very trap and hit the allowlist check above. Binding every returned
    // function to `target` closes that off structurally: allowed values
    // (`user`, `organization`, `$connect`, `$disconnect`, ...) keep working
    // because their internals now resolve against the real client, and
    // nothing routes back through the proxy to re-derive a way around the
    // allowlist (there previously was such a route, via the blanket
    // underscore allowance above, which this replaces).
    const value = Reflect.get(target, prop)
    return typeof value === 'function' ? value.bind(target) : value
  },
}) as PlatformScopedClient
