import { describe, it, expect, afterAll, beforeAll } from 'vitest'
import { prisma } from '@/db/client'
import { withTenantContext } from '@/server/tenant/context'
import { createStaffAccount } from '@/server/actions/staff-auth'
import { createCustomerAccount } from '@/server/actions/customer-auth'

/**
 * Task 16: Authentication Server Actions Tests
 *
 * Tests for sign-up/registration server actions:
 * 1. createStaffAccount - creates staff user and staff record
 * 2. createCustomerAccount - creates customer user and customer record
 *
 * These actions are called by the sign-up pages.
 */

let testOrgId: string

describe('Authentication Server Actions', () => {
  beforeAll(async () => {
    const org = await prisma.organization.create({
      data: {
        name: `Auth Test Org ${Date.now()}`,
        slug: `auth-test-${Date.now()}`,
      },
    })
    testOrgId = org.id
  })

  afterAll(async () => {
    await prisma.$disconnect()
  })

  describe('createStaffAccount', () => {
    it('creates a staff user with email, password, name', async () => {
      const result = await createStaffAccount({
        organizationId: testOrgId,
        email: `staff-${Date.now()}@test.com`,
        password: 'password123',
        name: 'Test Staff',
        roleId: 'admin',
      })

      expect(result.userId).toBeDefined()
      expect(result.staffId).toBeDefined()

      // Verify user was created
      const user = await prisma.user.findUnique({
        where: { id: result.userId },
      })
      expect(user).toBeDefined()
      expect(user?.email).toBe(`staff-${Date.now()}@test.com`)
      expect(user?.type).toBe('STAFF')
      expect(user?.name).toBe('Test Staff')
    })

    it('creates a staff record within the organization', async () => {
      const email = `staff-org-${Date.now()}@test.com`
      const result = await createStaffAccount({
        organizationId: testOrgId,
        email,
        password: 'password123',
        name: 'Staff in Org',
        roleId: 'manager',
      })

      // Verify staff record was created
      const staff = await withTenantContext(testOrgId, (tx) =>
        tx.staff.findUnique({
          where: { userId: result.userId },
        })
      )
      expect(staff).toBeDefined()
      expect(staff?.organizationId).toBe(testOrgId)

      // Verify role is stored in membership
      const membership = await withTenantContext(testOrgId, (tx) =>
        tx.membership.findFirst({
          where: { userId: result.userId },
        })
      )
      expect(membership?.roleId).toBe('manager')
    })

    it('creates membership record for the staff', async () => {
      const result = await createStaffAccount({
        organizationId: testOrgId,
        email: `staff-member-${Date.now()}@test.com`,
        password: 'password123',
        name: 'Staff Member',
        roleId: 'staff',
      })

      // Verify membership was created
      const membership = await withTenantContext(testOrgId, (tx) =>
        tx.membership.findFirst({
          where: { userId: result.userId },
        })
      )
      expect(membership).toBeDefined()
      expect(membership?.organizationId).toBe(testOrgId)
    })

    it('rejects duplicate email', async () => {
      const email = `duplicate-staff-${Date.now()}@test.com`

      // First signup
      await createStaffAccount({
        organizationId: testOrgId,
        email,
        password: 'password123',
        name: 'First Staff',
        roleId: 'admin',
      })

      // Second signup with same email should fail
      let error: Error | null = null
      try {
        await createStaffAccount({
          organizationId: testOrgId,
          email,
          password: 'password123',
          name: 'Second Staff',
          roleId: 'admin',
        })
      } catch (err) {
        error = err as Error
      }

      expect(error).toBeDefined()
      expect(error?.message).toContain('unique')
    })
  })

  describe('createCustomerAccount', () => {
    it('creates a customer user with email, password, firstName, lastName', async () => {
      const result = await createCustomerAccount({
        organizationId: testOrgId,
        email: `customer-${Date.now()}@test.com`,
        password: 'password123',
        firstName: 'John',
        lastName: 'Doe',
      })

      expect(result.userId).toBeDefined()
      expect(result.customerId).toBeDefined()
      expect(result.qrToken).toBeDefined()

      // Verify user was created
      const user = await prisma.user.findUnique({
        where: { id: result.userId },
      })
      expect(user).toBeDefined()
      expect(user?.type).toBe('CUSTOMER')
    })

    it('creates a customer record within the organization', async () => {
      const result = await createCustomerAccount({
        organizationId: testOrgId,
        email: `customer-org-${Date.now()}@test.com`,
        password: 'password123',
        firstName: 'Jane',
        lastName: 'Smith',
      })

      // Verify customer record was created
      const customer = await withTenantContext(testOrgId, (tx) =>
        tx.customer.findUnique({
          where: { id: result.customerId },
        })
      )
      expect(customer).toBeDefined()
      expect(customer?.organizationId).toBe(testOrgId)
      expect(customer?.firstName).toBe('Jane')
      expect(customer?.lastName).toBe('Smith')
    })

    it('generates a QR token for customer', async () => {
      const result = await createCustomerAccount({
        organizationId: testOrgId,
        email: `customer-qr-${Date.now()}@test.com`,
        password: 'password123',
        firstName: 'Token',
        lastName: 'User',
      })

      expect(result.qrToken).toBeDefined()
      expect(result.qrToken).toMatch(/^[a-f0-9]+$/)
    })

    it('rejects duplicate email', async () => {
      const email = `duplicate-customer-${Date.now()}@test.com`

      // First signup
      await createCustomerAccount({
        organizationId: testOrgId,
        email,
        password: 'password123',
        firstName: 'First',
        lastName: 'Customer',
      })

      // Second signup with same email should fail
      let error: Error | null = null
      try {
        await createCustomerAccount({
          organizationId: testOrgId,
          email,
          password: 'password123',
          firstName: 'Second',
          lastName: 'Customer',
        })
      } catch (err) {
        error = err as Error
      }

      expect(error).toBeDefined()
    })

    it('requires password when email already exists', async () => {
      const email = `verify-pwd-${Date.now()}@test.com`

      // Create a customer user without customer record
      await prisma.user.create({
        data: {
          email,
          passwordHash: 'x',
          type: 'CUSTOMER',
          name: 'Existing User',
        },
      })

      // Try to create customer with same email - should validate password
      let error: Error | null = null
      try {
        await createCustomerAccount({
          organizationId: testOrgId,
          email,
          password: 'wrong-password',
          firstName: 'New',
          lastName: 'Customer',
        })
      } catch (err) {
        error = err as Error
      }

      expect(error).toBeDefined()
      expect(error?.message).toContain('password')
    })
  })
})
