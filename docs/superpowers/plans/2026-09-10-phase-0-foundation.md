# EquestrianLoop Phase 0 (Foundation) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Stand up the multi-tenant SaaS foundation for EquestrianLoop — schema, tenant isolation, staff + customer auth, RBAC, provider-agnostic billing and storage, and styled (not placeholder) shells for the landing page, Super Admin, staff dashboard, and customer portal.

**Architecture:** Next.js 15 App Router monorepo-style single app. Shared-schema Postgres multi-tenancy with `organizationId` + Row-Level Security. Auth.js v5 with database sessions serving two structurally separate principal types (staff, customer) plus a Super Admin path outside tenant scope entirely. Billing and storage are behind provider interfaces (`PaymentProvider`, `StorageProvider`) with Stripe/Supabase as the first concrete implementations.

**Tech Stack:** Next.js 15 (App Router) + TypeScript, Tailwind CSS v4, shadcn/ui (`new-york`), Prisma ORM + PostgreSQL, Zod, React Hook Form, Auth.js v5, Stripe, Supabase Storage, Recharts, Lucide, Vitest.

**Spec:** `docs/superpowers/specs/2026-09-10-equestrianloop-foundation-design.md`

## Global Constraints

- Shared-schema multi-tenancy: every tenant-scoped table carries `organizationId`; never trust a tenant/customer identifier from client input (spec §2).
- Two independent isolation layers on every tenant query, and both are consistently exercised, not merely available: an explicit `where: { organizationId }` filter on every tenant-scoped query, *and* that query running inside `withTenantContext()` so Postgres RLS is keyed on a server-set `app.current_tenant_id` session variable (spec §2). This is enforced structurally (Task 2's `prisma`/`rawPrisma` split) — direct access to a tenant-scoped model outside `withTenantContext` is a thrown error, not a missed convention.
- `User.type` (`SUPER_ADMIN | STAFF | CUSTOMER`) — customer and staff authorization are separate guard functions with no shared code path; customers can never reach an RBAC permission check (spec §3).
- No `TRIALING` value anywhere in `SubscriptionStatus` — paid-only is structural, not configured (spec §6).
- Billing and storage are accessed only through `PaymentProvider`/`StorageProvider` interfaces — no Stripe or Supabase SDK types outside their provider implementation files (spec §6, §7).
- `LoyaltyTransaction` and booking-race safety are enforced by DB constraints, not application discipline (spec §8, §10).
- Only one active `CustomerMembership` per customer, enforced by a DB partial unique index (spec §10).
- UI ships fully styled at every step in this plan — no unstyled scaffolding, no fake buttons for unbuilt features (spec §14).

---

## File Structure

```
/prisma
  schema.prisma
  seed.ts
/src
  /app
    /(marketing)/page.tsx
    /(auth)/staff/sign-in/page.tsx
    /(auth)/staff/sign-up/page.tsx
    /(auth)/customer/sign-in/page.tsx
    /(auth)/customer/sign-up/page.tsx
    /(auth)/forgot-password/page.tsx
    /admin/layout.tsx
    /admin/page.tsx
    /admin/organizations/page.tsx
    /admin/subscriptions/page.tsx
    /admin/analytics/page.tsx
    /[orgSlug]/(dashboard)/layout.tsx
    /[orgSlug]/(dashboard)/page.tsx
    /[orgSlug]/portal/layout.tsx
    /[orgSlug]/portal/page.tsx
    /[orgSlug]/portal/qr-code/page.tsx
    /api/auth/[...nextauth]/route.ts
    /api/webhooks/[provider]/route.ts
  /components/ui/           # shadcn primitives (generated)
  /components/shared/page-header.tsx
  /components/shared/stat-card.tsx
  /components/shared/data-table.tsx
  /components/shared/empty-state.tsx
  /server/tenant/context.ts
  /server/auth/config.ts
  /server/auth/guards.ts
  /server/auth/password.ts
  /server/actions/staff-auth.ts
  /server/actions/customer-auth.ts
  /server/billing/PaymentProvider.ts
  /server/billing/BillingService.ts
  /server/billing/providers/StripeProvider.ts
  /server/storage/StorageProvider.ts
  /server/storage/StorageService.ts
  /server/storage/providers/SupabaseStorageProvider.ts
  /db/raw-client.ts
  /db/client.ts
  /config/site.ts
  /config/permissions.ts
  /lib/qr.ts
  /types/session.ts
/tests
  /db/*.test.ts
  /server/*.test.ts
```

---

## Task 1: Project Scaffold & Tooling

**Files:**
- Create: `package.json`, `tsconfig.json`, `next.config.ts`, `postcss.config.mjs`, `tailwind.config.ts`, `eslint.config.mjs`, `components.json`, `vitest.config.ts`, `.env.example`, `.gitignore`
- Create: `src/app/layout.tsx`, `src/app/globals.css`

**Interfaces:**
- Produces: a runnable Next.js app (`npm run dev`), a runnable test command (`npm run test`), shadcn/ui configured with `new-york` style so every later UI task can `npx shadcn add <component>`.

- [ ] **Step 1: Scaffold the Next.js app**

```bash
npx create-next-app@latest . --typescript --tailwind --eslint --app --src-dir --import-alias "@/*" --no-turbopack --use-npm
```
Answer prompts to match: App Router yes, `src/` yes, Tailwind yes, import alias `@/*`.

- [ ] **Step 2: Install core dependencies**

```bash
npm install @prisma/client @prisma/adapter-pg zod react-hook-form @hookform/resolvers next-auth@beta @auth/prisma-adapter bcryptjs stripe recharts lucide-react qrcode.react
npm install -D prisma vitest @vitejs/plugin-react vite-tsconfig-paths @types/bcryptjs
```

- [ ] **Step 3: Initialize shadcn/ui**

```bash
npx shadcn@latest init -d -b new-york
```
Verify `components.json` was created with `"style": "new-york"`.

- [ ] **Step 4: Add Vitest config**

`vitest.config.ts`:
```typescript
import { defineConfig } from 'vitest/config'
import tsconfigPaths from 'vite-tsconfig-paths'

export default defineConfig({
  plugins: [tsconfigPaths()],
  test: {
    environment: 'node',
    globals: true,
  },
})
```

Add to `package.json` scripts: `"test": "vitest run"`.

- [ ] **Step 5: Add `.env.example`**

```
DATABASE_URL=
DIRECT_URL=
NEXTAUTH_SECRET=
NEXTAUTH_URL=http://localhost:3000
STRIPE_SECRET_KEY=
STRIPE_WEBHOOK_SECRET=
SUPABASE_URL=
SUPABASE_SERVICE_ROLE_KEY=
```

- [ ] **Step 6: Verify the app builds and tests run**

Run: `npm run build`
Expected: build succeeds with the default Next.js starter page.

Run: `npm run test`
Expected: "No test files found" (exit code reflects no failures) — confirms Vitest is wired up.

- [ ] **Step 7: Commit**

```bash
git add -A
git commit -m "Scaffold Next.js app with Tailwind, shadcn/ui, Prisma, Vitest"
```

---

## Task 2: Prisma Setup, Platform-Level Schema, and the Tenant-Access Boundary

> **Architecture note — why this task is bigger than "add a Prisma client":** the spec (and a later review) require that tenant-scoped tables are *never* reachable except through the RLS-context-setting path (Task 9's `withTenantContext`) — not as a convention, as a fact enforced by both the type checker and the runtime. To make that true from the very first task that touches the database (rather than retrofitting it after several tasks have already written the wrong pattern), this task splits Prisma access into two objects: `rawPrisma` (the real, full-access client — imported only by `src/db/client.ts` itself and by `src/server/tenant/context.ts` in Task 9) and `prisma` (a `Proxy`-wrapped, deliberately narrow client that only exposes the four platform-level models — `user`, `organization`, `subscription`, `auditLog` — plus `$connect`/`$disconnect`). Every other property access on `prisma`, including `$transaction` and any raw-SQL escape hatch, throws immediately. There is no code path where forgetting to use `withTenantContext` silently succeeds unscoped — it fails loudly, at the first line that tries.

**Files:**
- Create: `prisma/schema.prisma`
- Create: `src/db/raw-client.ts`
- Create: `src/db/client.ts`
- Test: `tests/db/platform-schema.test.ts`
- Test: `tests/db/tenant-access-boundary.test.ts`

**Interfaces:**
- Produces: `rawPrisma` (full client, internal-use-only export from `src/db/raw-client.ts` — imported by `src/db/client.ts` and, starting Task 9, `src/server/tenant/context.ts`; also imported directly by schema-verification tests and `prisma/seed.ts`, which sit outside the request-handling application layer this boundary protects); `prisma` (the restricted, Proxy-guarded client from `src/db/client.ts` — `import { prisma } from '@/db/client'`, the only DB import any application code under `src/app` or `src/server` may use for `user`/`organization`/`subscription`/`auditLog`); `TenantScopedModelAccessError`; models `User`, `Organization`, `Branch`, `Subscription`, `AuditLog`; enums `UserType`, `SubscriptionStatus`.
- Consumes: `DATABASE_URL` / `DIRECT_URL` env vars (from Task 1's `.env.example`).

- [ ] **Step 1: Write `prisma/schema.prisma` platform-level models**

```prisma
generator client {
  provider = "prisma-client-js"
}

datasource db {
  provider          = "postgresql"
  url               = env("DATABASE_URL")
  directUrl         = env("DIRECT_URL")
}

enum UserType {
  SUPER_ADMIN
  STAFF
  CUSTOMER
}

enum SubscriptionStatus {
  INCOMPLETE
  ACTIVE
  PAST_DUE
  CANCELED
  UNPAID
}

model User {
  id           String   @id @default(cuid())
  email        String   @unique
  passwordHash String
  type         UserType
  name         String
  phone        String?
  createdAt    DateTime @default(now())
  updatedAt    DateTime @updatedAt
}

model Organization {
  id                        String   @id @default(cuid())
  name                      String
  slug                      String   @unique
  status                    String   @default("ACTIVE")
  customerSelfBookingEnabled Boolean @default(false)
  settings                  Json     @default("{}")
  createdAt                 DateTime @default(now())
  updatedAt                 DateTime @updatedAt

  branches     Branch[]
  subscription Subscription?
}

model Branch {
  id             String   @id @default(cuid())
  organizationId String
  organization   Organization @relation(fields: [organizationId], references: [id], onDelete: Cascade)
  name           String
  address        String?
  timezone       String
  operatingHours Json     @default("{}")
  createdAt      DateTime @default(now())

  @@index([organizationId])
}

model Subscription {
  id                     String             @id @default(cuid())
  organizationId         String             @unique
  organization           Organization       @relation(fields: [organizationId], references: [id], onDelete: Cascade)
  provider               String
  providerCustomerId     String
  providerSubscriptionId String?
  planId                 String
  status                 SubscriptionStatus @default(INCOMPLETE)
  currentPeriodEnd       DateTime?
  createdAt              DateTime           @default(now())
  updatedAt              DateTime           @updatedAt
}

model AuditLog {
  id             String   @id @default(cuid())
  organizationId String?
  actorUserId    String
  action         String
  entityType     String
  entityId       String
  metadata       Json     @default("{}")
  createdAt      DateTime @default(now())

  @@index([organizationId])
}
```

- [ ] **Step 2: Create the internal, full-access Prisma client**

`src/db/raw-client.ts`:
```typescript
// INTERNAL ONLY. Do not import this file from anywhere under src/app or
// src/server except src/server/tenant/context.ts (Task 9). Every other
// consumer of the database — pages, Server Actions, RBAC guards — must
// import `prisma` from '@/db/client' (platform models only) or use
// withTenantContext() from '@/server/tenant/context' (tenant-scoped models,
// RLS-enforced). Schema-verification tests and prisma/seed.ts are the only
// other sanctioned importers, since they sit outside the request-handling
// application layer this split protects.
import { PrismaClient } from '@prisma/client'

const globalForPrisma = globalThis as unknown as { rawPrisma?: PrismaClient }

export const rawPrisma = globalForPrisma.rawPrisma ?? new PrismaClient()

if (process.env.NODE_ENV !== 'production') {
  globalForPrisma.rawPrisma = rawPrisma
}
```

- [ ] **Step 3: Create the restricted, Proxy-guarded client application code actually imports**

`src/db/client.ts`:
```typescript
import { rawPrisma } from './raw-client'

// `permission` joins this allowlist in Task 3, once the Permission model actually exists in
// schema.prisma (it's a fixed, global catalog — the ~13 permission-key rows seeded once — not
// per-tenant data, and carries no organizationId column for RLS to key on). Referencing it here
// before Task 3 adds the model is a TypeScript compile error against the generated Prisma Client
// type, not just premature — keep this list in lockstep with which models actually exist.
const PLATFORM_MODEL_KEYS = new Set(['user', 'organization', 'subscription', 'auditLog'])
const ALSO_ALLOWED = new Set(['$connect', '$disconnect'])

export class TenantScopedModelAccessError extends Error {
  constructor(prop: string) {
    super(
      `Blocked direct access to prisma.${prop} — this is not one of the platform-level models ` +
        `(user, organization, subscription, auditLog). Tenant-scoped models, and any ` +
        `transaction or raw SQL, must go through withTenantContext(organizationId, (tx) => ...) from ` +
        `'@/server/tenant/context' so the Postgres RLS session variable is set before the query runs.`
    )
    this.name = 'TenantScopedModelAccessError'
  }
}

type PlatformScopedClient = Pick<typeof rawPrisma, 'user' | 'organization' | 'subscription' | 'auditLog' | '$connect' | '$disconnect'>

export const prisma: PlatformScopedClient = new Proxy(rawPrisma, {
  get(target, prop, receiver) {
    if (typeof prop === 'string' && !PLATFORM_MODEL_KEYS.has(prop) && !ALSO_ALLOWED.has(prop)) {
      throw new TenantScopedModelAccessError(prop)
    }
    return Reflect.get(target, prop, receiver)
  },
}) as PlatformScopedClient
```

Note `$transaction` is deliberately **not** in `ALSO_ALLOWED`: if it were, `prisma.$transaction(async (tx) => tx.customer.findMany())` would hand back an unrestricted `tx` from Prisma's own internals — a transaction client is a value returned by the method call, not a property access, so the Proxy's `get` trap never sees it and can't guard it. Excluding `$transaction` entirely closes that hole; any multi-step write (including ones that also touch a platform model like `User`) goes through `withTenantContext` instead (Task 9), whose `tx` is intentionally unrestricted because obtaining it already proves the RLS context was set first.

- [ ] **Step 4: Run the initial migration**

```bash
npx prisma migrate dev --name init_platform_schema
```
Expected: migration applies cleanly, Prisma Client regenerates.

- [ ] **Step 5: Write the failing platform-schema test**

`tests/db/platform-schema.test.ts`:
```typescript
import { describe, it, expect, afterAll } from 'vitest'
import { prisma } from '@/db/client'

describe('platform-level schema', () => {
  afterAll(async () => {
    await prisma.$disconnect()
  })

  it('creates an organization with default customerSelfBookingEnabled=false', async () => {
    const org = await prisma.organization.create({
      data: { name: 'Test Stables', slug: `test-stables-${Date.now()}` },
    })
    expect(org.customerSelfBookingEnabled).toBe(false)
    expect(org.status).toBe('ACTIVE')
  })

  it('enforces one subscription per organization via unique organizationId', async () => {
    const org = await prisma.organization.create({
      data: { name: 'Sub Test', slug: `sub-test-${Date.now()}` },
    })
    await prisma.subscription.create({
      data: {
        organizationId: org.id,
        provider: 'stripe',
        providerCustomerId: 'cus_test',
        planId: 'plan_basic',
      },
    })
    await expect(
      prisma.subscription.create({
        data: {
          organizationId: org.id,
          provider: 'stripe',
          providerCustomerId: 'cus_test_2',
          planId: 'plan_basic',
        },
      })
    ).rejects.toThrow()
  })
})
```

- [ ] **Step 6: Write the failing tenant-access-boundary test**

`tests/db/tenant-access-boundary.test.ts`:
```typescript
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
})
```

- [ ] **Step 7: Run both tests**

Run: `npm run test -- platform-schema tenant-access-boundary`
Expected: both PASS if `DATABASE_URL` in `.env` points to a real reachable Postgres instance (Supabase project created for this task — document the connection string in local `.env`, not committed). If no DB is reachable yet, this is the point to provision one before continuing. The boundary test needs no DB connection at all — it only exercises the Proxy.

- [ ] **Step 8: Commit**

```bash
git add prisma src/db tests/db .env.example
git commit -m "Add Prisma platform-level schema and the tenant-access boundary (rawPrisma/prisma split)"
```

---

## Task 3: RBAC Schema & Default Role/Permission Seed

> **Plan note:** Task 2 deliberately left `permission` out of `src/db/client.ts`'s `PLATFORM_MODEL_KEYS`/`PlatformScopedClient`, since the `Permission` model didn't exist yet and referencing it was a real `tsc` compile error. This task adds the model, so it also re-adds `permission` to that allowlist (Step 2a below) — Task 13's `tests/server/auth-guards.test.ts` calls `prisma.permission.upsert(...)` through the restricted `@/db/client` import and depends on it being there.

**Files:**
- Modify: `prisma/schema.prisma`
- Modify: `src/db/client.ts`
- Modify: `tests/db/tenant-access-boundary.test.ts`
- Create: `prisma/seed.ts`
- Create: `src/config/permissions.ts`
- Test: `tests/db/rbac-schema.test.ts`

**Interfaces:**
- Consumes: `prisma` from Task 2, `Organization`/`User` models from Task 2.
- Produces: models `Membership`, `Role`, `Permission`, `RolePermission`; `PERMISSIONS` const array from `src/config/permissions.ts`; a `prisma db seed` command that creates default roles/permissions for a given organization; `prisma.permission` now reachable through the restricted `@/db/client` export.

- [ ] **Step 1: Add RBAC models to `prisma/schema.prisma`**

```prisma
model Membership {
  id             String    @id @default(cuid())
  userId         String
  user           User      @relation(fields: [userId], references: [id], onDelete: Cascade)
  organizationId String
  organization   Organization @relation(fields: [organizationId], references: [id], onDelete: Cascade)
  branchId       String?
  branch         Branch?   @relation(fields: [branchId], references: [id])
  roleId         String
  role           Role      @relation(fields: [roleId], references: [id])
  invitedAt      DateTime  @default(now())
  acceptedAt     DateTime?

  @@unique([userId, organizationId])
  @@index([organizationId])
}

model Role {
  id             String   @id @default(cuid())
  organizationId String?
  organization   Organization? @relation(fields: [organizationId], references: [id], onDelete: Cascade)
  name           String
  isSystemRole   Boolean  @default(true)

  permissions RolePermission[]
  memberships Membership[]

  @@index([organizationId])
}

model Permission {
  id          String @id @default(cuid())
  key         String @unique
  description String

  roles RolePermission[]
}

model RolePermission {
  roleId       String
  role         Role       @relation(fields: [roleId], references: [id], onDelete: Cascade)
  permissionId String
  permission   Permission @relation(fields: [permissionId], references: [id], onDelete: Cascade)

  @@id([roleId, permissionId])
}
```

Add back-relations on `User`, `Organization`, `Branch` from Task 2:
```prisma
// User model: add
memberships Membership[]

// Organization model: add
memberships Membership[]
roles       Role[]

// Branch model: add
memberships Membership[]
```

- [ ] **Step 2a: Re-add `permission` to the tenant-access boundary's allowlist**

In `src/db/client.ts`, now that `Permission` exists in `schema.prisma`:
- Add `'permission'` back to `PLATFORM_MODEL_KEYS`.
- Add `| 'permission'` back to the `PlatformScopedClient` Pick type.
- Add `permission` back into the `TenantScopedModelAccessError` message's model list.

In `tests/db/tenant-access-boundary.test.ts`, restore the fifth assertion:
```typescript
  it('still allows the five platform-level models', () => {
    expect(() => prisma.user).not.toThrow()
    expect(() => prisma.organization).not.toThrow()
    expect(() => prisma.subscription).not.toThrow()
    expect(() => prisma.auditLog).not.toThrow()
    expect(() => prisma.permission).not.toThrow()
  })
```
(This replaces the four-model version Task 2 left behind — rename the `it` block back, don't add a duplicate.)

- [ ] **Step 2b: Define the permission catalog**

`src/config/permissions.ts`:
```typescript
export const PERMISSIONS = [
  'customers.manage',
  'horses.manage',
  'staff.manage',
  'services.manage',
  'bookings.manage',
  'sessions.manage',
  'checkins.manage',
  'loyalty.manage',
  'rewards.manage',
  'memberships.manage',
  'billing.manage',
  'reports.view',
  'settings.manage',
] as const

export type Permission = (typeof PERMISSIONS)[number]

export const DEFAULT_ROLE_PERMISSIONS: Record<string, Permission[]> = {
  OWNER: [...PERMISSIONS],
  ADMIN: [...PERMISSIONS].filter((p) => p !== 'billing.manage'),
  MANAGER: [
    'customers.manage', 'horses.manage', 'services.manage', 'bookings.manage',
    'sessions.manage', 'checkins.manage', 'loyalty.manage', 'rewards.manage',
    'memberships.manage', 'reports.view',
  ],
  TRAINER: ['sessions.manage', 'checkins.manage'],
  FRONT_DESK: ['customers.manage', 'bookings.manage', 'checkins.manage'],
}
```

- [ ] **Step 3: Write `prisma/seed.ts`**

```typescript
import { PrismaClient } from '@prisma/client'
import { PERMISSIONS, DEFAULT_ROLE_PERMISSIONS } from '../src/config/permissions'

const prisma = new PrismaClient()

export async function seedGlobalPermissions() {
  for (const key of PERMISSIONS) {
    await prisma.permission.upsert({
      where: { key },
      update: {},
      create: { key, description: key },
    })
  }
}

export async function seedDefaultRolesForOrganization(organizationId: string) {
  const allPermissions = await prisma.permission.findMany()
  const byKey = Object.fromEntries(allPermissions.map((p) => [p.key, p.id]))

  for (const [roleName, permissionKeys] of Object.entries(DEFAULT_ROLE_PERMISSIONS)) {
    const role = await prisma.role.create({
      data: { organizationId, name: roleName, isSystemRole: true },
    })
    await prisma.rolePermission.createMany({
      data: permissionKeys.map((key) => ({ roleId: role.id, permissionId: byKey[key] })),
    })
  }
}

async function main() {
  await seedGlobalPermissions()
}

if (require.main === module) {
  main().finally(() => prisma.$disconnect())
}
```

Add to `package.json`:
```json
"prisma": { "seed": "ts-node prisma/seed.ts" }
```

- [ ] **Step 4: Run migration**

```bash
npx prisma migrate dev --name add_rbac_schema
```

- [ ] **Step 5: Write the failing test**

`tests/db/rbac-schema.test.ts`:
```typescript
import { describe, it, expect, afterAll } from 'vitest'
// Schema-verification tests sit outside the application layer the rawPrisma/prisma
// split (Task 2) protects, so they use rawPrisma directly — aliased to `prisma` here
// purely so the rest of this file's assertions don't need renaming.
import { rawPrisma as prisma } from '@/db/raw-client'
import { seedGlobalPermissions, seedDefaultRolesForOrganization } from '../../prisma/seed'

describe('RBAC schema', () => {
  afterAll(async () => {
    await prisma.$disconnect()
  })

  it('seeds default roles with the correct permission sets per organization', async () => {
    await seedGlobalPermissions()
    const org = await prisma.organization.create({
      data: { name: 'RBAC Test', slug: `rbac-test-${Date.now()}` },
    })
    await seedDefaultRolesForOrganization(org.id)

    const ownerRole = await prisma.role.findFirstOrThrow({
      where: { organizationId: org.id, name: 'OWNER' },
      include: { permissions: { include: { permission: true } } },
    })
    expect(ownerRole.permissions.map((rp) => rp.permission.key)).toContain('billing.manage')

    const trainerRole = await prisma.role.findFirstOrThrow({
      where: { organizationId: org.id, name: 'TRAINER' },
      include: { permissions: { include: { permission: true } } },
    })
    expect(trainerRole.permissions.map((rp) => rp.permission.key)).not.toContain('billing.manage')
  })

  it('enforces one role per user per organization', async () => {
    const org = await prisma.organization.create({
      data: { name: 'Membership Test', slug: `membership-test-${Date.now()}` },
    })
    const user = await prisma.user.create({
      data: { email: `staff-${Date.now()}@test.com`, passwordHash: 'x', type: 'STAFF', name: 'Staff One' },
    })
    const role = await prisma.role.create({ data: { organizationId: org.id, name: 'CUSTOM' } })
    await prisma.membership.create({ data: { userId: user.id, organizationId: org.id, roleId: role.id } })

    await expect(
      prisma.membership.create({ data: { userId: user.id, organizationId: org.id, roleId: role.id } })
    ).rejects.toThrow()
  })
})
```

- [ ] **Step 6: Run test**

Run: `npm run test -- rbac-schema`
Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add prisma src/config src/db tests/db package.json
git commit -m "Add RBAC schema and default role/permission seed"
```

---

## Task 4: Customer & Staff Domain Schema

**Files:**
- Modify: `prisma/schema.prisma`
- Test: `tests/db/people-schema.test.ts`

**Interfaces:**
- Consumes: `User`, `Organization`, `Branch` from Task 2.
- Produces: models `Customer`, `Staff`, `Trainer`, `Horse`.

- [ ] **Step 1: Add models**

```prisma
model Customer {
  id             String   @id @default(cuid())
  organizationId String
  organization   Organization @relation(fields: [organizationId], references: [id], onDelete: Cascade)
  userId         String
  user           User     @relation(fields: [userId], references: [id], onDelete: Cascade)
  qrToken        String   @unique @default(cuid())
  firstName      String
  lastName       String
  phone          String?
  notes          String?
  createdAt      DateTime @default(now())

  @@unique([organizationId, userId])
  @@index([organizationId])
}

model Staff {
  id             String   @id @default(cuid())
  organizationId String
  organization   Organization @relation(fields: [organizationId], references: [id], onDelete: Cascade)
  branchId       String?
  branch         Branch?  @relation(fields: [branchId], references: [id])
  userId         String
  user           User     @relation(fields: [userId], references: [id], onDelete: Cascade)
  title          String?
  employmentStart DateTime @default(now())

  trainer Trainer?

  @@unique([organizationId, userId])
  @@index([organizationId])
}

model Trainer {
  id             String   @id @default(cuid())
  staffId        String   @unique
  staff          Staff    @relation(fields: [staffId], references: [id], onDelete: Cascade)
  bio            String?
  specialties    String[]
  certifications String[]
}

model Horse {
  id             String   @id @default(cuid())
  organizationId String
  organization   Organization @relation(fields: [organizationId], references: [id], onDelete: Cascade)
  branchId       String
  branch         Branch   @relation(fields: [branchId], references: [id])
  name           String
  breed          String?
  dob            DateTime?
  notes          String?
  photoUrl       String?
  status         String   @default("ACTIVE")
  createdAt      DateTime @default(now())

  @@index([organizationId])
}
```

Add back-relations: `User` gets `customer Customer?` and `staff Staff?`; `Organization` gets `customers Customer[]`, `staffMembers Staff[]`, `horses Horse[]`; `Branch` gets `staffMembers Staff[]`, `horses Horse[]`.

- [ ] **Step 2: Run migration**

```bash
npx prisma migrate dev --name add_customer_staff_schema
```

- [ ] **Step 3: Write the failing test**

`tests/db/people-schema.test.ts`:
```typescript
import { describe, it, expect, afterAll } from 'vitest'
// See the note in Task 3's rbac-schema.test.ts: schema-verification tests use
// rawPrisma directly, aliased to `prisma` so assertions below read naturally.
import { rawPrisma as prisma } from '@/db/raw-client'

describe('customer & staff schema', () => {
  afterAll(async () => {
    await prisma.$disconnect()
  })

  it('generates a unique qrToken for each customer', async () => {
    const org = await prisma.organization.create({
      data: { name: 'QR Test', slug: `qr-test-${Date.now()}` },
    })
    const user = await prisma.user.create({
      data: { email: `cust-${Date.now()}@test.com`, passwordHash: 'x', type: 'CUSTOMER', name: 'Rider One' },
    })
    const customer = await prisma.customer.create({
      data: { organizationId: org.id, userId: user.id, firstName: 'Rider', lastName: 'One' },
    })
    expect(customer.qrToken).toBeTruthy()
  })

  it('links a Trainer to a Staff record 1:1', async () => {
    const org = await prisma.organization.create({
      data: { name: 'Trainer Test', slug: `trainer-test-${Date.now()}` },
    })
    const user = await prisma.user.create({
      data: { email: `staff2-${Date.now()}@test.com`, passwordHash: 'x', type: 'STAFF', name: 'Trainer One' },
    })
    const staff = await prisma.staff.create({ data: { organizationId: org.id, userId: user.id } })
    const trainer = await prisma.trainer.create({
      data: { staffId: staff.id, specialties: ['dressage'], certifications: [] },
    })
    expect(trainer.staffId).toBe(staff.id)
  })
})
```

- [ ] **Step 4: Run test**

Run: `npm run test -- people-schema`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add prisma tests/db
git commit -m "Add Customer, Staff, Trainer, Horse schema"
```

---

## Task 5: Service Catalog & Scheduling Schema

**Files:**
- Modify: `prisma/schema.prisma`
- Test: `tests/db/scheduling-schema.test.ts`

**Interfaces:**
- Consumes: `Organization`, `Branch`, `Trainer`, `Horse`, `Customer` from Tasks 2/4.
- Produces: models `Service`, `BlockedTime`, `RidingSession`, `Booking`, `CheckIn`; enums `SchedulingType`, `BookingStatus`, `BookingCreatedVia`, `RidingSessionStatus`, `CheckInMethod`, `BlockedTimeScope`.

- [ ] **Step 1: Add enums and models**

```prisma
enum SchedulingType {
  FIXED_SESSION
  DYNAMIC
}

enum BookingStatus {
  PENDING
  CONFIRMED
  CANCELED
  COMPLETED
  NO_SHOW
}

enum BookingCreatedVia {
  STAFF
  CUSTOMER_SELF_SERVICE
}

enum RidingSessionStatus {
  SCHEDULED
  IN_PROGRESS
  COMPLETED
  CANCELED
}

enum CheckInMethod {
  QR_SCAN
  MANUAL
}

enum BlockedTimeScope {
  BRANCH
  TRAINER
  HORSE
}

model Service {
  id             String         @id @default(cuid())
  organizationId String
  organization   Organization   @relation(fields: [organizationId], references: [id], onDelete: Cascade)
  name           String
  description    String?
  durationMinutes Int
  capacity       Int            @default(1)
  price          Decimal        @db.Decimal(10, 2)
  currency       String         @default("USD")
  customerBookingEnabled Boolean @default(false)
  schedulingType SchedulingType
  requiresTrainer Boolean       @default(false)
  trainerSelectable Boolean     @default(false)
  requiresHorse  Boolean        @default(false)
  horseSelectable Boolean       @default(false)
  requiresPaymentAtBooking Boolean @default(false)
  maxBookingsPerCustomerPerWeek Int?
  cancellationAllowed Boolean   @default(true)
  cancellationCutoffMinutes Int?
  reschedulingAllowed Boolean   @default(true)
  reschedulingCutoffMinutes Int?
  isActive       Boolean        @default(true)
  createdAt      DateTime       @default(now())

  sessions RidingSession[]

  @@index([organizationId])
}

model BlockedTime {
  id             String            @id @default(cuid())
  organizationId String
  organization   Organization      @relation(fields: [organizationId], references: [id], onDelete: Cascade)
  scope          BlockedTimeScope
  branchId       String?
  trainerId      String?
  horseId        String?
  startsAt       DateTime
  endsAt         DateTime
  reason         String?

  @@index([organizationId])
}

model RidingSession {
  id             String              @id @default(cuid())
  organizationId String
  organization   Organization        @relation(fields: [organizationId], references: [id], onDelete: Cascade)
  branchId       String
  branch         Branch              @relation(fields: [branchId], references: [id])
  serviceId      String
  service        Service             @relation(fields: [serviceId], references: [id])
  trainerId      String?
  trainer        Trainer?            @relation(fields: [trainerId], references: [id])
  horseId        String?
  horse          Horse?              @relation(fields: [horseId], references: [id])
  startsAt       DateTime
  endsAt         DateTime
  capacity       Int
  status         RidingSessionStatus @default(SCHEDULED)
  createdAt      DateTime            @default(now())

  bookings Booking[]

  @@index([organizationId])
  @@index([trainerId, startsAt])
  @@index([horseId, startsAt])
}

model Booking {
  id                  String            @id @default(cuid())
  organizationId      String
  organization        Organization      @relation(fields: [organizationId], references: [id], onDelete: Cascade)
  customerId          String
  customer            Customer          @relation(fields: [customerId], references: [id], onDelete: Cascade)
  ridingSessionId     String
  ridingSession       RidingSession     @relation(fields: [ridingSessionId], references: [id])
  status              BookingStatus     @default(PENDING)
  createdVia          BookingCreatedVia
  paymentId           String?
  customerMembershipId String?          // plain scalar, not a @relation: CustomerMembership doesn't exist until Task 6, added later in this same file. Not read or written by any Phase 0 code (unused until Phase 4) — Task 6 may promote this to a full @relation once both models coexist, if a future task needs FK-level integrity here.
  createdAt           DateTime          @default(now())

  checkIn CheckIn?

  @@index([organizationId])
  @@index([customerId])
}

model CheckIn {
  id                  String        @id @default(cuid())
  organizationId      String
  organization        Organization  @relation(fields: [organizationId], references: [id], onDelete: Cascade)
  bookingId           String        @unique
  booking             Booking       @relation(fields: [bookingId], references: [id], onDelete: Cascade)
  method              CheckInMethod
  checkedInAt         DateTime      @default(now())
  checkedInByStaffId  String

  @@index([organizationId])
}
```

Add back-relations: `Organization` gets `services Service[]`, `blockedTimes BlockedTime[]`, `ridingSessions RidingSession[]`, `bookings Booking[]`, `checkIns CheckIn[]`; `Branch` gets `ridingSessions RidingSession[]`; `Trainer` gets `sessions RidingSession[]`; `Horse` gets `sessions RidingSession[]`; `Customer` gets `bookings Booking[]`.

- [ ] **Step 2: Run migration**

```bash
npx prisma migrate dev --name add_scheduling_schema
```

- [ ] **Step 3: Write the failing test**

`tests/db/scheduling-schema.test.ts`:
```typescript
import { describe, it, expect, afterAll } from 'vitest'
// See the note in Task 3's rbac-schema.test.ts: schema-verification tests use
// rawPrisma directly, aliased to `prisma` so assertions below read naturally.
import { rawPrisma as prisma } from '@/db/raw-client'

async function makeOrgBranchService(schedulingType: 'FIXED_SESSION' | 'DYNAMIC') {
  const org = await prisma.organization.create({
    data: { name: 'Sched Test', slug: `sched-test-${Date.now()}-${Math.random()}` },
  })
  const branch = await prisma.branch.create({
    data: { organizationId: org.id, name: 'Main', timezone: 'UTC' },
  })
  const service = await prisma.service.create({
    data: {
      organizationId: org.id, name: 'Horse Riding', durationMinutes: 60, price: 50,
      schedulingType, customerBookingEnabled: true,
    },
  })
  return { org, branch, service }
}

describe('scheduling schema', () => {
  afterAll(async () => {
    await prisma.$disconnect()
  })

  it('links a Booking to its RidingSession and Customer', async () => {
    const { org, branch, service } = await makeOrgBranchService('FIXED_SESSION')
    const session = await prisma.ridingSession.create({
      data: {
        organizationId: org.id, branchId: branch.id, serviceId: service.id,
        startsAt: new Date(), endsAt: new Date(Date.now() + 3600_000), capacity: 4,
      },
    })
    const user = await prisma.user.create({
      data: { email: `book-${Date.now()}@test.com`, passwordHash: 'x', type: 'CUSTOMER', name: 'Booker' },
    })
    const customer = await prisma.customer.create({
      data: { organizationId: org.id, userId: user.id, firstName: 'Book', lastName: 'Er' },
    })
    const booking = await prisma.booking.create({
      data: {
        organizationId: org.id, customerId: customer.id, ridingSessionId: session.id,
        createdVia: 'CUSTOMER_SELF_SERVICE',
      },
    })
    expect(booking.status).toBe('PENDING')
  })

  it('allows only one CheckIn per booking (unique bookingId)', async () => {
    const { org, branch, service } = await makeOrgBranchService('FIXED_SESSION')
    const session = await prisma.ridingSession.create({
      data: {
        organizationId: org.id, branchId: branch.id, serviceId: service.id,
        startsAt: new Date(), endsAt: new Date(Date.now() + 3600_000), capacity: 4,
      },
    })
    const user = await prisma.user.create({
      data: { email: `book2-${Date.now()}@test.com`, passwordHash: 'x', type: 'CUSTOMER', name: 'Booker2' },
    })
    const customer = await prisma.customer.create({
      data: { organizationId: org.id, userId: user.id, firstName: 'Book', lastName: 'Two' },
    })
    const booking = await prisma.booking.create({
      data: {
        organizationId: org.id, customerId: customer.id, ridingSessionId: session.id,
        createdVia: 'STAFF',
      },
    })
    await prisma.checkIn.create({
      data: { organizationId: org.id, bookingId: booking.id, method: 'MANUAL', checkedInByStaffId: 'staff_x' },
    })
    await expect(
      prisma.checkIn.create({
        data: { organizationId: org.id, bookingId: booking.id, method: 'MANUAL', checkedInByStaffId: 'staff_x' },
      })
    ).rejects.toThrow()
  })
})
```

- [ ] **Step 4: Run test**

Run: `npm run test -- scheduling-schema`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add prisma tests/db
git commit -m "Add Service, BlockedTime, RidingSession, Booking, CheckIn schema"
```

---

## Task 6: Membership Plan Schema & One-Active-Membership Enforcement

**Files:**
- Modify: `prisma/schema.prisma`
- Test: `tests/db/membership-schema.test.ts`

**Interfaces:**
- Consumes: `Organization`, `Service`, `Branch`, `Customer` from Tasks 2/4/5.
- Produces: models `MembershipPlan`, `MembershipPlanService`, `MembershipPlanBranch`, `CustomerMembership`; enums `MembershipPeriod`, `CustomerMembershipStatus`.

- [ ] **Step 1: Add enums and models**

```prisma
enum MembershipPeriod {
  WEEKLY
  MONTHLY
  ANNUAL
}

enum CustomerMembershipStatus {
  ACTIVE
  CANCELED
  EXPIRED
}

model MembershipPlan {
  id             String   @id @default(cuid())
  organizationId String
  organization   Organization @relation(fields: [organizationId], references: [id], onDelete: Cascade)
  name           String
  description    String?
  price          Decimal  @db.Decimal(10, 2)
  durationValue  Int
  durationUnit   MembershipPeriod
  maxSessions    Int?
  discountPercentage Decimal? @db.Decimal(5, 2)
  loyaltyBonusMultiplier Decimal @default(1.0) @db.Decimal(4, 2)
  allowsSelfBooking Boolean @default(true)
  bookingPriorityWeight Int @default(0)
  isActive       Boolean  @default(true)
  createdAt      DateTime @default(now())

  allowedServices MembershipPlanService[]
  allowedBranches MembershipPlanBranch[]
  customerMemberships CustomerMembership[]

  @@index([organizationId])
}

model MembershipPlanService {
  membershipPlanId String
  membershipPlan   MembershipPlan @relation(fields: [membershipPlanId], references: [id], onDelete: Cascade)
  serviceId        String
  service          Service        @relation(fields: [serviceId], references: [id], onDelete: Cascade)

  @@id([membershipPlanId, serviceId])
}

model MembershipPlanBranch {
  membershipPlanId String
  membershipPlan   MembershipPlan @relation(fields: [membershipPlanId], references: [id], onDelete: Cascade)
  branchId         String
  branch           Branch         @relation(fields: [branchId], references: [id], onDelete: Cascade)

  @@id([membershipPlanId, branchId])
}

model CustomerMembership {
  id                String                    @id @default(cuid())
  organizationId    String
  organization      Organization              @relation(fields: [organizationId], references: [id], onDelete: Cascade)
  customerId        String
  customer          Customer                  @relation(fields: [customerId], references: [id], onDelete: Cascade)
  membershipPlanId  String
  membershipPlan    MembershipPlan            @relation(fields: [membershipPlanId], references: [id])
  startDate         DateTime                  @default(now())
  endDate           DateTime
  status            CustomerMembershipStatus  @default(ACTIVE)
  paymentId         String?
  createdAt         DateTime                  @default(now())
  updatedAt         DateTime                  @updatedAt

  @@index([organizationId])
  @@index([customerId])
}
```

Add back-relations: `Organization` gets `membershipPlans MembershipPlan[]`, `customerMemberships CustomerMembership[]`; `Service` gets `membershipPlans MembershipPlanService[]`; `Branch` gets `membershipPlans MembershipPlanBranch[]`; `Customer` gets `memberships CustomerMembership[]`.

- [ ] **Step 2: Run migration, then add the partial unique index by hand**

```bash
npx prisma migrate dev --name add_membership_plan_schema --create-only
```

Prisma's schema language has no partial-index syntax, so edit the generated SQL file in `prisma/migrations/<timestamp>_add_membership_plan_schema/migration.sql` and append:

```sql
CREATE UNIQUE INDEX "CustomerMembership_one_active_per_customer"
ON "CustomerMembership" ("organizationId", "customerId")
WHERE "status" = 'ACTIVE';
```

Then apply it:
```bash
npx prisma migrate dev
```

- [ ] **Step 3: Write the failing test**

`tests/db/membership-schema.test.ts`:
```typescript
import { describe, it, expect, afterAll } from 'vitest'
// See the note in Task 3's rbac-schema.test.ts: schema-verification tests use
// rawPrisma directly, aliased to `prisma` so assertions below read naturally.
import { rawPrisma as prisma } from '@/db/raw-client'

describe('membership plan schema', () => {
  afterAll(async () => {
    await prisma.$disconnect()
  })

  it('prevents a customer from having two ACTIVE memberships at once', async () => {
    const org = await prisma.organization.create({
      data: { name: 'Membership Plan Test', slug: `mp-test-${Date.now()}` },
    })
    const user = await prisma.user.create({
      data: { email: `mp-${Date.now()}@test.com`, passwordHash: 'x', type: 'CUSTOMER', name: 'Plan Holder' },
    })
    const customer = await prisma.customer.create({
      data: { organizationId: org.id, userId: user.id, firstName: 'Plan', lastName: 'Holder' },
    })
    const plan = await prisma.membershipPlan.create({
      data: {
        organizationId: org.id, name: 'Gold', price: 100,
        durationValue: 1, durationUnit: 'MONTHLY', maxSessions: 8,
      },
    })
    const now = new Date()
    const inAMonth = new Date(now.getTime() + 30 * 24 * 3600_000)

    await prisma.customerMembership.create({
      data: { organizationId: org.id, customerId: customer.id, membershipPlanId: plan.id, endDate: inAMonth },
    })

    await expect(
      prisma.customerMembership.create({
        data: { organizationId: org.id, customerId: customer.id, membershipPlanId: plan.id, endDate: inAMonth },
      })
    ).rejects.toThrow()
  })

  it('allows a second CustomerMembership once the first is no longer ACTIVE', async () => {
    const org = await prisma.organization.create({
      data: { name: 'Membership Plan Test 2', slug: `mp-test2-${Date.now()}` },
    })
    const user = await prisma.user.create({
      data: { email: `mp2-${Date.now()}@test.com`, passwordHash: 'x', type: 'CUSTOMER', name: 'Plan Holder 2' },
    })
    const customer = await prisma.customer.create({
      data: { organizationId: org.id, userId: user.id, firstName: 'Plan', lastName: 'Two' },
    })
    const plan = await prisma.membershipPlan.create({
      data: {
        organizationId: org.id, name: 'Silver', price: 50,
        durationValue: 1, durationUnit: 'MONTHLY',
      },
    })
    const inAMonth = new Date(Date.now() + 30 * 24 * 3600_000)

    const first = await prisma.customerMembership.create({
      data: { organizationId: org.id, customerId: customer.id, membershipPlanId: plan.id, endDate: inAMonth },
    })
    await prisma.customerMembership.update({ where: { id: first.id }, data: { status: 'EXPIRED' } })

    const second = await prisma.customerMembership.create({
      data: { organizationId: org.id, customerId: customer.id, membershipPlanId: plan.id, endDate: inAMonth },
    })
    expect(second.status).toBe('ACTIVE')

    const history = await prisma.customerMembership.findMany({ where: { customerId: customer.id } })
    expect(history).toHaveLength(2)
  })
})
```

- [ ] **Step 4: Run test**

Run: `npm run test -- membership-schema`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add prisma tests/db
git commit -m "Add MembershipPlan/CustomerMembership schema with one-active-membership DB constraint"
```

---

## Task 7: Loyalty & Rewards Schema

**Files:**
- Modify: `prisma/schema.prisma`
- Test: `tests/db/loyalty-schema.test.ts`

**Interfaces:**
- Consumes: `Organization`, `Customer` from Tasks 2/4.
- Produces: models `LoyaltyAccount`, `LoyaltyTransaction`, `Reward`, `RewardRedemption`; enum `LoyaltyTransactionType`.

- [ ] **Step 1: Add enum and models**

```prisma
enum LoyaltyTransactionType {
  EARN
  REDEEM
  ADJUSTMENT
  EXPIRATION
}

model LoyaltyAccount {
  id             String   @id @default(cuid())
  organizationId String
  organization   Organization @relation(fields: [organizationId], references: [id], onDelete: Cascade)
  customerId     String   @unique
  customer       Customer @relation(fields: [customerId], references: [id], onDelete: Cascade)
  balance        Int      @default(0)
  createdAt      DateTime @default(now())
  updatedAt      DateTime @updatedAt

  transactions LoyaltyTransaction[]

  @@index([organizationId])
}

model LoyaltyTransaction {
  id               String                  @id @default(cuid())
  organizationId   String
  organization     Organization            @relation(fields: [organizationId], references: [id], onDelete: Cascade)
  loyaltyAccountId String
  loyaltyAccount   LoyaltyAccount          @relation(fields: [loyaltyAccountId], references: [id], onDelete: Cascade)
  type             LoyaltyTransactionType
  points           Int
  sourceType       String
  sourceId         String?
  createdAt        DateTime                @default(now())

  redemption RewardRedemption?

  @@index([organizationId])
}

model Reward {
  id             String   @id @default(cuid())
  organizationId String
  organization   Organization @relation(fields: [organizationId], references: [id], onDelete: Cascade)
  name           String
  description    String?
  pointsCost     Int
  isActive       Boolean  @default(true)
  createdAt      DateTime @default(now())

  redemptions RewardRedemption[]

  @@index([organizationId])
}

model RewardRedemption {
  id                   String              @id @default(cuid())
  organizationId       String
  organization         Organization        @relation(fields: [organizationId], references: [id], onDelete: Cascade)
  customerId           String
  customer             Customer            @relation(fields: [customerId], references: [id], onDelete: Cascade)
  rewardId             String
  reward               Reward              @relation(fields: [rewardId], references: [id])
  loyaltyTransactionId String              @unique
  loyaltyTransaction   LoyaltyTransaction  @relation(fields: [loyaltyTransactionId], references: [id])
  status               String              @default("COMPLETED")
  createdAt            DateTime            @default(now())

  @@index([organizationId])
}
```

Add back-relations: `Organization` gets `loyaltyAccounts LoyaltyAccount[]`, `loyaltyTransactions LoyaltyTransaction[]`, `rewards Reward[]`, `rewardRedemptions RewardRedemption[]`; `Customer` gets `loyaltyAccount LoyaltyAccount?`, `rewardRedemptions RewardRedemption[]`.

- [ ] **Step 2: Run migration, then add the idempotency partial unique index by hand**

```bash
npx prisma migrate dev --name add_loyalty_schema --create-only
```

Append to the generated migration SQL:
```sql
CREATE UNIQUE INDEX "LoyaltyTransaction_idempotent_source"
ON "LoyaltyTransaction" ("organizationId", "sourceType", "sourceId")
WHERE "sourceId" IS NOT NULL;
```

```bash
npx prisma migrate dev
```

- [ ] **Step 3: Write the failing test**

`tests/db/loyalty-schema.test.ts`:
```typescript
import { describe, it, expect, afterAll } from 'vitest'
// See the note in Task 3's rbac-schema.test.ts: schema-verification tests use
// rawPrisma directly, aliased to `prisma` so assertions below read naturally.
import { rawPrisma as prisma } from '@/db/raw-client'

describe('loyalty schema', () => {
  afterAll(async () => {
    await prisma.$disconnect()
  })

  it('rejects a second LoyaltyTransaction with the same (organizationId, sourceType, sourceId)', async () => {
    const org = await prisma.organization.create({
      data: { name: 'Loyalty Test', slug: `loy-test-${Date.now()}` },
    })
    const user = await prisma.user.create({
      data: { email: `loy-${Date.now()}@test.com`, passwordHash: 'x', type: 'CUSTOMER', name: 'Loyal One' },
    })
    const customer = await prisma.customer.create({
      data: { organizationId: org.id, userId: user.id, firstName: 'Loyal', lastName: 'One' },
    })
    const account = await prisma.loyaltyAccount.create({
      data: { organizationId: org.id, customerId: customer.id },
    })
    const sessionId = 'session_abc'

    await prisma.loyaltyTransaction.create({
      data: {
        organizationId: org.id, loyaltyAccountId: account.id, type: 'EARN',
        points: 10, sourceType: 'SESSION_COMPLETION', sourceId: sessionId,
      },
    })

    await expect(
      prisma.loyaltyTransaction.create({
        data: {
          organizationId: org.id, loyaltyAccountId: account.id, type: 'EARN',
          points: 10, sourceType: 'SESSION_COMPLETION', sourceId: sessionId,
        },
      })
    ).rejects.toThrow()
  })

  it('allows multiple transactions with a null sourceId (e.g. manual adjustments)', async () => {
    const org = await prisma.organization.create({
      data: { name: 'Loyalty Test 2', slug: `loy-test2-${Date.now()}` },
    })
    const user = await prisma.user.create({
      data: { email: `loy2-${Date.now()}@test.com`, passwordHash: 'x', type: 'CUSTOMER', name: 'Loyal Two' },
    })
    const customer = await prisma.customer.create({
      data: { organizationId: org.id, userId: user.id, firstName: 'Loyal', lastName: 'Two' },
    })
    const account = await prisma.loyaltyAccount.create({
      data: { organizationId: org.id, customerId: customer.id },
    })

    await prisma.loyaltyTransaction.create({
      data: { organizationId: org.id, loyaltyAccountId: account.id, type: 'ADJUSTMENT', points: 5, sourceType: 'MANUAL_ADJUSTMENT' },
    })
    await prisma.loyaltyTransaction.create({
      data: { organizationId: org.id, loyaltyAccountId: account.id, type: 'ADJUSTMENT', points: -2, sourceType: 'MANUAL_ADJUSTMENT' },
    })

    const count = await prisma.loyaltyTransaction.count({ where: { loyaltyAccountId: account.id } })
    expect(count).toBe(2)
  })
})
```

- [ ] **Step 4: Run test**

Run: `npm run test -- loyalty-schema`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add prisma tests/db
git commit -m "Add Loyalty and Rewards schema with idempotent-award DB constraint"
```

---

## Task 8: Payment & Notification Schema

**Files:**
- Modify: `prisma/schema.prisma`
- Test: `tests/db/payment-notification-schema.test.ts`

**Interfaces:**
- Consumes: `Organization`, `Customer`, `Booking`, `User` from prior tasks.
- Produces: models `Payment`, `Notification`; enums `PaymentStatus`, `NotificationChannel`.

- [ ] **Step 1: Add enums and models**

```prisma
enum PaymentStatus {
  PENDING
  SUCCEEDED
  FAILED
  REFUNDED
}

enum NotificationChannel {
  EMAIL
  SMS
  IN_APP
}

model Payment {
  id             String        @id @default(cuid())
  organizationId String
  organization   Organization  @relation(fields: [organizationId], references: [id], onDelete: Cascade)
  customerId     String?
  customer       Customer?     @relation(fields: [customerId], references: [id])
  bookingId      String?
  amount         Decimal       @db.Decimal(10, 2)
  currency       String        @default("USD")
  status         PaymentStatus @default(PENDING)
  method         String?
  createdAt      DateTime      @default(now())

  @@index([organizationId])
}

model Notification {
  id              String              @id @default(cuid())
  organizationId  String
  organization    Organization        @relation(fields: [organizationId], references: [id], onDelete: Cascade)
  recipientUserId String?
  channel         NotificationChannel
  type            String
  payload         Json                @default("{}")
  status          String              @default("PENDING")
  sentAt          DateTime?
  createdAt       DateTime            @default(now())

  @@index([organizationId])
}
```

Add back-relations: `Organization` gets `payments Payment[]`, `notifications Notification[]`; `Customer` gets `payments Payment[]`.

- [ ] **Step 2: Run migration**

```bash
npx prisma migrate dev --name add_payment_notification_schema
```

- [ ] **Step 3: Write the failing test**

`tests/db/payment-notification-schema.test.ts`:
```typescript
import { describe, it, expect, afterAll } from 'vitest'
// See the note in Task 3's rbac-schema.test.ts: schema-verification tests use
// rawPrisma directly, aliased to `prisma` so assertions below read naturally.
import { rawPrisma as prisma } from '@/db/raw-client'

describe('payment & notification schema', () => {
  afterAll(async () => {
    await prisma.$disconnect()
  })

  it('creates a PENDING payment by default', async () => {
    const org = await prisma.organization.create({
      data: { name: 'Payment Test', slug: `pay-test-${Date.now()}` },
    })
    const payment = await prisma.payment.create({
      data: { organizationId: org.id, amount: 50, currency: 'USD' },
    })
    expect(payment.status).toBe('PENDING')
  })

  it('creates an in-app notification with default PENDING status', async () => {
    const org = await prisma.organization.create({
      data: { name: 'Notif Test', slug: `notif-test-${Date.now()}` },
    })
    const notification = await prisma.notification.create({
      data: { organizationId: org.id, channel: 'IN_APP', type: 'BOOKING_CONFIRMED', payload: { bookingId: 'b1' } },
    })
    expect(notification.status).toBe('PENDING')
    expect(notification.sentAt).toBeNull()
  })
})
```

- [ ] **Step 4: Run test**

Run: `npm run test -- payment-notification-schema`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add prisma tests/db
git commit -m "Add Payment and Notification schema"
```

---

## Task 9: Tenant Context & Row-Level Security

**Files:**
- Create: `src/server/tenant/context.ts`
- Create: `prisma/migrations/<timestamp>_enable_rls/migration.sql` (via `prisma migrate dev --create-only`)
- Test: `tests/server/tenant-context.test.ts`

**Interfaces:**
- Consumes: `rawPrisma` from Task 2 (`src/db/raw-client.ts`) — this is the one sanctioned application-layer import of it, per Task 2's docstring.
- Produces: `withTenantContext<T>(organizationId: string, fn: (tx: Prisma.TransactionClient) => Promise<T>): Promise<T>` — the *only* way any application code (Tasks 11-21 onward) can reach a tenant-scoped model, since Task 2's `prisma` Proxy already throws on direct access to one.

- [ ] **Step 1: Write the RLS migration**

```bash
npx prisma migrate dev --name enable_rls --create-only
```

Edit the generated SQL to enable RLS on every tenant-scoped table that has an `organizationId` column, with a policy keyed on the session variable. Repeat the `ENABLE ROW LEVEL SECURITY` + `CREATE POLICY` pair for: `Branch`, `Membership`, `Role` (nullable org — see below), `Customer`, `Staff`, `Horse`, `Service`, `BlockedTime`, `RidingSession`, `Booking`, `CheckIn`, `MembershipPlan`, `CustomerMembership`, `LoyaltyAccount`, `LoyaltyTransaction`, `Reward`, `RewardRedemption`, `Payment`, `Notification`:

```sql
-- Repeat this pair for each tenant-scoped table listed above, substituting the table name:
ALTER TABLE "Customer" ENABLE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON "Customer"
  USING ("organizationId" = current_setting('app.current_tenant_id', true));
```

For `Role`, since `organizationId` is nullable (platform `SUPER_ADMIN` role has none):
```sql
ALTER TABLE "Role" ENABLE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON "Role"
  USING ("organizationId" IS NULL OR "organizationId" = current_setting('app.current_tenant_id', true));
```

`Trainer`, `RolePermission`, `MembershipPlanService`, and `MembershipPlanBranch` have no `organizationId` column (they're join/extension tables), so they get no RLS policy of their own — their isolation depends on always being queried joined to their RLS-protected parent (`Staff`, `Role`, `MembershipPlan`) inside the same `withTenantContext` transaction. They're still blocked from direct top-level access by Task 2's Proxy (nothing is in its platform allowlist except `user`/`organization`/`subscription`/`auditLog`), so there's no path to query them without already being inside a verified tenant context — it just doesn't happen to be reinforced by a Postgres policy for these four.

Apply:
```bash
npx prisma migrate dev
```

- [ ] **Step 2: Write `src/server/tenant/context.ts`**

```typescript
import { Prisma } from '@prisma/client'
import { rawPrisma } from '@/db/raw-client'

export async function withTenantContext<T>(
  organizationId: string,
  fn: (tx: Prisma.TransactionClient) => Promise<T>
): Promise<T> {
  return rawPrisma.$transaction(async (tx) => {
    await tx.$executeRawUnsafe(
      `SET LOCAL app.current_tenant_id = '${organizationId.replace(/'/g, "''")}'`
    )
    return fn(tx)
  })
}
```

- [ ] **Step 3: Write the failing test**

`tests/server/tenant-context.test.ts`:
```typescript
import { describe, it, expect, afterAll } from 'vitest'
import { prisma } from '@/db/client'
import { rawPrisma } from '@/db/raw-client'
import { withTenantContext } from '@/server/tenant/context'

