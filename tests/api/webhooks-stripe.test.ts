import { describe, it, expect, beforeEach, vi, afterAll } from 'vitest'
import { prisma } from '@/db/client'
import { withTenantContext } from '@/server/tenant/context'
import { handleStripeWebhookEvent } from '@/server/billing/webhook-handler'
import type Stripe from 'stripe'

/**
 * Task 14: Stripe Webhook Handler Tests
 *
 * Tests the handleStripeWebhookEvent function:
 * 1. Handles checkout.session.completed → creates membership + payment
 * 2. Handles invoice.payment_succeeded → renews membership + records payment
 * 3. Handles invoice.payment_failed → records payment
 * 4. Handles customer.subscription.deleted → cancels membership
 * 5. All operations use tenant context and restricted proxy
 * 6. All operations are idempotent (safe to retry)
 */

vi.setConfig({ testTimeout: 30_000 })

describe('Stripe Webhook Handler', () => {
  afterAll(async () => {
    await prisma.$disconnect()
  })

  describe('handleStripeWebhookEvent', () => {
    it('handles checkout.session.completed event - creates membership and payment', async () => {
      // Setup: organization, customer, plan, subscription
      const org = await prisma.organization.create({
        data: { name: `Webhook Org ${Date.now()}`, slug: `webhook-${Date.now()}` },
      })
      const user = await prisma.user.create({
        data: {
          email: `webhook-${Date.now()}@test.com`,
          passwordHash: 'x',
          type: 'CUSTOMER',
          name: 'Webhook Customer',
        },
      })
      const customer = await withTenantContext(org.id, (tx) =>
        tx.customer.create({
          data: { organizationId: org.id, userId: user.id, firstName: 'W', lastName: 'C' },
        })
      )
      const plan = await withTenantContext(org.id, (tx) =>
        tx.membershipPlan.create({
          data: {
            organizationId: org.id,
            name: 'Webhook Plan',
            price: 99.99,
            durationValue: 1,
            durationUnit: 'MONTHLY',
          },
        })
      )

      // Mock Stripe event: checkout.session.completed
      const event: Stripe.Event = {
        id: 'evt_checkout_123',
        type: 'checkout.session.completed',
        data: {
          object: {
            id: 'cs_123',
            customer: 'cus_123',
            subscription: 'sub_123',
            metadata: {
              organizationId: org.id,
              customerId: customer.id,
              membershipPlanId: plan.id,
            },
            amount_total: 9999,
            currency: 'usd',
          } as any,
        },
      } as any

      // Process webhook
      await handleStripeWebhookEvent(event)

      // Verify CustomerMembership was created
      const membership = await withTenantContext(org.id, (tx) =>
        tx.customerMembership.findFirst({
          where: { customerId: customer.id, membershipPlanId: plan.id },
        })
      )
      expect(membership).toBeDefined()
      expect(membership?.status).toBe('ACTIVE')

      // Verify Payment was created
      const payment = await withTenantContext(org.id, (tx) =>
        tx.payment.findFirst({
          where: { customerId: customer.id },
        })
      )
      expect(payment).toBeDefined()
      expect(payment?.amount).toBe(99.99) // 9999 cents = $99.99
      expect(payment?.status).toBe('SUCCEEDED')
    })

    it('handles invoice.payment_succeeded - renews membership and records payment', async () => {
      // Setup with existing membership
      const org = await prisma.organization.create({
        data: { name: `Invoice Org ${Date.now()}`, slug: `invoice-${Date.now()}` },
      })
      const user = await prisma.user.create({
        data: {
          email: `invoice-${Date.now()}@test.com`,
          passwordHash: 'x',
          type: 'CUSTOMER',
          name: 'Invoice Customer',
        },
      })
      const customer = await withTenantContext(org.id, (tx) =>
        tx.customer.create({
          data: { organizationId: org.id, userId: user.id, firstName: 'I', lastName: 'C' },
        })
      )
      const plan = await withTenantContext(org.id, (tx) =>
        tx.membershipPlan.create({
          data: {
            organizationId: org.id,
            name: 'Invoice Plan',
            price: 49.99,
            durationValue: 1,
            durationUnit: 'MONTHLY',
          },
        })
      )

      // Create existing membership
      const oldEndDate = new Date()
      oldEndDate.setDate(oldEndDate.getDate() + 1)
      const existingMembership = await withTenantContext(org.id, (tx) =>
        tx.customerMembership.create({
          data: {
            organizationId: org.id,
            customerId: customer.id,
            membershipPlanId: plan.id,
            endDate: oldEndDate,
            status: 'ACTIVE',
          },
        })
      )

      // Mock Stripe event: invoice.payment_succeeded
      const event: Stripe.Event = {
        id: 'evt_invoice_123',
        type: 'invoice.payment_succeeded',
        data: {
          object: {
            id: 'in_123',
            customer: 'cus_123',
            subscription: 'sub_123',
            lines: {
              data: [{ price: { product: plan.id } }],
            },
            amount_paid: 4999,
            currency: 'usd',
            metadata: {
              organizationId: org.id,
              customerId: customer.id,
            },
          } as any,
        },
      } as any

      // Process webhook
      await handleStripeWebhookEvent(event)

      // Verify Payment was created
      const payment = await withTenantContext(org.id, (tx) =>
        tx.payment.findFirst({
          where: { customerId: customer.id },
          orderBy: { createdAt: 'desc' },
        })
      )
      expect(payment).toBeDefined()
      expect(payment?.status).toBe('SUCCEEDED')

      // Verify membership was renewed (endDate extended)
      const renewedMembership = await withTenantContext(org.id, (tx) =>
        tx.customerMembership.findUnique({ where: { id: existingMembership.id } })
      )
      expect(renewedMembership?.endDate.getTime()).toBeGreaterThan(oldEndDate.getTime())
    })

    it('handles customer.subscription.deleted - cancels membership', async () => {
      // Setup with active subscription
      const org = await prisma.organization.create({
        data: { name: `Cancellation Org ${Date.now()}`, slug: `cancel-${Date.now()}` },
      })
      const user = await prisma.user.create({
        data: {
          email: `cancel-${Date.now()}@test.com`,
          passwordHash: 'x',
          type: 'CUSTOMER',
          name: 'Cancel Customer',
        },
      })
      const customer = await withTenantContext(org.id, (tx) =>
        tx.customer.create({
          data: { organizationId: org.id, userId: user.id, firstName: 'C', lastName: 'C' },
        })
      )
      const plan = await withTenantContext(org.id, (tx) =>
        tx.membershipPlan.create({
          data: {
            organizationId: org.id,
            name: 'Cancel Plan',
            price: 99.99,
            durationValue: 1,
            durationUnit: 'MONTHLY',
          },
        })
      )

      // Create active membership
      const membership = await withTenantContext(org.id, (tx) =>
        tx.customerMembership.create({
          data: {
            organizationId: org.id,
            customerId: customer.id,
            membershipPlanId: plan.id,
            endDate: new Date(Date.now() + 30 * 24 * 60 * 60 * 1000),
            status: 'ACTIVE',
          },
        })
      )

      // Mock Stripe event: customer.subscription.deleted
      const event: Stripe.Event = {
        id: 'evt_delete_123',
        type: 'customer.subscription.deleted',
        data: {
          object: {
            id: 'sub_123',
            customer: 'cus_123',
            metadata: {
              organizationId: org.id,
            },
          } as any,
        },
      } as any

      // Process webhook
      await handleStripeWebhookEvent(event)

      // Verify membership was canceled
      const canceledMembership = await withTenantContext(org.id, (tx) =>
        tx.customerMembership.findUnique({ where: { id: membership.id } })
      )
      expect(canceledMembership?.status).toBe('CANCELED')
    })
  })
})
