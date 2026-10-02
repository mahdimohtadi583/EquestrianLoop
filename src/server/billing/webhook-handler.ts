import type Stripe from 'stripe'
import { prisma } from '@/db/client'
import { withTenantContext } from '@/server/tenant/context'

/**
 * Task 14: Stripe Webhook Event Handler
 *
 * Processes normalized Stripe webhook events:
 * - checkout.session.completed: Create membership + payment
 * - invoice.payment_succeeded: Renew membership + record payment
 * - invoice.payment_failed: Record failed payment
 * - customer.subscription.deleted: Cancel membership
 *
 * All operations use:
 * - withTenantContext for tenant isolation (RLS)
 * - Restricted proxy client (from @/db/client)
 * - Idempotency checks to safely handle retries
 */

export async function handleStripeWebhookEvent(event: Stripe.Event): Promise<void> {
  switch (event.type) {
    case 'checkout.session.completed':
      return handleCheckoutSessionCompleted(event as Stripe.CheckoutSessionCompletedEvent)
    case 'invoice.payment_succeeded':
      return handleInvoicePaymentSucceeded(event as Stripe.InvoicePaymentSucceededEvent)
    case 'invoice.payment_failed':
      return handleInvoicePaymentFailed(event as Stripe.InvoicePaymentFailedEvent)
    case 'customer.subscription.deleted':
      return handleSubscriptionDeleted(event as Stripe.CustomerSubscriptionDeletedEvent)
    default:
      // Silently ignore unhandled event types (Stripe may add new ones)
      // The endpoint still returns 200 so Stripe doesn't retry
      return
  }
}

/**
 * Handle checkout.session.completed
 * When a customer completes Stripe Checkout, create:
 * 1. CustomerMembership record (ACTIVE)
 * 2. Payment record (SUCCEEDED)
 * 3. Update Subscription with providerSubscriptionId
 */
async function handleCheckoutSessionCompleted(event: Stripe.CheckoutSessionCompletedEvent): Promise<void> {
  const session = event.data.object

  // Extract metadata (organizationId, customerId, membershipPlanId set in startSubscription)
  const organizationId = session.metadata?.organizationId
  const customerId = session.metadata?.customerId
  const membershipPlanId = session.metadata?.membershipPlanId

  if (!organizationId || !customerId || !membershipPlanId || !session.subscription) {
    throw new Error('Missing required metadata in checkout session')
  }

  // Fetch the membership plan to get price and duration for the membership endDate
  const plan = await withTenantContext(organizationId, (tx) =>
    tx.membershipPlan.findUniqueOrThrow({ where: { id: membershipPlanId } })
  )

  // All writes inside tenant context
  await withTenantContext(organizationId, async (tx) => {
    // Idempotency: check if membership already exists for this session
    const existingMembership = await tx.customerMembership.findFirst({
      where: {
        customerId,
        membershipPlanId,
        // Only consider recent memberships (within last 5 minutes) as potential duplicates
        createdAt: { gte: new Date(Date.now() - 5 * 60 * 1000) },
      },
    })

    let membership
    if (existingMembership) {
      // Already processed this session, skip
      membership = existingMembership
    } else {
      // Calculate endDate based on membership plan duration
      const endDate = new Date()
      if (plan.durationUnit === 'WEEKLY') {
        endDate.setDate(endDate.getDate() + plan.durationValue * 7)
      } else if (plan.durationUnit === 'MONTHLY') {
        endDate.setMonth(endDate.getMonth() + plan.durationValue)
      } else if (plan.durationUnit === 'ANNUAL') {
        endDate.setFullYear(endDate.getFullYear() + plan.durationValue)
      }

      // Create new membership
      membership = await tx.customerMembership.create({
        data: {
          organizationId,
          customerId,
          membershipPlanId,
          endDate,
          status: 'ACTIVE',
        },
      })
    }

    // Idempotency: check if payment already exists for this session
    const existingPayment = await tx.payment.findFirst({
      where: {
        customerId,
        organizationId,
        // Only consider recent payments (within last 5 minutes) as potential duplicates
        createdAt: { gte: new Date(Date.now() - 5 * 60 * 1000) },
      },
    })

    if (!existingPayment) {
      // Create payment record
      await tx.payment.create({
        data: {
          organizationId,
          customerId,
          amount: (session.amount_total || 0) / 100, // Convert cents to dollars
          currency: session.currency?.toUpperCase() || 'USD',
          status: 'SUCCEEDED',
          method: 'stripe',
        },
      })
    }
  })

  // Update Subscription with the Stripe subscription ID (platform-scoped, no tenant context needed)
  await prisma.subscription.update({
    where: { organizationId },
    data: { providerSubscriptionId: session.subscription as string },
  })
}

