// INTERNAL ONLY. Do not import this file from anywhere under src/app or
// src/server except src/server/tenant/context.ts (Task 9). Every other
// consumer of the database — pages, Server Actions, RBAC guards — must
// import `prisma` from '@/db/client' (platform models only) or use
// withTenantContext() from '@/server/tenant/context' (tenant-scoped models,
// RLS-enforced). Schema-verification tests and prisma/seed.ts are the only
// other sanctioned importers, since they sit outside the request-handling
// application layer this split protects.
// Loads .env, then overlays .env.test when NODE_ENV=test. Replaces the bare
// `import 'dotenv/config'` that used to sit here: DATABASE_URL now names the
// restricted, NOBYPASSRLS `app_runtime` role, and the test overlay is what
// keeps Tasks 3-8's sanctioned contextless-rawPrisma pattern working. See
// src/db/env.ts for the full reasoning and the dotenv-precedence evidence.
import './env'
import { PrismaClient } from '@prisma/client'
import { PrismaPg } from '@prisma/adapter-pg'
import { Pool } from 'pg'

const globalForPrisma = globalThis as unknown as { rawPrisma?: PrismaClient }

// DATABASE_URL is the pooled (transaction-mode) connection intended for
// request-serving application traffic, and as of the Task 9 Part A hardening
// it authenticates as `app_runtime` — NOSUPERUSER, **NOBYPASSRLS**, not the
// table owner — so every query issued through this client is genuinely
// subject to the tenant_isolation RLS policies. DIRECT_URL is the unpooled,
// session-mode connection meant only for `prisma migrate`/introspection
// (see prisma.config.ts, which uses DIRECT_URL for exactly that). Preferring
// DIRECT_URL here would route every runtime query through the low-limit
// direct-connection slot instead of the pooler, risking connection
// exhaustion under real concurrent load.
//
// Extracted as a pure function so this precedence can be unit-tested
// directly (tests/db/raw-client.test.ts) without needing a live DB
// connection or relying on module-load side effects.
export function resolveConnectionString(env: Record<string, string | undefined>): string {
  const connectionString = env.DATABASE_URL || env.DIRECT_URL
  if (!connectionString) {
    throw new Error(
      `DATABASE_URL or DIRECT_URL environment variable is not set. Available env vars: ${Object.keys(env)
        .filter((k) => k.includes('DATABASE') || k.includes('DIRECT') || k.includes('PRISMA'))
        .join(', ')}`
    )
  }
  return connectionString
}

const connectionString = resolveConnectionString(process.env)

export const rawPrisma =
  globalForPrisma.rawPrisma ??
  new PrismaClient({
    adapter: new PrismaPg(
      new Pool({
        connectionString,
        // `pg`'s default connectionTimeoutMillis is 0, which means "wait
        // forever". With a bounded pool that turns a starved pool — or a
        // pooler/network stall — into a request that hangs indefinitely with no
        // error, no log line and no way for a caller's own timeout to attribute
        // the fault. Bounding it converts that into a prompt, explicit
        // "timeout exceeded when trying to connect".
        //
        // 10s, reasoned rather than picked: this is a *remote* Supabase
        // transaction-mode pooler, so the budget has to cover a genuine cold
        // acquire — TCP + TLS handshake + pooler-side backend assignment over
        // WAN latency, which is comfortably under 2s here but can spike on a
        // cold Supabase instance. Anything in the 1-3s range would turn normal
        // cold starts into spurious failures. It also has to stay well under
        // the time a human or an upstream request handler will wait, and under
        // Prisma's own `maxWait` queueing budget, so the pool is the layer that
        // reports the problem. 10s sits between those two bounds and matches
        // the conventional default for a remote Postgres pool.
        connectionTimeoutMillis: 10_000,
      })
    ),
  })

if (process.env.NODE_ENV !== 'production') {
  globalForPrisma.rawPrisma = rawPrisma
}
