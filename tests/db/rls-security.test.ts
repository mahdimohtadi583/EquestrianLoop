import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest'
import { Prisma } from '@prisma/client'
import { rawPrisma } from '@/db/raw-client'
import {
  withTenantContext,
  assertValidOrganizationId,
  InvalidOrganizationIdError,
} from '@/server/tenant/context'
// Fix round 3: the seed's own write path into "Permission", exercised verbatim
// rather than imitated, to prove the new deny-by-default policy does not touch
// it (the seed runs as `rawPrisma`/`postgres`, which holds BYPASSRLS).
import { seedGlobalPermissions } from '../../prisma/seed'
import { PERMISSIONS } from '@/config/permissions'

// =============================================================================
// Task 9 — adversarial, live-Postgres proof that Row-Level Security is a real
// second isolation boundary, independent of the Prisma-level boundary in
// src/db/client.ts.
//
// HOW THESE TESTS PROVE ANYTHING — read this first.
//
// Postgres exempts two classes of role from RLS entirely:
//   (a) a role with the BYPASSRLS attribute (or SUPERUSER), always;
//   (b) a table's owner, unless the table is marked FORCE ROW LEVEL SECURITY.
//
// The migration marks every covered table FORCE, which closes (b). It cannot
// close (a): BYPASSRLS outranks FORCE, and that is a hard Postgres invariant,
// not a setting.
//
// The role THIS SUITE connects as is Supabase's `postgres`, and it is in class
// (a): rolsuper = false but rolbypassrls = TRUE, and it also owns every table in
// `public`. Measured, not assumed — the "runtime role privileges" describe block
// below prints the verbatim pg_roles / pg_tables values and asserts that the
// observed leak behaviour matches them.
//
// Note "this suite", not "the application": the security hardening round that
// followed Task 9 moved the application's own DATABASE_URL onto `app_runtime`
// (see below). `.env.test` deliberately overrides DATABASE_URL back to
// `postgres` for test runs, because Tasks 3-8's sanctioned schema-verification
// tests and prisma/seed.ts issue contextless reads and writes that RLS would
// otherwise — correctly — refuse. So the owner/BYPASSRLS facts above still
// describe this file's own connection, and the fixture-setup discipline below
// still relies on them.
//
// Consequently, a test that simply called withTenantContext() and looked for
// filtering would pass or fail for reasons that have nothing to do with the
// policies. So every policy-behaviour test here issues its queries under
// `SET LOCAL ROLE app_runtime`.
//
// `app_runtime` is the purpose-built application role created by the hardening
// round. It:
//   - is NOT the owner of these tables (owner is `postgres`),
//   - does NOT have rolsuper or rolbypassrls,
//   - DOES hold exactly SELECT/INSERT/UPDATE/DELETE on every table in `public`
//     (and deliberately no TRUNCATE, REFERENCES or TRIGGER),
//   - is the role the real application authenticates as via DATABASE_URL.
// It is therefore fully subject to the policies, which makes it the correct
// instrument for testing them — and, unlike the role used before, it is not a
// stand-in but the genuine article. `SET LOCAL ROLE` is transaction-scoped and
// reverts at COMMIT and ROLLBACK, so it cannot leak into the connection pool.
//
// WHAT CHANGED, AND WHY. This constant previously read
// `SET LOCAL ROLE authenticated`. `authenticated` is one of the two roles
// Supabase's PostgREST Data API maps incoming `apikey` requests onto, and it
// happened to be non-owner, non-BYPASSRLS and fully DML-privileged on `public`,
// which made it a convenient instrument. Part B of the hardening round revoked
// all of its privileges (and `anon`'s) on `public`, because this project
// authenticates with Auth.js + Prisma and never calls PostgREST, so those grants
// were nothing but an unauthenticated read path to `User`.`passwordHash` on a
// table with no RLS. With the grants gone, `authenticated` now raises
// "permission denied" instead of returning an RLS-filtered result — which would
// make these tests assert the wrong thing entirely. Hence the switch.
//
// No Postgres role is created and no credential is changed by these tests. The
// migration 20260912093000_scope_runtime_role_and_revoke_data_api_grants issues
// `GRANT app_runtime TO postgres` so that SET ROLE is permitted; that grants
// `postgres` nothing it lacked (it owns the tables and holds BYPASSRLS, strictly
// more privilege than `app_runtime`), and `app_runtime` itself is a member of
// nothing.
//
// SCOPE OF THIS TECHNIQUE. `SET LOCAL ROLE` is still a role *switch* on an
// owner connection. tests/db/runtime-role-rls.test.ts complements this file by
// opening a connection with the real runtime DATABASE_URL and proving the same
// isolation with no role-switching of any kind.
//
// TEST-DATA DISCIPLINE: all fixture rows — including, deliberately, the "victim"
// tenant's rows — are created through `rawPrisma` directly, as `postgres`, with
// no tenant context set. Nothing in the setup path depends on withTenantContext
// or on RLS, so the setup cannot mask a failure of the thing under test.
// =============================================================================

// This database is a remote Supabase instance; a single round trip costs
// hundreds of milliseconds, and these tests deliberately do real work over real
// connections. Vitest's 5s default is far too tight for that, and a test that
// times out mid-transaction holds a pooled connection and cascades into
// `P2028: Unable to start a transaction` in whatever runs next. Raise both
// budgets for this file only.
vi.setConfig({ testTimeout: 120_000, hookTimeout: 240_000 })

/**
 * Options for the `$transaction` helpers below. `maxWait` is how long Prisma
 * will queue for a free connection (default 2000ms) and `timeout` how long the
 * transaction may run (default 5000ms) — both raised generously for the same
 * remote-latency reason.
 *
 * Fix round 1: `withTenantContext` now takes these as an optional third
 * argument, so `asTenant` passes them through rather than silently running on
 * Prisma's defaults. That is not cosmetic — on Prisma's stock `maxWait` of
 * 2000ms this suite's concurrent blocks intermittently failed with
 * `Transaction API error: Unable to start a transaction in the given time`
 * against this remote pooler, which is the flakiness finding 2 describes.
 */
const TX_OPTIONS = { maxWait: 30_000, timeout: 60_000 } as const

/**
 * The role the policies actually bind — and the role the application itself
 * connects as. See the header note for why it is no longer `authenticated`.
 * Referenced by name in the assertions and grants below, so there is exactly
 * one place to change if it is ever renamed.
 */
const RLS_SUBJECT_ROLE = 'app_runtime'

/** Downgrade to a role the policies actually bind. See the header note. */
const ENFORCE_RLS = `SET LOCAL ROLE ${RLS_SUBJECT_ROLE}`

/** The real `withTenantContext`, run under a role RLS applies to. */
function asTenant<T>(
  organizationId: string,
  fn: (tx: Prisma.TransactionClient) => Promise<T>
): Promise<T> {
  return withTenantContext(
    organizationId,
    async (tx) => {
      await tx.$executeRawUnsafe(ENFORCE_RLS)
      return fn(tx)
    },
    TX_OPTIONS
  )
}

/** RLS-subject role, and no tenant context is ever set on the transaction. */
function withNoTenantContext<T>(fn: (tx: Prisma.TransactionClient) => Promise<T>): Promise<T> {
  return rawPrisma.$transaction(async (tx) => {
    await tx.$executeRawUnsafe(ENFORCE_RLS)
    return fn(tx)
  }, TX_OPTIONS)
}

/**
 * RLS-subject role with an arbitrary raw GUC value — used to set a tenant id
 * that `withTenantContext` would (correctly) refuse, e.g. a well-formed but
 * nonexistent cuid.
 */
function withRawTenantContext<T>(
  value: string,
  fn: (tx: Prisma.TransactionClient) => Promise<T>
): Promise<T> {
  return rawPrisma.$transaction(async (tx) => {
    await tx.$executeRawUnsafe(ENFORCE_RLS)
    await tx.$executeRawUnsafe(`SET LOCAL app.current_tenant_id = '${value.replace(/'/g, "''")}'`)
    return fn(tx)
  }, TX_OPTIONS)
}

const CUID_ALPHABET = 'abcdefghijklmnopqrstuvwxyz0123456789'
/** A syntactically valid cuid that belongs to no row anywhere. */
function fakeCuid(): string {
  let out = 'c'
  for (let i = 0; i < 24; i += 1) {
    out += CUID_ALPHABET[Math.floor(Math.random() * CUID_ALPHABET.length)]
  }
  return out
}

async function count(tx: Prisma.TransactionClient, sql: string): Promise<number> {
  const rows = await tx.$queryRawUnsafe<{ count: number }[]>(sql)
  return rows[0].count
}

/** First row of a single-row query — lets several probes share one round trip. */
async function one<T>(tx: Prisma.TransactionClient, sql: string): Promise<T> {
  const rows = await tx.$queryRawUnsafe<T[]>(sql)
  return rows[0]
}

const stamp = `${Date.now()}-${Math.floor(Math.random() * 1e6)}`

type OrgFixture = {
  label: string
  orgId: string
  userId: string
  staffUserId: string
  customerId: string
  branchId: string
  horseId: string
  staffId: string
  trainerId: string
  roleId: string
  serviceId: string
  planId: string
}

/**
 * Build one complete tenant's worth of rows. Everything goes through
 * `rawPrisma` as `postgres` with no tenant context — see TEST-DATA DISCIPLINE
 * in the header.
 */
async function createOrgFixture(label: string, permissionId: string): Promise<OrgFixture> {
  const org = await rawPrisma.organization.create({
    data: { name: `RLS ${label}`, slug: `rls-${label}-${stamp}` },
  })
  const user = await rawPrisma.user.create({
    data: {
      email: `rls-${label}-cust-${stamp}@test.com`,
      passwordHash: 'x',
      type: 'CUSTOMER',
      name: `RLS ${label} customer`,
    },
  })
  const staffUser = await rawPrisma.user.create({
    data: {
      email: `rls-${label}-staff-${stamp}@test.com`,
      passwordHash: 'x',
      type: 'STAFF',
      name: `RLS ${label} staff`,
    },
  })
  const customer = await rawPrisma.customer.create({
    data: {
      organizationId: org.id,
      userId: user.id,
      firstName: `RLS-${label}`,
      lastName: 'Customer',
    },
  })
  const branch = await rawPrisma.branch.create({
    data: { organizationId: org.id, name: `RLS ${label} branch`, timezone: 'UTC' },
  })
  const horse = await rawPrisma.horse.create({
    data: { organizationId: org.id, branchId: branch.id, name: `RLS ${label} horse` },
  })
  const staff = await rawPrisma.staff.create({
    data: { organizationId: org.id, userId: staffUser.id, branchId: branch.id },
  })
  const trainer = await rawPrisma.trainer.create({
    data: { staffId: staff.id, specialties: ['rls'], certifications: [] },
  })
  const role = await rawPrisma.role.create({
    data: { organizationId: org.id, name: `RLS ${label} role`, isSystemRole: false },
  })
  await rawPrisma.rolePermission.create({ data: { roleId: role.id, permissionId } })
  const service = await rawPrisma.service.create({
    data: {
      organizationId: org.id,
      name: `RLS ${label} service`,
      durationMinutes: 60,
      price: new Prisma.Decimal('10.00'),
      schedulingType: 'FIXED_SESSION',
    },
  })
  const plan = await rawPrisma.membershipPlan.create({
    data: {
      organizationId: org.id,
      name: `RLS ${label} plan`,
      price: new Prisma.Decimal('99.00'),
      durationValue: 1,
      durationUnit: 'MONTHLY',
    },
  })
  await rawPrisma.membershipPlanService.create({
    data: { membershipPlanId: plan.id, serviceId: service.id },
  })
  await rawPrisma.membershipPlanBranch.create({
    data: { membershipPlanId: plan.id, branchId: branch.id },
  })

  return {
    label,
    orgId: org.id,
    userId: user.id,
    staffUserId: staffUser.id,
    customerId: customer.id,
    branchId: branch.id,
    horseId: horse.id,
    staffId: staff.id,
    trainerId: trainer.id,
    roleId: role.id,
    serviceId: service.id,
    planId: plan.id,
  }
}

let A: OrgFixture
let B: OrgFixture
let permissionId: string
/** A platform-level Role with organizationId = NULL, plus a RolePermission on it. */
let systemRoleId: string
/** A spare user in org B, used as the target of cross-tenant INSERT attempts. */
let spareUserBId: string

/** Verbatim role/ownership facts, measured once and reused by several tests. */
let runtimeRole: {
  current_user: string
  session_user: string
  rolname: string
  rolsuper: boolean
  rolbypassrls: boolean
}

beforeAll(async () => {
  const permission = await rawPrisma.permission.create({
    data: { key: `rls.test.${stamp}`, description: 'RLS security suite fixture permission' },
  })
  permissionId = permission.id

  A = await createOrgFixture('a', permissionId)
  B = await createOrgFixture('b', permissionId)

  const systemRole = await rawPrisma.role.create({
    data: { organizationId: null, name: `RLS SYSTEM ${stamp}`, isSystemRole: true },
  })
  systemRoleId = systemRole.id
  await rawPrisma.rolePermission.create({ data: { roleId: systemRoleId, permissionId } })

  const spareUserB = await rawPrisma.user.create({
    data: {
      email: `rls-b-spare-${stamp}@test.com`,
      passwordHash: 'x',
      type: 'CUSTOMER',
      name: 'RLS B spare',
    },
  })
  spareUserBId = spareUserB.id

  const rows = await rawPrisma.$queryRawUnsafe<
    {
      current_user: string
      session_user: string
      rolname: string
      rolsuper: boolean
      rolbypassrls: boolean
    }[]
  >(
    `SELECT current_user, session_user, r.rolname, r.rolsuper, r.rolbypassrls
       FROM pg_roles r WHERE r.rolname = current_user`
  )
  runtimeRole = rows[0]
}, 120_000)

afterAll(async () => {
  // Best-effort, dependency-ordered teardown. Wrapped so a cleanup hiccup can
  // never turn a passing security suite red.
  try {
    const planIds = [A.planId, B.planId]
    const roleIds = [A.roleId, B.roleId, systemRoleId]
    const orgIds = [A.orgId, B.orgId]
    const userIds = [A.userId, A.staffUserId, B.userId, B.staffUserId, spareUserBId]
    await rawPrisma.membershipPlanService.deleteMany({ where: { membershipPlanId: { in: planIds } } })
    await rawPrisma.membershipPlanBranch.deleteMany({ where: { membershipPlanId: { in: planIds } } })
    await rawPrisma.membershipPlan.deleteMany({ where: { id: { in: planIds } } })
    await rawPrisma.rolePermission.deleteMany({ where: { roleId: { in: roleIds } } })
    await rawPrisma.trainer.deleteMany({ where: { id: { in: [A.trainerId, B.trainerId] } } })
    await rawPrisma.staff.deleteMany({ where: { id: { in: [A.staffId, B.staffId] } } })
    await rawPrisma.horse.deleteMany({ where: { organizationId: { in: orgIds } } })
    await rawPrisma.customer.deleteMany({ where: { organizationId: { in: orgIds } } })
    await rawPrisma.service.deleteMany({ where: { organizationId: { in: orgIds } } })
    await rawPrisma.branch.deleteMany({ where: { organizationId: { in: orgIds } } })
    await rawPrisma.role.deleteMany({ where: { id: { in: roleIds } } })
    await rawPrisma.organization.deleteMany({ where: { id: { in: orgIds } } })
    await rawPrisma.user.deleteMany({ where: { id: { in: userIds } } })
    await rawPrisma.permission.deleteMany({ where: { id: permissionId } })
  } catch (error) {
    console.warn('[rls-security] teardown skipped:', (error as Error).message)
  }
  await rawPrisma.$disconnect()
}, 120_000)

