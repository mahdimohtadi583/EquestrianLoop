import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest'
import fs from 'node:fs'
import path from 'node:path'
import dotenv from 'dotenv'
import { Client } from 'pg'
import { Prisma } from '@prisma/client'
import { rawPrisma } from '@/db/raw-client'

// =============================================================================
// Task 9 security hardening, Part D — regression tests for
// 20260913001657_harden_default_privileges_and_scalar_tenant_matching.
//
// TWO INDEPENDENT THINGS ARE DEFENDED HERE
// ----------------------------------------
// 1. FINDING 3 — four plain scalars that reference tenant data with NO foreign
//    key, and were therefore classified out of scope by Part C's FK audit:
//
//        CheckIn.checkedInByStaffId   NOT NULL   -> "Staff"
//        BlockedTime.branchId         NULLABLE   -> "Branch"
//        BlockedTime.trainerId        NULLABLE   -> "Trainer" (two-hop via "Staff")
//        BlockedTime.horseId          NULLABLE   -> "Horse"
//
//    Postgres will not enforce the reference, but an RLS predicate can still
//    validate the VALUE — look the id up and compare tenants. That is what the
//    migration added, and what the cross-tenant cases below prove is closed.
//
// 2. FINDING 4 — `app_runtime` held full CRUD on `_prisma_migrations` (the
//    migration ledger) and on `AuditLog` (including UPDATE and DELETE). Both are
//    narrowed, and the assertions below pin BOTH directions: the privileges that
//    were removed are gone, and every privilege that must survive still works.
//
// WHICH CONNECTION DOES WHAT — stated explicitly, because it decides whether the
// assertions mean anything. Same instrument as tests/db/fk-tenant-matching.test.ts:
//
//   * `rawPrisma` — the OWNER connection (`postgres`, BYPASSRLS, table owner;
//     `.env.test` repoints DATABASE_URL there for the suite). Used ONLY to build
//     fixtures — including the victim tenant's rows, so no part of the setup
//     depends on the thing under test — and for the post-hoc "did that write
//     actually land?" check, so an RLS-FILTERED READ can never be mistaken for a
//     BLOCKED WRITE.
//
//   * `app` — a plain `pg.Client` on the runtime DATABASE_URL from `.env`, i.e.
//     the REAL `app_runtime` role. Every attack, every control write, and every
//     privilege probe is issued here, with no `SET ROLE` proxy of any kind. What
//     it proves is what the application does.
// =============================================================================

// Remote Supabase; real round trips per case.
vi.setConfig({ testTimeout: 120_000, hookTimeout: 300_000 })

const ROOT = path.resolve(__dirname, '..', '..')

/**
 * The connection string the application itself uses at runtime, read from `.env`
 * rather than `process.env` — under NODE_ENV=test `.env.test` has repointed
 * `process.env.DATABASE_URL` at the BYPASSRLS owner role, which would make every
 * assertion here vacuous. Fails loudly rather than skipping.
 */
