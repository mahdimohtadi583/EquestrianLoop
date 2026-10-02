/**
 * Task 32: Rate Limiting
 *
 * In-memory rate limiter using Map-based storage.
 * Automatically cleans up expired entries.
 * Never throws — always returns { success: boolean, remaining: number, resetAt: Date }
 */

interface RateLimitEntry {
  count: number
  resetAt: Date
}

const store = new Map<string, RateLimitEntry>()

export async function rateLimit(
  identifier: string,
  limit: number,
  windowSeconds: number
): Promise<{
  success: boolean
  remaining: number
  resetAt: Date
}> {
  try {
    const now = new Date()
    const entry = store.get(identifier)

    // Check if window has expired
    if (entry && entry.resetAt <= now) {
      store.delete(identifier)
    }

    const current = store.get(identifier)

    if (!current) {
      // First request in this window
      const resetAt = new Date(now.getTime() + windowSeconds * 1000)
      store.set(identifier, { count: 1, resetAt })

      return {
        success: true,
        remaining: limit - 1,
        resetAt,
      }
    }

    // Check if limit exceeded
    if (current.count >= limit) {
      return {
        success: false,
        remaining: 0,
        resetAt: current.resetAt,
      }
    }

    // Increment and allow
    current.count++
    return {
      success: true,
      remaining: limit - current.count,
      resetAt: current.resetAt,
    }
  } catch (err) {
    // Never throw
    console.error('Rate limit error:', err)
    return {
      success: false,
      remaining: 0,
      resetAt: new Date(),
    }
  }
}

export function clearRateLimitForTesting(): void {
  store.clear()
}
