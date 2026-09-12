import { describe, it, expect, afterAll } from 'vitest'
import { prisma } from '@/db/client'
import { rawPrisma } from '@/db/raw-client'
import { withTenantContext } from '@/server/tenant/context'

// ---------------------------------------------------------------------------
// This is Task 9's baseline TDD test, implemented from the task brief's Step 3.
//
// ONE DELIBERATE DEVIATION FROM THE BRIEF'S LITERAL CODE, in the first test.
//
// The brief writes the cross-tenant read as:
//
//     const visibleToA = await withTenantContext(orgA.id, (tx) => tx.customer.findMany())
//     expect(visibleToA.every((c) => c.organizationId === orgA.id)).toBe(true)
//
// That assertion cannot hold on this database as written, and the reason is
// exactly the caveat the brief itself raises at the end: the role this suite
// connects as is Supabase's `postgres`, which is both the owner of every table
// in `public` AND holds rolbypassrls = true (measured — see the task report).
// A BYPASSRLS role is exempt from every RLS policy, and FORCE ROW LEVEL
// SECURITY cannot override that; it is a hard Postgres invariant. So an
// unfiltered `tx.customer.findMany()` issued by that role returns every
// organization's customers, and `.every(...)` is false the moment the table
// holds more than one tenant's rows — which it does (100+ rows from Tasks 3-8's
// schema tests).
//
// Rather than weaken the assertion (e.g. adding a `where` clause, which would
// prove only that Prisma can filter, not that Postgres isolates), the read is
// issued under `SET LOCAL ROLE app_runtime` — the role RLS actually applies to.
// `SET LOCAL ROLE` is transaction-scoped and reverts at COMMIT/ROLLBACK, so it
// leaks nothing to the connection pool.
//
// WHY `app_runtime` AND NOT `authenticated` (security hardening, Parts A and B).
//
// This constant used to read `SET LOCAL ROLE authenticated`, a stock Supabase
// role that happened to be non-owner, non-BYPASSRLS and fully DML-privileged on
// `public` — a convenient stand-in. Two changes retired it:
//
//   Part A provisioned `app_runtime`, a real, purpose-built application role
//   (NOSUPERUSER, NOBYPASSRLS, non-owner, ordinary CRUD only), and pointed
//   DATABASE_URL at it. So the honest instrument is no longer a stand-in at
//   all: it is the role the application genuinely connects as.
//
//   Part B revoked every privilege `anon` and `authenticated` held on `public`,
//   because those are Supabase's PostgREST Data API roles and this project uses
//   Auth.js with Prisma instead — they were an unauthenticated read path to
//   `User`.`passwordHash`. `authenticated` therefore now gets "permission denied"
//   rather than an RLS-filtered result, which would make these tests assert the
//   wrong thing.
//
// tests/db/rls-security.test.ts carries the full adversarial suite built on the
// same technique, and tests/db/runtime-role-rls.test.ts proves the property
// end-to-end over a connection opened with the real runtime DATABASE_URL, with
// no SET ROLE at all.
// ---------------------------------------------------------------------------

/** See the note above: downgrades the transaction to a role RLS actually applies to. */
const ENFORCE_RLS = 'SET LOCAL ROLE app_runtime'

