import { describe, it, expect, beforeEach, vi, afterAll } from 'vitest'
import { prisma } from '@/db/client'
import { withTenantContext } from '@/server/tenant/context'
import {
  createCheckoutSession,
  createBillingPortalSession,
  cancelSubscription,
} from '@/server/billing/payment-actions'

/**
 * Task 15: Payment Server Actions Tests
 *
 * Tests server actions for payment flows:
 * 1. createCheckoutSession(planId) - staff initiates for customer
 * 2. createBillingPortalSession() - customer opens billing portal
 * 3. cancelSubscription(subscriptionId) - cancel at period end
 *
 * All actions:
 * - Use getSessionOrRedirect() + role guards
 * - Use restricted proxy for DB access
 * - Return typed results { success, data?, error? }
 * - Mock Stripe API, use live DB for DB parts
 */

vi.setConfig({ testTimeout: 30_000 })

// Mock Stripe client
vi.mock('stripe', () => {
  const mockStripe = {
    checkout: {
      sessions: {
        create: vi.fn(),
      },
    },
    billingPortal: {
      sessions: {
        create: vi.fn(),
      },
    },
    subscriptions: {
      cancel: vi.fn(),
    },
  }
  return { default: vi.fn(() => mockStripe) }
})

import Stripe from 'stripe'
import { auth } from '@/server/auth/config'

vi.mock('@/server/auth/config', () => ({
  auth: vi.fn(),
}))

