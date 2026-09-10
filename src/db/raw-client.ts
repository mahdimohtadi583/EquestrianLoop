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

const connectionString = process.env.DIRECT_URL || process.env.DATABASE_URL
if (!connectionString) {
  throw new Error(
    `DATABASE_URL or DIRECT_URL environment variable is not set. Available env vars: ${Object.keys(process.env)
      .filter((k) => k.includes('DATABASE') || k.includes('DIRECT') || k.includes('PRISMA'))
      .join(', ')}`
  )
}

export const rawPrisma =
  globalForPrisma.rawPrisma ??
  new PrismaClient({
    adapter: new PrismaPg({
      pool: new Pool({
        connectionString,
      }),
    }),
  })

if (process.env.NODE_ENV !== 'production') {
  globalForPrisma.rawPrisma = rawPrisma
}
