-- =============================================================================
-- Task 9 security hardening, Parts A and B: role scoping and Data API exposure.
--
-- Everything in Task 9 up to this point wrote RLS *policies*. An adversarial
-- review then proved those policies enforced nothing for real traffic, for two
-- independent reasons that no policy can fix:
--
--   A. The runtime role behind DATABASE_URL was Supabase's `postgres`, which has
--      rolbypassrls = TRUE and owns every table in `public`. BYPASSRLS outranks
--      FORCE ROW LEVEL SECURITY — a hard Postgres invariant — so every
--      tenant_isolation policy was inert for the connection the app used.
--
--   B. `anon` and `authenticated` — the two roles Supabase's PostgREST Data API
--      maps incoming `apikey` requests onto — held SELECT/INSERT/UPDATE/DELETE/
--      TRUNCATE/REFERENCES/TRIGGER on all 29 `public` tables. Six of those have
--      no RLS at all (`User` including `passwordHash`, `Organization`,
--      `Subscription`, `AuditLog`, `_prisma_migrations`, plus `Permission`'s
--      write side), and the Data API is live on the project's REST endpoint,
--      reachable with only the `anon` key — a value a normal Supabase app
--      publishes to browsers by design.
--
-- This migration fixes the grant side of both.
-- =============================================================================

-- -----------------------------------------------------------------------------
-- PART A — privileges for `app_runtime`, the non-bypassing application role.
--
-- `CREATE ROLE app_runtime ... PASSWORD '...'` is deliberately NOT in this file:
-- the password is a secret and must never enter version control. The role is
-- provisioned out-of-band and its credentials live only in the (gitignored)
-- .env `DATABASE_URL`. The attributes it is provisioned with are, for the
-- record: LOGIN, NOSUPERUSER, NOBYPASSRLS, NOCREATEDB, NOCREATEROLE,
-- NOREPLICATION, INHERIT.
--
-- The grants are therefore wrapped in an existence check, so this migration
-- applies cleanly (as a documented no-op) on an environment where the role has
-- not been provisioned yet, instead of failing the whole migration run.
--
-- `postgres` remains the table owner and stays on DIRECT_URL for
-- `prisma migrate dev/deploy`: DDL and CREATE POLICY need owner privileges that
-- `app_runtime` is deliberately denied.
--
-- Note what is NOT granted: no TRUNCATE, no REFERENCES, no TRIGGER. The
-- application performs ordinary CRUD and nothing else. No sequence grants
-- either — `information_schema.sequences` for schema `public` was queried and is
-- empty, because every id in this schema is a Prisma-side `cuid()`, not a
-- Postgres sequence. Checked rather than assumed.
-- -----------------------------------------------------------------------------
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'app_runtime') THEN
    EXECUTE 'GRANT USAGE ON SCHEMA public TO app_runtime';
    EXECUTE 'GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO app_runtime';
    -- So that tables created by future migrations (still owned by `postgres`)
    -- do not silently leave the runtime role without access.
    EXECUTE 'ALTER DEFAULT PRIVILEGES FOR ROLE postgres IN SCHEMA public '
         || 'GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO app_runtime';

    -- Test-infrastructure membership, so that the owner connection the test
    -- suite runs on can `SET LOCAL ROLE app_runtime` and exercise the policies
    -- against the *real* runtime role. Until now those tests used the stock
    -- Supabase `authenticated` role as a stand-in, which Part B below correctly
    -- strips of all privileges — so the stand-in has to become the real thing.
    --
    -- This grants `postgres` nothing it did not already have: `postgres` is the
    -- table owner and holds BYPASSRLS, i.e. strictly more privilege than
    -- `app_runtime`. The dangerous direction would be the reverse
    -- (`GRANT postgres TO app_runtime`), which is emphatically not done here —
    -- `app_runtime` is a member of nothing.
    EXECUTE 'GRANT app_runtime TO postgres';
  ELSE
    RAISE NOTICE 'role "app_runtime" does not exist on this database; skipping its grants. '
                 'Provision it out-of-band (LOGIN NOSUPERUSER NOBYPASSRLS NOCREATEDB '
                 'NOCREATEROLE NOREPLICATION + a generated password), point DATABASE_URL '
                 'at it, and re-run these grants, or RLS will not enforce for app traffic.';
  END IF;
END
$$;

-- -----------------------------------------------------------------------------
-- PART B — remove the Supabase Data API's reach into `public`.
--
-- Safe because this project does not use Supabase's data-access pattern at all:
-- authentication is Auth.js (NextAuth) v5 with the Prisma adapter and database
-- sessions (spec §4), all database access goes through Prisma over a direct
-- Postgres connection, and there is no `@supabase/*` package in package.json.
-- `anon`/`authenticated` exist only to serve PostgREST, which this application
-- never calls. They therefore have no legitimate need for any privilege here.
--
-- Supabase Storage (spec §7's planned SupabaseStorageProvider) is unaffected:
-- it is a separate service whose tables live in the `storage` schema with their
-- own, independently-granted ACLs, and its server-side path uses `service_role`.
-- Neither is touched by a `public`-schema-only revoke.
-- -----------------------------------------------------------------------------
REVOKE ALL PRIVILEGES ON ALL TABLES IN SCHEMA public FROM anon, authenticated;
REVOKE ALL PRIVILEGES ON SCHEMA public FROM anon, authenticated;

-- Without this, the next migration's CREATE TABLE would silently re-grant the
-- full privilege set to both roles, because Supabase ships `postgres` with
-- default privileges that do exactly that.
ALTER DEFAULT PRIVILEGES FOR ROLE postgres IN SCHEMA public
  REVOKE ALL PRIVILEGES ON TABLES FROM anon, authenticated;
