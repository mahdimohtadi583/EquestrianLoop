import { describe, it, expect, beforeEach, vi } from 'vitest'
import { middleware } from '../../middleware'
import { NextRequest } from 'next/server'

/**
 * Task 13: Middleware route protection tests
 *
 * Tests that middleware correctly:
 * 1. Redirects unauthenticated users to login
 * 2. Enforces role-based access (STAFF/ADMIN vs CUSTOMER)
 * 3. Redirects authenticated users away from auth routes
 */

vi.mock('@/server/auth/config', () => ({
  auth: vi.fn(),
}))

import { auth } from '@/server/auth/config'

describe('Middleware - Route Protection', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  describe('Staff routes protection', () => {
    it('allows STAFF user to access /staff/dashboard', async () => {
      // Given a STAFF user is logged in
      vi.mocked(auth).mockResolvedValueOnce({
        user: { id: 'staff-1', type: 'STAFF' },
      } as any)

      // When they access /staff/dashboard
      const request = new NextRequest('http://localhost:3000/staff/dashboard')
      const response = await middleware(request)

      // Then the request proceeds (no redirect)
      expect(response.status).not.toBe(307) // 307 = redirect
    })

    it('allows ADMIN user to access /staff/dashboard', async () => {
      // Given an ADMIN user is logged in
      vi.mocked(auth).mockResolvedValueOnce({
        user: { id: 'admin-1', type: 'ADMIN' },
      } as any)

      // When they access /staff/dashboard
      const request = new NextRequest('http://localhost:3000/staff/dashboard')
      const response = await middleware(request)

      // Then the request proceeds
      expect(response.status).not.toBe(307)
    })

    it('redirects CUSTOMER to /staff/sign-in', async () => {
      // Given a CUSTOMER user is logged in
      vi.mocked(auth).mockResolvedValueOnce({
        user: { id: 'cust-1', type: 'CUSTOMER' },
      } as any)

      // When they try to access /staff/dashboard
      const request = new NextRequest('http://localhost:3000/staff/dashboard')
      const response = await middleware(request)

      // Then they are redirected to /staff/sign-in
      expect(response.status).toBe(307)
      expect(response.headers.get('location')).toContain('/staff/sign-in')
    })

    it('redirects unauthenticated user to /staff/sign-in', async () => {
      // Given no session exists
      vi.mocked(auth).mockResolvedValueOnce(null as any)

      // When they try to access /staff/dashboard
      const request = new NextRequest('http://localhost:3000/staff/dashboard')
      const response = await middleware(request)

      // Then they are redirected to /staff/sign-in
      expect(response.status).toBe(307)
      expect(response.headers.get('location')).toContain('/staff/sign-in')
    })
  })

  describe('Customer routes protection', () => {
    it('allows CUSTOMER user to access /customer/portal', async () => {
      // Given a CUSTOMER user is logged in
      vi.mocked(auth).mockResolvedValueOnce({
        user: { id: 'cust-1', type: 'CUSTOMER' },
      } as any)

      // When they access /customer/portal
      const request = new NextRequest('http://localhost:3000/customer/portal')
      const response = await middleware(request)

      // Then the request proceeds
      expect(response.status).not.toBe(307)
    })

    it('redirects STAFF to /customer/sign-in', async () => {
      // Given a STAFF user is logged in
      vi.mocked(auth).mockResolvedValueOnce({
        user: { id: 'staff-1', type: 'STAFF' },
      } as any)

      // When they try to access /customer/portal
      const request = new NextRequest('http://localhost:3000/customer/portal')
      const response = await middleware(request)

      // Then they are redirected to /customer/sign-in
      expect(response.status).toBe(307)
      expect(response.headers.get('location')).toContain('/customer/sign-in')
    })

    it('redirects ADMIN to /customer/sign-in', async () => {
      // Given an ADMIN user is logged in
      vi.mocked(auth).mockResolvedValueOnce({
        user: { id: 'admin-1', type: 'ADMIN' },
      } as any)

      // When they try to access /customer/portal
      const request = new NextRequest('http://localhost:3000/customer/portal')
      const response = await middleware(request)

      // Then they are redirected to /customer/sign-in
      expect(response.status).toBe(307)
      expect(response.headers.get('location')).toContain('/customer/sign-in')
    })

    it('redirects unauthenticated user to /customer/sign-in', async () => {
      // Given no session exists
      vi.mocked(auth).mockResolvedValueOnce(null as any)

      // When they try to access /customer/portal
      const request = new NextRequest('http://localhost:3000/customer/portal')
      const response = await middleware(request)

      // Then they are redirected to /customer/sign-in
      expect(response.status).toBe(307)
      expect(response.headers.get('location')).toContain('/customer/sign-in')
    })
  })

  describe('Auth route redirects', () => {
    it('redirects logged-in STAFF away from /staff/sign-in', async () => {
      // Given a STAFF user is logged in
      vi.mocked(auth).mockResolvedValueOnce({
        user: { id: 'staff-1', type: 'STAFF' },
      } as any)

      // When they navigate to /staff/sign-in
      const request = new NextRequest('http://localhost:3000/staff/sign-in')
      const response = await middleware(request)

      // Then they are redirected to /staff/dashboard
      expect(response.status).toBe(307)
      expect(response.headers.get('location')).toContain('/staff/dashboard')
    })

    it('redirects logged-in CUSTOMER away from /customer/sign-in', async () => {
      // Given a CUSTOMER user is logged in
      vi.mocked(auth).mockResolvedValueOnce({
        user: { id: 'cust-1', type: 'CUSTOMER' },
      } as any)

      // When they navigate to /customer/sign-in
      const request = new NextRequest('http://localhost:3000/customer/sign-in')
      const response = await middleware(request)

      // Then they are redirected to /customer/portal
      expect(response.status).toBe(307)
      expect(response.headers.get('location')).toContain('/customer/portal')
    })

    it('allows unauthenticated user to access /staff/sign-in', async () => {
      // Given no session exists
      vi.mocked(auth).mockResolvedValueOnce(null as any)

      // When they access /staff/sign-in
      const request = new NextRequest('http://localhost:3000/staff/sign-in')
      const response = await middleware(request)

      // Then the request proceeds
      expect(response.status).not.toBe(307)
    })

    it('allows unauthenticated user to access /customer/sign-in', async () => {
      // Given no session exists
      vi.mocked(auth).mockResolvedValueOnce(null as any)

      // When they access /customer/sign-in
      const request = new NextRequest('http://localhost:3000/customer/sign-in')
      const response = await middleware(request)

      // Then the request proceeds
      expect(response.status).not.toBe(307)
    })
  })

  describe('Public routes', () => {
    it('allows access to public routes without authentication', async () => {
      // Given no session exists
      vi.mocked(auth).mockResolvedValueOnce(null as any)

      // When they access /
      const request = new NextRequest('http://localhost:3000/')
      const response = await middleware(request)

      // Then the request proceeds
      expect(response.status).not.toBe(307)
    })
  })
})
