import { prisma } from '@/db/client'
import { auth } from '@/server/auth/config'
import { withTenantContext } from '@/server/tenant/context'
import type { Permission } from '@/config/permissions'

export async function getSessionUser() {
  const session = await auth()
  if (!session?.user?.id) return null
  const user = await prisma.user.findUnique({ where: { id: session.user.id } })
  if (!user) return null
  return { id: user.id, type: user.type }
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
