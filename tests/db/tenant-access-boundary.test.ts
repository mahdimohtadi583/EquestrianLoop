import { describe, it, expect, afterAll } from 'vitest'
import * as util from 'node:util'
import { prisma, TenantScopedModelAccessError } from '@/db/client'
// `rawPrisma` is imported here only to assert the *underlying hazard* still
// exists in the generated Prisma client (e.g. `rawPrisma.user.$parent ===
// rawPrisma`). Without that assertion the $parent regression tests below would
// silently become vacuous the day Prisma removes the property, and would stop
// proving that it is *this module* closing the hole. Tests are one of the
// sanctioned importers of rawPrisma (see src/db/raw-client.ts).
import { rawPrisma } from '@/db/raw-client'

/** Keys the boundary is allowed to expose on `prisma`, and nothing else. */
const ALLOWED_CLIENT_KEYS = ['user', 'organization', 'subscription', 'auditLog', '$connect', '$disconnect']

/** Names that must never be observable through any operation on `prisma`. */
const DANGEROUS_CLIENT_KEYS = [
  '_engine',
  '_originalClient',
  '_request',
  '_executeRequest',
  '_transactionWithCallback',
  '_transactionWithArray',
  '_createItxClient',
  '_runtimeDataModel',
  '_requestHandler',
  '_extensions',
  'branch',
  '$transaction',
  '$queryRaw',
  '$queryRawUnsafe',
  '$executeRaw',
  '$executeRawUnsafe',
  '$extends',
  '$on',
]

const PLATFORM_MODELS = ['user', 'organization', 'subscription', 'auditLog'] as const

