import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { PrismaClient } from '@prisma/client'
import {
  getBookingStats,
  getRevenueStats,
  getMembershipStats,
  getLoyaltyStats,
} from '@/server/actions/staff-reports'
import { withTenantContext } from '@/server/tenant/context'

const rawPrisma = new PrismaClient()

describe('Reports & Analytics', () => {
  let testOrgId: string
  let testBranchId: string

  beforeAll(async () => {
    // Create test org
    const org = await rawPrisma.organization.create({
      data: { name: 'Reports Test Org', slug: `rto-${Date.now()}` },
    })
    testOrgId = org.id

    // Create test branch
    await rawPrisma.branch.create({
      data: {
        organizationId: testOrgId,
        name: 'Test Branch',
        timezone: 'UTC',
      },
    })
  })

  afterAll(async () => {
    // Cleanup
    await rawPrisma.booking.deleteMany({
      where: { organization: { id: testOrgId } },
    })
    await rawPrisma.ridingSession.deleteMany({
      where: { organization: { id: testOrgId } },
    })
    await rawPrisma.payment.deleteMany({
      where: { organization: { id: testOrgId } },
    })
    await rawPrisma.customerMembership.deleteMany({
      where: { organization: { id: testOrgId } },
    })
    await rawPrisma.loyaltyAccount.deleteMany({
      where: { organization: { id: testOrgId } },
    })
    await rawPrisma.customer.deleteMany({
      where: { organization: { id: testOrgId } },
    })
    await rawPrisma.horse.deleteMany({
      where: { branch: { organizationId: testOrgId } },
    })
    await rawPrisma.branch.deleteMany({
      where: { organizationId: testOrgId },
    })
    await rawPrisma.organization.delete({
      where: { id: testOrgId },
    })
    await rawPrisma.$disconnect()
  })

  describe('getBookingStats', () => {
    it('returns booking statistics for date range', async () => {
      const today = new Date()
      const thisMonth = new Date(today.getFullYear(), today.getMonth(), 1)
      const nextMonth = new Date(today.getFullYear(), today.getMonth() + 1, 1)

      const result = await getBookingStats(testOrgId, {
        from: thisMonth,
        to: nextMonth,
      })

      expect(result.success).toBe(true)
      expect(result.data).toBeDefined()
      expect(result.data?.total).toBe(0) // No bookings yet
      expect(result.data?.byStatus).toBeDefined()
    })

    it('rejects invalid date range', async () => {
      const result = await getBookingStats(testOrgId, {
        from: new Date('2025-12-31'),
        to: new Date('2025-01-01'), // Invalid: to before from
      })

      expect(result.success).toBe(false)
      expect(result.error).toBeDefined()
    })
  })

  describe('getRevenueStats', () => {
    it('returns revenue statistics for date range', async () => {
      const today = new Date()
      const thisMonth = new Date(today.getFullYear(), today.getMonth(), 1)
      const nextMonth = new Date(today.getFullYear(), today.getMonth() + 1, 1)

      const result = await getRevenueStats(testOrgId, {
        from: thisMonth,
        to: nextMonth,
      })

      expect(result.success).toBe(true)
      expect(result.data).toBeDefined()
      expect(result.data?.totalRevenue).toBe(0) // No payments yet
      expect(result.data?.byMonth).toBeDefined()
    })
  })

  describe('getMembershipStats', () => {
    it('returns membership statistics', async () => {
      const result = await getMembershipStats(testOrgId)

      expect(result.success).toBe(true)
      expect(result.data).toBeDefined()
      expect(result.data?.byStatus).toBeDefined()
      expect(result.data?.newThisMonth).toBeDefined()
    })
  })

  describe('getLoyaltyStats', () => {
    it('returns loyalty statistics', async () => {
      const result = await getLoyaltyStats(testOrgId)

      expect(result.success).toBe(true)
      expect(result.data).toBeDefined()
      expect(result.data?.totalPointsIssued).toBe(0)
      expect(result.data?.totalPointsRedeemed).toBe(0)
    })
  })
})