function runtimeConnectionString(): string {
  const envPath = path.join(ROOT, '.env')
  if (!fs.existsSync(envPath)) {
    throw new Error(
      `tests/db/scalar-tenant-matching.test.ts needs the real runtime DATABASE_URL, which lives ` +
        `in ${envPath} (gitignored). It must not fall back to process.env.DATABASE_URL — under ` +
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

type Fixture = {
  orgId: string
  customerUserId: string
  staffUserId: string
  customerId: string
  branchId: string
  serviceId: string
  horseId: string
  staffId: string
  trainerId: string
  ridingSessionId: string
  bookingId: string
  spareBookingId: string
}

let app: Client
let A: Fixture
let B: Fixture
let identity: { current_user: string; rolsuper: boolean; rolbypassrls: boolean }

async function createFixture(label: string): Promise<Fixture> {
  const org = await rawPrisma.organization.create({
    data: { name: `scalarmatch ${label} ${stamp}`, slug: `scalarmatch-${label}-${stamp}` },
  })
  const mkUser = (tag: string, type: 'CUSTOMER' | 'STAFF') =>
    rawPrisma.user.create({
      data: {
        email: `scalarmatch-${label}-${tag}-${stamp}@test.com`,
        passwordHash: 'x',
        type,
        name: `scalarmatch ${label} ${tag}`,
      },
    })
  const [customerUser, staffUser] = await Promise.all([mkUser('c1', 'CUSTOMER'), mkUser('staff', 'STAFF')])

  const branch = await rawPrisma.branch.create({
    data: { organizationId: org.id, name: `scalarmatch ${label} branch`, timezone: 'UTC' },
  })
  const customer = await rawPrisma.customer.create({
    data: { organizationId: org.id, userId: customerUser.id, firstName: `SC-${label}`, lastName: 'C' },
  })
  const service = await rawPrisma.service.create({
    data: {
      organizationId: org.id,
      name: `scalarmatch ${label} service`,
      durationMinutes: 60,
      price: new Prisma.Decimal('10.00'),
      schedulingType: 'FIXED_SESSION',
    },
  })
  const horse = await rawPrisma.horse.create({
    data: { organizationId: org.id, branchId: branch.id, name: `scalarmatch ${label} horse` },
  })
  const staff = await rawPrisma.staff.create({
    data: { organizationId: org.id, branchId: branch.id, userId: staffUser.id },
  })
  const trainer = await rawPrisma.trainer.create({
    data: { staffId: staff.id, specialties: ['scalarmatch'], certifications: [] },
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
  // Two bookings: CheckIn.bookingId is UNIQUE, so the "accepted" control case
  // needs a booking the rejected cases have not consumed.
  const mkBooking = () =>
    rawPrisma.booking.create({
      data: {
        organizationId: org.id,
        customerId: customer.id,
        ridingSessionId: ridingSession.id,
        createdVia: 'STAFF',
      },
    })
  const booking = await mkBooking()
  const spareBooking = await mkBooking()

  return {
    orgId: org.id,
    customerUserId: customerUser.id,
    staffUserId: staffUser.id,
    customerId: customer.id,
    branchId: branch.id,
    serviceId: service.id,
    horseId: horse.id,
    staffId: staff.id,
    trainerId: trainer.id,
    ridingSessionId: ridingSession.id,
    bookingId: booking.id,
    spareBookingId: spareBooking.id,
  }
}

/**
 * Run one statement on the REAL `app_runtime` connection inside a transaction
 * carrying a tenant context — the same mechanism `withTenantContext` uses, minus
 * Prisma, and with no `SET ROLE` anywhere.
 *
 * Returns either the affected row count or the error message, because the two
 * rejection shapes mean different things: a WITH CHECK failure raises `new row
 * violates row-level security policy`, while a USING failure silently filters the
 * row out and yields `rowCount = 0`.
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
    const userIds = [A, B].flatMap((f) => [f.customerUserId, f.staffUserId])
    for (const model of ['blockedTime', 'checkIn', 'booking', 'ridingSession', 'horse', 'service', 'customer'] as const) {
      await (rawPrisma[model] as { deleteMany: (a: unknown) => Promise<unknown> }).deleteMany({
        where: { organizationId: { in: orgIds } },
      })
    }
    await rawPrisma.trainer.deleteMany({ where: { staff: { organizationId: { in: orgIds } } } })
    await rawPrisma.staff.deleteMany({ where: { organizationId: { in: orgIds } } })
    await rawPrisma.branch.deleteMany({ where: { organizationId: { in: orgIds } } })
    await rawPrisma.organization.deleteMany({ where: { id: { in: orgIds } } })
    await rawPrisma.user.deleteMany({ where: { id: { in: userIds } } })
  } catch (error) {
    console.warn('[scalar-tenant-matching] teardown skipped:', (error as Error).message)
  }
  await rawPrisma.$disconnect()
}, 300_000)

// -----------------------------------------------------------------------------
// The precondition. Every assertion below is vacuous if this fails, so it is
// measured and printed rather than assumed.
// -----------------------------------------------------------------------------
describe('the attacking connection really is the non-bypassing runtime role', () => {
  it('is app_runtime, not superuser, and does not hold BYPASSRLS', () => {
    console.log('[scalar-tenant-matching] attacking connection identity:', identity)
    expect(identity.rolsuper).toBe(false)
    expect(identity.rolbypassrls).toBe(false)
  })
})

// -----------------------------------------------------------------------------
// FINDING 3, structure. The premise of the whole fix is that these four columns
// carry NO foreign key — if a later migration adds one, Part C's FK audit takes
// over and this file's reasoning would need revisiting, so the premise is
// asserted rather than assumed.
// -----------------------------------------------------------------------------
describe('the four scalars are still constraint-less, and their policies now validate them', () => {
  const SCALARS: [string, string, boolean][] = [
    // table, column, nullable
    ['CheckIn', 'checkedInByStaffId', false],
    ['BlockedTime', 'branchId', true],
    ['BlockedTime', 'trainerId', true],
    ['BlockedTime', 'horseId', true],
  ]

  it('none of the four columns is covered by a foreign-key constraint', async () => {
    const rows = await rawPrisma.$queryRawUnsafe<{ src_table: string; src_col: string }[]>(`
      SELECT src.relname AS src_table, sa.attname AS src_col
        FROM pg_constraint con
        JOIN pg_class src ON src.oid = con.conrelid
        JOIN pg_namespace n ON n.oid = src.relnamespace
        JOIN pg_attribute sa ON sa.attrelid = con.conrelid AND sa.attnum = ANY (con.conkey)
       WHERE con.contype = 'f' AND n.nspname = 'public'
         AND src.relname IN ('CheckIn','BlockedTime')`)
    const covered = rows.map((r) => `${r.src_table}.${r.src_col}`)
    console.log('[scalar-tenant-matching] FK-covered columns on these two tables:', covered)
    for (const [table, column] of SCALARS) {
      expect(covered, `${table}.${column} unexpectedly has an FK`).not.toContain(`${table}.${column}`)
    }
    // CheckIn.bookingId DOES have one — Part C's, still in place. Stated so the
    // query above is visibly discriminating rather than vacuously empty.
    expect(covered).toContain('CheckIn.bookingId')
  })

  it('nullability matches what each predicate assumes', async () => {
    // The predicates hard-code which columns get an `IS NULL OR ...` escape. A
    // later migration flipping one would either reject legitimate NULLs or leave
    // dead code, so the assumption is pinned to the database.
    const rows = await rawPrisma.$queryRawUnsafe<{ tbl: string; col: string; notnull: boolean }[]>(`
      SELECT c.relname AS tbl, a.attname AS col, a.attnotnull AS notnull
        FROM pg_attribute a
        JOIN pg_class c ON c.oid = a.attrelid
        JOIN pg_namespace n ON n.oid = c.relnamespace
       WHERE n.nspname='public' AND NOT a.attisdropped
         AND (c.relname, a.attname) IN
             (('CheckIn','checkedInByStaffId'),('BlockedTime','branchId'),
              ('BlockedTime','trainerId'),('BlockedTime','horseId'))`)
    console.log('[scalar-tenant-matching] nullability:', rows)
    expect(rows.length).toBe(4)
    for (const [table, column, nullable] of SCALARS) {
      const row = rows.find((r) => r.tbl === table && r.col === column)!
      expect(row.notnull, `${table}.${column} nullability`).toBe(!nullable)
    }
  })

  it('each table has one policy, a strict USING, and a WITH CHECK naming every scalar it validates', async () => {
    const rows = await rawPrisma.$queryRawUnsafe<
      { tablename: string; policies: number; qual: string; with_check: string | null }[]
    >(
      `SELECT p.tablename,
              (SELECT count(*)::int FROM pg_policies q
                WHERE q.schemaname='public' AND q.tablename = p.tablename) AS policies,
              p.qual, p.with_check
         FROM pg_policies p
        WHERE p.schemaname='public' AND p.policyname='tenant_isolation'
          AND p.tablename IN ('BlockedTime','CheckIn')
        ORDER BY p.tablename`
    )
    expect(rows.map((r) => r.tablename)).toEqual(['BlockedTime', 'CheckIn'])

    for (const r of rows) {
      // One policy: no RESTRICTIVE companion is warranted, because organizationId
      // is NOT NULL on both tables so neither can hold a platform-scoped row.
      expect(r.policies, `${r.tablename} policy count`).toBe(1)
      // READ side untouched: the row's own tenant column and nothing else, so a
      // pre-existing malformed row stays VISIBLE to the tenant that owns it.
      expect(r.qual, `${r.tablename}.qual`).toMatch(/current_setting\('app\.current_tenant_id'/)
      expect(r.qual, `${r.tablename}.qual`).not.toMatch(/EXISTS/)
      // WRITE side explicit — ending Postgres's implicit reuse of USING, which is
      // what let these columns through — and still restating the tenant match.
      expect(r.with_check, `${r.tablename}.with_check`).not.toBeNull()
      expect(r.with_check!, `${r.tablename}.with_check`).toMatch(
        /current_setting\('app\.current_tenant_id'/
      )
    }

    const byTable = Object.fromEntries(rows.map((r) => [r.tablename, r.with_check!]))
    // CheckIn: Part C's bookingId conjunct MUST have survived — ALTER POLICY
    // replaces the whole expression, so the restatement is load-bearing.
    expect(byTable.CheckIn).toMatch(/"Booking"/)
    expect(byTable.CheckIn).toMatch(/checkedInByStaffId/)
    expect(byTable.CheckIn).toMatch(/"Staff"/)
    // BlockedTime: all three scalars, with the Trainer one joining through Staff.
    for (const col of ['branchId', 'trainerId', 'horseId']) {
      expect(byTable.BlockedTime, `BlockedTime.${col} conjunct`).toMatch(new RegExp(col))
    }
    expect(byTable.BlockedTime).toMatch(/"Trainer"/)
    expect(byTable.BlockedTime).toMatch(/"Staff"/)
    expect(byTable.BlockedTime).toMatch(/IS NULL/)
  })
})

// -----------------------------------------------------------------------------
// FINDING 3, the exploit. Each case is an INSERT into tenant A's OWN
// organization whose named scalar points at a row of tenant B. Everything else
// about the row is legitimate, which is exactly what made this silent — the row's
// own organizationId satisfied the old predicate.
// -----------------------------------------------------------------------------
describe('a tenant cannot point one of the four scalars at another tenant', () => {
  function cases(): { scalar: string; table: string; sql: string; params: (x: string) => unknown[] }[] {
    return [
      {
        scalar: 'CheckIn.checkedInByStaffId',
        table: 'CheckIn',
        sql: `INSERT INTO "CheckIn" ("id","organizationId","bookingId","method","checkedInByStaffId")
              VALUES ($1,$2,$3,'MANUAL',$4)`,
        params: (x) => [x, A.orgId, A.bookingId, B.staffId],
      },
      {
        scalar: 'BlockedTime.branchId',
        table: 'BlockedTime',
        sql: `INSERT INTO "BlockedTime" ("id","organizationId","scope","branchId","startsAt","endsAt")
              VALUES ($1,$2,'BRANCH',$3,now(),now()+interval '1 hour')`,
        params: (x) => [x, A.orgId, B.branchId],
      },
      {
        // Two-hop: "Trainer" has no organizationId of its own, so the predicate
        // joins Trainer to its parent Staff.
        scalar: 'BlockedTime.trainerId',
        table: 'BlockedTime',
        sql: `INSERT INTO "BlockedTime" ("id","organizationId","scope","trainerId","startsAt","endsAt")
              VALUES ($1,$2,'TRAINER',$3,now(),now()+interval '1 hour')`,
        params: (x) => [x, A.orgId, B.trainerId],
      },
      {
        scalar: 'BlockedTime.horseId',
        table: 'BlockedTime',
        sql: `INSERT INTO "BlockedTime" ("id","organizationId","scope","horseId","startsAt","endsAt")
              VALUES ($1,$2,'HORSE',$3,now(),now()+interval '1 hour')`,
        params: (x) => [x, A.orgId, B.horseId],
      },
    ]
  }

  it('the case table covers exactly the four scalars the migration fixed', () => {
    expect(new Set(cases().map((c) => c.scalar)).size).toBe(4)
  })

  it.each(cases())('blocks $scalar pointing at another tenant', async ({ table, sql, params }) => {
    const rogueId = fakeCuid()
    const out = await asTenant(A.orgId, sql, params(rogueId))
    console.log(
      `[scalar-tenant-matching] cross-tenant INSERT ${table}:`,
      out.error?.split('\n')[0] ?? out.rowCount
    )
    expect(out.error, `${table} was not rejected`).toBeDefined()
    expect(out.error!).toMatch(/row-level security/i)
    // And nothing landed — asked on the owner connection, so an RLS-filtered read
    // cannot be mistaken for a blocked write.
    expect(await landed(table, rogueId)).toBe(0)
  })

  it('a fabricated id that exists nowhere is also refused (there is no FK to catch it)', async () => {
    // Worth its own case: with no foreign-key constraint, a dangling id was
    // previously accepted outright. The EXISTS conjunct now refuses it, which is
    // integrity the database did not have before at all.
    const rogueId = fakeCuid()
    const out = await asTenant(
      A.orgId,
      `INSERT INTO "BlockedTime" ("id","organizationId","scope","horseId","startsAt","endsAt")
       VALUES ($1,$2,'HORSE',$3,now(),now()+interval '1 hour')`,
      [rogueId, A.orgId, fakeCuid()]
    )
    expect(out.error).toBeDefined()
    expect(out.error!).toMatch(/row-level security/i)
    expect(await landed('BlockedTime', rogueId)).toBe(0)
  })
})

// -----------------------------------------------------------------------------
// UPDATE is the verb the INSERT cases miss: the old row is legitimately the
// caller's own, so USING admits it, and only WITH CHECK can refuse the row it
// would produce.
// -----------------------------------------------------------------------------
describe('a tenant cannot re-point one of its own rows at another tenant', () => {
  let ownBlockedTimeId: string
  let ownCheckInId: string

  beforeAll(async () => {
    const bt = await rawPrisma.blockedTime.create({
      data: {
        organizationId: A.orgId,
        scope: 'BRANCH',
        branchId: A.branchId,
        startsAt: new Date(),
        endsAt: new Date(Date.now() + 3_600_000),
      },
    })
    ownBlockedTimeId = bt.id
    const ci = await rawPrisma.checkIn.create({
      data: {
        organizationId: A.orgId,
        bookingId: A.bookingId,
        method: 'MANUAL',
        checkedInByStaffId: A.staffId,
      },
    })
    ownCheckInId = ci.id
  }, 120_000)

  afterAll(async () => {
    try {
      await deleteAsOwner('CheckIn', ownCheckInId)
      await deleteAsOwner('BlockedTime', ownBlockedTimeId)
    } catch {
      /* the broader teardown will get it */
    }
  }, 120_000)

  it("UPDATE BlockedTime.branchId onto another tenant's Branch is refused", async () => {
    const out = await asTenant(A.orgId, `UPDATE "BlockedTime" SET "branchId" = $1 WHERE "id" = $2`, [
      B.branchId,
      ownBlockedTimeId,
    ])
    expect(out.error).toBeDefined()
    expect(out.error!).toMatch(/row-level security/i)
    const after = await rawPrisma.blockedTime.findUniqueOrThrow({ where: { id: ownBlockedTimeId } })
    expect(after.branchId).toBe(A.branchId)
  })

  it("UPDATE CheckIn.checkedInByStaffId onto another tenant's Staff is refused", async () => {
    const out = await asTenant(
      A.orgId,
      `UPDATE "CheckIn" SET "checkedInByStaffId" = $1 WHERE "id" = $2`,
      [B.staffId, ownCheckInId]
    )
    expect(out.error).toBeDefined()
    expect(out.error!).toMatch(/row-level security/i)
    const after = await rawPrisma.checkIn.findUniqueOrThrow({ where: { id: ownCheckInId } })
    expect(after.checkedInByStaffId).toBe(A.staffId)
  })
})

