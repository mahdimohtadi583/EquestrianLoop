import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest'
import fs from 'node:fs'
import path from 'node:path'
import dotenv from 'dotenv'
import { Client } from 'pg'
import { Prisma } from '@prisma/client'
import { rawPrisma } from '@/db/raw-client'

// =============================================================================
// Task 9 security hardening, Part C — regression tests for
// 20260912103749_enforce_foreign_key_tenant_matching.
//
// WHAT IS BEING DEFENDED
// ----------------------
// Every RLS policy written before Part C checked exactly one thing: the row's
// OWN `organizationId`. A `pg_constraint` audit of all 49 foreign keys in schema
// `public` found 18 of them — spanning 11 tables — where the owning table is
// tenant-scoped, the REFERENCED table is tenant-scoped too, and nothing
// validated that the two agree. A valid tenant context could therefore create a
// row inside its own organization holding a durable, database-enforced reference
// into another organization's data. All 18 were reproduced live before the fix
// (see the Task 9 report, Part C); this file is what keeps them closed.
//
// WHY THIS FILE, AND NOT tests/db/rls-security.test.ts
// ---------------------------------------------------
// Two reasons. First, that file is already ~2750 lines covering security items
// 1-18 plus three earlier fix rounds; this is a distinct, self-contained concern
// with its own fixtures. Second and more importantly, it exercises the policies
// through `SET LOCAL ROLE app_runtime` on the owner connection — a faithful
// instrument, but still a proxy. This file follows
// tests/db/runtime-role-rls.test.ts instead: it opens a connection with the
// REAL runtime `DATABASE_URL`, authenticates as `app_runtime` itself, and never
// issues `SET ROLE` of any kind. What it proves is what the application does.
//
// WHICH CONNECTION DOES WHAT — stated explicitly, because it decides whether the
// assertions mean anything:
//
//   * `rawPrisma`  — the OWNER connection (`postgres`, BYPASSRLS, table owner;
//     `.env.test` repoints DATABASE_URL there for the whole suite). Used ONLY
//     for (a) creating fixtures, including the victim tenant's rows, so no part
//     of the setup depends on the thing under test, and (b) the post-hoc "did
//     that write actually land?" checks, so an RLS-FILTERED READ can never be
//     mistaken for a BLOCKED WRITE.
//
//   * `app` — a plain `pg.Client` on the runtime DATABASE_URL from `.env`, i.e.
//     the real `app_runtime` role. Every attack and every control write below is
//     issued here, inside a transaction whose only preamble is
//     `SET LOCAL app.current_tenant_id` — exactly what `withTenantContext` does.
// =============================================================================

// Remote Supabase; real round trips per case.
vi.setConfig({ testTimeout: 120_000, hookTimeout: 300_000 })

const ROOT = path.resolve(__dirname, '..', '..')

/**
 * The connection string the application itself uses at runtime, read from `.env`
 * rather than `process.env` — under NODE_ENV=test `.env.test` has repointed
 * `process.env.DATABASE_URL` at the BYPASSRLS owner role, which would make
 * every assertion here vacuous. Fails loudly rather than skipping, for the same
 * reason tests/db/runtime-role-rls.test.ts does.
 */
function runtimeConnectionString(): string {
  const envPath = path.join(ROOT, '.env')
  if (!fs.existsSync(envPath)) {
    throw new Error(
      `tests/db/fk-tenant-matching.test.ts needs the real runtime DATABASE_URL, which lives in ` +
        `${envPath} (gitignored). It must not fall back to process.env.DATABASE_URL — under ` +
        `NODE_ENV=test that is .env.test's owner-role override, which bypasses RLS. Create .env ` +
        `from .env.example.`
    )
  }
  const parsed = dotenv.parse(fs.readFileSync(envPath))
  if (!parsed.DATABASE_URL) throw new Error('.env exists but defines no DATABASE_URL')
  return parsed.DATABASE_URL
}

const CUID_ALPHABET = 'abcdefghijklmnopqrstuvwxyz0123456789'
/** A syntactically valid cuid that belongs to no row anywhere. */
function fakeCuid(): string {
  let out = 'c'
  for (let i = 0; i < 24; i += 1) out += CUID_ALPHABET[Math.floor(Math.random() * 36)]
  return out
}

const stamp = `${Date.now()}-${Math.floor(Math.random() * 1e6)}`

/** One complete tenant's worth of rows, every id needed by the cases below. */
type Fixture = {
  orgId: string
  customerUserId: string
  customer2UserId: string
  staffUserId: string
  spareUserId: string
  customerId: string
  customer2Id: string
  branchId: string
  serviceId: string
  horseId: string
  staffId: string
  trainerId: string
  roleId: string
  planId: string
  ridingSessionId: string
  bookingId: string
  loyaltyAccountId: string
  loyaltyTxIds: string[]
  rewardId: string
}

let app: Client
let A: Fixture
let B: Fixture
let identity: { current_user: string; rolsuper: boolean; rolbypassrls: boolean }

