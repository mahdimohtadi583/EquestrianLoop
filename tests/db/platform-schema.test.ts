import { describe, it, expect, afterAll } from 'vitest'
import { prisma } from '@/db/client'

describe('platform-level schema', () => {
  afterAll(async () => {
    await prisma.$disconnect()
  })

  it('creates an organization with default customerSelfBookingEnabled=false', async () => {
    const org = await prisma.organization.create({
      data: { name: 'Test Stables', slug: `test-stables-${Date.now()}` },
    })
    expect(org.customerSelfBookingEnabled).toBe(false)
    expect(org.status).toBe('ACTIVE')
  })

  it('enforces one subscription per organization via unique organizationId', async () => {
    const org = await prisma.organization.create({
      data: { name: 'Sub Test', slug: `sub-test-${Date.now()}` },
    })
    await prisma.subscription.create({
      data: {
        organizationId: org.id,
        provider: 'stripe',
        providerCustomerId: 'cus_test',
        planId: 'plan_basic',
      },
    })
    await expect(
      prisma.subscription.create({
        data: {
          organizationId: org.id,
          provider: 'stripe',
          providerCustomerId: 'cus_test_2',
          planId: 'plan_basic',
        },
      })
    ).rejects.toThrow()
  })
})
