'use server'

import { getSessionOrRedirect, requireStaffRole } from '@/server/auth/guards'
import { withTenantContext } from '@/server/tenant/context'

/**
 * Task 20: Staff Memberships Server Actions
 *
 * Server actions for staff to view membership data:
 * 1. getMemberships - list all memberships (customer, plan, status, expiry)
 * 2. getMembershipById - fetch single membership with payment history
 *
 * All use getSessionOrRedirect() + requireStaffRole()
 * All return data directly (no success/error wrapper)
 */

export async function getMemberships(organizationId: string) {
  const session = await getSessionOrRedirect()
  requireStaffRole((session.user as any)?.type)

  return withTenantContext(organizationId, (tx) =>
    tx.customerMembership.findMany({
      include: {
        customer: {
          include: {
            user: {
              select: {
                id: true,
                email: true,
                name: true,
              },
            },
          },
        },
        membershipPlan: {
          select: {
            id: true,
            name: true,
            price: true,
          },
        },
      },
      orderBy: { startDate: 'desc' },
    })
  )
}

export async function getMembershipById(organizationId: string, membershipId: string) {
  const session = await getSessionOrRedirect()
  requireStaffRole((session.user as any)?.type)

  return withTenantContext(organizationId, (tx) =>
    tx.customerMembership.findUnique({
      where: { id: membershipId },
      include: {
        customer: {
          include: {
            user: {
              select: {
                id: true,
                email: true,
                name: true,
              },
            },
            bookings: {
              select: {
                id: true,
                status: true,
                createdAt: true,
              },
            },
          },
        },
        membershipPlan: {
          select: {
            id: true,
            name: true,
            price: true,
            durationValue: true,
            durationUnit: true,
          },
        },
      },
    })
  )
}