describe('withTenantContext', () => {
  afterAll(async () => {
    await prisma.$disconnect()
  })

  it('only returns rows belonging to the active tenant, for both the write and the read', async () => {
    const orgA = await prisma.organization.create({ data: { name: 'A', slug: `a-${Date.now()}` } })
    const orgB = await prisma.organization.create({ data: { name: 'B', slug: `b-${Date.now()}` } })
    const userA = await prisma.user.create({
      data: { email: `ua-${Date.now()}@test.com`, passwordHash: 'x', type: 'CUSTOMER', name: 'User A' },
    })
    const userB = await prisma.user.create({
      data: { email: `ub-${Date.now()}@test.com`, passwordHash: 'x', type: 'CUSTOMER', name: 'User B' },
    })

    // Writes go through withTenantContext too — there is no other way to create a
    // Customer row at all, since prisma.customer is blocked (Task 2).
    await withTenantContext(orgA.id, (tx) =>
      tx.customer.create({ data: { organizationId: orgA.id, userId: userA.id, firstName: 'A', lastName: 'A' } })
    )
    await withTenantContext(orgB.id, (tx) =>
      tx.customer.create({ data: { organizationId: orgB.id, userId: userB.id, firstName: 'B', lastName: 'B' } })
    )

    const visibleToA = await withTenantContext(orgA.id, (tx) => tx.customer.findMany())
    expect(visibleToA.every((c) => c.organizationId === orgA.id)).toBe(true)
    expect(visibleToA.some((c) => c.organizationId === orgB.id)).toBe(false)
  })

  it('cannot be bypassed: prisma.customer throws before any query runs', () => {
    expect(() => (prisma as unknown as { customer: unknown }).customer).toThrow()
  })

  it('sets a real, verifiable Postgres session variable inside the transaction', async () => {
    const org = await prisma.organization.create({ data: { name: 'Session Var Test', slug: `svt-${Date.now()}` } })
    const observed = await withTenantContext(org.id, async (tx) => {
      const rows = await tx.$queryRawUnsafe<{ current_setting: string }[]>(
        `SELECT current_setting('app.current_tenant_id', true)`
      )
      return rows[0].current_setting
    })
    expect(observed).toBe(org.id)
    // Outside any withTenantContext transaction the setting reverts — SET LOCAL is
    // transaction-scoped by design, so a later unrelated transaction never inherits it.
    const afterCommit = await rawPrisma.$queryRawUnsafe<{ current_setting: string }[]>(
      `SELECT current_setting('app.current_tenant_id', true)`
    )
    expect(afterCommit[0].current_setting).not.toBe(org.id)
  })
})
```

- [ ] **Step 4: Run test**

Run: `npm run test -- tenant-context`
Expected: PASS.

**Remaining, purely operational caveat (not a code gap):** Postgres exempts a table's *owner* from its own RLS policies unless the table is altered with `FORCE ROW LEVEL SECURITY`. The role that ran `prisma migrate dev` owns these tables, so if the app's runtime DB connection uses that same role, the policies from Step 1 are real and enabled but structurally skipped for that role's own queries — meaning RLS is present but not currently filtering anything, regardless of how carefully application code calls `withTenantContext`. This is now purely a deployment/infrastructure choice, not an application-code gap: every tenant-scoped query in this codebase already goes through `withTenantContext` (enforced by Task 2's Proxy, which makes the alternative a thrown error, not just a discouraged pattern) — closing this caveat only requires pointing the runtime connection at a restricted, non-owner Postgres role before handling real customer data, with no further code changes. Track that role switch as a pre-launch infrastructure task, and re-run this file's first test under that role at that time to see it actually block a cross-tenant read rather than merely return correctly-scoped data by virtue of the application-layer filter.

- [ ] **Step 5: Commit**

```bash
git add prisma src/server/tenant tests/server
git commit -m "Enable Postgres RLS on tenant-scoped tables and add withTenantContext helper"
```

---

## Task 10: Auth.js Configuration & Password Utilities

> **Spec correction, noted here rather than silently deviating:** spec §4 calls for "database sessions." Auth.js (NextAuth) v5's Credentials provider does not support the `database` session strategy — it requires `jwt`. We keep the spec's actual intent (never trust cached role/permission data from the client) by using `jwt` strategy with a **minimal token containing only the user id** (`token.sub`) — no role, org, or permission claims ever go in the token — and every authorization check (Task 13) re-queries `Membership`/`Customer`/`Role`/`Permission` fresh from the database by that id on every request. The security property is identical; the session-transport mechanism is not literally a DB-backed session table.

**Files:**
- Create: `src/server/auth/password.ts`
- Create: `src/server/auth/credentials.ts`
- Create: `src/server/auth/config.ts`
- Create: `src/app/api/auth/[...nextauth]/route.ts`
- Test: `tests/server/auth-password.test.ts`
- Test: `tests/server/auth-credentials.test.ts`

**Interfaces:**
- Consumes: `prisma` from Task 2, `User` model.
- Produces: `hashPassword(password: string): Promise<string>`, `verifyPassword(password: string, hash: string): Promise<boolean>`, `verifyCredentials(email: string, password: string): Promise<{id, email, name, type} | null>`, `auth()`/`signIn()`/`signOut()`/`handlers` exported from `src/server/auth/config.ts`.

- [ ] **Step 1: Write the failing password test**

`tests/server/auth-password.test.ts`:
```typescript
import { describe, it, expect } from 'vitest'
import { hashPassword, verifyPassword } from '@/server/auth/password'

