'use server'

import { getSessionOrRedirect, requireCustomerRole } from '@/server/auth/guards'
import { withTenantContext } from '@/server/tenant/context'
import { prisma } from '@/db/client'
import { sendBookingCancellation } from '@/server/notifications/notification-service'

/**
 * Task 21: Customer Portal Server Actions
 * Task 25: Booking Management CRUD - Cancel booking
 *
 * Server actions for customers to view and manage their own data:
 * 1. getMyBookings - customer's own bookings
 * 2. getMyMembership - current active membership
 * 3. getMyCustomerProfile - customer profile
 * 4. cancelMyBooking - cancel own booking (Task 25)
 *
 * All use getSessionOrRedirect() + requireCustomerRole()
 * All return data directly (no success/error wrapper) OR { success, error? }
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

export async function cancelMyBooking(
  organizationId: string,
  bookingId: string,
  reason?: string
): Promise<{ success: boolean; error?: string }> {
  try {
    const session = await getSessionOrRedirect()
    requireCustomerRole((session.user as any)?.type)

    // Verify customer owns this booking
    const customer = await withTenantContext(organizationId, (tx) =>
      tx.customer.findFirst({
        where: { userId: session.user?.id },
        select: { id: true },
      })
    )

    if (!customer) {
      return { success: false, error: 'Customer not found' }
    }

    const booking = await withTenantContext(organizationId, (tx) =>
      tx.booking.findUnique({
        where: { id: bookingId },
        select: { customerId: true },
      })
    )

    if (!booking || booking.customerId !== customer.id) {
      return { success: false, error: 'Booking not found or access denied' }
    }

    // Cancel the booking
    await withTenantContext(organizationId, (tx) =>
      tx.booking.update({
        where: { id: bookingId },
        data: { status: 'CANCELED' },
      })
    )

    // Send cancellation email (fire and forget)
    sendBookingCancellation(organizationId, bookingId, reason).catch((err) => {
      console.error('Failed to send booking cancellation:', err)
    })

    return { success: true }
  } catch (err) {
    return { success: false, error: err instanceof Error ? err.message : 'Failed to cancel booking' }
  }
}

export async function getLoyaltyBalance(organizationId: string) {
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
    tx.loyaltyAccount.findUnique({
      where: { customerId: customer.id },
      include: {
        transactions: {
          orderBy: { createdAt: 'desc' },
          take: 20,
        },
      },
    })
  )
}

export async function redeemReward(
  organizationId: string,
  rewardId: string
): Promise<{ success: boolean; data?: any; error?: string }> {
  try {
    const session = await getSessionOrRedirect()
    requireCustomerRole((session.user as any)?.type)

    // Find customer
    const customer = await withTenantContext(organizationId, (tx) =>
      tx.customer.findFirst({
        where: { userId: session.user?.id },
        select: { id: true },
      })
    )

    if (!customer) {
      return { success: false, error: 'Customer not found' }
    }

    // Get reward and loyalty account
    const [reward, loyalty] = await Promise.all([
      withTenantContext(organizationId, (tx) =>
        tx.reward.findUnique({
          where: { id: rewardId },
        })
      ),
      withTenantContext(organizationId, (tx) =>
        tx.loyaltyAccount.findUnique({
          where: { customerId: customer.id },
        })
      ),
    ])

    if (!reward) {
      return { success: false, error: 'Reward not found' }
    }

    if (!loyalty) {
      return { success: false, error: 'Loyalty account not found' }
    }

    if (loyalty.balance < reward.pointsCost) {
      return { success: false, error: 'Insufficient points' }
    }

    // Create transaction and redemption within transaction
    const result = await withTenantContext(organizationId, (tx) =>
      tx.$transaction(async (prisma: any) => {
        const transaction = await prisma.loyaltyTransaction.create({
          data: {
            organizationId,
            loyaltyAccountId: loyalty.id,
            type: 'REDEMPTION',
            points: -reward.pointsCost,
            sourceType: 'REWARD',
            sourceId: rewardId,
          },
        })

        const redemption = await prisma.rewardRedemption.create({
          data: {
            organizationId,
            customerId: customer.id,
            rewardId,
            loyaltyTransactionId: transaction.id,
          },
        })

        // Update loyalty account balance
        const updatedLoyalty = await prisma.loyaltyAccount.update({
          where: { id: loyalty.id },
          data: { balance: loyalty.balance - reward.pointsCost },
        })

        return updatedLoyalty
      })
    )

    return { success: true, data: result }
  } catch (err) {
    return { success: false, error: err instanceof Error ? err.message : 'Failed to redeem reward' }
  }
}
