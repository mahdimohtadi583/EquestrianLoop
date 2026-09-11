import { describe, it, expect, afterAll } from 'vitest'
// See the note in Task 3's rbac-schema.test.ts: schema-verification tests use
// rawPrisma directly, aliased to `prisma` so assertions below read naturally.
import { rawPrisma as prisma } from '@/db/raw-client'

describe('customer & staff schema', () => {
  afterAll(async () => {
    await prisma.$disconnect()
  })

  it('generates a unique qrToken for each customer', async () => {
    const org = await prisma.organization.create({
      data: { name: 'QR Test', slug: `qr-test-${Date.now()}` },
    })
    const user = await prisma.user.create({
      data: { email: `cust-${Date.now()}@test.com`, passwordHash: 'x', type: 'CUSTOMER', name: 'Rider One' },
    })
    const customer = await prisma.customer.create({
      data: { organizationId: org.id, userId: user.id, firstName: 'Rider', lastName: 'One' },
    })
    expect(customer.qrToken).toBeTruthy()
  })

  it('links a Trainer to a Staff record 1:1', async () => {
    const org = await prisma.organization.create({
      data: { name: 'Trainer Test', slug: `trainer-test-${Date.now()}` },
    })
    const user = await prisma.user.create({
      data: { email: `staff2-${Date.now()}@test.com`, passwordHash: 'x', type: 'STAFF', name: 'Trainer One' },
    })
    const staff = await prisma.staff.create({ data: { organizationId: org.id, userId: user.id } })
    const trainer = await prisma.trainer.create({
      data: { staffId: staff.id, specialties: ['dressage'], certifications: [] },
    })
    expect(trainer.staffId).toBe(staff.id)
  })
})
