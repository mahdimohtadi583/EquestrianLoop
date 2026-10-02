'use server'

import { getSessionOrRedirect, requireStaffRole } from '@/server/auth/guards'
import { withTenantContext } from '@/server/tenant/context'

/**
 * Task 19: Staff Horses Server Actions
 * Task 26: Horse Management CRUD
 *
 * Server actions for staff to manage horses:
 * 1. getHorses - list all horses for organization
 * 2. getHorseById - fetch single horse with branch and bookings
 * 3. createHorse - create new horse (Task 26)
 * 4. updateHorse - update horse details (Task 26)
 * 5. archiveHorse - retire horse (Task 26)
 *
 * All use getSessionOrRedirect() + requireStaffRole()
 * Query actions return data directly
 * Mutation actions return { success, data?, error? }
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

export async function createHorse(
  organizationId: string,
  data: {
    name: string
    breed?: string | null
    dob?: Date
    status: string
    branchId: string
    notes?: string | null
    photoUrl?: string | null
  }
): Promise<{ success: boolean; data?: any; error?: string }> {
  try {
    const session = await getSessionOrRedirect()
    requireStaffRole((session.user as any)?.type)

    if (!data.name?.trim()) {
      return { success: false, error: 'Horse name is required' }
    }

    // Verify branch belongs to organization
    const branch = await withTenantContext(organizationId, (tx) =>
      tx.branch.findUnique({
        where: { id: data.branchId },
      })
    )

    if (!branch) {
      return { success: false, error: 'Branch not found or does not belong to organization' }
    }

    const horse = await withTenantContext(organizationId, (tx) =>
      tx.horse.create({
        data: {
          organizationId,
          name: data.name,
          breed: data.breed,
          dob: data.dob,
          status: data.status,
          branchId: data.branchId,
          notes: data.notes,
          photoUrl: data.photoUrl,
        } as any,
      })
    )

    return { success: true, data: horse }
  } catch (err) {
    return { success: false, error: err instanceof Error ? err.message : 'Failed to create horse' }
  }
}

export async function updateHorse(
  organizationId: string,
  horseId: string,
  data: {
    name?: string
    breed?: string | null
    status?: string
    notes?: string | null
    photoUrl?: string | null
  }
): Promise<{ success: boolean; data?: any; error?: string }> {
  try {
    const session = await getSessionOrRedirect()
    requireStaffRole((session.user as any)?.type)

    // Verify horse exists
    const horse = await withTenantContext(organizationId, (tx) =>
      tx.horse.findUnique({
        where: { id: horseId },
      })
    )

    if (!horse) {
      return { success: false, error: 'Horse not found' }
    }

    const updated = await withTenantContext(organizationId, (tx) =>
      tx.horse.update({
        where: { id: horseId },
        data: {
          name: data.name,
          breed: data.breed,
          status: data.status,
          notes: data.notes,
          photoUrl: data.photoUrl,
        } as any,
      })
    )

    return { success: true, data: updated }
  } catch (err) {
    return { success: false, error: err instanceof Error ? err.message : 'Failed to update horse' }
  }
}

export async function archiveHorse(
  organizationId: string,
  horseId: string
): Promise<{ success: boolean; error?: string }> {
  try {
    const session = await getSessionOrRedirect()
    requireStaffRole((session.user as any)?.type)

    // Check if horse has future bookings
    const futureBookings = await withTenantContext(organizationId, (tx) =>
      tx.booking.findFirst({
        where: {
          ridingSession: {
            horse: { id: horseId },
            startsAt: { gt: new Date() },
          },
        },
      })
    )

    if (futureBookings) {
      return { success: false, error: 'Cannot archive horse with future bookings' }
    }

    await withTenantContext(organizationId, (tx) =>
      tx.horse.update({
        where: { id: horseId },
        data: { status: 'RETIRED' },
      })
    )

    return { success: true }
  } catch (err) {
    return { success: false, error: err instanceof Error ? err.message : 'Failed to archive horse' }
  }
}
