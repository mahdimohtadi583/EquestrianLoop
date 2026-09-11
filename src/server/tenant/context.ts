import { Prisma } from '@prisma/client'
// This is the one sanctioned application-layer import of the unrestricted
// client, per src/db/raw-client.ts's docstring. Everything else under src/app
// and src/server must use `prisma` from '@/db/client' (platform models) or
// `withTenantContext` from this file (tenant-scoped models).
import { rawPrisma } from '@/db/raw-client'

/**
 * The exact shape every `organizationId` in this codebase has.
 *
 * `Organization.id` is `@default(cuid())` (prisma/schema.prisma), and Prisma
 * v7's `cuid()` emits cuid v1: the literal character `c` followed by 24
 * lowercase-alphanumeric characters, 25 characters in total. That was verified
 * empirically against this project's live database rather than recalled — all
 * 274 `Organization.id` values present, and every `Customer.id`, `Branch.id`,
 * `Role.id` and `User.id`, match `^c[a-z0-9]{24}$` with zero exceptions, and
 * `length(id)` is 25 for every row.
 *
 * If the schema's id strategy ever changes (uuid(), a different cuid version, a
 * database-generated key), this constant must change with it — the failure mode
 * is a thrown `InvalidOrganizationIdError` on every call, which is loud and
 * immediate rather than silent.
 */
const CUID_PATTERN = /^c[a-z0-9]{24}$/

export class InvalidOrganizationIdError extends Error {
  constructor(received: unknown) {
    const rendered =
      typeof received === 'string'
        ? JSON.stringify(received.length > 80 ? `${received.slice(0, 80)}…` : received)
        : `${typeof received}`
    super(
      `withTenantContext() was given ${rendered} as an organizationId, which is not a well-formed cuid ` +
        `(/^c[a-z0-9]{24}$/, as produced by Prisma's cuid() default on Organization.id). Refusing to build ` +
        `the SET LOCAL statement. Every organizationId in this system is server-generated; a value that ` +
        `does not match this shape did not come from the database, so it is rejected before it can reach SQL.`
    )
    this.name = 'InvalidOrganizationIdError'
  }
}

/**
 * Defence in depth for the `SET LOCAL` interpolation below.
 *
 * `SET LOCAL <name> = <value>` is not a parameterisable statement in Postgres —
 * the extended query protocol does not accept bind parameters there — so the
 * organization id has to be interpolated into the SQL text. `withTenantContext`
 * still escapes it by doubling single quotes, which is genuinely sufficient
 * under Postgres's default `standard_conforming_strings = on` (verified `on`
 * for this database): with backslash escapes disabled, `''` is the only way to
 * express a quote inside a literal, so a doubled-quote escape cannot be broken
 * out of.
 *
 * This check sits on top of that, not instead of it. It removes the need to
 * reason about that argument at all for well-formed input, and it makes the
 * *only* strings that ever reach the interpolation 25 characters drawn from
 * `[a-z0-9]` — a set containing no quote, no semicolon, no comment marker, no
 * whitespace, and no backslash. An injection attempt fails here, before any SQL
 * text is constructed, rather than relying on the escape to neutralise it.
 *
 * Exported so it can be tested directly (tests/db/rls-security.test.ts).
 *
 * @throws {InvalidOrganizationIdError} if the value is not a well-formed cuid.
 * @returns the same string, narrowed, so call sites can use the return value
 *          and cannot accidentally interpolate the unvalidated original.
 */
export function assertValidOrganizationId(organizationId: unknown): string {
  if (typeof organizationId !== 'string' || !CUID_PATTERN.test(organizationId)) {
    throw new InvalidOrganizationIdError(organizationId)
  }
  return organizationId
}