describe('tenant-access boundary', () => {
  afterAll(async () => {
    await prisma.$disconnect()
  })

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

  // =========================================================================
  // Fix round 2 regression tests.
  //
  // A reviewer proved that a Proxy defining only a `get` trap does not
  // intercept the other fundamental object operations: with the trap absent,
  // `getOwnPropertyDescriptor`, `ownKeys`, `has` and `getPrototypeOf` forward
  // straight to the *target*. Because the target was `rawPrisma` itself, the
  // allowlist could be walked around entirely:
  //
  //   const oc = Object.getOwnPropertyDescriptor(prisma, '_originalClient').value
  //   await oc.$transaction((tx) => tx.branch.findMany())   // <- executed live
  //
  // The fix stops wrapping `rawPrisma` and instead wraps a minimal object that
  // only ever received the allowed values, so those operations now forward to
  // something that structurally does not possess the dangerous properties.
  // These tests assert that structural absence — not merely that a `get` trap
  // throws — which is what makes them robust against the next un-trapped
  // operation someone thinks of.
  // =========================================================================
  describe('Proxy meta-operations cannot walk around the get trap (regression for the get-only-trap bypass)', () => {
    it('reproduces the reviewer exploit verbatim and confirms it has no starting handle', async () => {
      const descriptor = Object.getOwnPropertyDescriptor(prisma, '_originalClient')
      expect(descriptor).toBeUndefined()

      // The exploit's second half cannot even be attempted: there is no value
      // to call $transaction on. Assert that explicitly so the test documents
      // the whole chain being broken, not just its first link.
      const originalClient = descriptor === undefined ? undefined : (descriptor as PropertyDescriptor).value
      expect(originalClient).toBeUndefined()
    })

    it('does not expose _engine through getOwnPropertyDescriptor', () => {
      expect(Object.getOwnPropertyDescriptor(prisma, '_engine')).toBeUndefined()
    })

    it.each(DANGEROUS_CLIENT_KEYS)(
      'getOwnPropertyDescriptor(prisma, %s) is undefined — the key is absent from the target, not hidden',
      (key) => {
        expect(Object.getOwnPropertyDescriptor(prisma, key)).toBeUndefined()
      }
    )

    it('Reflect.ownKeys(prisma) exposes only the allowlisted members', () => {
      const stringKeys = Reflect.ownKeys(prisma).filter((k): k is string => typeof k === 'string')
      expect(stringKeys.sort()).toEqual([...ALLOWED_CLIENT_KEYS].sort())
    })

    it('Object.keys(prisma) exposes only the allowlisted members', () => {
      expect(Object.keys(prisma).sort()).toEqual([...ALLOWED_CLIENT_KEYS].sort())
    })

    it.each(DANGEROUS_CLIENT_KEYS)('Reflect.ownKeys(prisma) does not leak the name %s', (key) => {
      expect(Reflect.ownKeys(prisma).map(String)).not.toContain(key)
    })

    it.each(DANGEROUS_CLIENT_KEYS)('`%s in prisma` is false — the property genuinely is not there', (key) => {
      expect(key in prisma).toBe(false)
    })

    it('exposes only the two well-known formatting symbols, and no Prisma-internal symbol', () => {
      const symbolKeys = Reflect.ownKeys(prisma).filter((k): k is symbol => typeof k === 'symbol')
      expect(symbolKeys.sort((a, b) => a.toString().localeCompare(b.toString()))).toEqual([
        Symbol.for('nodejs.util.inspect.custom'),
        Symbol.toStringTag,
      ])
    })

    it('has a null prototype, so getPrototypeOf cannot walk back to the real client', () => {
      expect(Object.getPrototypeOf(prisma)).toBeNull()
      expect(Reflect.getPrototypeOf(prisma)).toBeNull()
    })

    it('leaks nothing through getOwnPropertyDescriptors / spread / Object.assign', () => {
      expect(Object.keys(Object.getOwnPropertyDescriptors(prisma)).sort()).toEqual([...ALLOWED_CLIENT_KEYS].sort())
      expect(Object.keys({ ...prisma }).sort()).toEqual([...ALLOWED_CLIENT_KEYS].sort())
      expect(Object.keys(Object.assign({}, prisma)).sort()).toEqual([...ALLOWED_CLIENT_KEYS].sort())
    })

    it('does not disclose internal names when inspected or logged', () => {
      const inspected = util.inspect(prisma)
      expect(inspected).toContain('PlatformScopedPrismaClient')
      for (const key of DANGEROUS_CLIENT_KEYS) {
        expect(inspected).not.toContain(key)
      }
      expect(Object.prototype.toString.call(prisma)).toBe('[object PlatformScopedPrismaClient]')
    })
  })

  // =========================================================================
  // The second, independent bypass found in the same review: it lives one
  // level deeper, on the model delegate, and is reachable through an
  // *allowed* access rather than through any gap in the outer proxy.
  //
  // Prisma's real delegate object carries an own `$parent` property that is
  // the full client itself, so `prisma.user.$parent.branch.findMany()` and
  // `prisma.user.$parent.$transaction((tx) => tx.branch.findMany())` were both
  // verified to execute live, unrestricted tenant queries. The fix rebuilds
  // each exposed delegate as a minimal object holding only its documented
  // query methods (pre-bound to the real delegate) plus `fields`, so `$parent`
  // is never copied across.
  // =========================================================================
  describe('model delegates cannot hand back the full client (regression for the $parent bypass)', () => {
    it('confirms the underlying hazard still exists on the raw client, so these tests are not vacuous', () => {
      // If this ever fails, Prisma changed its delegate shape and the tests
      // below must be re-derived against the new one rather than trusted.
      expect((rawPrisma.user as unknown as { $parent: unknown }).$parent).toBe(rawPrisma)
    })

    it.each(PLATFORM_MODELS)('prisma.%s.$parent throws instead of returning the client', (model) => {
      const delegate = prisma[model] as unknown as { $parent: unknown }
      expect(() => delegate.$parent).toThrow(TenantScopedModelAccessError)
    })

    it.each(PLATFORM_MODELS)('prisma.%s has no $parent to find via meta-operations either', (model) => {
      const delegate = prisma[model] as unknown as object
      expect(Object.getOwnPropertyDescriptor(delegate, '$parent')).toBeUndefined()
      expect('$parent' in delegate).toBe(false)
      expect(Reflect.ownKeys(delegate).map(String)).not.toContain('$parent')
      expect(Object.getPrototypeOf(delegate)).toBeNull()
    })

    it.each(PLATFORM_MODELS)('prisma.%s exposes no raw-command or internal escape hatch', (model) => {
      const delegate = prisma[model] as unknown as Record<string, unknown>
      const keys = Reflect.ownKeys(delegate).map(String)
      for (const forbidden of ['$parent', 'findRaw', 'aggregateRaw', '$transaction', 'branch', '_engine', '_request']) {
        expect(keys).not.toContain(forbidden)
        expect(forbidden in delegate).toBe(false)
        expect(Object.getOwnPropertyDescriptor(delegate, forbidden)).toBeUndefined()
        expect(() => delegate[forbidden]).toThrow(TenantScopedModelAccessError)
      }
    })

    it('exposes the full documented query surface of each delegate', () => {
      const expected = [
        'findUnique',
        'findUniqueOrThrow',
        'findFirst',
        'findFirstOrThrow',
        'findMany',
        'create',
        'createMany',
        'createManyAndReturn',
        'update',
        'updateMany',
        'updateManyAndReturn',
        'upsert',
        'delete',
        'deleteMany',
        'aggregate',
        'groupBy',
        'count',
      ]
      for (const model of PLATFORM_MODELS) {
        const delegate = prisma[model] as unknown as Record<string, unknown>
        for (const method of expected) {
          expect(typeof delegate[method]).toBe('function')
        }
        expect(typeof delegate.fields).toBe('object')
      }
    })

    it('hands out bound methods whose `this` cannot be re-targeted', () => {
      const findMany = prisma.organization.findMany as unknown as Record<string, unknown>
      // A bound function exposes only `length`/`name`; [[BoundThis]] is not
      // reachable from JavaScript, so handing out the method does not hand out
      // the delegate it is bound to.
      expect(Reflect.ownKeys(findMany).map(String).sort()).toEqual(['length', 'name'])
      expect(findMany.prototype).toBeUndefined()
    })
  })

  describe('the boundary objects cannot be mutated or re-pointed', () => {
    it('rejects grafting new properties onto prisma', () => {
      const mutable = prisma as unknown as Record<string, unknown>
      expect(() => {
        mutable.branch = { hacked: true }
      }).toThrow(TypeError)
      expect(() => Object.defineProperty(mutable, 'branch', { value: 1 })).toThrow(TypeError)
      expect('branch' in prisma).toBe(false)
    })

    it('rejects re-pointing the prototype at the real client', () => {
      expect(() => Object.setPrototypeOf(prisma, rawPrisma)).toThrow(TypeError)
      expect(Object.getPrototypeOf(prisma)).toBeNull()
    })

    it('rejects deleting an allowed member', () => {
      const mutable = prisma as unknown as Record<string, unknown>
      expect(() => {
        delete mutable.user
      }).toThrow(TypeError)
      expect(Object.keys(prisma)).toContain('user')
    })

    it('is not extensible', () => {
      expect(Object.isExtensible(prisma)).toBe(false)
      expect(Object.isExtensible(prisma.user as unknown as object)).toBe(false)
    })
  })

  // The round-1 tests above only asserted `typeof x === 'function'`, which
  // would still have passed if the rebuilt delegates were broken shells. These
  // run real queries through the boundary against the live database, so the
  // hardening is proven not to have cost any real capability.
  describe('allowed access works end-to-end against the live database', () => {
    it('runs a full create/read/update/delete cycle through the rebuilt delegates', async () => {
      await prisma.$connect()

      const slug = `boundary-e2e-${Date.now()}`
      const org = await prisma.organization.create({ data: { name: 'Boundary E2E', slug } })
      expect(org.slug).toBe(slug)

      const found = await prisma.organization.findUnique({ where: { id: org.id } })
      expect(found?.id).toBe(org.id)

      const many = await prisma.organization.findMany({ where: { slug }, take: 5 })
      expect(many).toHaveLength(1)

      expect(await prisma.organization.count({ where: { slug } })).toBe(1)

      const renamed = await prisma.organization.update({ where: { id: org.id }, data: { name: 'Renamed' } })
      expect(renamed.name).toBe('Renamed')

      const log = await prisma.auditLog.create({
        data: { actorUserId: 'boundary-test', action: 'E2E', entityType: 'Organization', entityId: org.id },
      })
      expect(log.id).toBeTruthy()

      await expect(prisma.user.findUnique({ where: { email: `${slug}@example.com` } })).resolves.toBeNull()
      await expect(prisma.subscription.findMany({ where: { organizationId: org.id } })).resolves.toEqual([])
      await expect(prisma.user.aggregate({ _count: true })).resolves.toBeTruthy()

      await prisma.auditLog.delete({ where: { id: log.id } })
      await prisma.organization.delete({ where: { id: org.id } })
      await expect(prisma.organization.findUnique({ where: { id: org.id } })).resolves.toBeNull()
      // Explicit timeout: this is a dozen sequential round-trips to a remote
      // Supabase pooler, which can exceed vitest's 5s default on a cold
      // connection. Nothing about the boundary itself is slow.
    }, 30_000)

    it('still carries usable field metadata', () => {
      expect(Object.keys(prisma.user.fields)).toContain('email')
    })
  })
})
