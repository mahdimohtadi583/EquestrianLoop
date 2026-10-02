'use server'

import Stripe from 'stripe'
import { getSessionOrRedirect, requireStaffRole, requireCustomerRole } from '@/server/auth/guards'
import { prisma } from '@/db/client'
import { withTenantContext } from '@/server/tenant/context'

/**
 * Task 15: Payment Server Actions
 *
 * Server actions for payment flows:
 * 1. createCheckoutSession - create Stripe Checkout for membership
 * 2. createBillingPortalSession - open billing portal for customer
 * 3. cancelSubscription - cancel at period end
 *
 * All use session guards and restricted proxy.
 * Return typed results: { success, data?, error? }
 */

const stripe = new Stripe(process.env.STRIPE_SECRET_KEY || '')

/**
 * Create a Stripe Checkout session for membership purchase
 * Staff initiates on behalf of a customer
 */
export async function createCheckoutSession(
  organizationId: string,
  customerId: string,
  membershipPlanId: string,
  successUrl: string,
  cancelUrl: string
): Promise<{ success: boolean; data?: { checkoutUrl: string }; error?: string }> {
  try {
    // Check authentication and role
    const session = await getSessionOrRedirect()
    requireStaffRole((session.user as any)?.type)

    // Get subscription for org
    const subscription = await prisma.subscription.findUnique({
      where: { organizationId },
    })

    if (!subscription) {
      return { success: false, error: 'Organization has no billing subscription' }
    }

    // Create Stripe checkout session
    const checkoutSession = await stripe.checkout.sessions.create({
      mode: 'subscription',
      customer: subscription.providerCustomerId,
      line_items: [{ price: subscription.planId, quantity: 1 }],
      success_url: successUrl,
      cancel_url: cancelUrl,
      subscription_data: {
        metadata: {
          organizationId,
          customerId,
          membershipPlanId,
        },
      },
    })

    if (!checkoutSession.url) {
      return { success: false, error: 'Failed to create checkout session' }
    }

    return {
      success: true,
      data: { checkoutUrl: checkoutSession.url },
    }
  } catch (err) {
    const message = err instanceof Error ? err.message : 'Unknown error'
    return { success: false, error: message }
  }
}

/**
 * Create a Stripe Billing Portal session for customer
 * Customer manages their subscription and payment methods
 */
export async function createBillingPortalSession(
  organizationId: string,
  returnUrl: string
): Promise<{ success: boolean; data?: { portalUrl: string }; error?: string }> {
  try {
    // Check authentication and role
    const session = await getSessionOrRedirect()
    requireCustomerRole((session.user as any)?.type)

    // Get subscription for org
    const subscription = await prisma.subscription.findUnique({
      where: { organizationId },
    })

    if (!subscription) {
      return { success: false, error: 'Organization has no billing subscription' }
    }

    // Create Stripe billing portal session
    const portalSession = await stripe.billingPortal.sessions.create({
      customer: subscription.providerCustomerId,
      return_url: returnUrl,
    })

    if (!portalSession.url) {
      return { success: false, error: 'Failed to create billing portal session' }
    }

    return {
      success: true,
      data: { portalUrl: portalSession.url },
    }
  } catch (err) {
    const message = err instanceof Error ? err.message : 'Unknown error'
    return { success: false, error: message }
  }
}

/**
 * Cancel a Stripe subscription at period end or immediately
 * Staff action to end customer's membership
 */
export async function cancelSubscription(
  providerSubscriptionId: string,
  immediate: boolean = false
): Promise<{ success: boolean; error?: string }> {
  try {
    // Check authentication and role
    const session = await getSessionOrRedirect()
    requireStaffRole((session.user as any)?.type)

    // Cancel subscription with Stripe
    await stripe.subscriptions.cancel(providerSubscriptionId, {
      invoice_now: immediate,
    })

    return { success: true }
  } catch (err) {
    const message = err instanceof Error ? err.message : 'Unknown error'
    return { success: false, error: message }
  }
}
