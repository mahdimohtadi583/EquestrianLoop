'use server'

import { getSessionOrRedirect, requireStaffRole } from '@/server/auth/guards'
import { withTenantContext } from '@/server/tenant/context'

/**
 * Task 19: Staff Horses Server Actions
 *
 * Server actions for staff to view horse data:
 * 1. getHorses - list all horses for organization
 * 2. getHorseById - fetch single horse with branch and bookings
 *
 * All use getSessionOrRedirect() + requireStaffRole()
 * All return data directly (no success/error wrapper)
 */

export async function getHorses(organizationId: string) {
  const session = await getSessionOrRedirect()
  requireStaffRole((session.user as any)?.type)

  return withTenantContext(organizationId, (tx) =>
    tx.horse.findMany({
      include: {
        branch: {
          select: {
            id: true,
            name: true,
          },
        },
        sessions: {
          select: {
            id: true,
          },
        },
      },
      orderBy: { name: 'asc' },
    })
  )
}

export async function getHorseById(organizationId: string, horseId: string) {
  const session = await getSessionOrRedirect()
  requireStaffRole((session.user as any)?.type)

  return withTenantContext(organizationId, (tx) =>
    tx.horse.findUnique({
      where: { id: horseId },
      include: {
        branch: {
          select: {
            id: true,
            name: true,
          },
        },
        sessions: {
          include: {
            bookings: {
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
              },
            },
          },
        },
      },
    })
  )
}
