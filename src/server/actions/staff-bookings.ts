'use server'

import { getSessionOrRedirect, requireStaffRole } from '@/server/auth/guards'
import { withTenantContext } from '@/server/tenant/context'

/**
 * Task 20: Staff Bookings Server Actions
 * Task 25: Booking Management CRUD
 *
 * Server actions for staff to view and manage bookings:
 * 1. getBookings - list all bookings (with customer, horse, session)
 * 2. getBookingById - fetch single booking detail
 * 3. createBooking - create new booking (Task 25)
 * 4. updateBooking - update existing booking (Task 25)
 * 5. cancelBooking - cancel booking (Task 25)
 *
 * All use getSessionOrRedirect() + requireStaffRole()
 * All return data directly (no success/error wrapper) OR { success, data?, error? }
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

export async function createBooking(
  organizationId: string,
  data: {
    customerId: string
    ridingSessionId: string
  }
): Promise<{ success: boolean; data?: any; error?: string }> {
  try {
    const session = await getSessionOrRedirect()
    requireStaffRole((session.user as any)?.type)

    // Verify customer has active membership
    const customer = await withTenantContext(organizationId, (tx) =>
      tx.customer.findUnique({
        where: { id: data.customerId },
        include: {
          memberships: {
            where: { status: 'ACTIVE' },
            take: 1,
          },
        },
      })
    )

    if (!customer || customer.memberships.length === 0) {
      return { success: false, error: 'Customer does not have an active membership' }
    }

    // Create booking
    const booking = await withTenantContext(organizationId, (tx) =>
      tx.booking.create({
        data: {
          organizationId,
          customerId: data.customerId,
          ridingSessionId: data.ridingSessionId,
          status: 'PENDING',
          createdVia: 'STAFF',
        },
      })
    )

    return { success: true, data: booking }
  } catch (err) {
    return { success: false, error: err instanceof Error ? err.message : 'Failed to create booking' }
  }
}

export async function updateBooking(
  organizationId: string,
  bookingId: string,
  data: {
    status?: string
  }
): Promise<{ success: boolean; data?: any; error?: string }> {
  try {
    const session = await getSessionOrRedirect()
    requireStaffRole((session.user as any)?.type)

    const booking = await withTenantContext(organizationId, (tx) =>
      tx.booking.update({
        where: { id: bookingId },
        data: data as any,
      })
    )

    return { success: true, data: booking }
  } catch (err) {
    return { success: false, error: err instanceof Error ? err.message : 'Failed to update booking' }
  }
}

export async function cancelBooking(
  organizationId: string,
  bookingId: string,
  reason?: string
): Promise<{ success: boolean; error?: string }> {
  try {
    const session = await getSessionOrRedirect()
    requireStaffRole((session.user as any)?.type)

    await withTenantContext(organizationId, (tx) =>
      tx.booking.update({
        where: { id: bookingId },
        data: { status: 'CANCELED' },
      })
    )

    return { success: true }
  } catch (err) {
    return { success: false, error: err instanceof Error ? err.message : 'Failed to cancel booking' }
  }
}

export async function getRidingSessions(organizationId: string) {
  const session = await getSessionOrRedirect()
  requireStaffRole((session.user as any)?.type)

  return withTenantContext(organizationId, (tx) =>
    tx.ridingSession.findMany({
      where: {
        startsAt: { gt: new Date() }, // Only future sessions
      },
      include: {
        horse: {
          select: {
            id: true,
            name: true,
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
      orderBy: { startsAt: 'asc' },
    })
  )
}