// -----------------------------------------------------------------------------
// #18 — Runtime role privileges. Placed first because every other block's
// meaning depends on it.
// -----------------------------------------------------------------------------
describe('runtime role privileges (security item 18)', () => {
  it('reports the exact role, its RLS-relevant attributes, and who owns the tables', async () => {
    const owners = await rawPrisma.$queryRawUnsafe<
      { tablename: string; tableowner: string; rowsecurity: boolean; forced: boolean }[]
    >(
      `SELECT t.tablename, t.tableowner, t.rowsecurity, c.relforcerowsecurity AS forced
         FROM pg_tables t
         JOIN pg_class c ON c.relname = t.tablename
         JOIN pg_namespace n ON n.oid = c.relnamespace AND n.nspname = t.schemaname
        WHERE t.schemaname = 'public'
          AND t.tablename IN ('Customer', 'Branch', 'Horse', 'Trainer')
        ORDER BY t.tablename`
    )

    const bypasses = runtimeRole.rolsuper || runtimeRole.rolbypassrls
    const ownsAll = owners.every((o) => o.tableowner === runtimeRole.current_user)

    // Printed verbatim so the finding is legible in CI output, not merely
    // encoded in an assertion.
    console.log(
      [
        '',
        '================ Task 9 RLS role-privilege finding ================',
        `  current_user   : ${runtimeRole.current_user}`,
        `  session_user   : ${runtimeRole.session_user}`,
        `  rolsuper       : ${runtimeRole.rolsuper}`,
        `  rolbypassrls   : ${runtimeRole.rolbypassrls}`,
        `  owns the tables: ${ownsAll}`,
        ...owners.map(
          (o) =>
            `    ${o.tablename.padEnd(10)} owner=${o.tableowner} rowsecurity=${o.rowsecurity} force=${o.forced}`
        ),
        bypasses
          ? '  VERDICT: this role BYPASSES RLS. FORCE ROW LEVEL SECURITY cannot help —\n' +
            '           BYPASSRLS/SUPERUSER outranks FORCE in Postgres. The policies are\n' +
            '           correct and enforce fully for any role subject to them (proved by\n' +
            `           the rest of this suite under SET LOCAL ROLE ${RLS_SUBJECT_ROLE}), but\n` +
            '           they filter NOTHING for this connection. That is expected here and\n' +
            '           only here: .env.test deliberately points the TEST connection at the\n' +
            '           owner role so Tasks 3-8\'s contextless schema tests keep working.\n' +
            '           The APPLICATION no longer uses it — DATABASE_URL in .env names\n' +
            `           ${RLS_SUBJECT_ROLE} (NOSUPERUSER, NOBYPASSRLS, non-owner), proved\n` +
            '           end-to-end over a real runtime connection in\n' +
            '           tests/db/runtime-role-rls.test.ts.'
          : '  VERDICT: this role is subject to RLS; the policies filter its queries.',
        '===================================================================',
        '',
      ].join('\n')
    )

    expect(typeof runtimeRole.rolsuper).toBe('boolean')
    expect(typeof runtimeRole.rolbypassrls).toBe('boolean')
    expect(owners.length).toBe(4)
    // Whatever the role turns out to be, every covered table must be ENABLE+FORCE.
    for (const o of owners) {
      expect(o.rowsecurity).toBe(true)
      expect(o.forced).toBe(true)
    }
  })

  it('observed leak behaviour matches the privilege metadata (not an assumption)', async () => {
    // Issue the *same* unfiltered read as the raw runtime role, inside a valid
    // tenant context, and see whether other tenants' rows come back. This is the
    // empirical counterpart to the pg_roles reading above: whichever way the
    // deployment is configured, the two must agree.
    const leakedAsRuntimeRole = await withTenantContext(
      A.orgId,
      async (tx) => {
        const rows = await tx.$queryRawUnsafe<{ count: number }[]>(
          `SELECT count(*)::int AS count FROM "Customer" WHERE "organizationId" = '${B.orgId}'`
        )
        return rows[0].count > 0
      },
      TX_OPTIONS
    )

    const bypasses = runtimeRole.rolsuper || runtimeRole.rolbypassrls
    console.log(
      `[rls-security] runtime role ${runtimeRole.current_user}: bypassesRls=${bypasses}, ` +
        `cross-tenant read leaked=${leakedAsRuntimeRole}`
    )
    expect(leakedAsRuntimeRole).toBe(bypasses)

    // And the control: the identical query under a role that IS subject to RLS
    // must see nothing of tenant B.
    const leakedAsRlsSubjectRole = await asTenant(A.orgId, async (tx) => {
      const rows = await tx.$queryRawUnsafe<{ count: number }[]>(
        `SELECT count(*)::int AS count FROM "Customer" WHERE "organizationId" = '${B.orgId}'`
      )
      return rows[0].count > 0
    })
    expect(leakedAsRlsSubjectRole).toBe(false)
  })

  it('the role used to test the policies is genuinely subject to them', async () => {
    const observed = await withNoTenantContext(async (tx) => {
      const rows = await tx.$queryRawUnsafe<
        { current_user: string; rolsuper: boolean; rolbypassrls: boolean; owner: string }[]
      >(
        `SELECT current_user,
                r.rolsuper,
                r.rolbypassrls,
                (SELECT tableowner FROM pg_tables WHERE schemaname='public' AND tablename='Customer') AS owner
           FROM pg_roles r WHERE r.rolname = current_user`
      )
      return rows[0]
    })
    console.log('[rls-security] policy-test role:', observed)
    expect(observed.current_user).toBe(RLS_SUBJECT_ROLE)
    expect(observed.rolsuper).toBe(false)
    expect(observed.rolbypassrls).toBe(false)
    expect(observed.owner).not.toBe(observed.current_user)
  })
})

// -----------------------------------------------------------------------------
// #1 / #2 — cross-tenant SELECT, both directions, more than one table.
// -----------------------------------------------------------------------------
describe('cross-tenant SELECT isolation (security items 1 and 2)', () => {
  it("tenant A cannot SELECT tenant B's Customer or Branch rows", async () => {
    // One statement, several scalar subqueries: each subquery is still subject
    // to RLS, and keeping it to a single round trip keeps the transaction short
    // against a remote database.
    const seen = await asTenant(A.orgId, async (tx) =>
      one<{
        bCustomer: number
        bBranch: number
        bHorse: number
        aCustomer: number
        aBranch: number
        foreignCustomers: number
      }>(
        tx,
        `SELECT
           (SELECT count(*)::int FROM "Customer" WHERE "id" = '${B.customerId}')            AS "bCustomer",
           (SELECT count(*)::int FROM "Branch"   WHERE "id" = '${B.branchId}')              AS "bBranch",
           (SELECT count(*)::int FROM "Horse"    WHERE "id" = '${B.horseId}')               AS "bHorse",
           (SELECT count(*)::int FROM "Customer" WHERE "id" = '${A.customerId}')            AS "aCustomer",
           (SELECT count(*)::int FROM "Branch"   WHERE "id" = '${A.branchId}')              AS "aBranch",
           (SELECT count(*)::int FROM "Customer" WHERE "organizationId" <> '${A.orgId}')    AS "foreignCustomers"`
      )
    )
    console.log('[rls-security] A looking at B:', seen)
    expect(seen.bCustomer).toBe(0)
    expect(seen.bBranch).toBe(0)
    expect(seen.bHorse).toBe(0)
    // ...while A's own rows remain fully visible (the policy isolates, it does
    // not simply break the table).
    expect(seen.aCustomer).toBe(1)
    expect(seen.aBranch).toBe(1)
    // Not just B: NO other tenant's customers are visible, out of the 100+ rows
    // this table holds from earlier tasks' tests.
    expect(seen.foreignCustomers).toBe(0)
  })

  it("tenant B cannot SELECT tenant A's Customer or Branch rows (symmetric)", async () => {
    const seen = await asTenant(B.orgId, async (tx) =>
      one<{
        aCustomer: number
        aBranch: number
        aHorse: number
        bCustomer: number
        foreignBranches: number
      }>(
        tx,
        `SELECT
           (SELECT count(*)::int FROM "Customer" WHERE "id" = '${A.customerId}')          AS "aCustomer",
           (SELECT count(*)::int FROM "Branch"   WHERE "id" = '${A.branchId}')            AS "aBranch",
           (SELECT count(*)::int FROM "Horse"    WHERE "id" = '${A.horseId}')             AS "aHorse",
           (SELECT count(*)::int FROM "Customer" WHERE "id" = '${B.customerId}')          AS "bCustomer",
           (SELECT count(*)::int FROM "Branch"   WHERE "organizationId" <> '${B.orgId}')  AS "foreignBranches"`
      )
    )
    console.log('[rls-security] B looking at A:', seen)
    expect(seen.aCustomer).toBe(0)
    expect(seen.aBranch).toBe(0)
    expect(seen.aHorse).toBe(0)
    expect(seen.bCustomer).toBe(1)
    expect(seen.foreignBranches).toBe(0)
  })
})

// -----------------------------------------------------------------------------
// #3 — cross-tenant INSERT, via the implicit WITH CHECK.
// -----------------------------------------------------------------------------
describe('cross-tenant INSERT is rejected by the implicit WITH CHECK (security item 3)', () => {
  it('the policies carry no explicit WITH CHECK, so USING is reused for writes', async () => {
    const rows = await rawPrisma.$queryRawUnsafe<{ tablename: string; with_check: string | null }[]>(
      `SELECT tablename, with_check FROM pg_policies
        WHERE schemaname='public' AND policyname='tenant_isolation'
          AND tablename IN ('Customer','Branch') ORDER BY tablename`
    )
    console.log('[rls-security] policy with_check columns:', rows)
    // NULL with_check on a FOR ALL policy means Postgres applies the USING
    // expression to new/updated rows too. That is the mechanism items 3-5 rely
    // on, so it is asserted rather than assumed.
    expect(rows.length).toBe(2)
    for (const r of rows) expect(r.with_check).toBeNull()
  })

  it("tenant A cannot INSERT a Customer carrying tenant B's organizationId", async () => {
    const rogueId = fakeCuid()
    let thrown: Error | undefined
    try {
      await asTenant(A.orgId, (tx) =>
        tx.$executeRawUnsafe(
          `INSERT INTO "Customer" ("id","organizationId","userId","qrToken","firstName","lastName")
           VALUES ('${rogueId}', '${B.orgId}', '${spareUserBId}', '${fakeCuid()}', 'Rogue', 'Insert')`
        )
      )
    } catch (error) {
      thrown = error as Error
    }
    console.log('[rls-security] cross-tenant INSERT error:', thrown?.message.split('\n').slice(-3).join(' | '))
    expect(thrown).toBeDefined()
    expect(thrown!.message).toMatch(/row-level security/i)

    // And nothing was written — checked as the bypassing role, so the check
    // itself cannot be fooled by RLS.
    const landed = await rawPrisma.$queryRawUnsafe<{ count: number }[]>(
      `SELECT count(*)::int AS count FROM "Customer" WHERE "id" = '${rogueId}'`
    )
    expect(landed[0].count).toBe(0)
  })

  it('the same INSERT succeeds when the organizationId matches the active tenant', async () => {
    // Control: proves the rejection above is the policy talking, not a broken
    // statement or a missing privilege.
    const okUser = await rawPrisma.user.create({
      data: {
        email: `rls-a-ok-${stamp}@test.com`,
        passwordHash: 'x',
        type: 'CUSTOMER',
        name: 'RLS A control',
      },
    })
    const okId = fakeCuid()
    const affected = await asTenant(A.orgId, (tx) =>
      tx.$executeRawUnsafe(
        `INSERT INTO "Customer" ("id","organizationId","userId","qrToken","firstName","lastName")
         VALUES ('${okId}', '${A.orgId}', '${okUser.id}', '${fakeCuid()}', 'Control', 'Insert')`
      )
    )
    expect(affected).toBe(1)
    await rawPrisma.customer.deleteMany({ where: { id: okId } })
    await rawPrisma.user.deleteMany({ where: { id: okUser.id } })
  })
})

// -----------------------------------------------------------------------------
// #4 / #5 — cross-tenant UPDATE and DELETE.
// -----------------------------------------------------------------------------
describe('cross-tenant UPDATE and DELETE (security items 4 and 5)', () => {
  it("tenant A's UPDATE of a tenant-B row by primary key affects zero rows", async () => {
    const before = await rawPrisma.customer.findUniqueOrThrow({ where: { id: B.customerId } })

    const affected = await asTenant(A.orgId, (tx) =>
      tx.$executeRawUnsafe(
        `UPDATE "Customer" SET "firstName" = 'HACKED' WHERE "id" = '${B.customerId}'`
      )
    )
    console.log('[rls-security] cross-tenant UPDATE affected rows:', affected)
    // Zero rows, not an exception: the row is simply invisible to the UPDATE's
    // USING filter, so there is nothing to update. Asserting on the count is
    // what distinguishes "blocked" from "silently swallowed error".
    expect(affected).toBe(0)

    const after = await rawPrisma.customer.findUniqueOrThrow({ where: { id: B.customerId } })
    expect(after.firstName).toBe(before.firstName)
    expect(after.firstName).not.toBe('HACKED')
  })

  it("tenant A's DELETE of a tenant-B row by primary key affects zero rows", async () => {
    const affected = await asTenant(A.orgId, (tx) =>
      tx.$executeRawUnsafe(`DELETE FROM "Customer" WHERE "id" = '${B.customerId}'`)
    )
    console.log('[rls-security] cross-tenant DELETE affected rows:', affected)
    expect(affected).toBe(0)

    const stillThere = await rawPrisma.customer.findUnique({ where: { id: B.customerId } })
    expect(stillThere).not.toBeNull()
  })

  it('tenant A cannot relocate one of its own rows into tenant B', async () => {
    // The WITH CHECK side of the same policy: the row is visible (it is A's), so
    // USING passes, but the *new* row would belong to B and must be refused.
    let thrown: Error | undefined
    try {
      await asTenant(A.orgId, (tx) =>
        tx.$executeRawUnsafe(
          `UPDATE "Customer" SET "organizationId" = '${B.orgId}' WHERE "id" = '${A.customerId}'`
        )
      )
    } catch (error) {
      thrown = error as Error
    }
    expect(thrown).toBeDefined()
    expect(thrown!.message).toMatch(/row-level security/i)

    const unchanged = await rawPrisma.customer.findUniqueOrThrow({ where: { id: A.customerId } })
    expect(unchanged.organizationId).toBe(A.orgId)
  })

  it('a tenant CAN update and delete its own rows (the policy is not a blanket deny)', async () => {
    const affected = await asTenant(B.orgId, (tx) =>
      tx.$executeRawUnsafe(
        `UPDATE "Customer" SET "notes" = 'own-write-ok' WHERE "id" = '${B.customerId}'`
      )
    )
    expect(affected).toBe(1)
    const row = await rawPrisma.customer.findUniqueOrThrow({ where: { id: B.customerId } })
    expect(row.notes).toBe('own-write-ok')
  })
})

// -----------------------------------------------------------------------------
// #6 / #7 — missing and invalid tenant context.
// -----------------------------------------------------------------------------
describe('missing and invalid tenant context fail closed (security items 6 and 7)', () => {
  it('a transaction that never sets app.current_tenant_id sees zero tenant-scoped rows', async () => {
    const seen = await withNoTenantContext((tx) =>
      one<{
        setting: string | null
        customers: number
        branches: number
        horses: number
        knownRow: number
      }>(
        tx,
        `SELECT
           current_setting('app.current_tenant_id', true)                            AS "setting",
           (SELECT count(*)::int FROM "Customer")                                    AS "customers",
           (SELECT count(*)::int FROM "Branch")                                      AS "branches",
           (SELECT count(*)::int FROM "Horse")                                       AS "horses",
           -- a probe that would certainly match if RLS were off:
           (SELECT count(*)::int FROM "Customer" WHERE "id" = '${A.customerId}')     AS "knownRow"`
      )
    )
    console.log('[rls-security] no tenant context:', seen)
    // Zero rows — not an error, not everything.
    expect(seen.customers).toBe(0)
    expect(seen.branches).toBe(0)
    expect(seen.horses).toBe(0)
    expect(seen.knownRow).toBe(0)

    // Sanity: the row the query looked for genuinely exists.
    const reallyExists = await rawPrisma.customer.findUnique({ where: { id: A.customerId } })
    expect(reallyExists).not.toBeNull()
  })

  it('a well-formed but nonexistent tenant id also sees zero rows', async () => {
    const ghost = fakeCuid()
    // It must look real enough that the application layer would accept it.
    expect(() => assertValidOrganizationId(ghost)).not.toThrow()

    const seen = await withRawTenantContext(ghost, (tx) =>
      one<{ setting: string | null; customers: number; knownRow: number }>(
        tx,
        `SELECT
           current_setting('app.current_tenant_id', true)                        AS "setting",
           (SELECT count(*)::int FROM "Customer")                                AS "customers",
           (SELECT count(*)::int FROM "Customer" WHERE "id" = '${A.customerId}') AS "knownRow"`
      )
    )
    console.log('[rls-security] ghost tenant context:', seen)
    expect(seen.setting).toBe(ghost)
    expect(seen.customers).toBe(0)
    expect(seen.knownRow).toBe(0)
  })

  it('an empty-string tenant context sees zero rows', async () => {
    const seen = await withRawTenantContext('', (tx) =>
      count(tx, `SELECT count(*)::int AS count FROM "Customer"`)
    )
    expect(seen).toBe(0)
  })
})

