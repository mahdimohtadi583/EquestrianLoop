import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest'
import fs from 'node:fs'
import path from 'node:path'
import dotenv from 'dotenv'
import { Client } from 'pg'
import { rawPrisma } from '@/db/raw-client'

// =============================================================================
// Task 9 security hardening, Part A — the regression test for the one finding
// that every previous round of Task 9 work could not close.
//
// WHAT MAKES THIS FILE DIFFERENT FROM tests/db/rls-security.test.ts
// -----------------------------------------------------------------
// That file proves the *policies* are correct. It has to do so through
// `SET LOCAL ROLE authenticated`, because the role behind DATABASE_URL at the
// time was Supabase's `postgres`: rolbypassrls = TRUE and owner of every table,
// so the policies filtered nothing at all for the connection the application
// actually used. `SET LOCAL ROLE` is a faithful instrument for testing a policy,
// but it is a *proxy* — it proves "these policies would enforce against a role
// that is subject to them", not "they enforce for the role this app runs as".
//
// This file closes that gap. It opens a connection using the **actual runtime
// DATABASE_URL**, authenticates as the real `app_runtime` role, performs no
// role-switching of any kind, and proves cross-tenant isolation from there. If
// someone ever repoints DATABASE_URL back at a BYPASSRLS role, or grants
// `app_runtime` BYPASSRLS, or makes it a table owner, the assertions below go
// red — which is the entire point.
//
// WHY IT READS .env DIRECTLY INSTEAD OF process.env.DATABASE_URL
// --------------------------------------------------------------
// Under NODE_ENV=test (which Vitest sets), src/db/env.ts overlays `.env.test`,
// which deliberately points process.env.DATABASE_URL back at the owner role so
// that Tasks 3-8's sanctioned contextless-`rawPrisma` schema tests keep working.
// Reading process.env here would therefore test the owner role and prove
// nothing. The runtime string has to come from `.env` itself — the very value
// the application uses in dev and production.
//
// TEST-DATA DISCIPLINE
// --------------------
// Every fixture row, including the victim tenant's, is created through
// `rawPrisma` as the owner with no tenant context, so nothing in the setup path
// depends on RLS and the setup cannot mask a failure of the thing under test.
// All post-hoc "did the write actually land?" checks are made from that same
// owner connection, so an RLS-filtered read can never be mistaken for a blocked
// write.
// =============================================================================

// Remote Supabase; real round trips. Vitest's 5s default is far too tight.
vi.setConfig({ testTimeout: 120_000, hookTimeout: 240_000 })

const ROOT = path.resolve(__dirname, '..', '..')

/**
 * The connection string the application itself uses at runtime, taken from
 * `.env` rather than from process.env — see the header note.
 *
 * Deliberately fails loudly rather than skipping: a security regression test
 * that quietly no-ops when its input is missing is worse than no test, because
 * a green suite would then assert nothing about the property that matters most.
 */
function runtimeConnectionString(): string {
  const envPath = path.join(ROOT, '.env')
  if (!fs.existsSync(envPath)) {
    throw new Error(
      `tests/db/runtime-role-rls.test.ts needs the real runtime DATABASE_URL, which lives in ` +
        `${envPath} (gitignored). This test exists to prove that RLS enforces for the role the ` +
        `application actually connects as, so it cannot fall back to process.env.DATABASE_URL — ` +
        `under NODE_ENV=test that is .env.test's owner-role override, which bypasses RLS and ` +
        `would make every assertion below vacuous. Create .env from .env.example.`
    )
  }
  const parsed = dotenv.parse(fs.readFileSync(envPath))
  if (!parsed.DATABASE_URL) throw new Error('.env exists but defines no DATABASE_URL')
  return parsed.DATABASE_URL
}

const CUID_ALPHABET = 'abcdefghijklmnopqrstuvwxyz0123456789'
function fakeCuid(): string {
  let out = 'c'
  for (let i = 0; i < 24; i += 1) out += CUID_ALPHABET[Math.floor(Math.random() * 36)]
  return out
}

const stamp = `${Date.now()}-${Math.floor(Math.random() * 1e6)}`

type Fixture = { orgId: string; userId: string; customerId: string; branchId: string }