describe('withTenantContext', () => {
  afterAll(async () => {
    await prisma.$disconnect()
  })

  it('only returns rows belonging to the active tenant, for both the write and the read', async () => {
    const orgA = await prisma.organization.create({ data: { name: 'A', slug: `a-${Date.now()}` } })
    const orgB = await prisma.organization.create({ data: { name: 'B', slug: `b-${Date.now()}` } })
    const userA = await prisma.user.create({
      data: { email: `ua-${Date.now()}@test.com`, passwordHash: 'x', type: 'CUSTOMER', name: 'User A' },
    })
    const userB = await prisma.user.create({
      data: { email: `ub-${Date.now()}@test.com`, passwordHash: 'x', type: 'CUSTOMER', name: 'User B' },
    })

    // Writes go through withTenantContext too — there is no other way to create a
    // Customer row at all, since prisma.customer is blocked (Task 2).
    await withTenantContext(orgA.id, (tx) =>
      tx.customer.create({ data: { organizationId: orgA.id, userId: userA.id, firstName: 'A', lastName: 'A' } })
    )
    await withTenantContext(orgB.id, (tx) =>
      tx.customer.create({ data: { organizationId: orgB.id, userId: userB.id, firstName: 'B', lastName: 'B' } })
    )

    const visibleToA = await withTenantContext(orgA.id, async (tx) => {
      await tx.$executeRawUnsafe(ENFORCE_RLS)
      return tx.customer.findMany()
    })
    expect(visibleToA.length).toBeGreaterThan(0)
    expect(visibleToA.every((c) => c.organizationId === orgA.id)).toBe(true)
    expect(visibleToA.some((c) => c.organizationId === orgB.id)).toBe(false)
    // Explicit timeout: this test makes ~7 sequential round trips (2 orgs, 2
    // users, 2 tenant-context writes, 1 tenant-context read) against a live,
    // remote Supabase pooler, where a single round trip costs hundreds of
    // milliseconds — that exceeds vitest's 5s default on a cold connection, and
    // was observed to do so when the whole suite runs. Matches the 30s pattern
    // already used in tests/db/rbac-schema.test.ts and
    // tests/db/tenant-access-boundary.test.ts.
  }, 30_000)

  it('cannot be bypassed: prisma.customer throws before any query runs', () => {
    expect(() => (prisma as unknown as { customer: unknown }).customer).toThrow()
  })

  it('sets a real, verifiable Postgres session variable inside the transaction', async () => {
    const org = await prisma.organization.create({ data: { name: 'Session Var Test', slug: `svt-${Date.now()}` } })
    const observed = await withTenantContext(org.id, async (tx) => {
      const rows = await tx.$queryRawUnsafe<{ current_setting: string }[]>(
        `SELECT current_setting('app.current_tenant_id', true)`
      )
      return rows[0].current_setting
    })
    expect(observed).toBe(org.id)
    // Outside any withTenantContext transaction the setting reverts — SET LOCAL is
    // transaction-scoped by design, so a later unrelated transaction never inherits it.
    const afterCommit = await rawPrisma.$queryRawUnsafe<{ current_setting: string }[]>(
      `SELECT current_setting('app.current_tenant_id', true)`
    )
    expect(afterCommit[0].current_setting).not.toBe(org.id)
  }, 30_000)

  it('accepts Prisma $transaction options so a slow callback can outlive the 5s default', async () => {
    const org = await prisma.organization.create({
      data: { name: 'Tx Timeout Test', slug: `txt-${Date.now()}` },
    })

    // Prisma's interactive-transaction default `timeout` is 5000ms. A callback
    // that deliberately sleeps 7s therefore cannot complete on the default, and
    // can on a raised one. Both halves are asserted, so the test proves the new
    // parameter is actually wired through rather than merely accepted.
    const started = Date.now()
    const observed = await withTenantContext(
      org.id,
      async (tx) => {
        await tx.$executeRawUnsafe(`SELECT pg_sleep(7)`)
        const rows = await tx.$queryRawUnsafe<{ current_setting: string }[]>(
          `SELECT current_setting('app.current_tenant_id', true)`
        )
        return rows[0].current_setting
      },
      { maxWait: 30_000, timeout: 60_000 }
    )
    const elapsed = Date.now() - started
    expect(observed).toBe(org.id)
    expect(elapsed).toBeGreaterThan(5_000)

    // The control: the identical callback with no options must fail on the
    // stock 5s budget, with Prisma's transaction-timeout error (P2028).
    let thrown: Error | undefined
    try {
      await withTenantContext(org.id, async (tx) => {
        await tx.$executeRawUnsafe(`SELECT pg_sleep(7)`)
        return 'should not get here'
      })
    } catch (error) {
      thrown = error as Error
    }
    console.log('[tenant-context] default-timeout error:', thrown?.message.split('\n').slice(-2).join(' | '))
    expect(thrown).toBeDefined()
    expect(thrown!.message).toMatch(/transaction|P2028|timeout/i)
  }, 120_000)
})
