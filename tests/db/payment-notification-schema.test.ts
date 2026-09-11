import { describe, it, expect, afterAll } from 'vitest'
// See the note in Task 3's rbac-schema.test.ts: schema-verification tests use
// rawPrisma directly, aliased to `prisma` so assertions below read naturally.
import { rawPrisma as prisma } from '@/db/raw-client'

describe('payment & notification schema', () => {
  afterAll(async () => {
    await prisma.$disconnect()
  })

  it('creates a PENDING payment by default', async () => {
    const org = await prisma.organization.create({
      data: { name: 'Payment Test', slug: `pay-test-${Date.now()}` },
    })
    const payment = await prisma.payment.create({
      data: { organizationId: org.id, amount: 50, currency: 'USD' },
    })
    expect(payment.status).toBe('PENDING')
  })

  it('creates an in-app notification with default PENDING status', async () => {
    const org = await prisma.organization.create({
      data: { name: 'Notif Test', slug: `notif-test-${Date.now()}` },
    })
    const notification = await prisma.notification.create({
      data: { organizationId: org.id, channel: 'IN_APP', type: 'BOOKING_CONFIRMED', payload: { bookingId: 'b1' } },
    })
    expect(notification.status).toBe('PENDING')
    expect(notification.sentAt).toBeNull()
  })
})
