'use server'

import { z } from 'zod'
import { hashPassword } from '@/server/auth/password'
import { withTenantContext } from '@/server/tenant/context'

const createStaffAccountSchema = z.object({
  organizationId: z.string(),
  email: z.string().email(),
  password: z.string().min(8),
  name: z.string().min(1),
  roleId: z.string(),
  branchId: z.string().optional(),
})

export async function createStaffAccount(input: z.infer<typeof createStaffAccountSchema>) {
  const data = createStaffAccountSchema.parse(input)
  const passwordHash = await hashPassword(data.password)

  // User is a platform-level model, but it's created inside the same withTenantContext
  // transaction as the tenant-scoped Staff/Membership rows so all three commit atomically —
  // there is no separate prisma.$transaction path available (Task 2 blocks it), and there
  // doesn't need to be: withTenantContext's tx already has every model, User included.
  return withTenantContext(data.organizationId, async (tx) => {
    const user = await tx.user.create({
      data: { email: data.email, passwordHash, type: 'STAFF', name: data.name },
    })
    const staff = await tx.staff.create({
      data: { organizationId: data.organizationId, branchId: data.branchId, userId: user.id },
    })
    await tx.membership.create({
      data: {
        userId: user.id,
        organizationId: data.organizationId,
        branchId: data.branchId,
        roleId: data.roleId,
        acceptedAt: new Date(),
      },
    })
    return { userId: user.id, staffId: staff.id }
  })
}
