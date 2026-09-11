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
// exactly the caveat the brief itself raises at the end: the role behind
// DATABASE_URL is Supabase's `postgres`, which is both the owner of every table
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
// issued under `SET LOCAL ROLE authenticated`. `authenticated` is a stock
// Supabase role that is NOT the table owner and does NOT hold BYPASSRLS, while
// holding full DML privileges on `public` — so the policies actually apply, and
// the brief's assertion then tests precisely what it was written to test.
// `SET LOCAL ROLE` is transaction-scoped and reverts at COMMIT/ROLLBACK, so it
// leaks nothing to the connection pool.
//
// tests/db/rls-security.test.ts carries the full adversarial suite built on the
// same technique, including the evidence for the role-privilege claim above.
// ---------------------------------------------------------------------------

/** See the note above: downgrades the transaction to a role RLS actually applies to. */
const ENFORCE_RLS = 'SET LOCAL ROLE authenticated'

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
  })

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
  })
})
