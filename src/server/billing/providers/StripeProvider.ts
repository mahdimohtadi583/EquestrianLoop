import type Stripe from 'stripe'
import type { PaymentProvider, NormalizedBillingEvent, ProviderChargeResult } from '../PaymentProvider'

const STATUS_MAP: Record<string, 'ACTIVE' | 'PAST_DUE' | 'CANCELED' | 'UNPAID'> = {
  active: 'ACTIVE',
  past_due: 'PAST_DUE',
  canceled: 'CANCELED',
  unpaid: 'UNPAID',
  incomplete: 'UNPAID',
  incomplete_expired: 'CANCELED',
}

export class StripeProvider implements PaymentProvider {
  constructor(private readonly stripe: Stripe, private readonly webhookSecret: string) {}

  async createCustomer(input: { organizationId: string; name: string; email: string }): Promise<string> {
    const customer = await this.stripe.customers.create({
      name: input.name,
      email: input.email,
      metadata: { organizationId: input.organizationId },
    })
    return customer.id
  }

  async createCheckoutSession(input: {
    organizationId: string
    providerCustomerId: string
    planId: string
    successUrl: string
    cancelUrl: string
  }): Promise<string> {
    const session = await this.stripe.checkout.sessions.create({
      mode: 'subscription',
      customer: input.providerCustomerId,
      line_items: [{ price: input.planId, quantity: 1 }],
      success_url: input.successUrl,
      cancel_url: input.cancelUrl,
      subscription_data: { metadata: { organizationId: input.organizationId } },
    })
    if (!session.url) throw new Error('Stripe did not return a checkout URL')
    return session.url
  }

  async cancelSubscription(providerSubscriptionId: string): Promise<void> {
    await this.stripe.subscriptions.cancel(providerSubscriptionId)
  }

  async createOneOffCharge(input: {
    providerCustomerId: string
    amount: number
    currency: string
    metadata: Record<string, string>
  }): Promise<ProviderChargeResult> {
    const intent = await this.stripe.paymentIntents.create({
      amount: Math.round(input.amount * 100),
      currency: input.currency,
      customer: input.providerCustomerId,
      metadata: input.metadata,
      confirm: true,
      automatic_payment_methods: { enabled: true, allow_redirects: 'never' },
    })
    return {
      providerChargeId: intent.id,
      status: intent.status === 'succeeded' ? 'SUCCEEDED' : intent.status === 'requires_payment_method' ? 'FAILED' : 'PENDING',
    }
  }

  verifyAndParseWebhookEvent(rawBody: string, signature: string): NormalizedBillingEvent {
    const event = this.stripe.webhooks.constructEvent(rawBody, signature, this.webhookSecret)
    if (event.type === 'customer.subscription.created' || event.type === 'customer.subscription.updated') {
      const sub = event.data.object as Stripe.Subscription
      // Stripe moved the billing-period fields off `Subscription` onto each
      // `SubscriptionItem` (flexible billing mode). This app's checkout session
      // always creates exactly one line item per subscription (one plan per
      // organization), so the first item's period end is the subscription's.
      const currentPeriodEnd = sub.items.data[0].current_period_end
      return {
        type: 'subscription.updated',
        organizationId: sub.metadata.organizationId,
        providerSubscriptionId: sub.id,
        status: STATUS_MAP[sub.status] ?? 'UNPAID',
        currentPeriodEnd: new Date(currentPeriodEnd * 1000),
      }
    }
    if (event.type === 'customer.subscription.deleted') {
      const sub = event.data.object as Stripe.Subscription
      return { type: 'subscription.canceled', organizationId: sub.metadata.organizationId, providerSubscriptionId: sub.id }
    }
    throw new Error(`Unhandled Stripe event type: ${event.type}`)
  }
}