// -----------------------------------------------------------------------------
// The controls. Without these, every rejection above could be a blanket deny
// that had broken the application outright — the realistic failure mode of a
// predicate this size, and the one that matters most for BlockedTime, whose
// policy had no explicit WITH CHECK at all before this migration.
// -----------------------------------------------------------------------------
describe('legitimate same-tenant values still succeed', () => {
  const created: [string, string][] = []

  afterAll(async () => {
    for (const [table, rowId] of created.reverse()) {
      try {
        await deleteAsOwner(table, rowId)
      } catch {
        /* the broader teardown will get it */
      }
    }
  }, 120_000)

  async function expectAccepted(table: string, sql: string, params: (x: string) => unknown[]) {
    const okId = fakeCuid()
    const out = await asTenant(A.orgId, sql, params(okId))
    expect(out.error, `${table} same-tenant write was rejected: ${out.error}`).toBeUndefined()
    expect(out.rowCount).toBe(1)
    expect(await landed(table, okId)).toBe(1)
    created.push([table, okId])
  }

  it('CheckIn recorded by its own Staff member', async () => {
    await expectAccepted(
      'CheckIn',
      `INSERT INTO "CheckIn" ("id","organizationId","bookingId","method","checkedInByStaffId")
       VALUES ($1,$2,$3,'MANUAL',$4)`,
      (x) => [x, A.orgId, A.spareBookingId, A.staffId]
    )
  })

  it('BlockedTime on its own Branch', async () => {
    await expectAccepted(
      'BlockedTime',
      `INSERT INTO "BlockedTime" ("id","organizationId","scope","branchId","startsAt","endsAt")
       VALUES ($1,$2,'BRANCH',$3,now(),now()+interval '1 hour')`,
      (x) => [x, A.orgId, A.branchId]
    )
  })

  it('BlockedTime on its own Trainer (resolved two-hop through Staff)', async () => {
    await expectAccepted(
      'BlockedTime',
      `INSERT INTO "BlockedTime" ("id","organizationId","scope","trainerId","startsAt","endsAt")
       VALUES ($1,$2,'TRAINER',$3,now(),now()+interval '1 hour')`,
      (x) => [x, A.orgId, A.trainerId]
    )
  })

  it('BlockedTime on its own Horse', async () => {
    await expectAccepted(
      'BlockedTime',
      `INSERT INTO "BlockedTime" ("id","organizationId","scope","horseId","startsAt","endsAt")
       VALUES ($1,$2,'HORSE',$3,now(),now()+interval '1 hour')`,
      (x) => [x, A.orgId, A.horseId]
    )
  })

  it('and a tenant still reads its own rows on both tables (USING was not widened)', async () => {
    await app.query('BEGIN')
    await app.query(`SET LOCAL app.current_tenant_id = '${A.orgId}'`)
    const r = await app.query<{ [k: string]: number }>(
      `SELECT (SELECT count(*)::int FROM "BlockedTime") AS blocked_time,
              (SELECT count(*)::int FROM "CheckIn")     AS check_in,
              (SELECT count(*)::int FROM "BlockedTime" WHERE "organizationId" <> $1) AS foreign_bt`,
      [A.orgId]
    )
    await app.query('COMMIT')
    console.log('[scalar-tenant-matching] tenant A read-side after the fix:', r.rows[0])
    expect(r.rows[0].blocked_time).toBeGreaterThan(0)
    expect(r.rows[0].check_in).toBeGreaterThan(0)
    expect(r.rows[0].foreign_bt).toBe(0)
  })
})