// -----------------------------------------------------------------------------
// #8 — tenant context cannot be spoofed through application input.
// -----------------------------------------------------------------------------
describe('tenant context cannot be spoofed through application input (security item 8)', () => {
  const HOSTILE_IDS: [name: string, value: string][] = [
    ['SET LOCAL command injection', "x'; SET LOCAL app.current_tenant_id = 'other"],
    ['statement terminator', "cabcdefghijklmnopqrstuvwx'; DROP TABLE \"Customer\"; --"],
    ['classic tautology', "' OR '1'='1"],
    ['doubled-quote escape attempt', "c''); SET LOCAL app.current_tenant_id='x"],
    ['line comment', 'cabcdefghijklmnopqrstuv--'],
    ['block comment', 'cabcdefghijklmnop/*x*/uv'],
    ['backslash escape', "c\\'; SET LOCAL app.current_tenant_id='y"],
    ['newline smuggling', "cabcdefghijklmnopqrstuvw\nSET LOCAL app.current_tenant_id='z'"],
    ['null byte', 'cabcdefghijklmnopqrstuvw '],
    ['uppercase (outside the cuid alphabet)', 'cABCDEFGHIJKLMNOPQRSTUVWX'],
    ['too short', 'cabc'],
    ['too long', `c${'a'.repeat(40)}`],
    ['empty string', ''],
    ['whitespace padding', ` ${'c' + 'a'.repeat(24)} `],
    ['unicode homoglyph', `c${'а'.repeat(24)}`],
  ]

  it.each(HOSTILE_IDS)('assertValidOrganizationId rejects: %s', (_name, value) => {
    expect(() => assertValidOrganizationId(value)).toThrow(InvalidOrganizationIdError)
  })

  it.each(HOSTILE_IDS)(
    'withTenantContext rejects before any SQL is built: %s',
    async (_name, value) => {
      await expect(withTenantContext(value, async () => 'should not run')).rejects.toBeInstanceOf(
        InvalidOrganizationIdError
      )
    }
  )

  it('rejects non-string inputs too', () => {
    for (const value of [null, undefined, 42, {}, [], Symbol('x')]) {
      expect(() => assertValidOrganizationId(value)).toThrow(InvalidOrganizationIdError)
    }
  })

  it('the callback never runs when the id is rejected', async () => {
    let ran = false
    await expect(
      withTenantContext("x'; SET LOCAL app.current_tenant_id = 'other", async () => {
        ran = true
        return null
      })
    ).rejects.toBeInstanceOf(InvalidOrganizationIdError)
    expect(ran).toBe(false)
  })

  it('accepts genuine, server-generated organization ids', () => {
    expect(assertValidOrganizationId(A.orgId)).toBe(A.orgId)
    expect(assertValidOrganizationId(B.orgId)).toBe(B.orgId)
    expect(A.orgId).toMatch(/^c[a-z0-9]{24}$/)
  })

  it('even if the validator were bypassed, the escaping holds: no injected GUC survives', async () => {
    // Belt-and-braces: drive the raw SET LOCAL path (the one withTenantContext
    // would take) with a hostile value, and confirm quote-doubling under
    // standard_conforming_strings=on keeps it a single literal — the injected
    // trailing statement becomes part of the value rather than a new command,
    // and the tenant still resolves to nothing.
    const hostile = "x'; SET LOCAL app.current_tenant_id = 'other"
    const observed = await withRawTenantContext(hostile, (tx) =>
      one<{ setting: string | null; customers: number }>(
        tx,
        `SELECT
           current_setting('app.current_tenant_id', true) AS "setting",
           (SELECT count(*)::int FROM "Customer")         AS "customers"`
      )
    )
    console.log('[rls-security] hostile literal landed as:', JSON.stringify(observed.setting))
    expect(observed.setting).toBe(hostile)
    expect(observed.setting).not.toBe('other')
    expect(observed.customers).toBe(0)
  })

  it('standard_conforming_strings is on, which is what makes that escaping sound', async () => {
    const rows = await rawPrisma.$queryRawUnsafe<{ standard_conforming_strings: string }[]>(
      `SHOW standard_conforming_strings`
    )
    expect(rows[0].standard_conforming_strings).toBe('on')
  })
})

// -----------------------------------------------------------------------------
// #9 / #10 / #11 — context lifetime across the connection pool.
// -----------------------------------------------------------------------------
describe('context isolation across connections and transactions (security items 9, 10, 11)', () => {
  it('concurrent withTenantContext calls never see each other\'s tenant id', async () => {
    const ids = [A.orgId, B.orgId, fakeCuid(), fakeCuid(), fakeCuid(), fakeCuid()]
    const results = await Promise.all(
      ids.map((id) =>
        withTenantContext(id, async (tx) => {
          // Read, do other work, read again — a mid-transaction context swap
          // caused by connection reuse would show up between the two reads.
          const first = await tx.$queryRawUnsafe<{ current_setting: string }[]>(
            `SELECT current_setting('app.current_tenant_id', true)`
          )
          // $executeRawUnsafe, not $queryRawUnsafe: pg_sleep returns `void`,
          // which Prisma's row deserialiser cannot represent.
          await tx.$executeRawUnsafe(`SELECT pg_sleep(0.05)`)
          const second = await tx.$queryRawUnsafe<{ current_setting: string }[]>(
            `SELECT current_setting('app.current_tenant_id', true)`
          )
          return { expected: id, first: first[0].current_setting, second: second[0].current_setting }
        }, TX_OPTIONS)
      )
    )
    console.log('[rls-security] concurrent contexts:', results)
    for (const r of results) {
      expect(r.first).toBe(r.expected)
      expect(r.second).toBe(r.expected)
    }
    expect(new Set(results.map((r) => r.first)).size).toBe(ids.length)
  }, 60_000)

  it('concurrent tenants each read only their own rows', async () => {
    const [fromA, fromB] = await Promise.all([
      asTenant(A.orgId, (tx) =>
        tx.$queryRawUnsafe<{ id: string; organizationId: string }[]>(
          `SELECT "id", "organizationId" FROM "Customer"`
        )
      ),
      asTenant(B.orgId, (tx) =>
        tx.$queryRawUnsafe<{ id: string; organizationId: string }[]>(
          `SELECT "id", "organizationId" FROM "Customer"`
        )
      ),
    ])
    expect(fromA.length).toBeGreaterThan(0)
    expect(fromB.length).toBeGreaterThan(0)
    expect(fromA.every((r) => r.organizationId === A.orgId)).toBe(true)
    expect(fromB.every((r) => r.organizationId === B.orgId)).toBe(true)
  }, 60_000)

  it('no context survives a committed transaction, across repeated pool reuse', async () => {
    const observations: { org: string; after: string | null }[] = []
    for (const org of [A.orgId, B.orgId, A.orgId, fakeCuid(), B.orgId, fakeCuid(), A.orgId, B.orgId]) {
      const inside = await withTenantContext(org, async (tx) => {
        const rows = await tx.$queryRawUnsafe<{ current_setting: string }[]>(
          `SELECT current_setting('app.current_tenant_id', true)`
        )
        return rows[0].current_setting
      }, TX_OPTIONS)
      expect(inside).toBe(org)

      // A separate query, outside any withTenantContext — it may well land on
      // the very connection the transaction above just released.
      const outside = await rawPrisma.$queryRawUnsafe<{ current_setting: string | null }[]>(
        `SELECT current_setting('app.current_tenant_id', true)`
      )
      observations.push({ org, after: outside[0].current_setting })
    }
    console.log('[rls-security] post-commit settings:', observations)
    for (const o of observations) {
      expect(o.after).not.toBe(o.org)
      // SET LOCAL reverts to the session value, which for a custom GUC that was
      // never set at session level is the empty string (or NULL if the placeholder
      // was never created on this backend).
      expect(o.after === null || o.after === '').toBe(true)
    }
  }, 60_000)

  it('a rolled-back transaction leaves no trace of its tenant context', async () => {
    const doomedCustomerId = fakeCuid()
    const doomedUser = await rawPrisma.user.create({
      data: {
        email: `rls-rollback-${stamp}@test.com`,
        passwordHash: 'x',
        type: 'CUSTOMER',
        name: 'RLS rollback',
      },
    })

    await expect(
      withTenantContext(A.orgId, async (tx) => {
        await tx.$executeRawUnsafe(
          `INSERT INTO "Customer" ("id","organizationId","userId","qrToken","firstName","lastName")
           VALUES ('${doomedCustomerId}', '${A.orgId}', '${doomedUser.id}', '${fakeCuid()}', 'Doomed', 'Row')`
        )
        throw new Error('deliberate failure, forcing ROLLBACK')
      }, TX_OPTIONS)
    ).rejects.toThrow('deliberate failure')

    // The write was rolled back...
    const orphan = await rawPrisma.customer.findUnique({ where: { id: doomedCustomerId } })
    expect(orphan).toBeNull()

    // ...and so was the context, on however many pooled connections follow.
    for (let i = 0; i < 6; i += 1) {
      const after = await rawPrisma.$queryRawUnsafe<{ current_setting: string | null }[]>(
        `SELECT current_setting('app.current_tenant_id', true)`
      )
      expect(after[0].current_setting).not.toBe(A.orgId)
      expect(after[0].current_setting === null || after[0].current_setting === '').toBe(true)
    }

    // An unrelated later transaction is unaffected and correctly scoped.
    const laterSeesOnlyB = await asTenant(B.orgId, async (tx) => {
      const rows = await tx.$queryRawUnsafe<{ organizationId: string }[]>(
        `SELECT "organizationId" FROM "Customer"`
      )
      return rows.every((r) => r.organizationId === B.orgId) && rows.length > 0
    })
    expect(laterSeesOnlyB).toBe(true)

    await rawPrisma.user.deleteMany({ where: { id: doomedUser.id } })
  }, 60_000)
})

// -----------------------------------------------------------------------------
// #12 — nested withTenantContext. Observed behaviour, recorded.
// -----------------------------------------------------------------------------
describe('nested withTenantContext (security item 12)', () => {
  it('the inner context is isolated from the outer one, on its own connection', async () => {
    // OBSERVED BEHAVIOUR (recorded, not assumed): rawPrisma.$transaction opens a
    // fresh connection for the inner call, so the inner SET LOCAL applies to that
    // connection only. The outer transaction's context is untouched and still in
    // force after the inner one commits. No deadlock occurs, because neither
    // transaction takes a lock the other waits on; the only real hazard is
    // connection-pool exhaustion if nesting were done at depth or in a loop
    // (each level holds a connection for the whole nested duration).
    const result = await withTenantContext(A.orgId, async (outerTx) => {
      const before = await one<{ setting: string; pid: number }>(
        outerTx,
        `SELECT current_setting('app.current_tenant_id', true) AS "setting",
                pg_backend_pid()::int AS "pid"`
      )

      const inner = await withTenantContext(B.orgId, async (innerTx) => {
        const seen = await one<{ setting: string; pid: number }>(
          innerTx,
          `SELECT current_setting('app.current_tenant_id', true) AS "setting",
                  pg_backend_pid()::int AS "pid"`
        )
        await innerTx.$executeRawUnsafe(ENFORCE_RLS)
        const rows = await innerTx.$queryRawUnsafe<{ organizationId: string }[]>(
          `SELECT "organizationId" FROM "Customer"`
        )
        return { setting: seen.setting, pid: seen.pid, rows }
      }, TX_OPTIONS)

      const after = await one<{ setting: string }>(
        outerTx,
        `SELECT current_setting('app.current_tenant_id', true) AS "setting"`
      )
      await outerTx.$executeRawUnsafe(ENFORCE_RLS)
      const outerRows = await outerTx.$queryRawUnsafe<{ organizationId: string }[]>(
        `SELECT "organizationId" FROM "Customer"`
      )

      return {
        outerBefore: before.setting,
        outerAfter: after.setting,
        outerPid: before.pid,
        inner,
        outerRows,
      }
    }, TX_OPTIONS)

    console.log('[rls-security] nested contexts:', {
      outerBefore: result.outerBefore,
      innerSetting: result.inner.setting,
      outerAfter: result.outerAfter,
      outerPid: result.outerPid,
      innerPid: result.inner.pid,
      separateBackends: result.outerPid !== result.inner.pid,
      innerRowCount: result.inner.rows.length,
      outerRowCount: result.outerRows.length,
    })

    expect(result.outerBefore).toBe(A.orgId)
    expect(result.inner.setting).toBe(B.orgId)
    // The crucial one: the inner transaction did NOT clobber the outer context.
    expect(result.outerAfter).toBe(A.orgId)
    // Each saw only its own tenant's data.
    expect(result.inner.rows.length).toBeGreaterThan(0)
    expect(result.inner.rows.every((r) => r.organizationId === B.orgId)).toBe(true)
    expect(result.outerRows.length).toBeGreaterThan(0)
    expect(result.outerRows.every((r) => r.organizationId === A.orgId)).toBe(true)
    // Recorded observation: separate backends, hence separate GUC scopes.
    expect(result.outerPid).not.toBe(result.inner.pid)
  }, 60_000)
})

