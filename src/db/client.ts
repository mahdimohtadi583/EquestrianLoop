import { Prisma } from '@prisma/client'
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
// A third round closed a bypass of a completely different class. Rounds 1 and
// 2 were both about *object identity*: which handles the boundary hands out.
// They succeeded — no tenant-scoped delegate and no Prisma internal is
// obtainable from `prisma` any more. But the delegates the boundary does hand
// out are pre-bound to the real Prisma delegate and, until round 3, accepted
// the **real, full Prisma query-argument shape**. Prisma expresses relation
// traversal in the *arguments*, not in the receiver, so the entire tenant-
// scoped `Branch` table was reachable through the allowed `organization`
// delegate using ordinary Prisma syntax:
//
//   prisma.organization.findUnique({ where: {id}, include: { branches: true } })
//   prisma.organization.findUnique({ select: { branches: { select: {name:true} } } })
//   prisma.organization.create({ data: { ..., branches: { create: {...} } } })
//   prisma.organization.update({ where: {id}, data: { branches: { deleteMany: {} } } })
//   prisma.subscription.findUnique({ include: { organization: { include: { branches: true } } } })
//
// All five were verified to execute against the live database, reading and
// writing real `Branch` rows, with `npx tsc --noEmit` clean.
//
// The fix is `assertNoRelationTraversal` below: a single generic argument
// guard, applied uniformly to all 17 delegate methods, that forbids **any**
// relation traversal, not merely traversal into models currently known to be
// tenant-scoped. The set of relation field names per model is derived at
// module load from Prisma's own runtime metadata (`Prisma.dmmf.datamodel`,
// where `field.kind === 'object'` means "relation"), never hand-written, so
// every relation added by a later task is covered the moment the schema
// declares it — the same reasoning that made round 2 replace an allowlist of
// dangerous property names with a constructed minimal object.
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
  /**
   * @param path   Dotted path naming the offending access, e.g. `branch` or
   *               `organization.include`.
   * @param reason When given, this is an *argument-shape* rejection (fix round
   *               3) rather than a property-access rejection, and the message
   *               is built around the reason instead of the property-access
   *               text. The error class is deliberately the same one: from a
   *               caller's point of view both mean "you tried to reach past the
   *               platform-scoped boundary", and every existing test and
   *               `catch` that keys on this class keeps working.
   */
  constructor(path: string, reason?: string) {
    super(
      reason === undefined
        ? `Blocked access to prisma.${path} — the platform-scoped client exposes only the platform-level ` +
            `models (user, organization, subscription, auditLog) and their standard query methods, plus ` +
            `$connect/$disconnect. Tenant-scoped models, $transaction, raw SQL, and every Prisma internal ` +
            `are structurally absent from this object, not merely hidden. Tenant-scoped access must go ` +
            `through withTenantContext(organizationId, (tx) => ...) from '@/server/tenant/context' so the ` +
            `Postgres RLS session variable is set before the query runs.`
        : `Blocked query on prisma.${path} — ${reason} The platform-scoped client forbids every form of ` +
            `relation traversal (include / select / where / orderBy / _count / nested relation writes), ` +
            `because a single relation hop out of a platform-level model reaches rows this client is not ` +
            `allowed to read or write. Express the query as two separate platform-model queries, or, for ` +
            `tenant-scoped data, go through withTenantContext(organizationId, (tx) => ...) from ` +
            `'@/server/tenant/context' so the Postgres RLS session variable is set before the query runs.`
    )
    this.name = 'TenantScopedModelAccessError'
  }
}

// ---------------------------------------------------------------------------
// Relation-traversal guard (fix round 3).
//
// Everything from here to `assertNoRelationTraversal` implements one rule:
// a query issued through the platform-scoped client may not mention any
// relation field of the model it is issued against, in any argument position.
//
// The rule is categorical on purpose. It would be possible to allow the hops
// that happen to be harmless today (Organization -> Subscription is
// platform-to-platform) and forbid only the dangerous ones (Organization ->
// Branch). That is exactly the hand-maintained allowlist shape round 2 removed
// from this file: Tasks 3-21 each add more models and relations, and such a
// list is one forgotten edit away from being wrong. Phase 0 has no legitimate
// need for a one-call relation hop from the platform client — the plan and its
// tests already express every platform-to-platform lookup as two queries — so
// the categorical rule costs nothing and needs no maintenance.
// ---------------------------------------------------------------------------

