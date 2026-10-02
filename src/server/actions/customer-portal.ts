'use server'

import { getSessionOrRedirect, requireCustomerRole } from '@/server/auth/guards'
import { withTenantContext } from '@/server/tenant/context'
import { prisma } from '@/db/client'

/**
 * Task 21: Customer Portal Server Actions
 *
 * Server actions for customers to view their own data:
 * 1. getMyBookings - customer's own bookings
 * 2. getMyMembership - current active membership
 * 3. getMyHorses - customer's own horses (through bookings)
 *
 * All use getSessionOrRedirect() + requireCustomerRole()
 * All return data directly (no success/error wrapper)
 */

export async function getMyBookings(organizationId: string) {
  const session = await getSessionOrRedirect()
  requireCustomerRole((session.user as any)?.type)

  const customer = await withTenantContext(organizationId, (tx) =>
    tx.customer.findFirst({
      where: { userId: session.user?.id },
      select: { id: true },
    })
  )

  if (!customer) {
    return []
  }

  return withTenantContext(organizationId, (tx) =>
    tx.booking.findMany({
      where: { customerId: customer.id },
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
            service: {
              select: {
                id: true,
                name: true,
              },
            },
          },
        },
      },
      orderBy: { ridingSession: { startsAt: 'desc' } },
    })
  )
}

export async function getMyMembership(organizationId: string) {
  const session = await getSessionOrRedirect()
  requireCustomerRole((session.user as any)?.type)

  const customer = await withTenantContext(organizationId, (tx) =>
    tx.customer.findFirst({
      where: { userId: session.user?.id },
      select: { id: true },
    })
  )

  if (!customer) {
    return null
  }

  return withTenantContext(organizationId, (tx) =>
    tx.customerMembership.findFirst({
      where: {
        customerId: customer.id,
        status: 'ACTIVE',
      },
      include: {
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

export async function getMyCustomerProfile(organizationId: string) {
  const session = await getSessionOrRedirect()
  requireCustomerRole((session.user as any)?.type)

  return withTenantContext(organizationId, (tx) =>
    tx.customer.findFirst({
      where: { userId: session.user?.id },
      include: {
        user: {
          select: {
            id: true,
            email: true,
            name: true,
          },
        },
      },
    })
  )
}
