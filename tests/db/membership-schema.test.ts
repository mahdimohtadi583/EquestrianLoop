import { describe, it, expect, afterAll } from 'vitest'
// See the note in Task 3's rbac-schema.test.ts: schema-verification tests use
// rawPrisma directly, aliased to `prisma` so assertions below read naturally.
import { rawPrisma as prisma } from '@/db/raw-client'

describe('membership plan schema', () => {
  afterAll(async () => {
    await prisma.$disconnect()
  })

  it('prevents a customer from having two ACTIVE memberships at once', async () => {
    const org = await prisma.organization.create({
      data: { name: 'Membership Plan Test', slug: `mp-test-${Date.now()}` },
    })
    const user = await prisma.user.create({
      data: { email: `mp-${Date.now()}@test.com`, passwordHash: 'x', type: 'CUSTOMER', name: 'Plan Holder' },
    })
    const customer = await prisma.customer.create({
      data: { organizationId: org.id, userId: user.id, firstName: 'Plan', lastName: 'Holder' },
    })
    const plan = await prisma.membershipPlan.create({
      data: {
        organizationId: org.id, name: 'Gold', price: 100,
        durationValue: 1, durationUnit: 'MONTHLY', maxSessions: 8,
      },
    })
    const now = new Date()
    const inAMonth = new Date(now.getTime() + 30 * 24 * 3600_000)

    await prisma.customerMembership.create({
      data: { organizationId: org.id, customerId: customer.id, membershipPlanId: plan.id, endDate: inAMonth },
    })

    await expect(
      prisma.customerMembership.create({
        data: { organizationId: org.id, customerId: customer.id, membershipPlanId: plan.id, endDate: inAMonth },
      })
    ).rejects.toThrow()
  })

  it('allows a second CustomerMembership once the first is no longer ACTIVE', async () => {
    const org = await prisma.organization.create({
      data: { name: 'Membership Plan Test 2', slug: `mp-test2-${Date.now()}` },
    })
    const user = await prisma.user.create({
      data: { email: `mp2-${Date.now()}@test.com`, passwordHash: 'x', type: 'CUSTOMER', name: 'Plan Holder 2' },
    })
    const customer = await prisma.customer.create({
      data: { organizationId: org.id, userId: user.id, firstName: 'Plan', lastName: 'Two' },
    })
    const plan = await prisma.membershipPlan.create({
      data: {
        organizationId: org.id, name: 'Silver', price: 50,
        durationValue: 1, durationUnit: 'MONTHLY',
      },
    })
    const inAMonth = new Date(Date.now() + 30 * 24 * 3600_000)

    const first = await prisma.customerMembership.create({
      data: { organizationId: org.id, customerId: customer.id, membershipPlanId: plan.id, endDate: inAMonth },
    })
    await prisma.customerMembership.update({ where: { id: first.id }, data: { status: 'EXPIRED' } })

    const second = await prisma.customerMembership.create({
      data: { organizationId: org.id, customerId: customer.id, membershipPlanId: plan.id, endDate: inAMonth },
    })
    expect(second.status).toBe('ACTIVE')

    const history = await prisma.customerMembership.findMany({ where: { customerId: customer.id } })
    expect(history).toHaveLength(2)
  })
})
