'use server'

import { z } from 'zod'
import { hashPassword, verifyPassword } from '@/server/auth/password'
import { withTenantContext } from '@/server/tenant/context'

const createCustomerAccountSchema = z.object({
  organizationId: z.string(),
  email: z.string().email(),
  password: z.string().min(8),
  firstName: z.string().min(1),
  lastName: z.string().min(1),
  phone: z.string().optional(),
})

export async function createCustomerAccount(input: z.infer<typeof createCustomerAccountSchema>) {
  const data = createCustomerAccountSchema.parse(input)

  // Same reasoning as createStaffAccount (Task 11): User is platform-level but is created
  // inside the same withTenantContext transaction as the tenant-scoped Customer row so both
  // commit atomically, without needing a separate (blocked) prisma.$transaction path.
  return withTenantContext(data.organizationId, async (tx) => {
    let user = await tx.user.findUnique({ where: { email: data.email } })
    if (!user) {
      user = await tx.user.create({
        data: {
          email: data.email,
          passwordHash: await hashPassword(data.password),
          type: 'CUSTOMER',
          name: `${data.firstName} ${data.lastName}`,
          phone: data.phone,
        },
      })
    } else {
      // SECURITY: an email match against an existing User (of any type, from any
      // organization — User.email is globally unique) must never be treated as proof
      // of identity on its own. Without this check, anyone who knows a victim's email
      // could call this action with an attacker-chosen password and have it silently
      // attach a brand-new Customer profile (with a live qrToken) to the victim's real
      // account, in an organization of the attacker's choosing — without ever knowing
      // the victim's actual password. Requiring the submitted password to match the
      // existing account's passwordHash preserves the legitimate case (an existing
      // platform User — e.g. a staff account from Task 11 — creating their first
      // Customer profile) while failing closed on everyone else. Customer.userId is
      // globally @unique, so a User can never hold more than one Customer row at all.
      const passwordMatches = await verifyPassword(data.password, user.passwordHash)
      if (!passwordMatches) {
        throw new Error('An account with this email already exists.')
      }
    }
    const customer = await tx.customer.create({
      data: {
        organizationId: data.organizationId,
        userId: user.id,
        firstName: data.firstName,
        lastName: data.lastName,
        phone: data.phone,
      },
    })
    return { userId: user.id, customerId: customer.id, qrToken: customer.qrToken }
  })
}
