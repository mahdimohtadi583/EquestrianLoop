import { prisma } from '@/db/client'
import type { PaymentProvider, NormalizedBillingEvent } from './PaymentProvider'

export class BillingService {
  constructor(private readonly provider: PaymentProvider, private readonly providerName: string) {}

  async startSubscription(organizationId: string, planId: string, successUrl: string, cancelUrl: string) {
    const org = await prisma.organization.findUniqueOrThrow({ where: { id: organizationId } })
    let subscription = await prisma.subscription.findUnique({ where: { organizationId } })

    const providerCustomerId =
      subscription?.providerCustomerId ??
      (await this.provider.createCustomer({
        organizationId,
        name: org.name,
        email: `billing+${org.slug}@equestrianloop.app`,
      }))

    if (!subscription) {
      subscription = await prisma.subscription.create({
        data: { organizationId, provider: this.providerName, providerCustomerId, planId, status: 'INCOMPLETE' },
      })
    }

    return this.provider.createCheckoutSession({ organizationId, providerCustomerId, planId, successUrl, cancelUrl })
  }

  async applyWebhookEvent(event: NormalizedBillingEvent) {
    if (event.type === 'subscription.updated') {
      await prisma.subscription.update({
        where: { organizationId: event.organizationId },
        data: {
          status: event.status,
          providerSubscriptionId: event.providerSubscriptionId,
          currentPeriodEnd: event.currentPeriodEnd,
        },
      })
    } else if (event.type === 'subscription.canceled') {
      await prisma.subscription.update({ where: { organizationId: event.organizationId }, data: { status: 'CANCELED' } })
    }
  }

  async isOrganizationActive(organizationId: string): Promise<boolean> {
    const sub = await prisma.subscription.findUnique({ where: { organizationId } })
    return sub?.status === 'ACTIVE'
  }
}
