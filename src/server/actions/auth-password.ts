'use server'

import { prisma } from '@/db/client'
import { hashPassword, verifyPassword } from '@/server/auth/password'
import { sendEmail } from '@/server/notifications/notification-service'
import { rateLimit } from '@/server/rate-limit/rate-limiter'
import { logAction } from '@/server/audit/audit-logger'
import crypto from 'crypto'

/**
 * Task 31: Password Reset
 *
 * Server actions for password reset flows:
 * 1. requestPasswordReset(email) - generate token, send email
 * 2. resetPassword(token, newPassword) - validate token, update password
 *
 * Security:
 * - Tokens are hashed before storage (SHA-256)
 * - 1-hour expiry prevents token reuse
 * - Returns success even if email not found (prevents enumeration)
 * - Password strength validation (8+ chars, 1 uppercase, 1 number)
 */

function generateToken(): string {
  return crypto.randomBytes(32).toString('hex')
}

function hashToken(token: string): string {
  return crypto.createHash('sha256').update(token).digest('hex')
}

function validatePasswordStrength(password: string): { valid: boolean; error?: string } {
  if (password.length < 8) {
    return { valid: false, error: 'Password must be at least 8 characters' }
  }

  if (!/[A-Z]/.test(password)) {
    return { valid: false, error: 'Password must contain at least one uppercase letter' }
  }

  if (!/\d/.test(password)) {
    return { valid: false, error: 'Password must contain at least one number' }
  }

  return { valid: true }
}

export async function requestPasswordReset(email: string): Promise<{
  success: boolean
  error?: string
}> {
  try {
    // Rate limit: 3 attempts per hour per email
    const rateLimitResult = await rateLimit(email, 3, 3600)
    if (!rateLimitResult.success) {
      const minutesRemaining = Math.ceil((rateLimitResult.resetAt.getTime() - Date.now()) / 60000)
      return { success: false, error: `Too many attempts. Try again in ${minutesRemaining} minutes.` }
    }

    const user = await prisma.user.findUnique({
      where: { email },
    })

    // SECURITY: Always return success, even if user not found (prevents enumeration)
    if (!user) {
      return { success: true }
    }

    // Generate token
    const rawToken = generateToken()
    const hashedToken = hashToken(rawToken)
    const expiryTime = new Date()
    expiryTime.setHours(expiryTime.getHours() + 1) // 1 hour expiry

    // Update user with token
    await prisma.user.update({
      where: { id: user.id },
      data: {
        resetToken: hashedToken,
        resetTokenExpiry: expiryTime,
      },
    })

    // Send reset email
    const resetLink = `${process.env.NEXTAUTH_URL}/reset-password?token=${rawToken}`
    const html = `
      <h1>Reset Your Password</h1>
      <p>You requested to reset your password. Click the link below to continue.</p>
      <p><a href="${resetLink}">Click here to reset your password</a></p>
      <p>Or copy this link: ${resetLink}</p>
      <p>This link expires in 1 hour.</p>
      <p>If you didn't request this, you can ignore this email.</p>
    `

    return sendEmail(user.email, 'Reset Your Password', html)
  } catch (err) {
    // Log error but still return success (user-facing message same regardless)
    console.error('Error requesting password reset:', err)
    return { success: true }
  }
}

export async function resetPassword(
  token: string,
  newPassword: string
): Promise<{
  success: boolean
  error?: string
}> {
  try {
    // Validate password strength
    const validation = validatePasswordStrength(newPassword)
    if (!validation.valid) {
      return { success: false, error: validation.error }
    }

    // Hash provided token
    const hashedToken = hashToken(token)
    const now = new Date()

    // Find user with valid token
    const user = await prisma.user.findFirst({
      where: {
        resetToken: hashedToken,
        resetTokenExpiry: {
          gt: now, // Token must not be expired
        },
      },
    })

    if (!user) {
      return { success: false, error: 'Invalid or expired reset token' }
    }

    // Hash new password
    const passwordHash = await hashPassword(newPassword)

    // Update password and clear reset token
    await prisma.user.update({
      where: { id: user.id },
      data: {
        passwordHash,
        resetToken: null,
        resetTokenExpiry: null,
      },
    })

    // Send confirmation email
    const html = `
      <h1>Password Reset Successful</h1>
      <p>Your password has been successfully reset.</p>
      <p>If you didn't make this change, please contact support immediately.</p>
    `

    sendEmail(user.email, 'Password Reset Confirmation', html).catch((err) => {
      console.error('Error sending reset confirmation:', err)
    })

    return { success: true }
  } catch (err) {
    return {
      success: false,
      error: err instanceof Error ? err.message : 'Failed to reset password',
    }
  }
}
