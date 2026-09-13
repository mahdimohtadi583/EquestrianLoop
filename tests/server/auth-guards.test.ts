import { describe, it, expect, afterAll, vi } from 'vitest'
import { prisma } from '@/db/client'
// Test fixtures for tenant-scoped models (Role, Membership, Customer) go through
// withTenantContext, same as application code would — see Task 9.
import { withTenantContext } from '@/server/tenant/context'
import { requirePermission, requireCustomer } from '@/server/auth/guards'

vi.mock('@/server/auth/config', () => ({
  auth: vi.fn(),
}))

import { auth } from '@/server/auth/config'

// This file round-trips the live Supabase pooler several times per test
// (org/user/permission fixtures plus withTenantContext writes and reads) and
// reliably exceeds vitest's 5000ms default under full-suite parallel load.
// Same fix already applied in tests/server/staff-auth.test.ts,
// tests/server/customer-auth.test.ts, and the other live-DB suites here.
vi.setConfig({ testTimeout: 30_000 })

describe('requirePermission', () => {
  afterAll(async () => {
    await prisma.$disconnect()
  })

  it('resolves for a staff member whose role has the permission', async () => {
    const org = await prisma.organization.create({ data: { name: 'Guard Test', slug: `guard-${Date.now()}` } })
    const permission = await prisma.permission.upsert({
      where: { key: 'bookings.manage' }, update: {}, create: { key: 'bookings.manage', description: 'x' },
    })
    const user = await prisma.user.create({
      data: { email: `guard-${Date.now()}@test.com`, passwordHash: 'x', type: 'STAFF', name: 'Guard User' },
    })
    await withTenantContext(org.id, async (tx) => {
      const role = await tx.role.create({ data: { organizationId: org.id, name: 'FRONT_DESK' } })
      await tx.rolePermission.create({ data: { roleId: role.id, permissionId: permission.id } })
      await tx.membership.create({ data: { userId: user.id, organizationId: org.id, roleId: role.id } })
    })

    vi.mocked(auth).mockResolvedValue({ user: { id: user.id } } as never)

    const result = await requirePermission(org.id, 'bookings.manage')
    expect(result.userId).toBe(user.id)
  })

  it('throws for a staff member whose role lacks the permission', async () => {
    const org = await prisma.organization.create({ data: { name: 'Guard Test 2', slug: `guard2-${Date.now()}` } })
    const user = await prisma.user.create({
      data: { email: `guard2-${Date.now()}@test.com`, passwordHash: 'x', type: 'STAFF', name: 'Guard User 2' },
    })
    await withTenantContext(org.id, async (tx) => {
      const role = await tx.role.create({ data: { organizationId: org.id, name: 'TRAINER' } })
      await tx.membership.create({ data: { userId: user.id, organizationId: org.id, roleId: role.id } })
    })

    vi.mocked(auth).mockResolvedValue({ user: { id: user.id } } as never)

    await expect(requirePermission(org.id, 'bookings.manage')).rejects.toThrow()
  })

  it('throws for a customer even if they happen to know a permission string', async () => {
    const org = await prisma.organization.create({ data: { name: 'Guard Test 3', slug: `guard3-${Date.now()}` } })
    const user = await prisma.user.create({
      data: { email: `guard3-${Date.now()}@test.com`, passwordHash: 'x', type: 'CUSTOMER', name: 'Customer Guard' },
    })
    await withTenantContext(org.id, (tx) =>
      tx.customer.create({ data: { organizationId: org.id, userId: user.id, firstName: 'C', lastName: 'G' } })
    )

    vi.mocked(auth).mockResolvedValue({ user: { id: user.id } } as never)

    await expect(requirePermission(org.id, 'bookings.manage')).rejects.toThrow()
  })
})

describe('requireCustomer', () => {
  it('resolves for a customer of that organization', async () => {
    const org = await prisma.organization.create({ data: { name: 'Guard Test 4', slug: `guard4-${Date.now()}` } })
    const user = await prisma.user.create({
      data: { email: `guard4-${Date.now()}@test.com`, passwordHash: 'x', type: 'CUSTOMER', name: 'Customer Four' },
    })
    const customer = await withTenantContext(org.id, (tx) =>
      tx.customer.create({ data: { organizationId: org.id, userId: user.id, firstName: 'C', lastName: 'F' } })
    )

    vi.mocked(auth).mockResolvedValue({ user: { id: user.id } } as never)

    const result = await requireCustomer(org.id)
    expect(result.customerId).toBe(customer.id)
  })

  it('throws for a staff member (never grants customer-portal access to staff)', async () => {
    const org = await prisma.organization.create({ data: { name: 'Guard Test 5', slug: `guard5-${Date.now()}` } })
    const user = await prisma.user.create({
      data: { email: `guard5-${Date.now()}@test.com`, passwordHash: 'x', type: 'STAFF', name: 'Staff Five' },
    })
    await withTenantContext(org.id, async (tx) => {
      const role = await tx.role.create({ data: { organizationId: org.id, name: 'OWNER' } })
      await tx.membership.create({ data: { userId: user.id, organizationId: org.id, roleId: role.id } })
    })

    vi.mocked(auth).mockResolvedValue({ user: { id: user.id } } as never)

    await expect(requireCustomer(org.id)).rejects.toThrow()
  })
})