async function createFixture(label: string): Promise<Fixture> {
  const org = await rawPrisma.organization.create({
    data: { name: `fkmatch ${label} ${stamp}`, slug: `fkmatch-${label}-${stamp}` },
  })
  const mkUser = (tag: string, type: 'CUSTOMER' | 'STAFF') =>
    rawPrisma.user.create({
      data: {
        email: `fkmatch-${label}-${tag}-${stamp}@test.com`,
        passwordHash: 'x',
        type,
        name: `fkmatch ${label} ${tag}`,
      },
    })
  const [customerUser, customer2User, staffUser, spareUser] = await Promise.all([
    mkUser('c1', 'CUSTOMER'),
    mkUser('c2', 'CUSTOMER'),
    mkUser('staff', 'STAFF'),
    mkUser('spare', 'STAFF'),
  ])

  const branch = await rawPrisma.branch.create({
    data: { organizationId: org.id, name: `fkmatch ${label} branch`, timezone: 'UTC' },
  })
  const customer = await rawPrisma.customer.create({
    data: { organizationId: org.id, userId: customerUser.id, firstName: `FK-${label}-1`, lastName: 'C' },
  })
  const customer2 = await rawPrisma.customer.create({
    data: { organizationId: org.id, userId: customer2User.id, firstName: `FK-${label}-2`, lastName: 'C' },
  })
  const service = await rawPrisma.service.create({
    data: {
      organizationId: org.id,
      name: `fkmatch ${label} service`,
      durationMinutes: 60,
      price: new Prisma.Decimal('10.00'),
      schedulingType: 'FIXED_SESSION',
    },
  })
  const horse = await rawPrisma.horse.create({
    data: { organizationId: org.id, branchId: branch.id, name: `fkmatch ${label} horse` },
  })
  const staff = await rawPrisma.staff.create({
    data: { organizationId: org.id, branchId: branch.id, userId: staffUser.id },
  })
  const trainer = await rawPrisma.trainer.create({
    data: { staffId: staff.id, specialties: ['fkmatch'], certifications: [] },
  })
  const role = await rawPrisma.role.create({
    data: { organizationId: org.id, name: `fkmatch ${label} role`, isSystemRole: false },
  })
  const plan = await rawPrisma.membershipPlan.create({
    data: {
      organizationId: org.id,
      name: `fkmatch ${label} plan`,
      price: new Prisma.Decimal('99.00'),
      durationValue: 1,
      durationUnit: 'MONTHLY',
    },
  })
  const ridingSession = await rawPrisma.ridingSession.create({
    data: {
      organizationId: org.id,
      branchId: branch.id,
      serviceId: service.id,
      startsAt: new Date(),
      endsAt: new Date(Date.now() + 3_600_000),
      capacity: 5,
    },
  })
  const booking = await rawPrisma.booking.create({
    data: {
      organizationId: org.id,
      customerId: customer.id,
      ridingSessionId: ridingSession.id,
      createdVia: 'STAFF',
    },
  })
  const loyaltyAccount = await rawPrisma.loyaltyAccount.create({
    data: { organizationId: org.id, customerId: customer.id },
  })
  // Three, because RewardRedemption.loyaltyTransactionId is UNIQUE and several
  // cases need a fresh, unconsumed one.
  const loyaltyTxIds: string[] = []
  for (let i = 0; i < 3; i += 1) {
    const tx = await rawPrisma.loyaltyTransaction.create({
      data: {
        organizationId: org.id,
        loyaltyAccountId: loyaltyAccount.id,
        type: 'EARN',
        points: 1,
        sourceType: 'fkmatch',
        sourceId: `${label}-${i}-${stamp}`,
      },
    })
    loyaltyTxIds.push(tx.id)
  }
  const reward = await rawPrisma.reward.create({
    data: { organizationId: org.id, name: `fkmatch ${label} reward`, pointsCost: 10 },
  })

  return {
    orgId: org.id,
    customerUserId: customerUser.id,
    customer2UserId: customer2User.id,
    staffUserId: staffUser.id,
    spareUserId: spareUser.id,
    customerId: customer.id,
    customer2Id: customer2.id,
    branchId: branch.id,
    serviceId: service.id,
    horseId: horse.id,
    staffId: staff.id,
    trainerId: trainer.id,
    roleId: role.id,
    planId: plan.id,
    ridingSessionId: ridingSession.id,
    bookingId: booking.id,
    loyaltyAccountId: loyaltyAccount.id,
    loyaltyTxIds,
    rewardId: reward.id,
  }
}

/**
 * Run one statement on the REAL `app_runtime` connection inside a transaction
 * carrying a tenant context — the same mechanism `withTenantContext` uses, minus
 * Prisma, and with no `SET ROLE` anywhere.
 *
 * Returns either the affected row count or the error message, because the two
 * rejection shapes are both legitimate and mean different things: a WITH CHECK
 * failure raises `new row violates row-level security policy`, while a USING
 * failure silently filters the row out and yields `rowCount = 0`.
 */
async function asTenant(
  organizationId: string,
  sql: string,
  params: unknown[] = []
): Promise<{ rowCount: number | null; error?: string }> {
  await app.query('BEGIN')
  try {
    await app.query(`SET LOCAL app.current_tenant_id = '${organizationId.replace(/'/g, "''")}'`)
    const r = await app.query(sql, params)
    await app.query('COMMIT')
    return { rowCount: r.rowCount }
  } catch (error) {
    await app.query('ROLLBACK')
    return { rowCount: null, error: (error as Error).message }
  }
}

/** Did a row with this id actually land? Asked on the OWNER connection. */
async function landed(table: string, rowId: string): Promise<number> {
  const rows = await rawPrisma.$queryRawUnsafe<{ n: number }[]>(
    `SELECT count(*)::int AS n FROM "${table}" WHERE "id" = $1`,
    rowId
  )
  return rows[0].n
}

async function deleteAsOwner(table: string, rowId: string): Promise<void> {
  await rawPrisma.$executeRawUnsafe(`DELETE FROM "${table}" WHERE "id" = $1`, rowId)
}

beforeAll(async () => {
  A = await createFixture('a')
  B = await createFixture('b')

  app = new Client({ connectionString: runtimeConnectionString(), connectionTimeoutMillis: 20_000 })
  await app.connect()
  const rows = await app.query<typeof identity>(
    `SELECT current_user, r.rolsuper, r.rolbypassrls FROM pg_roles r WHERE r.rolname = current_user`
  )
  identity = rows.rows[0]
}, 300_000)

