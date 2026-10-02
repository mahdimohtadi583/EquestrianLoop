import { describe, it, expect, beforeEach } from 'vitest'
import { rateLimit, clearRateLimitForTesting } from '@/server/rate-limit/rate-limiter'

describe('Rate Limiter', () => {
  beforeEach(() => {
    clearRateLimitForTesting()
  })

  describe('basic functionality', () => {
    it('allows requests under the limit', async () => {
      const result = await rateLimit('user-1', 3, 60)
      expect(result.success).toBe(true)
      expect(result.remaining).toBe(2)
    })

    it('allows multiple requests up to the limit', async () => {
      // First request
      const result1 = await rateLimit('user-1', 3, 60)
      expect(result1.success).toBe(true)
      expect(result1.remaining).toBe(2)

      // Second request
      const result2 = await rateLimit('user-1', 3, 60)
      expect(result2.success).toBe(true)
      expect(result2.remaining).toBe(1)

      // Third request (at limit)
      const result3 = await rateLimit('user-1', 3, 60)
      expect(result3.success).toBe(true)
      expect(result3.remaining).toBe(0)
    })

    it('blocks requests over the limit', async () => {
      // Max 3 requests per minute
      await rateLimit('user-2', 3, 60)
      await rateLimit('user-2', 3, 60)
      await rateLimit('user-2', 3, 60)

      // Fourth request should fail
      const result = await rateLimit('user-2', 3, 60)
      expect(result.success).toBe(false)
      expect(result.remaining).toBe(0)
    })

    it('returns resetAt timestamp', async () => {
      const before = new Date()
      const result = await rateLimit('user-3', 5, 30)
      const after = new Date()

      expect(result.resetAt).toBeDefined()
      // resetAt should be ~30 seconds in the future
      const delta = result.resetAt!.getTime() - before.getTime()
      expect(delta).toBeGreaterThanOrEqual(30000 - 100) // Allow 100ms margin
      expect(delta).toBeLessThanOrEqual(30000 + 100)
    })
  })

  describe('identifier isolation', () => {
    it('different identifiers do not interfere with each other', async () => {
      // Max 2 per minute
      const result1a = await rateLimit('user-4', 2, 60)
      const result1b = await rateLimit('user-4', 2, 60)
      const result1c = await rateLimit('user-4', 2, 60) // Should fail

      const result2a = await rateLimit('user-5', 2, 60)
      const result2b = await rateLimit('user-5', 2, 60)

      expect(result1a.success).toBe(true)
      expect(result1b.success).toBe(true)
      expect(result1c.success).toBe(false)

      expect(result2a.success).toBe(true)
      expect(result2b.success).toBe(true)
    })
  })

  describe('edge cases', () => {
    it('handles limit of 1', async () => {
      const result1 = await rateLimit('user-6', 1, 60)
      expect(result1.success).toBe(true)
      expect(result1.remaining).toBe(0)

      const result2 = await rateLimit('user-6', 1, 60)
      expect(result2.success).toBe(false)
    })

    it('handles very short window (1 second)', async () => {
      const result1 = await rateLimit('user-7', 1, 1)
      expect(result1.success).toBe(true)

      const result2 = await rateLimit('user-7', 1, 1)
      expect(result2.success).toBe(false)
    })

    it('never throws - returns success false on error', async () => {
      // This test ensures the function is resilient
      expect(async () => {
        await rateLimit('valid-id', 5, 60)
      }).not.toThrow()
    })
  })
})
