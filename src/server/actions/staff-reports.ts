'use server'

import { getSessionOrRedirect, requireStaffRole } from '@/server/auth/guards'
import { withTenantContext } from '@/server/tenant/context'

/**
 * Task 29: Reports & Analytics
 *
 * Server actions for staff to view business analytics:
 * 1. getBookingStats - booking statistics by status, month, horse utilization
 * 2. getRevenueStats - revenue by plan, month, top customers
 * 3. getMembershipStats - membership status breakdown, churn rate
 * 4. getLoyaltyStats - points issued/redeemed, top rewards
 *
 * All use getSessionOrRedirect() + requireStaffRole()
 * All return { success, data?, error? }
 */

export async function getBookingStats(
  organizationId: string,
  dateRange: { from: Date; to: Date }
): Promise<{ success: boolean; data?: any; error?: string }> {
  try {
    const session = await getSessionOrRedirect()
    requireStaffRole((session.user as any)?.type)

    if (dateRange.from >= dateRange.to) {
      return { success: false, error: 'Invalid date range: from must be before to' }
    }

    const stats = await withTenantContext(organizationId, (tx) =>
      tx.$transaction(async (prisma: any) => {
        // Total bookings in date range
        const totalBookings = await prisma.booking.count({
          where: {
            createdAt: {
              gte: dateRange.from,
              lt: dateRange.to,
            },
          },
        })

        // Bookings by status
        const statusCounts = await prisma.booking.groupBy({
          by: ['status'],
          where: {
            createdAt: {
              gte: dateRange.from,
              lt: dateRange.to,
            },
          },
          _count: true,
        })

        const byStatus = statusCounts.reduce(
          (acc: any, item: any) => {
            acc[item.status] = item._count
            return acc
          },
          {}
        )

        // Bookings by month
        const monthlyBookings = await prisma.booking.groupBy({
          by: ['createdAt'],
          where: {
            createdAt: {
              gte: dateRange.from,
              lt: dateRange.to,
            },
          },
          _count: true,
        })

        // Group by month for chart
        const byMonth: Record<string, number> = {}
        monthlyBookings.forEach((item: any) => {
          const month = new Date(item.createdAt).toLocaleString('default', {
            month: 'short',
            year: 'numeric',
          })
          byMonth[month] = (byMonth[month] || 0) + item._count
        })

        // Top 5 most booked horses
        const topHorses = await prisma.booking.groupBy({
          by: ['ridingSessionId'],
          where: {
            createdAt: {
              gte: dateRange.from,
              lt: dateRange.to,
            },
          },
          _count: true,
          orderBy: {
            _count: 'desc',
          },
          take: 5,
        })

        return {
          total: totalBookings,
          byStatus,
          byMonth,
          topHorses: topHorses.map((item: any) => ({
            sessionId: item.ridingSessionId,
            count: item._count,
          })),
        }
      })
    )

    return { success: true, data: stats }
  } catch (err) {
    return {
      success: false,
      error: err instanceof Error ? err.message : 'Failed to get booking stats',
    }
  }
}

export async function getRevenueStats(
  organizationId: string,
  dateRange: { from: Date; to: Date }
): Promise<{ success: boolean; data?: any; error?: string }> {
  try {
    const session = await getSessionOrRedirect()
    requireStaffRole((session.user as any)?.type)

    if (dateRange.from >= dateRange.to) {
      return { success: false, error: 'Invalid date range: from must be before to' }
    }

    const stats = await withTenantContext(organizationId, (tx) =>
      tx.$transaction(async (prisma: any) => {
        // Total revenue from successful payments
        const revenueResult = await prisma.payment.aggregate({
          _sum: {
            amount: true,
          },
          where: {
            status: 'SUCCEEDED',
            createdAt: {
              gte: dateRange.from,
              lt: dateRange.to,
            },
          },
        })

        const totalRevenue = revenueResult._sum.amount || 0

        // Revenue by membership plan
        const planRevenue = await prisma.payment.groupBy({
          by: ['membershipPlanId'],
          where: {
            status: 'SUCCEEDED',
            createdAt: {
              gte: dateRange.from,
              lt: dateRange.to,
            },
          },
          _sum: {
            amount: true,
          },
        })

        const byPlan: Record<string, number> = {}
        planRevenue.forEach((item: any) => {
          byPlan[item.membershipPlanId] = item._sum.amount || 0
        })

        // Revenue by month
        const monthlyRevenue = await prisma.payment.groupBy({
          by: ['createdAt'],
          where: {
            status: 'SUCCEEDED',
            createdAt: {
              gte: dateRange.from,
              lt: dateRange.to,
            },
          },
          _sum: {
            amount: true,
          },
        })

        const byMonth: Record<string, number> = {}
        monthlyRevenue.forEach((item: any) => {
          const month = new Date(item.createdAt).toLocaleString('default', {
            month: 'short',
            year: 'numeric',
          })
          byMonth[month] = (byMonth[month] || 0) + (item._sum.amount || 0)
        })

        // Top 5 paying customers
        const topCustomers = await prisma.payment.groupBy({
          by: ['customerId'],
          where: {
            status: 'SUCCEEDED',
            createdAt: {
              gte: dateRange.from,
              lt: dateRange.to,
            },
          },
          _sum: {
            amount: true,
          },
          orderBy: {
            _sum: {
              amount: 'desc',
            },
          },
          take: 5,
        })

        return {
          totalRevenue,
          byPlan,
          byMonth,
          topCustomers: topCustomers.map((item: any) => ({
            customerId: item.customerId,
            totalSpent: item._sum.amount || 0,
          })),
        }
      })
    )

    return { success: true, data: stats }
  } catch (err) {
    return {
      success: false,
      error: err instanceof Error ? err.message : 'Failed to get revenue stats',
    }
  }
}

