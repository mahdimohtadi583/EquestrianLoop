-- =============================================================================
-- Task 9 security hardening, Part D. Four narrow findings from the adversarial
-- review that cleared Parts A-C. None of them is a live exploit today; all four
-- are latent holes that a later migration, a dashboard action, or a compromised
-- runtime credential would turn into one.
--
--   1. Parts A/B fixed default privileges for future TABLES only. Future
--      SEQUENCES and FUNCTIONS in `public` were still default-granted to
--      `anon`/`authenticated`, and `app_runtime` was granted NOTHING on a future
--      sequence — so the first migration to add a serial/identity column would
--      simultaneously re-open the Data API and break the application. `anon` also
--      retained schema-level USAGE on `public` through a grant to the pseudo-role
--      PUBLIC, which Part B's `REVOKE ... ON SCHEMA public FROM anon` could not
--      touch.
--   2. Default privileges key off the CREATING role. A second `pg_default_acl`
--      entry owned by `supabase_admin` still grants `anon`/`authenticated`
--      everything on tables IT creates. (See the honest limitation below.)
--   3. Four plain scalars that reference tenant data without a foreign key —
--      `CheckIn.checkedInByStaffId` and `BlockedTime.branchId/trainerId/horseId` —
--      were classified out of scope by Part C. They are now given the same
--      EXISTS-conjunct treatment Part C applied to its 18 real foreign keys.
--   4. `app_runtime` held full CRUD on `_prisma_migrations` (the migration
--      ledger, which request-serving traffic must never touch) and on `AuditLog`
--      including UPDATE and DELETE (an audit trail that can be silently altered
--      or erased is not an audit trail).
--
-- Produced with `npx prisma migrate dev --name ... --create-only` and then
-- hand-written — the same two-step pattern every other security migration in
-- this project uses, since neither grants nor RLS policies are modelled in
-- schema.prisma. No Prisma model changes.
-- =============================================================================


-- =============================================================================
-- FINDING 1 — default privileges for future SEQUENCES and FUNCTIONS, and the
--             PUBLIC-role grant of USAGE on schema `public`.
--
-- MEASURED BEFORE THIS MIGRATION (rolled-back DDL on this deployment,
-- PostgreSQL 17.6, as `postgres` — the role Prisma migrations run as):
--
--   CREATE SEQUENCE public.probe_seq  -> relacl
--     {postgres=rwU/postgres,anon=rwU/postgres,authenticated=rwU/postgres,
--      service_role=rwU/postgres}
--   CREATE FUNCTION public.probe_fn   -> proacl
--     {=X/postgres,postgres=X/postgres,anon=X/postgres,authenticated=X/postgres,
--      service_role=X/postgres}
--   CREATE TABLE public.probe_tbl     -> already correct (Part B closed this):
--     no anon/authenticated entry, app_runtime=arwd
--
--   has_sequence_privilege('app_runtime', probe_seq, 'USAGE')  = false
--   has_sequence_privilege('app_runtime', probe_seq, 'SELECT') = false
--
-- So: sequences and functions were the two object classes Part B did not cover,
-- and the app-runtime grant for sequences was missing entirely.
--
-- There are currently ZERO sequences and ZERO functions in schema `public`
-- (`information_schema.sequences` and `pg_proc`/`pg_namespace` both queried and
-- empty — every id in this schema is a Prisma-side `cuid()`), so nothing here
-- repairs an existing object. This is purely about what the NEXT migration
-- creates. Checked rather than assumed, the same way Part A checked it.
-- =============================================================================

ALTER DEFAULT PRIVILEGES FOR ROLE postgres IN SCHEMA public
  REVOKE ALL PRIVILEGES ON SEQUENCES FROM anon, authenticated;

ALTER DEFAULT PRIVILEGES FOR ROLE postgres IN SCHEMA public
  REVOKE ALL PRIVILEGES ON FUNCTIONS FROM anon, authenticated;

