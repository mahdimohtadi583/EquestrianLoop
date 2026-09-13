import { describe, it, expect, afterAll } from 'vitest'
import { prisma } from '@/db/client'
import { withTenantContext } from '@/server/tenant/context'
import { createCustomerAccount } from '@/server/actions/customer-auth'
import { verifyCredentials } from '@/server/auth/credentials'

describe('createCustomerAccount', () => {
  afterAll(async () => {
    await prisma.$disconnect()
  })

  it('creates a User(type=CUSTOMER) and Customer row with a qrToken, and can log in', async () => {
    const org = await prisma.organization.create({
      data: { name: 'Customer Auth Test', slug: `cust-auth-${Date.now()}` },
    })
    const email = `rider-${Date.now()}@test.com`

    const { userId, customerId, qrToken } = await createCustomerAccount({
      organizationId: org.id, email, password: 'rider-password-1', firstName: 'Rider', lastName: 'One',
    })

    expect(qrToken).toBeTruthy()
    const customer = await withTenantContext(org.id, (tx) => tx.customer.findUniqueOrThrow({ where: { id: customerId } }))
    expect(customer.userId).toBe(userId)
    expect(customer.qrToken).toBe(qrToken)

    const loggedIn = await verifyCredentials(email, 'rider-password-1')
    expect(loggedIn?.type).toBe('CUSTOMER')
  })

  it('rejects creating a second Customer profile for the same user in the same organization', async () => {
    const org = await prisma.organization.create({
      data: { name: 'Dup Customer Test', slug: `dup-cust-${Date.now()}` },
    })
    const email = `dup-${Date.now()}@test.com`
    await createCustomerAccount({ organizationId: org.id, email, password: 'password-1', firstName: 'A', lastName: 'B' })

    await expect(
      createCustomerAccount({ organizationId: org.id, email, password: 'password-1', firstName: 'A', lastName: 'B' })
    ).rejects.toThrow()
  })
})
