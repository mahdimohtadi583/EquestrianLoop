// INTERNAL ONLY. Do not import this file from anywhere under src/app or
// src/server except src/server/tenant/context.ts (Task 9). Every other
// consumer of the database — pages, Server Actions, RBAC guards — must
// import `prisma` from '@/db/client' (platform models only) or use
// withTenantContext() from '@/server/tenant/context' (tenant-scoped models,
// RLS-enforced). Schema-verification tests and prisma/seed.ts are the only
// other sanctioned importers, since they sit outside the request-handling
// application layer this split protects.
import 'dotenv/config'
import { PrismaClient } from '@prisma/client'
import { PrismaPg } from '@prisma/adapter-pg'
import { Pool } from 'pg'

const globalForPrisma = globalThis as unknown as { rawPrisma?: PrismaClient }

// DATABASE_URL is the pooled (transaction-mode) connection intended for
// request-serving application traffic; DIRECT_URL is the unpooled,
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
    adapter: new PrismaPg(new Pool({ connectionString })),
  })

if (process.env.NODE_ENV !== 'production') {
  globalForPrisma.rawPrisma = rawPrisma
}
