import { describe, it, expect, afterAll } from 'vitest'
import { prisma } from '@/db/client'
import { assertOrganizationActive, OrganizationInactiveError } from '@/server/billing/guards'

describe('assertOrganizationActive', () => {
  afterAll(async () => {
    await prisma.$disconnect()
  })

  it('throws OrganizationInactiveError when there is no subscription at all', async () => {
    const org = await prisma.organization.create({ data: { name: 'Gate Test', slug: `gate-${Date.now()}` } })
    await expect(assertOrganizationActive(org.id)).rejects.toThrow(OrganizationInactiveError)
  })

  it('throws when the subscription exists but is not ACTIVE', async () => {
    const org = await prisma.organization.create({ data: { name: 'Gate Test 2', slug: `gate2-${Date.now()}` } })
    await prisma.subscription.create({
      data: { organizationId: org.id, provider: 'stripe', providerCustomerId: 'cus_x', planId: 'price_x', status: 'PAST_DUE' },
    })
    await expect(assertOrganizationActive(org.id)).rejects.toThrow(OrganizationInactiveError)
  })

  it('resolves silently when ACTIVE', async () => {
    const org = await prisma.organization.create({ data: { name: 'Gate Test 3', slug: `gate3-${Date.now()}` } })
    await prisma.subscription.create({
      data: { organizationId: org.id, provider: 'stripe', providerCustomerId: 'cus_y', planId: 'price_y', status: 'ACTIVE' },
    })
    await expect(assertOrganizationActive(org.id)).resolves.toBeUndefined()
  })
})
