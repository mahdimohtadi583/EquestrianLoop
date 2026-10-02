'use server'

import { prisma } from '@/db/client'
import { sendEmail } from '@/server/notifications/notification-service'
import { rateLimit } from '@/server/rate-limit/rate-limiter'
import crypto from 'crypto'

/**
 * Task 30: Email Verification
 *
 * Server actions for email verification flows:
 * 1. sendVerificationEmail(userId) - generate token, send email
 * 2. verifyEmail(token) - validate token, set emailVerified
 * 3. resendVerificationEmail(userId) - rate-limited resend
 *
 * Note: Rate limiting and token generation are handled here
 * Tokens are hashed before storage, raw token sent to user
 */

function generateToken(): string {
  return crypto.randomBytes(32).toString('hex')
}

function hashToken(token: string): string {
  return crypto.createHash('sha256').update(token).digest('hex')
}

export async function sendVerificationEmail(userId: string): Promise<{
  success: boolean
  error?: string
}> {
  try {
    const user = await prisma.user.findUnique({
      where: { id: userId },
    })

    if (!user) {
      return { success: false, error: 'User not found' }
    }

    if (user.emailVerified) {
      return { success: false, error: 'Email already verified' }
    }

    // Generate token
    const rawToken = generateToken()
    const hashedToken = hashToken(rawToken)
    const expiryTime = new Date()
    expiryTime.setHours(expiryTime.getHours() + 24) // 24 hour expiry

    // Update user with token
    await prisma.user.update({
      where: { id: userId },
      data: {
        verificationToken: hashedToken,
        verificationTokenExpiry: expiryTime,
      },
    })

    // Send email
    const verifyLink = `${process.env.NEXTAUTH_URL}/verify-email?token=${rawToken}`
    const html = `
      <h1>Verify Your Email</h1>
      <p>Please verify your email address to activate your account.</p>
      <p><a href="${verifyLink}">Click here to verify your email</a></p>
      <p>Or copy this link: ${verifyLink}</p>
      <p>This link expires in 24 hours.</p>
    `

    return sendEmail(user.email, 'Verify Your Email Address', html)
  } catch (err) {
    return {
      success: false,
      error: err instanceof Error ? err.message : 'Failed to send verification email',
    }
  }
}

export async function verifyEmail(token: string): Promise<{
  success: boolean
  error?: string
}> {
  try {
    if (!token) {
      return { success: false, error: 'Token is required' }
    }

    const hashedToken = hashToken(token)
    const now = new Date()

    // Find user with matching token
    const user = await prisma.user.findFirst({
      where: {
        verificationToken: hashedToken,
        verificationTokenExpiry: {
          gt: now, // Token must not be expired
        },
      },
    })

    if (!user) {
      return { success: false, error: 'Invalid or expired verification token' }
    }

    // Mark email as verified
    await prisma.user.update({
      where: { id: user.id },
      data: {
        emailVerified: now,
        verificationToken: null,
        verificationTokenExpiry: null,
      },
    })

    return { success: true }
  } catch (err) {
    return {
      success: false,
      error: err instanceof Error ? err.message : 'Failed to verify email',
    }
  }
}

export async function resendVerificationEmail(userId: string): Promise<{
  success: boolean
  error?: string
}> {
  try {
    // Rate limit: 3 attempts per hour per userId
    const rateLimitResult = await rateLimit(userId, 3, 3600)
    if (!rateLimitResult.success) {
      const minutesRemaining = Math.ceil((rateLimitResult.resetAt.getTime() - Date.now()) / 60000)
      return { success: false, error: `Too many attempts. Try again in ${minutesRemaining} minutes.` }
    }

    const user = await prisma.user.findUnique({
      where: { id: userId },
    })

    if (!user) {
      return { success: false, error: 'User not found' }
    }

    if (user.emailVerified) {
      return { success: false, error: 'Email already verified' }
    }

    return sendVerificationEmail(userId)
  } catch (err) {
    return {
      success: false,
      error: err instanceof Error ? err.message : 'Failed to resend verification email',
    }
  }
}