// -----------------------------------------------------------------------------
// The NULL branches. All three BlockedTime columns are optional, and `scope`
// (BRANCH | TRAINER | HORSE) decides which ONE is populated — so a predicate
// missing the `IS NULL OR` escape would reject essentially every real write. That
// is the most likely way this migration could have been subtly wrong, so each
// column is asserted individually.
// -----------------------------------------------------------------------------
describe('NULL is still accepted for all three nullable BlockedTime scalars', () => {
  const created: [string, string][] = []

  afterAll(async () => {
    for (const [table, rowId] of created.reverse()) {
      try {
        await deleteAsOwner(table, rowId)
      } catch {
        /* the broader teardown will get it */
      }
    }
  }, 120_000)

  async function expectNullAccepted(label: string, sql: string, params: (x: string) => unknown[]) {
    const okId = fakeCuid()
    const out = await asTenant(A.orgId, sql, params(okId))
    expect(out.error, `${label} rejected a legitimate NULL: ${out.error}`).toBeUndefined()
    expect(out.rowCount).toBe(1)
    expect(await landed('BlockedTime', okId)).toBe(1)
    created.push(['BlockedTime', okId])
  }

  it('branchId set, trainerId and horseId NULL (scope = BRANCH, the normal shape)', async () => {
    await expectNullAccepted(
      'scope BRANCH',
      `INSERT INTO "BlockedTime" ("id","organizationId","scope","branchId","trainerId","horseId","startsAt","endsAt")
       VALUES ($1,$2,'BRANCH',$3,NULL,NULL,now(),now()+interval '1 hour')`,
      (x) => [x, A.orgId, A.branchId]
    )
  })

  it('trainerId set, branchId and horseId NULL (scope = TRAINER)', async () => {
    await expectNullAccepted(
      'scope TRAINER',
      `INSERT INTO "BlockedTime" ("id","organizationId","scope","branchId","trainerId","horseId","startsAt","endsAt")
       VALUES ($1,$2,'TRAINER',NULL,$3,NULL,now(),now()+interval '1 hour')`,
      (x) => [x, A.orgId, A.trainerId]
    )
  })

  it('horseId set, branchId and trainerId NULL (scope = HORSE)', async () => {
    await expectNullAccepted(
      'scope HORSE',
      `INSERT INTO "BlockedTime" ("id","organizationId","scope","branchId","trainerId","horseId","startsAt","endsAt")
       VALUES ($1,$2,'HORSE',NULL,NULL,$3,now(),now()+interval '1 hour')`,
      (x) => [x, A.orgId, A.horseId]
    )
  })

  it('all three NULL at once is still legal (the schema permits it, so the policy must not forbid it)', async () => {
    await expectNullAccepted(
      'all NULL',
      `INSERT INTO "BlockedTime" ("id","organizationId","scope","startsAt","endsAt")
       VALUES ($1,$2,'BRANCH',now(),now()+interval '1 hour')`,
      (x) => [x, A.orgId]
    )
  })

  it('an existing non-null value can still be cleared back to NULL', async () => {
    // UPDATE re-evaluates the whole WITH CHECK, so a predicate that only handled
    // NULL on INSERT would fail here.
    const row = await rawPrisma.blockedTime.create({
      data: {
        organizationId: A.orgId,
        scope: 'HORSE',
        horseId: A.horseId,
        startsAt: new Date(),
        endsAt: new Date(Date.now() + 3_600_000),
      },
    })
    created.push(['BlockedTime', row.id])
    const out = await asTenant(A.orgId, `UPDATE "BlockedTime" SET "horseId" = NULL WHERE "id" = $1`, [
      row.id,
    ])
    expect(out.error).toBeUndefined()
    expect(out.rowCount).toBe(1)
    const after = await rawPrisma.blockedTime.findUniqueOrThrow({ where: { id: row.id } })
    expect(after.horseId).toBeNull()
  })

  it('and a cross-tenant value is still refused on a row whose other two columns are NULL', async () => {
    // Guards the obvious way a NULL-permissive predicate could be written wrong:
    // an `OR` that short-circuits the whole conjunction as soon as ONE column is
    // NULL, rather than one `IS NULL OR EXISTS` group per column.
    const rogueId = fakeCuid()
    const out = await asTenant(
      A.orgId,
      `INSERT INTO "BlockedTime" ("id","organizationId","scope","branchId","trainerId","horseId","startsAt","endsAt")
       VALUES ($1,$2,'HORSE',NULL,NULL,$3,now(),now()+interval '1 hour')`,
      [rogueId, A.orgId, B.horseId]
    )
    expect(out.error).toBeDefined()
    expect(out.error!).toMatch(/row-level security/i)
    expect(await landed('BlockedTime', rogueId)).toBe(0)
  })
})

