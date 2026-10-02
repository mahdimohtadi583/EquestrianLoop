'use server'

import { getSessionOrRedirect, requireStaffRole } from '@/server/auth/guards'
import { withTenantContext } from '@/server/tenant/context'

/**
 * Task 20: Staff Bookings Server Actions
 *
 * Server actions for staff to view and manage bookings:
 * 1. getBookings - list all bookings (with customer, horse, session)
 * 2. getBookingById - fetch single booking detail
 *
 * All use getSessionOrRedirect() + requireStaffRole()
 * All return data directly (no success/error wrapper)
 */

export async function getBookings(organizationId: string) {
  const session = await getSessionOrRedirect()
  requireStaffRole((session.user as any)?.type)

  return withTenantContext(organizationId, (tx) =>
    tx.booking.findMany({
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

export async function getBookingById(organizationId: string, bookingId: string) {
  const session = await getSessionOrRedirect()
  requireStaffRole((session.user as any)?.type)

  return withTenantContext(organizationId, (tx) =>
    tx.booking.findUnique({
      where: { id: bookingId },
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
            memberships: {
              select: {
                id: true,
                status: true,
                endDate: true,
              },
            },
          },
        },
        ridingSession: {
          include: {
            horse: {
              select: {
                id: true,
                name: true,
                breed: true,
                status: true,
              },
            },
            service: {
              select: {
                id: true,
                name: true,
                durationMinutes: true,
              },
            },
            trainer: {
              include: {
                staff: {
                  include: {
                    user: {
                      select: {
                        name: true,
                      },
                    },
                  },
                },
              },
            },
          },
        },
        checkIn: true,
      },
    })
  )
}
