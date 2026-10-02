/**
 * Notification Service
 * Task 27: Email notifications for booking events
 *
 * Handles sending emails for:
 * - Booking confirmations
 * - Booking cancellations
 *
 * Uses Resend for email delivery (or mock in test environment)
 */

import { prisma } from '@/db/client'
import { withTenantContext } from '@/server/tenant/context'

// Mock email in test environment
const isTest = process.env.NODE_ENV === 'test'

// Only import Resend in production
let resend: any = null
if (!isTest) {
  try {
    const ResendModule = require('resend')
    resend = new ResendModule.Resend(process.env.RESEND_API_KEY)
  } catch (err) {
    console.error('Failed to initialize Resend:', err)
  }
}

const EMAIL_FROM = process.env.EMAIL_FROM || 'noreply@equestrianloop.com'

async function sendEmail(
  to: string,
  subject: string,
  html: string
): Promise<{ success: boolean; error?: string }> {
  try {
    // Mock email in test environment
    if (isTest) {
      console.log(`[TEST] Email to ${to}: ${subject}`)
      return { success: true }
    }

    // Send via Resend
    if (!resend) {
      return { success: false, error: 'Email service not configured' }
    }

    const result = await resend.emails.send({
      from: EMAIL_FROM,
      to,
      subject,
      html,
    })

    if (result.error) {
      return { success: false, error: result.error.message }
    }

    return { success: true }
  } catch (err) {
    return {
      success: false,
      error: err instanceof Error ? err.message : 'Failed to send email',
    }
  }
}

export async function sendBookingConfirmation(
  organizationId: string,
  bookingId: string
): Promise<{ success: boolean; error?: string }> {
  try {
    // Fetch booking details
    const booking = await withTenantContext(organizationId, (tx) =>
      tx.booking.findUnique({
        where: { id: bookingId },
        include: {
          customer: {
            include: {
              user: {
                select: {
                  email: true,
                  name: true,
                },
              },
            },
          },
          ridingSession: {
            include: {
              horse: {
                select: {
                  name: true,
                },
              },
              service: {
                select: {
                  name: true,
                  durationMinutes: true,
                },
              },
            },
          },
        },
      })
    )

    if (!booking || !booking.customer.user.email) {
      return { success: false, error: 'Booking or customer email not found' }
    }

    const sessionDate = new Date(booking.ridingSession.startsAt).toLocaleString()
    const html = `
      <h1>Booking Confirmation</h1>
      <p>Dear ${booking.customer.user.name},</p>
      <p>Your booking has been confirmed!</p>
      <h2>Booking Details</h2>
      <ul>
        <li><strong>Service:</strong> ${booking.ridingSession.service.name}</li>
        <li><strong>Horse:</strong> ${booking.ridingSession.horse?.name || 'Not assigned'}</li>
        <li><strong>Date & Time:</strong> ${sessionDate}</li>
        <li><strong>Duration:</strong> ${booking.ridingSession.service.durationMinutes} minutes</li>
        <li><strong>Status:</strong> ${booking.status}</li>
      </ul>
      <p>See you soon!</p>
    `

    return sendEmail(booking.customer.user.email, 'Booking Confirmation', html)
  } catch (err) {
    return {
      success: false,
      error: err instanceof Error ? err.message : 'Failed to send booking confirmation',
    }
  }
}

export async function sendBookingCancellation(
  organizationId: string,
  bookingId: string,
  reason?: string
): Promise<{ success: boolean; error?: string }> {
  try {
    // Fetch booking details
    const booking = await withTenantContext(organizationId, (tx) =>
      tx.booking.findUnique({
        where: { id: bookingId },
        include: {
          customer: {
            include: {
              user: {
                select: {
                  email: true,
                  name: true,
                },
              },
            },
          },
          ridingSession: {
            include: {
              horse: {
                select: {
                  name: true,
                },
              },
              service: {
                select: {
                  name: true,
                },
              },
            },
          },
        },
      })
    )

    if (!booking || !booking.customer.user.email) {
      return { success: false, error: 'Booking or customer email not found' }
    }

    const sessionDate = new Date(booking.ridingSession.startsAt).toLocaleString()
    const html = `
      <h1>Booking Cancelled</h1>
      <p>Dear ${booking.customer.user.name},</p>
      <p>Your booking has been cancelled.</p>
      <h2>Booking Details</h2>
      <ul>
        <li><strong>Service:</strong> ${booking.ridingSession.service.name}</li>
        <li><strong>Horse:</strong> ${booking.ridingSession.horse?.name || 'Not assigned'}</li>
        <li><strong>Date & Time:</strong> ${sessionDate}</li>
      </ul>
      ${reason ? `<p><strong>Reason:</strong> ${reason}</p>` : ''}
      <p>If you have questions, please contact us.</p>
    `

    return sendEmail(booking.customer.user.email, 'Booking Cancelled', html)
  } catch (err) {
    return {
      success: false,
      error: err instanceof Error ? err.message : 'Failed to send booking cancellation',
    }
  }
}