// =============================================================================
// FINDING 4 — least privilege for the runtime role on `_prisma_migrations` and
// `AuditLog`. Asserted in both directions: what was removed is gone, what must
// survive still works, and nothing else moved.
// =============================================================================
describe('app_runtime holds no privilege on the migration ledger', () => {
  it('the catalog shows zero grants on _prisma_migrations', async () => {
    const rows = await rawPrisma.$queryRawUnsafe<{ privilege_type: string }[]>(
      `SELECT privilege_type FROM information_schema.table_privileges
        WHERE grantee='app_runtime' AND table_schema='public' AND table_name='_prisma_migrations'`
    )
    console.log('[scalar-tenant-matching] app_runtime privileges on _prisma_migrations:', rows)
    expect(rows).toEqual([])
  })

  it('and a live SELECT as app_runtime is refused by Postgres, not merely filtered', async () => {
    // The distinction matters: `_prisma_migrations` has RLS DISABLED, so a policy
    // could never have protected it. Only a grant revoke can, and a revoke shows
    // up as `permission denied`, never as an empty result.
    const out = await asTenant(A.orgId, `SELECT count(*) FROM "_prisma_migrations"`)
    console.log('[scalar-tenant-matching] app_runtime SELECT _prisma_migrations:', out.error?.split('\n')[0])
    expect(out.error).toBeDefined()
    expect(out.error!).toMatch(/permission denied for table _prisma_migrations/i)
  })

  it('migrations are unaffected: the ledger is owned by postgres, which runs them over DIRECT_URL', async () => {
    const rows = await rawPrisma.$queryRawUnsafe<{ owner: string; rls: boolean; applied: number }[]>(
      `SELECT pg_get_userbyid(c.relowner) AS owner, c.relrowsecurity AS rls,
              (SELECT count(*)::int FROM "_prisma_migrations" WHERE "finished_at" IS NOT NULL) AS applied
         FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace
        WHERE n.nspname='public' AND c.relname='_prisma_migrations'`
    )
    console.log('[scalar-tenant-matching] _prisma_migrations ownership:', rows[0])
    expect(rows[0].owner).toBe('postgres')
    // The owner connection can still read it — i.e. the revoke touched only the
    // runtime role — and this migration is itself recorded in it.
    expect(rows[0].applied).toBeGreaterThan(0)
  })
})

