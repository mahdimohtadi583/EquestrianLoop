import { describe, it, expect, afterAll } from 'vitest'
import { prisma } from '@/db/client'
import { BillingService } from '@/server/billing/BillingService'
import type { PaymentProvider } from '@/server/billing/PaymentProvider'

function fakeProvider(overrides: Partial<PaymentProvider> = {}): PaymentProvider {
  return {
    createCustomer: async () => 'cus_fake',
    createCheckoutSession: async () => 'https://fake.checkout/session',
    cancelSubscription: async () => {},
    createOneOffCharge: async () => ({ providerChargeId: 'ch_fake', status: 'SUCCEEDED' }),
    verifyAndParseWebhookEvent: () => {
      throw new Error('not used in this test')
    },
    ...overrides,
  }
}

describe('BillingService', () => {
  afterAll(async () => {
    await prisma.$disconnect()
  })

  it('creates a Subscription row in INCOMPLETE status when starting a subscription', async () => {
    const org = await prisma.organization.create({ data: { name: 'Billing Test', slug: `billing-${Date.now()}` } })
    const service = new BillingService(fakeProvider(), 'stripe')

    await service.startSubscription(org.id, 'price_basic', 'https://x/success', 'https://x/cancel')

    const sub = await prisma.subscription.findUniqueOrThrow({ where: { organizationId: org.id } })
    expect(sub.status).toBe('INCOMPLETE')
    expect(sub.provider).toBe('stripe')
  })

  it('flips a subscription to ACTIVE when a subscription.updated event arrives', async () => {
    const org = await prisma.organization.create({ data: { name: 'Billing Test 2', slug: `billing2-${Date.now()}` } })
    const service = new BillingService(fakeProvider(), 'stripe')
    await service.startSubscription(org.id, 'price_basic', 'https://x/success', 'https://x/cancel')

    await service.applyWebhookEvent({
      type: 'subscription.updated', organizationId: org.id, providerSubscriptionId: 'sub_fake',
      status: 'ACTIVE', currentPeriodEnd: new Date(),
    })

    expect(await service.isOrganizationActive(org.id)).toBe(true)
  })

  it('gates access when the subscription has never gone active', async () => {
    const org = await prisma.organization.create({ data: { name: 'Billing Test 3', slug: `billing3-${Date.now()}` } })
    expect(await new BillingService(fakeProvider(), 'stripe').isOrganizationActive(org.id)).toBe(false)
  })
})
