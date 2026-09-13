import { describe, it, expect, afterAll, beforeAll } from 'vitest'
import * as util from 'node:util'
import { Prisma } from '@prisma/client'
import { prisma, TenantScopedModelAccessError } from '@/db/client'
// `rawPrisma` is imported here only to assert the *underlying hazard* still
// exists in the generated Prisma client (e.g. `rawPrisma.user.$parent ===
// rawPrisma`). Without that assertion the $parent regression tests below would
// silently become vacuous the day Prisma removes the property, and would stop
// proving that it is *this module* closing the hole. Tests are one of the
// sanctioned importers of rawPrisma (see src/db/raw-client.ts).
import { rawPrisma } from '@/db/raw-client'

/** Keys the boundary is allowed to expose on `prisma`, and nothing else. */
const ALLOWED_CLIENT_KEYS = ['user', 'organization', 'subscription', 'auditLog', 'permission', '$connect', '$disconnect']

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
  'customer',
  'staff',
  'trainer',
  'horse',
  'service',
  'blockedTime',
  'ridingSession',
  'booking',
  'checkIn',
  'membershipPlan',
  'membershipPlanService',
  'membershipPlanBranch',
  'customerMembership',
  'loyaltyAccount',
  'loyaltyTransaction',
  'reward',
  'rewardRedemption',
  'payment',
  'notification',
  '$transaction',
  '$queryRaw',
  '$queryRawUnsafe',
  '$executeRaw',
  '$executeRawUnsafe',
  '$extends',
  '$on',
]

const PLATFORM_MODELS = ['user', 'organization', 'subscription', 'auditLog'] as const

