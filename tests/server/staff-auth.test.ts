import { describe, it, expect, afterAll, vi } from 'vitest'
import { prisma } from '@/db/client'
import { withTenantContext } from '@/server/tenant/context'
import { createStaffAccount } from '@/server/actions/staff-auth'
import { verifyCredentials } from '@/server/auth/credentials'

// This test round-trips the live Supabase pooler ~6 times (org create, role
// create, user/staff/membership create inside withTenantContext, a follow-up
// tenant-context read, plus bcrypt hashing at cost 12 in createStaffAccount
// and verifyCredentials) and reliably exceeds vitest's 5000ms default. Other
// live-DB suites in this repo (tests/db/fk-tenant-matching.test.ts,
// tests/db/runtime-role-rls.test.ts, tests/db/scalar-tenant-matching.test.ts)
// hit the same issue and raise the timeout the same way.
vi.setConfig({ testTimeout: 30_000 })

describe('createStaffAccount', () => {
  afterAll(async () => {
    await prisma.$disconnect()
  })

  it('creates a User, Staff, and Membership row, and the account can then log in', async () => {
    const org = await prisma.organization.create({
      data: { name: 'Staff Auth Test', slug: `staff-auth-${Date.now()}` },
    })
    const role = await withTenantContext(org.id, (tx) => tx.role.create({ data: { organizationId: org.id, name: 'OWNER' } }))
    const email = `owner-${Date.now()}@test.com`

    const { userId, staffId } = await createStaffAccount({
      organizationId: org.id, email, password: 'owner-password-1', name: 'Org Owner', roleId: role.id,
    })

    expect(userId).toBeTruthy()
    expect(staffId).toBeTruthy()

    const membership = await withTenantContext(org.id, (tx) =>
      tx.membership.findUniqueOrThrow({ where: { userId_organizationId: { userId, organizationId: org.id } } })
    )
    expect(membership.roleId).toBe(role.id)

    const loggedIn = await verifyCredentials(email, 'owner-password-1')
    expect(loggedIn?.id).toBe(userId)
  })
})
