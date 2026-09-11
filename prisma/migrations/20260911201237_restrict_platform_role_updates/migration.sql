-- =============================================================================
-- Task 9, Fix Round 2 (part 1): close the UPDATE OLD-row half of the platform
-- role escalation.
--
-- WHAT ROUND 1 CLOSED, AND WHAT IT LEFT OPEN
-- ------------------------------------------
-- 20260911185229_harden_role_write_policies gave "Role" and "RolePermission" an
-- explicit, strict WITH CHECK. Postgres applies WITH CHECK to the row an
-- INSERT or an UPDATE *produces*, so that closed INSERT outright, and closed the
-- half of UPDATE that tries to leave a forbidden row behind.
--
-- 20260911185927_restrict_platform_role_deletes then added a RESTRICTIVE,
-- FOR DELETE-only policy, because DELETE produces no new row and is therefore
-- governed by USING alone — and USING has to stay permissive, since it is what
-- keeps a NULL-org platform system role readable in every tenant context.
--
-- Neither migration touched the OTHER clause UPDATE consults: an UPDATE's USING
-- expression, which decides whether the *old*, pre-update row is even eligible
-- to be touched. On "Role" and "RolePermission" that was still the permissive
-- read predicate (`organizationId IS NULL OR organizationId = current_setting(...)`),
-- so a NULL-org platform row remained an eligible UPDATE target. An independent
-- re-review measured this on the live database, under `SET LOCAL ROLE
-- authenticated` with a valid tenant context, after BOTH round-1 migrations were
-- applied:
--
--     -- old row: NULL-org platform role, passes the permissive USING
--     -- new row: owned by the caller's tenant, passes the strict WITH CHECK
--     UPDATE "Role" SET "organizationId" = '<caller''s own org>'
--      WHERE "organizationId" IS NULL;                              -> 1 row
--
--     UPDATE "RolePermission" SET "roleId" = '<caller''s own role>'
--      WHERE "roleId" = '<platform role id>';                       -> 1 row
--
-- Both statements satisfy every predicate round 1 installed, because both ends
-- of the update are individually legal: the old row is *visible*, the new row is
-- *owned*. The result is the exact escalation round 1 set out to stop — the
-- platform role is adopted into the tenant (who may then freely rename or delete
-- it), and a platform permission grant is re-parented onto a tenant role,
-- stripping it from the platform role and granting it to the tenant.
--
-- THE FIX
-- -------
-- The DELETE shape from round 1, applied to UPDATE: a RESTRICTIVE, FOR UPDATE
-- policy whose USING is the STRICT predicate — the caller's own tenant, never
-- NULL, never another tenant's. Restrictive policies are ANDed with the
-- permissive ones rather than ORed, so this narrows which EXISTING rows are
-- eligible for UPDATE and does nothing else:
--
--   * SELECT is untouched — no SELECT-applicable expression is modified here, so
--     the NULL-org platform role stays visible in every tenant context and RBAC
--     does not fail closed.
--   * INSERT is untouched — a FOR UPDATE policy is never consulted for INSERT.
--   * DELETE is untouched — it has its own tenant_delete_isolation policy.
--   * The NEW row of an UPDATE is still governed by the permissive
--     tenant_isolation policy's strict WITH CHECK from round 1, unchanged. Both
--     halves now fire independently: old-row rejection here, new-row rejection
--     there.
--
-- Verified on this deployment (PostgreSQL 17.6) rather than assumed: `AS
-- RESTRICTIVE FOR UPDATE ... USING (...)` is accepted, and pg_policies reports
-- it as permissive='RESTRICTIVE', cmd='UPDATE', with_check=NULL — i.e. Postgres
-- does NOT mirror this USING into a restrictive WITH CHECK, which is precisely
-- what keeps the new-row check exactly as round 1 left it.
--
-- The effect for an out-of-scope old row is a silent zero-row UPDATE (the row is
-- filtered out of the update's scan) rather than an error — the standard RLS
-- shape for a row that is out of scope for a write, and the same shape a
-- cross-tenant `UPDATE "Customer"` already has.
--
-- A tenant updating its OWN Role/RolePermission rows is unaffected: the
-- predicate is satisfied whenever the owning Role's organizationId equals the
-- active tenant. prisma/seed.ts and the schema tests run as `rawPrisma` /
-- `postgres` with no tenant context and are not governed by this either.
--
-- Named `tenant_update_isolation`, deliberately NOT `tenant_isolation`, for the
-- same reason round 1 chose `tenant_delete_isolation`: the coverage tests
-- enumerate policies by that name and count them, and keeping the names distinct
-- keeps "one permissive tenant_isolation policy per covered table" true while
-- making the extra restriction visible for what it is.
--
-- Produced with `prisma migrate dev --create-only` and then hand-written — the
-- same two-step pattern Tasks 6/7/9 and both round-1 migrations use, since RLS
-- policies are not modelled in schema.prisma.
-- =============================================================================

CREATE POLICY tenant_update_isolation ON "Role"
  AS RESTRICTIVE
  FOR UPDATE
  USING ("organizationId" = current_setting('app.current_tenant_id', true));

CREATE POLICY tenant_update_isolation ON "RolePermission"
  AS RESTRICTIVE
  FOR UPDATE
  USING (EXISTS (
    SELECT 1 FROM "Role"
    WHERE "Role"."id" = "RolePermission"."roleId"
      AND "Role"."organizationId" = current_setting('app.current_tenant_id', true)
  ));
