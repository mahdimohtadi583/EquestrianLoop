import { describe, it, expect } from 'vitest'
import { prisma, TenantScopedModelAccessError } from '@/db/client'

describe('tenant-access boundary', () => {
  it('blocks direct access to a tenant-scoped model (branch)', () => {
    expect(() => (prisma as unknown as { branch: unknown }).branch).toThrow(TenantScopedModelAccessError)
  })

  it('blocks $transaction, since its callback would hand back an unrestricted client', () => {
    expect(() => (prisma as unknown as { $transaction: unknown }).$transaction).toThrow(TenantScopedModelAccessError)
  })

  it('still allows the five platform-level models', () => {
    expect(() => prisma.user).not.toThrow()
    expect(() => prisma.organization).not.toThrow()
    expect(() => prisma.subscription).not.toThrow()
    expect(() => prisma.auditLog).not.toThrow()
    expect(() => prisma.permission).not.toThrow()
  })
})
