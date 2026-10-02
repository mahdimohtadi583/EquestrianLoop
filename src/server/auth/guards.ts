import { prisma } from '@/db/client'
import { auth } from '@/server/auth/config'
import { withTenantContext } from '@/server/tenant/context'
import type { Permission } from '@/config/permissions'
import type { Session } from 'next-auth'

export async function getSessionUser() {
  const session = await auth()
  if (!session?.user?.id) return null
  const user = await prisma.user.findUnique({ where: { id: session.user.id } })
  if (!user) return null
  return { id: user.id, type: user.type }
}

/**
 * Task 13: Get session or throw if not authenticated.
 * Used by middleware to check if user is logged in.
 * Does NOT fetch user from DB — relies only on JWT session (auth()).
 */
export async function getSessionOrRedirect() {
  const session = await auth()
  if (!session?.user?.id) {
    throw new Error('Not authenticated: session required')
  }
  return session as Session
}

/**
 * Task 13: Require STAFF or ADMIN role.
 * Throws if user type does not allow staff access.
 * Synchronous — used for quick role checks in middleware or server actions.
 */
export function requireStaffRole(userType: string | undefined) {
  if (!userType || (userType !== 'STAFF' && userType !== 'ADMIN')) {
    throw new Error('Not authorized: staff session required')
  }
}

/**
 * Task 13: Require CUSTOMER role (exclusive).
 * Throws if user type is not CUSTOMER.
 * Staff and admin cannot use customer portal.
 * Synchronous — used for quick role checks in middleware or server actions.
 */
export function requireCustomerRole(userType: string | undefined) {
  if (!userType || userType !== 'CUSTOMER') {
    throw new Error('Not authorized: customer session required')
  }
}

export async function requirePermission(organizationId: string, permission: Permission) {
  const sessionUser = await getSessionUser()
  if (!sessionUser || sessionUser.type !== 'STAFF') {
    throw new Error('Not authorized: staff session required')
  }
  return withTenantContext(organizationId, async (tx) => {
    const membership = await tx.membership.findUnique({
      where: { userId_organizationId: { userId: sessionUser.id, organizationId } },
      include: { role: { include: { permissions: { include: { permission: true } } } } },
    })
    if (!membership) throw new Error('Not authorized: no membership in this organization')
    const hasPermission = membership.role.permissions.some((rp) => rp.permission.key === permission)
    if (!hasPermission) throw new Error(`Not authorized: missing permission ${permission}`)
    return { userId: sessionUser.id, membershipId: membership.id }
  })
}

export async function requireCustomer(organizationId: string) {
  const sessionUser = await getSessionUser()
  if (!sessionUser || sessionUser.type !== 'CUSTOMER') {
    throw new Error('Not authorized: customer session required')
  }
  return withTenantContext(organizationId, async (tx) => {
    const customer = await tx.customer.findUnique({
      where: { organizationId_userId: { organizationId, userId: sessionUser.id } },
    })
    if (!customer) throw new Error('Not authorized: no customer profile in this organization')
    return { userId: sessionUser.id, customerId: customer.id }
  })
}