afterAll(async () => {
  try {
    await app?.end()
  } catch {
    /* already gone */
  }
  try {
    const orgIds = [A.orgId, B.orgId]
    const userIds = [A, B].flatMap((f) => [f.customerUserId, f.customer2UserId, f.staffUserId, f.spareUserId])
    // Dependency order matters: several of these FKs are ON DELETE RESTRICT.
    for (const model of [
      'checkIn',
      'booking',
      'rewardRedemption',
      'loyaltyTransaction',
      'loyaltyAccount',
      'reward',
      'customerMembership',
      'ridingSession',
      'payment',
      'notification',
      'membership',
      'membershipPlan',
      'horse',
      'service',
      'customer',
      'blockedTime',
    ] as const) {
      await (rawPrisma[model] as { deleteMany: (a: unknown) => Promise<unknown> }).deleteMany({
        where: { organizationId: { in: orgIds } },
      })
    }
    await rawPrisma.trainer.deleteMany({ where: { staff: { organizationId: { in: orgIds } } } })
    await rawPrisma.staff.deleteMany({ where: { organizationId: { in: orgIds } } })
    await rawPrisma.branch.deleteMany({ where: { organizationId: { in: orgIds } } })
    await rawPrisma.role.deleteMany({ where: { organizationId: { in: orgIds } } })
    await rawPrisma.organization.deleteMany({ where: { id: { in: orgIds } } })
    await rawPrisma.user.deleteMany({ where: { id: { in: userIds } } })
  } catch (error) {
    console.warn('[fk-tenant-matching] teardown skipped:', (error as Error).message)
  }
  await rawPrisma.$disconnect()
}, 300_000)

// -----------------------------------------------------------------------------
// The precondition. Every assertion below is vacuous if this fails, so it is
// measured and printed rather than assumed.
// -----------------------------------------------------------------------------
describe('the attacking connection really is the non-bypassing runtime role', () => {
  it('is app_runtime, not superuser, and does not hold BYPASSRLS', () => {
    console.log('[fk-tenant-matching] attacking connection identity:', identity)
    expect(identity.rolsuper).toBe(false)
    expect(identity.rolbypassrls).toBe(false)
  })

  it('is a different role from the one that creates the fixtures', async () => {
    const suite = await rawPrisma.$queryRawUnsafe<{ current_user: string; rolbypassrls: boolean }[]>(
      `SELECT current_user, r.rolbypassrls FROM pg_roles r WHERE r.rolname = current_user`
    )
    console.log('[fk-tenant-matching] fixture (owner) role:', suite[0])
    expect(suite[0].current_user).not.toBe(identity.current_user)
    expect(suite[0].rolbypassrls).toBe(true)
  })
})