/**
 * Every top-level query-argument key the four platform delegates' generated
 * `*Args` types declare across all 70 of them (verified by parsing
 * node_modules/.prisma/client/index.d.ts for @prisma/client v7.10.0), minus
 * `include`, which is rejected outright below.
 *
 * `_avg` / `_sum` are listed although no platform model currently has a
 * numeric field for them to apply to; they are ordinary scalar aggregations
 * and would appear the moment one is added.
 *
 * This is deny-by-default: an argument key that is not in this set is
 * rejected rather than forwarded unexamined. That is what makes the guard
 * hold if a future Prisma version introduces a *new* argument shape capable of
 * expressing relation access — the new key fails loudly here and forces this
 * file to be re-reviewed, exactly like DELEGATE_METHOD_KEYS does for the
 * method surface. The failure mode is a missing feature, never a silent hole.
 */
const ALLOWED_QUERY_ARG_KEYS = new Set<string>([
  'where',
  'select',
  'omit',
  'orderBy',
  'cursor',
  'take',
  'skip',
  'limit',
  'distinct',
  'data',
  'create',
  'update',
  'by',
  'having',
  'skipDuplicates',
  '_count',
  '_avg',
  '_sum',
  '_min',
  '_max',
])

/**
 * The only keys of a `WhereInput` whose values are themselves `WhereInput`s of
 * the same model. A relation filter can therefore only ever appear either as a
 * direct key of a `where` object or nested inside one of these — which is why
 * the `where` scan recurses through exactly these three and nothing else.
 * Recursing into arbitrary values would false-positive on JSON-column filters
 * (`Organization.settings`, `AuditLog.metadata`), whose *data* may legitimately
 * contain a key called `branches`.
 */
const WHERE_COMBINATOR_KEYS = new Set<string>(['AND', 'OR', 'NOT'])

/**
 * Inside a `select` or `include`, `_count` selects aggregate counts of
 * **related** rows and nothing else (the generated
 * `<Model>CountOutputTypeSelect` contains only relation names), so it is
 * rejected categorically there. At the *top level* of `aggregate`/`groupBy`
 * args, `_count` is an ordinary scalar aggregation and is allowed.
 */
const RELATION_COUNT_KEY = '_count'

/** Refuse to reason about argument trees nested deeper than this; fail closed. */
const MAX_ARG_DEPTH = 24

type ArgRecord = Record<string, unknown>

/**
 * Relation field names per delegate key (`organization` -> {branches,
 * subscription}), derived from Prisma's own runtime datamodel rather than
 * hand-written, so later tasks' schema additions are covered automatically.
 * A field with `kind === 'object'` is a relation field; its `name` is exactly
 * the key that would appear in include/select/where/orderBy/data.
 */
function buildRelationFieldNamesByDelegateKey(): ReadonlyMap<string, ReadonlySet<string>> {
  const byDelegateKey = new Map<string, ReadonlySet<string>>()
  for (const model of Prisma.dmmf.datamodel.models) {
    // Prisma derives a delegate key from a model name by lower-casing its
    // first character (`AuditLog` -> `auditLog`).
    const delegateKey = model.name.charAt(0).toLowerCase() + model.name.slice(1)
    const relationFieldNames = new Set<string>()
    for (const field of model.fields) {
      if (field.kind === 'object') {
        relationFieldNames.add(field.name)
      }
    }
    byDelegateKey.set(delegateKey, relationFieldNames)
  }
  return byDelegateKey
}

const RELATION_FIELD_NAMES_BY_MODEL = buildRelationFieldNamesByDelegateKey()

function isObjectLike(value: unknown): value is object {
  return typeof value === 'object' && value !== null
}

/**
 * Every string key Prisma could observe on an argument object.
 *
 * `for...in` is used rather than `Object.keys` because Prisma's argument
 * serialisation reads **inherited enumerable** properties too — verified live:
 * `findUnique(Object.create({ include: { branches: true } }))` returned related
 * `Branch` rows. A scan built on `Object.keys` alone would have missed it.
 * `getOwnPropertyNames` is unioned in so an own non-enumerable key cannot hide
 * from the scan either; over-scanning can only reject, never permit.
 */
