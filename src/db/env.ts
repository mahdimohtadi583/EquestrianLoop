// The single environment-loading point for every database entry path:
// src/db/raw-client.ts (application runtime + tests), prisma.config.ts
// (migrations), and prisma/seed-connection.ts (the seed's owner override).
//
// WHY THIS FILE EXISTS (security hardening, Task 9 Part A)
// -------------------------------------------------------
// `DATABASE_URL` now points at `app_runtime`: a LOGIN role with
// rolsuper = false and, crucially, **rolbypassrls = false**, holding nothing
// but USAGE on schema `public` and SELECT/INSERT/UPDATE/DELETE on its tables.
// It does not own the tables (`postgres` still does). That is what finally
// makes the `tenant_isolation` RLS policies a real second security boundary
// for request-serving traffic: before this change the runtime role was
// `postgres`, which has BYPASSRLS and owns every table, so the policies —
// correct as they were — filtered nothing at all for the connection the
// application actually used.
//
// `DIRECT_URL` is unchanged and still `postgres`: DDL, CREATE POLICY and
// `prisma migrate dev/deploy` all need owner-level privileges that
// `app_runtime` deliberately does not have.
//
// THE TEST OVERRIDE
// -----------------
// Tasks 3-8's schema-verification tests and prisma/seed.ts are a
// previously-reviewed, sanctioned pattern: they import `rawPrisma` directly
// and issue contextless reads and writes, because they exercise schema and
// constraints from outside the request-handling layer that the
// rawPrisma/prisma split protects. Under `app_runtime` those contextless
// statements are — correctly — denied or filtered to zero rows by RLS. So
// when NODE_ENV is `test` (Vitest sets this automatically), `.env.test`
// overrides `DATABASE_URL` back to the owner role, exactly as it was before
// this change. Both `.env` and `.env.test` are gitignored by `.gitignore`'s
// `.env*` rule.
//
// PRECEDENCE, VERIFIED EMPIRICALLY RATHER THAN ASSUMED
// ----------------------------------------------------
// dotenv 17.4.2 was probed directly before this file was written, because the
// obvious spelling is wrong:
//
//   dotenv.config({ path: ['.env', '.env.test'] })                 => X=from_base
//   dotenv.config({ path: ['.env', '.env.test'], override: true }) => X=from_test
//
// i.e. with an array path dotenv is **first-wins** by default, so the naive
// multi-path form would silently ignore `.env.test` entirely. Two sequential
// calls are used here instead of `{ path: [...], override: true }` for a
// reason: `override: true` also stomps variables that were genuinely set in
// the real process environment. Loading `.env` without `override` preserves
// the standard precedence (real env > .env file) that production and CI rely
// on, and the second call applies `override` only to the test file, whose
// entire purpose is to win.
import dotenv from 'dotenv'
import path from 'node:path'

/** Repo root: this file is `<root>/src/db/env.ts`. */
const ROOT = path.resolve(__dirname, '..', '..')

let loaded = false

/**
 * Load `.env`, then — only under NODE_ENV=test — overlay `.env.test`.
 *
 * Idempotent: importing this module from several entry points (raw-client,
 * prisma.config, the seed) must not re-apply the files.
 */
export function loadEnv(): void {
  if (loaded) return
  loaded = true

  // Real process environment keeps precedence over .env (dotenv's default).
  dotenv.config({ path: path.join(ROOT, '.env'), quiet: true })

  if (process.env.NODE_ENV === 'test') {
    // `override: true` is what makes the later file win — see the note above.
    dotenv.config({ path: path.join(ROOT, '.env.test'), override: true, quiet: true })
  }
}

/**
 * Point `DATABASE_URL` at the owner connection for the duration of this
 * process.
 *
 * Used by prisma/seed-connection.ts only. The seed writes the global
 * `Permission` catalogue and system `Role`/`RolePermission` rows with no
 * tenant context — writes that `lock_down_permission_catalog_writes` and the
 * `tenant_isolation` policies correctly deny to `app_runtime`. Seeding is a
 * migration-time, owner-level operation in this architecture (the project
 * owner's rule: "migrations always run as `postgres` regardless of
 * environment"), and `DIRECT_URL` is precisely the owner connection string
 * that rule reserves, so no additional credential is introduced.
 *
 * Deliberately a no-op under NODE_ENV=test: there, `.env.test` has already
 * put `DATABASE_URL` on the owner role via the *pooled* endpoint, and
 * silently moving the whole test run onto the unpooled direct connection
 * would change connection-pool behaviour that tests/db/rls-security.test.ts
 * makes assertions about.
 *
 * MUST be called before `src/db/raw-client.ts` is first imported: that module
 * resolves its connection string at load time.
 */
export function useOwnerConnectionForSeed(): void {
  loadEnv()
  if (process.env.NODE_ENV === 'test') return
  if (process.env.DIRECT_URL) {
    process.env.DATABASE_URL = process.env.DIRECT_URL
  }
}

loadEnv()