describe('app_runtime can write and read the audit trail but cannot alter or erase it', () => {
  const written: string[] = []

  afterAll(async () => {
    try {
      if (written.length) {
        await rawPrisma.auditLog.deleteMany({ where: { id: { in: written } } })
      }
    } catch (error) {
      console.warn('[scalar-tenant-matching] audit teardown skipped:', (error as Error).message)
    }
  }, 120_000)

  it('the catalog shows exactly SELECT and INSERT', async () => {
    const rows = await rawPrisma.$queryRawUnsafe<{ privilege_type: string }[]>(
      `SELECT privilege_type FROM information_schema.table_privileges
        WHERE grantee='app_runtime' AND table_schema='public' AND table_name='AuditLog'
        ORDER BY privilege_type`
    )
    console.log('[scalar-tenant-matching] app_runtime privileges on AuditLog:', rows)
    expect(rows.map((r) => r.privilege_type)).toEqual(['INSERT', 'SELECT'])
  })

  it('INSERT works — the platform must be able to write audit entries', async () => {
    const id = fakeCuid()
    const out = await asTenant(
      A.orgId,
      `INSERT INTO "AuditLog" ("id","organizationId","actorUserId","action","entityType","entityId")
       VALUES ($1,$2,$3,'scalarmatch.probe','Probe',$1)`,
      [id, A.orgId, A.staffUserId]
    )
    expect(out.error, `audit INSERT was rejected: ${out.error}`).toBeUndefined()
    expect(out.rowCount).toBe(1)
    written.push(id)
    expect(await landed('AuditLog', id)).toBe(1)
  })

  it('SELECT works — the platform must be able to read them back', async () => {
    const out = await asTenant(A.orgId, `SELECT count(*) FROM "AuditLog"`)
    expect(out.error, `audit SELECT was rejected: ${out.error}`).toBeUndefined()
  })

  it('UPDATE is refused', async () => {
    const out = await asTenant(A.orgId, `UPDATE "AuditLog" SET "action" = 'tampered' WHERE "id" = $1`, [
      written[0] ?? fakeCuid(),
    ])
    console.log('[scalar-tenant-matching] app_runtime UPDATE AuditLog:', out.error?.split('\n')[0])
    expect(out.error).toBeDefined()
    expect(out.error!).toMatch(/permission denied for table "?AuditLog"?/i)
  })

  it('DELETE is refused', async () => {
    const out = await asTenant(A.orgId, `DELETE FROM "AuditLog" WHERE "id" = $1`, [
      written[0] ?? fakeCuid(),
    ])
    console.log('[scalar-tenant-matching] app_runtime DELETE AuditLog:', out.error?.split('\n')[0])
    expect(out.error).toBeDefined()
    expect(out.error!).toMatch(/permission denied for table "?AuditLog"?/i)
  })

  it('the surviving entry proves the refusals were real, not a rolled-back illusion', async () => {
    // Read on the OWNER connection: the row written above is still present and
    // still says what it said.
    const row = await rawPrisma.auditLog.findUniqueOrThrow({ where: { id: written[0] } })
    expect(row.action).toBe('scalarmatch.probe')
  })
})

