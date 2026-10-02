'use server'

import { prisma } from '@/db/client'
import { withTenantContext } from '@/server/tenant/context'
import { requireStaffRole } from '@/server/auth/guards'

export interface AuditLogEntry {
  id: string
  organizationId: string
  userId: string | null
  action: string
  resource: string
  resourceId: string | null
  metadata: any
  ipAddress: string | null
  createdAt: Date
}

export async function getAuditLogs(organizationId: string, options?: {
  limit?: number
  action?: string
  offset?: number
}): Promise<AuditLogEntry[]> {
  // Verify staff access
  await requireStaffRole(organizationId)

  const limit = options?.limit ?? 100
  const offset = options?.offset ?? 0
  const action = options?.action

  return withTenantContext(organizationId, async (tx) => {
    const where: Record<string, any> = {}

    if (action) {
      where.action = action
    }

    return tx.auditLog.findMany({
      where,
      orderBy: { createdAt: 'desc' },
      take: limit,
      skip: offset,
    })
  })
}