// -----------------------------------------------------------------------------
// #13 / #14 — coverage of every tenant-scoped table, enforced mechanically.
// -----------------------------------------------------------------------------
describe('RLS coverage of tenant-scoped tables (security items 13 and 14)', () => {
  /**
   * `Subscription` and `AuditLog` also carry an organizationId, but they are
   * platform-scoped by design: src/db/client.ts exposes both on the platform
   * client precisely so platform-level code can read them WITHOUT a tenant
   * context (billing administration, cross-tenant audit review), and AuditLog's
   * organizationId is nullable for platform-level events. Giving them a tenant
   * policy would make every platform read return zero rows as soon as the
   * runtime role stops bypassing RLS.
   *
   * The exemption is listed here by name so it stays a decision. Any *new*
   * model with an organizationId lands in the enumeration below and fails the
   * test until it is either given a policy or consciously added here.
   */
  const PLATFORM_SCOPED_EXEMPTIONS = new Set(['Subscription', 'AuditLog'])

  /** Tables with no organizationId column whose tenant is resolved via EXISTS. */
  const JOIN_TABLES_COVERED_VIA_PARENT = [
    'Trainer',
    'RolePermission',
    'MembershipPlanService',
    'MembershipPlanBranch',
  ] as const

  function tenantScopedModelNames(): string[] {
    return Prisma.dmmf.datamodel.models
      .filter((m) => m.fields.some((f) => f.name === 'organizationId'))
      .map((m) => m.name)
      .filter((name) => !PLATFORM_SCOPED_EXEMPTIONS.has(name))
      .sort()
  }

  async function protectedTables(): Promise<Map<string, { rls: boolean; force: boolean; policies: number }>> {
    const rows = await rawPrisma.$queryRawUnsafe<
      { tablename: string; rls: boolean; force: boolean; policies: number }[]
    >(
      `SELECT c.relname AS tablename,
              c.relrowsecurity AS rls,
              c.relforcerowsecurity AS force,
              (SELECT count(*)::int FROM pg_policies p
                WHERE p.schemaname = 'public' AND p.tablename = c.relname) AS policies
         FROM pg_class c
         JOIN pg_namespace n ON n.oid = c.relnamespace
        WHERE n.nspname = 'public' AND c.relkind = 'r'`
    )
    return new Map(rows.map((r) => [r.tablename, { rls: r.rls, force: r.force, policies: r.policies }]))
  }

  it('every Prisma model with an organizationId has RLS, FORCE and a policy', async () => {
    const expected = tenantScopedModelNames()
    const actual = await protectedTables()

    const missing = expected.filter((name) => {
      const state = actual.get(name)
      return !state || !state.rls || !state.force || state.policies < 1
    })
    console.log('[rls-security] tenant-scoped models enumerated from dmmf:', expected)
    console.log('[rls-security] unprotected among them:', missing)

    expect(missing).toEqual([])
    // There are 19 today (18 NOT NULL + Role's nullable column). A new
    // tenant-scoped model added by a later task changes this number and makes
    // the count assertion fail loudly, prompting a re-read of this block rather
    // than a silent pass.
    expect(expected.length).toBe(19)
  })

  it('the platform-scoped exemptions are exactly Subscription and AuditLog, and are deliberate', async () => {
    const allWithOrgId = Prisma.dmmf.datamodel.models
      .filter((m) => m.fields.some((f) => f.name === 'organizationId'))
      .map((m) => m.name)
      .sort()
    expect(allWithOrgId.filter((n) => PLATFORM_SCOPED_EXEMPTIONS.has(n)).sort()).toEqual([
      'AuditLog',
      'Subscription',
    ])
    // Recorded fact, so a reviewer can see that the exemption is real and not a
    // table that quietly acquired a policy behind the comment's back.
    const actual = await protectedTables()
    console.log('[rls-security] exemption state:', {
      Subscription: actual.get('Subscription'),
      AuditLog: actual.get('AuditLog'),
    })
    expect(actual.get('Subscription')?.rls).toBe(false)
    expect(actual.get('AuditLog')?.rls).toBe(false)
  })

  it('the join/extension tables are covered too, via an EXISTS policy on their parent', async () => {
    const actual = await protectedTables()
    for (const table of JOIN_TABLES_COVERED_VIA_PARENT) {
      const state = actual.get(table)
      expect(state, `${table} has no pg_class row`).toBeDefined()
      expect(state!.rls, `${table} rowsecurity`).toBe(true)
      expect(state!.force, `${table} force rowsecurity`).toBe(true)
      // One permissive `tenant_isolation` policy each — plus, on
      // RolePermission only, the two RESTRICTIVE policies that narrow the verbs
      // WITH CHECK cannot reach: `tenant_delete_isolation` (FOR DELETE, round 1,
      // 20260911185927_restrict_platform_role_deletes) and
      // `tenant_update_isolation` (FOR UPDATE's old row, round 2,
      // 20260911201237_restrict_platform_role_updates). See the two
      // "Role/RolePermission" blocks below for why.
      expect(state!.policies, `${table} policy count`).toBe(table === 'RolePermission' ? 3 : 1)
    }
    // And their predicates really are EXISTS subqueries against the parent.
    const quals = await rawPrisma.$queryRawUnsafe<{ tablename: string; qual: string }[]>(
      `SELECT tablename, qual FROM pg_policies
        WHERE schemaname='public' AND policyname='tenant_isolation'
          AND tablename IN ('Trainer','RolePermission','MembershipPlanService','MembershipPlanBranch')
        ORDER BY tablename`
    )
    expect(quals.length).toBe(4)
    const byTable = new Map(quals.map((q) => [q.tablename, q.qual]))
    expect(byTable.get('Trainer')).toMatch(/EXISTS[\s\S]*"Staff"[\s\S]*"staffId"/)
    expect(byTable.get('RolePermission')).toMatch(/EXISTS[\s\S]*"Role"[\s\S]*"roleId"/)
    // RolePermission deliberately mirrors Role's nullable-org allowance.
    expect(byTable.get('RolePermission')).toMatch(/"organizationId" IS NULL/)
    expect(byTable.get('MembershipPlanService')).toMatch(
      /EXISTS[\s\S]*"MembershipPlan"[\s\S]*"membershipPlanId"/
    )
    expect(byTable.get('MembershipPlanBranch')).toMatch(
      /EXISTS[\s\S]*"MembershipPlan"[\s\S]*"membershipPlanId"/
    )
  })

  it('every tenant_isolation policy keys on app.current_tenant_id and applies to ALL commands to PUBLIC', async () => {
    const rows = await rawPrisma.$queryRawUnsafe<
      { tablename: string; cmd: string; roles: string; permissive: string; qual: string }[]
    >(
      `SELECT tablename, cmd, roles::text AS roles, permissive, qual
         FROM pg_policies WHERE schemaname='public' AND policyname='tenant_isolation'
        ORDER BY tablename`
    )
    expect(rows.length).toBe(23)
    for (const r of rows) {
      expect(r.cmd, `${r.tablename}.cmd`).toBe('ALL')
      expect(r.roles, `${r.tablename}.roles`).toBe('{public}')
      expect(r.permissive, `${r.tablename}.permissive`).toBe('PERMISSIVE')
      expect(r.qual, `${r.tablename}.qual`).toMatch(/current_setting\('app\.current_tenant_id'/)
    }
  })

  it('the tables added by Tasks 4-8 are covered, named explicitly (security item 14)', async () => {
    const TASK_4_TO_8_TABLES = [
      'Customer',
      'Staff',
      'Horse',
      'Service',
      'BlockedTime',
      'RidingSession',
      'Booking',
      'CheckIn',
      'MembershipPlan',
      'CustomerMembership',
      'LoyaltyAccount',
      'LoyaltyTransaction',
      'Reward',
      'RewardRedemption',
      'Payment',
      'Notification',
    ] as const
    const actual = await protectedTables()
    for (const table of TASK_4_TO_8_TABLES) {
      const state = actual.get(table)
      expect(state, `${table} missing from pg_class`).toBeDefined()
      expect(state!.rls, `${table} rowsecurity`).toBe(true)
      expect(state!.force, `${table} force rowsecurity`).toBe(true)
      expect(state!.policies, `${table} policy count`).toBe(1)
    }
  })

  it('Branch, Membership and Role (Tasks 1-3) are covered as well', async () => {
    const actual = await protectedTables()
    for (const table of ['Branch', 'Membership', 'Role'] as const) {
      expect(actual.get(table)?.rls, `${table} rowsecurity`).toBe(true)
      expect(actual.get(table)?.force, `${table} force rowsecurity`).toBe(true)
      // Role additionally carries two RESTRICTIVE policies: FOR DELETE from
      // 20260911185927_restrict_platform_role_deletes (round 1) and FOR UPDATE
      // from 20260911201237_restrict_platform_role_updates (round 2).
      expect(actual.get(table)?.policies, `${table} policy count`).toBe(table === 'Role' ? 3 : 1)
    }
  })
})

// -----------------------------------------------------------------------------
// #15 — relationship paths with no organizationId column.
// -----------------------------------------------------------------------------
describe('join/extension tables cannot bypass isolation (security item 15)', () => {
  it('Trainer, queried directly with no join, returns only the active tenant\'s rows', async () => {
    const fromA = await asTenant(A.orgId, (tx) =>
      tx.$queryRawUnsafe<{ id: string; staffId: string }[]>(`SELECT "id","staffId" FROM "Trainer"`)
    )
    const fromB = await asTenant(B.orgId, (tx) =>
      tx.$queryRawUnsafe<{ id: string; staffId: string }[]>(`SELECT "id","staffId" FROM "Trainer"`)
    )
    console.log('[rls-security] Trainer rows visible:', { A: fromA.length, B: fromB.length })
    expect(fromA.map((r) => r.id)).toContain(A.trainerId)
    expect(fromA.map((r) => r.id)).not.toContain(B.trainerId)
    expect(fromB.map((r) => r.id)).toContain(B.trainerId)
    expect(fromB.map((r) => r.id)).not.toContain(A.trainerId)
    // The table holds 17+ trainers from earlier tasks' tests; A must see exactly
    // its own one.
    expect(fromA.length).toBe(1)
    expect(fromB.length).toBe(1)
  })

  it('Trainer is invisible with no tenant context at all', async () => {
    const seen = await withNoTenantContext((tx) =>
      count(tx, `SELECT count(*)::int AS count FROM "Trainer"`)
    )
    expect(seen).toBe(0)
  })

  it('Trainer, reached through the Prisma delegate rather than raw SQL, is filtered too', async () => {
    const rows = await asTenant(A.orgId, (tx) => tx.trainer.findMany())
    expect(rows.map((r) => r.id)).toEqual([A.trainerId])
  })

  it("RolePermission returns the tenant's own roles plus NULL-org system roles, never another tenant's", async () => {
    const fromA = await asTenant(A.orgId, (tx) =>
      tx.$queryRawUnsafe<{ roleId: string }[]>(`SELECT "roleId" FROM "RolePermission"`)
    )
    const roleIdsA = fromA.map((r) => r.roleId)
    console.log('[rls-security] RolePermission roleIds visible to A:', roleIdsA.length)
    expect(roleIdsA).toContain(A.roleId)
    // Deliberate, and consistent with Role's own `organizationId IS NULL OR ...`
    // policy: a platform system role's permission set must stay readable in
    // every tenant context, or RBAC would fail closed against SUPER_ADMIN.
    expect(roleIdsA).toContain(systemRoleId)
    expect(roleIdsA).not.toContain(B.roleId)

    const fromB = await asTenant(B.orgId, (tx) =>
      tx.$queryRawUnsafe<{ roleId: string }[]>(`SELECT "roleId" FROM "RolePermission"`)
    )
    const roleIdsB = fromB.map((r) => r.roleId)
    expect(roleIdsB).toContain(B.roleId)
    expect(roleIdsB).toContain(systemRoleId)
    expect(roleIdsB).not.toContain(A.roleId)
  })

  it('RolePermission visibility matches Role visibility exactly, row for row', async () => {
    // The invariant the nullable-org reasoning rests on: a RolePermission row is
    // visible iff its parent Role is visible.
    const observed = await asTenant(A.orgId, async (tx) => {
      const roles = await tx.$queryRawUnsafe<{ id: string }[]>(`SELECT "id" FROM "Role"`)
      const perms = await tx.$queryRawUnsafe<{ roleId: string }[]>(
        `SELECT DISTINCT "roleId" FROM "RolePermission"`
      )
      return { roleIds: new Set(roles.map((r) => r.id)), permRoleIds: perms.map((p) => p.roleId) }
    })
    const orphaned = observed.permRoleIds.filter((id) => !observed.roleIds.has(id))
    console.log('[rls-security] RolePermission rows whose Role is NOT visible:', orphaned.length)
    expect(orphaned).toEqual([])
  })

  it("RolePermission with no tenant context shows only NULL-org system roles' rows", async () => {
    // Role's policy makes NULL-org roles globally visible, so their permissions
    // stay visible too — but nothing belonging to an actual tenant does.
    const rows = await withNoTenantContext((tx) =>
      tx.$queryRawUnsafe<{ roleId: string }[]>(`SELECT "roleId" FROM "RolePermission"`)
    )
    const roleIds = rows.map((r) => r.roleId)
    expect(roleIds).not.toContain(A.roleId)
    expect(roleIds).not.toContain(B.roleId)
    expect(roleIds).toContain(systemRoleId)
  })

  it('MembershipPlanService, queried directly, returns only the active tenant\'s rows', async () => {
    const fromA = await asTenant(A.orgId, (tx) =>
      tx.$queryRawUnsafe<{ membershipPlanId: string; serviceId: string }[]>(
        `SELECT "membershipPlanId","serviceId" FROM "MembershipPlanService"`
      )
    )
    const fromB = await asTenant(B.orgId, (tx) =>
      tx.$queryRawUnsafe<{ membershipPlanId: string; serviceId: string }[]>(
        `SELECT "membershipPlanId","serviceId" FROM "MembershipPlanService"`
      )
    )
    expect(fromA.map((r) => r.membershipPlanId)).toContain(A.planId)
    expect(fromA.map((r) => r.membershipPlanId)).not.toContain(B.planId)
    expect(fromA.every((r) => r.serviceId !== B.serviceId)).toBe(true)
    expect(fromB.map((r) => r.membershipPlanId)).toContain(B.planId)
    expect(fromB.map((r) => r.membershipPlanId)).not.toContain(A.planId)
  })

  it('MembershipPlanBranch, queried directly, returns only the active tenant\'s rows', async () => {
    const fromA = await asTenant(A.orgId, (tx) =>
      tx.$queryRawUnsafe<{ membershipPlanId: string; branchId: string }[]>(
        `SELECT "membershipPlanId","branchId" FROM "MembershipPlanBranch"`
      )
    )
    const fromB = await asTenant(B.orgId, (tx) =>
      tx.$queryRawUnsafe<{ membershipPlanId: string; branchId: string }[]>(
        `SELECT "membershipPlanId","branchId" FROM "MembershipPlanBranch"`
      )
    )
    expect(fromA.map((r) => r.branchId)).toContain(A.branchId)
    expect(fromA.map((r) => r.branchId)).not.toContain(B.branchId)
    expect(fromB.map((r) => r.branchId)).toContain(B.branchId)
    expect(fromB.map((r) => r.branchId)).not.toContain(A.branchId)
  })

  it('MembershipPlanService and MembershipPlanBranch are invisible with no tenant context', async () => {
    const seen = await withNoTenantContext(async (tx) => ({
      services: await count(tx, `SELECT count(*)::int AS count FROM "MembershipPlanService"`),
      branches: await count(tx, `SELECT count(*)::int AS count FROM "MembershipPlanBranch"`),
    }))
    expect(seen.services).toBe(0)
    expect(seen.branches).toBe(0)
  })

  it("a join/extension row cannot be INSERTed against another tenant's parent", async () => {
    let thrown: Error | undefined
    try {
      await asTenant(A.orgId, (tx) =>
        tx.$executeRawUnsafe(
          `INSERT INTO "MembershipPlanBranch" ("membershipPlanId","branchId")
           VALUES ('${B.planId}', '${B.branchId}')`
        )
      )
    } catch (error) {
      thrown = error as Error
    }
    console.log(
      '[rls-security] cross-tenant join-table INSERT error:',
      thrown?.message.split('\n').slice(-2).join(' | ')
    )
    expect(thrown).toBeDefined()
    expect(thrown!.message).toMatch(/row-level security/i)
  })

  // ---------------------------------------------------------------------------
  // Fix Round 1, finding 5: MembershipPlanService / MembershipPlanBranch reached
  // through the Prisma delegate with no join and no where clause, against real
  // rows created for both tenants in beforeAll. Structurally identical to the
  // Trainer delegate test above, so these two join tables are now exercised
  // against actual data rather than verified only by policy text + RLS state.
  // ---------------------------------------------------------------------------
  it('MembershipPlanService, via the Prisma delegate, is filtered per tenant', async () => {
    const [fromA, fromB] = await Promise.all([
      asTenant(A.orgId, (tx) => tx.membershipPlanService.findMany()),
      asTenant(B.orgId, (tx) => tx.membershipPlanService.findMany()),
    ])
    console.log('[rls-security] MembershipPlanService delegate rows:', {
      A: fromA.length,
      B: fromB.length,
    })
    // Real rows exist on both sides — otherwise "not visible" would be vacuous.
    expect(fromA.length).toBeGreaterThan(0)
    expect(fromB.length).toBeGreaterThan(0)
    expect(fromA.map((r) => r.membershipPlanId)).toContain(A.planId)
    expect(fromA.map((r) => r.membershipPlanId)).not.toContain(B.planId)
    expect(fromA.map((r) => r.serviceId)).not.toContain(B.serviceId)
    expect(fromB.map((r) => r.membershipPlanId)).toContain(B.planId)
    expect(fromB.map((r) => r.membershipPlanId)).not.toContain(A.planId)
    expect(fromB.map((r) => r.serviceId)).not.toContain(A.serviceId)
  })

  it('MembershipPlanBranch, via the Prisma delegate, is filtered per tenant', async () => {
    const [fromA, fromB] = await Promise.all([
      asTenant(A.orgId, (tx) => tx.membershipPlanBranch.findMany()),
      asTenant(B.orgId, (tx) => tx.membershipPlanBranch.findMany()),
    ])
    console.log('[rls-security] MembershipPlanBranch delegate rows:', {
      A: fromA.length,
      B: fromB.length,
    })
    expect(fromA.length).toBeGreaterThan(0)
    expect(fromB.length).toBeGreaterThan(0)
    expect(fromA.map((r) => r.branchId)).toContain(A.branchId)
    expect(fromA.map((r) => r.branchId)).not.toContain(B.branchId)
    expect(fromB.map((r) => r.branchId)).toContain(B.branchId)
    expect(fromB.map((r) => r.branchId)).not.toContain(A.branchId)
  })

  it('both join tables genuinely hold rows for both tenants (the fixtures are not empty)', async () => {
    // Read as the bypassing runtime role, so this is a statement about the
    // database, not about what RLS lets anyone see. Guards against the previous
    // state of affairs, in which these two policies were asserted against zero
    // rows.
    const rows = await rawPrisma.$queryRawUnsafe<
      { aServices: number; bServices: number; aBranches: number; bBranches: number }[]
    >(
      `SELECT
         (SELECT count(*)::int FROM "MembershipPlanService" WHERE "membershipPlanId" = '${A.planId}') AS "aServices",
         (SELECT count(*)::int FROM "MembershipPlanService" WHERE "membershipPlanId" = '${B.planId}') AS "bServices",
         (SELECT count(*)::int FROM "MembershipPlanBranch"  WHERE "membershipPlanId" = '${A.planId}') AS "aBranches",
         (SELECT count(*)::int FROM "MembershipPlanBranch"  WHERE "membershipPlanId" = '${B.planId}') AS "bBranches"`
    )
    console.log('[rls-security] join-table fixture row counts:', rows[0])
    expect(rows[0].aServices).toBe(1)
    expect(rows[0].bServices).toBe(1)
    expect(rows[0].aBranches).toBe(1)
    expect(rows[0].bBranches).toBe(1)
  })
})

// -----------------------------------------------------------------------------
// Fix Round 1, finding 1 — Role / RolePermission WRITE hardening.
//
// The original migration gave both policies a USING clause only, so Postgres
// reused the deliberately permissive read predicate (`organizationId IS NULL OR
// ...`) as the WITH CHECK expression. That let any single valid tenant context
// grant itself platform scope. Migration 20260911185229_harden_role_write_policies
// splits the two: USING unchanged (reads must keep seeing NULL-org system
// roles), WITH CHECK strict (writes must match the active tenant exactly).
//
// Every test below therefore comes in two halves: the write is refused, AND the
// corresponding read still works.
// -----------------------------------------------------------------------------
describe('Role/RolePermission writes cannot reach the platform system role (fix round 1)', () => {
  it('the two policies now carry an explicit, strict WITH CHECK', async () => {
    const rows = await rawPrisma.$queryRawUnsafe<
      { tablename: string; qual: string; with_check: string | null }[]
    >(
      `SELECT tablename, qual, with_check FROM pg_policies
        WHERE schemaname='public' AND policyname='tenant_isolation'
          AND tablename IN ('Role','RolePermission') ORDER BY tablename`
    )
    console.log('[rls-security] hardened policies:', rows)
    expect(rows.length).toBe(2)
    const byTable = new Map(rows.map((r) => [r.tablename, r]))

    // READ side: unchanged, still permits the NULL-org platform role.
    expect(byTable.get('Role')!.qual).toMatch(/"organizationId" IS NULL/)
    expect(byTable.get('RolePermission')!.qual).toMatch(/"organizationId" IS NULL/)

    // WRITE side: present, and containing no IS NULL allowance at all.
    expect(byTable.get('Role')!.with_check).not.toBeNull()
    expect(byTable.get('RolePermission')!.with_check).not.toBeNull()
    expect(byTable.get('Role')!.with_check).not.toMatch(/IS NULL/)
    expect(byTable.get('RolePermission')!.with_check).not.toMatch(/IS NULL/)
    expect(byTable.get('Role')!.with_check).toMatch(/current_setting\('app\.current_tenant_id'/)
    expect(byTable.get('RolePermission')!.with_check).toMatch(
      /current_setting\('app\.current_tenant_id'/
    )
  })

  it('a RESTRICTIVE, DELETE-only policy covers the verb WITH CHECK cannot reach', async () => {
    const rows = await rawPrisma.$queryRawUnsafe<
      { tablename: string; cmd: string; permissive: string; roles: string; qual: string }[]
    >(
      `SELECT tablename, cmd, permissive, roles::text AS roles, qual FROM pg_policies
        WHERE schemaname='public' AND policyname='tenant_delete_isolation' ORDER BY tablename`
    )
    console.log('[rls-security] delete-restriction policies:', rows)
    expect(rows.map((r) => r.tablename)).toEqual(['Role', 'RolePermission'])
    for (const r of rows) {
      expect(r.permissive, `${r.tablename}.permissive`).toBe('RESTRICTIVE')
      // DELETE only — so SELECT/INSERT/UPDATE behaviour is provably untouched.
      expect(r.cmd, `${r.tablename}.cmd`).toBe('DELETE')
      expect(r.roles, `${r.tablename}.roles`).toBe('{public}')
      expect(r.qual, `${r.tablename}.qual`).toMatch(/current_setting\('app\.current_tenant_id'/)
      expect(r.qual, `${r.tablename}.qual`).not.toMatch(/IS NULL/)
    }
  })

  it('a tenant context cannot INSERT a RolePermission against the NULL-org system role', async () => {
    // A permission the system role does not already hold, so a unique-constraint
    // violation cannot be mistaken for the policy doing its job.
    const extraPermission = await rawPrisma.permission.create({
      data: { key: `rls.escalation.${stamp}`, description: 'fix-round-1 escalation probe' },
    })
    let thrown: Error | undefined
    try {
      await asTenant(A.orgId, (tx) =>
        tx.$executeRawUnsafe(
          `INSERT INTO "RolePermission" ("roleId","permissionId")
           VALUES ('${systemRoleId}', '${extraPermission.id}')`
        )
      )
    } catch (error) {
      thrown = error as Error
    }
    console.log(
      '[rls-security] system-role RolePermission INSERT error:',
      thrown?.message.split('\n').slice(-2).join(' | ')
    )
    expect(thrown).toBeDefined()
    expect(thrown!.message).toMatch(/row-level security/i)

    // Verified as the bypassing role: nothing landed.
    const landed = await rawPrisma.rolePermission.findMany({
      where: { roleId: systemRoleId, permissionId: extraPermission.id },
    })
    expect(landed).toEqual([])

    await rawPrisma.permission.deleteMany({ where: { id: extraPermission.id } })
  })

  it("a tenant context cannot DELETE the system role's RolePermission rows", async () => {
    // DELETE has no "new row", so WITH CHECK does not apply to it — Postgres
    // governs DELETE by USING alone, and USING must stay permissive for reads.
    // That is why migration 20260911185927_restrict_platform_role_deletes adds a
    // RESTRICTIVE, FOR DELETE-only policy: restrictive policies are ANDed in, so
    // they narrow DELETE without touching SELECT at all. Measured before that
    // migration, this DELETE removed 1 row.
    const affected = await asTenant(A.orgId, (tx) =>
      tx.$executeRawUnsafe(`DELETE FROM "RolePermission" WHERE "roleId" = '${systemRoleId}'`)
    )
    console.log('[rls-security] system-role RolePermission DELETE affected:', affected)
    expect(affected).toBe(0)

    // Verified as the bypassing role: the row is still there.
    const stillThere = await rawPrisma.rolePermission.findMany({ where: { roleId: systemRoleId } })
    expect(stillThere.length).toBeGreaterThan(0)
  })

  it('a tenant context cannot DELETE the NULL-org system Role itself', async () => {
    // Worth its own test: Role.onDelete is Cascade, so deleting the platform
    // role would take its RolePermission and Membership rows with it.
    const affected = await asTenant(A.orgId, (tx) =>
      tx.$executeRawUnsafe(`DELETE FROM "Role" WHERE "id" = '${systemRoleId}'`)
    )
    console.log('[rls-security] system-Role DELETE affected:', affected)
    expect(affected).toBe(0)

    const stillThere = await rawPrisma.role.findUnique({ where: { id: systemRoleId } })
    expect(stillThere).not.toBeNull()
    expect(stillThere!.organizationId).toBeNull()
  })

  it("a tenant context cannot DELETE another tenant's Role", async () => {
    const affected = await asTenant(A.orgId, (tx) =>
      tx.$executeRawUnsafe(`DELETE FROM "Role" WHERE "id" = '${B.roleId}'`)
    )
    expect(affected).toBe(0)
    const stillThere = await rawPrisma.role.findUnique({ where: { id: B.roleId } })
    expect(stillThere).not.toBeNull()
  })

  it('a tenant context cannot UPDATE the NULL-org system role (e.g. rename it)', async () => {
    const before = await rawPrisma.role.findUniqueOrThrow({ where: { id: systemRoleId } })

    let thrown: Error | undefined
    let affected: number | undefined
    try {
      affected = await asTenant(A.orgId, (tx) =>
        tx.$executeRawUnsafe(`UPDATE "Role" SET "name" = 'HACKED' WHERE "id" = '${systemRoleId}'`)
      )
    } catch (error) {
      thrown = error as Error
    }
    console.log('[rls-security] system-role UPDATE:', { affected, error: thrown?.message.split('\n').pop() })
    // BEHAVIOUR CHANGED IN FIX ROUND 2, and strengthened rather than weakened.
    //
    // Under round 1 alone this raised an RLS error: UPDATE's USING was still the
    // permissive read predicate, so the NULL-org row WAS eligible, the statement
    // matched it, and only then did the strict WITH CHECK reject the row it would
    // have produced. That rejection depended entirely on the new row being
    // out of scope — which is exactly why round 1 did not stop the variant that
    // writes an IN-scope new row (`SET "organizationId" = '<own org>'`).
    //
    // 20260911201237_restrict_platform_role_updates adds a RESTRICTIVE FOR UPDATE
    // policy whose USING is strict, so the NULL-org row is now filtered out of
    // the update's scan before any new row is formed. The statement therefore
    // affects zero rows instead of erroring — the same shape a cross-tenant
    // `UPDATE "Customer"` has, and a stricter outcome than before: it no longer
    // matters what the new row looks like. See the fix-round-2 block below.
    expect(thrown).toBeUndefined()
    expect(affected).toBe(0)

    const after = await rawPrisma.role.findUniqueOrThrow({ where: { id: systemRoleId } })
    expect(after.name).toBe(before.name)
    expect(after.name).not.toBe('HACKED')
    expect(after.organizationId).toBeNull()
  })

  it('a tenant context cannot relocate its own Role to organizationId = NULL (self-promotion)', async () => {
    let thrown: Error | undefined
    try {
      await asTenant(A.orgId, (tx) =>
        tx.$executeRawUnsafe(`UPDATE "Role" SET "organizationId" = NULL WHERE "id" = '${A.roleId}'`)
      )
    } catch (error) {
      thrown = error as Error
    }
    console.log(
      '[rls-security] self-promotion to platform scope:',
      thrown?.message.split('\n').slice(-2).join(' | ')
    )
    expect(thrown).toBeDefined()
    expect(thrown!.message).toMatch(/row-level security/i)

    const unchanged = await rawPrisma.role.findUniqueOrThrow({ where: { id: A.roleId } })
    expect(unchanged.organizationId).toBe(A.orgId)
  })

  it('a tenant context cannot relocate its own Role into another tenant either', async () => {
    let thrown: Error | undefined
    try {
      await asTenant(A.orgId, (tx) =>
        tx.$executeRawUnsafe(
          `UPDATE "Role" SET "organizationId" = '${B.orgId}' WHERE "id" = '${A.roleId}'`
        )
      )
    } catch (error) {
      thrown = error as Error
    }
    expect(thrown).toBeDefined()
    expect(thrown!.message).toMatch(/row-level security/i)
    const unchanged = await rawPrisma.role.findUniqueOrThrow({ where: { id: A.roleId } })
    expect(unchanged.organizationId).toBe(A.orgId)
  })

  it('a tenant context cannot INSERT a new platform-scoped Role of its own', async () => {
    const rogueRoleId = fakeCuid()
    let thrown: Error | undefined
    try {
      await asTenant(A.orgId, (tx) =>
        tx.$executeRawUnsafe(
          `INSERT INTO "Role" ("id","organizationId","name","isSystemRole")
           VALUES ('${rogueRoleId}', NULL, 'ROGUE PLATFORM ${stamp}', true)`
        )
      )
    } catch (error) {
      thrown = error as Error
    }
    expect(thrown).toBeDefined()
    expect(thrown!.message).toMatch(/row-level security/i)
    const landed = await rawPrisma.role.findMany({ where: { id: rogueRoleId } })
    expect(landed).toEqual([])
  })

  it('the writes a tenant SHOULD be able to do still work (not a blanket deny)', async () => {
    // Control for every rejection above: the same statements, aimed at the
    // tenant's own Role, must succeed.
    const ownRoleId = fakeCuid()
    const created = await asTenant(A.orgId, (tx) =>
      tx.$executeRawUnsafe(
        `INSERT INTO "Role" ("id","organizationId","name","isSystemRole")
         VALUES ('${ownRoleId}', '${A.orgId}', 'OWN ROLE ${stamp}', false)`
      )
    )
    expect(created).toBe(1)

    const renamed = await asTenant(A.orgId, (tx) =>
      tx.$executeRawUnsafe(`UPDATE "Role" SET "name" = 'OWN ROLE RENAMED ${stamp}' WHERE "id" = '${ownRoleId}'`)
    )
    expect(renamed).toBe(1)

    const granted = await asTenant(A.orgId, (tx) =>
      tx.$executeRawUnsafe(
        `INSERT INTO "RolePermission" ("roleId","permissionId")
         VALUES ('${ownRoleId}', '${permissionId}')`
      )
    )
    expect(granted).toBe(1)

    const revoked = await asTenant(A.orgId, (tx) =>
      tx.$executeRawUnsafe(`DELETE FROM "RolePermission" WHERE "roleId" = '${ownRoleId}'`)
    )
    expect(revoked).toBe(1)

    await rawPrisma.rolePermission.deleteMany({ where: { roleId: ownRoleId } })
    await rawPrisma.role.deleteMany({ where: { id: ownRoleId } })
  }, 60_000)

  it('READ behaviour is unchanged: the NULL-org system role and its permissions stay visible', async () => {
    // The half of the fix that must NOT have moved. If this regresses, RBAC
    // reads an empty permission set for SUPER_ADMIN and fails closed.
    const seen = await asTenant(A.orgId, async (tx) => {
      const roles = await tx.$queryRawUnsafe<{ id: string; organizationId: string | null }[]>(
        `SELECT "id","organizationId" FROM "Role"`
      )
      const perms = await tx.$queryRawUnsafe<{ roleId: string }[]>(
        `SELECT "roleId" FROM "RolePermission"`
      )
      return { roleIds: roles.map((r) => r.id), permRoleIds: perms.map((p) => p.roleId) }
    })
    console.log('[rls-security] post-hardening read visibility:', {
      roles: seen.roleIds.length,
      perms: seen.permRoleIds.length,
    })
    expect(seen.roleIds).toContain(systemRoleId)
    expect(seen.roleIds).toContain(A.roleId)
    expect(seen.roleIds).not.toContain(B.roleId)
    expect(seen.permRoleIds).toContain(systemRoleId)
    expect(seen.permRoleIds).toContain(A.roleId)
    expect(seen.permRoleIds).not.toContain(B.roleId)
  })
})

// -----------------------------------------------------------------------------
// Fix Round 2, finding 1 — the OLD-row half of UPDATE on Role / RolePermission.
//
// Round 1 tightened the row an UPDATE *produces* (WITH CHECK) and closed DELETE
// (a RESTRICTIVE FOR DELETE policy). It never tightened the clause that decides
// whether the OLD, pre-update row is eligible to be touched at all: UPDATE's
// USING, which was still the permissive read predicate. So an UPDATE whose old
// row was the NULL-org platform role and whose new row was owned by the caller
// satisfied every round-1 predicate — both ends individually legal, the
// combination an escalation. Measured live after both round-1 migrations, under
// `SET LOCAL ROLE authenticated` (the RLS-subject role this suite used at the
// time; it is `app_runtime` now — see the header note. The finding stands either
// way: both roles are non-owner and non-BYPASSRLS, so the policies bound them
// identically):
//
//   UPDATE "Role" SET "organizationId" = '<own org>' WHERE "organizationId" IS NULL;  -> 1 row
//   UPDATE "RolePermission" SET "roleId" = '<own role>' WHERE "roleId" = '<platform>'; -> 1 row
//
// 20260911201237_restrict_platform_role_updates adds the UPDATE analogue of the
// round-1 DELETE policy: RESTRICTIVE, FOR UPDATE, strict USING. Both halves of
// an UPDATE are now independently guarded, and the tests below prove each one
// separately — old-row rejection (silent zero rows) and new-row rejection (an
// explicit RLS error) — plus the two controls that keep this from being a
// blanket deny: own-tenant UPDATEs still work, and SELECT is untouched.
// -----------------------------------------------------------------------------
describe('Role/RolePermission UPDATE cannot touch platform rows (fix round 2)', () => {
  it('a RESTRICTIVE, UPDATE-only policy now guards the old row', async () => {
    const rows = await rawPrisma.$queryRawUnsafe<
      {
        tablename: string
        cmd: string
        permissive: string
        roles: string
        qual: string
        with_check: string | null
      }[]
    >(
      `SELECT tablename, cmd, permissive, roles::text AS roles, qual, with_check FROM pg_policies
        WHERE schemaname='public' AND policyname='tenant_update_isolation' ORDER BY tablename`
    )
    console.log('[rls-security] update-restriction policies:', rows)
    expect(rows.map((r) => r.tablename)).toEqual(['Role', 'RolePermission'])
    for (const r of rows) {
      expect(r.permissive, `${r.tablename}.permissive`).toBe('RESTRICTIVE')
      // UPDATE only — SELECT, INSERT and DELETE behaviour is provably untouched.
      expect(r.cmd, `${r.tablename}.cmd`).toBe('UPDATE')
      expect(r.roles, `${r.tablename}.roles`).toBe('{public}')
      expect(r.qual, `${r.tablename}.qual`).toMatch(/current_setting\('app\.current_tenant_id'/)
      // The whole point: no NULL-org allowance on the old row.
      expect(r.qual, `${r.tablename}.qual`).not.toMatch(/IS NULL/)
      // Postgres does not mirror a restrictive FOR UPDATE USING into a
      // restrictive WITH CHECK, so the new-row check is exactly what round 1
      // left it — verified here rather than assumed.
      expect(r.with_check, `${r.tablename}.with_check`).toBeNull()
    }
  })

  it('a tenant cannot adopt the NULL-org platform Role by UPDATE (old-row rejection)', async () => {
    // The exact statement an independent reviewer ran against the round-1 state,
    // where it reported rowCount 1. Old row passed the permissive USING; new row
    // (now owned by A) passed the strict WITH CHECK.
    const affected = await asTenant(A.orgId, (tx) =>
      tx.$executeRawUnsafe(
        `UPDATE "Role" SET "organizationId" = '${A.orgId}' WHERE "id" = '${systemRoleId}'`
      )
    )
    console.log('[rls-security] platform-role adoption UPDATE affected:', affected)
    // Silent zero rows, not an error: the restrictive policy filters the old row
    // out of the update's scan before WITH CHECK is ever consulted.
    expect(affected).toBe(0)

    const unchanged = await rawPrisma.role.findUniqueOrThrow({ where: { id: systemRoleId } })
    expect(unchanged.organizationId).toBeNull()
  })

  it('the same adoption phrased as an unkeyed WHERE ... IS NULL also affects zero rows', async () => {
    // Phrasing matters: this form does not name the platform role's id at all,
    // so it cannot be dismissed as "the attacker had to know the id".
    const affected = await asTenant(A.orgId, (tx) =>
      tx.$executeRawUnsafe(
        `UPDATE "Role" SET "organizationId" = '${A.orgId}' WHERE "organizationId" IS NULL`
      )
    )
    console.log('[rls-security] unkeyed platform-role adoption UPDATE affected:', affected)
    expect(affected).toBe(0)

    const stillPlatform = await rawPrisma.role.findUniqueOrThrow({ where: { id: systemRoleId } })
    expect(stillPlatform.organizationId).toBeNull()
  })

  it("a tenant cannot re-parent the platform role's RolePermission onto its own role", async () => {
    // Reported rowCount 1 against the round-1 state. Re-parenting strips the
    // grant from the platform role AND hands it to the tenant in one statement.
    const before = await rawPrisma.rolePermission.findMany({ where: { roleId: systemRoleId } })
    expect(before.length).toBeGreaterThan(0)

    const affected = await asTenant(A.orgId, (tx) =>
      tx.$executeRawUnsafe(
        `UPDATE "RolePermission" SET "roleId" = '${A.roleId}' WHERE "roleId" = '${systemRoleId}'`
      )
    )
    console.log('[rls-security] RolePermission re-parenting UPDATE affected:', affected)
    expect(affected).toBe(0)

    const after = await rawPrisma.rolePermission.findMany({ where: { roleId: systemRoleId } })
    expect(after.length).toBe(before.length)
  })

  it("a tenant cannot UPDATE another tenant's Role or RolePermission either", async () => {
    // The old row is not merely NULL-org-exempt — it must be the caller's own.
    const roleAffected = await asTenant(A.orgId, (tx) =>
      tx.$executeRawUnsafe(`UPDATE "Role" SET "name" = 'HACKED' WHERE "id" = '${B.roleId}'`)
    )
    expect(roleAffected).toBe(0)

    const permAffected = await asTenant(A.orgId, (tx) =>
      tx.$executeRawUnsafe(
        `UPDATE "RolePermission" SET "roleId" = '${A.roleId}' WHERE "roleId" = '${B.roleId}'`
      )
    )
    expect(permAffected).toBe(0)

    const unchanged = await rawPrisma.role.findUniqueOrThrow({ where: { id: B.roleId } })
    expect(unchanged.name).not.toBe('HACKED')
    const bPerms = await rawPrisma.rolePermission.findMany({ where: { roleId: B.roleId } })
    expect(bPerms.length).toBeGreaterThan(0)
  })

  it('the NEW-row check still fires independently of the new old-row check', async () => {
    // Complement of the tests above: here the OLD row IS the caller's own, so
    // the new RESTRICTIVE FOR UPDATE policy admits it — and the update is still
    // refused, by round 1's strict WITH CHECK on the row it would produce. Both
    // halves are therefore proven to work on their own, not one masking the
    // other.
    let thrown: Error | undefined
    try {
      await asTenant(A.orgId, (tx) =>
        tx.$executeRawUnsafe(`UPDATE "Role" SET "organizationId" = NULL WHERE "id" = '${A.roleId}'`)
      )
    } catch (error) {
      thrown = error as Error
    }
    console.log(
      '[rls-security] own-row -> NULL-org UPDATE:',
      thrown?.message.split('\n').slice(-1).join('')
    )
    expect(thrown).toBeDefined()
    expect(thrown!.message).toMatch(/row-level security/i)

    const unchanged = await rawPrisma.role.findUniqueOrThrow({ where: { id: A.roleId } })
    expect(unchanged.organizationId).toBe(A.orgId)
  })

  it('own-tenant UPDATEs still succeed (not a blanket deny)', async () => {
    const ownRoleId = fakeCuid()
    await rawPrisma.role.create({
      data: { id: ownRoleId, organizationId: A.orgId, name: `ROUND2 OWN ${stamp}`, isSystemRole: false },
    })
    await rawPrisma.rolePermission.create({ data: { roleId: ownRoleId, permissionId } })

    const renamed = await asTenant(A.orgId, (tx) =>
      tx.$executeRawUnsafe(
        `UPDATE "Role" SET "name" = 'ROUND2 RENAMED ${stamp}' WHERE "id" = '${ownRoleId}'`
      )
    )
    expect(renamed).toBe(1)

    // A RolePermission UPDATE that moves a grant between two roles the tenant
    // owns: old row in scope, new row in scope, so both clauses admit it.
    const moved = await asTenant(A.orgId, (tx) =>
      tx.$executeRawUnsafe(
        `UPDATE "RolePermission" SET "roleId" = '${ownRoleId}' WHERE "roleId" = '${ownRoleId}'`
      )
    )
    expect(moved).toBe(1)

    const after = await rawPrisma.role.findUniqueOrThrow({ where: { id: ownRoleId } })
    expect(after.name).toBe(`ROUND2 RENAMED ${stamp}`)

    await rawPrisma.rolePermission.deleteMany({ where: { roleId: ownRoleId } })
    await rawPrisma.role.deleteMany({ where: { id: ownRoleId } })
  }, 60_000)

  it('SELECT visibility of the NULL-org platform role is completely unchanged', async () => {
    // The half that must not have moved. A FOR UPDATE policy is never consulted
    // for SELECT, but this is the assertion that makes that a measurement rather
    // than a claim.
    const seen = await asTenant(A.orgId, async (tx) => {
      const roles = await tx.$queryRawUnsafe<{ id: string; organizationId: string | null }[]>(
        `SELECT "id","organizationId" FROM "Role"`
      )
      const perms = await tx.$queryRawUnsafe<{ roleId: string }[]>(
        `SELECT "roleId" FROM "RolePermission"`
      )
      return { roleIds: roles.map((r) => r.id), permRoleIds: perms.map((p) => p.roleId) }
    })
    expect(seen.roleIds).toContain(systemRoleId)
    expect(seen.roleIds).toContain(A.roleId)
    expect(seen.roleIds).not.toContain(B.roleId)
    expect(seen.permRoleIds).toContain(systemRoleId)
    expect(seen.permRoleIds).toContain(A.roleId)
    expect(seen.permRoleIds).not.toContain(B.roleId)
  })
})

// -----------------------------------------------------------------------------
// Fix Round 2, finding 2 — MembershipPlanService / MembershipPlanBranch must
// match the tenant on BOTH ends of the link.
//
// The original policies resolved the row's tenant through "MembershipPlan" only.
// Each of these tables has two foreign keys, and the second one was entirely
// unchecked, so a tenant could link its own plan to another tenant's Service or
// Branch (measured: rowCount 1 for both). Not a read leak — the row stays scoped
// to the caller's own plan — but a durable cross-tenant reference no application
// path can produce legitimately.
// 20260911201510_fix_membership_plan_join_tenant_matching ANDs a second EXISTS
// onto each predicate.
// -----------------------------------------------------------------------------
describe('MembershipPlan join tables match the tenant on both ends (fix round 2)', () => {
  /** A spare plan for A, so control INSERTs do not collide with the fixture PKs. */
  let sparePlanId: string

  beforeAll(async () => {
    const plan = await rawPrisma.membershipPlan.create({
      data: {
        organizationId: A.orgId,
        name: `RLS a spare plan ${stamp}`,
        price: new Prisma.Decimal('49.00'),
        durationValue: 1,
        durationUnit: 'MONTHLY',
      },
    })
    sparePlanId = plan.id
  }, 120_000)

  afterAll(async () => {
    try {
      await rawPrisma.membershipPlanService.deleteMany({ where: { membershipPlanId: sparePlanId } })
      await rawPrisma.membershipPlanBranch.deleteMany({ where: { membershipPlanId: sparePlanId } })
      await rawPrisma.membershipPlan.deleteMany({ where: { id: sparePlanId } })
    } catch (error) {
      console.warn('[rls-security] round-2 join-table teardown skipped:', (error as Error).message)
    }
  }, 120_000)

  it('both policies now test the linked Service/Branch as well as the plan', async () => {
    const rows = await rawPrisma.$queryRawUnsafe<{ tablename: string; qual: string }[]>(
      `SELECT tablename, qual FROM pg_policies
        WHERE schemaname='public' AND policyname='tenant_isolation'
          AND tablename IN ('MembershipPlanService','MembershipPlanBranch') ORDER BY tablename`
    )
    console.log('[rls-security] join-table policies:', rows)
    expect(rows.map((r) => r.tablename)).toEqual(['MembershipPlanBranch', 'MembershipPlanService'])
    const byTable = new Map(rows.map((r) => [r.tablename, r.qual]))
    expect(byTable.get('MembershipPlanService')).toMatch(/FROM "MembershipPlan"/)
    expect(byTable.get('MembershipPlanService')).toMatch(/FROM "Service"/)
    expect(byTable.get('MembershipPlanBranch')).toMatch(/FROM "MembershipPlan"/)
    expect(byTable.get('MembershipPlanBranch')).toMatch(/FROM "Branch"/)
  })

  it("a tenant cannot link its own plan to another tenant's Service", async () => {
    let thrown: Error | undefined
    try {
      await asTenant(A.orgId, (tx) =>
        tx.$executeRawUnsafe(
          `INSERT INTO "MembershipPlanService" ("membershipPlanId","serviceId")
           VALUES ('${sparePlanId}', '${B.serviceId}')`
        )
      )
    } catch (error) {
      thrown = error as Error
    }
    console.log(
      '[rls-security] cross-tenant plan->service link:',
      thrown?.message.split('\n').slice(-1).join('')
    )
    expect(thrown).toBeDefined()
    expect(thrown!.message).toMatch(/row-level security/i)

    const landed = await rawPrisma.membershipPlanService.findMany({
      where: { membershipPlanId: sparePlanId, serviceId: B.serviceId },
    })
    expect(landed).toEqual([])
  })

  it("a tenant cannot link its own plan to another tenant's Branch", async () => {
    let thrown: Error | undefined
    try {
      await asTenant(A.orgId, (tx) =>
        tx.$executeRawUnsafe(
          `INSERT INTO "MembershipPlanBranch" ("membershipPlanId","branchId")
           VALUES ('${sparePlanId}', '${B.branchId}')`
        )
      )
    } catch (error) {
      thrown = error as Error
    }
    console.log(
      '[rls-security] cross-tenant plan->branch link:',
      thrown?.message.split('\n').slice(-1).join('')
    )
    expect(thrown).toBeDefined()
    expect(thrown!.message).toMatch(/row-level security/i)

    const landed = await rawPrisma.membershipPlanBranch.findMany({
      where: { membershipPlanId: sparePlanId, branchId: B.branchId },
    })
    expect(landed).toEqual([])
  })

  it('the same links to the tenant\'s OWN Service and Branch still succeed', async () => {
    // Control: identical statements, same-tenant targets. Without this the two
    // rejections above could be a blanket deny rather than a tenant match.
    const linkedService = await asTenant(A.orgId, (tx) =>
      tx.$executeRawUnsafe(
        `INSERT INTO "MembershipPlanService" ("membershipPlanId","serviceId")
         VALUES ('${sparePlanId}', '${A.serviceId}')`
      )
    )
    expect(linkedService).toBe(1)

    const linkedBranch = await asTenant(A.orgId, (tx) =>
      tx.$executeRawUnsafe(
        `INSERT INTO "MembershipPlanBranch" ("membershipPlanId","branchId")
         VALUES ('${sparePlanId}', '${A.branchId}')`
      )
    )
    expect(linkedBranch).toBe(1)

    // And they are readable by their own tenant afterwards.
    const visible = await asTenant(A.orgId, async (tx) => ({
      services: await tx.membershipPlanService.findMany({ where: { membershipPlanId: sparePlanId } }),
      branches: await tx.membershipPlanBranch.findMany({ where: { membershipPlanId: sparePlanId } }),
    }))
    expect(visible.services.map((r) => r.serviceId)).toEqual([A.serviceId])
    expect(visible.branches.map((r) => r.branchId)).toEqual([A.branchId])

    await rawPrisma.membershipPlanService.deleteMany({ where: { membershipPlanId: sparePlanId } })
    await rawPrisma.membershipPlanBranch.deleteMany({ where: { membershipPlanId: sparePlanId } })
  }, 60_000)

  it("an UPDATE cannot swing an existing link onto another tenant's Service", async () => {
    // The verb the INSERT tests do not cover: re-pointing a link row the tenant
    // legitimately owns at a foreign Service. The old row is in scope, so this is
    // purely a test of the widened WITH CHECK (Postgres reuses USING for it,
    // since these policies state no explicit WITH CHECK).
    await rawPrisma.membershipPlanService.create({
      data: { membershipPlanId: sparePlanId, serviceId: A.serviceId },
    })

    let thrown: Error | undefined
    try {
      await asTenant(A.orgId, (tx) =>
        tx.$executeRawUnsafe(
          `UPDATE "MembershipPlanService" SET "serviceId" = '${B.serviceId}'
            WHERE "membershipPlanId" = '${sparePlanId}'`
        )
      )
    } catch (error) {
      thrown = error as Error
    }
    console.log(
      '[rls-security] cross-tenant plan->service re-point:',
      thrown?.message.split('\n').slice(-1).join('')
    )
    expect(thrown).toBeDefined()
    expect(thrown!.message).toMatch(/row-level security/i)

    const stillOwn = await rawPrisma.membershipPlanService.findMany({
      where: { membershipPlanId: sparePlanId },
    })
    expect(stillOwn.map((r) => r.serviceId)).toEqual([A.serviceId])

    await rawPrisma.membershipPlanService.deleteMany({ where: { membershipPlanId: sparePlanId } })
  }, 60_000)
})

// -----------------------------------------------------------------------------
// #16 / #17 — the application's own WHERE clause is not what isolates.
// -----------------------------------------------------------------------------
describe('isolation survives the application layer (security items 16 and 17)', () => {
  it('tx.customer.findMany() with NO where clause still returns only the active tenant', async () => {
    // The core proof: Postgres is doing the filtering, not the application.
    const rows = await asTenant(A.orgId, (tx) => tx.customer.findMany())
    console.log('[rls-security] unfiltered findMany() row count for A:', rows.length)
    expect(rows.length).toBeGreaterThan(0)
    expect(rows.every((r) => r.organizationId === A.orgId)).toBe(true)
    expect(rows.some((r) => r.id === B.customerId)).toBe(false)

    // For contrast, the same unfiltered query as the bypassing runtime role sees
    // the whole table — which is exactly why the role-privilege finding matters.
    const unrestricted = await withTenantContext(A.orgId, (tx) => tx.customer.count(), TX_OPTIONS)
    console.log('[rls-security] same query as the runtime role sees:', unrestricted, 'rows')
    if (runtimeRole.rolbypassrls || runtimeRole.rolsuper) {
      expect(unrestricted).toBeGreaterThan(rows.length)
    }
  })

  it('unfiltered findMany() on Branch, Horse and Service is filtered by Postgres too', async () => {
    const seen = await asTenant(B.orgId, async (tx) => ({
      branches: await tx.branch.findMany(),
      horses: await tx.horse.findMany(),
      services: await tx.service.findMany(),
    }))
    expect(seen.branches.length).toBeGreaterThan(0)
    expect(seen.branches.every((r) => r.organizationId === B.orgId)).toBe(true)
    expect(seen.horses.every((r) => r.organizationId === B.orgId)).toBe(true)
    expect(seen.services.every((r) => r.organizationId === B.orgId)).toBe(true)
  })

  it('an injection payload passed as an ordinary Prisma argument is parameterised, not interpolated', async () => {
    const payloads = [
      "' OR '1'='1",
      "'; DROP TABLE \"Customer\"; --",
      `${A.orgId}' OR 'x'='x`,
      "1' UNION SELECT * FROM \"Customer\" --",
    ]
    for (const payload of payloads) {
      const rows = await asTenant(A.orgId, (tx) =>
        tx.customer.findMany({ where: { organizationId: payload } })
      )
      expect(rows).toEqual([])
    }

    // A payload in a non-key field, through a string operator.
    const byName = await asTenant(A.orgId, (tx) =>
      tx.customer.findMany({ where: { firstName: { contains: "'; DROP TABLE \"Customer\"; --" } } })
    )
    expect(byName).toEqual([])

    // The table is still there and still holds its rows: nothing was executed.
    const stillThere = await rawPrisma.customer.findUnique({ where: { id: A.customerId } })
    expect(stillThere).not.toBeNull()

    // And a legitimate filter still works — proving the empty results above are
    // "no match", not "query broken".
    const legit = await asTenant(A.orgId, (tx) =>
      tx.customer.findMany({ where: { organizationId: A.orgId } })
    )
    expect(legit.length).toBeGreaterThan(0)
    expect(legit.every((r) => r.organizationId === A.orgId)).toBe(true)
  }, 60_000)

  it("an application filter naming another tenant's org returns nothing, even though the row exists", async () => {
    // The dangerous case a pure application-layer boundary cannot stop: code
    // that asks for the wrong organizationId on purpose. RLS makes it empty.
    const rows = await asTenant(A.orgId, (tx) =>
      tx.customer.findMany({ where: { organizationId: B.orgId } })
    )
    expect(rows).toEqual([])

    const byId = await asTenant(A.orgId, (tx) =>
      tx.customer.findUnique({ where: { id: B.customerId } })
    )
    expect(byId).toBeNull()

    const exists = await rawPrisma.customer.findUnique({ where: { id: B.customerId } })
    expect(exists).not.toBeNull()
  })
})

// -----------------------------------------------------------------------------
// Fix Round 3, finding 1 — "Permission" had no RLS at all, and
// "RolePermission"."permissionId" is ON DELETE CASCADE.
//
// Rounds 1 and 2 made the NULL-org platform role's grants unreachable through
// "Role" and "RolePermission" themselves. The same outcome stayed reachable one
// table over: measured live under `SET LOCAL ROLE authenticated` (this suite's
// RLS-subject role at the time; `app_runtime` now — see the header note) with a valid
// tenant context, before 20260911205351_lock_down_permission_catalog_writes,
//
//     DELETE FROM "Permission" WHERE "id" = '<permission>';   -> 1 row,
//       and the platform role's matching RolePermission row cascaded away (1->0)
//     INSERT INTO "Permission" ...                            -> 1 row
//     UPDATE "Permission" SET "description" = 'HACKED' ...    -> 1 row
//
// The fix is shaped by what the table IS: a fixed, global, public catalog
// (src/config/permissions.ts) with no tenant of its own. So it is not a tenant
// predicate — it is ENABLE + FORCE plus exactly one permissive policy,
// `permission_public_read` FOR SELECT USING (true), and deliberately no policy
// covering INSERT/UPDATE/DELETE. Readable everywhere; writable by nobody subject
// to RLS.
//
// The "no policy for a command means deny" behaviour is asserted here
// empirically, per command, rather than taken on faith from the Postgres docs.
// -----------------------------------------------------------------------------
describe('Permission is a read-only public catalog under RLS (fix round 3)', () => {
  it('has RLS enabled and forced, with exactly one SELECT-only permissive policy', async () => {
    const state = await rawPrisma.$queryRawUnsafe<
      { rls: boolean; force: boolean; policies: number }[]
    >(
      `SELECT c.relrowsecurity AS rls, c.relforcerowsecurity AS force,
              (SELECT count(*)::int FROM pg_policies p
                WHERE p.schemaname='public' AND p.tablename='Permission') AS policies
         FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
        WHERE n.nspname='public' AND c.relname='Permission'`
    )
    console.log('[rls-security] Permission RLS state:', state[0])
    expect(state[0].rls).toBe(true)
    expect(state[0].force).toBe(true)
    expect(state[0].policies).toBe(1)

    const policy = await rawPrisma.$queryRawUnsafe<
      { policyname: string; cmd: string; permissive: string; roles: string; qual: string; with_check: string | null }[]
    >(
      `SELECT policyname, cmd, permissive, roles::text AS roles, qual, with_check
         FROM pg_policies WHERE schemaname='public' AND tablename='Permission'`
    )
    console.log('[rls-security] Permission policy:', policy[0])
    expect(policy[0].policyname).toBe('permission_public_read')
    // SELECT-only is the whole mechanism: every write command is left with zero
    // matching policies, which is what denies it.
    expect(policy[0].cmd).toBe('SELECT')
    expect(policy[0].permissive).toBe('PERMISSIVE')
    expect(policy[0].roles).toBe('{public}')
    expect(policy[0].qual).toBe('true')
    expect(policy[0].with_check).toBeNull()
  })

  it('stays fully readable from a tenant context, a ghost context, and no context at all', async () => {
    const asBypassingRole = await rawPrisma.permission.count()
    expect(asBypassingRole).toBeGreaterThan(0)

    const [fromTenant, fromNoContext, fromGhost] = await Promise.all([
      asTenant(A.orgId, (tx) => count(tx, `SELECT count(*)::int AS count FROM "Permission"`)),
      withNoTenantContext((tx) => count(tx, `SELECT count(*)::int AS count FROM "Permission"`)),
      withRawTenantContext(fakeCuid(), (tx) =>
        count(tx, `SELECT count(*)::int AS count FROM "Permission"`)
      ),
    ])
    console.log('[rls-security] Permission readability:', {
      asBypassingRole,
      fromTenant,
      fromNoContext,
      fromGhost,
    })
    // Identical in every context — RLS must not have turned a public catalog
    // into tenant data, or RBAC would fail closed for reasons unrelated to
    // tenancy.
    expect(fromTenant).toBe(asBypassingRole)
    expect(fromNoContext).toBe(asBypassingRole)
    expect(fromGhost).toBe(asBypassingRole)

    // And the specific row this suite created is among them, reachable by id and
    // through the Prisma delegate, not merely counted.
    const byId = await asTenant(A.orgId, (tx) =>
      tx.permission.findMany({ where: { id: permissionId } })
    )
    expect(byId.map((p) => p.id)).toEqual([permissionId])
  })

  it('rejects INSERT from a tenant context — and from any RLS-subject context', async () => {
    for (const [label, run] of [
      ['tenant context', (sql: string) => asTenant(A.orgId, (tx) => tx.$executeRawUnsafe(sql))],
      ['no tenant context', (sql: string) => withNoTenantContext((tx) => tx.$executeRawUnsafe(sql))],
    ] as const) {
      const key = `rls.round3.insert.${label.replace(/\s/g, '-')}.${stamp}`
      let thrown: Error | undefined
      try {
        await run(
          `INSERT INTO "Permission" ("id","key","description")
           VALUES ('${fakeCuid()}', '${key}', 'round-3 rogue catalog entry')`
        )
      } catch (error) {
        thrown = error as Error
      }
      console.log(
        `[rls-security] Permission INSERT (${label}):`,
        thrown?.message.split('\n').slice(-1).join('')
      )
      expect(thrown, label).toBeDefined()
      expect(thrown!.message, label).toMatch(/row-level security/i)

      // Checked as the bypassing role: nothing landed.
      const landed = await rawPrisma.permission.findMany({ where: { key } })
      expect(landed, label).toEqual([])
    }
  }, 60_000)

  it('rejects UPDATE from a tenant context (zero rows, catalog unchanged)', async () => {
    const before = await rawPrisma.permission.findUniqueOrThrow({ where: { id: permissionId } })

    const affected = await asTenant(A.orgId, (tx) =>
      tx.$executeRawUnsafe(
        `UPDATE "Permission" SET "description" = 'HACKED' WHERE "id" = '${permissionId}'`
      )
    )
    console.log('[rls-security] Permission UPDATE affected:', affected)
    // Zero rows rather than an error: with no policy covering UPDATE, the old
    // row is not eligible, so nothing is even scanned into the update.
    expect(affected).toBe(0)

    const after = await rawPrisma.permission.findUniqueOrThrow({ where: { id: permissionId } })
    expect(after.description).toBe(before.description)
    expect(after.description).not.toBe('HACKED')

    // The `key` column is the one RBAC resolves through, so try that too.
    const keyAffected = await asTenant(A.orgId, (tx) =>
      tx.$executeRawUnsafe(`UPDATE "Permission" SET "key" = 'billing.manage.rogue' WHERE "id" = '${permissionId}'`)
    )
    expect(keyAffected).toBe(0)
    const keyAfter = await rawPrisma.permission.findUniqueOrThrow({ where: { id: permissionId } })
    expect(keyAfter.key).toBe(before.key)
  }, 60_000)

  it("rejects DELETE, so the cascade into the platform role's grants is unreachable", async () => {
    // The finding in its original form. RolePermission.permissionId is ON DELETE
    // CASCADE, so before the fix this one statement stripped the NULL-org
    // platform role of the grant resolving through this permission.
    const grantsBefore = await rawPrisma.rolePermission.count({ where: { roleId: systemRoleId } })
    expect(grantsBefore).toBeGreaterThan(0)

    const affected = await asTenant(A.orgId, (tx) =>
      tx.$executeRawUnsafe(`DELETE FROM "Permission" WHERE "id" = '${permissionId}'`)
    )
    console.log('[rls-security] Permission DELETE affected:', affected)
    expect(affected).toBe(0)

    // Unkeyed phrasing too: "the attacker had to know the id" is not a defence.
    const wholeTable = await asTenant(A.orgId, (tx) =>
      tx.$executeRawUnsafe(`DELETE FROM "Permission"`)
    )
    expect(wholeTable).toBe(0)

    const noContext = await withNoTenantContext((tx) =>
      tx.$executeRawUnsafe(`DELETE FROM "Permission" WHERE "id" = '${permissionId}'`)
    )
    expect(noContext).toBe(0)

    // Verified as the bypassing role: the permission row and, crucially, the
    // platform role's grants are all still there.
    const stillThere = await rawPrisma.permission.findUnique({ where: { id: permissionId } })
    expect(stillThere).not.toBeNull()
    const grantsAfter = await rawPrisma.rolePermission.count({ where: { roleId: systemRoleId } })
    expect(grantsAfter).toBe(grantsBefore)
  }, 60_000)

  it("the seed script's own write path is unaffected (it runs as a BYPASSRLS role)", async () => {
    // Not an imitation of the seed — the seed's exported function itself,
    // executed against the live database after the migration. It upserts every
    // key in src/config/permissions.ts through rawPrisma.
    await seedGlobalPermissions()

    const seeded = await rawPrisma.permission.findMany({
      where: { key: { in: [...PERMISSIONS] } },
    })
    console.log('[rls-security] seeded catalog keys present:', seeded.length, 'of', PERMISSIONS.length)
    expect(seeded.length).toBe(PERMISSIONS.length)

    // And the full write triad through the same role, to show the deny applies
    // to RLS-subject roles only. Cleaned up immediately.
    const probeKey = `rls.round3.seedpath.${stamp}`
    const created = await rawPrisma.permission.create({
      data: { key: probeKey, description: 'round-3 seed-path probe' },
    })
    const updated = await rawPrisma.permission.update({
      where: { id: created.id },
      data: { description: 'round-3 seed-path probe, updated' },
    })
    expect(updated.description).toMatch(/updated/)
    await rawPrisma.permission.delete({ where: { id: created.id } })
    expect(await rawPrisma.permission.findUnique({ where: { id: created.id } })).toBeNull()

    // The measured reason this works, recorded rather than assumed.
    console.log('[rls-security] seed-path role:', {
      role: runtimeRole.current_user,
      rolbypassrls: runtimeRole.rolbypassrls,
      rolsuper: runtimeRole.rolsuper,
    })
    expect(runtimeRole.rolbypassrls || runtimeRole.rolsuper).toBe(true)
  }, 120_000)

  it("Postgres's zero-policy default really is deny on this server, per command", async () => {
    // The claim the whole fix rests on, measured on this exact deployment rather
    // than quoted from the manual: a table with RLS enabled and only a SELECT
    // policy denies every other command. Proved on a throwaway table so the
    // result cannot be an artefact of "Permission"'s grants or contents, then
    // dropped.
    const table = `rls_default_deny_${Date.now()}`
    await rawPrisma.$executeRawUnsafe(`CREATE TABLE "${table}" (id text primary key, v text)`)
    try {
      await rawPrisma.$executeRawUnsafe(`INSERT INTO "${table}" VALUES ('seed','before')`)
      await rawPrisma.$executeRawUnsafe(
        `GRANT SELECT, INSERT, UPDATE, DELETE ON "${table}" TO ${RLS_SUBJECT_ROLE}`
      )
      await rawPrisma.$executeRawUnsafe(`ALTER TABLE "${table}" ENABLE ROW LEVEL SECURITY`)
      await rawPrisma.$executeRawUnsafe(`ALTER TABLE "${table}" FORCE ROW LEVEL SECURITY`)
      await rawPrisma.$executeRawUnsafe(
        `CREATE POLICY read_all ON "${table}" FOR SELECT USING (true)`
      )

      const observed = await withNoTenantContext(async (tx) => {
        const selected = await count(tx, `SELECT count(*)::int AS count FROM "${table}"`)
        let insertError: string | null = null
        try {
          await tx.$executeRawUnsafe(`INSERT INTO "${table}" VALUES ('rogue','x')`)
        } catch (error) {
          insertError = (error as Error).message
        }
        return { selected, insertError }
      })
      // A failed INSERT aborts its transaction, so UPDATE/DELETE are measured in
      // a second one.
      const writes = await withNoTenantContext(async (tx) => ({
        updated: await tx.$executeRawUnsafe(`UPDATE "${table}" SET v = 'after'`),
        deleted: await tx.$executeRawUnsafe(`DELETE FROM "${table}"`),
      }))

      console.log('[rls-security] zero-policy default-deny measurement:', {
        ...observed,
        ...writes,
      })
      // SELECT: allowed by the one policy that exists.
      expect(observed.selected).toBe(1)
      // INSERT: no policy covers it -> hard error.
      expect(observed.insertError).toMatch(/row-level security/i)
      // UPDATE / DELETE: no policy covers them -> no row is eligible.
      expect(writes.updated).toBe(0)
      expect(writes.deleted).toBe(0)

      const survived = await rawPrisma.$queryRawUnsafe<{ v: string; n: number }[]>(
        `SELECT v, count(*)::int AS n FROM "${table}" GROUP BY v`
      )
      expect(survived).toEqual([{ v: 'before', n: 1 }])
    } finally {
      await rawPrisma.$executeRawUnsafe(`DROP TABLE IF EXISTS "${table}"`)
    }
  }, 120_000)
})

// -----------------------------------------------------------------------------
// Fix Round 3, finding 2 — "Membership"."roleId" was never checked against the
// Membership's own tenant.
//
// The policy tested "organizationId" alone and carried no explicit WITH CHECK,
// so that one predicate governed writes too. Measured live under `SET LOCAL ROLE
// authenticated` (this suite's RLS-subject role at the time; `app_runtime` now —
// see the header note) with a valid tenant context, before
// 20260911205920_restrict_membership_role_to_own_tenant:
//
//   INSERT INTO "Membership" (...,'<own org>','<NULL-org platform role>') -> 1 row
//   INSERT INTO "Membership" (...,'<own org>','<other tenant''s role>')   -> 1 row
//   UPDATE "Membership" SET "roleId" = '<platform role>' ...              -> 1 row
//   UPDATE "Membership" SET "roleId" = '<other tenant''s role>' ...       -> 1 row
//
// i.e. a tenant could grant one of its own users the platform SUPER_ADMIN role
// without touching "Role" or "RolePermission" at all. Latent today (no RBAC
// resolution code exists until Task 13), silent the moment it isn't.
//
// SEMANTICS — deliberately NOT round 1's NULL-org exception. Membership's
// organizationId is NOT NULL and a Membership means "this person's role INSIDE
// this organization", while Role.organizationId IS NULL means "platform-wide
// system role". A Membership pointing at one is the escalation itself, and
// nothing in this repo creates such a row. So: strict equality, no exception.
//
// ERRATUM to 20260911205920_restrict_membership_role_to_own_tenant's own comment:
// it says platform administrators are modelled by `User.type = PLATFORM_ADMIN`.
// That enum member does not exist. prisma/schema.prisma declares
// `enum UserType { SUPER_ADMIN STAFF CUSTOMER }`, so the correct name is
// SUPER_ADMIN. The correction is recorded here rather than in the migration
// because that migration is already applied and Prisma stores a checksum of its
// bytes in _prisma_migrations; editing even a comment makes `prisma migrate
// dev`/`deploy` refuse to run until the checksum is re-recorded. Nothing
// executable is affected — the SQL never referenced the enum.
//
// And the fix is a WITH CHECK only. Membership's USING already admits nothing
// but the caller's own rows (unlike Role/RolePermission, whose USING had to stay
// permissive), so DELETE and the old-row half of UPDATE are already strict and
// need no RESTRICTIVE policy; the new-row half is the entire attack surface.
// -----------------------------------------------------------------------------
describe('Membership.roleId must belong to the same tenant (fix round 3)', () => {
  /** Users with no Membership yet — @@unique([userId, organizationId]) bites otherwise. */
  let freeUserAId: string
  let freeUserA2Id: string
  let membershipId: string

  beforeAll(async () => {
    const [u1, u2] = await Promise.all([
      rawPrisma.user.create({
        data: {
          email: `rls-r3-a-${stamp}@test.com`,
          passwordHash: 'x',
          type: 'STAFF',
          name: 'RLS round3 member',
        },
      }),
      rawPrisma.user.create({
        data: {
          email: `rls-r3-b-${stamp}@test.com`,
          passwordHash: 'x',
          type: 'STAFF',
          name: 'RLS round3 member 2',
        },
      }),
    ])
    freeUserAId = u1.id
    freeUserA2Id = u2.id

    // A legitimate, same-tenant Membership for tenant A, created as the
    // bypassing role — the UPDATE tests need an existing row to aim at.
    const membership = await rawPrisma.membership.create({
      data: { userId: freeUserA2Id, organizationId: A.orgId, roleId: A.roleId },
    })
    membershipId = membership.id
  }, 120_000)

  afterAll(async () => {
    try {
      await rawPrisma.membership.deleteMany({
        where: { userId: { in: [freeUserAId, freeUserA2Id] } },
      })
      await rawPrisma.user.deleteMany({ where: { id: { in: [freeUserAId, freeUserA2Id] } } })
    } catch (error) {
      console.warn('[rls-security] round-3 membership teardown skipped:', (error as Error).message)
    }
  }, 120_000)

  it('the policy now carries an explicit WITH CHECK that joins Membership to Role', async () => {
    const rows = await rawPrisma.$queryRawUnsafe<
      { qual: string; with_check: string | null }[]
    >(
      `SELECT qual, with_check FROM pg_policies
        WHERE schemaname='public' AND tablename='Membership' AND policyname='tenant_isolation'`
    )
    console.log('[rls-security] Membership policy:', rows[0])
    expect(rows.length).toBe(1)

    // READ side: unchanged, still the row's own organizationId and nothing else.
    expect(rows[0].qual).toMatch(/current_setting\('app\.current_tenant_id'/)
    expect(rows[0].qual).not.toMatch(/FROM "Role"/)

    // WRITE side: tenant match AND a strict Role tenant match, with no NULL-org
    // allowance anywhere in it.
    expect(rows[0].with_check).not.toBeNull()
    expect(rows[0].with_check).toMatch(/current_setting\('app\.current_tenant_id'/)
    expect(rows[0].with_check).toMatch(/EXISTS[\s\S]*FROM "Role"[\s\S]*"roleId"/)
    expect(rows[0].with_check).toMatch(/"Role"\."organizationId" = "Membership"\."organizationId"/)
    // No NULL-org ROLE allowance: a NULL-org platform Role must never satisfy
    // this predicate, which is the whole point of round 3.
    //
    // Narrowed from a blanket `not.toMatch(/IS NULL/)` by Part C
    // (20260912103749_enforce_foreign_key_tenant_matching), which added a second
    // conjunct for Membership's OTHER tenant-crossing foreign key, `branchId`.
    // That column IS nullable — an organization-wide membership with no home
    // branch — so its conjunct legitimately contains `"branchId" IS NULL`. The
    // blanket assertion would reject that while claiming to be about Role, so it
    // is stated precisely instead: the string that must not appear is an
    // organizationId NULL allowance.
    expect(rows[0].with_check).not.toMatch(/"organizationId" IS NULL/)
    expect(rows[0].with_check).toMatch(/"branchId" IS NULL/)

    // Membership is still counted as a single-policy table — no RESTRICTIVE
    // policy was added, because USING is already strict here (see the block
    // comment above).
    const policies = await rawPrisma.$queryRawUnsafe<{ n: number }[]>(
      `SELECT count(*)::int AS n FROM pg_policies WHERE schemaname='public' AND tablename='Membership'`
    )
    expect(policies[0].n).toBe(1)
  })

  it('a tenant cannot INSERT a Membership pointing at the NULL-org platform role', async () => {
    // The escalation in its purest form: tenant A hands one of its own users the
    // platform SUPER_ADMIN role, without ever touching Role or RolePermission.
    let thrown: Error | undefined
    const rogueId = fakeCuid()
    try {
      await asTenant(A.orgId, (tx) =>
        tx.$executeRawUnsafe(
          `INSERT INTO "Membership" ("id","userId","organizationId","roleId")
           VALUES ('${rogueId}', '${freeUserAId}', '${A.orgId}', '${systemRoleId}')`
        )
      )
    } catch (error) {
      thrown = error as Error
    }
    console.log(
      '[rls-security] Membership -> platform role INSERT:',
      thrown?.message.split('\n').slice(-1).join('')
    )
    expect(thrown).toBeDefined()
    expect(thrown!.message).toMatch(/row-level security/i)

    const landed = await rawPrisma.membership.findMany({ where: { id: rogueId } })
    expect(landed).toEqual([])
  })

  it("a tenant cannot INSERT a Membership pointing at another tenant's role", async () => {
    let thrown: Error | undefined
    const rogueId = fakeCuid()
    try {
      await asTenant(A.orgId, (tx) =>
        tx.$executeRawUnsafe(
          `INSERT INTO "Membership" ("id","userId","organizationId","roleId")
           VALUES ('${rogueId}', '${freeUserAId}', '${A.orgId}', '${B.roleId}')`
        )
      )
    } catch (error) {
      thrown = error as Error
    }
    console.log(
      '[rls-security] Membership -> foreign-tenant role INSERT:',
      thrown?.message.split('\n').slice(-1).join('')
    )
    expect(thrown).toBeDefined()
    expect(thrown!.message).toMatch(/row-level security/i)

    const landed = await rawPrisma.membership.findMany({ where: { id: rogueId } })
    expect(landed).toEqual([])
  })

  it('a tenant cannot UPDATE an existing Membership onto the platform role', async () => {
    // The verb the INSERT tests miss: the row is legitimately the tenant's own,
    // so USING admits it — and WITH CHECK rejects the row it would produce.
    let thrown: Error | undefined
    try {
      await asTenant(A.orgId, (tx) =>
        tx.$executeRawUnsafe(
          `UPDATE "Membership" SET "roleId" = '${systemRoleId}' WHERE "id" = '${membershipId}'`
        )
      )
    } catch (error) {
      thrown = error as Error
    }
    console.log(
      '[rls-security] Membership roleId re-point to platform role:',
      thrown?.message.split('\n').slice(-1).join('')
    )
    expect(thrown).toBeDefined()
    expect(thrown!.message).toMatch(/row-level security/i)

    const unchanged = await rawPrisma.membership.findUniqueOrThrow({ where: { id: membershipId } })
    expect(unchanged.roleId).toBe(A.roleId)
  })

  it("a tenant cannot UPDATE an existing Membership onto another tenant's role", async () => {
    let thrown: Error | undefined
    try {
      await asTenant(A.orgId, (tx) =>
        tx.$executeRawUnsafe(
          `UPDATE "Membership" SET "roleId" = '${B.roleId}' WHERE "id" = '${membershipId}'`
        )
      )
    } catch (error) {
      thrown = error as Error
    }
    expect(thrown).toBeDefined()
    expect(thrown!.message).toMatch(/row-level security/i)

    const unchanged = await rawPrisma.membership.findUniqueOrThrow({ where: { id: membershipId } })
    expect(unchanged.roleId).toBe(A.roleId)
  })

  it('cross-tenant Membership writes are still rejected (the original predicate survived)', async () => {
    // Naming WITH CHECK explicitly ends Postgres's implicit reuse of USING, so
    // the tenant-match conjunct had to be restated. This proves it was.
    let thrown: Error | undefined
    try {
      await asTenant(A.orgId, (tx) =>
        tx.$executeRawUnsafe(
          `INSERT INTO "Membership" ("id","userId","organizationId","roleId")
           VALUES ('${fakeCuid()}', '${freeUserAId}', '${B.orgId}', '${B.roleId}')`
        )
      )
    } catch (error) {
      thrown = error as Error
    }
    expect(thrown).toBeDefined()
    expect(thrown!.message).toMatch(/row-level security/i)
  })

  it('a legitimate same-tenant Membership can still be created, read, updated and deleted', async () => {
    // The control that keeps every rejection above from being a blanket deny —
    // and the specific thing a strict predicate could plausibly have broken.
    const okId = fakeCuid()
    const created = await asTenant(A.orgId, (tx) =>
      tx.$executeRawUnsafe(
        `INSERT INTO "Membership" ("id","userId","organizationId","roleId")
         VALUES ('${okId}', '${freeUserAId}', '${A.orgId}', '${A.roleId}')`
      )
    )
    expect(created).toBe(1)

    // Readable by its own tenant, through the Prisma delegate with no filter.
    const visible = await asTenant(A.orgId, (tx) => tx.membership.findMany())
    expect(visible.map((m) => m.id)).toContain(okId)
    expect(visible.every((m) => m.organizationId === A.orgId)).toBe(true)

    // Invisible to the other tenant.
    const fromB = await asTenant(B.orgId, (tx) => tx.membership.findMany())
    expect(fromB.map((m) => m.id)).not.toContain(okId)

    // A non-role UPDATE still works (WITH CHECK re-evaluates the whole row, so a
    // wrong predicate would have broken even this).
    const accepted = await asTenant(A.orgId, (tx) =>
      tx.$executeRawUnsafe(`UPDATE "Membership" SET "acceptedAt" = now() WHERE "id" = '${okId}'`)
    )
    expect(accepted).toBe(1)

    // And a roleId UPDATE onto another role of the SAME tenant is still allowed.
    const siblingRoleId = fakeCuid()
    await rawPrisma.role.create({
      data: { id: siblingRoleId, organizationId: A.orgId, name: `ROUND3 SIBLING ${stamp}`, isSystemRole: false },
    })
    const rerouted = await asTenant(A.orgId, (tx) =>
      tx.$executeRawUnsafe(
        `UPDATE "Membership" SET "roleId" = '${siblingRoleId}' WHERE "id" = '${okId}'`
      )
    )
    expect(rerouted).toBe(1)
    const after = await rawPrisma.membership.findUniqueOrThrow({ where: { id: okId } })
    expect(after.roleId).toBe(siblingRoleId)

    // DELETE of its own row is untouched (governed by USING, which did not move).
    const deleted = await asTenant(A.orgId, (tx) =>
      tx.$executeRawUnsafe(`DELETE FROM "Membership" WHERE "id" = '${okId}'`)
    )
    expect(deleted).toBe(1)
    expect(await rawPrisma.membership.findUnique({ where: { id: okId } })).toBeNull()

    await rawPrisma.role.deleteMany({ where: { id: siblingRoleId } })
  }, 120_000)

  it('the Prisma delegate path is blocked too, not just raw SQL', async () => {
    await expect(
      asTenant(A.orgId, (tx) =>
        tx.membership.create({
          data: { userId: freeUserAId, organizationId: A.orgId, roleId: systemRoleId },
        })
      )
    ).rejects.toThrow(/row-level security/i)

    const landed = await rawPrisma.membership.findMany({
      where: { userId: freeUserAId, roleId: systemRoleId },
    })
    expect(landed).toEqual([])
  })
})