/**
 * Fix round 3's exploits are, by construction, argument shapes the generated
 * Prisma types *accept* — that was half the finding: `npx tsc --noEmit` was
 * clean on every one of them. They are cast through this alias so the tests
 * exercise the runtime guard rather than being rewritten into shapes the
 * compiler happens to like.
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Loose = any

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

  it('still allows the five platform-level models', () => {
    expect(() => prisma.user).not.toThrow()
    expect(() => prisma.organization).not.toThrow()
    expect(() => prisma.subscription).not.toThrow()
    expect(() => prisma.auditLog).not.toThrow()
    expect(() => prisma.permission).not.toThrow()
  })

  // Task 3 regression: `permission` newly joined PLATFORM_MODEL_KEYS alongside
  // the other four models. `Permission.roles: RolePermission[]` is a real
  // relation the RBAC schema adds, so this proves the existing generic
  // guard/seal machinery (assertNoRelationTraversal, sealMinimalTarget)
  // applies to it automatically — no Permission-specific logic was added.
  describe('prisma.permission gets the same protections as the other platform models (Task 3)', () => {
    it('prisma.permission.findMany() works against the live database', async () => {
      const rows = await prisma.permission.findMany()
      expect(Array.isArray(rows)).toBe(true)
    })

    it('prisma.permission.findMany({ include: { roles: true } }) throws — Permission.roles is a real relation', () => {
      expect(() => (prisma.permission as Loose).findMany({ include: { roles: true } })).toThrow(
        TenantScopedModelAccessError
      )
    })

    it('prisma.permission has no $parent, matching the other four delegates', () => {
      const delegate = prisma.permission as unknown as { $parent: unknown }
      expect(() => delegate.$parent).toThrow(TenantScopedModelAccessError)
      expect(Object.getOwnPropertyDescriptor(delegate, '$parent')).toBeUndefined()
      expect('$parent' in delegate).toBe(false)
      expect(Reflect.ownKeys(delegate as object).map(String)).not.toContain('$parent')
    })
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

    it('exposes only scalar field refs in `fields`, so it is not a relation-traversal vector either', () => {
      // If a relation ever appeared here it would be a FieldRef the caller
      // could feed back into a query; confirm the generated metadata is
      // scalar-only for every exposed delegate.
      expect(Object.keys(prisma.organization.fields)).not.toContain('branches')
      expect(Object.keys(prisma.organization.fields)).not.toContain('subscription')
      expect(Object.keys(prisma.subscription.fields)).not.toContain('organization')
    })
  })

  // =========================================================================
  // Fix round 3 regression tests: the relation-traversal bypass.
  //
  // Rounds 1 and 2 were about *object identity* — which handles the boundary
  // hands out — and both are intact. This one is a different class entirely:
  // the delegates the boundary legitimately hands out were pre-bound to the
  // real Prisma delegate and accepted the full Prisma argument shape, and
  // Prisma expresses relation traversal in the arguments. An adversarial
  // reviewer proved, live against Supabase and with `tsc --noEmit` clean,
  // that the whole tenant-scoped `Branch` table was readable and writable
  // through the *allowed* `organization` delegate using ordinary syntax.
  //
  // Every exploit below was re-run against the pre-fix code first and
  // confirmed to SUCCEED, so none of these tests is vacuous.
  // =========================================================================
  describe('relation traversal through query arguments (regression for the round-3 bypass)', () => {
    /** A throwaway Organization the read-side exploits can aim at. */
    let orgId = ''
    let orgSlug = ''

    beforeAll(async () => {
      orgSlug = `relguard-${Date.now()}`
      const org = await prisma.organization.create({ data: { name: 'Relation Guard', slug: orgSlug } })
      orgId = org.id
    }, 30_000)

    afterAll(async () => {
      if (orgId) {
        await prisma.organization.delete({ where: { id: orgId } })
      }
    }, 30_000)

    it('confirms the relations these tests target really exist in the datamodel, so they are not vacuous', () => {
      const relationNamesOf = (modelName: string) =>
        Prisma.dmmf.datamodel.models
          .find((model) => model.name === modelName)!
          .fields.filter((field) => field.kind === 'object')
          .map((field) => field.name)

      // If a later task removes these relations, these tests must be
      // re-derived rather than silently passing against a schema that can no
      // longer express the exploit. `memberships`/`roles` on Organization and
      // `memberships` on User are Task 3 additions (RBAC schema); `customers`/
      // `staffMembers`/`horses` on Organization and `customer`/`staff` on User
      // are Task 4 additions (Customer/Staff/Trainer/Horse schema);
      // `services`/`blockedTimes`/`ridingSessions`/`bookings`/`checkIns` on
      // Organization are Task 5 additions (Service Catalog & Scheduling
      // schema); `membershipPlans`/`customerMemberships` on Organization are
      // Task 6 additions (MembershipPlan/CustomerMembership schema);
      // `loyaltyAccounts`/`loyaltyTransactions`/`rewards`/`rewardRedemptions`
      // on Organization are Task 7 additions (Loyalty & Rewards schema).
      // `payments`/`notifications` on Organization are Task 8 additions
      // (Payment & Notification schema). None of these affect the
      // branches/subscription exploit paths this test protects, but the
      // pinned list must still reflect the real datamodel.
      expect(relationNamesOf('Organization').sort()).toEqual([
        'blockedTimes',
        'bookings',
        'branches',
        'checkIns',
        'customerMemberships',
        'customers',
        'horses',
        'loyaltyAccounts',
        'loyaltyTransactions',
        'membershipPlans',
        'memberships',
        'notifications',
        'payments',
        'rewardRedemptions',
        'rewards',
        'ridingSessions',
        'roles',
        'services',
        'staffMembers',
        'subscription',
      ])
      expect(relationNamesOf('Subscription')).toEqual(['organization'])
      expect(relationNamesOf('User')).toEqual(['memberships', 'customers', 'staff'])
      expect(relationNamesOf('AuditLog')).toEqual([])
      // And `Branch` — the tenant-scoped target — is genuinely reachable from
      // Organization in the schema, which is what made the exploit possible.
      expect(relationNamesOf('Organization')).toContain('branches')
    })

    // The guard runs at call time, before Prisma is reached, so it throws
    // synchronously rather than returning a rejected PrismaPromise. That is
    // deliberate and matches the rest of this boundary (a blocked property
    // access throws synchronously too): the stack points at the offending call
    // site, not at an await somewhere downstream. `blocked()` pins that.
    const blocked = (call: () => unknown) => expect(call).toThrow(TenantScopedModelAccessError)

    // --- the reviewer's five proof-of-concepts, verbatim -------------------

    it('PoC 1: findUnique + include of a tenant-scoped relation throws', () => {
      blocked(() => (prisma.organization as Loose).findUnique({ where: { id: orgId }, include: { branches: true } }))
    })

    it('PoC 2: findUnique + object-form select of a tenant-scoped relation throws', () => {
      blocked(() =>
        (prisma.organization as Loose).findUnique({
          where: { id: orgId },
          select: { id: true, branches: { select: { name: true } } },
        })
      )
    })

    it('PoC 3: create with a nested relation write (creating a real Branch row) throws', async () => {
      blocked(() =>
        (prisma.organization as Loose).create({
          data: {
            name: 'Nested Create',
            slug: `${orgSlug}-nested`,
            branches: { create: { name: 'x', timezone: 'UTC' } },
          },
        })
      )
      // And nothing was written: the guard runs before Prisma sees the call.
      expect(await prisma.organization.count({ where: { slug: `${orgSlug}-nested` } })).toBe(0)
    }, 30_000)

    it('PoC 4: update with a nested relation deleteMany throws', () => {
      blocked(() =>
        (prisma.organization as Loose).update({ where: { id: orgId }, data: { branches: { deleteMany: {} } } })
      )
    })

    it('PoC 5: the two-hop include (subscription -> organization -> branches) throws at the first hop', () => {
      blocked(() =>
        (prisma.subscription as Loose).findUnique({
          where: { organizationId: orgId },
          include: { organization: { include: { branches: true } } },
        })
      )
    })

    it('PoC 5b: the same two-hop expressed with select instead of include throws', () => {
      blocked(() =>
        (prisma.subscription as Loose).findUnique({
          where: { organizationId: orgId },
          select: { id: true, organization: { select: { branches: true } } },
        })
      )
    })

    // --- argument shapes the reviewer did not try --------------------------

    it('blocks a relation filter in `where`, which leaks tenant-row existence via the result set', () => {
      blocked(() => (prisma.organization as Loose).findMany({ where: { branches: { some: {} } }, take: 3 }))
    })

    it('blocks a relation filter hidden inside nested AND/OR/NOT combinators, not just at the top level', () => {
      // A shallow top-level scan of `where` would have let this straight
      // through — the relation key is four levels down.
      blocked(() =>
        (prisma.organization as Loose).findMany({
          where: { AND: [{ OR: [{ NOT: { branches: { some: {} } } }] }] },
          take: 3,
        })
      )
    })

    it('blocks a relation filter in `cursor`, which is a WhereUniqueInput and accepts relation filters too', () => {
      blocked(() =>
        (prisma.organization as Loose).findMany({
          where: { slug: orgSlug },
          cursor: { branches: { some: {} } },
          take: 1,
        })
      )
    })

    it('blocks ordering by a relation', () => {
      blocked(() => (prisma.organization as Loose).findMany({ orderBy: { branches: { _count: 'desc' } }, take: 3 }))
    })

    it('blocks ordering by a relation inside the array form of orderBy', () => {
      blocked(() =>
        (prisma.organization as Loose).findMany({
          orderBy: [{ name: 'asc' }, { branches: { _count: 'desc' } }],
          take: 3,
        })
      )
    })

    it('blocks _count of a relation requested through select', () => {
      blocked(() =>
        (prisma.organization as Loose).findMany({ select: { id: true, _count: { select: { branches: true } } }, take: 3 })
      )
    })

    it('blocks _count of a relation requested through include', () => {
      blocked(() =>
        (prisma.organization as Loose).findUnique({
          where: { id: orgId },
          include: { _count: { select: { branches: true } } },
        })
      )
    })

    it('blocks a relation key in updateMany data', () => {
      blocked(() =>
        (prisma.organization as Loose).updateMany({
          where: { slug: orgSlug },
          data: { branches: { deleteMany: {} } },
        })
      )
    })

    it('blocks a relation key inside a createMany data array element', async () => {
      blocked(() =>
        (prisma.organization as Loose).createMany({
          data: [{ name: 'cm', slug: `${orgSlug}-cm`, branches: { create: { name: 'y', timezone: 'UTC' } } }],
        })
      )
      expect(await prisma.organization.count({ where: { slug: `${orgSlug}-cm` } })).toBe(0)
    }, 30_000)

    it("blocks a relation key in upsert's create and update branches", async () => {
      blocked(() =>
        (prisma.organization as Loose).upsert({
          where: { slug: `${orgSlug}-upsert` },
          create: { name: 'u', slug: `${orgSlug}-upsert`, branches: { create: { name: 'z', timezone: 'UTC' } } },
          update: {},
        })
      )
      blocked(() =>
        (prisma.organization as Loose).upsert({
          where: { slug: `${orgSlug}-upsert` },
          create: { name: 'u', slug: `${orgSlug}-upsert` },
          update: { branches: { deleteMany: {} } },
        })
      )
      expect(await prisma.organization.count({ where: { slug: `${orgSlug}-upsert` } })).toBe(0)
    }, 30_000)

    it('blocks a relation filter reached through groupBy', () => {
      blocked(() =>
        (prisma.organization as Loose).groupBy({ by: ['slug'], where: { branches: { some: {} } }, _count: true })
      )
    })

    it('blocks a relation filter reached through aggregate and count', () => {
      blocked(() => (prisma.organization as Loose).aggregate({ where: { branches: { some: {} } }, _count: true }))
      blocked(() => (prisma.organization as Loose).count({ where: { branches: { some: {} } } }))
    })

    it('blocks a relation filter reached through deleteMany, the most destructive shape', () => {
      blocked(() => (prisma.organization as Loose).deleteMany({ where: { branches: { some: {} } } }))
    })

    it('blocks the platform-to-platform hop too (Subscription -> Organization), not only the tenant-scoped one', () => {
      // The rule is categorical by design: hand-picking which relations are
      // "dangerous today" is the maintenance trap this guard exists to avoid,
      // since Tasks 3-21 keep adding relations. Two queries express this.
      blocked(() =>
        (prisma.subscription as Loose).create({
          data: {
            organization: { connect: { id: orgId } },
            provider: 'stripe',
            providerCustomerId: 'cus_guard',
            planId: 'p',
          },
        })
      )
    })

    it('applies to every one of the four delegates, including the two with no relations at all', () => {
      // User and AuditLog have no relation fields, so nothing can be rejected
      // by name there — but `include` is still refused categorically, which is
      // what keeps the guard uniform rather than per-model.
      for (const model of PLATFORM_MODELS) {
        blocked(() => (prisma[model] as Loose).findMany({ include: {} }))
      }
    })

    it('guards every one of the 17 exposed delegate methods, not just the ones with a PoC', () => {
      // The guard is applied by one wrapper factory in buildPlatformDelegate,
      // so this asserts the wiring is uniform rather than per-method.
      const methods = [
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
      for (const method of methods) {
        blocked(() => (prisma.organization as Loose)[method]({ include: { branches: true } }))
        blocked(() => (prisma.organization as Loose)[method]({ where: { branches: { some: {} } } }))
      }
    })

    // --- deliberate design decisions, pinned so they cannot drift ----------

    it('rejects an empty `include: {}` as well (documented decision: include is refused categorically)', () => {
      // `include` has exactly one purpose in Prisma — fetching related records
      // — so there is no scalar-only use of it to preserve, and refusing the
      // key rather than its contents is what closes the two-hop case. An empty
      // include is meaningless code, so nothing legitimate is lost.
      blocked(() => (prisma.organization as Loose).findUnique({ where: { id: orgId }, include: {} }))
    })

    it('treats include: undefined and include: null as absent, exactly as Prisma does', async () => {
      // `include: cond ? {...} : undefined` is an ordinary pattern, and
      // Prisma's own types spell "no include" as `| null`.
      await expect(
        (prisma.organization as Loose).findUnique({ where: { id: orgId }, include: undefined })
      ).resolves.toMatchObject({ id: orgId })
      await expect(
        (prisma.organization as Loose).findUnique({ where: { id: orgId }, include: null })
      ).resolves.toMatchObject({ id: orgId })
    }, 30_000)

    it('allows `select: { <relation>: false }`, which explicitly asks for nothing', async () => {
      await expect(
        (prisma.organization as Loose).findUnique({ where: { id: orgId }, select: { id: true, branches: false } })
      ).resolves.toEqual({ id: orgId })
    }, 30_000)

    it('refuses an argument key it does not recognise rather than forwarding it unexamined', () => {
      // Deny-by-default on the argument surface: if a future Prisma version
      // adds a new way to express relation access, it fails loudly here
      // instead of sailing past a scan written for the old shapes.
      blocked(() => (prisma.organization as Loose).findMany({ where: { id: orgId }, relationLoadStrategy: 'join' }))
    })

    it('refuses extra positional arguments, which the guard has not inspected', () => {
      blocked(() =>
        (prisma.organization as Loose).findMany({ where: { id: orgId } }, { include: { branches: true } })
      )
    })

    it('refuses arguments that are not a plain object, so no snapshot can silently widen a query', () => {
      blocked(() => (prisma.organization as Loose).deleteMany(new Date()))
      blocked(() => (prisma.organization as Loose).findMany([]))
    })

    // --- the two vectors an argument guard is structurally exposed to ------

    it('sees relation keys inherited from a prototype, which Prisma itself reads', () => {
      // Verified live against the pre-fix code: Prisma's argument
      // serialisation reads inherited enumerable properties, so
      // findUnique(Object.create({ include: { branches: true } })) returned
      // related Branch rows. A guard built on Object.keys alone would miss it.
      const inherited = Object.create({ include: { branches: true } }) as Record<string, unknown>
      inherited.where = { id: orgId }
      blocked(() => (prisma.organization as Loose).findUnique(inherited))
    })

    it('is immune to a time-of-check/time-of-use getter, because Prisma receives the inspected snapshot', async () => {
      let reads = 0
      const toctou: Record<string, unknown> = { where: { id: orgId } }
      Object.defineProperty(toctou, 'include', {
        enumerable: true,
        configurable: true,
        get() {
          reads += 1
          // Benign on the guard's read, hostile on any later one.
          return reads === 1 ? undefined : { branches: true }
        },
      })

      const result = (await (prisma.organization as Loose).findUnique(toctou)) as Record<string, unknown> | null

      // The discriminating assertion: the getter ran exactly once — the
      // guard's read. Prisma never touched the caller's object, so the second,
      // hostile value could not reach it.
      expect(reads).toBe(1)
      expect(result).not.toBeNull()
      expect('branches' in (result as Record<string, unknown>)).toBe(false)
    }, 30_000)

    it('does not mutate the caller’s argument object', () => {
      // The guard forwards a snapshot; the caller's object must come back
      // unchanged so reusing it (a shared `where` constant, say) is safe.
      const args = { where: { id: orgId }, take: 1 }
      const before = JSON.stringify(args)
      void (prisma.organization as Loose).findMany(args)
      expect(JSON.stringify(args)).toBe(before)
    })

    // --- and the ordinary, relation-free usage must be untouched -----------

    it('leaves relation-free select / where / orderBy / data working against the live database', async () => {
      await expect(
        (prisma.organization as Loose).findUnique({ where: { id: orgId }, select: { id: true, name: true } })
      ).resolves.toEqual({ id: orgId, name: 'Relation Guard' })

      await expect(
        prisma.organization.findMany({
          where: { AND: [{ slug: orgSlug }, { OR: [{ status: 'ACTIVE' }, { status: 'SUSPENDED' }] }] },
          orderBy: [{ createdAt: 'desc' }, { name: 'asc' }],
          take: 5,
          skip: 0,
          distinct: ['id'],
        })
      ).resolves.toHaveLength(1)

      await expect(prisma.organization.count({ where: { slug: orgSlug } })).resolves.toBe(1)
      // A genuine zero-argument call must stay a zero-argument call, not
      // become `count(undefined)`.
      await expect(prisma.organization.count()).resolves.toBeGreaterThanOrEqual(1)
      await expect(prisma.user.aggregate({ _count: true })).resolves.toBeTruthy()
      await expect(
        prisma.organization.aggregate({ _count: { _all: true }, where: { slug: orgSlug } })
      ).resolves.toBeTruthy()
      await expect(
        prisma.organization.groupBy({ by: ['status'], where: { slug: orgSlug }, _count: { _all: true } })
      ).resolves.toHaveLength(1)

      // A JSON column may legitimately contain a key that happens to be named
      // after a relation; that is data, not traversal, and must not be
      // rejected. This is why the `where` scan descends only through
      // AND/OR/NOT rather than through every value it meets.
      const renamed = await prisma.organization.update({
        where: { id: orgId },
        data: { name: 'Relation Guard', settings: { branches: ['this is JSON data, not a relation'] } },
      })
      expect(renamed.settings).toEqual({ branches: ['this is JSON data, not a relation'] })

      await expect(
        prisma.organization.findMany({ where: { settings: { path: ['branches'], not: Prisma.DbNull } } })
      ).resolves.toHaveLength(1)

      // A `Date` passed as a leaf value survives the snapshot by reference.
      await expect(
        prisma.organization.findMany({ where: { slug: orgSlug, createdAt: { lte: new Date() } } })
      ).resolves.toHaveLength(1)
    }, 30_000)

    it('leaves a relation-free omit working', async () => {
      const row = (await (prisma.organization as Loose).findUnique({
        where: { id: orgId },
        omit: { settings: true },
      })) as Record<string, unknown>
      expect(row.id).toBe(orgId)
      expect('settings' in row).toBe(false)
    }, 30_000)
  })

  // =========================================================================
  // Found while hardening round 3, in the same "relation traversal" class but
  // through a completely different channel: Prisma's *fluent API*.
  //
  // `findUnique`/`findFirst`/`create`/`update`/`upsert`/`delete` (and the
  // OrThrow variants) do not return a plain promise — they return a
  // `Prisma__<Model>Client` carrying one method per relation of that model.
  // Verified live against Supabase before the fix:
  //
  //   await prisma.organization.findUnique({ where: { id } }).branches()
  //   -> [{ id, organizationId, name: 'secret-branch', timezone: 'UTC', ... }]
  //
  // No query argument is involved, so the argument guard cannot see it; the
  // capability is on the return value. Closed the way round 2 closed $parent —
  // the fluent client is never handed out; a minimal frozen thenable carrying
  // only then/catch/finally is returned instead.
  // =========================================================================
  describe('the fluent relation API on returned values (regression for the return-value bypass)', () => {
    let orgId = ''

    beforeAll(async () => {
      const org = await prisma.organization.create({
        data: { name: 'Fluent Guard', slug: `fluent-guard-${Date.now()}` },
      })
      orgId = org.id
    }, 30_000)

    afterAll(async () => {
      if (orgId) {
        await prisma.organization.delete({ where: { id: orgId } })
      }
    }, 30_000)

    it('confirms the hazard still exists on the raw client, so these tests are not vacuous', () => {
      // If Prisma ever drops the fluent API, these tests must be re-derived
      // rather than silently passing against a client that no longer has it.
      const fluent = rawPrisma.organization.findUnique({ where: { id: orgId } }) as unknown as Record<string, unknown>
      expect(typeof fluent.branches).toBe('function')
      expect(typeof fluent.subscription).toBe('function')
      // A PrismaPromise is lazy: nothing is dispatched unless then/catch/
      // finally is called, so this probe issues no query at all.
    })

    it.each([
      'findUnique',
      'findUniqueOrThrow',
      'findFirst',
      'findFirstOrThrow',
      'create',
      'update',
      'upsert',
      'delete',
    ])('%s does not hand back a fluent client that can walk into a relation', (method) => {
      const argsFor: Record<string, unknown> = {
        findUnique: { where: { id: orgId } },
        findUniqueOrThrow: { where: { id: orgId } },
        findFirst: { where: { id: orgId } },
        findFirstOrThrow: { where: { id: orgId } },
        create: { data: { name: 'never-runs', slug: 'never-runs' } },
        update: { where: { id: orgId }, data: { name: 'never-runs' } },
        upsert: { where: { id: orgId }, create: { name: 'n', slug: 'n' }, update: {} },
        delete: { where: { id: 'does-not-exist' } },
      }
      const result = (prisma.organization as Loose)[method](argsFor[method])
      expect(() => result.branches).toThrow(TenantScopedModelAccessError)
      expect(() => result.subscription).toThrow(TenantScopedModelAccessError)
      // Structurally absent, not merely blocked — the same standard round 2 set.
      expect(Object.getOwnPropertyDescriptor(result, 'branches')).toBeUndefined()
      expect('branches' in result).toBe(false)
      expect(Reflect.ownKeys(result).map(String)).not.toContain('branches')
      expect(Object.getPrototypeOf(result)).toBeNull()
      // Nothing above ever calls then/catch/finally, and a PrismaPromise is
      // lazy, so none of these queries is dispatched — including the write
      // shapes. `no write escaped the lazy promises` below proves that.
    })

    it('no write escaped the lazy promises built by the test above', async () => {
      expect(await prisma.organization.count({ where: { slug: 'never-runs' } })).toBe(0)
      expect(await prisma.organization.count({ where: { name: 'never-runs' } })).toBe(0)
    }, 30_000)

    it('exposes only then/catch/finally on a returned query, dropping spec and requestTransaction', () => {
      const result = prisma.organization.findMany({ take: 1 })
      expect(Reflect.ownKeys(result).map(String).sort()).toEqual([
        'Symbol(Symbol.toStringTag)',
        'Symbol(nodejs.util.inspect.custom)',
        'catch',
        'finally',
        'then',
      ])
      // `requestTransaction` was explicitly listed as an unwrapped risk in fix
      // round 2's report; it is gone now rather than merely judged harmless.
      expect(() => (result as unknown as Record<string, unknown>).requestTransaction).toThrow(
        TenantScopedModelAccessError
      )
      expect(() => (result as unknown as Record<string, unknown>).spec).toThrow(TenantScopedModelAccessError)
    })

    it('keeps await, Promise.all, .catch() and .finally() working on the sealed result', async () => {
      await expect(prisma.organization.findUnique({ where: { id: orgId } })).resolves.toMatchObject({ id: orgId })

      const [count, rows] = await Promise.all([
        prisma.organization.count({ where: { id: orgId } }),
        prisma.organization.findMany({ where: { id: orgId } }),
      ])
      expect(count).toBe(1)
      expect(rows).toHaveLength(1)

      await expect(
        prisma.organization.findUniqueOrThrow({ where: { id: 'does-not-exist' } }).catch(() => 'caught')
      ).resolves.toBe('caught')

      let ranFinally = false
      await prisma.organization.findMany({ take: 1 }).finally(() => {
        ranFinally = true
      })
      expect(ranFinally).toBe(true)
    }, 30_000)

    it('does not disclose internal names when a returned query is inspected', () => {
      const result = prisma.organization.findMany({ take: 1 })
      const inspected = util.inspect(result)
      expect(inspected).toContain('PlatformScopedQuery')
      expect(inspected).not.toContain('branches')
      expect(inspected).not.toContain('requestTransaction')
    })
  })
})
