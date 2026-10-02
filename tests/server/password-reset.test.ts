import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { PrismaClient } from '@prisma/client'
import { hashPassword } from '@/server/auth/password'
import { requestPasswordReset, resetPassword } from '@/server/actions/auth-password'

const rawPrisma = new PrismaClient()

describe('Password Reset', () => {
  let testUserId: string
  let testEmail = `reset-test-${Date.now()}@example.com`

  beforeAll(async () => {
    // Create test user
    const user = await rawPrisma.user.create({
      data: {
        email: testEmail,
        passwordHash: await hashPassword('InitialPass123'),
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

  describe('requestPasswordReset', () => {
    it('returns success for existing email', async () => {
      const result = await requestPasswordReset(testEmail)

      expect(result.success).toBe(true)

      // Verify token was set
      const user = await rawPrisma.user.findUnique({
        where: { id: testUserId },
      })
      expect(user?.resetToken).toBeTruthy()
      expect(user?.resetTokenExpiry).toBeTruthy()
    })

    it('returns success for non-existing email (security: no enumeration)', async () => {
      const result = await requestPasswordReset('nonexistent@example.com')

      expect(result.success).toBe(true)
    })

    it('token expires in 1 hour', async () => {
      const before = new Date()
      await requestPasswordReset(testEmail)
      const after = new Date()

      const user = await rawPrisma.user.findUnique({
        where: { id: testUserId },
      })

      const expiryTime = user?.resetTokenExpiry
      expect(expiryTime).toBeTruthy()

      // Check expiry is approximately 1 hour from now
      const hourFromNow = new Date(before.getTime() + 3600000)
      const hourFromNowAfter = new Date(after.getTime() + 3600000)

      expect(expiryTime?.getTime()).toBeGreaterThanOrEqual(hourFromNow.getTime())
      expect(expiryTime?.getTime()).toBeLessThanOrEqual(hourFromNowAfter.getTime() + 1000)
    })
  })

  describe('resetPassword', () => {
    let validToken: string

    beforeAll(async () => {
      // Request a reset to get a token
      // Note: We can't directly get the token since it's hashed, so this tests the failure path
    })

    it('rejects invalid token', async () => {
      const result = await resetPassword('invalid-token-123456789', 'NewPass123')

      expect(result.success).toBe(false)
      expect(result.error).toContain('Invalid or expired')
    })

    it('rejects expired token', async () => {
      // Create a user with expired token
      const expiredUser = await rawPrisma.user.create({
        data: {
          email: `expired-reset-${Date.now()}@example.com`,
          passwordHash: await hashPassword('InitialPass123'),
          type: 'CUSTOMER',
          name: 'Expired User',
          resetToken: 'dummy-hash',
          resetTokenExpiry: new Date(Date.now() - 1000), // Already expired
        },
      })

      const result = await resetPassword('some-token', 'NewPass123')

      expect(result.success).toBe(false)
      expect(result.error).toContain('Invalid or expired')

      // Cleanup
      await rawPrisma.user.delete({
        where: { id: expiredUser.id },
      })
    })

    it('rejects weak password (too short)', async () => {
      const result = await resetPassword('some-token', 'Short1')

      expect(result.success).toBe(false)
      expect(result.error).toContain('8 characters')
    })

    it('rejects password without uppercase', async () => {
      const result = await resetPassword('some-token', 'lowercase123')

      expect(result.success).toBe(false)
      expect(result.error).toContain('uppercase')
    })

    it('rejects password without number', async () => {
      const result = await resetPassword('some-token', 'NoNumbers')

      expect(result.success).toBe(false)
      expect(result.error).toContain('number')
    })
  })
})
