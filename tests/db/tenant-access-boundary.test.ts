import { describe, it, expect } from 'vitest'
import { prisma, TenantScopedModelAccessError } from '@/db/client'

describe('tenant-access boundary', () => {
  it('blocks direct access to a tenant-scoped model (branch)', () => {
    expect(() => (prisma as unknown as { branch: unknown }).branch).toThrow(TenantScopedModelAccessError)
  })

  it('blocks $transaction, since its callback would hand back an unrestricted client', () => {
    expect(() => (prisma as unknown as { $transaction: unknown }).$transaction).toThrow(TenantScopedModelAccessError)
  })

  it('still allows the four platform-level models that exist as of this task (permission joins in Task 3)', () => {
    expect(() => prisma.user).not.toThrow()
    expect(() => prisma.organization).not.toThrow()
    expect(() => prisma.subscription).not.toThrow()
    expect(() => prisma.auditLog).not.toThrow()
  })

  // Regression tests for a bypass found in review: the `get` trap used to
  // forward `receiver` (the proxy) into `Reflect.get(target, prop, receiver)`
  // and blanket-allow every `_`-prefixed property "for Prisma internals".
  // Prisma's real internal machinery is reachable through exactly those
  // underscore-prefixed properties, so the blanket allowance defeated the
  // boundary entirely: `prisma._transactionWithCallback({ callback: (tx) =>
  // tx.branch.findMany() })` returned unrestricted tenant data, and
  // `prisma._request(...)` issued arbitrary unscoped queries directly. These
  // tests exercise the real proxy-wrapped client (no mocking of Prisma
  // internals) against each internal property the reviewer found exposed,
  // so they only pass if the boundary is actually closed, not merely
  // patched for the one example in the report.
  describe('blocks Prisma-internal escape hatches (regression for receiver-forwarding bypass)', () => {
    it('blocks prisma._request, the direct unscoped-query internal', () => {
      expect(() => (prisma as unknown as { _request: unknown })._request).toThrow(TenantScopedModelAccessError)
    })

    it('blocks prisma._transactionWithCallback, which hands back an unrestricted transaction client', () => {
      expect(() => (prisma as unknown as { _transactionWithCallback: unknown })._transactionWithCallback).toThrow(
        TenantScopedModelAccessError
      )
    })

    it('blocks prisma._engine, the raw query engine handle', () => {
      expect(() => (prisma as unknown as { _engine: unknown })._engine).toThrow(TenantScopedModelAccessError)
    })

    it('blocks prisma._executeRequest', () => {
      expect(() => (prisma as unknown as { _executeRequest: unknown })._executeRequest).toThrow(
        TenantScopedModelAccessError
      )
    })

    it('blocks prisma._transactionWithArray', () => {
      expect(() => (prisma as unknown as { _transactionWithArray: unknown })._transactionWithArray).toThrow(
        TenantScopedModelAccessError
      )
    })

    it('blocks prisma._createItxClient, the interactive-transaction client factory', () => {
      expect(() => (prisma as unknown as { _createItxClient: unknown })._createItxClient).toThrow(
        TenantScopedModelAccessError
      )
    })

    it('blocks prisma._originalClient', () => {
      expect(() => (prisma as unknown as { _originalClient: unknown })._originalClient).toThrow(
        TenantScopedModelAccessError
      )
    })
  })

  // Regression tests for the second gap the reviewer found: the old guard
  // only checked `typeof prop === 'string'`, so any symbol-keyed property
  // access skipped the allowlist check entirely and fell straight through
  // to Reflect.get.
  describe('symbol-keyed property access (regression for the string-only guard gap)', () => {
    it('blocks an arbitrary, unlisted symbol', () => {
      const probe = Symbol('probe')
      expect(() => (prisma as unknown as Record<symbol, unknown>)[probe]).toThrow(TenantScopedModelAccessError)
    })

    it('allows Symbol.toStringTag, which carries no query capability', () => {
      expect(() => (prisma as unknown as Record<symbol, unknown>)[Symbol.toStringTag]).not.toThrow()
    })

    it('allows Symbol.iterator, which carries no query capability', () => {
      expect(() => (prisma as unknown as Record<symbol, unknown>)[Symbol.iterator]).not.toThrow()
    })
  })

  // Confirms the fix didn't just block access but preserved real
  // functionality for everything still allowed: model delegates keep their
  // chained methods working, and $connect/$disconnect still work. This
  // matters specifically because the fix works by binding returned
  // functions to `target` instead of the proxy — if that binding were
  // wrong, these would be the calls that broke.
  describe('allowed access still works end-to-end after the fix', () => {
    it('exposes chainable methods on platform model delegates', () => {
      expect(typeof prisma.user.findUnique).toBe('function')
      expect(typeof prisma.organization.create).toBe('function')
      expect(typeof prisma.subscription.findMany).toBe('function')
      expect(typeof prisma.auditLog.create).toBe('function')
    })

    it('exposes $connect and $disconnect as callable functions', () => {
      expect(typeof prisma.$connect).toBe('function')
      expect(typeof prisma.$disconnect).toBe('function')
    })
  })
})
