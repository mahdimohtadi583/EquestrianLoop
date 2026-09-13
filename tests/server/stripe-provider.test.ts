import { describe, it, expect, vi } from 'vitest'
import type Stripe from 'stripe'
import { StripeProvider } from '@/server/billing/providers/StripeProvider'

function fakeStripe(overrides: Partial<Stripe> = {}) {
  return {
    checkout: { sessions: { create: vi.fn() } },
    customers: { create: vi.fn() },
    subscriptions: { cancel: vi.fn() },
    paymentIntents: { create: vi.fn() },
    webhooks: { constructEvent: vi.fn() },
    ...overrides,
  } as unknown as Stripe
}

describe('StripeProvider', () => {
  it('never sets a trial period when creating a checkout session', async () => {
    const stripe = fakeStripe()
    ;(stripe.checkout.sessions.create as ReturnType<typeof vi.fn>).mockResolvedValue({ url: 'https://checkout.stripe.com/x' })
    const provider = new StripeProvider(stripe, 'whsec_test')

    await provider.createCheckoutSession({
      organizationId: 'org_1', providerCustomerId: 'cus_1', planId: 'price_1',
      successUrl: 'https://x/success', cancelUrl: 'https://x/cancel',
    })

    const callArgs = (stripe.checkout.sessions.create as ReturnType<typeof vi.fn>).mock.calls[0][0]
    expect(callArgs.subscription_data?.trial_period_days).toBeUndefined()
    expect(callArgs.mode).toBe('subscription')
  })

  it('maps an active Stripe subscription webhook to a normalized ACTIVE event', () => {
    const stripe = fakeStripe()
    ;(stripe.webhooks.constructEvent as ReturnType<typeof vi.fn>).mockReturnValue({
      type: 'customer.subscription.updated',
      data: {
        object: {
          id: 'sub_1',
          status: 'active',
          items: { data: [{ current_period_end: 1_700_000_000 }] },
          metadata: { organizationId: 'org_1' },
        },
      },
    })
    const provider = new StripeProvider(stripe, 'whsec_test')

    const event = provider.verifyAndParseWebhookEvent('{}', 'sig')

    expect(event).toEqual({
      type: 'subscription.updated', organizationId: 'org_1', providerSubscriptionId: 'sub_1',
      status: 'ACTIVE', currentPeriodEnd: new Date(1_700_000_000 * 1000),
    })
  })
})
