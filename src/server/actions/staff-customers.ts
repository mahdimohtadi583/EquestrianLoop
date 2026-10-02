'use server'

import { getSessionOrRedirect, requireStaffRole } from '@/server/auth/guards'
import { prisma } from '@/db/client'
import { withTenantContext } from '@/server/tenant/context'

/**
 * Task 19: Staff Customers Server Actions
 * Task 28: Loyalty Rewards
 *
 * Server actions for staff to manage customers:
 * 1. getCustomers - list all customers for organization
 * 2. getCustomerById - fetch single customer with memberships
 * 3. getCustomerBookedHorses - fetch horses for a customer
 * 4. awardLoyaltyPoints - award points to customer (Task 28)
 *
 * All use getSessionOrRedirect() + requireStaffRole()
 * Query actions return data directly
 * Mutation actions return { success, data?, error? }
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

export async function awardLoyaltyPoints(
  organizationId: string,
  customerId: string,
  points: number,
  reason?: string
): Promise<{ success: boolean; data?: any; error?: string }> {
  try {
    const session = await getSessionOrRedirect()
    requireStaffRole((session.user as any)?.type)

    if (points <= 0) {
      return { success: false, error: 'Points must be greater than zero' }
    }

    // Get or create loyalty account
    let loyaltyAccount = await withTenantContext(organizationId, (tx) =>
      tx.loyaltyAccount.findUnique({
        where: { customerId },
      })
    )

    if (!loyaltyAccount) {
      // Create new loyalty account if it doesn't exist
      loyaltyAccount = await withTenantContext(organizationId, (tx) =>
        tx.loyaltyAccount.create({
          data: {
            organizationId,
            customerId,
            balance: 0,
          },
        })
      )
    }

    // Award points via transaction
    const result = await withTenantContext(organizationId, (tx) =>
      tx.$transaction(async (prisma: any) => {
        // Create transaction record
        await prisma.loyaltyTransaction.create({
          data: {
            organizationId,
            loyaltyAccountId: loyaltyAccount.id,
            type: 'AWARD',
            points,
            sourceType: 'STAFF_AWARD',
            sourceId: reason || 'MANUAL',
          },
        })

        // Update balance
        const updated = await prisma.loyaltyAccount.update({
          where: { id: loyaltyAccount.id },
          data: { balance: loyaltyAccount.balance + points },
        })

        return updated
      })
    )

    return { success: true, data: result }
  } catch (err) {
    return { success: false, error: err instanceof Error ? err.message : 'Failed to award loyalty points' }
  }
}