describe('nothing else about app_runtime moved', () => {
  it('every other public table still carries exactly SELECT, INSERT, UPDATE, DELETE', async () => {
    // The blunt way Finding 4 could have gone wrong is a revoke that caught more
    // than its two targets. This enumerates the whole schema from the catalog.
    const rows = await rawPrisma.$queryRawUnsafe<{ table_name: string; privs: string }[]>(
      `SELECT table_name, string_agg(privilege_type, ',' ORDER BY privilege_type) AS privs
         FROM information_schema.table_privileges
        WHERE grantee='app_runtime' AND table_schema='public'
        GROUP BY 1 ORDER BY 1`
    )
    const byTable = Object.fromEntries(rows.map((r) => [r.table_name, r.privs]))
    console.log('[scalar-tenant-matching] tables app_runtime can reach:', rows.length)

    expect(byTable['_prisma_migrations']).toBeUndefined()
    expect(byTable['AuditLog']).toBe('INSERT,SELECT')
    const others = Object.entries(byTable).filter(([t]) => t !== 'AuditLog')
    // 28 tables exist in `public` plus the ledger; AuditLog is narrowed and the
    // ledger is gone, leaving 27 on full CRUD.
    expect(others.length).toBe(27)
    for (const [table, privs] of others) {
      expect(privs, `${table} privileges`).toBe('DELETE,INSERT,SELECT,UPDATE')
    }
  })

  it('and it still holds USAGE on schema public, which the PUBLIC-grant revoke did not touch', async () => {
    // Finding 1 revoked USAGE on `public` from the pseudo-role PUBLIC.
    // `app_runtime` has an explicit grant of its own from Part A, so it is
    // unaffected — but "unaffected" is exactly the kind of claim that should be
    // measured, since losing it would break the application outright.
    const rows = await rawPrisma.$queryRawUnsafe<{ rolname: string; usage: boolean }[]>(
      `SELECT rolname, has_schema_privilege(rolname,'public','USAGE') AS usage
         FROM pg_roles
        WHERE rolname IN ('app_runtime','postgres','service_role','anon','authenticated')
        ORDER BY rolname`
    )
    console.log('[scalar-tenant-matching] schema public USAGE:', rows)
    const usage = Object.fromEntries(rows.map((r) => [r.rolname, r.usage]))
    expect(usage.app_runtime).toBe(true)
    expect(usage.postgres).toBe(true)
    expect(usage.service_role).toBe(true)
    // And the point of the revoke: the two Data API roles no longer have it.
    expect(usage.anon).toBe(false)
    expect(usage.authenticated).toBe(false)
  })
})

