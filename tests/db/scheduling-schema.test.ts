import { describe, it, expect, afterAll } from 'vitest'
// See the note in Task 3's rbac-schema.test.ts: schema-verification tests use
// rawPrisma directly, aliased to `prisma` so assertions below read naturally.
import { rawPrisma as prisma } from '@/db/raw-client'

async function makeOrgBranchService(schedulingType: 'FIXED_SESSION' | 'DYNAMIC') {
  const org = await prisma.organization.create({
    data: { name: 'Sched Test', slug: `sched-test-${Date.now()}-${Math.random()}` },
  })
  const branch = await prisma.branch.create({
    data: { organizationId: org.id, name: 'Main', timezone: 'UTC' },
  })
  const service = await prisma.service.create({
    data: {
      organizationId: org.id, name: 'Horse Riding', durationMinutes: 60, price: 50,
      schedulingType, customerBookingEnabled: true,
    },
  })
  return { org, branch, service }
}

describe('scheduling schema', () => {
  afterAll(async () => {
    await prisma.$disconnect()
  })

  it('links a Booking to its RidingSession and Customer', async () => {
    const { org, branch, service } = await makeOrgBranchService('FIXED_SESSION')
    const session = await prisma.ridingSession.create({
      data: {
        organizationId: org.id, branchId: branch.id, serviceId: service.id,
        startsAt: new Date(), endsAt: new Date(Date.now() + 3600_000), capacity: 4,
      },
    })
    const user = await prisma.user.create({
      data: { email: `book-${Date.now()}@test.com`, passwordHash: 'x', type: 'CUSTOMER', name: 'Booker' },
    })
    const customer = await prisma.customer.create({
      data: { organizationId: org.id, userId: user.id, firstName: 'Book', lastName: 'Er' },
    })
    const booking = await prisma.booking.create({
      data: {
        organizationId: org.id, customerId: customer.id, ridingSessionId: session.id,
        createdVia: 'CUSTOMER_SELF_SERVICE',
      },
    })
    expect(booking.status).toBe('PENDING')
  })

  it('allows only one CheckIn per booking (unique bookingId)', async () => {
    const { org, branch, service } = await makeOrgBranchService('FIXED_SESSION')
    const session = await prisma.ridingSession.create({
      data: {
        organizationId: org.id, branchId: branch.id, serviceId: service.id,
        startsAt: new Date(), endsAt: new Date(Date.now() + 3600_000), capacity: 4,
      },
    })
    const user = await prisma.user.create({
      data: { email: `book2-${Date.now()}@test.com`, passwordHash: 'x', type: 'CUSTOMER', name: 'Booker2' },
    })
    const customer = await prisma.customer.create({
      data: { organizationId: org.id, userId: user.id, firstName: 'Book', lastName: 'Two' },
    })
    const booking = await prisma.booking.create({
      data: {
        organizationId: org.id, customerId: customer.id, ridingSessionId: session.id,
        createdVia: 'STAFF',
      },
    })
    await prisma.checkIn.create({
      data: { organizationId: org.id, bookingId: booking.id, method: 'MANUAL', checkedInByStaffId: 'staff_x' },
    })
    await expect(
      prisma.checkIn.create({
        data: { organizationId: org.id, bookingId: booking.id, method: 'MANUAL', checkedInByStaffId: 'staff_x' },
      })
    ).rejects.toThrow()
  })
})
