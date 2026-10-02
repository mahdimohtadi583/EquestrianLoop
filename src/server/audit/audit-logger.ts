/**
 * Task 33: Audit Logging
 *
 * Fire-and-forget audit logging: logs action asynchronously without blocking caller.
 * Wraps in try/catch — NEVER throws, ensuring audit failures don't break business logic.
 */

import { prisma } from '@/db/client'
import { withTenantContext } from '@/server/tenant/context'

export interface AuditLogParams {
  organizationId: string
  userId?: string
  action: string
  resource: string
  resourceId?: string
  metadata?: Record<string, any>
  ipAddress?: string
}

export async function logAction(params: AuditLogParams): Promise<void> {
  // Fire-and-forget: never throw, return immediately
  try {
    const { organizationId, userId, action, resource, resourceId, metadata, ipAddress } = params

    // Log within tenant context to ensure RLS policies apply
    await withTenantContext(organizationId, async (tx) => {
      await tx.auditLog.create({
        data: {
          organizationId,
          userId: userId || null,
          action,
          resource,
          resourceId: resourceId || null,
          metadata: metadata as any,
          ipAddress: ipAddress || null,
        },
      })
    })
  } catch (err) {
    // CRITICAL: Never throw. Log failures to console for debugging but don't break caller.
    console.error('Audit log error:', err)
  }
}

// Action constants for consistency
export const AUDIT_ACTIONS = {
  USER_LOGIN: 'USER_LOGIN',
  BOOKING_CREATED: 'BOOKING_CREATED',
  BOOKING_CANCELLED: 'BOOKING_CANCELLED',
  HORSE_CREATED: 'HORSE_CREATED',
  HORSE_ARCHIVED: 'HORSE_ARCHIVED',
  MEMBERSHIP_CANCELLED: 'MEMBERSHIP_CANCELLED',
  PASSWORD_RESET: 'PASSWORD_RESET',
  EMAIL_VERIFIED: 'EMAIL_VERIFIED',
  LOYALTY_REDEEMED: 'LOYALTY_REDEEMED',
  REWARD_REDEEMED: 'REWARD_REDEEMED',
} as const