// =============================================================================
// FINDINGS 1 and 2 — default privileges for objects that do not exist yet.
//
// This is the hardest thing in Part D to test, because the subject is a FUTURE
// object. The instrument is the reviewer's: create a sequence, a function and a
// table inside a transaction on the OWNER connection (i.e. as `postgres`, the
// role every Prisma migration runs as), read the ACL Postgres actually stamped
// on them, then drop all three inside the same transaction so nothing is left
// behind — and assert that emptiness separately rather than trusting it.
// =============================================================================
describe('default privileges for future objects created by postgres', () => {
  type Acls = {
    seq_acl: string | null
    fn_acl: string | null
    tbl_acl: string | null
    ar_seq_usage: boolean
    ar_seq_select: boolean
    ar_seq_update: boolean
    anon_seq_usage: boolean
    auth_seq_usage: boolean
    anon_tbl_select: boolean
    auth_tbl_select: boolean
    ar_tbl_select: boolean
  }
  let acls: Acls

  beforeAll(async () => {
    // One transaction, so a failure part-way through rolls the probe DDL back
    // rather than leaving a stray object in `public`. Names carry a timestamp
    // suffix so a crashed earlier run cannot collide with this one.
    const suffix = `${Date.now()}`
    await rawPrisma.$transaction(async (tx) => {
      await tx.$executeRawUnsafe(`CREATE SEQUENCE public.partd_probe_seq_${suffix}`)
      await tx.$executeRawUnsafe(
          `CREATE FUNCTION public.partd_probe_fn_${suffix}() RETURNS int LANGUAGE sql AS $fn$ SELECT 1 $fn$`
      )
      await tx.$executeRawUnsafe(`CREATE TABLE public.partd_probe_tbl_${suffix} (id int)`)
      const rows = await tx.$queryRawUnsafe<Acls[]>(`
          SELECT (SELECT relacl::text FROM pg_class WHERE relname='partd_probe_seq_${suffix}') AS seq_acl,
                 (SELECT proacl::text FROM pg_proc  WHERE proname='partd_probe_fn_${suffix}')  AS fn_acl,
                 (SELECT relacl::text FROM pg_class WHERE relname='partd_probe_tbl_${suffix}') AS tbl_acl,
                 has_sequence_privilege('app_runtime','public.partd_probe_seq_${suffix}','USAGE')  AS ar_seq_usage,
                 has_sequence_privilege('app_runtime','public.partd_probe_seq_${suffix}','SELECT') AS ar_seq_select,
                 has_sequence_privilege('app_runtime','public.partd_probe_seq_${suffix}','UPDATE') AS ar_seq_update,
                 has_sequence_privilege('anon','public.partd_probe_seq_${suffix}','USAGE')          AS anon_seq_usage,
                 has_sequence_privilege('authenticated','public.partd_probe_seq_${suffix}','USAGE') AS auth_seq_usage,
                 has_table_privilege('anon','public.partd_probe_tbl_${suffix}','SELECT')            AS anon_tbl_select,
                 has_table_privilege('authenticated','public.partd_probe_tbl_${suffix}','SELECT')    AS auth_tbl_select,
                 has_table_privilege('app_runtime','public.partd_probe_tbl_${suffix}','SELECT')      AS ar_tbl_select`)
      acls = rows[0]
      // Undo everything explicitly inside the same transaction, so the schema is
      // clean whether the transaction commits or not.
      await tx.$executeRawUnsafe(`DROP TABLE public.partd_probe_tbl_${suffix}`)
      await tx.$executeRawUnsafe(`DROP FUNCTION public.partd_probe_fn_${suffix}()`)
      await tx.$executeRawUnsafe(`DROP SEQUENCE public.partd_probe_seq_${suffix}`)
    })
    console.log('[scalar-tenant-matching] ACLs stamped on future objects:', acls)
  }, 300_000)

  it('leaves nothing behind in the schema', async () => {
    const rows = await rawPrisma.$queryRawUnsafe<{ n: number }[]>(
      `SELECT (SELECT count(*)::int FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace
                WHERE n.nspname='public' AND c.relname LIKE 'partd_probe_%')
            + (SELECT count(*)::int FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace
                WHERE n.nspname='public' AND p.proname LIKE 'partd_probe_%') AS n`
    )
    expect(rows[0].n).toBe(0)
  })

  it('a future SEQUENCE grants anon/authenticated nothing (Finding 1)', () => {
    expect(acls.seq_acl ?? '').not.toMatch(/(^|,)anon=/)
    expect(acls.seq_acl ?? '').not.toMatch(/(^|,)authenticated=/)
    expect(acls.anon_seq_usage).toBe(false)
    expect(acls.auth_seq_usage).toBe(false)
  })

  it('a future SEQUENCE is usable by app_runtime, but not rewindable (Finding 1)', () => {
    // Before this migration both were FALSE, which would have broken the app the
    // moment any migration added a serial/identity column. UPDATE stays denied:
    // it is what setval() needs, and no application flow rewinds a generator.
    expect(acls.ar_seq_usage).toBe(true)
    expect(acls.ar_seq_select).toBe(true)
    expect(acls.ar_seq_update).toBe(false)
  })

  it('a future FUNCTION grants anon/authenticated nothing by name (Finding 1)', () => {
    expect(acls.fn_acl ?? '').not.toMatch(/(^|,)anon=/)
    expect(acls.fn_acl ?? '').not.toMatch(/(^|,)authenticated=/)
  })

  it("a future FUNCTION's residual PUBLIC execute grant is unreachable without schema USAGE", async () => {
    // Honest about what remains: Postgres's OWN built-in default gives EXECUTE to
    // the pseudo-role PUBLIC on every new function (`=X/postgres` in the ACL), and
    // that is not a `pg_default_acl` entry, so ALTER DEFAULT PRIVILEGES ... REVOKE
    // ... FROM anon, authenticated cannot remove it. It is inert here because
    // Finding 1 also revoked USAGE on schema `public` from PUBLIC, and a function
    // cannot be named without USAGE on its schema. If a future task ever grants
    // anon schema USAGE again, this becomes live — which is why it is pinned here
    // rather than left as a footnote.
    expect(acls.fn_acl ?? '').toMatch(/(^|\{)=X\//)
    // The thing that makes it inert, measured here too rather than cross-referenced.
    const rows = await rawPrisma.$queryRawUnsafe<{ anon_usage: boolean; auth_usage: boolean }[]>(
      `SELECT has_schema_privilege('anon','public','USAGE') AS anon_usage,
              has_schema_privilege('authenticated','public','USAGE') AS auth_usage`
    )
    expect(rows[0].anon_usage).toBe(false)
    expect(rows[0].auth_usage).toBe(false)
  })

  it('a future TABLE is still correct — Part B closed this one, and Part D did not regress it', () => {
    expect(acls.anon_tbl_select).toBe(false)
    expect(acls.auth_tbl_select).toBe(false)
    expect(acls.ar_tbl_select).toBe(true)
  })
})

describe('the supabase_admin default-ACL entry (Finding 2) — recorded, not fixed', () => {
  it('still grants anon/authenticated on tables supabase_admin itself creates', async () => {
    // This is a DELIBERATE failing-to-fix, asserted so it cannot rot into an
    // unexamined assumption. `ALTER DEFAULT PRIVILEGES FOR ROLE supabase_admin`
    // was attempted as `postgres` and returned `permission denied to change
    // default privileges`: Postgres allows it only for oneself or a role one is a
    // member of, and `postgres` is not a member of `supabase_admin` (checked via
    // pg_auth_members) nor a superuser on Supabase's managed platform. See the
    // Task 9 report, Part D, for the residual-item writeup.
    //
    // If this test ever FAILS, that is good news — it means the entry was cleaned
    // up out-of-band, and the residual item can be closed.
    const rows = await rawPrisma.$queryRawUnsafe<{ objtype: string; acl: string }[]>(
      `SELECT d.defaclobjtype::text AS objtype, d.defaclacl::text AS acl
         FROM pg_default_acl d JOIN pg_namespace n ON n.oid=d.defaclnamespace
        WHERE n.nspname='public' AND pg_get_userbyid(d.defaclrole) = 'supabase_admin'
        ORDER BY 1`
    )
    console.log('[scalar-tenant-matching] supabase_admin default ACLs (residual):', rows)
    expect(rows.length).toBeGreaterThan(0)
    expect(rows.some((r) => /anon=/.test(r.acl))).toBe(true)
  })

  it("but postgres's OWN entries — the path every migration actually takes — are clean", async () => {
    const rows = await rawPrisma.$queryRawUnsafe<{ objtype: string; acl: string }[]>(
      `SELECT d.defaclobjtype::text AS objtype, d.defaclacl::text AS acl
         FROM pg_default_acl d JOIN pg_namespace n ON n.oid=d.defaclnamespace
        WHERE n.nspname='public' AND pg_get_userbyid(d.defaclrole) = 'postgres'
        ORDER BY 1`
    )
    console.log('[scalar-tenant-matching] postgres default ACLs:', rows)
    // All three object classes present: tables (r), sequences (S), functions (f).
    expect(rows.map((r) => r.objtype).sort()).toEqual(['S', 'f', 'r'])
    for (const r of rows) {
      expect(r.acl, `${r.objtype} default ACL`).not.toMatch(/(^|,|\{)anon=/)
      expect(r.acl, `${r.objtype} default ACL`).not.toMatch(/(^|,|\{)authenticated=/)
    }
  })

  it('and the migration-running role really is postgres, which is what makes that the primary path', async () => {
    const rows = await rawPrisma.$queryRawUnsafe<{ current_user: string }[]>(`SELECT current_user`)
    // The suite's owner connection and `prisma migrate deploy` both authenticate
    // as this role (`.env.test` DATABASE_URL and `.env` DIRECT_URL respectively).
    expect(rows[0].current_user).toBe('postgres')
  })
})
