import { describe, it, expect, afterAll } from 'vitest'
// See the note in Task 3's rbac-schema.test.ts: schema-verification tests use
// rawPrisma directly, aliased to `prisma` so assertions below read naturally.
import { rawPrisma as prisma } from '@/db/raw-client'

describe('loyalty schema', () => {
  afterAll(async () => {
    await prisma.$disconnect()
  })

  it('rejects a second LoyaltyTransaction with the same (organizationId, sourceType, sourceId)', async () => {
    const org = await prisma.organization.create({
      data: { name: 'Loyalty Test', slug: `loy-test-${Date.now()}` },
    })
    const user = await prisma.user.create({
      data: { email: `loy-${Date.now()}@test.com`, passwordHash: 'x', type: 'CUSTOMER', name: 'Loyal One' },
    })
    const customer = await prisma.customer.create({
      data: { organizationId: org.id, userId: user.id, firstName: 'Loyal', lastName: 'One' },
    })
    const account = await prisma.loyaltyAccount.create({
      data: { organizationId: org.id, customerId: customer.id },
    })
    const sessionId = 'session_abc'

    await prisma.loyaltyTransaction.create({
      data: {
        organizationId: org.id, loyaltyAccountId: account.id, type: 'EARN',
        points: 10, sourceType: 'SESSION_COMPLETION', sourceId: sessionId,
      },
    })

    await expect(
      prisma.loyaltyTransaction.create({
        data: {
          organizationId: org.id, loyaltyAccountId: account.id, type: 'EARN',
          points: 10, sourceType: 'SESSION_COMPLETION', sourceId: sessionId,
        },
      })
    ).rejects.toThrow()
  })

  it('allows multiple transactions with a null sourceId (e.g. manual adjustments)', async () => {
    const org = await prisma.organization.create({
      data: { name: 'Loyalty Test 2', slug: `loy-test2-${Date.now()}` },
    })
    const user = await prisma.user.create({
      data: { email: `loy2-${Date.now()}@test.com`, passwordHash: 'x', type: 'CUSTOMER', name: 'Loyal Two' },
    })
    const customer = await prisma.customer.create({
      data: { organizationId: org.id, userId: user.id, firstName: 'Loyal', lastName: 'Two' },
    })
    const account = await prisma.loyaltyAccount.create({
      data: { organizationId: org.id, customerId: customer.id },
    })

    await prisma.loyaltyTransaction.create({
      data: { organizationId: org.id, loyaltyAccountId: account.id, type: 'ADJUSTMENT', points: 5, sourceType: 'MANUAL_ADJUSTMENT' },
    })
    await prisma.loyaltyTransaction.create({
      data: { organizationId: org.id, loyaltyAccountId: account.id, type: 'ADJUSTMENT', points: -2, sourceType: 'MANUAL_ADJUSTMENT' },
    })

    const count = await prisma.loyaltyTransaction.count({ where: { loyaltyAccountId: account.id } })
    expect(count).toBe(2)
  })
})
