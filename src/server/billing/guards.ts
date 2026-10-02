import { prisma } from '@/db/client'

export class OrganizationInactiveError extends Error {
  constructor(organizationId: string) {
    super(`Organization ${organizationId} does not have an active subscription`)
  }
}

export async function assertOrganizationActive(organizationId: string): Promise<void> {
  const subscription = await prisma.subscription.findUnique({ where: { organizationId } })
  if (subscription?.status !== 'ACTIVE') {
    throw new OrganizationInactiveError(organizationId)
  }
}