function observableKeys(obj: object): string[] {
  const keys = new Set<string>()
  for (const key in obj) {
    keys.add(key)
  }
  for (const key of Object.getOwnPropertyNames(obj)) {
    keys.add(key)
  }
  return [...keys]
}

/**
 * Read every observable key of an argument container exactly once into a fresh
 * plain object, and scan/forward **that copy** instead of the caller's object.
 *
 * This removes a time-of-check/time-of-use hole that any inspect-then-forward
 * guard otherwise has: a caller could define `include` as a getter that yields
 * `undefined` to the guard and `{ branches: true }` to Prisma a moment later.
 * Because each key is read once here and the resulting snapshot is what Prisma
 * receives, the value the guard checked is by construction the value Prisma
 * executes.
 *
 * Only the structural *containers* are copied (args, where + its AND/OR/NOT
 * subtrees, select, orderBy, data, aggregate selectors). Leaf values — `Date`,
 * `Prisma.Decimal`, JSON payloads, `Prisma.DbNull`, field references — are
 * carried across by reference, so no fidelity is lost.
 *
 * A container whose prototype is neither `Object.prototype` nor `null` is
 * rejected rather than copied: snapshotting e.g. a `Date` would yield `{}`,
 * and silently turning `where: <something odd>` into `where: {}` would *widen*
 * a query. Rejecting fails closed instead. Prisma's own argument types require
 * plain object literals in all of these positions, so this cannot reject a
 * well-formed call.
 */
function materialize(obj: object, path: string): ArgRecord {
  const prototype = Object.getPrototypeOf(obj) as object | null
  if (prototype !== Object.prototype && prototype !== null) {
    throw new TenantScopedModelAccessError(
      path,
      `'${path}' is not a plain object literal (its prototype is neither Object.prototype nor null), ` +
        `so this boundary cannot take a faithful snapshot of it to inspect.`
    )
  }
  const source = obj as ArgRecord
  const copy: ArgRecord = {}
  for (const key of observableKeys(obj)) {
    copy[key] = source[key]
  }
  return copy
}

function rejectRelationKey(path: string, key: string, what: string): never {
  throw new TenantScopedModelAccessError(
    path,
    `'${path}.${key}' names a relation field, and this query uses it to ${what}.`
  )
}

function rejectTooDeep(path: string): never {
  throw new TenantScopedModelAccessError(
    path,
    `'${path}' nests more than ${MAX_ARG_DEPTH} levels deep, which this boundary refuses to inspect.`
  )
}

/** `where`, `cursor` (a WhereUniqueInput also accepts relation filters), `having`. */
function scanWhere(value: unknown, relations: ReadonlySet<string>, path: string, depth: number): unknown {
  if (depth > MAX_ARG_DEPTH) rejectTooDeep(path)
  if (!isObjectLike(value)) return value
  if (Array.isArray(value)) {
    return value.map((element, index) => scanWhere(element, relations, `${path}[${index}]`, depth + 1))
  }
  const copy = materialize(value, path)
  for (const key of Object.keys(copy)) {
    const entry = copy[key]
    if (entry === undefined) continue
    if (relations.has(key)) {
      // `{ where: { branches: { some: {...} } } }` never returns a Branch row,
      // but the boolean outcome still discloses tenant-row existence.
      rejectRelationKey(path, key, 'filter on related rows')
    }
    if (WHERE_COMBINATOR_KEYS.has(key)) {
      copy[key] = scanWhere(entry, relations, `${path}.${key}`, depth + 1)
    }
  }
  return copy
}