/** The live connection authenticated as the real runtime role. */
let app: Client
/** Identity facts measured on that connection, reused by several tests. */
let identity: {
  current_user: string
  session_user: string
  rolsuper: boolean
  rolbypassrls: boolean
  customer_owner: string
}
let A: Fixture
let B: Fixture
/** A user with no Customer row yet — Customer.userId is unique. */
let spareUserId: string

async function createFixture(label: string): Promise<Fixture> {
  const org = await rawPrisma.organization.create({
    data: { name: `runtime-role ${label} ${stamp}`, slug: `runtime-role-${label}-${stamp}` },
  })
  const user = await rawPrisma.user.create({
    data: {
      email: `runtime-role-${label}-${stamp}@test.com`,
      passwordHash: 'x',
      type: 'CUSTOMER',
      name: `runtime-role ${label}`,
    },
  })
  const customer = await rawPrisma.customer.create({
    data: {
      organizationId: org.id,
      userId: user.id,
      firstName: `RR-${label}`,
      lastName: 'Customer',
    },
  })
  const branch = await rawPrisma.branch.create({
    data: { organizationId: org.id, name: `runtime-role ${label} branch`, timezone: 'UTC' },
  })
  return { orgId: org.id, userId: user.id, customerId: customer.id, branchId: branch.id }
}

/**
 * Run `fn` in a transaction on the runtime connection with `app.current_tenant_id`
 * set — the same mechanism `withTenantContext` uses, minus Prisma, and with
 * absolutely no `SET ROLE`.
 */
async function asTenant<T>(organizationId: string, fn: () => Promise<T>): Promise<T> {
  await app.query('BEGIN')
  try {
    // Same escaping withTenantContext applies; the ids here are server-generated.
    await app.query(`SET LOCAL app.current_tenant_id = '${organizationId.replace(/'/g, "''")}'`)
    const out = await fn()
    await app.query('COMMIT')
    return out
  } catch (error) {
    await app.query('ROLLBACK')
    throw error
  }
}

/** Same, but no tenant context is ever set. */
async function withNoTenantContext<T>(fn: () => Promise<T>): Promise<T> {
  await app.query('BEGIN')
  try {
    const out = await fn()
    await app.query('COMMIT')
    return out
  } catch (error) {
    await app.query('ROLLBACK')
    throw error
  }
}

beforeAll(async () => {
  A = await createFixture('a')
  B = await createFixture('b')
  const spare = await rawPrisma.user.create({
    data: {
      email: `runtime-role-spare-${stamp}@test.com`,
      passwordHash: 'x',
      type: 'CUSTOMER',
      name: 'runtime-role spare',
    },
  })
  spareUserId = spare.id

  app = new Client({ connectionString: runtimeConnectionString(), connectionTimeoutMillis: 15_000 })
  await app.connect()
  const rows = await app.query<typeof identity>(
    `SELECT current_user, session_user, r.rolsuper, r.rolbypassrls,
            (SELECT tableowner FROM pg_tables WHERE schemaname='public' AND tablename='Customer')
              AS customer_owner
       FROM pg_roles r WHERE r.rolname = current_user`
  )
  identity = rows.rows[0]
}, 240_000)

afterAll(async () => {
  try {
    await app?.end()
  } catch {
    /* connection already gone */
  }
  try {
    const orgIds = [A.orgId, B.orgId]
    await rawPrisma.customer.deleteMany({ where: { organizationId: { in: orgIds } } })
    await rawPrisma.branch.deleteMany({ where: { organizationId: { in: orgIds } } })
    await rawPrisma.organization.deleteMany({ where: { id: { in: orgIds } } })
    await rawPrisma.user.deleteMany({ where: { id: { in: [A.userId, B.userId, spareUserId] } } })
  } catch (error) {
    console.warn('[runtime-role-rls] teardown skipped:', (error as Error).message)
  }
  await rawPrisma.$disconnect()
}, 240_000)