describe('Payment Server Actions', () => {
  afterAll(async () => {
    await prisma.$disconnect()
  })

  describe('createCheckoutSession', () => {
    it('creates a Stripe checkout session for a membership plan', async () => {
      // Setup: logged-in staff user, organization, customer, membership plan
      const org = await prisma.organization.create({
        data: { name: `Checkout Org ${Date.now()}`, slug: `checkout-${Date.now()}` },
      })
      const staffUser = await prisma.user.create({
        data: {
          email: `staff-${Date.now()}@test.com`,
          passwordHash: 'x',
          type: 'STAFF',
          name: 'Staff User',
        },
      })
      const customerUser = await prisma.user.create({
        data: {
          email: `customer-${Date.now()}@test.com`,
          passwordHash: 'x',
          type: 'CUSTOMER',
          name: 'Customer User',
        },
      })

      // Create subscription for org
      const subscription = await prisma.subscription.create({
        data: {
          organizationId: org.id,
          provider: 'stripe',
          providerCustomerId: 'cus_123',
          planId: 'price_123',
          status: 'ACTIVE',
        },
      })

      // Create customer
      const customer = await withTenantContext(org.id, (tx) =>
        tx.customer.create({
          data: { organizationId: org.id, userId: customerUser.id, firstName: 'C', lastName: 'U' },
        })
      )

      // Create membership plan
      const plan = await withTenantContext(org.id, (tx) =>
        tx.membershipPlan.create({
          data: {
            organizationId: org.id,
            name: 'Checkout Plan',
            price: 99.99,
            durationValue: 1,
            durationUnit: 'MONTHLY',
          },
        })
      )

      // Mock Stripe checkout session creation
      vi.mocked(auth).mockResolvedValueOnce({
        user: { id: staffUser.id, type: 'STAFF' },
      } as any)

      const mockStripe = vi.mocked(require('stripe').default())
      ;(mockStripe.checkout.sessions.create as any).mockResolvedValueOnce({
        url: 'https://checkout.stripe.com/pay/abc123',
        id: 'cs_123',
      })

      // Call server action
      const result = await createCheckoutSession(
        org.id,
        customer.id,
        plan.id,
        'https://example.com/success',
        'https://example.com/cancel'
      )

      // Verify result
      expect(result.success).toBe(true)
      expect(result.data).toBeDefined()
      expect(result.data?.checkoutUrl).toContain('https://checkout.stripe.com')
    })

    it('returns error if user is not staff', async () => {
      // Mock non-staff user session
      vi.mocked(auth).mockResolvedValueOnce({
        user: { id: 'customer-123', type: 'CUSTOMER' },
      } as any)

      // Call action - should fail because not staff
      const result = await createCheckoutSession('org-1', 'cust-1', 'plan-1', '', '')

      expect(result.success).toBe(false)
      expect(result.error).toContain('staff')
    })

    it('returns error if not authenticated', async () => {
      // Mock no session
      vi.mocked(auth).mockResolvedValueOnce(null as any)

      const result = await createCheckoutSession('org-1', 'cust-1', 'plan-1', '', '')

      expect(result.success).toBe(false)
      expect(result.error).toBeDefined()
    })
  })

  describe('createBillingPortalSession', () => {
    it('creates a Stripe billing portal session for a customer', async () => {
      // Setup: logged-in customer, organization, subscription
      const org = await prisma.organization.create({
        data: { name: `Portal Org ${Date.now()}`, slug: `portal-${Date.now()}` },
      })
      const customerUser = await prisma.user.create({
        data: {
          email: `portal-${Date.now()}@test.com`,
          passwordHash: 'x',
          type: 'CUSTOMER',
          name: 'Portal Customer',
        },
      })

      // Create subscription
      await prisma.subscription.create({
        data: {
          organizationId: org.id,
          provider: 'stripe',
          providerCustomerId: 'cus_portal_123',
          planId: 'price_123',
          status: 'ACTIVE',
        },
      })

      // Create customer
      const customer = await withTenantContext(org.id, (tx) =>
        tx.customer.create({
          data: { organizationId: org.id, userId: customerUser.id, firstName: 'P', lastName: 'C' },
        })
      )

      // Mock auth
      vi.mocked(auth).mockResolvedValueOnce({
        user: { id: customerUser.id, type: 'CUSTOMER' },
      } as any)

      const mockStripe = vi.mocked(require('stripe').default())
      ;(mockStripe.billingPortal.sessions.create as any).mockResolvedValueOnce({
        url: 'https://billing.stripe.com/session/xyz789',
      })

      // Call server action
      const result = await createBillingPortalSession(org.id, 'https://example.com/return')

      // Verify result
      expect(result.success).toBe(true)
      expect(result.data?.portalUrl).toContain('https://billing.stripe.com')
    })

    it('returns error if user is not customer', async () => {
      // Mock staff user
      vi.mocked(auth).mockResolvedValueOnce({
        user: { id: 'staff-123', type: 'STAFF' },
      } as any)

      const result = await createBillingPortalSession('org-1', '')

      expect(result.success).toBe(false)
      expect(result.error).toContain('customer')
    })
  })

  describe('cancelSubscription', () => {
    it('cancels a Stripe subscription at period end', async () => {
      const org = await prisma.organization.create({
        data: { name: `Cancel Org ${Date.now()}`, slug: `cancel-${Date.now()}` },
      })

      // Create subscription
      const subscription = await prisma.subscription.create({
        data: {
          organizationId: org.id,
          provider: 'stripe',
          providerCustomerId: 'cus_cancel_123',
          providerSubscriptionId: 'sub_cancel_123',
          planId: 'price_123',
          status: 'ACTIVE',
        },
      })

      // Mock staff user
      vi.mocked(auth).mockResolvedValueOnce({
        user: { id: 'staff-123', type: 'STAFF' },
      } as any)

      const mockStripe = vi.mocked(require('stripe').default())
      ;(mockStripe.subscriptions.cancel as any).mockResolvedValueOnce({
        id: 'sub_cancel_123',
        status: 'active',
        cancel_at_period_end: true,
      })

      // Call server action
      const result = await cancelSubscription(subscription.providerSubscriptionId!, true)

      // Verify result
      expect(result.success).toBe(true)

      // Verify Stripe was called
      expect(mockStripe.subscriptions.cancel).toHaveBeenCalledWith('sub_cancel_123', {
        invoice_now: false,
      })
    })

    it('returns error if not staff', async () => {
      // Mock customer user
      vi.mocked(auth).mockResolvedValueOnce({
        user: { id: 'cust-123', type: 'CUSTOMER' },
      } as any)

      const result = await cancelSubscription('sub_123', false)

      expect(result.success).toBe(false)
      expect(result.error).toContain('staff')
    })
  })
})
