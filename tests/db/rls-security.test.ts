import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest'
import { Prisma } from '@prisma/client'
import { rawPrisma } from '@/db/raw-client'
import {
  withTenantContext,
  assertValidOrganizationId,
  InvalidOrganizationIdError,
} from '@/server/tenant/context'

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
// The role behind this project's DATABASE_URL is Supabase's `postgres`, and it
// is in class (a): rolsuper = false but rolbypassrls = TRUE, and it also owns
// every table in `public`. Measured, not assumed — the "runtime role privileges"
// describe block below prints the verbatim pg_roles / pg_tables values and
// asserts that the observed leak behaviour matches them.
//
// Consequently, a test that simply called withTenantContext() and looked for
// filtering would pass or fail for reasons that have nothing to do with the
// policies. So every policy-behaviour test here issues its queries under
// `SET LOCAL ROLE authenticated`.
//
// `authenticated` is a stock Supabase role that:
//   - is NOT the owner of these tables (owner is `postgres`),
//   - does NOT have rolsuper or rolbypassrls,
//   - DOES hold SELECT/INSERT/UPDATE/DELETE on every table in `public`
//     (Supabase's default privileges grant them).
// It is therefore fully subject to the policies, which makes it the correct
// instrument for testing them. `SET LOCAL ROLE` is transaction-scoped and
// reverts at COMMIT and ROLLBACK, so it cannot leak into the connection pool.
//
// No Postgres role is created and no credential is changed by these tests;
// `postgres` is already a member of `authenticated`, so SET ROLE is permitted.
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
 * Options for the raw `$transaction` helpers below. `maxWait` is how long
 * Prisma will queue for a free connection and `timeout` how long the
 * transaction may run — both generous for the same latency reason.
 * (`withTenantContext` keeps Prisma's defaults; its signature is fixed by the
 * task brief, so the tests that use it are written to be short instead.)
 */
const TX_OPTIONS = { maxWait: 30_000, timeout: 60_000 } as const

/** Downgrade to a role the policies actually bind. See the header note. */
const ENFORCE_RLS = 'SET LOCAL ROLE authenticated'

/** The real `withTenantContext`, run under a role RLS applies to. */
function asTenant<T>(
  organizationId: string,
  fn: (tx: Prisma.TransactionClient) => Promise<T>
): Promise<T> {
  return withTenantContext(organizationId, async (tx) => {
    await tx.$executeRawUnsafe(ENFORCE_RLS)
    return fn(tx)
  })
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
            '           the rest of this suite under SET LOCAL ROLE authenticated), but they\n' +
            '           filter NOTHING for this connection. Closing it requires pointing\n' +
            '           DATABASE_URL at a role without BYPASSRLS — an infrastructure and\n' +
            '           credentials change, out of scope for Task 9.'
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
    const leakedAsRuntimeRole = await withTenantContext(A.orgId, async (tx) => {
      const rows = await tx.$queryRawUnsafe<{ count: number }[]>(
        `SELECT count(*)::int AS count FROM "Customer" WHERE "organizationId" = '${B.orgId}'`
      )
      return rows[0].count > 0
    })

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
    expect(observed.current_user).toBe('authenticated')
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
        })
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
      })
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
      })
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
      })

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
    })

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
      expect(state!.policies, `${table} policy count`).toBe(1)
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
      expect(actual.get(table)?.policies, `${table} policy count`).toBe(1)
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
    const unrestricted = await withTenantContext(A.orgId, (tx) => tx.customer.count())
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