// -----------------------------------------------------------------------------
// The precondition. Every assertion below is meaningless if this one fails, so
// it is asserted rather than assumed, and printed verbatim.
// -----------------------------------------------------------------------------
describe('the runtime DATABASE_URL role is genuinely subject to RLS', () => {
  it('is not superuser, does not have BYPASSRLS, and does not own the tables', () => {
    console.log('[runtime-role-rls] runtime connection identity:', identity)
    expect(identity.rolsuper).toBe(false)
    // THE finding this whole hardening round exists to fix. Postgres exempts a
    // BYPASSRLS role from RLS unconditionally — FORCE ROW LEVEL SECURITY cannot
    // override it — so this single boolean decides whether the tenant_isolation
    // policies are a security boundary or decoration.
    expect(identity.rolbypassrls).toBe(false)
    // Ownership is the second exemption route. FORCE closes it, but a non-owner
    // runtime role means RLS holds even if FORCE were ever dropped.
    expect(identity.customer_owner).not.toBe(identity.current_user)
    expect(identity.current_user).toBe(identity.session_user)
  })

  it('is a different role from the one the rest of the test suite runs as', async () => {
    // .env.test points process.env.DATABASE_URL at the owner role so that Tasks
    // 3-8's sanctioned contextless-rawPrisma tests keep working. If that
    // override ever collapsed onto the same role, this file would silently
    // degrade into testing the owner and prove nothing.
    const suiteRole = await rawPrisma.$queryRawUnsafe<
      { current_user: string; rolbypassrls: boolean }[]
    >(`SELECT current_user, r.rolbypassrls FROM pg_roles r WHERE r.rolname = current_user`)
    console.log('[runtime-role-rls] suite (owner) role:', suiteRole[0])
    expect(suiteRole[0].current_user).not.toBe(identity.current_user)
    // And the contrast that documents why the override is needed at all.
    expect(suiteRole[0].rolbypassrls).toBe(true)
  })

  it('holds exactly ordinary CRUD on public, and no TRUNCATE/REFERENCES/TRIGGER', async () => {
    const rows = await rawPrisma.$queryRawUnsafe<{ privilege_type: string; tables: number }[]>(
      `SELECT privilege_type, count(DISTINCT table_name)::int AS tables
         FROM information_schema.role_table_grants
        WHERE table_schema = 'public' AND grantee = '${identity.current_user}'
        GROUP BY privilege_type ORDER BY privilege_type`
    )
    console.log('[runtime-role-rls] runtime role grants on public:', rows)
    expect(rows.map((r) => r.privilege_type).sort()).toEqual([
      'DELETE',
      'INSERT',
      'SELECT',
      'UPDATE',
    ])
  })
})