-- -----------------------------------------------------------------------------
-- The PUBLIC-role grant of USAGE on schema `public`.
--
-- `pg_namespace.nspacl` for `public` was, before this statement:
--   {pg_database_owner=UC/pg_database_owner,
--    =U/pg_database_owner,                <-- the grant to the pseudo-role PUBLIC
--    postgres=U/pg_database_owner,
--    service_role=U/pg_database_owner,
--    app_runtime=U/pg_database_owner}
--
-- The entry with an empty grantee is the grant to PUBLIC, i.e. to every role in
-- the cluster. `REVOKE USAGE ON SCHEMA public FROM anon, authenticated` (Part B)
-- cannot remove it, because it was never granted to those roles individually —
-- which is why `has_schema_privilege('anon','public','USAGE')` was still TRUE
-- after Part B.
--
-- WHY THIS IS SAFE, MEASURED RATHER THAN ARGUED. Revoking a PUBLIC grant affects
-- every role that had no grant of its own, so the blast radius was enumerated
-- before writing this line, by running the revoke inside a transaction and
-- diffing `has_schema_privilege(rolname,'public','USAGE')` across all 16
-- non-system roles, then rolling back:
--
--   KEEPS USAGE (explicit grant of its own, or superuser):
--     postgres, app_runtime, service_role, supabase_admin, supabase_etl_admin,
--     supabase_read_only_user
--   LOSES USAGE:
--     anon, authenticated            <-- the intent
--     authenticator, dashboard_user, pgbouncer, supabase_auth_admin,
--     supabase_privileged_role, supabase_realtime_admin,
--     supabase_replication_admin, supabase_storage_admin
--
-- The second group is collateral, so each was checked for an actual dependency
-- on schema `public`:
--
--   * ONLY THREE ROLES HOLD ANY PRIVILEGE ON ANY `public` TABLE:
--     `information_schema.table_privileges` for table_schema='public' grouped by
--     grantee returns exactly postgres (203), service_role (203),
--     app_runtime (116) — and all three retain USAGE. Every role in the losing
--     group holds ZERO table privileges here, so USAGE on the schema granted it
--     the ability to name objects it could not read, write, or execute anyway.
--   * NO functions and NO sequences exist in `public`, so there is no EXECUTE or
--     nextval() path either.
--   * NO triggers exist on `auth.users` (the standard Supabase pattern where
--     `supabase_auth_admin` must reach a `public.handle_new_user()` function).
--     This project authenticates with Auth.js v5 + the Prisma adapter and does
--     not use Supabase Auth at all, so no such trigger can exist.
--   * The `supabase_realtime` publication covers NO `public` table
--     (`pg_publication_tables` for schemaname='public' is empty, puballtables =
--     false), so Realtime has nothing to lose.
--   * Supabase Storage (spec §7's planned SupabaseStorageProvider) lives in the
--     `storage` schema with its own ACLs and its server-side path uses
--     `service_role`, which keeps USAGE. `supabase_storage_admin` losing USAGE on
--     `public` does not touch the `storage` schema.
--   * `authenticator` is PostgREST's login role; it exists only to SET ROLE to
--     anon/authenticated, both of which are being closed deliberately.
--
-- If a future task adopts Supabase Realtime, Supabase Auth triggers, or any
-- other managed service that must reach `public`, the correct response is an
-- explicit `GRANT USAGE ON SCHEMA public TO <that role>` — narrow and visible —
-- not restoring the blanket PUBLIC grant.
-- -----------------------------------------------------------------------------
REVOKE USAGE ON SCHEMA public FROM PUBLIC;


-- =============================================================================
-- FINDING 2 — the second `pg_default_acl` entry, owned by `supabase_admin`.
--
-- HONEST LIMITATION, MEASURED. `ALTER DEFAULT PRIVILEGES FOR ROLE
-- supabase_admin ...` was attempted on this deployment as `postgres` (the role
-- every Prisma migration runs as, via DIRECT_URL) inside a transaction, and it
-- FAILED:
--
--     ERROR: permission denied to change default privileges
--
-- Postgres only lets a role alter default privileges for itself or for a role it
-- is a member of. `pg_auth_members` was queried: `postgres` is a member of anon,
-- app_runtime, authenticated, authenticator, pg_create_subscription, pg_monitor,
-- pg_read_all_data, pg_signal_backend, service_role and
-- supabase_privileged_role — and NOT of `supabase_admin`. On Supabase's managed
-- platform `postgres` is not a superuser either (`rolsuper = false`, verified),
-- so there is no route to this from inside a migration.
--
-- The statements are therefore deliberately NOT in this file. Writing them would
-- make every future `prisma migrate deploy` fail outright, and wrapping them in
-- an exception-swallowing DO block would be theatre — a statement that looks
-- like a control and silently is not.
--
-- WHAT THIS ACTUALLY LEAVES OPEN, stated precisely rather than minimised. The
-- `supabase_admin` default-ACL entry is:
--     tables:    {postgres=arwdDxtm,anon=arwdDxtm,authenticated=arwdDxtm,
--                 service_role=arwdDxtm}
--     sequences: {postgres=rwU,anon=rwU,authenticated=rwU,service_role=rwU}
--     functions: {postgres=X,anon=X,authenticated=X,service_role=X}
-- It applies ONLY to objects `supabase_admin` itself creates in `public`. No
-- project code path does that: Prisma migrations run as `postgres` (verified —
-- `current_user` on the DIRECT_URL connection is `postgres`), and that path is
-- now fully closed for tables, sequences and functions alike. The residual path
-- is a human creating a table through the Supabase dashboard's table editor or
-- another managed tool that runs as `supabase_admin`.
--
-- Note that even in that case, the Finding 1 revoke above is a partial backstop:
-- `anon`/`authenticated` no longer hold USAGE on schema `public`, and without
-- schema USAGE a table-level grant is unusable. It is defence in depth, not a
-- substitute — a later `GRANT USAGE ON SCHEMA public TO anon` (or a Supabase
-- platform change that re-grants it) would reactivate every such table grant.
--
-- This is therefore recorded as a RESIDUAL, DASHBOARD-LEVEL item alongside the
-- "disable the PostgREST Data API in project settings" item from Part B: both
-- require project-owner action in the Supabase dashboard and neither is
-- reachable from this repository's migration role. Documented in the Task 9
-- report, Part D.
-- =============================================================================

-- (no SQL — see the limitation above)


-- =============================================================================
-- FINDING 1, continued — `app_runtime` must be able to USE a future sequence.
--
-- Wrapped in the same `pg_roles` existence check Part A used: `app_runtime` is
-- provisioned out-of-band (its password is a secret and must never enter version
-- control), so this migration has to apply cleanly, as a documented no-op, on an
-- environment where the role does not exist yet.
--
-- USAGE and SELECT, not ALL: USAGE covers nextval()/setval-free normal use and
-- SELECT covers currval()/last_value reads. UPDATE on a sequence would let the
-- runtime role call setval() and rewind a generator — no application need, so it
-- is not granted, exactly as Part A withheld TRUNCATE/REFERENCES/TRIGGER.
--
-- FINDING 4 lives in the same block — it is the same role, gated by the same
-- existence check.
-- =============================================================================
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'app_runtime') THEN

    -- FINDING 1: future sequences created by `postgres` (i.e. by any future
    -- Prisma migration) must be usable by the runtime role.
    EXECUTE 'ALTER DEFAULT PRIVILEGES FOR ROLE postgres IN SCHEMA public '
         || 'GRANT USAGE, SELECT ON SEQUENCES TO app_runtime';

    -- -------------------------------------------------------------------------
    -- FINDING 4a: `_prisma_migrations` is the migration ledger. It is written by
    -- `prisma migrate deploy` running as `postgres` over DIRECT_URL, and read by
    -- nothing at request time. `app_runtime` held SELECT/INSERT/UPDATE/DELETE on
    -- it (measured), which means a compromised runtime credential could rewrite
    -- migration history — mark a migration as un-applied so the next deploy
    -- re-runs it, or delete the ledger so Prisma sees a virgin database. There is
    -- no legitimate runtime read either, so this is a full revoke rather than a
    -- narrowing.
    --
    -- This does NOT affect migrations: they run as `postgres`, the table's owner,
    -- on DIRECT_URL. Revoking a grant from a different role cannot change what
    -- the owner may do.
    -- -------------------------------------------------------------------------
    EXECUTE 'REVOKE ALL PRIVILEGES ON TABLE "_prisma_migrations" FROM app_runtime';

    -- -------------------------------------------------------------------------
    -- FINDING 4b: `AuditLog` is an audit trail. The platform must be able to
    -- write entries (INSERT) and read them back (SELECT) — both are kept. UPDATE
    -- and DELETE are revoked: an audit record that the audited party can silently
    -- alter or erase provides no evidence of anything, and no legitimate
    -- application flow edits or removes an audit entry. Retention/pruning, if it
    -- is ever needed, is an operator job for the owner role, not a runtime one.
    --
    -- Note the asymmetry with `_prisma_migrations`: that one is a full revoke
    -- because the runtime has no business reading it either.
    -- -------------------------------------------------------------------------
    EXECUTE 'REVOKE UPDATE, DELETE ON TABLE "AuditLog" FROM app_runtime';

  ELSE
    RAISE NOTICE 'role "app_runtime" does not exist on this database; skipping its '
                 'sequence default-privilege grant and its _prisma_migrations/AuditLog '
                 'revokes. Provision the role as described in '
                 '20260912093000_scope_runtime_role_and_revoke_data_api_grants and re-run.';
  END IF;