/**
 * Run `fn` inside a transaction whose Postgres session has
 * `app.current_tenant_id` set to `organizationId`, which is the value every
 * `tenant_isolation` RLS policy keys on (see
 * prisma/migrations/*_enable_rls/migration.sql).
 *
 * This is the only way application code can reach a tenant-scoped model: Task
 * 2's platform-scoped client (`prisma` from '@/db/client') does not expose one,
 * and throws rather than returning undefined if you try.
 *
 * WHAT `tx` IS, PRECISELY — do not over-read the sentence above. `tx` is the
 * FULL, unrestricted Prisma transaction client, not a tenant-scoped subset of
 * it. `tx.user`, `tx.organization`, `tx.subscription`, `tx.auditLog`, every
 * other platform model, and the raw-SQL escape hatches (`tx.$queryRaw*`,
 * `tx.$executeRaw*`) are all reachable from inside the callback and are all
 * completely unfiltered by RLS, because those tables deliberately carry no
 * `tenant_isolation` policy (see the DELIBERATELY NOT COVERED section of
 * prisma/migrations/*_enable_rls/migration.sql — Task 2's platform models are
 * meant to be readable regardless of tenant context). What the tenant context
 * scopes is the set of tables that *have* a policy; it does not extend to
 * everything reachable through `tx`. Callers touching platform models inside
 * the callback are responsible for their own authorization.
 *
 * `SET LOCAL` is transaction-scoped: the setting is discarded at COMMIT and at
 * ROLLBACK alike, so a pooled connection handed to the next caller never
 * carries a previous tenant's context. A transaction that never issues the
 * `SET LOCAL` (i.e. anything not going through this function) leaves the GUC
 * unset, `current_setting(..., true)` returns NULL, every policy predicate
 * evaluates to NULL rather than TRUE, and the query sees zero rows — the layer
 * fails closed.
 *
 * KNOWN DEPLOYMENT CAVEAT: the policies only bind roles that are subject to
 * RLS. The role behind this project's current DATABASE_URL (Supabase's
 * `postgres`) holds `rolbypassrls = true` and owns every table, so RLS is
 * bypassed for it today and `FORCE ROW LEVEL SECURITY` — which the migration
 * sets on every covered table — cannot change that. Closing it is a credentials
 * change (point the runtime connection at a non-BYPASSRLS role), not a code
 * change. See the Task 9 report; tests/db/rls-security.test.ts proves the
 * policies themselves enforce correctly by running under a role that is subject
 * to them.
 *
 * @param options forwarded verbatim to Prisma's interactive-`$transaction`
 *   options. Omitting it leaves Prisma's own defaults in force — `maxWait`
 *   2000ms (how long the call queues for a free pooled connection) and
 *   `timeout` 5000ms (how long the whole transaction, including everything
 *   `fn` does, may run) — which is exactly the behaviour every existing
 *   two-argument caller had before this parameter existed. Nothing is defaulted
 *   on their behalf here, deliberately: silently widening the timeout for all
 *   callers would hide real runaway transactions.
 *
 *   Pass it when the callback genuinely needs longer. That is not hypothetical
 *   on this deployment: the database is a remote Supabase pooler where a single
 *   round trip costs hundreds of milliseconds, so ~3 sequential statements
 *   already spend ~3s of the 5s budget, and nesting `withTenantContext` (each
 *   level holding its own connection for the nested duration) reliably trips
 *   `P2028` at depth ~9-11 — the *outer* transaction timing out, before the
 *   pool is even exhausted. `{ maxWait: 30_000, timeout: 60_000 }` is the shape
 *   the live-DB tests in this repo use.
 */
export async function withTenantContext<T>(
  organizationId: string,
  fn: (tx: Prisma.TransactionClient) => Promise<T>,
  options?: { maxWait?: number; timeout?: number; isolationLevel?: Prisma.TransactionIsolationLevel }
): Promise<T> {
  // Validate BEFORE opening the transaction, so a malformed id costs no
  // connection and no SQL text is ever built from it.
  const validated = assertValidOrganizationId(organizationId)

  // `options` is passed straight through — `undefined` is what
  // `$transaction(fn)` would have received anyway, so the two-argument call
  // path is byte-for-byte the same behaviour it was.
  return rawPrisma.$transaction(async (tx) => {
    await tx.$executeRawUnsafe(`SET LOCAL app.current_tenant_id = '${validated.replace(/'/g, "''")}'`)
    return fn(tx)
  }, options)
}