// -----------------------------------------------------------------------------
// Cross-tenant isolation, proved on the real runtime connection.
// -----------------------------------------------------------------------------
describe('cross-tenant isolation holds for the real runtime role', () => {
  it('with no tenant context at all, tenant-scoped tables return zero rows', async () => {
    const seen = await withNoTenantContext(async () => {
      const r = await app.query<{
        setting: string | null
        customers: number
        branches: number
        known_row: number
      }>(
        `SELECT current_setting('app.current_tenant_id', true) AS setting,
                (SELECT count(*)::int FROM "Customer")                  AS customers,
                (SELECT count(*)::int FROM "Branch")                    AS branches,
                (SELECT count(*)::int FROM "Customer" WHERE "id" = $1)   AS known_row`,
        [A.customerId]
      )
      return r.rows[0]
    })
    console.log('[runtime-role-rls] no tenant context:', seen)
    // Zero rows — not an error, and emphatically not everything.
    expect(seen.customers).toBe(0)
    expect(seen.branches).toBe(0)
    expect(seen.known_row).toBe(0)
    // Sanity, from the owner connection: the row it looked for really exists.
    const exists = await rawPrisma.customer.findUnique({ where: { id: A.customerId } })
    expect(exists).not.toBeNull()
  })

  it('with tenant context set, only that tenant\'s rows are visible', async () => {
    const seen = await asTenant(A.orgId, async () => {
      const r = await app.query<{
        own_customer: number
        own_branch: number
        other_customer: number
        other_branch: number
        any_foreign_customer: number
        any_foreign_branch: number
      }>(
        `SELECT (SELECT count(*)::int FROM "Customer" WHERE "id" = $1)              AS own_customer,
                (SELECT count(*)::int FROM "Branch"   WHERE "id" = $2)              AS own_branch,
                (SELECT count(*)::int FROM "Customer" WHERE "id" = $3)              AS other_customer,
                (SELECT count(*)::int FROM "Branch"   WHERE "id" = $4)              AS other_branch,
                (SELECT count(*)::int FROM "Customer" WHERE "organizationId" <> $5) AS any_foreign_customer,
                (SELECT count(*)::int FROM "Branch"   WHERE "organizationId" <> $5) AS any_foreign_branch`,
        [A.customerId, A.branchId, B.customerId, B.branchId, A.orgId]
      )
      return r.rows[0]
    })
    console.log('[runtime-role-rls] tenant A context:', seen)
    // The policy isolates rather than simply breaking the table...
    expect(seen.own_customer).toBe(1)
    expect(seen.own_branch).toBe(1)
    // ...and tenant B is invisible...
    expect(seen.other_customer).toBe(0)
    expect(seen.other_branch).toBe(0)
    // ...as is every other tenant in the database, not just B.
    expect(seen.any_foreign_customer).toBe(0)
    expect(seen.any_foreign_branch).toBe(0)
  })

  it('a cross-tenant INSERT is refused by the policy, and nothing lands', async () => {
    const rogueId = fakeCuid()
    let thrown: Error | undefined
    try {
      await asTenant(A.orgId, () =>
        app.query(
          `INSERT INTO "Customer" ("id","organizationId","userId","qrToken","firstName","lastName")
           VALUES ($1, $2, $3, $4, 'Rogue', 'Insert')`,
          [rogueId, B.orgId, spareUserId, fakeCuid()]
        )
      )
    } catch (error) {
      thrown = error as Error
    }
    console.log('[runtime-role-rls] cross-tenant INSERT:', thrown?.message)
    expect(thrown).toBeDefined()
    expect(thrown!.message).toMatch(/row-level security/i)
    // Checked from the owner connection, so an RLS-filtered read cannot be
    // mistaken for a blocked write.
    const landed = await rawPrisma.customer.findUnique({ where: { id: rogueId } })
    expect(landed).toBeNull()
  })

  it('a cross-tenant UPDATE by primary key affects zero rows and changes nothing', async () => {
    const before = await rawPrisma.customer.findUniqueOrThrow({ where: { id: B.customerId } })
    const affected = await asTenant(A.orgId, async () => {
      const r = await app.query(`UPDATE "Customer" SET "firstName" = 'HACKED' WHERE "id" = $1`, [
        B.customerId,
      ])
      return r.rowCount
    })
    console.log('[runtime-role-rls] cross-tenant UPDATE rowCount:', affected)
    // Zero rows, not an exception: the row is invisible to the UPDATE's USING
    // filter, so there is nothing to update. Asserting the count is what
    // distinguishes "blocked" from "error silently swallowed".
    expect(affected).toBe(0)
    const after = await rawPrisma.customer.findUniqueOrThrow({ where: { id: B.customerId } })
    expect(after.firstName).toBe(before.firstName)
    expect(after.firstName).not.toBe('HACKED')
  })

  it('a cross-tenant DELETE by primary key affects zero rows and the row survives', async () => {
    const affected = await asTenant(A.orgId, async () => {
      const r = await app.query(`DELETE FROM "Customer" WHERE "id" = $1`, [B.customerId])
      return r.rowCount
    })
    console.log('[runtime-role-rls] cross-tenant DELETE rowCount:', affected)
    expect(affected).toBe(0)
    const survives = await rawPrisma.customer.findUnique({ where: { id: B.customerId } })
    expect(survives).not.toBeNull()
  })

  it('a tenant cannot relocate one of its own rows into another tenant', async () => {
    // The WITH CHECK side of the same policy: USING passes (the row is A's), but
    // the *new* row would belong to B and must be refused.
    let thrown: Error | undefined
    try {
      await asTenant(A.orgId, () =>
        app.query(`UPDATE "Customer" SET "organizationId" = $1 WHERE "id" = $2`, [
          B.orgId,
          A.customerId,
        ])
      )
    } catch (error) {
      thrown = error as Error
    }
    expect(thrown).toBeDefined()
    expect(thrown!.message).toMatch(/row-level security/i)
    const unchanged = await rawPrisma.customer.findUniqueOrThrow({ where: { id: A.customerId } })
    expect(unchanged.organizationId).toBe(A.orgId)
  })

  it('a well-formed but nonexistent tenant id sees zero rows', async () => {
    const ghost = fakeCuid()
    const seen = await asTenant(ghost, async () => {
      const r = await app.query<{ setting: string; customers: number }>(
        `SELECT current_setting('app.current_tenant_id', true) AS setting,
                (SELECT count(*)::int FROM "Customer")          AS customers`
      )
      return r.rows[0]
    })
    expect(seen.setting).toBe(ghost)
    expect(seen.customers).toBe(0)
  })

  it('the runtime role CAN still do its own tenant\'s work (not a blanket deny)', async () => {
    // The control that proves every rejection above is the policy talking, and
    // not a missing grant that would break the application outright.
    const okId = fakeCuid()
    const result = await asTenant(A.orgId, async () => {
      const upd = await app.query(`UPDATE "Customer" SET "notes" = 'own-write-ok' WHERE "id" = $1`, [
        A.customerId,
      ])
      const ins = await app.query(
        `INSERT INTO "Customer" ("id","organizationId","userId","qrToken","firstName","lastName")
         VALUES ($1, $2, $3, $4, 'Control', 'Insert')`,
        [okId, A.orgId, spareUserId, fakeCuid()]
      )
      const read = await app.query<{ count: number }>(
        `SELECT count(*)::int AS count FROM "Customer" WHERE "organizationId" = $1`,
        [A.orgId]
      )
      const del = await app.query(`DELETE FROM "Customer" WHERE "id" = $1`, [okId])
      return { upd: upd.rowCount, ins: ins.rowCount, visible: read.rows[0].count, del: del.rowCount }
    })
    console.log('[runtime-role-rls] same-tenant CRUD:', result)
    expect(result.upd).toBe(1)
    expect(result.ins).toBe(1)
    expect(result.visible).toBe(2)
    expect(result.del).toBe(1)
    const persisted = await rawPrisma.customer.findUniqueOrThrow({ where: { id: A.customerId } })
    expect(persisted.notes).toBe('own-write-ok')
  })

  it('privileges deliberately withheld from the runtime role are actually withheld', async () => {
    // TRUNCATE would empty a tenant-scoped table wholesale, and RLS does not
    // apply to TRUNCATE at all — Postgres gates it on the privilege alone. So
    // the grant being absent is itself a security property worth pinning.
    let thrown: Error | undefined
    await app.query('BEGIN')
    try {
      await app.query(`TRUNCATE "Customer"`)
    } catch (error) {
      thrown = error as Error
    }
    await app.query('ROLLBACK')
    console.log('[runtime-role-rls] TRUNCATE attempt:', thrown?.message)
    expect(thrown).toBeDefined()
    expect(thrown!.message).toMatch(/permission denied/i)
  })
})

