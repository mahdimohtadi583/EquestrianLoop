import { NextRequest, NextResponse } from 'next/server'
import Stripe from 'stripe'
import { handleStripeWebhookEvent } from '@/server/billing/webhook-handler'

/**
 * Task 14: Webhook Handler (dynamic)
 *
 * POST /api/webhooks/[provider]
 *
 * Handles Stripe webhooks for checkout, invoices, and subscriptions.
 * Uses the new handleStripeWebhookEvent which supports:
 * - checkout.session.completed
 * - invoice.payment_succeeded
 * - invoice.payment_failed
 * - customer.subscription.deleted
 */

// Mark as dynamic to prevent static generation
export const dynamic = 'force-dynamic'

export async function POST(req: NextRequest, { params }: { params: Promise<{ provider: string }> }) {
  const { provider } = await params
  if (provider !== 'stripe') {
    return NextResponse.json({ error: 'Unknown payment provider' }, { status: 404 })
  }

  const signature = req.headers.get('stripe-signature')
  if (!signature) {
    return NextResponse.json({ error: 'Missing stripe-signature header' }, { status: 400 })
  }

  const rawBody = await req.text()
  const stripe = new Stripe(process.env.STRIPE_SECRET_KEY!)
  const webhookSecret = process.env.STRIPE_WEBHOOK_SECRET!

  try {
    const event = stripe.webhooks.constructEvent(rawBody, signature, webhookSecret)
    await handleStripeWebhookEvent(event)
    return NextResponse.json({ received: true })
  } catch (err) {
    const message = err instanceof Error ? err.message : 'Unknown error'
    console.error(`Webhook error for provider ${provider}: ${message}`)
    return NextResponse.json({ error: message }, { status: 400 })
  }
}