/** `select` and `omit` — field-name-keyed maps. */
function scanSelect(value: unknown, relations: ReadonlySet<string>, path: string): unknown {
  if (!isObjectLike(value)) return value
  if (Array.isArray(value)) {
    throw new TenantScopedModelAccessError(path, `'${path}' must be an object, not an array.`)
  }
  const copy = materialize(value, path)
  for (const key of Object.keys(copy)) {
    const entry = copy[key]
    if (entry === undefined) continue
    if (key === RELATION_COUNT_KEY) {
      throw new TenantScopedModelAccessError(
        path,
        `'${path}._count' aggregates over related rows (it is the only thing it can do inside a select).`
      )
    }
    // `false` is an explicit *exclusion* of the relation, which asks for
    // nothing; anything else (`true`, or a nested sub-shape) fetches it.
    if (relations.has(key) && entry !== false) {
      rejectRelationKey(path, key, 'fetch related rows')
    }
  }
  return copy
}

/** `orderBy` — an object or an array of objects. */
function scanOrderBy(value: unknown, relations: ReadonlySet<string>, path: string, depth: number): unknown {
  if (depth > MAX_ARG_DEPTH) rejectTooDeep(path)
  if (!isObjectLike(value)) return value
  if (Array.isArray(value)) {
    return value.map((element, index) => scanOrderBy(element, relations, `${path}[${index}]`, depth + 1))
  }
  const copy = materialize(value, path)
  for (const key of Object.keys(copy)) {
    const entry = copy[key]
    if (entry === undefined) continue
    if (relations.has(key)) {
      rejectRelationKey(path, key, 'order by related rows')
    }
    // `_count` / `_min` / `_max` / `_relevance` sub-objects are scalar-only by
    // Prisma's types; descend anyway so a relation name cannot hide in one.
    if (key.startsWith('_') && isObjectLike(entry)) {
      copy[key] = scanOrderBy(entry, relations, `${path}.${key}`, depth + 1)
    }
  }
  return copy
}

/**
 * `data` (create/update/updateMany, and the array form used by createMany /
 * createManyAndReturn), plus `upsert`'s `create` and `update` branches.
 *
 * A relation field is never assigned a scalar in Prisma — a foreign key is set
 * through its own scalar field (`organizationId`), so *any* value under a
 * relation-field key here is a nested relation write
 * (connect/create/createMany/update/updateMany/upsert/delete/deleteMany/
 * disconnect/set) and is rejected outright.
 */
function scanData(value: unknown, relations: ReadonlySet<string>, path: string, depth: number): unknown {
  if (depth > MAX_ARG_DEPTH) rejectTooDeep(path)
  if (!isObjectLike(value)) return value
  if (Array.isArray(value)) {
    return value.map((element, index) => scanData(element, relations, `${path}[${index}]`, depth + 1))
  }
  const copy = materialize(value, path)
  for (const key of Object.keys(copy)) {
    if (copy[key] === undefined) continue
    if (relations.has(key)) {
      rejectRelationKey(path, key, 'write through to related rows')
    }
  }
  return copy
}

/** Top-level `_count` / `_avg` / `_sum` / `_min` / `_max` on aggregate / groupBy. */
function scanAggregateSelection(value: unknown, relations: ReadonlySet<string>, path: string): unknown {
  // `_count: true` is the common, entirely scalar form.
  if (!isObjectLike(value)) return value
  if (Array.isArray(value)) {
    throw new TenantScopedModelAccessError(path, `'${path}' must be an object or true, not an array.`)
  }
  const copy = materialize(value, path)
  for (const key of Object.keys(copy)) {
    if (copy[key] === undefined) continue
    if (relations.has(key)) {
      rejectRelationKey(path, key, 'aggregate over related rows')
    }
    if (key === 'select' || key === 'include') {
      throw new TenantScopedModelAccessError(
        path,
        `'${path}.${key}' is the relation-count shape (_count: { select: { <relation>: true } }).`
      )
    }
  }
  return copy
}

/** `by` and `distinct` — a scalar field name or array of them. */
function scanFieldNameList(value: unknown, relations: ReadonlySet<string>, path: string): unknown {
  const copy = Array.isArray(value) ? [...(value as unknown[])] : value
  const names = Array.isArray(copy) ? copy : [copy]
  for (const name of names) {
    if (typeof name === 'string' && relations.has(name)) {
      throw new TenantScopedModelAccessError(path, `'${path}' names the relation field '${name}'.`)
    }
  }
  return copy
}