// -----------------------------------------------------------------------------
// Task 9 security hardening, Part B — the Supabase Data API's reach into public.
// -----------------------------------------------------------------------------
describe('the Supabase Data API roles have no access to public (Part B)', () => {
  const DATA_API_ROLES = ['anon', 'authenticated'] as const

  it('anon and authenticated hold no privilege on any public table', async () => {
    const rows = await rawPrisma.$queryRawUnsafe<
      { grantee: string; privilege_type: string; tables: number }[]
    >(
      `SELECT grantee, privilege_type, count(DISTINCT table_name)::int AS tables
         FROM information_schema.role_table_grants
        WHERE table_schema = 'public' AND grantee IN ('anon','authenticated')
        GROUP BY grantee, privilege_type ORDER BY grantee, privilege_type`
    )
    console.log('[runtime-role-rls] anon/authenticated grants on public:', rows)
    // Before the Part B revoke this returned 14 rows: all of
    // SELECT/INSERT/UPDATE/DELETE/TRUNCATE/REFERENCES/TRIGGER on all 29 tables,
    // for both roles — including `User`.`passwordHash`, on a table with no RLS.
    expect(rows).toEqual([])
  })

  it('a read attempt as those roles is denied by Postgres, including on the no-RLS tables', async () => {
    // This is the authorization decision PostgREST itself makes: it resolves an
    // incoming `apikey` to one of these roles and then issues plain SQL. If the
    // role cannot read the table, the Data API cannot serve it.
    const NO_RLS_TABLES = ['User', 'Organization', 'Subscription', 'AuditLog', '_prisma_migrations']
    for (const role of DATA_API_ROLES) {
      for (const table of NO_RLS_TABLES) {
        let thrown: Error | undefined
        try {
          await rawPrisma.$transaction(async (tx) => {
            await tx.$executeRawUnsafe(`SET LOCAL ROLE ${role}`)
            await tx.$queryRawUnsafe(`SELECT count(*)::int FROM "${table}"`)
          })
        } catch (error) {
          thrown = error as Error
        }
        expect(thrown, `${role} could still read "${table}"`).toBeDefined()
        // TWO acceptable denial shapes, and which one appears got STRICTER in
        // Part D. Under Part B alone the roles kept schema-level USAGE on
        // `public` (granted to the pseudo-role PUBLIC, which
        // `REVOKE ... FROM anon, authenticated` could not remove), so the table
        // resolved and Postgres refused on the table grant:
        //     ERROR: permission denied for table "User"
        // Part D's `REVOKE USAGE ON SCHEMA public FROM PUBLIC` removes the
        // schema from their search path entirely, so the name no longer resolves
        // at all and the refusal arrives one step earlier:
        //     ERROR 42P01: relation "User" does not exist
        // Both are hard denials and the second is strictly stronger — the role
        // cannot even establish that the table exists. Accepting either keeps
        // this assertion about the security outcome rather than about which
        // layer of Postgres says no. What is NOT accepted is a successful read.
        expect(thrown!.message, `${role} on "${table}"`).toMatch(
          /permission denied|does not exist/i
        )
      }
    }
  })

  it('and the denial is now the stronger, schema-level one for every no-RLS table (Part D)', async () => {
    // Pinned separately so the strengthening above cannot silently regress to
    // the weaker "permission denied for table" shape — which is what would
    // happen if anything re-granted `USAGE ON SCHEMA public` to PUBLIC or to
    // these roles by name. The two-shape tolerance in the previous test exists
    // to keep it robust; this test is the one that says which shape is current.
    const rows = await rawPrisma.$queryRawUnsafe<{ rolname: string; usage: boolean }[]>(
      `SELECT rolname, has_schema_privilege(rolname, 'public', 'USAGE') AS usage
         FROM pg_roles WHERE rolname IN ('anon','authenticated') ORDER BY rolname`
    )
    console.log('[runtime-role-rls] Data API roles, schema public USAGE:', rows)
    expect(rows.map((r) => r.usage)).toEqual([false, false])
  })

  it('future migrations will not silently re-grant to them (default privileges)', async () => {
    // Supabase ships `postgres` with default privileges that hand anon and
    // authenticated the full set on every newly created table. Without the
    // ALTER DEFAULT PRIVILEGES ... REVOKE, the next CREATE TABLE would undo the
    // revoke above without anyone noticing.
    const rows = await rawPrisma.$queryRawUnsafe<{ acl: string }[]>(
      `SELECT d.defaclacl::text AS acl FROM pg_default_acl d
         JOIN pg_namespace n ON n.oid = d.defaclnamespace
        WHERE n.nspname = 'public' AND d.defaclobjtype = 'r'
          AND pg_get_userbyid(d.defaclrole) = 'postgres'`
    )
    console.log('[runtime-role-rls] postgres default table ACL for public:', rows)
    expect(rows.length).toBe(1)
    expect(rows[0].acl).not.toMatch(/\banon=/)
    expect(rows[0].acl).not.toMatch(/\bauthenticated=/)
    // And the runtime role's own default grant is present, so new tables stay
    // reachable by the application: `arwd` = INSERT/SELECT/UPDATE/DELETE, with
    // no `D` (TRUNCATE), `x` (REFERENCES) or `t` (TRIGGER).
    expect(rows[0].acl).toMatch(/app_runtime=arwd\//)
  })

  it('Supabase Storage grants live in their own schema and were not touched', async () => {
    // Spec §7 plans a SupabaseStorageProvider. Storage is a separate service
    // whose tables live in the `storage` schema with independently granted ACLs,
    // so a public-schema-only revoke cannot affect it. Asserted, not assumed.
    const rows = await rawPrisma.$queryRawUnsafe<{ grantee: string; tables: number }[]>(
      `SELECT grantee, count(DISTINCT table_name)::int AS tables
         FROM information_schema.role_table_grants
        WHERE table_schema = 'storage' AND grantee IN ('anon','authenticated')
        GROUP BY grantee ORDER BY grantee`
    )
    console.log('[runtime-role-rls] storage-schema grants (untouched):', rows)
    expect(rows.length).toBe(2)
    for (const r of rows) expect(r.tables).toBeGreaterThan(0)
  })
})
