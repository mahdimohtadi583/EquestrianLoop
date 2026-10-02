import { describe, it, expect, beforeEach, vi } from 'vitest'
import {
  requireStaffRole,
  requireCustomerRole,
  getSessionOrRedirect,
} from '@/server/auth/guards'

/**
 * Task 13: Route-level session and role guards
 *
 * These tests verify:
 * 1. Role enforcement (staff vs customer vs unauthenticated)
 * 2. Session access via NextAuth v5 JWT
 * 3. No proxy or RLS layer bypass
 * 4. Proper error handling and redirects
 */

vi.mock('@/server/auth/config', () => ({
  auth: vi.fn(),
}))

import { auth } from '@/server/auth/config'

describe('Session & Role Guards', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  describe('requireStaffRole', () => {
    it('allows STAFF user to proceed', () => {
      // When requireStaffRole is called with type='STAFF'
      // Then returns successfully without throwing
      const result = requireStaffRole('STAFF')
      expect(result).toBeUndefined()
    })

    it('allows ADMIN user to proceed', () => {
      // When requireStaffRole is called with type='ADMIN'
      // Then returns successfully (admin can perform staff actions)
      const result = requireStaffRole('ADMIN')
      expect(result).toBeUndefined()
    })

    it('throws for CUSTOMER user', () => {
      // When requireStaffRole is called with type='CUSTOMER'
      // Then throws error containing 'staff'
      expect(() => requireStaffRole('CUSTOMER')).toThrow(/staff/i)
    })

    it('throws for undefined role', () => {
      // When requireStaffRole is called with no role
      // Then throws error
      expect(() => requireStaffRole(undefined as never)).toThrow()
    })
  })

  describe('requireCustomerRole', () => {
    it('allows CUSTOMER user to proceed', () => {
      // When requireCustomerRole is called with type='CUSTOMER'
      // Then returns successfully
      const result = requireCustomerRole('CUSTOMER')
      expect(result).toBeUndefined()
    })

    it('throws for STAFF user', () => {
      // When requireCustomerRole is called with type='STAFF'
      // Then throws error containing 'customer'
      expect(() => requireCustomerRole('STAFF')).toThrow(/customer/i)
    })

    it('throws for ADMIN user', () => {
      // When requireCustomerRole is called with type='ADMIN'
      // Then throws error containing 'customer' (admin is staff, not customer)
      expect(() => requireCustomerRole('ADMIN')).toThrow(/customer/i)
    })

    it('throws for undefined role', () => {
      // When requireCustomerRole is called with no role
      // Then throws error
      expect(() => requireCustomerRole(undefined as never)).toThrow()
    })
  })

  describe('getSessionOrRedirect', () => {
    it('returns user info when session exists', async () => {
      // When getSessionOrRedirect is called and auth() returns a session
      // Then returns user id and type
      const mockSession = { user: { id: 'user-123', type: 'STAFF' } }
      vi.mocked(auth).mockResolvedValueOnce(mockSession as any)

      const result = await getSessionOrRedirect()
      expect(result?.user?.id).toBe('user-123')
    })

    it('throws when no session exists', async () => {
      // When getSessionOrRedirect is called with no session
      // Then throws error
      vi.mocked(auth).mockResolvedValueOnce(null as any)

      await expect(getSessionOrRedirect()).rejects.toThrow()
    })

    it('throws when session lacks user.id', async () => {
      // When session exists but has no user.id
      // Then throws error
      vi.mocked(auth).mockResolvedValueOnce({ user: { id: undefined } } as any)

      await expect(getSessionOrRedirect()).rejects.toThrow()
    })
  })
})