/**
 * The guard every exposed delegate method runs before forwarding.
 *
 * Returns the snapshot of `args` that must be handed to Prisma (see
 * `materialize` for why the caller's own object is not forwarded). Throws
 * `TenantScopedModelAccessError` if the call expresses any relation traversal,
 * or uses an argument key this boundary does not recognise.
 */
function assertNoRelationTraversal(modelKey: string, args: unknown): unknown {
  const relations = RELATION_FIELD_NAMES_BY_MODEL.get(modelKey)
  if (relations === undefined) {
    // Unreachable: enforced at module load by buildPlatformDelegate.
    throw new TenantScopedModelAccessError(
      modelKey,
      `the Prisma datamodel has no model matching the delegate '${modelKey}', so its relation fields ` +
        `cannot be determined.`
    )
  }

  // `findMany()`, `count()` etc. are legitimately called with no arguments.
  if (args === undefined || args === null) return args

  if (!isObjectLike(args) || Array.isArray(args)) {
    throw new TenantScopedModelAccessError(
      modelKey,
      `query arguments must be a plain object, got ${Array.isArray(args) ? 'an array' : typeof args}.`
    )
  }

  const copy = materialize(args, modelKey)
  for (const key of Object.keys(copy)) {
    const value = copy[key]
    if (value === undefined) continue

    if (key === 'include') {
      // `include: null` is how Prisma's own types spell "no include", so it is
      // treated as absent exactly like `include: undefined` (which the
      // `value === undefined` check above already skipped). Only a present,
      // non-nullish include is a request for related records.
      if (value === null) continue
      // `include` exists for exactly one purpose: fetching related records
      // (relations, or `_count` of relations). There is no scalar-only use of
      // it, so it is rejected whenever present and non-nullish — including the
      // vacuous `include: {}`. Rejecting the key itself, rather than its
      // contents, is also what closes the two-hop case
      // (`subscription.findUnique({ include: { organization: { include: {
      // branches: true } } } })`): the outer key is refused before any deeper
      // shape can be constructed. `include: undefined` / `include: null` are
      // treated as absent, which is how Prisma treats them.
      throw new TenantScopedModelAccessError(
        modelKey,
        `'${modelKey}.include' requests related records, which is the one thing include can express.`
      )
    }

    if (!ALLOWED_QUERY_ARG_KEYS.has(key)) {
      throw new TenantScopedModelAccessError(
        modelKey,
        `'${key}' is not a query argument this boundary recognises, so it cannot be shown not to express ` +
          `relation access; it is refused rather than forwarded unexamined.`
      )
    }

    const path = `${modelKey}.${key}`
    switch (key) {
      case 'where':
      case 'cursor':
      case 'having':
        copy[key] = scanWhere(value, relations, path, 1)
        break
      case 'select':
      case 'omit':
        copy[key] = scanSelect(value, relations, path)
        break
      case 'orderBy':
        copy[key] = scanOrderBy(value, relations, path, 1)
        break
      case 'data':
      case 'create':
      case 'update':
        copy[key] = scanData(value, relations, path, 1)
        break
      case 'by':
      case 'distinct':
        copy[key] = scanFieldNameList(value, relations, path)
        break
      case '_count':
      case '_avg':
      case '_sum':
      case '_min':
      case '_max':
        copy[key] = scanAggregateSelection(value, relations, path)
        break
      default:
        // take / skip / limit / skipDuplicates — scalars with no field names
        // in them at all.
        break
    }
  }
  return copy
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
/**
 * Prisma's *fluent API*: the object returned by `findUnique` / `findFirst` /
 * `create` / `update` / `upsert` / `delete` (and their OrThrow variants) is not
 * a plain promise — it is a `Prisma__<Model>Client`, and it carries one method
 * per relation of that model. Found and proved live while building this round's
 * guard:
 *
 *   await prisma.organization.findUnique({ where: { id } }).branches()
 *   // -> [{ id, organizationId, name: 'secret-branch', ... }]  a real, full,
 *   //    unrestricted tenant-scoped Branch row.
 *
 * Its own keys are `["branches","subscription","spec","then","catch","finally",
 * "requestTransaction"]`. This is relation traversal with *no query arguments
 * involved at all*, so the argument guard above cannot see it: the capability
 * is on the **return value**.
 *
 * Closed the same way round 2 closed `$parent`: the fluent client is never
 * handed out. Every returned thenable is replaced by a minimal, frozen,
 * null-prototype object carrying only `then` / `catch` / `finally`, forwarded
 * to the real one. The relation methods are structurally absent rather than
 * blocked, and `spec` / `requestTransaction` (noted as unwrapped risks in round
 * 2's report) are gone with them. Laziness is preserved — the underlying query
 * still runs only when the consumer calls `then`.
 *
 * Detection is duck-typed (`typeof result.then === 'function'`) rather than a
 * list of which methods are fluent, so a future Prisma that makes another
 * method fluent is covered without an edit.
 */
function sealQueryResult(modelKey: string, methodKey: string, result: unknown): unknown {
  if (!isObjectLike(result)) return result
  const pending = result as {
    then?: unknown
    catch?: unknown
    finally?: unknown
  }
  if (typeof pending.then !== 'function') return result

  const forward = (key: 'then' | 'catch' | 'finally') => {
    const method = pending[key]
    if (typeof method !== 'function') return undefined
    return (...callbacks: unknown[]): unknown =>
      (method as (...args: unknown[]) => unknown).apply(pending, callbacks)
  }

  const target: MinimalTarget = Object.create(null) as MinimalTarget
  for (const key of ['then', 'catch', 'finally'] as const) {
    const forwarded = forward(key)
    if (forwarded !== undefined) {
      target[key] = forwarded
    }
  }
  target[Symbol.toStringTag] = 'PlatformScopedQuery'
  target[NODE_INSPECT_CUSTOM] = () => `[PlatformScopedQuery: ${modelKey}.${methodKey}]`

  return sealMinimalTarget(target, `${modelKey}.${methodKey}().`)
}

/**
 * One wrapper factory for all 17 delegate methods: run the relation-traversal
 * guard, forward the *snapshot* it returns to the pre-bound real method, and
 * seal whatever comes back so Prisma's fluent relation API cannot be reached
 * through the result.
 *
 * Deliberately an arrow function so it has no `prototype` and only `length` /
 * `name` as own properties — the same shape a bound function has, which is
 * what the boundary's "handing out the method does not hand out the delegate"
 * property and its regression test both rest on.
 */
function guardDelegateMethod(
  modelKey: string,
  methodKey: string,
  boundMethod: (...args: unknown[]) => unknown
): (...args: unknown[]) => unknown {
  const guarded = (...callArgs: unknown[]): unknown => {
    // Preserve a genuine zero-argument call rather than turning it into
    // `method(undefined)`.
    if (callArgs.length === 0) return sealQueryResult(modelKey, methodKey, boundMethod())
    if (callArgs.length > 1) {
      // Every generated delegate method declares exactly one parameter. A
      // second positional argument is therefore something this guard has not
      // inspected, so it is refused rather than forwarded.
      throw new TenantScopedModelAccessError(
        `${modelKey}.${methodKey}`,
        `it was called with ${callArgs.length} arguments; every Prisma delegate method takes exactly one.`
      )
    }
    return sealQueryResult(modelKey, methodKey, boundMethod(assertNoRelationTraversal(modelKey, callArgs[0])))
  }
  Object.defineProperty(guarded, 'name', { value: methodKey, configurable: true })
  return guarded
}

function buildPlatformDelegate(modelKey: string): unknown {
  const realDelegate = (rawPrisma as unknown as Record<string, Record<string, unknown>>)[modelKey]

  if (!RELATION_FIELD_NAMES_BY_MODEL.has(modelKey)) {
    throw new Error(
      `Tenant-access boundary: no model in Prisma.dmmf.datamodel maps to the delegate '${modelKey}', so its ` +
        `relation fields cannot be derived and the relation-traversal guard cannot be built. Known delegates: ` +
        `${[...RELATION_FIELD_NAMES_BY_MODEL.keys()].join(', ')}. Re-review src/db/client.ts against the ` +
        `generated client before changing PLATFORM_MODEL_KEYS.`
    )
  }

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
    target[methodKey] = guardDelegateMethod(
      modelKey,
      methodKey,
      (method as (...args: unknown[]) => unknown).bind(realDelegate)
    )
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