// -----------------------------------------------------------------------------
// The audit itself, as an assertion. This is what stops a LATER task from
// adding a tenant-to-tenant foreign key and quietly reintroducing the whole
// class of bug: the enumeration is derived from pg_constraint at run time, not
// from a list anyone maintains by hand.
// -----------------------------------------------------------------------------
describe('the foreign-key audit is re-derived from pg_constraint every run', () => {
  /**
   * Tenant-to-tenant foreign keys whose enforcement lives in the referencing
   * table's OWN policy predicate, keyed `Table.column`.
   *
   * Split into two groups only to document where the enforcement sits:
   *   - FIXED_IN_PART_C   — this migration's 18, checked in WITH CHECK.
   *   - PROTECTED_EARLIER — the 4 columnless join tables' EXISTS policies plus
   *     Membership.roleId, all from earlier rounds and deliberately untouched.
   */
  const FIXED_IN_PART_C = new Set([
    'Staff.branchId',
    'Horse.branchId',
    'RidingSession.branchId',
    'RidingSession.serviceId',
    'RidingSession.trainerId',
    'RidingSession.horseId',
    'Booking.customerId',
    'Booking.ridingSessionId',
    'CheckIn.bookingId',
    'CustomerMembership.customerId',
    'CustomerMembership.membershipPlanId',
    'LoyaltyAccount.customerId',
    'LoyaltyTransaction.loyaltyAccountId',
    'RewardRedemption.customerId',
    'RewardRedemption.rewardId',
    'RewardRedemption.loyaltyTransactionId',
    'Payment.customerId',
    'Membership.branchId',
  ])

  const PROTECTED_EARLIER = new Set([
    'Trainer.staffId',
    'RolePermission.roleId',
    'MembershipPlanService.membershipPlanId',
    'MembershipPlanService.serviceId',
    'MembershipPlanBranch.membershipPlanId',
    'MembershipPlanBranch.branchId',
    'Membership.roleId',
  ])

  type FkRow = {
    src_table: string
    src_col: string
    tgt_table: string
    src_has_org: boolean
    tgt_has_org: boolean
    src_notnull: boolean
  }

  async function foreignKeys(): Promise<FkRow[]> {
    return rawPrisma.$queryRawUnsafe<FkRow[]>(`
      SELECT src.relname AS src_table,
             sa.attname  AS src_col,
             tgt.relname AS tgt_table,
             sa.attnotnull AS src_notnull,
             EXISTS (SELECT 1 FROM pg_attribute a
                      WHERE a.attrelid = con.conrelid AND a.attname = 'organizationId'
                        AND NOT a.attisdropped) AS src_has_org,
             EXISTS (SELECT 1 FROM pg_attribute a
                      WHERE a.attrelid = con.confrelid AND a.attname = 'organizationId'
                        AND NOT a.attisdropped) AS tgt_has_org
        FROM pg_constraint con
        JOIN pg_class src ON src.oid = con.conrelid
        JOIN pg_class tgt ON tgt.oid = con.confrelid
        JOIN pg_namespace n ON n.oid = src.relnamespace
        JOIN pg_attribute sa ON sa.attrelid = con.conrelid AND sa.attnum = con.conkey[1]
       WHERE con.contype = 'f' AND n.nspname = 'public'
       ORDER BY src.relname, sa.attname
    `)
  }

  /**
   * Tables with no organizationId of their own, whose whole tenancy is defined
   * by an EXISTS policy against a parent. Their own FKs are therefore the
   * mechanism, not a gap — and they are already handled.
   */
  const COLUMNLESS_JOIN_TABLES = new Set([
    'Trainer',
    'RolePermission',
    'MembershipPlanService',
    'MembershipPlanBranch',
  ])

  it('every FK is single-column, so no composite organizationId key exists to rely on', async () => {
    // Stated because "protected by a database constraint" is a real category in
    // the audit taxonomy and this is the measurement that empties it: a
    // composite FK carrying organizationId on both sides WOULD make a
    // cross-tenant reference structurally impossible. None exists here.
    const rows = await rawPrisma.$queryRawUnsafe<{ total: number; single: number }[]>(
      `SELECT count(*)::int AS total,
              count(*) FILTER (WHERE array_length(con.conkey,1) = 1
                                 AND array_length(con.confkey,1) = 1)::int AS single
         FROM pg_constraint con
         JOIN pg_class k ON k.oid = con.conrelid
         JOIN pg_namespace n ON n.oid = k.relnamespace
        WHERE con.contype = 'f' AND n.nspname = 'public'`
    )
    console.log('[fk-tenant-matching] FK arity:', rows[0])
    expect(rows[0].single).toBe(rows[0].total)
  })

  it('no tenant-to-tenant foreign key is unaccounted for', async () => {
    const all = await foreignKeys()
    // A cross-tenant question exists only when BOTH ends are tenant data. An FK
    // into User / Organization / Permission cannot cross a tenant boundary
    // because its target has no tenant.
    //
    // "Tenant data" is not the same as "has an organizationId column": the four
    // columnless join/extension tables are tenant data whose tenant is resolved
    // through a parent, and they count on BOTH sides. The target side matters —
    // RidingSession.trainerId points at "Trainer", which has no organizationId,
    // and it is one of the 18 keys this migration fixed (by joining Trainer to
    // its parent Staff inside the predicate). A target-side test of
    // `tgt_has_org` alone would silently drop that case from the audit.
    const isTenantData = (table: string, hasOrg: boolean) =>
      hasOrg || COLUMNLESS_JOIN_TABLES.has(table)
    const tenantToTenant = all.filter(
      (r) => isTenantData(r.src_table, r.src_has_org) && isTenantData(r.tgt_table, r.tgt_has_org)
    )
    const keys = tenantToTenant.map((r) => `${r.src_table}.${r.src_col}`).sort()
    const unaccounted = keys.filter((k) => !FIXED_IN_PART_C.has(k) && !PROTECTED_EARLIER.has(k))

    console.log('[fk-tenant-matching] total FKs in public:', all.length)
    console.log('[fk-tenant-matching] tenant-to-tenant FKs:', keys)
    console.log('[fk-tenant-matching] unaccounted for:', unaccounted)

    // The assertion that survives future schema changes: a new FK from one
    // tenant-scoped table to another fails here until it is either given a
    // policy conjunct and added to FIXED_IN_PART_C, or consciously justified.
    expect(unaccounted).toEqual([])
    expect(keys.length).toBe(FIXED_IN_PART_C.size + PROTECTED_EARLIER.size)
    // Recorded facts, so a drift in either direction is loud rather than silent.
    expect(all.length).toBe(49)
    expect(keys.length).toBe(25)
  })

  it('the nullability of each fixed column matches what its policy assumes', async () => {
    // The policy predicates hard-code which columns get an `IS NULL OR ...`
    // escape. If a later migration made one of the NOT NULL columns optional (or
    // vice versa) the predicate would either reject legitimate NULLs or carry
    // dead code, so the assumption is pinned to the database rather than trusted.
    const NULLABLE = new Set([
      'Staff.branchId',
      'Membership.branchId',
      'RidingSession.trainerId',
      'RidingSession.horseId',
      'Payment.customerId',
    ])
    const all = await foreignKeys()
    const actualNullable = all
      .filter((r) => FIXED_IN_PART_C.has(`${r.src_table}.${r.src_col}`) && !r.src_notnull)
      .map((r) => `${r.src_table}.${r.src_col}`)
      .sort()
    console.log('[fk-tenant-matching] nullable among the fixed columns:', actualNullable)
    expect(actualNullable).toEqual([...NULLABLE].sort())
  })

  it('each fixed table carries exactly one policy, with a strict USING and an explicit WITH CHECK', async () => {
    const TABLES = [
      'Booking',
      'CheckIn',
      'CustomerMembership',
      'Horse',
      'LoyaltyAccount',
      'LoyaltyTransaction',
      'Membership',
      'Payment',
      'RewardRedemption',
      'RidingSession',
      'Staff',
    ]
    const rows = await rawPrisma.$queryRawUnsafe<
      { tablename: string; policies: number; qual: string; with_check: string | null }[]
    >(
      `SELECT p.tablename,
              (SELECT count(*)::int FROM pg_policies q
                WHERE q.schemaname='public' AND q.tablename = p.tablename) AS policies,
              p.qual, p.with_check
         FROM pg_policies p
        WHERE p.schemaname='public' AND p.policyname='tenant_isolation'
          AND p.tablename IN (${TABLES.map((t) => `'${t}'`).join(',')})
        ORDER BY p.tablename`
    )
    expect(rows.map((r) => r.tablename)).toEqual(TABLES)
    for (const r of rows) {
      // Exactly one policy: no RESTRICTIVE companion was needed, because unlike
      // Role/RolePermission these tables' USING is already strict (their
      // organizationId is NOT NULL, so no platform-scoped row can exist).
      expect(r.policies, `${r.tablename} policy count`).toBe(1)
      // READ side untouched: the row's own tenant column and nothing else. A
      // pre-existing malformed row therefore stays VISIBLE to the tenant that
      // owns it, which is what makes cleanup possible.
      expect(r.qual, `${r.tablename}.qual`).toMatch(/current_setting\('app\.current_tenant_id'/)
      expect(r.qual, `${r.tablename}.qual`).not.toMatch(/EXISTS/)
      // WRITE side: explicit (ending Postgres's implicit reuse of USING), and it
      // still restates the tenant-match conjunct — omitting that would have
      // reopened plain cross-tenant INSERT, a worse hole than the one closed.
      expect(r.with_check, `${r.tablename}.with_check`).not.toBeNull()
      expect(r.with_check!, `${r.tablename}.with_check`).toMatch(
        /current_setting\('app\.current_tenant_id'/
      )
      expect(r.with_check!, `${r.tablename}.with_check`).toMatch(/EXISTS/)
    }
  })
})

// -----------------------------------------------------------------------------
// The 18 exploits, each reproduced live before the fix and blocked after.
// -----------------------------------------------------------------------------
describe('a tenant cannot create a row referencing another tenant (18 foreign keys)', () => {
  /**
   * Each case: tenant A attempts an INSERT into its OWN organization whose named
   * foreign key points at a row of tenant B. Everything else about the row is
   * legitimate, which is exactly what made this silent — the row's own
   * organizationId satisfies the old predicate.
   */
  function crossTenantCases(): {
    fk: string
    table: string
    sql: string
    params: (rogueId: string) => unknown[]
  }[] {
    return [
      {
        fk: 'Staff.branchId',
        table: 'Staff',
        sql: `INSERT INTO "Staff" ("id","organizationId","branchId","userId") VALUES ($1,$2,$3,$4)`,
        params: (x) => [x, A.orgId, B.branchId, A.spareUserId],
      },
      {
        fk: 'Horse.branchId',
        table: 'Horse',
        sql: `INSERT INTO "Horse" ("id","organizationId","branchId","name") VALUES ($1,$2,$3,'rogue')`,
        params: (x) => [x, A.orgId, B.branchId],
      },
      {
        fk: 'RidingSession.branchId',
        table: 'RidingSession',
        sql: `INSERT INTO "RidingSession" ("id","organizationId","branchId","serviceId","startsAt","endsAt","capacity")
              VALUES ($1,$2,$3,$4,now(),now()+interval '1 hour',1)`,
        params: (x) => [x, A.orgId, B.branchId, A.serviceId],
      },
      {
        fk: 'RidingSession.serviceId',
        table: 'RidingSession',
        sql: `INSERT INTO "RidingSession" ("id","organizationId","branchId","serviceId","startsAt","endsAt","capacity")
              VALUES ($1,$2,$3,$4,now(),now()+interval '1 hour',1)`,
        params: (x) => [x, A.orgId, A.branchId, B.serviceId],
      },
      {
        // The one whose target carries NO organizationId of its own: Trainer's
        // tenant is its parent Staff's, so the predicate joins through Staff.
        fk: 'RidingSession.trainerId',
        table: 'RidingSession',
        sql: `INSERT INTO "RidingSession" ("id","organizationId","branchId","serviceId","trainerId","startsAt","endsAt","capacity")
              VALUES ($1,$2,$3,$4,$5,now(),now()+interval '1 hour',1)`,
        params: (x) => [x, A.orgId, A.branchId, A.serviceId, B.trainerId],
      },
      {
        fk: 'RidingSession.horseId',
        table: 'RidingSession',
        sql: `INSERT INTO "RidingSession" ("id","organizationId","branchId","serviceId","horseId","startsAt","endsAt","capacity")
              VALUES ($1,$2,$3,$4,$5,now(),now()+interval '1 hour',1)`,
        params: (x) => [x, A.orgId, A.branchId, A.serviceId, B.horseId],
      },
      {
        fk: 'Booking.customerId',
        table: 'Booking',
        sql: `INSERT INTO "Booking" ("id","organizationId","customerId","ridingSessionId","createdVia")
              VALUES ($1,$2,$3,$4,'STAFF')`,
        params: (x) => [x, A.orgId, B.customerId, A.ridingSessionId],
      },
      {
        fk: 'Booking.ridingSessionId',
        table: 'Booking',
        sql: `INSERT INTO "Booking" ("id","organizationId","customerId","ridingSessionId","createdVia")
              VALUES ($1,$2,$3,$4,'STAFF')`,
        params: (x) => [x, A.orgId, A.customerId, B.ridingSessionId],
      },
      {
        // Two-hop: only the DIRECT key is validated here. Booking's own FKs are
        // Booking's policy's job, above.
        fk: 'CheckIn.bookingId',
        table: 'CheckIn',
        sql: `INSERT INTO "CheckIn" ("id","organizationId","bookingId","method","checkedInByStaffId")
              VALUES ($1,$2,$3,'MANUAL',$4)`,
        params: (x) => [x, A.orgId, B.bookingId, A.staffId],
      },
      {
        fk: 'CustomerMembership.customerId',
        table: 'CustomerMembership',
        sql: `INSERT INTO "CustomerMembership" ("id","organizationId","customerId","membershipPlanId","endDate","updatedAt")
              VALUES ($1,$2,$3,$4,now()+interval '30 days',now())`,
        params: (x) => [x, A.orgId, B.customerId, A.planId],
      },
      {
        fk: 'CustomerMembership.membershipPlanId',
        table: 'CustomerMembership',
        sql: `INSERT INTO "CustomerMembership" ("id","organizationId","customerId","membershipPlanId","endDate","updatedAt")
              VALUES ($1,$2,$3,$4,now()+interval '30 days',now())`,
        params: (x) => [x, A.orgId, A.customerId, B.planId],
      },
      {
        // customerId is UNIQUE here, so this also claimed the victim's only
        // loyalty-account slot — a functional lockout on top of the reference.
        fk: 'LoyaltyAccount.customerId',
        table: 'LoyaltyAccount',
        sql: `INSERT INTO "LoyaltyAccount" ("id","organizationId","customerId","updatedAt") VALUES ($1,$2,$3,now())`,
        params: (x) => [x, A.orgId, B.customer2Id],
      },
      {
        fk: 'LoyaltyTransaction.loyaltyAccountId',
        table: 'LoyaltyTransaction',
        sql: `INSERT INTO "LoyaltyTransaction" ("id","organizationId","loyaltyAccountId","type","points","sourceType","sourceId")
              VALUES ($1,$2,$3,'EARN',1,'fkmatch',$4)`,
        params: (x) => [x, A.orgId, B.loyaltyAccountId, fakeCuid()],
      },
      {
        fk: 'RewardRedemption.customerId',
        table: 'RewardRedemption',
        sql: `INSERT INTO "RewardRedemption" ("id","organizationId","customerId","rewardId","loyaltyTransactionId")
              VALUES ($1,$2,$3,$4,$5)`,
        params: (x) => [x, A.orgId, B.customerId, A.rewardId, A.loyaltyTxIds[0]],
      },
      {
        fk: 'RewardRedemption.rewardId',
        table: 'RewardRedemption',
        sql: `INSERT INTO "RewardRedemption" ("id","organizationId","customerId","rewardId","loyaltyTransactionId")
              VALUES ($1,$2,$3,$4,$5)`,
        params: (x) => [x, A.orgId, A.customerId, B.rewardId, A.loyaltyTxIds[1]],
      },
      {
        fk: 'RewardRedemption.loyaltyTransactionId',
        table: 'RewardRedemption',
        sql: `INSERT INTO "RewardRedemption" ("id","organizationId","customerId","rewardId","loyaltyTransactionId")
              VALUES ($1,$2,$3,$4,$5)`,
        params: (x) => [x, A.orgId, A.customerId, A.rewardId, B.loyaltyTxIds[0]],
      },
      {
        fk: 'Payment.customerId',
        table: 'Payment',
        sql: `INSERT INTO "Payment" ("id","organizationId","customerId","amount") VALUES ($1,$2,$3,5.00)`,
        params: (x) => [x, A.orgId, B.customerId],
      },
      {
        fk: 'Membership.branchId',
        table: 'Membership',
        sql: `INSERT INTO "Membership" ("id","userId","organizationId","branchId","roleId") VALUES ($1,$2,$3,$4,$5)`,
        params: (x) => [x, A.spareUserId, A.orgId, B.branchId, A.roleId],
      },
    ]
  }

  it('the case table covers exactly the 18 foreign keys the migration fixed', () => {
    // Guards against a case being dropped in a refactor and the suite still
    // going green with 17 of the 18 proven.
    const fks = crossTenantCases().map((c) => c.fk)
    expect(new Set(fks).size).toBe(18)
  })

  it.each(crossTenantCases())('blocks $fk pointing at another tenant', async ({ table, sql, params }) => {
    const rogueId = fakeCuid()
    const out = await asTenant(A.orgId, sql, params(rogueId))
    console.log(`[fk-tenant-matching] cross-tenant INSERT ${table}:`, out.error?.split('\n')[0] ?? out.rowCount)
    // WITH CHECK rejects the new row, so Postgres raises rather than filtering.
    expect(out.error, `${table} was not rejected`).toBeDefined()
    expect(out.error!).toMatch(/row-level security/i)
    // And nothing landed — asked on the owner connection, so an RLS-filtered
    // read cannot be mistaken for a blocked write.
    expect(await landed(table, rogueId)).toBe(0)
  })
})

// -----------------------------------------------------------------------------
// UPDATE is the verb the INSERT cases miss: the old row is legitimately the
// caller's own, so USING admits it, and only WITH CHECK can refuse the row it
// would produce. Three representative shapes — NOT NULL, NOT NULL via a second
// FK, and a CASCADE key.
// -----------------------------------------------------------------------------
describe('a tenant cannot re-point one of its own rows at another tenant', () => {
  it("UPDATE Horse.branchId onto another tenant's Branch is refused", async () => {
    const out = await asTenant(A.orgId, `UPDATE "Horse" SET "branchId" = $1 WHERE "id" = $2`, [
      B.branchId,
      A.horseId,
    ])
    expect(out.error).toBeDefined()
    expect(out.error!).toMatch(/row-level security/i)
    const after = await rawPrisma.horse.findUniqueOrThrow({ where: { id: A.horseId } })
    expect(after.branchId).toBe(A.branchId)
  })

  it("UPDATE RidingSession.serviceId onto another tenant's Service is refused", async () => {
    const out = await asTenant(A.orgId, `UPDATE "RidingSession" SET "serviceId" = $1 WHERE "id" = $2`, [
      B.serviceId,
      A.ridingSessionId,
    ])
    expect(out.error).toBeDefined()
    expect(out.error!).toMatch(/row-level security/i)
    const after = await rawPrisma.ridingSession.findUniqueOrThrow({ where: { id: A.ridingSessionId } })
    expect(after.serviceId).toBe(A.serviceId)
  })

  it("UPDATE Booking.customerId onto another tenant's Customer is refused", async () => {
    const out = await asTenant(A.orgId, `UPDATE "Booking" SET "customerId" = $1 WHERE "id" = $2`, [
      B.customerId,
      A.bookingId,
    ])
    expect(out.error).toBeDefined()
    expect(out.error!).toMatch(/row-level security/i)
    const after = await rawPrisma.booking.findUniqueOrThrow({ where: { id: A.bookingId } })
    expect(after.customerId).toBe(A.customerId)
  })
})

// -----------------------------------------------------------------------------
// The controls. Without these, every rejection above could be a blanket deny
// that had broken the application outright — which is the realistic failure mode
// of a predicate this large.
// -----------------------------------------------------------------------------
describe('legitimate same-tenant references still succeed', () => {
  const created: [string, string][] = []

  afterAll(async () => {
    for (const [table, rowId] of created.reverse()) {
      try {
        await deleteAsOwner(table, rowId)
      } catch {
        /* the broader teardown will get it */
      }
    }
  })

  async function expectAccepted(table: string, sql: string, params: (x: string) => unknown[]) {
    const okId = fakeCuid()
    const out = await asTenant(A.orgId, sql, params(okId))
    expect(out.error, `${table} same-tenant write was rejected: ${out.error}`).toBeUndefined()
    expect(out.rowCount).toBe(1)
    expect(await landed(table, okId)).toBe(1)
    created.push([table, okId])
    return okId
  }

  it('Staff with its own Branch', async () => {
    await expectAccepted(
      'Staff',
      `INSERT INTO "Staff" ("id","organizationId","branchId","userId") VALUES ($1,$2,$3,$4)`,
      (x) => [x, A.orgId, A.branchId, A.spareUserId]
    )
  })

  it('Horse with its own Branch', async () => {
    await expectAccepted(
      'Horse',
      `INSERT INTO "Horse" ("id","organizationId","branchId","name") VALUES ($1,$2,$3,'ok')`,
      (x) => [x, A.orgId, A.branchId]
    )
  })

  it('RidingSession with its own Branch, Service, Trainer and Horse (all four at once)', async () => {
    await expectAccepted(
      'RidingSession',
      `INSERT INTO "RidingSession" ("id","organizationId","branchId","serviceId","trainerId","horseId","startsAt","endsAt","capacity")
       VALUES ($1,$2,$3,$4,$5,$6,now(),now()+interval '1 hour',1)`,
      (x) => [x, A.orgId, A.branchId, A.serviceId, A.trainerId, A.horseId]
    )
  })

  it('Booking with its own Customer and RidingSession', async () => {
    await expectAccepted(
      'Booking',
      `INSERT INTO "Booking" ("id","organizationId","customerId","ridingSessionId","createdVia")
       VALUES ($1,$2,$3,$4,'STAFF')`,
      (x) => [x, A.orgId, A.customer2Id, A.ridingSessionId]
    )
  })

  it('CheckIn on its own Booking', async () => {
    await expectAccepted(
      'CheckIn',
      `INSERT INTO "CheckIn" ("id","organizationId","bookingId","method","checkedInByStaffId")
       VALUES ($1,$2,$3,'MANUAL',$4)`,
      (x) => [x, A.orgId, A.bookingId, A.staffId]
    )
  })

  it('CustomerMembership with its own Customer and MembershipPlan', async () => {
    await expectAccepted(
      'CustomerMembership',
      `INSERT INTO "CustomerMembership" ("id","organizationId","customerId","membershipPlanId","endDate","updatedAt")
       VALUES ($1,$2,$3,$4,now()+interval '30 days',now())`,
      (x) => [x, A.orgId, A.customer2Id, A.planId]
    )
  })

  it('LoyaltyAccount for its own Customer', async () => {
    await expectAccepted(
      'LoyaltyAccount',
      `INSERT INTO "LoyaltyAccount" ("id","organizationId","customerId","updatedAt") VALUES ($1,$2,$3,now())`,
      (x) => [x, A.orgId, A.customer2Id]
    )
  })

  it('LoyaltyTransaction on its own LoyaltyAccount', async () => {
    await expectAccepted(
      'LoyaltyTransaction',
      `INSERT INTO "LoyaltyTransaction" ("id","organizationId","loyaltyAccountId","type","points","sourceType","sourceId")
       VALUES ($1,$2,$3,'EARN',1,'fkmatch',$4)`,
      (x) => [x, A.orgId, A.loyaltyAccountId, fakeCuid()]
    )
  })

  it('RewardRedemption with its own Customer, Reward and LoyaltyTransaction', async () => {
    await expectAccepted(
      'RewardRedemption',
      `INSERT INTO "RewardRedemption" ("id","organizationId","customerId","rewardId","loyaltyTransactionId")
       VALUES ($1,$2,$3,$4,$5)`,
      (x) => [x, A.orgId, A.customerId, A.rewardId, A.loyaltyTxIds[2]]
    )
  })

  it('Payment for its own Customer', async () => {
    await expectAccepted(
      'Payment',
      `INSERT INTO "Payment" ("id","organizationId","customerId","amount") VALUES ($1,$2,$3,5.00)`,
      (x) => [x, A.orgId, A.customerId]
    )
  })

  it('Membership with its own Branch and its own Role', async () => {
    await expectAccepted(
      'Membership',
      `INSERT INTO "Membership" ("id","userId","organizationId","branchId","roleId") VALUES ($1,$2,$3,$4,$5)`,
      (x) => [x, A.spareUserId, A.orgId, A.branchId, A.roleId]
    )
  })

  it('a tenant still sees its own rows on every fixed table (reads are untouched)', async () => {
    // The USING clause was deliberately not widened, so ordinary tenant reads
    // must be bit-for-bit what they were. Any FK check leaking into USING would
    // show up here as rows going missing.
    await app.query('BEGIN')
    await app.query(`SET LOCAL app.current_tenant_id = '${A.orgId}'`)
    const r = await app.query<{ [k: string]: number }>(
      `SELECT (SELECT count(*)::int FROM "Staff")              AS staff,
              (SELECT count(*)::int FROM "Horse")              AS horse,
              (SELECT count(*)::int FROM "RidingSession")      AS riding_session,
              (SELECT count(*)::int FROM "Booking")            AS booking,
              (SELECT count(*)::int FROM "LoyaltyTransaction") AS loyalty_transaction,
              (SELECT count(*)::int FROM "Payment")            AS payment,
              (SELECT count(*)::int FROM "Membership")         AS membership,
              (SELECT count(*)::int FROM "Horse" WHERE "organizationId" <> $1) AS foreign_horse`,
      [A.orgId]
    )
    await app.query('COMMIT')
    console.log('[fk-tenant-matching] tenant A read-side after the fix:', r.rows[0])
    // Its own rows are there...
    expect(r.rows[0].staff).toBeGreaterThan(0)
    expect(r.rows[0].horse).toBeGreaterThan(0)
    expect(r.rows[0].riding_session).toBeGreaterThan(0)
    expect(r.rows[0].booking).toBeGreaterThan(0)
    expect(r.rows[0].loyalty_transaction).toBeGreaterThan(0)
    // ...and no other tenant's are, on any of them.
    expect(r.rows[0].foreign_horse).toBe(0)
  })
})

// -----------------------------------------------------------------------------
// The nullable columns. Five of the 18 are genuinely optional, and a predicate
// that forgot the `IS NULL OR` escape would silently make an optional
// relationship mandatory — a schema change smuggled in through a policy. That is
// the most likely way this migration could have been subtly wrong, so each one
// is asserted individually.
// -----------------------------------------------------------------------------
describe('NULL is still accepted for every nullable foreign key touched', () => {
  const created: [string, string][] = []

  afterAll(async () => {
    for (const [table, rowId] of created.reverse()) {
      try {
        await deleteAsOwner(table, rowId)
      } catch {
        /* the broader teardown will get it */
      }
    }
  })

  async function expectNullAccepted(table: string, sql: string, params: (x: string) => unknown[]) {
    const okId = fakeCuid()
    const out = await asTenant(A.orgId, sql, params(okId))
    expect(out.error, `${table} rejected a legitimate NULL: ${out.error}`).toBeUndefined()
    expect(out.rowCount).toBe(1)
    expect(await landed(table, okId)).toBe(1)
    created.push([table, okId])
  }

  it('Staff.branchId = NULL (a staff member with no branch assignment)', async () => {
    await expectNullAccepted(
      'Staff',
      `INSERT INTO "Staff" ("id","organizationId","branchId","userId") VALUES ($1,$2,NULL,$3)`,
      (x) => [x, A.orgId, A.spareUserId]
    )
  })

  it('RidingSession.trainerId = NULL and horseId = NULL (Service requires neither)', async () => {
    await expectNullAccepted(
      'RidingSession',
      `INSERT INTO "RidingSession" ("id","organizationId","branchId","serviceId","trainerId","horseId","startsAt","endsAt","capacity")
       VALUES ($1,$2,$3,$4,NULL,NULL,now(),now()+interval '1 hour',1)`,
      (x) => [x, A.orgId, A.branchId, A.serviceId]
    )
  })

  it('Payment.customerId = NULL (a payment not attributable to a customer)', async () => {
    await expectNullAccepted(
      'Payment',
      `INSERT INTO "Payment" ("id","organizationId","customerId","amount") VALUES ($1,$2,NULL,5.00)`,
      (x) => [x, A.orgId]
    )
  })

  it('Membership.branchId = NULL (an organization-wide membership)', async () => {
    await expectNullAccepted(
      'Membership',
      `INSERT INTO "Membership" ("id","userId","organizationId","branchId","roleId") VALUES ($1,$2,$3,NULL,$4)`,
      (x) => [x, A.spareUserId, A.orgId, A.roleId]
    )
  })

  it('an existing non-null value can still be cleared back to NULL', async () => {
    // UPDATE re-evaluates the whole WITH CHECK, so a predicate that only handled
    // NULL on INSERT would fail here.
    const out = await asTenant(A.orgId, `UPDATE "Staff" SET "branchId" = NULL WHERE "id" = $1`, [
      A.staffId,
    ])
    expect(out.error).toBeUndefined()
    expect(out.rowCount).toBe(1)
    const after = await rawPrisma.staff.findUniqueOrThrow({ where: { id: A.staffId } })
    expect(after.branchId).toBeNull()
    // Restore, so the fixture stays usable for any later block.
    await rawPrisma.staff.update({ where: { id: A.staffId }, data: { branchId: A.branchId } })
  })
})

// -----------------------------------------------------------------------------
// Round 3's Membership.roleId fix must survive this migration. ALTER POLICY
// REPLACES the whole WITH CHECK expression rather than appending to it, so
// adding the branchId conjunct meant restating the roleId one verbatim. If that
// restatement were ever dropped, the privilege escalation round 3 closed would
// reopen silently — and every other test in this file would still pass.
// -----------------------------------------------------------------------------
describe("Membership's earlier roleId protection was not lost when branchId was added", () => {
  let platformRoleId: string
  let freeUserId: string

  beforeAll(async () => {
    const role = await rawPrisma.role.create({
      data: { organizationId: null, name: `fkmatch PLATFORM ${stamp}`, isSystemRole: true },
    })
    platformRoleId = role.id
    const user = await rawPrisma.user.create({
      data: {
        email: `fkmatch-escalate-${stamp}@test.com`,
        passwordHash: 'x',
        type: 'STAFF',
        name: 'fkmatch escalation probe',
      },
    })
    freeUserId = user.id
  }, 120_000)

  afterAll(async () => {
    try {
      await rawPrisma.membership.deleteMany({ where: { userId: freeUserId } })
      await rawPrisma.user.deleteMany({ where: { id: freeUserId } })
      await rawPrisma.role.deleteMany({ where: { id: platformRoleId } })
    } catch (error) {
      console.warn('[fk-tenant-matching] escalation teardown skipped:', (error as Error).message)
    }
  }, 120_000)

  it('still refuses a Membership pointing at the NULL-org platform Role', async () => {
    const rogueId = fakeCuid()
    const out = await asTenant(
      A.orgId,
      `INSERT INTO "Membership" ("id","userId","organizationId","roleId") VALUES ($1,$2,$3,$4)`,
      [rogueId, freeUserId, A.orgId, platformRoleId]
    )
    expect(out.error).toBeDefined()
    expect(out.error!).toMatch(/row-level security/i)
    expect(await landed('Membership', rogueId)).toBe(0)
  })

  it("still refuses a Membership pointing at another tenant's Role", async () => {
    const rogueId = fakeCuid()
    const out = await asTenant(
      A.orgId,
      `INSERT INTO "Membership" ("id","userId","organizationId","roleId") VALUES ($1,$2,$3,$4)`,
      [rogueId, freeUserId, A.orgId, B.roleId]
    )
    expect(out.error).toBeDefined()
    expect(out.error!).toMatch(/row-level security/i)
    expect(await landed('Membership', rogueId)).toBe(0)
  })

  it('and still refuses a plain cross-tenant Membership INSERT', async () => {
    // The conjunct that an explicit WITH CHECK can silently drop.
    const rogueId = fakeCuid()
    const out = await asTenant(
      A.orgId,
      `INSERT INTO "Membership" ("id","userId","organizationId","roleId") VALUES ($1,$2,$3,$4)`,
      [rogueId, freeUserId, B.orgId, B.roleId]
    )
    expect(out.error).toBeDefined()
    expect(out.error!).toMatch(/row-level security/i)
    expect(await landed('Membership', rogueId)).toBe(0)
  })
})
