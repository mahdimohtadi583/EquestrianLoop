'use server'

import { z } from 'zod'
import { hashPassword } from '@/server/auth/password'
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
