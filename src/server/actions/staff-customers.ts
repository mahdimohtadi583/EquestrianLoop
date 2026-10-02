'use server'

import { getSessionOrRedirect, requireStaffRole } from '@/server/auth/guards'
import { prisma } from '@/db/client'
import { withTenantContext } from '@/server/tenant/context'

/**
 * Task 19: Staff Customers Server Actions
 *
 * Server actions for staff to view customer data:
 * 1. getCustomers - list all customers for organization
 * 2. getCustomerById - fetch single customer with memberships
 * 3. getCustomerHorses - fetch horses for a customer
 *
 * All use getSessionOrRedirect() + requireStaffRole()
 * All return data directly (no success/error wrapper)
 */

export async function getCustomers(organizationId: string) {
  const session = await getSessionOrRedirect()
  requireStaffRole((session.user as any)?.type)

  return withTenantContext(organizationId, (tx) =>
    tx.customer.findMany({
      include: {
        user: {
          select: {
            id: true,
            email: true,
            name: true,
          },
        },
        memberships: {
          select: {
            id: true,
            status: true,
            startDate: true,
            endDate: true,
          },
        },
      },
      orderBy: { user: { name: 'asc' } },
    })
  )
}

export async function getCustomerById(organizationId: string, customerId: string) {
  const session = await getSessionOrRedirect()
  requireStaffRole((session.user as any)?.type)

  return withTenantContext(organizationId, (tx) =>
    tx.customer.findUnique({
      where: { id: customerId },
      include: {
        user: {
          select: {
            id: true,
            email: true,
            name: true,
          },
        },
        memberships: {
          include: {
            membershipPlan: {
              select: {
                id: true,
                name: true,
                price: true,
              },
            },
          },
          orderBy: { startDate: 'desc' },
        },
        bookings: {
          include: {
            ridingSession: {
              include: {
                horse: {
                  select: {
                    id: true,
                    name: true,
                    breed: true,
                  },
                },
              },
            },
          },
        },
      },
    })
  )
}

export async function getCustomerBookedHorses(organizationId: string, customerId: string) {
  const session = await getSessionOrRedirect()
  requireStaffRole((session.user as any)?.type)

  return withTenantContext(organizationId, (tx) =>
    tx.booking.findMany({
      where: { customerId },
      include: {
        ridingSession: {
          include: {
            horse: {
              select: {
                id: true,
                name: true,
                breed: true,
                dob: true,
              },
            },
          },
        },
      },
      orderBy: { createdAt: 'desc' },
    })
  )
}