describe('password utilities', () => {
  it('hashes a password and verifies it correctly', async () => {
    const hash = await hashPassword('correct-horse-battery-staple')
    expect(hash).not.toBe('correct-horse-battery-staple')
    expect(await verifyPassword('correct-horse-battery-staple', hash)).toBe(true)
    expect(await verifyPassword('wrong-password', hash)).toBe(false)
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm run test -- auth-password`
Expected: FAIL — `Cannot find module '@/server/auth/password'`.

- [ ] **Step 3: Implement `src/server/auth/password.ts`**

```typescript
import bcrypt from 'bcryptjs'

export async function hashPassword(password: string): Promise<string> {
  return bcrypt.hash(password, 12)
}

export async function verifyPassword(password: string, hash: string): Promise<boolean> {
  return bcrypt.compare(password, hash)
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npm run test -- auth-password`
Expected: PASS.

- [ ] **Step 5: Write the failing credentials test**

`tests/server/auth-credentials.test.ts`:
```typescript
import { describe, it, expect, afterAll } from 'vitest'
import { prisma } from '@/db/client'
import { hashPassword } from '@/server/auth/password'
import { verifyCredentials } from '@/server/auth/credentials'

describe('verifyCredentials', () => {
  afterAll(async () => {
    await prisma.$disconnect()
  })

  it('returns the user for correct credentials', async () => {
    const email = `cred-${Date.now()}@test.com`
    await prisma.user.create({
      data: { email, passwordHash: await hashPassword('s3cret-pass'), type: 'STAFF', name: 'Cred User' },
    })
    const result = await verifyCredentials(email, 's3cret-pass')
    expect(result?.email).toBe(email)
    expect(result?.type).toBe('STAFF')
  })

  it('returns null for a wrong password', async () => {
    const email = `cred2-${Date.now()}@test.com`
    await prisma.user.create({
      data: { email, passwordHash: await hashPassword('s3cret-pass'), type: 'STAFF', name: 'Cred User 2' },
    })
    expect(await verifyCredentials(email, 'wrong')).toBeNull()
  })

  it('returns null for a nonexistent email', async () => {
    expect(await verifyCredentials('nobody@test.com', 'whatever')).toBeNull()
  })
})
```

- [ ] **Step 6: Run test to verify it fails, then implement**

`src/server/auth/credentials.ts`:
```typescript
import { prisma } from '@/db/client'
import { verifyPassword } from './password'

export async function verifyCredentials(email: string, password: string) {
  const user = await prisma.user.findUnique({ where: { email } })
  if (!user) return null
  const valid = await verifyPassword(password, user.passwordHash)
  if (!valid) return null
  return { id: user.id, email: user.email, name: user.name, type: user.type }
}
```

Run: `npm run test -- auth-credentials`
Expected: PASS.

- [ ] **Step 7: Wire up Auth.js config (no isolated test — exercised end-to-end in Task 11/12)**

`src/server/auth/config.ts`:
```typescript
import NextAuth from 'next-auth'
import Credentials from 'next-auth/providers/credentials'
import { verifyCredentials } from './credentials'

export const { handlers, auth, signIn, signOut } = NextAuth({
  session: { strategy: 'jwt' },
  pages: { signIn: '/staff/sign-in' },
  providers: [
    Credentials({
      credentials: { email: {}, password: {} },
      authorize: async (raw) => {
        const email = raw?.email as string | undefined
        const password = raw?.password as string | undefined
        if (!email || !password) return null
        const user = await verifyCredentials(email, password)
        if (!user) return null
        return { id: user.id, email: user.email, name: user.name }
      },
    }),
  ],
  callbacks: {
    async jwt({ token, user }) {
      if (user) token.sub = user.id
      return token
    },
    async session({ session, token }) {
      if (token.sub && session.user) session.user.id = token.sub
      return session
    },
  },
})
```

`src/app/api/auth/[...nextauth]/route.ts`:
```typescript
import { handlers } from '@/server/auth/config'

export const { GET, POST } = handlers
```

Add `NEXTAUTH_SECRET` to your local `.env` (generate with `openssl rand -base64 32`).

- [ ] **Step 8: Commit**

```bash
git add src/server/auth src/app/api/auth tests/server
git commit -m "Add Auth.js config, password hashing, and credentials verification"
```

---

## Task 11: Staff Account Creation & Sign-In

> Email-based invite delivery is deferred to the notifications/email-provider phase (spec Phase 6, no provider chosen yet). Phase 0 creates staff accounts directly with a password so the full login flow is real and testable now, rather than shipping a fake "invite sent" button that sends nothing.

**Files:**
- Create: `src/server/actions/staff-auth.ts`
- Create: `src/app/(auth)/staff/sign-in/page.tsx`
- Test: `tests/server/staff-auth.test.ts`

**Interfaces:**
- Consumes: `hashPassword` from Task 10; `withTenantContext` from Task 9; `Role`/`Membership`/`Staff` models from Task 3/4.
- Produces: `createStaffAccount(input): Promise<{ userId: string; staffId: string }>`.

- [ ] **Step 1: Write the failing test**

`tests/server/staff-auth.test.ts`:
```typescript
import { describe, it, expect, afterAll } from 'vitest'
import { prisma } from '@/db/client'
import { withTenantContext } from '@/server/tenant/context'
import { createStaffAccount } from '@/server/actions/staff-auth'
import { verifyCredentials } from '@/server/auth/credentials'

describe('createStaffAccount', () => {
  afterAll(async () => {
    await prisma.$disconnect()
  })

  it('creates a User, Staff, and Membership row, and the account can then log in', async () => {
    const org = await prisma.organization.create({
      data: { name: 'Staff Auth Test', slug: `staff-auth-${Date.now()}` },
    })
    const role = await withTenantContext(org.id, (tx) => tx.role.create({ data: { organizationId: org.id, name: 'OWNER' } }))
    const email = `owner-${Date.now()}@test.com`

    const { userId, staffId } = await createStaffAccount({
      organizationId: org.id, email, password: 'owner-password-1', name: 'Org Owner', roleId: role.id,
    })

    expect(userId).toBeTruthy()
    expect(staffId).toBeTruthy()

    const membership = await withTenantContext(org.id, (tx) =>
      tx.membership.findUniqueOrThrow({ where: { userId_organizationId: { userId, organizationId: org.id } } })
    )
    expect(membership.roleId).toBe(role.id)

    const loggedIn = await verifyCredentials(email, 'owner-password-1')
    expect(loggedIn?.id).toBe(userId)
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm run test -- staff-auth`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement `src/server/actions/staff-auth.ts`**

```typescript
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
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npm run test -- staff-auth`
Expected: PASS.

- [ ] **Step 5: Add shadcn form components and build the sign-in page**

```bash
npx shadcn@latest add button input card label form
```

`src/app/(auth)/staff/sign-in/page.tsx`:
```tsx
'use client'

import { useState } from 'react'
import { signIn } from 'next-auth/react'
import { useRouter } from 'next/navigation'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'

export default function StaffSignInPage() {
  const router = useRouter()
  const [email, setEmail] = useState('')
  const [password, setPassword] = useState('')
  const [error, setError] = useState<string | null>(null)
  const [submitting, setSubmitting] = useState(false)

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault()
    setSubmitting(true)
    setError(null)
    const result = await signIn('credentials', { email, password, redirect: false })
    setSubmitting(false)
    if (result?.error) {
      setError('Incorrect email or password.')
      return
    }
    router.push('/admin')
  }

  return (
    <div className="flex min-h-screen items-center justify-center bg-stone-50 px-4">
      <Card className="w-full max-w-sm border-stone-200 shadow-sm">
        <CardHeader>
          <CardTitle className="font-serif text-2xl text-stone-900">Staff sign in</CardTitle>
        </CardHeader>
        <CardContent>
          <form onSubmit={handleSubmit} className="space-y-4">
            <div className="space-y-1.5">
              <Label htmlFor="email">Email</Label>
              <Input id="email" type="email" value={email} onChange={(e) => setEmail(e.target.value)} required />
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="password">Password</Label>
              <Input id="password" type="password" value={password} onChange={(e) => setPassword(e.target.value)} required />
            </div>
            {error && <p className="text-sm text-red-600">{error}</p>}
            <Button type="submit" className="w-full" disabled={submitting}>
              {submitting ? 'Signing in…' : 'Sign in'}
            </Button>
          </form>
        </CardContent>
      </Card>
    </div>
  )
}
```

- [ ] **Step 6: Verify manually**

Run: `npm run dev`, visit `/staff/sign-in`, confirm the styled form renders (login itself is exercised by the automated test above; manual check is for visual/UX confirmation only).

- [ ] **Step 7: Commit**

```bash
git add src/server/actions/staff-auth.ts "src/app/(auth)/staff" tests/server
git commit -m "Add staff account creation and sign-in page"
```

---

## Task 12: Customer Account Creation, QR Token, & Sign-In

**Files:**
- Create: `src/server/actions/customer-auth.ts`
- Create: `src/app/(auth)/customer/sign-in/page.tsx`
- Test: `tests/server/customer-auth.test.ts`

**Interfaces:**
- Consumes: `hashPassword` from Task 10; `withTenantContext` from Task 9; `Customer` model from Task 4.
- Produces: `createCustomerAccount(input): Promise<{ userId: string; customerId: string; qrToken: string }>`.

- [ ] **Step 1: Write the failing test**

`tests/server/customer-auth.test.ts`:
```typescript
import { describe, it, expect, afterAll } from 'vitest'
import { prisma } from '@/db/client'
import { withTenantContext } from '@/server/tenant/context'
import { createCustomerAccount } from '@/server/actions/customer-auth'
import { verifyCredentials } from '@/server/auth/credentials'

describe('createCustomerAccount', () => {
  afterAll(async () => {
    await prisma.$disconnect()
  })

  it('creates a User(type=CUSTOMER) and Customer row with a qrToken, and can log in', async () => {
    const org = await prisma.organization.create({
      data: { name: 'Customer Auth Test', slug: `cust-auth-${Date.now()}` },
    })
    const email = `rider-${Date.now()}@test.com`

    const { userId, customerId, qrToken } = await createCustomerAccount({
      organizationId: org.id, email, password: 'rider-password-1', firstName: 'Rider', lastName: 'One',
    })

    expect(qrToken).toBeTruthy()
    const customer = await withTenantContext(org.id, (tx) => tx.customer.findUniqueOrThrow({ where: { id: customerId } }))
    expect(customer.userId).toBe(userId)
    expect(customer.qrToken).toBe(qrToken)

    const loggedIn = await verifyCredentials(email, 'rider-password-1')
    expect(loggedIn?.type).toBe('CUSTOMER')
  })

  it('rejects creating a second Customer profile for the same user in the same organization', async () => {
    const org = await prisma.organization.create({
      data: { name: 'Dup Customer Test', slug: `dup-cust-${Date.now()}` },
    })
    const email = `dup-${Date.now()}@test.com`
    await createCustomerAccount({ organizationId: org.id, email, password: 'password-1', firstName: 'A', lastName: 'B' })

    await expect(
      createCustomerAccount({ organizationId: org.id, email, password: 'password-1', firstName: 'A', lastName: 'B' })
    ).rejects.toThrow()
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm run test -- customer-auth`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement `src/server/actions/customer-auth.ts`**

```typescript
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
```

Note: a duplicate `(organizationId, userId)` attempt hits the `Customer` unique constraint from Task 4 and throws — that's what the second test verifies.

- [ ] **Step 4: Run test to verify it passes**

Run: `npm run test -- customer-auth`
Expected: PASS.

- [ ] **Step 5: Build the customer sign-in page**

`src/app/(auth)/customer/sign-in/page.tsx`:
```tsx
'use client'

import { useState } from 'react'
import { signIn } from 'next-auth/react'
import { useRouter, useParams } from 'next/navigation'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'

export default function CustomerSignInPage() {
  const router = useRouter()
  const params = useParams<{ orgSlug: string }>()
  const [email, setEmail] = useState('')
  const [password, setPassword] = useState('')
  const [error, setError] = useState<string | null>(null)
  const [submitting, setSubmitting] = useState(false)

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault()
    setSubmitting(true)
    setError(null)
    const result = await signIn('credentials', { email, password, redirect: false })
    setSubmitting(false)
    if (result?.error) {
      setError('Incorrect email or password.')
      return
    }
    router.push(`/${params.orgSlug}/portal`)
  }

  return (
    <div className="flex min-h-screen items-center justify-center bg-stone-50 px-4">
      <Card className="w-full max-w-sm border-stone-200 shadow-sm">
        <CardHeader>
          <CardTitle className="font-serif text-2xl text-stone-900">Welcome back</CardTitle>
        </CardHeader>
        <CardContent>
          <form onSubmit={handleSubmit} className="space-y-4">
            <div className="space-y-1.5">
              <Label htmlFor="email">Email</Label>
              <Input id="email" type="email" value={email} onChange={(e) => setEmail(e.target.value)} required />
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="password">Password</Label>
              <Input id="password" type="password" value={password} onChange={(e) => setPassword(e.target.value)} required />
            </div>
            {error && <p className="text-sm text-red-600">{error}</p>}
            <Button type="submit" className="w-full" disabled={submitting}>
              {submitting ? 'Signing in…' : 'Sign in'}
            </Button>
          </form>
        </CardContent>
      </Card>
    </div>
  )
}
```

- [ ] **Step 6: Commit**

```bash
git add src/server/actions/customer-auth.ts "src/app/(auth)/customer" tests/server
git commit -m "Add customer account creation with QR token and sign-in page"
```

---

## Task 13: RBAC Guard Functions

**Files:**
- Create: `src/server/auth/guards.ts`
- Test: `tests/server/auth-guards.test.ts`

**Interfaces:**
- Consumes: `auth()` from Task 10; `withTenantContext` from Task 9; `Membership`/`Role`/`Permission`/`Customer` models.
- Produces: `getSessionUser(): Promise<{ id: string; type: UserType } | null>`, `requirePermission(organizationId: string, permission: Permission): Promise<{ userId: string; membershipId: string }>` (throws if unauthorized), `requireCustomer(organizationId: string): Promise<{ userId: string; customerId: string }>` (throws if not a customer of that org). **These two are where every later task's tenant-scoped access starts** — they establish the verified `organizationId` and immediately do their own lookup inside `withTenantContext`, so nothing downstream ever receives an unverified tenant id.

- [ ] **Step 1: Write the failing test**

`tests/server/auth-guards.test.ts`:
```typescript
import { describe, it, expect, afterAll, vi } from 'vitest'
import { prisma } from '@/db/client'
// Test fixtures for tenant-scoped models (Role, Membership, Customer) go through
// withTenantContext, same as application code would — see Task 9.
import { withTenantContext } from '@/server/tenant/context'
import { requirePermission, requireCustomer } from '@/server/auth/guards'

vi.mock('@/server/auth/config', () => ({
  auth: vi.fn(),
}))

import { auth } from '@/server/auth/config'

describe('requirePermission', () => {
  afterAll(async () => {
    await prisma.$disconnect()
  })

  it('resolves for a staff member whose role has the permission', async () => {
    const org = await prisma.organization.create({ data: { name: 'Guard Test', slug: `guard-${Date.now()}` } })
    const permission = await prisma.permission.upsert({
      where: { key: 'bookings.manage' }, update: {}, create: { key: 'bookings.manage', description: 'x' },
    })
    const user = await prisma.user.create({
      data: { email: `guard-${Date.now()}@test.com`, passwordHash: 'x', type: 'STAFF', name: 'Guard User' },
    })
    await withTenantContext(org.id, async (tx) => {
      const role = await tx.role.create({ data: { organizationId: org.id, name: 'FRONT_DESK' } })
      await tx.rolePermission.create({ data: { roleId: role.id, permissionId: permission.id } })
      await tx.membership.create({ data: { userId: user.id, organizationId: org.id, roleId: role.id } })
    })

    vi.mocked(auth).mockResolvedValue({ user: { id: user.id } } as never)

    const result = await requirePermission(org.id, 'bookings.manage')
    expect(result.userId).toBe(user.id)
  })

  it('throws for a staff member whose role lacks the permission', async () => {
    const org = await prisma.organization.create({ data: { name: 'Guard Test 2', slug: `guard2-${Date.now()}` } })
    const user = await prisma.user.create({
      data: { email: `guard2-${Date.now()}@test.com`, passwordHash: 'x', type: 'STAFF', name: 'Guard User 2' },
    })
    await withTenantContext(org.id, async (tx) => {
      const role = await tx.role.create({ data: { organizationId: org.id, name: 'TRAINER' } })
      await tx.membership.create({ data: { userId: user.id, organizationId: org.id, roleId: role.id } })
    })

    vi.mocked(auth).mockResolvedValue({ user: { id: user.id } } as never)

    await expect(requirePermission(org.id, 'bookings.manage')).rejects.toThrow()
  })

  it('throws for a customer even if they happen to know a permission string', async () => {
    const org = await prisma.organization.create({ data: { name: 'Guard Test 3', slug: `guard3-${Date.now()}` } })
    const user = await prisma.user.create({
      data: { email: `guard3-${Date.now()}@test.com`, passwordHash: 'x', type: 'CUSTOMER', name: 'Customer Guard' },
    })
    await withTenantContext(org.id, (tx) =>
      tx.customer.create({ data: { organizationId: org.id, userId: user.id, firstName: 'C', lastName: 'G' } })
    )

    vi.mocked(auth).mockResolvedValue({ user: { id: user.id } } as never)

    await expect(requirePermission(org.id, 'bookings.manage')).rejects.toThrow()
  })
})

describe('requireCustomer', () => {
  it('resolves for a customer of that organization', async () => {
    const org = await prisma.organization.create({ data: { name: 'Guard Test 4', slug: `guard4-${Date.now()}` } })
    const user = await prisma.user.create({
      data: { email: `guard4-${Date.now()}@test.com`, passwordHash: 'x', type: 'CUSTOMER', name: 'Customer Four' },
    })
    const customer = await withTenantContext(org.id, (tx) =>
      tx.customer.create({ data: { organizationId: org.id, userId: user.id, firstName: 'C', lastName: 'F' } })
    )

    vi.mocked(auth).mockResolvedValue({ user: { id: user.id } } as never)

    const result = await requireCustomer(org.id)
    expect(result.customerId).toBe(customer.id)
  })

  it('throws for a staff member (never grants customer-portal access to staff)', async () => {
    const org = await prisma.organization.create({ data: { name: 'Guard Test 5', slug: `guard5-${Date.now()}` } })
    const user = await prisma.user.create({
      data: { email: `guard5-${Date.now()}@test.com`, passwordHash: 'x', type: 'STAFF', name: 'Staff Five' },
    })
    await withTenantContext(org.id, async (tx) => {
      const role = await tx.role.create({ data: { organizationId: org.id, name: 'OWNER' } })
      await tx.membership.create({ data: { userId: user.id, organizationId: org.id, roleId: role.id } })
    })

    vi.mocked(auth).mockResolvedValue({ user: { id: user.id } } as never)

    await expect(requireCustomer(org.id)).rejects.toThrow()
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm run test -- auth-guards`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement `src/server/auth/guards.ts`**

```typescript
import { prisma } from '@/db/client'
import { auth } from '@/server/auth/config'
import { withTenantContext } from '@/server/tenant/context'
import type { Permission } from '@/config/permissions'

export async function getSessionUser() {
  const session = await auth()
  if (!session?.user?.id) return null
  const user = await prisma.user.findUnique({ where: { id: session.user.id } })
  if (!user) return null
  return { id: user.id, type: user.type }
}

export async function requirePermission(organizationId: string, permission: Permission) {
  const sessionUser = await getSessionUser()
  if (!sessionUser || sessionUser.type !== 'STAFF') {
    throw new Error('Not authorized: staff session required')
  }
  return withTenantContext(organizationId, async (tx) => {
    const membership = await tx.membership.findUnique({
      where: { userId_organizationId: { userId: sessionUser.id, organizationId } },
      include: { role: { include: { permissions: { include: { permission: true } } } } },
    })
    if (!membership) throw new Error('Not authorized: no membership in this organization')
    const hasPermission = membership.role.permissions.some((rp) => rp.permission.key === permission)
    if (!hasPermission) throw new Error(`Not authorized: missing permission ${permission}`)
    return { userId: sessionUser.id, membershipId: membership.id }
  })
}

export async function requireCustomer(organizationId: string) {
  const sessionUser = await getSessionUser()
  if (!sessionUser || sessionUser.type !== 'CUSTOMER') {
    throw new Error('Not authorized: customer session required')
  }
  return withTenantContext(organizationId, async (tx) => {
    const customer = await tx.customer.findUnique({
      where: { organizationId_userId: { organizationId, userId: sessionUser.id } },
    })
    if (!customer) throw new Error('Not authorized: no customer profile in this organization')
    return { userId: sessionUser.id, customerId: customer.id }
  })
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npm run test -- auth-guards`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/server/auth/guards.ts tests/server
git commit -m "Add requirePermission and requireCustomer RBAC guards"
```

---

## Task 14: Billing Abstraction — PaymentProvider Interface, Stripe Implementation, BillingService

**Files:**
- Create: `src/server/billing/PaymentProvider.ts`
- Create: `src/server/billing/providers/StripeProvider.ts`
- Create: `src/server/billing/BillingService.ts`
- Test: `tests/server/stripe-provider.test.ts`
- Test: `tests/server/billing-service.test.ts`

**Interfaces:**
- Consumes: `prisma`, `Subscription`/`Organization` models.
- Produces: `PaymentProvider` interface; `StripeProvider` (constructor-injected `Stripe` client, for testability); `BillingService` with `startSubscription()`, `applyWebhookEvent()`, `isOrganizationActive()`.

- [ ] **Step 1: Install the Stripe SDK types (already installed in Task 1) and define the interface**

`src/server/billing/PaymentProvider.ts`:
```typescript
export type NormalizedBillingEvent =
  | { type: 'subscription.updated'; organizationId: string; providerSubscriptionId: string; status: 'ACTIVE' | 'PAST_DUE' | 'CANCELED' | 'UNPAID'; currentPeriodEnd: Date }
  | { type: 'subscription.canceled'; organizationId: string; providerSubscriptionId: string }

export interface ProviderChargeResult {
  providerChargeId: string
  status: 'SUCCEEDED' | 'PENDING' | 'FAILED'
}

export interface PaymentProvider {
  createCustomer(input: { organizationId: string; name: string; email: string }): Promise<string>
  createCheckoutSession(input: {
    organizationId: string
    providerCustomerId: string
    planId: string
    successUrl: string
    cancelUrl: string
  }): Promise<string>
  cancelSubscription(providerSubscriptionId: string): Promise<void>
  createOneOffCharge(input: {
    providerCustomerId: string
    amount: number
    currency: string
    metadata: Record<string, string>
  }): Promise<ProviderChargeResult>
  verifyAndParseWebhookEvent(rawBody: string, signature: string): NormalizedBillingEvent
}
```

- [ ] **Step 2: Write the failing StripeProvider test**

`tests/server/stripe-provider.test.ts`:
```typescript
import { describe, it, expect, vi } from 'vitest'
import type Stripe from 'stripe'
import { StripeProvider } from '@/server/billing/providers/StripeProvider'

function fakeStripe(overrides: Partial<Stripe> = {}) {
  return {
    checkout: { sessions: { create: vi.fn() } },
    customers: { create: vi.fn() },
    subscriptions: { cancel: vi.fn() },
    paymentIntents: { create: vi.fn() },
    webhooks: { constructEvent: vi.fn() },
    ...overrides,
  } as unknown as Stripe
}

describe('StripeProvider', () => {
  it('never sets a trial period when creating a checkout session', async () => {
    const stripe = fakeStripe()
    ;(stripe.checkout.sessions.create as ReturnType<typeof vi.fn>).mockResolvedValue({ url: 'https://checkout.stripe.com/x' })
    const provider = new StripeProvider(stripe, 'whsec_test')

    await provider.createCheckoutSession({
      organizationId: 'org_1', providerCustomerId: 'cus_1', planId: 'price_1',
      successUrl: 'https://x/success', cancelUrl: 'https://x/cancel',
    })

    const callArgs = (stripe.checkout.sessions.create as ReturnType<typeof vi.fn>).mock.calls[0][0]
    expect(callArgs.subscription_data?.trial_period_days).toBeUndefined()
    expect(callArgs.mode).toBe('subscription')
  })

  it('maps an active Stripe subscription webhook to a normalized ACTIVE event', () => {
    const stripe = fakeStripe()
    ;(stripe.webhooks.constructEvent as ReturnType<typeof vi.fn>).mockReturnValue({
      type: 'customer.subscription.updated',
      data: { object: { id: 'sub_1', status: 'active', current_period_end: 1_700_000_000, metadata: { organizationId: 'org_1' } } },
    })
    const provider = new StripeProvider(stripe, 'whsec_test')

    const event = provider.verifyAndParseWebhookEvent('{}', 'sig')

    expect(event).toEqual({
      type: 'subscription.updated', organizationId: 'org_1', providerSubscriptionId: 'sub_1',
      status: 'ACTIVE', currentPeriodEnd: new Date(1_700_000_000 * 1000),
    })
  })
})
```

- [ ] **Step 3: Run test to verify it fails**

Run: `npm run test -- stripe-provider`
Expected: FAIL — module not found.

- [ ] **Step 4: Implement `src/server/billing/providers/StripeProvider.ts`**

```typescript
import type Stripe from 'stripe'
import type { PaymentProvider, NormalizedBillingEvent, ProviderChargeResult } from '../PaymentProvider'

const STATUS_MAP: Record<string, 'ACTIVE' | 'PAST_DUE' | 'CANCELED' | 'UNPAID'> = {
  active: 'ACTIVE',
  past_due: 'PAST_DUE',
  canceled: 'CANCELED',
  unpaid: 'UNPAID',
  incomplete: 'UNPAID',
  incomplete_expired: 'CANCELED',
}

export class StripeProvider implements PaymentProvider {
  constructor(private readonly stripe: Stripe, private readonly webhookSecret: string) {}

  async createCustomer(input: { organizationId: string; name: string; email: string }): Promise<string> {
    const customer = await this.stripe.customers.create({
      name: input.name,
      email: input.email,
      metadata: { organizationId: input.organizationId },
    })
    return customer.id
  }

  async createCheckoutSession(input: {
    organizationId: string
    providerCustomerId: string
    planId: string
    successUrl: string
    cancelUrl: string
  }): Promise<string> {
    const session = await this.stripe.checkout.sessions.create({
      mode: 'subscription',
      customer: input.providerCustomerId,
      line_items: [{ price: input.planId, quantity: 1 }],
      success_url: input.successUrl,
      cancel_url: input.cancelUrl,
      subscription_data: { metadata: { organizationId: input.organizationId } },
    })
    if (!session.url) throw new Error('Stripe did not return a checkout URL')
    return session.url
  }

  async cancelSubscription(providerSubscriptionId: string): Promise<void> {
    await this.stripe.subscriptions.cancel(providerSubscriptionId)
  }

  async createOneOffCharge(input: {
    providerCustomerId: string
    amount: number
    currency: string
    metadata: Record<string, string>
  }): Promise<ProviderChargeResult> {
    const intent = await this.stripe.paymentIntents.create({
      amount: Math.round(input.amount * 100),
      currency: input.currency,
      customer: input.providerCustomerId,
      metadata: input.metadata,
      confirm: true,
      automatic_payment_methods: { enabled: true, allow_redirects: 'never' },
    })
    return {
      providerChargeId: intent.id,
      status: intent.status === 'succeeded' ? 'SUCCEEDED' : intent.status === 'requires_payment_method' ? 'FAILED' : 'PENDING',
    }
  }

  verifyAndParseWebhookEvent(rawBody: string, signature: string): NormalizedBillingEvent {
    const event = this.stripe.webhooks.constructEvent(rawBody, signature, this.webhookSecret)
    if (event.type === 'customer.subscription.created' || event.type === 'customer.subscription.updated') {
      const sub = event.data.object as Stripe.Subscription
      return {
        type: 'subscription.updated',
        organizationId: sub.metadata.organizationId,
        providerSubscriptionId: sub.id,
        status: STATUS_MAP[sub.status] ?? 'UNPAID',
        currentPeriodEnd: new Date(sub.current_period_end * 1000),
      }
    }
    if (event.type === 'customer.subscription.deleted') {
      const sub = event.data.object as Stripe.Subscription
      return { type: 'subscription.canceled', organizationId: sub.metadata.organizationId, providerSubscriptionId: sub.id }
    }
    throw new Error(`Unhandled Stripe event type: ${event.type}`)
  }
}
```

- [ ] **Step 5: Run test to verify it passes**

Run: `npm run test -- stripe-provider`
Expected: PASS.

- [ ] **Step 6: Write the failing BillingService test (using a fake provider — no Stripe involved)**

`tests/server/billing-service.test.ts`:
```typescript
import { describe, it, expect, afterAll } from 'vitest'
import { prisma } from '@/db/client'
import { BillingService } from '@/server/billing/BillingService'
import type { PaymentProvider } from '@/server/billing/PaymentProvider'

function fakeProvider(overrides: Partial<PaymentProvider> = {}): PaymentProvider {
  return {
    createCustomer: async () => 'cus_fake',
    createCheckoutSession: async () => 'https://fake.checkout/session',
    cancelSubscription: async () => {},
    createOneOffCharge: async () => ({ providerChargeId: 'ch_fake', status: 'SUCCEEDED' }),
    verifyAndParseWebhookEvent: () => {
      throw new Error('not used in this test')
    },
    ...overrides,
  }
}

describe('BillingService', () => {
  afterAll(async () => {
    await prisma.$disconnect()
  })

  it('creates a Subscription row in INCOMPLETE status when starting a subscription', async () => {
    const org = await prisma.organization.create({ data: { name: 'Billing Test', slug: `billing-${Date.now()}` } })
    const service = new BillingService(fakeProvider(), 'stripe')

    await service.startSubscription(org.id, 'price_basic', 'https://x/success', 'https://x/cancel')

    const sub = await prisma.subscription.findUniqueOrThrow({ where: { organizationId: org.id } })
    expect(sub.status).toBe('INCOMPLETE')
    expect(sub.provider).toBe('stripe')
  })

  it('flips a subscription to ACTIVE when a subscription.updated event arrives', async () => {
    const org = await prisma.organization.create({ data: { name: 'Billing Test 2', slug: `billing2-${Date.now()}` } })
    const service = new BillingService(fakeProvider(), 'stripe')
    await service.startSubscription(org.id, 'price_basic', 'https://x/success', 'https://x/cancel')

    await service.applyWebhookEvent({
      type: 'subscription.updated', organizationId: org.id, providerSubscriptionId: 'sub_fake',
      status: 'ACTIVE', currentPeriodEnd: new Date(),
    })

    expect(await service.isOrganizationActive(org.id)).toBe(true)
  })

  it('gates access when the subscription has never gone active', async () => {
    const org = await prisma.organization.create({ data: { name: 'Billing Test 3', slug: `billing3-${Date.now()}` } })
    expect(await new BillingService(fakeProvider(), 'stripe').isOrganizationActive(org.id)).toBe(false)
  })
})
```

- [ ] **Step 7: Run test to verify it fails, then implement**

`src/server/billing/BillingService.ts`:
```typescript
import { prisma } from '@/db/client'
import type { PaymentProvider, NormalizedBillingEvent } from './PaymentProvider'

export class BillingService {
  constructor(private readonly provider: PaymentProvider, private readonly providerName: string) {}

  async startSubscription(organizationId: string, planId: string, successUrl: string, cancelUrl: string) {
    const org = await prisma.organization.findUniqueOrThrow({ where: { id: organizationId } })
    let subscription = await prisma.subscription.findUnique({ where: { organizationId } })

    const providerCustomerId =
      subscription?.providerCustomerId ??
      (await this.provider.createCustomer({
        organizationId,
        name: org.name,
        email: `billing+${org.slug}@equestrianloop.app`,
      }))

    if (!subscription) {
      subscription = await prisma.subscription.create({
        data: { organizationId, provider: this.providerName, providerCustomerId, planId, status: 'INCOMPLETE' },
      })
    }

    return this.provider.createCheckoutSession({ organizationId, providerCustomerId, planId, successUrl, cancelUrl })
  }

  async applyWebhookEvent(event: NormalizedBillingEvent) {
    if (event.type === 'subscription.updated') {
      await prisma.subscription.update({
        where: { organizationId: event.organizationId },
        data: {
          status: event.status,
          providerSubscriptionId: event.providerSubscriptionId,
          currentPeriodEnd: event.currentPeriodEnd,
        },
      })
    } else if (event.type === 'subscription.canceled') {
      await prisma.subscription.update({ where: { organizationId: event.organizationId }, data: { status: 'CANCELED' } })
    }
  }

  async isOrganizationActive(organizationId: string): Promise<boolean> {
    const sub = await prisma.subscription.findUnique({ where: { organizationId } })
    return sub?.status === 'ACTIVE'
  }
}
```

Run: `npm run test -- billing-service`
Expected: PASS.

- [ ] **Step 8: Commit**

```bash
git add src/server/billing tests/server
git commit -m "Add provider-agnostic billing: PaymentProvider interface, StripeProvider, BillingService"
```

---

## Task 15: Stripe Webhook Route & Subscription Access Gating

**Files:**
- Create: `src/app/api/webhooks/[provider]/route.ts`
- Create: `src/server/billing/guards.ts`
- Test: `tests/server/billing-guards.test.ts`

**Interfaces:**
- Consumes: `BillingService`, `StripeProvider` from Task 14.
- Produces: `POST /api/webhooks/stripe`; `assertOrganizationActive(organizationId: string): Promise<void>` (throws `OrganizationInactiveError` if not active) — used by the dashboard/portal layouts in Tasks 20-22.

- [ ] **Step 1: Implement the webhook route**

`src/app/api/webhooks/[provider]/route.ts`:
```typescript
import { NextRequest, NextResponse } from 'next/server'
import Stripe from 'stripe'
import { StripeProvider } from '@/server/billing/providers/StripeProvider'
import { BillingService } from '@/server/billing/BillingService'

export async function POST(req: NextRequest, { params }: { params: Promise<{ provider: string }> }) {
  const { provider } = await params
  if (provider !== 'stripe') {
    return NextResponse.json({ error: 'Unknown payment provider' }, { status: 404 })
  }

  const signature = req.headers.get('stripe-signature')
  if (!signature) {
    return NextResponse.json({ error: 'Missing stripe-signature header' }, { status: 400 })
  }

  const rawBody = await req.text()
  const stripe = new Stripe(process.env.STRIPE_SECRET_KEY!)
  const stripeProvider = new StripeProvider(stripe, process.env.STRIPE_WEBHOOK_SECRET!)
  const billingService = new BillingService(stripeProvider, 'stripe')

  try {
    const event = stripeProvider.verifyAndParseWebhookEvent(rawBody, signature)
    await billingService.applyWebhookEvent(event)
    return NextResponse.json({ received: true })
  } catch (err) {
    return NextResponse.json({ error: (err as Error).message }, { status: 400 })
  }
}
```

This route is exercised by Stripe's own signature-verification round trip and is intentionally not unit tested in isolation (it's a thin composition of already-tested `StripeProvider`/`BillingService`); verify manually with `stripe listen --forward-to localhost:3000/api/webhooks/stripe` once Stripe keys are configured.

- [ ] **Step 2: Write the failing gating test**

`tests/server/billing-guards.test.ts`:
```typescript
import { describe, it, expect, afterAll } from 'vitest'
import { prisma } from '@/db/client'
import { assertOrganizationActive, OrganizationInactiveError } from '@/server/billing/guards'

describe('assertOrganizationActive', () => {
  afterAll(async () => {
    await prisma.$disconnect()
  })

  it('throws OrganizationInactiveError when there is no subscription at all', async () => {
    const org = await prisma.organization.create({ data: { name: 'Gate Test', slug: `gate-${Date.now()}` } })
    await expect(assertOrganizationActive(org.id)).rejects.toThrow(OrganizationInactiveError)
  })

  it('throws when the subscription exists but is not ACTIVE', async () => {
    const org = await prisma.organization.create({ data: { name: 'Gate Test 2', slug: `gate2-${Date.now()}` } })
    await prisma.subscription.create({
      data: { organizationId: org.id, provider: 'stripe', providerCustomerId: 'cus_x', planId: 'price_x', status: 'PAST_DUE' },
    })
    await expect(assertOrganizationActive(org.id)).rejects.toThrow(OrganizationInactiveError)
  })

  it('resolves silently when ACTIVE', async () => {
    const org = await prisma.organization.create({ data: { name: 'Gate Test 3', slug: `gate3-${Date.now()}` } })
    await prisma.subscription.create({
      data: { organizationId: org.id, provider: 'stripe', providerCustomerId: 'cus_y', planId: 'price_y', status: 'ACTIVE' },
    })
    await expect(assertOrganizationActive(org.id)).resolves.toBeUndefined()
  })
})
```

- [ ] **Step 3: Run test to verify it fails, then implement**

`src/server/billing/guards.ts`:
```typescript
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
```

Run: `npm run test -- billing-guards`
Expected: PASS.

- [ ] **Step 4: Commit**

```bash
git add src/app/api/webhooks src/server/billing/guards.ts tests/server
git commit -m "Add Stripe webhook route and subscription access gating"
```

---

## Task 16: Storage Abstraction — StorageProvider Interface & Supabase Implementation

**Files:**
- Create: `src/server/storage/StorageProvider.ts`
- Create: `src/server/storage/providers/SupabaseStorageProvider.ts`
- Create: `src/server/storage/StorageService.ts`
- Test: `tests/server/supabase-storage-provider.test.ts`

**Interfaces:**
- Produces: `StorageProvider` interface (`upload`, `getUrl`, `delete`); `SupabaseStorageProvider implements StorageProvider`; `getStorageService(): StorageProvider` factory used by all app code (e.g. horse photo upload in a later phase).

- [ ] **Step 1: Install the Supabase client**

```bash
npm install @supabase/supabase-js
```

- [ ] **Step 2: Define the interface**

`src/server/storage/StorageProvider.ts`:
```typescript
export interface StorageProvider {
  upload(input: { path: string; file: Buffer; contentType: string }): Promise<void>
  getUrl(path: string): string
  delete(path: string): Promise<void>
}
```

- [ ] **Step 3: Write the failing test**

`tests/server/supabase-storage-provider.test.ts`:
```typescript
import { describe, it, expect, vi } from 'vitest'
import type { SupabaseClient } from '@supabase/supabase-js'
import { SupabaseStorageProvider } from '@/server/storage/providers/SupabaseStorageProvider'

function fakeSupabaseClient() {
  const from = vi.fn().mockReturnValue({
    upload: vi.fn().mockResolvedValue({ error: null }),
    getPublicUrl: vi.fn().mockReturnValue({ data: { publicUrl: 'https://fake.supabase.co/storage/v1/object/public/equestrianloop-assets/horses/1.jpg' } }),
    remove: vi.fn().mockResolvedValue({ error: null }),
  })
  return { storage: { from } } as unknown as SupabaseClient
}

describe('SupabaseStorageProvider', () => {
  it('uploads to the configured bucket at the given path', async () => {
    const client = fakeSupabaseClient()
    const provider = new SupabaseStorageProvider(client)

    await provider.upload({ path: 'horses/1.jpg', file: Buffer.from('fake-image'), contentType: 'image/jpeg' })

    expect(client.storage.from).toHaveBeenCalledWith('equestrianloop-assets')
  })

  it('returns a public URL for a given path', () => {
    const client = fakeSupabaseClient()
    const provider = new SupabaseStorageProvider(client)

    const url = provider.getUrl('horses/1.jpg')

    expect(url).toContain('horses/1.jpg')
  })
})
```

- [ ] **Step 4: Run test to verify it fails, then implement**

`src/server/storage/providers/SupabaseStorageProvider.ts`:
```typescript
import type { SupabaseClient } from '@supabase/supabase-js'
import type { StorageProvider } from '../StorageProvider'

const BUCKET = 'equestrianloop-assets'

export class SupabaseStorageProvider implements StorageProvider {
  constructor(private readonly client: SupabaseClient) {}

  async upload(input: { path: string; file: Buffer; contentType: string }): Promise<void> {
    const { error } = await this.client.storage
      .from(BUCKET)
      .upload(input.path, input.file, { contentType: input.contentType, upsert: true })
    if (error) throw new Error(`Storage upload failed: ${error.message}`)
  }

  getUrl(path: string): string {
    const { data } = this.client.storage.from(BUCKET).getPublicUrl(path)
    return data.publicUrl
  }

  async delete(path: string): Promise<void> {
    const { error } = await this.client.storage.from(BUCKET).remove([path])
    if (error) throw new Error(`Storage delete failed: ${error.message}`)
  }
}
```

Run: `npm run test -- supabase-storage-provider`
Expected: PASS.

- [ ] **Step 5: Add the factory**

`src/server/storage/StorageService.ts`:
```typescript
import { createClient } from '@supabase/supabase-js'
import { SupabaseStorageProvider } from './providers/SupabaseStorageProvider'
import type { StorageProvider } from './StorageProvider'

let cached: StorageProvider | null = null

export function getStorageService(): StorageProvider {
  if (!cached) {
    const client = createClient(process.env.SUPABASE_URL!, process.env.SUPABASE_SERVICE_ROLE_KEY!)
    cached = new SupabaseStorageProvider(client)
  }
  return cached
}
```

- [ ] **Step 6: Commit**

```bash
git add src/server/storage tests/server package.json package-lock.json
git commit -m "Add provider-agnostic storage: StorageProvider interface and Supabase implementation"
```

---

## Task 17: Design Tokens & Shared UI Components

**Files:**
- Modify: `src/app/globals.css`
- Create: `src/components/shared/page-header.tsx`
- Create: `src/components/shared/stat-card.tsx`
- Create: `src/components/shared/empty-state.tsx`
- Test: `tests/components/empty-state.test.tsx`

**Interfaces:**
- Produces: Tailwind theme tokens (`forest`, `saddle`, `cream` color scales, `font-display`); `<PageHeader title description actions? />`, `<StatCard label value trend? />`, `<EmptyState icon title description action? />` — the last one is how every not-yet-built feature in this plan is represented (never a fake, non-functional button).

- [ ] **Step 1: Install component-testing dependencies**

```bash
npm install -D @testing-library/react @testing-library/jest-dom jsdom
```

- [ ] **Step 2: Define the brand palette and display font**

`src/app/globals.css` (append to the existing Tailwind v4 import):
```css
@import "tailwindcss";

@theme {
  --color-forest-50: #f3f6f3;
  --color-forest-100: #dfe9e0;
  --color-forest-600: #33513f;
  --color-forest-700: #263c30;
  --color-forest-900: #14201a;
  --color-saddle-400: #a97a4a;
  --color-saddle-500: #8b5a2b;
  --color-saddle-600: #6f4620;
  --color-cream-50: #faf7f2;
  --color-cream-100: #f2ecdf;
  --font-display: "Fraunces", ui-serif, Georgia, serif;
}

body {
  background-color: var(--color-cream-50);
}
```

Add the display font in `src/app/layout.tsx` via `next/font/google`:
```tsx
import { Fraunces } from 'next/font/google'

const fraunces = Fraunces({ subsets: ['latin'], variable: '--font-display', display: 'swap' })
// add fraunces.variable to the <html> or <body> className alongside the existing sans font
```

- [ ] **Step 3: Write the failing EmptyState test**

`tests/components/empty-state.test.tsx`:
```tsx
// @vitest-environment jsdom
import { describe, it, expect } from 'vitest'
import { render, screen } from '@testing-library/react'
import { Ban } from 'lucide-react'
import { EmptyState } from '@/components/shared/empty-state'

describe('EmptyState', () => {
  it('renders the title, description, and an icon, with no interactive action when none is passed', () => {
    render(<EmptyState icon={Ban} title="No horses yet" description="Add your first horse to get started." />)
    expect(screen.getByText('No horses yet')).toBeInTheDocument()
    expect(screen.getByText('Add your first horse to get started.')).toBeInTheDocument()
    expect(screen.queryByRole('button')).not.toBeInTheDocument()
  })

  it('renders an action button when one is passed, for genuinely available actions only', () => {
    render(
      <EmptyState
        icon={Ban}
        title="No horses yet"
        description="Add your first horse to get started."
        action={{ label: 'Add horse', onClick: () => {} }}
      />
    )
    expect(screen.getByRole('button', { name: 'Add horse' })).toBeInTheDocument()
  })
})
```

- [ ] **Step 4: Run test to verify it fails**

Run: `npm run test -- empty-state`
Expected: FAIL — module not found.

- [ ] **Step 5: Add shadcn primitives these components need**

```bash
npx shadcn@latest add card table badge
```

- [ ] **Step 6: Implement the shared components**

`src/components/shared/empty-state.tsx`:
```tsx
import type { LucideIcon } from 'lucide-react'
import { Button } from '@/components/ui/button'

export function EmptyState({
  icon: Icon,
  title,
  description,
  action,
}: {
  icon: LucideIcon
  title: string
  description: string
  action?: { label: string; onClick: () => void }
}) {
  return (
    <div className="flex flex-col items-center justify-center gap-3 rounded-lg border border-dashed border-forest-100 bg-white px-6 py-16 text-center">
      <Icon className="h-8 w-8 text-forest-600" strokeWidth={1.5} />
      <h3 className="font-display text-lg text-forest-900">{title}</h3>
      <p className="max-w-sm text-sm text-forest-600">{description}</p>
      {action && (
        <Button className="mt-2" onClick={action.onClick}>
          {action.label}
        </Button>
      )}
    </div>
  )
}
```

`src/components/shared/page-header.tsx`:
```tsx
export function PageHeader({
  title,
  description,
  actions,
}: {
  title: string
  description?: string
  actions?: React.ReactNode
}) {
  return (
    <div className="flex items-start justify-between gap-4 border-b border-forest-100 pb-6">
      <div>
        <h1 className="font-display text-2xl text-forest-900">{title}</h1>
        {description && <p className="mt-1 text-sm text-forest-600">{description}</p>}
      </div>
      {actions && <div className="flex shrink-0 items-center gap-2">{actions}</div>}
    </div>
  )
}
```

`src/components/shared/stat-card.tsx`:
```tsx
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'

export function StatCard({ label, value, trend }: { label: string; value: string; trend?: string }) {
  return (
    <Card className="border-forest-100">
      <CardHeader className="pb-2">
        <CardTitle className="text-sm font-medium text-forest-600">{label}</CardTitle>
      </CardHeader>
      <CardContent>
        <p className="font-display text-3xl text-forest-900">{value}</p>
        {trend && <p className="mt-1 text-xs text-forest-500">{trend}</p>}
      </CardContent>
    </Card>
  )
}
```

- [ ] **Step 7: Run test to verify it passes**

Run: `npm run test -- empty-state`
Expected: PASS.

- [ ] **Step 8: Commit**

```bash
git add src/app/globals.css src/app/layout.tsx src/components/shared src/components/ui tests/components package.json package-lock.json
git commit -m "Add brand design tokens and shared PageHeader/StatCard/EmptyState components"
```

---

## Task 18: Landing Page

**Files:**
- Create: `src/app/(marketing)/page.tsx`
- Create: `src/config/site.ts`

**Interfaces:**
- Consumes: `PageHeader`-style typographic conventions from Task 17 (not the component itself — a landing page has its own hero layout).
- Produces: `SITE_CONFIG` (name, tagline, plans) consumed by this page and, later, the pricing/checkout flow in Phase 1.

- [ ] **Step 1: Define site/plan config**

`src/config/site.ts`:
```typescript
export const SITE_CONFIG = {
  name: 'EquestrianLoop',
  tagline: 'The operating system for modern equestrian businesses.',
  plans: [
    { id: 'price_basic', name: 'Basic', price: 79, description: 'For a single branch getting started.' },
    { id: 'price_growth', name: 'Growth', price: 199, description: 'For multi-branch clubs scaling up.' },
  ],
} as const
```

- [ ] **Step 2: Build the landing page**

`src/app/(marketing)/page.tsx`:
```tsx
import Link from 'next/link'
import { Button } from '@/components/ui/button'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { SITE_CONFIG } from '@/config/site'

export default function MarketingHomePage() {
  return (
    <main className="bg-cream-50">
      <section className="mx-auto flex max-w-4xl flex-col items-center gap-6 px-6 py-28 text-center">
        <h1 className="font-display text-5xl leading-tight text-forest-900">{SITE_CONFIG.tagline}</h1>
        <p className="max-w-xl text-lg text-forest-600">
          Customers, horses, bookings, loyalty, and billing — one premium platform built for equestrian clubs,
          farms, and riding schools.
        </p>
        <div className="flex gap-3">
          <Button asChild size="lg">
            <Link href="/staff/sign-in">Sign in</Link>
          </Button>
        </div>
        <p className="text-xs text-forest-500">Paid plans only — no free trial, cancel anytime.</p>
      </section>

      <section className="mx-auto max-w-4xl px-6 pb-28">
        <h2 className="mb-8 text-center font-display text-3xl text-forest-900">Plans</h2>
        <div className="grid gap-6 sm:grid-cols-2">
          {SITE_CONFIG.plans.map((plan) => (
            <Card key={plan.id} className="border-forest-100">
              <CardHeader>
                <CardTitle className="font-display text-xl text-forest-900">{plan.name}</CardTitle>
              </CardHeader>
              <CardContent>
                <p className="font-display text-3xl text-forest-900">
                  ${plan.price}
                  <span className="text-base font-sans text-forest-500">/mo</span>
                </p>
                <p className="mt-2 text-sm text-forest-600">{plan.description}</p>
              </CardContent>
            </Card>
          ))}
        </div>
      </section>
    </main>
  )
}
```

- [ ] **Step 3: Verify manually**

Run: `npm run dev`, visit `/`, confirm the styled landing page renders with both plans and no trial/free-plan language anywhere.

- [ ] **Step 4: Commit**

```bash
git add "src/app/(marketing)" src/config/site.ts
git commit -m "Add landing page and site/plan config"
```

---

## Task 19: Super Admin Shell

**Files:**
- Create: `src/app/admin/layout.tsx`
- Create: `src/app/admin/organizations/page.tsx`
- Create: `src/app/admin/subscriptions/page.tsx`
- Create: `src/app/admin/analytics/page.tsx`

**Interfaces:**
- Consumes: `getSessionUser` from Task 13, `prisma`, `PageHeader`/`EmptyState`/`StatCard` from Task 17.
- Produces: `/admin` route tree, gated to `type === 'SUPER_ADMIN'` only.

- [ ] **Step 1: Build the Super Admin layout with the access check**

`src/app/admin/layout.tsx`:
```tsx
import { redirect } from 'next/navigation'
import { getSessionUser } from '@/server/auth/guards'

export default async function AdminLayout({ children }: { children: React.ReactNode }) {
  const sessionUser = await getSessionUser()
  if (!sessionUser || sessionUser.type !== 'SUPER_ADMIN') {
    redirect('/staff/sign-in')
  }

  return (
    <div className="min-h-screen bg-cream-50">
      <header className="border-b border-forest-100 bg-white px-8 py-4">
        <p className="font-display text-lg text-forest-900">EquestrianLoop — Platform Admin</p>
      </header>
      <div className="mx-auto max-w-6xl px-8 py-10">{children}</div>
    </div>
  )
}
```

- [ ] **Step 2: Organizations page — real data, not a placeholder**

`src/app/admin/organizations/page.tsx`:
```tsx
import { Building2 } from 'lucide-react'
import { prisma } from '@/db/client'
import { PageHeader } from '@/components/shared/page-header'
import { EmptyState } from '@/components/shared/empty-state'
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table'
import { Badge } from '@/components/ui/badge'

export default async function AdminOrganizationsPage() {
  const organizations = await prisma.organization.findMany({
    include: { subscription: true },
    orderBy: { createdAt: 'desc' },
  })

  return (
    <div className="space-y-6">
      <PageHeader title="Organizations" description="Every club on the platform." />
      {organizations.length === 0 ? (
        <EmptyState icon={Building2} title="No organizations yet" description="Clubs will appear here once they sign up." />
      ) : (
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>Name</TableHead>
              <TableHead>Slug</TableHead>
              <TableHead>Status</TableHead>
              <TableHead>Subscription</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {organizations.map((org) => (
              <TableRow key={org.id}>
                <TableCell className="font-medium">{org.name}</TableCell>
                <TableCell className="text-forest-600">{org.slug}</TableCell>
                <TableCell>
                  <Badge variant={org.status === 'ACTIVE' ? 'default' : 'destructive'}>{org.status}</Badge>
                </TableCell>
                <TableCell>{org.subscription?.status ?? 'No subscription'}</TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      )}
    </div>
  )
}
```

- [ ] **Step 3: Subscriptions and Analytics pages — explicitly pending, not fake**

`src/app/admin/subscriptions/page.tsx`:
```tsx
import { CreditCard } from 'lucide-react'
import { PageHeader } from '@/components/shared/page-header'
import { EmptyState } from '@/components/shared/empty-state'

export default function AdminSubscriptionsPage() {
  return (
    <div className="space-y-6">
      <PageHeader title="Subscriptions" description="Platform-wide billing overview." />
      <EmptyState
        icon={CreditCard}
        title="Subscription reporting is coming in a later phase"
        description="Per-organization subscription status already lives on the Organizations page — this cross-org billing view ships alongside Phase 1's onboarding flow."
      />
    </div>
  )
}
```

`src/app/admin/analytics/page.tsx`:
```tsx
import { BarChart3 } from 'lucide-react'
import { PageHeader } from '@/components/shared/page-header'
import { EmptyState } from '@/components/shared/empty-state'

export default function AdminAnalyticsPage() {
  return (
    <div className="space-y-6">
      <PageHeader title="Analytics" description="Platform-wide usage and growth." />
      <EmptyState
        icon={BarChart3}
        title="Analytics is coming in a later phase"
        description="This dashboard ships once there is real usage data to report on, in Phase 7."
      />
    </div>
  )
}
```

- [ ] **Step 4: Verify manually**

Create a `SUPER_ADMIN` user directly via `npx prisma studio` (or a one-off script), sign in, and confirm `/admin/organizations` lists seeded orgs while `/admin/subscriptions` and `/admin/analytics` show the styled "coming later" state rather than empty pages or non-functional buttons.

- [ ] **Step 5: Commit**

```bash
git add src/app/admin
git commit -m "Add Super Admin shell: layout, Organizations (real data), Subscriptions/Analytics (marked pending)"
```

---

## Task 20: Staff Dashboard Shell

**Files:**
- Create: `src/app/[orgSlug]/(dashboard)/layout.tsx`
- Create: `src/app/[orgSlug]/(dashboard)/page.tsx`
- Create: `src/app/[orgSlug]/(dashboard)/customers/page.tsx`, `horses/page.tsx`, `trainers/page.tsx`, `staff/page.tsx`, `services/page.tsx`, `bookings/page.tsx`, `check-ins/page.tsx`, `loyalty/page.tsx`, `rewards/page.tsx`, `payments/page.tsx`, `notifications/page.tsx`, `reports/page.tsx`, `settings/page.tsx`

**Interfaces:**
- Consumes: `getSessionUser` (Task 13), `withTenantContext` (Task 9), `assertOrganizationActive`/`OrganizationInactiveError` (Task 15), `PageHeader`/`StatCard`/`EmptyState` (Task 17).
- Produces: `/[orgSlug]/(dashboard)` route tree — resolves `orgSlug` to an organization, verifies the session belongs to a staff member of that org, verifies the subscription is active, and renders a styled overview.

- [ ] **Step 1: Build the dashboard layout with tenant resolution, staff auth, and subscription gating**

`src/app/[orgSlug]/(dashboard)/layout.tsx`:
```tsx
import { notFound, redirect } from 'next/navigation'
import { prisma } from '@/db/client'
import { getSessionUser } from '@/server/auth/guards'
import { withTenantContext } from '@/server/tenant/context'
import { assertOrganizationActive, OrganizationInactiveError } from '@/server/billing/guards'
import {
  Users, Rabbit, GraduationCap, UserCog, ListChecks, CalendarDays, ScanLine, Award, Gift, CreditCard, Bell, BarChart3, Settings,
} from 'lucide-react'
import Link from 'next/link'

const NAV_ITEMS = [
  { href: 'customers', label: 'Customers', icon: Users },
  { href: 'horses', label: 'Horses', icon: Rabbit },
  { href: 'trainers', label: 'Trainers', icon: GraduationCap },
  { href: 'staff', label: 'Staff', icon: UserCog },
  { href: 'services', label: 'Services', icon: ListChecks },
  { href: 'bookings', label: 'Bookings', icon: CalendarDays },
  { href: 'check-ins', label: 'Check-ins', icon: ScanLine },
  { href: 'loyalty', label: 'Loyalty', icon: Award },
  { href: 'rewards', label: 'Rewards', icon: Gift },
  { href: 'payments', label: 'Payments', icon: CreditCard },
  { href: 'notifications', label: 'Notifications', icon: Bell },
  { href: 'reports', label: 'Reports', icon: BarChart3 },
  { href: 'settings', label: 'Settings', icon: Settings },
]

export default async function DashboardLayout({
  children,
  params,
}: {
  children: React.ReactNode
  params: Promise<{ orgSlug: string }>
}) {
  const { orgSlug } = await params
  const organization = await prisma.organization.findUnique({ where: { slug: orgSlug } })
  if (!organization) notFound()

  const sessionUser = await getSessionUser()
  if (!sessionUser || sessionUser.type !== 'STAFF') redirect('/staff/sign-in')

  const membership = await withTenantContext(organization.id, (tx) =>
    tx.membership.findUnique({
      where: { userId_organizationId: { userId: sessionUser.id, organizationId: organization.id } },
    })
  )
  if (!membership) redirect('/staff/sign-in')

  try {
    await assertOrganizationActive(organization.id)
  } catch (err) {
    if (err instanceof OrganizationInactiveError) redirect(`/${orgSlug}/billing-required`)
    throw err
  }

  return (
    <div className="flex min-h-screen bg-cream-50">
      <aside className="w-56 shrink-0 border-r border-forest-100 bg-white px-4 py-6">
        <p className="mb-6 px-2 font-display text-lg text-forest-900">{organization.name}</p>
        <nav className="space-y-1">
          {NAV_ITEMS.map(({ href, label, icon: Icon }) => (
            <Link
              key={href}
              href={`/${orgSlug}/${href}`}
              className="flex items-center gap-2 rounded-md px-2 py-1.5 text-sm text-forest-700 hover:bg-forest-50"
            >
              <Icon className="h-4 w-4" strokeWidth={1.5} />
              {label}
            </Link>
          ))}
        </nav>
      </aside>
      <main className="flex-1 px-8 py-8">{children}</main>
    </div>
  )
}
```

- [ ] **Step 2: Dashboard overview page — real counts, no fake data**

`src/app/[orgSlug]/(dashboard)/page.tsx`:
```tsx
import { prisma } from '@/db/client'
import { withTenantContext } from '@/server/tenant/context'
import { PageHeader } from '@/components/shared/page-header'
import { StatCard } from '@/components/shared/stat-card'

export default async function DashboardOverviewPage({ params }: { params: Promise<{ orgSlug: string }> }) {
  const { orgSlug } = await params
  const organization = await prisma.organization.findUniqueOrThrow({ where: { slug: orgSlug } })

  const { customerCount, horseCount, upcomingBookingCount } = await withTenantContext(organization.id, async (tx) => {
    const [customerCount, horseCount, upcomingBookingCount] = await Promise.all([
      tx.customer.count({ where: { organizationId: organization.id } }),
      tx.horse.count({ where: { organizationId: organization.id } }),
      tx.booking.count({
        where: { organizationId: organization.id, status: { in: ['PENDING', 'CONFIRMED'] } },
      }),
    ])
    return { customerCount, horseCount, upcomingBookingCount }
  })

  return (
    <div className="space-y-6">
      <PageHeader title="Overview" description={`Welcome back to ${organization.name}.`} />
      <div className="grid gap-4 sm:grid-cols-3">
        <StatCard label="Customers" value={String(customerCount)} />
        <StatCard label="Horses" value={String(horseCount)} />
        <StatCard label="Upcoming bookings" value={String(upcomingBookingCount)} />
      </div>
    </div>
  )
}
```

- [ ] **Step 3: Add a styled pending page for every domain the sidebar links to but this plan doesn't build yet**

Every `NAV_ITEMS` entry must resolve to a real page — a sidebar link that 404s is worse than one that honestly says "not built yet." Each of the 13 pages below follows the same template; only the imported icon, title, and description change. Create all 13 files:

Template (substitute `ICON`, `ROUTE`, `TITLE`, `DESCRIPTION` from the table below):

```tsx
import { ICON } from 'lucide-react'
import { PageHeader } from '@/components/shared/page-header'
import { EmptyState } from '@/components/shared/empty-state'

export default function ROUTE_NAMEPage() {
  return (
    <div className="space-y-6">
      <PageHeader title="TITLE" />
      <EmptyState icon={ICON} title="TITLE is coming in a later phase" description="DESCRIPTION" />
    </div>
  )
}
```

| File | ICON | TITLE | DESCRIPTION |
|---|---|---|---|
| `customers/page.tsx` | `Users` | Customers | Customer CRM ships in Phase 2. |
| `horses/page.tsx` | `Rabbit` | Horses | Horse profiles ship in Phase 2. |
| `trainers/page.tsx` | `GraduationCap` | Trainers | Trainer management ships in Phase 2. |
| `staff/page.tsx` | `UserCog` | Staff | Full staff management ships in Phase 2 (accounts can already be created via `createStaffAccount`). |
| `services/page.tsx` | `ListChecks` | Services | The service catalog ships in Phase 2. |
| `bookings/page.tsx` | `CalendarDays` | Bookings | The booking calendar ships in Phase 3. |
| `check-ins/page.tsx` | `ScanLine` | Check-ins | The QR check-in flow ships in Phase 3. |
| `loyalty/page.tsx` | `Award` | Loyalty | The loyalty engine and dashboard ship in Phase 5. |
| `rewards/page.tsx` | `Gift` | Rewards | Rewards management ships in Phase 5. |
| `payments/page.tsx` | `CreditCard` | Payments | Club-facing payment reporting ships in Phase 6. |
| `notifications/page.tsx` | `Bell` | Notifications | Notification delivery ships in Phase 6. |
| `reports/page.tsx` | `BarChart3` | Reports | Reports and analytics ship in Phase 7. |
| `settings/page.tsx` | `Settings` | Settings | Organization settings management ships in Phase 8. |

Each import name must match exactly (e.g. `import { Rabbit } from 'lucide-react'` for Horses) — these are real `lucide-react` exports, same icons already used in `NAV_ITEMS`.

- [ ] **Step 4: Verify manually**

Seed an organization with an ACTIVE subscription and a staff Membership (via the Task 3/6/11 helpers), sign in as that staff user, visit `/<slug>`, confirm real counts render on the overview, and click through every sidebar link to confirm each resolves to a styled page (either real data or an honest "coming later" state) with no 404s.

- [ ] **Step 5: Commit**

```bash
git add "src/app/[orgSlug]/(dashboard)"
git commit -m "Add staff dashboard shell with tenant/auth/subscription gating, real overview stats, and pending-state pages for every nav item"
```

---

## Task 21: Customer Portal Shell

**Files:**
- Create: `src/app/[orgSlug]/portal/layout.tsx`
- Create: `src/app/[orgSlug]/portal/page.tsx`
- Create: `src/app/[orgSlug]/portal/qr-code/page.tsx`
- Create: `src/app/[orgSlug]/portal/profile/page.tsx` (real — view/edit the customer's own data)
- Create: `src/app/[orgSlug]/portal/bookings/page.tsx`, `sessions/page.tsx`, `loyalty/page.tsx`, `rewards/page.tsx`, `membership/page.tsx`, `notifications/page.tsx` (styled pending states)
- Test: `tests/lib/qr.test.ts`
- Create: `src/lib/qr.ts`

**Interfaces:**
- Consumes: `requireCustomer` (Task 13), `withTenantContext` (Task 9), `PageHeader`/`EmptyState` (Task 17), `qrcode.react` (installed in Task 1).
- Produces: `/[orgSlug]/portal` route tree, gated to `type === 'CUSTOMER'` with an active `Customer` profile in that org; `buildQrPayload(qrToken: string): string`.

- [ ] **Step 1: Write the failing QR payload test**

`tests/lib/qr.test.ts`:
```typescript
import { describe, it, expect } from 'vitest'
import { buildQrPayload } from '@/lib/qr'

describe('buildQrPayload', () => {
  it('encodes the token, not the raw customer id, into the QR payload', () => {
    const payload = buildQrPayload('qr_abc123')
    expect(payload).toBe('equestrianloop:checkin:qr_abc123')
  })
})
```

- [ ] **Step 2: Run test to verify it fails, then implement**

`src/lib/qr.ts`:
```typescript
export function buildQrPayload(qrToken: string): string {
  return `equestrianloop:checkin:${qrToken}`
}
```

Run: `npm run test -- qr`
Expected: PASS.

- [ ] **Step 3: Build the portal layout with tenant/customer auth**

`src/app/[orgSlug]/portal/layout.tsx`:
```tsx
import { notFound, redirect } from 'next/navigation'
import Link from 'next/link'
import { User, CalendarDays, History, Award, Gift, IdCard, Bell, QrCode } from 'lucide-react'
import { prisma } from '@/db/client'
import { requireCustomer } from '@/server/auth/guards'

const NAV_ITEMS = [
  { href: 'profile', label: 'Profile', icon: User },
  { href: 'bookings', label: 'Bookings', icon: CalendarDays },
  { href: 'sessions', label: 'Past sessions', icon: History },
  { href: 'loyalty', label: 'Loyalty', icon: Award },
  { href: 'rewards', label: 'Rewards', icon: Gift },
  { href: 'membership', label: 'Membership', icon: IdCard },
  { href: 'notifications', label: 'Notifications', icon: Bell },
  { href: 'qr-code', label: 'My QR code', icon: QrCode },
]

export default async function PortalLayout({
  children,
  params,
}: {
  children: React.ReactNode
  params: Promise<{ orgSlug: string }>
}) {
  const { orgSlug } = await params
  const organization = await prisma.organization.findUnique({ where: { slug: orgSlug } })
  if (!organization) notFound()

  try {
    await requireCustomer(organization.id)
  } catch {
    redirect(`/${orgSlug}/customer/sign-in`)
  }

  return (
    <div className="min-h-screen bg-cream-50 pb-16">
      <header className="border-b border-forest-100 bg-white px-4 py-4">
        <p className="font-display text-lg text-forest-900">{organization.name}</p>
      </header>
      <main className="mx-auto max-w-md px-4 py-6">{children}</main>
      <nav className="fixed inset-x-0 bottom-0 flex justify-around border-t border-forest-100 bg-white py-2">
        {NAV_ITEMS.slice(0, 5).map(({ href, label, icon: Icon }) => (
          <Link key={href} href={`/${orgSlug}/portal/${href}`} className="flex flex-col items-center gap-0.5 px-2 text-forest-600">
            <Icon className="h-5 w-5" strokeWidth={1.5} />
            <span className="text-[10px]">{label}</span>
          </Link>
        ))}
      </nav>
    </div>
  )
}
```

- [ ] **Step 4: Portal home page**

`src/app/[orgSlug]/portal/page.tsx`:
```tsx
import { CalendarDays } from 'lucide-react'
import { EmptyState } from '@/components/shared/empty-state'

export default function PortalHomePage() {
  return (
    <div className="space-y-6">
      <h1 className="font-display text-2xl text-forest-900">Welcome back</h1>
      <EmptyState
        icon={CalendarDays}
        title="No upcoming bookings"
        description="Self-service booking arrives in Phase 4 — for now, contact the club directly to book a ride."
      />
    </div>
  )
}
```

- [ ] **Step 5: QR code page — real, functional, mobile-first**

`src/app/[orgSlug]/portal/qr-code/page.tsx`:
```tsx
import { notFound } from 'next/navigation'
import { prisma } from '@/db/client'
import { requireCustomer } from '@/server/auth/guards'
import { withTenantContext } from '@/server/tenant/context'
import { buildQrPayload } from '@/lib/qr'
import { QRCodeSVG } from 'qrcode.react'

export default async function PortalQrCodePage({ params }: { params: Promise<{ orgSlug: string }> }) {
  const { orgSlug } = await params
  const organization = await prisma.organization.findUnique({ where: { slug: orgSlug } })
  if (!organization) notFound()

  const { customerId } = await requireCustomer(organization.id)
  const customer = await withTenantContext(organization.id, (tx) => tx.customer.findUniqueOrThrow({ where: { id: customerId } }))

  return (
    <div className="flex flex-col items-center gap-4 py-8 text-center">
      <h1 className="font-display text-2xl text-forest-900">Your check-in code</h1>
      <p className="max-w-xs text-sm text-forest-600">Show this to front desk staff to check in for your session.</p>
      <div className="rounded-2xl border border-forest-100 bg-white p-6 shadow-sm">
        <QRCodeSVG value={buildQrPayload(customer.qrToken)} size={220} />
      </div>
    </div>
  )
}
```

- [ ] **Step 6: Write the failing profile-update test**

`tests/server/customer-profile.test.ts`:
```typescript
import { describe, it, expect, vi, afterAll } from 'vitest'
import { prisma } from '@/db/client'
import { withTenantContext } from '@/server/tenant/context'
import { updateCustomerProfile } from '@/server/actions/customer-profile'

vi.mock('@/server/auth/config', () => ({ auth: vi.fn() }))
import { auth } from '@/server/auth/config'

describe('updateCustomerProfile', () => {
  afterAll(async () => {
    await prisma.$disconnect()
  })

  it("updates only the requesting customer's own profile, derived from session + org, never from client input", async () => {
    const org = await prisma.organization.create({ data: { name: 'Profile Test', slug: `profile-${Date.now()}` } })
    const user = await prisma.user.create({
      data: { email: `profile-${Date.now()}@test.com`, passwordHash: 'x', type: 'CUSTOMER', name: 'Old Name' },
    })
    const customer = await withTenantContext(org.id, (tx) =>
      tx.customer.create({ data: { organizationId: org.id, userId: user.id, firstName: 'Old', lastName: 'Name' } })
    )
    vi.mocked(auth).mockResolvedValue({ user: { id: user.id } } as never)

    const updated = await updateCustomerProfile(org.id, { firstName: 'New', lastName: 'Name', phone: '555-0100' })
    expect(updated.id).toBe(customer.id)
    expect(updated.firstName).toBe('New')
  })
})
```

Run: `npm run test -- customer-profile`
Expected: FAIL — module not found.

- [ ] **Step 7: Implement the profile server action and page**

`src/server/actions/customer-profile.ts`:
```typescript
'use server'

import { z } from 'zod'
import { requireCustomer } from '@/server/auth/guards'
import { withTenantContext } from '@/server/tenant/context'

const updateProfileSchema = z.object({
  firstName: z.string().min(1),
  lastName: z.string().min(1),
  phone: z.string().optional(),
})

export async function updateCustomerProfile(organizationId: string, input: z.infer<typeof updateProfileSchema>) {
  const { customerId } = await requireCustomer(organizationId)
  const data = updateProfileSchema.parse(input)
  return withTenantContext(organizationId, (tx) => tx.customer.update({ where: { id: customerId }, data }))
}
```

Run: `npm run test -- customer-profile`
Expected: PASS.

`src/app/[orgSlug]/portal/profile/profile-form.tsx`:
```tsx
'use client'

import { useState } from 'react'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { updateCustomerProfile } from '@/server/actions/customer-profile'

export function ProfileForm({
  organizationId,
  initialValues,
}: {
  organizationId: string
  initialValues: { firstName: string; lastName: string; phone: string }
}) {
  const [values, setValues] = useState(initialValues)
  const [saved, setSaved] = useState(false)

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault()
    await updateCustomerProfile(organizationId, values)
    setSaved(true)
  }

  return (
    <form onSubmit={handleSubmit} className="space-y-4">
      <div className="space-y-1.5">
        <Label htmlFor="firstName">First name</Label>
        <Input id="firstName" value={values.firstName} onChange={(e) => setValues({ ...values, firstName: e.target.value })} required />
      </div>
      <div className="space-y-1.5">
        <Label htmlFor="lastName">Last name</Label>
        <Input id="lastName" value={values.lastName} onChange={(e) => setValues({ ...values, lastName: e.target.value })} required />
      </div>
      <div className="space-y-1.5">
        <Label htmlFor="phone">Phone</Label>
        <Input id="phone" value={values.phone} onChange={(e) => setValues({ ...values, phone: e.target.value })} />
      </div>
      <Button type="submit">Save</Button>
      {saved && <p className="text-sm text-forest-600">Saved.</p>}
    </form>
  )
}
```

`src/app/[orgSlug]/portal/profile/page.tsx`:
```tsx
import { notFound } from 'next/navigation'
import { prisma } from '@/db/client'
import { requireCustomer } from '@/server/auth/guards'
import { withTenantContext } from '@/server/tenant/context'
import { ProfileForm } from './profile-form'

export default async function PortalProfilePage({ params }: { params: Promise<{ orgSlug: string }> }) {
  const { orgSlug } = await params
  const organization = await prisma.organization.findUnique({ where: { slug: orgSlug } })
  if (!organization) notFound()

  const { customerId } = await requireCustomer(organization.id)
  const customer = await withTenantContext(organization.id, (tx) => tx.customer.findUniqueOrThrow({ where: { id: customerId } }))

  return (
    <div className="space-y-6">
      <h1 className="font-display text-2xl text-forest-900">Profile</h1>
      <ProfileForm
        organizationId={organization.id}
        initialValues={{ firstName: customer.firstName, lastName: customer.lastName, phone: customer.phone ?? '' }}
      />
    </div>
  )
}
```

- [ ] **Step 8: Add styled pending pages for the portal sections not yet built**

Same reasoning as the staff dashboard (Task 20, Step 3) — every bottom-nav item must resolve to a real page, never a 404. Use the same template:

```tsx
import { ICON } from 'lucide-react'
import { EmptyState } from '@/components/shared/empty-state'

export default function ROUTE_NAMEPage() {
  return (
    <div className="space-y-6">
      <h1 className="font-display text-2xl text-forest-900">TITLE</h1>
      <EmptyState icon={ICON} title="TITLE is coming in a later phase" description="DESCRIPTION" />
    </div>
  )
}
```

| File | ICON | TITLE | DESCRIPTION |
|---|---|---|---|
| `bookings/page.tsx` | `CalendarDays` | Bookings | Self-service booking ships in Phase 4 — contact the club directly for now. |
| `sessions/page.tsx` | `History` | Past sessions | Session history ships alongside the booking engine in Phase 3-4. |
| `loyalty/page.tsx` | `Award` | Loyalty | Your loyalty balance and history ship in Phase 5. |
| `rewards/page.tsx` | `Gift` | Rewards | Reward redemption ships in Phase 5. |
| `membership/page.tsx` | `IdCard` | Membership | Membership plans ship in Phase 8. |
| `notifications/page.tsx` | `Bell` | Notifications | Notifications ship in Phase 6. |

- [ ] **Step 9: Verify manually**

Seed a customer account (via Task 12's `createCustomerAccount`), sign in at `/<slug>/customer/sign-in`, confirm `/<slug>/portal/qr-code` renders a real scannable QR code encoding that customer's token, confirm the Profile form loads and saves real changes, and click every bottom-nav item to confirm none 404.

- [ ] **Step 10: Commit**

```bash
git add "src/app/[orgSlug]/portal" src/lib/qr.ts src/server/actions/customer-profile.ts tests/lib tests/server
git commit -m "Add customer portal shell: real QR code and profile screens, pending states for the rest"
```

---

## Task 22: Full Verification Pass

**Files:** none created — this task runs and fixes, across whatever files the checks flag.

**Interfaces:** none new.

- [ ] **Step 1: Run the full test suite**

Run: `npm run test`
Expected: every test file from Tasks 2–21 passes. Fix any failures before continuing — do not proceed with a red suite.

- [ ] **Step 2: Run lint**

Run: `npm run lint`
Expected: no errors. Fix any that appear (unused imports, missing dependency arrays, etc.) and re-run until clean.

- [ ] **Step 3: Run the TypeScript type check**

Run: `npx tsc --noEmit`
Expected: no type errors. Fix any and re-run until clean.

- [ ] **Step 4: Run the production build**

Run: `npm run build`
Expected: build succeeds. Pay particular attention to dynamic route params (`params` as a `Promise` in Next.js 15 route handlers/pages — already handled with `await params` throughout this plan) and any server/client component boundary errors.

- [ ] **Step 5: Verify the tenant-access boundary has no stragglers**

Run (Git Bash / any POSIX shell):
```bash
grep -rn "from '@/db/raw-client'" src/
```
Expected: **zero matches.** `rawPrisma` is legitimately imported by `src/db/client.ts` (Task 2) and `src/server/tenant/context.ts` (Task 9) only — both under `src/db` or `src/server/tenant`, not general application code. If this prints a match anywhere else under `src/app`, `src/server/actions`, `src/server/auth`, `src/server/billing`, or `src/server/storage`, that file bypassed the boundary and needs to be fixed to use `withTenantContext` instead before this task is done. (Test files under `tests/` and `prisma/seed.ts` are the documented, sanctioned exceptions — Task 2's docstring — and are not part of this check.)

- [ ] **Step 6: Commit any fixes**

```bash
git add -A
git commit -m "Fix lint/typecheck/build issues found in Phase 0 verification pass"
```

(Skip this step if step 1–4 required no changes.)

---

## Definition of Done for Phase 0

- [ ] All 22 tasks above complete, each with its own commit(s).
- [ ] `npm run test`, `npm run lint`, `npx tsc --noEmit`, and `npm run build` all pass cleanly.
- [ ] A staff user can sign up (via `createStaffAccount`), sign in, and reach `/<orgSlug>` only when that org's subscription is `ACTIVE`.
- [ ] A customer user can sign up (via `createCustomerAccount`), sign in, and see their real QR code at `/<orgSlug>/portal/qr-code`.
- [ ] A Super Admin can view real organizations at `/admin/organizations`; Subscriptions/Analytics show a styled "coming later" state, never a fake control.
- [ ] Every tenant-scoped table with an `organizationId` column has RLS enabled with a tenant-isolation policy, proven by Task 9's test.
- [ ] Direct access to any non-platform model via `prisma` (from `@/db/client`) throws `TenantScopedModelAccessError` — proven by Task 2's test — and Task 22 Step 5's grep confirms no application file reaches around this via `rawPrisma`.
- [ ] Every tenant-scoped read and write in Tasks 11-21 runs inside `withTenantContext`, alongside its explicit `where: { organizationId }` filter — both layers active on every call, not just available.
- [ ] `LoyaltyTransaction` and `CustomerMembership` both have their DB-level uniqueness guarantees in place and covered by a failing-then-passing test.
- [ ] No file outside `server/billing/providers/` imports the Stripe SDK; no file outside `server/storage/providers/` imports the Supabase SDK.

**Remaining operational item, not a code gap (see Task 9):** whether Postgres's RLS policies actually filter anything for the app's own queries still depends on the runtime DB connection using a restricted, non-owner role rather than the migration-owning role (Postgres exempts table owners from their own RLS policies by default). The application-code side of "RLS as a real second boundary" is done — every tenant-scoped call is forced through `withTenantContext`, with no bypass available short of deliberately reaching around the type system and the Proxy guard. Switching the runtime connection's role before handling real customer data is the one remaining step, and it requires no further code changes.

---