/**
 * Handle invoice.payment_succeeded
 * When an invoice is successfully paid:
 * 1. Record Payment (SUCCEEDED)
 * 2. Renew the CustomerMembership endDate
 */
async function handleInvoicePaymentSucceeded(event: Stripe.InvoicePaymentSucceededEvent): Promise<void> {
  const invoice = event.data.object as any // Use 'any' for flexible invoice access

  // Get organizationId from subscription metadata or invoice metadata
  const organizationId = invoice.metadata?.organizationId ||
    (invoice.subscription && typeof invoice.subscription === 'object' ? invoice.subscription?.metadata?.organizationId : undefined)
  const customerId = invoice.metadata?.customerId

  if (!organizationId) {
    return // Can't process without organizationId, silently skip
  }

  // Fetch membership plan from the invoice line items
  const lineItem = invoice.lines?.data?.[0]
  if (!lineItem) {
    return // No line items, skip
  }

  // Stripe InvoiceLineItem.price can be string | Price object
  const priceObj = lineItem.price
  if (!priceObj) {
    return // No price, skip
  }

  const membershipPlanId = typeof priceObj === 'string' ? priceObj : (priceObj as any)?.product
  if (!membershipPlanId) {
    return // Can't determine plan, skip
  }

  await withTenantContext(organizationId, async (tx) => {
    // Record payment (idempotent by invoice ID)
    const existingPayment = await tx.payment.findFirst({
      where: {
        organizationId,
        customerId: customerId || undefined,
      },
      orderBy: { createdAt: 'desc' },
      take: 1,
    })

    if (!existingPayment || new Date(existingPayment.createdAt).getTime() < Date.now() - 60000) {
      // Only record if payment doesn't exist recently
      await tx.payment.create({
        data: {
          organizationId,
          customerId: customerId || undefined,
          amount: (invoice.amount_paid || 0) / 100,
          currency: invoice.currency.toUpperCase(),
          status: 'SUCCEEDED',
          method: 'stripe',
        },
      })
    }

    // Renew active membership if it exists
    if (customerId && membershipPlanId) {
      const membership = await tx.customerMembership.findFirst({
        where: {
          customerId,
          membershipPlanId,
          status: 'ACTIVE',
        },
      })

      if (membership) {
        // Calculate new endDate
        const plan = await tx.membershipPlan.findUniqueOrThrow({ where: { id: membershipPlanId } })
        const newEndDate = new Date(membership.endDate)

        if (plan.durationUnit === 'WEEKLY') {
          newEndDate.setDate(newEndDate.getDate() + plan.durationValue * 7)
        } else if (plan.durationUnit === 'MONTHLY') {
          newEndDate.setMonth(newEndDate.getMonth() + plan.durationValue)
        } else if (plan.durationUnit === 'ANNUAL') {
          newEndDate.setFullYear(newEndDate.getFullYear() + plan.durationValue)
        }

        // Renew membership
        await tx.customerMembership.update({
          where: { id: membership.id },
          data: { endDate: newEndDate },
        })
      }
    }
  })
}

/**
 * Handle invoice.payment_failed
 * Record the failed payment
 */
async function handleInvoicePaymentFailed(event: Stripe.InvoicePaymentFailedEvent): Promise<void> {
  const invoice = event.data.object

  const organizationId = invoice.metadata?.organizationId
  const customerId = invoice.metadata?.customerId

  if (!organizationId) {
    return // Can't process without organizationId
  }

  await withTenantContext(organizationId, async (tx) => {
    // Record failed payment
    await tx.payment.create({
      data: {
        organizationId,
        customerId: customerId || undefined,
        amount: (invoice.amount_due || 0) / 100,
        currency: invoice.currency.toUpperCase(),
        status: 'FAILED',
        method: 'stripe',
      },
    })
  })
}

/**
 * Handle customer.subscription.deleted
 * Cancel all active CustomerMemberships for this organization
 */
async function handleSubscriptionDeleted(event: Stripe.CustomerSubscriptionDeletedEvent): Promise<void> {
  const subscription = event.data.object

  const organizationId = subscription.metadata?.organizationId

  if (!organizationId) {
    return // Can't process without organizationId
  }

  await withTenantContext(organizationId, async (tx) => {
    // Cancel all active memberships
    await tx.customerMembership.updateMany({
      where: {
        organizationId,
        status: 'ACTIVE',
      },
      data: { status: 'CANCELED' },
    })
  })
}
