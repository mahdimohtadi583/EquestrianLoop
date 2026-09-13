export type NormalizedBillingEvent =
  | { type: 'subscription.updated'; organizationId: string; providerSubscriptionId: string; status: 'ACTIVE' | 'PAST_DUE' | 'CANCELED' | 'UNPAID'; currentPeriodEnd: Date }
  | { type: 'subscription.canceled'; organizationId: string; providerSubscriptionId: string }

export interface ProviderChargeResult {
  providerChargeId: string
  status: 'SUCCEEDED' | 'PENDING' | 'FAILED'
}

export interface PaymentProvider {
  createCustomer(input: { organizationId: string; name: string; email: string }): Promise<string>
  createCheckoutSession(input: {
    organizationId: string
    providerCustomerId: string
    planId: string
    successUrl: string
    cancelUrl: string
  }): Promise<string>
  cancelSubscription(providerSubscriptionId: string): Promise<void>
  createOneOffCharge(input: {
    providerCustomerId: string
    amount: number
    currency: string
    metadata: Record<string, string>
  }): Promise<ProviderChargeResult>
  verifyAndParseWebhookEvent(rawBody: string, signature: string): NormalizedBillingEvent
}