END
$$;


-- =============================================================================
-- FINDING 3 — four plain scalars that reference tenant data with no foreign key.
--
-- WHY THESE FOUR, AND WHY NOW
-- ---------------------------
-- Part C audited all 49 foreign-key CONSTRAINTS and fixed the 18 that could
-- cross a tenant boundary. It explicitly listed the constraint-less forward
-- references as out of scope, on the grounds that "an RLS predicate cannot be
-- attached to a reference the database does not model". That reasoning was half
-- right: Postgres will not enforce the reference, but an RLS predicate can still
-- validate the VALUE — look the id up in the referenced table and compare
-- tenants. The review identified four such columns where the referenced table is
-- unambiguous and single-typed, which is what makes the lookup well-defined:
--
--     CheckIn.checkedInByStaffId   NOT NULL   -> "Staff"
--     BlockedTime.branchId         NULLABLE   -> "Branch"
--     BlockedTime.trainerId        NULLABLE   -> "Trainer" (via "Staff")
--     BlockedTime.horseId          NULLABLE   -> "Horse"
--
-- The remaining constraint-less scalars stay out of scope, for reasons that are
-- about the reference itself and not about effort:
--     LoyaltyTransaction.sourceId      polymorphic — `sourceType` decides the
--                                      target table, so there is no single table
--                                      to look the value up in.
--     Booking.paymentId,               genuinely forward/optional references in a
--     Booking.customerMembershipId,    two-way pair (Payment.bookingId points
--     CustomerMembership.paymentId,    back), where a predicate on both sides
--     Payment.bookingId                would deadlock ordinary creation order.
--     Notification.recipientUserId     -> "User", which is NOT tenant data (no
--                                      organizationId), so there is no
--                                      cross-tenant question to ask.
--
-- THE USING / WITH CHECK SPLIT, REASONED PER TABLE
-- -----------------------------------------------
-- Both tables carry their own NOT NULL `organizationId` (verified in
-- schema.prisma and in `pg_attribute`), so neither can hold a platform-scoped
-- NULL-org row the way "Role"/"RolePermission" can. That is the fact that
-- decided the split for Part C's 11 tables, and it decides it identically here:
--
--   * USING stays EXACTLY `"organizationId" = current_setting(...)`. A row's
--     tenant is stated by its own NOT NULL column; whether its unenforced scalar
--     references are sane is an integrity question, not a visibility one. Folding
--     the conjuncts into USING would make any pre-existing malformed row — and
--     these columns were never validated, so malformed rows are exactly what an
--     operator may need to find — silently INVISIBLE to the tenant that owns it.
--     It would also govern the OLD row of an UPDATE and the row of a DELETE,
--     meaning a tenant could neither fix nor remove its own bad data.
--
--   * WITH CHECK becomes explicit and carries the conjuncts. Before this
--     migration "BlockedTime".with_check was NULL (measured via `pg_policies`),
--     i.e. Postgres was implicitly reusing USING — which is precisely how the
--     unvalidated columns got through. "CheckIn" already had an explicit WITH
--     CHECK from Part C, and its `bookingId` conjunct is RESTATED VERBATIM below,
--     because ALTER POLICY replaces the whole expression rather than appending to
--     it. The tenant-match conjunct is likewise restated in both — omitting it
--     while naming WITH CHECK explicitly would re-open plain cross-tenant INSERT,
--     a far worse hole than the one being closed. Same trap Part C called out on
--     "Membership".
--
--   * No RESTRICTIVE companion policy on either table, for the same reason Part C
--     added none: their USING is already strict, so there is no widened read path
--     to claw back on UPDATE/DELETE.
--
-- SHAPE OF EACH CONJUNCT
-- ----------------------
-- The parent's organizationId is compared to the CHILD ROW'S OWN organizationId,
-- not directly to `current_setting(...)` — Part C's convention, followed here for
-- consistency. It states an intra-row invariant ("this row's staff member is in
-- this row's organization") that holds regardless of who is asking, while the
-- separate `"organizationId" = current_setting(...)` conjunct in the same WITH
-- CHECK pins the row to the caller. Together they are strictly stronger than
-- either alone and they cannot disagree. Each subquery also runs as the querying
-- role and is therefore itself filtered by the parent table's own RLS policy,
-- which can only narrow the result — two independent reasons a foreign id is
-- rejected.
--
-- NULLABILITY, read off the schema per column
-- -------------------------------------------
-- `CheckIn.checkedInByStaffId` is NOT NULL, so it gets a bare EXISTS with no
-- IS NULL branch — writing one would be dead code inviting a reader to think the
-- column optional. All three `BlockedTime` columns are NULLABLE (`String?`), and
-- necessarily so: `BlockedTimeScope` is BRANCH | TRAINER | HORSE, so `scope`
-- selects WHICH ONE of the three is populated and the other two are NULL on every
-- legitimate row. A predicate without the NULL branches would reject 100% of real
-- BlockedTime writes. Each therefore gets `IS NULL OR EXISTS (...)`,
-- so leaving the relationship unset stays legal while a non-null value pointing
-- at another tenant is refused. Making any of them effectively mandatory would be
-- a schema change smuggled in through a policy. Asserted by the regression tests
-- in tests/db/scalar-tenant-matching.test.ts.
--
-- WHY NOTHING LEGITIMATE BREAKS
-- -----------------------------
-- Every row the application can create links rows of one organization, so all
-- conjuncts hold. prisma/seed.ts and Tasks 3-8's schema-verification tests run
-- through `rawPrisma` as `postgres` — BYPASSRLS and the table owner — with no
-- tenant context, so these predicates do not govern them at all.
-- =============================================================================


-- -----------------------------------------------------------------------------
-- 1. "CheckIn".checkedInByStaffId -> "Staff".id            NOT NULL, NO FK
--
-- The staff member who performed a check-in. Unvalidated, a tenant could record
-- one of its own check-ins as having been performed by ANOTHER organization's
-- staff member — an attribution forgery in exactly the table whose whole purpose
-- is to record who did what, and a cross-tenant identity leak the moment any
-- future task resolves the name behind that id (Task 10+'s check-in UI will).
--
-- The `bookingId` conjunct below is Part C's, restated verbatim and unchanged.
-- -----------------------------------------------------------------------------
ALTER POLICY tenant_isolation ON "CheckIn"
  USING ("organizationId" = current_setting('app.current_tenant_id', true))
  WITH CHECK (
    "organizationId" = current_setting('app.current_tenant_id', true)
    AND EXISTS (
      SELECT 1 FROM "Booking"
      WHERE "Booking"."id" = "CheckIn"."bookingId"
        AND "Booking"."organizationId" = "CheckIn"."organizationId"
    )
    AND EXISTS (
      SELECT 1 FROM "Staff"
      WHERE "Staff"."id" = "CheckIn"."checkedInByStaffId"
        AND "Staff"."organizationId" = "CheckIn"."organizationId"
    )
  );


-- -----------------------------------------------------------------------------
-- 2. "BlockedTime" — three nullable scalars, none of them backed by an FK.
--
--      branchId  -> "Branch".id                NULLABLE, NO FK
--      trainerId -> "Trainer".id via "Staff"   NULLABLE, NO FK
--      horseId   -> "Horse".id                 NULLABLE, NO FK
--
-- BlockedTime is the table that makes a resource unavailable for booking. A
-- cross-tenant row here is a denial-of-service primitive with the scheduling
-- engine as its delivery mechanism: tenant A blocks tenant B's branch, trainer
-- or horse, and every future availability query that honours BlockedTime
-- (Task 10+) removes capacity the victim owns, for reasons the victim cannot see
-- — the blocking row is invisible behind BlockedTime's own SELECT predicate.
-- Nothing reads BlockedTime today, which makes this latent rather than live, and
-- silent when it stops being latent.
--
-- This policy had NO explicit WITH CHECK before now (`pg_policies.with_check`
-- was NULL), so it is the only one of the two tables where naming WITH CHECK is
-- itself part of the fix rather than an amendment to an existing expression.
--
-- THE "Trainer" CASE, two-hop, mirroring RidingSession.trainerId from Part C:
-- "Trainer" carries no organizationId of its own — its tenant is defined by its
-- parent "Staff" row — so the conjunct joins Trainer to Staff and compares
-- Staff.organizationId to BlockedTime.organizationId. Relying on Trainer's own
-- EXISTS policy to filter the subquery would be a weaker guarantee resting on a
-- different table's predicate; this states the invariant directly.
--
-- All three NULL branches are load-bearing, not defensive padding: `scope` is
-- BRANCH | TRAINER | HORSE, so exactly one of the three columns is populated on
-- any legitimate row and the other two are NULL.
-- -----------------------------------------------------------------------------
ALTER POLICY tenant_isolation ON "BlockedTime"
  USING ("organizationId" = current_setting('app.current_tenant_id', true))
  WITH CHECK (
    "organizationId" = current_setting('app.current_tenant_id', true)
    AND (
      "branchId" IS NULL
      OR EXISTS (
        SELECT 1 FROM "Branch"
        WHERE "Branch"."id" = "BlockedTime"."branchId"
          AND "Branch"."organizationId" = "BlockedTime"."organizationId"
      )
    )
    AND (
      "trainerId" IS NULL
      OR EXISTS (
        SELECT 1 FROM "Trainer"
        JOIN "Staff" ON "Staff"."id" = "Trainer"."staffId"
        WHERE "Trainer"."id" = "BlockedTime"."trainerId"
          AND "Staff"."organizationId" = "BlockedTime"."organizationId"
      )
    )
    AND (
      "horseId" IS NULL
      OR EXISTS (
        SELECT 1 FROM "Horse"
        WHERE "Horse"."id" = "BlockedTime"."horseId"
          AND "Horse"."organizationId" = "BlockedTime"."organizationId"
      )
    )
  );
