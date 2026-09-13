import { describe, it, expect, afterAll, vi } from 'vitest'
import { prisma } from '@/db/client'
import { withTenantContext } from '@/server/tenant/context'
import { createCustomerAccount } from '@/server/actions/customer-auth'
import { verifyCredentials } from '@/server/auth/credentials'
import { hashPassword } from '@/server/auth/password'

// This file round-trips the live Supabase pooler multiple times per test plus
// several bcrypt hashes/compares at cost 12, and reliably exceeds vitest's
// 5000ms default under full-suite parallel load. Same fix already applied in
// tests/server/staff-auth.test.ts and the other live-DB suites in this repo.
vi.setConfig({ testTimeout: 30_000 })

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

  it('rejects attaching a new Customer profile to an existing account when the submitted password is wrong', async () => {
    const orgA = await prisma.organization.create({
      data: { name: 'Victim Org', slug: `victim-org-${Date.now()}` },
    })
    const orgB = await prisma.organization.create({
      data: { name: 'Attacker Org', slug: `attacker-org-${Date.now()}` },
    })
    const email = `victim-${Date.now()}@test.com`

    // The real account holder signs up in Org A with their real password.
    await createCustomerAccount({
      organizationId: orgA.id, email, password: 'victim-real-password', firstName: 'Vic', lastName: 'Tim',
    })

    // An attacker who only knows the victim's email tries to attach a Customer
    // profile to that same account in a different organization, guessing a password.
    await expect(
      createCustomerAccount({
        organizationId: orgB.id, email, password: 'attacker-guessed-password', firstName: 'Mal', lastName: 'Ory',
      })
    ).rejects.toThrow()

    // No Customer row should have been created for the attacker's organization.
    const orgBCustomers = await withTenantContext(orgB.id, (tx) =>
      tx.customer.findMany({ where: { organizationId: orgB.id } })
    )
    expect(orgBCustomers).toHaveLength(0)
  })

  it('allows an existing platform User (e.g. a staff account) to create their first Customer profile using their correct password', async () => {
    const org = await prisma.organization.create({
      data: { name: 'Staff Also Customer Org', slug: `staff-cust-${Date.now()}` },
    })
    const email = `staffcust-${Date.now()}@test.com`
    const password = 'correct-password-1'

    // A platform User already exists with this email (e.g. created via Task 11's
    // createStaffAccount) but has never had a Customer profile — Customer.userId is
    // globally unique, so this is the only legitimate shape of "existing user" reuse.
    const existingUser = await prisma.user.create({
      data: { email, passwordHash: await hashPassword(password), type: 'STAFF', name: 'Existing Staffer' },
    })

    const result = await createCustomerAccount({
      organizationId: org.id, email, password, firstName: 'Existing', lastName: 'Staffer',
    })

    expect(result.userId).toBe(existingUser.id)
    const customer = await withTenantContext(org.id, (tx) =>
      tx.customer.findUniqueOrThrow({ where: { id: result.customerId } })
    )
    expect(customer.userId).toBe(existingUser.id)
  })
})
