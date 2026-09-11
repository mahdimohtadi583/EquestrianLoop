import { describe, it, expect } from 'vitest'
import { resolveConnectionString } from '@/db/raw-client'

// Regression test for a bundled (non-security) fix found in the same
// review as the tenant-access boundary bypass: the runtime client was
// preferring DIRECT_URL (Supabase's unpooled, session-mode connection,
// meant only for `prisma migrate`/introspection) over DATABASE_URL (the
// pooled, transaction-mode connection meant for request-serving traffic).
// Preferring DIRECT_URL at runtime risks exhausting Supabase's low
// direct-connection limit under real concurrent load. This test exercises
// the actual precedence logic in src/db/raw-client.ts directly, rather
// than re-reading the source, so it fails if the precedence is ever
// silently flipped back.
describe('resolveConnectionString', () => {
  it('prefers DATABASE_URL (pooled) over DIRECT_URL (unpooled) when both are set', () => {
    expect(
      resolveConnectionString({
        DATABASE_URL: 'postgres://pooled',
        DIRECT_URL: 'postgres://direct',
      })
    ).toBe('postgres://pooled')
  })

  it('falls back to DIRECT_URL when only DIRECT_URL is set', () => {
    expect(resolveConnectionString({ DIRECT_URL: 'postgres://direct' })).toBe('postgres://direct')
  })

  it('throws when neither DATABASE_URL nor DIRECT_URL is set', () => {
    expect(() => resolveConnectionString({})).toThrow()
  })
})
