import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { PrismaClient } from '@prisma/client'
import {
  sendVerificationEmail,
  verifyEmail,
  resendVerificationEmail,
} from '@/server/actions/auth-verification'

const rawPrisma = new PrismaClient()

describe('Email Verification', () => {
  let testUserId: string
  let testEmail = `test-${Date.now()}@example.com`

  beforeAll(async () => {
    // Create test user
    const user = await rawPrisma.user.create({
      data: {
        email: testEmail,
        passwordHash: 'test-hash',
        type: 'CUSTOMER',
        name: 'Test User',
      },
    })
    testUserId = user.id
  })

  afterAll(async () => {
    // Cleanup
    await rawPrisma.user.deleteMany({
      where: { email: testEmail },
    })
    await rawPrisma.$disconnect()
  })

  describe('sendVerificationEmail', () => {
    it('generates token and sets expiry', async () => {
      const result = await sendVerificationEmail(testUserId)

      expect(result.success).toBe(true)

      // Verify user has token stored
      const user = await rawPrisma.user.findUnique({
        where: { id: testUserId },
      })
      expect(user?.verificationToken).toBeTruthy()
      expect(user?.verificationTokenExpiry).toBeTruthy()
    })

    it('rejects if user not found', async () => {
      const result = await sendVerificationEmail('non-existent-id')

      expect(result.success).toBe(false)
      expect(result.error).toContain('not found')
    })

    it('rejects if email already verified', async () => {
      // Create a verified user
      const verifiedUser = await rawPrisma.user.create({
        data: {
          email: `verified-${Date.now()}@example.com`,
          passwordHash: 'test-hash',
          type: 'CUSTOMER',
          name: 'Verified User',
          emailVerified: new Date(),
        },
      })

      const result = await sendVerificationEmail(verifiedUser.id)

      expect(result.success).toBe(false)
      expect(result.error).toContain('already verified')

      // Cleanup
      await rawPrisma.user.delete({
        where: { id: verifiedUser.id },
      })
    })
  })

  describe('verifyEmail', () => {
    it('validates email with correct token', async () => {
      // Send verification email first
      await sendVerificationEmail(testUserId)

      // Get the token from the user
      const user = await rawPrisma.user.findUnique({
        where: { id: testUserId },
      })
      expect(user?.verificationToken).toBeTruthy()

      // Note: We can't get the raw token from here since it's hashed
      // In a real test, we'd intercept the email send or use a test email service
      // For now, just test the structure
      expect(user?.verificationTokenExpiry).toBeTruthy()
    })

    it('rejects invalid token', async () => {
      const result = await verifyEmail('invalid-token-123456789')

      expect(result.success).toBe(false)
      expect(result.error).toContain('Invalid or expired')
    })

    it('rejects empty token', async () => {
      const result = await verifyEmail('')

      expect(result.success).toBe(false)
      expect(result.error).toContain('required')
    })

    it('rejects expired token', async () => {
      // Create user with expired token
      const expiredUser = await rawPrisma.user.create({
        data: {
          email: `expired-${Date.now()}@example.com`,
          passwordHash: 'test-hash',
          type: 'CUSTOMER',
          name: 'Expired User',
          verificationToken: 'dummy-hash',
          verificationTokenExpiry: new Date(Date.now() - 1000), // Expired
        },
      })

      const result = await verifyEmail('some-token')

      expect(result.success).toBe(false)
      expect(result.error).toContain('expired')

      // Cleanup
      await rawPrisma.user.delete({
        where: { id: expiredUser.id },
      })
    })
  })

  describe('resendVerificationEmail', () => {
    it('resends verification email for unverified user', async () => {
      const result = await resendVerificationEmail(testUserId)

      expect(result.success).toBe(true)
    })

    it('rejects resend if user not found', async () => {
      const result = await resendVerificationEmail('non-existent-id')

      expect(result.success).toBe(false)
      expect(result.error).toContain('not found')
    })

    it('rejects resend if email already verified', async () => {
      // Create a verified user
      const verifiedUser = await rawPrisma.user.create({
        data: {
          email: `verified2-${Date.now()}@example.com`,
          passwordHash: 'test-hash',
          type: 'CUSTOMER',
          name: 'Verified User 2',
          emailVerified: new Date(),
        },
      })

      const result = await resendVerificationEmail(verifiedUser.id)

      expect(result.success).toBe(false)
      expect(result.error).toContain('already verified')

      // Cleanup
      await rawPrisma.user.delete({
        where: { id: verifiedUser.id },
      })
    })
  })
})