export async function getMembershipStats(organizationId: string): Promise<{
  success: boolean
  data?: any
  error?: string
}> {
  try {
    const session = await getSessionOrRedirect()
    requireStaffRole((session.user as any)?.type)

    const stats = await withTenantContext(organizationId, (tx) =>
      tx.$transaction(async (prisma: any) => {
        // Memberships by status
        const statusCounts = await prisma.customerMembership.groupBy({
          by: ['status'],
          _count: true,
        })

        const byStatus = statusCounts.reduce(
          (acc: any, item: any) => {
            acc[item.status] = item._count
            return acc
          },
          {}
        )

        // New memberships this month
        const now = new Date()
        const thisMonthStart = new Date(now.getFullYear(), now.getMonth(), 1)
        const newThisMonth = await prisma.customerMembership.count({
          where: {
            startDate: {
              gte: thisMonthStart,
            },
          },
        })

        // Last month start/end for comparison
        const lastMonthStart = new Date(now.getFullYear(), now.getMonth() - 1, 1)
        const lastMonthEnd = thisMonthStart

        // New memberships last month
        const newLastMonth = await prisma.customerMembership.count({
          where: {
            startDate: {
              gte: lastMonthStart,
              lt: lastMonthEnd,
            },
          },
        })

        // Churn rate calculation
        const activeLast = await prisma.customerMembership.count({
          where: {
            status: 'ACTIVE',
            startDate: {
              lt: lastMonthEnd,
            },
          },
        })

        const cancelledThisMonth = await prisma.customerMembership.count({
          where: {
            status: 'CANCELLED',
            endDate: {
              gte: thisMonthStart,
            },
          },
        })

        const churnRate = activeLast > 0 ? (cancelledThisMonth / activeLast) * 100 : 0

        return {
          byStatus,
          newThisMonth,
          newLastMonth,
          churnRate: parseFloat(churnRate.toFixed(2)),
        }
      })
    )

    return { success: true, data: stats }
  } catch (err) {
    return {
      success: false,
      error: err instanceof Error ? err.message : 'Failed to get membership stats',
    }
  }
}

export async function getLoyaltyStats(organizationId: string): Promise<{
  success: boolean
  data?: any
  error?: string
}> {
  try {
    const session = await getSessionOrRedirect()
    requireStaffRole((session.user as any)?.type)

    const stats = await withTenantContext(organizationId, (tx) =>
      tx.$transaction(async (prisma: any) => {
        // Total points issued (all AWARD type transactions)
        const issuedResult = await prisma.loyaltyTransaction.aggregate({
          _sum: {
            points: true,
          },
          where: {
            type: 'AWARD',
          },
        })

        const totalPointsIssued = Math.max(issuedResult._sum.points || 0, 0)

        // Total points redeemed (all REDEMPTION type transactions)
        const redeemedResult = await prisma.loyaltyTransaction.aggregate({
          _sum: {
            points: true,
          },
          where: {
            type: 'REDEMPTION',
          },
        })

        // Redemptions are negative, so take absolute value
        const totalPointsRedeemed = Math.abs(redeemedResult._sum.points || 0)

        // Points redeemed this month
        const now = new Date()
        const thisMonthStart = new Date(now.getFullYear(), now.getMonth(), 1)

        const redeemedThisMonth = await prisma.loyaltyTransaction.aggregate({
          _sum: {
            points: true,
          },
          where: {
            type: 'REDEMPTION',
            createdAt: {
              gte: thisMonthStart,
            },
          },
        })

        const pointsRedeemedThisMonth = Math.abs(redeemedThisMonth._sum.points || 0)

        // Top 5 rewards by redemption count
        const topRewards = await prisma.rewardRedemption.groupBy({
          by: ['rewardId'],
          _count: true,
          orderBy: {
            _count: 'desc',
          },
          take: 5,
        })

        return {
          totalPointsIssued,
          totalPointsRedeemed,
          pointsRedeemedThisMonth,
          topRewards: topRewards.map((item: any) => ({
            rewardId: item.rewardId,
            redemptionCount: item._count,
          })),
        }
      })
    )

    return { success: true, data: stats }
  } catch (err) {
    return {
      success: false,
      error: err instanceof Error ? err.message : 'Failed to get loyalty stats',
    }
  }
}
