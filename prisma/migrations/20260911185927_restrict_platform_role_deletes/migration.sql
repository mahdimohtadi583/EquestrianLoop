-- =============================================================================
-- Task 9, Fix Round 1 (part 2): close the DELETE half of the same escalation.
--
-- WHY A SECOND MIGRATION IS NEEDED AT ALL
-- ---------------------------------------
-- 20260911185229_harden_role_write_policies added an explicit, strict WITH CHECK
-- to "Role" and "RolePermission". That closes INSERT and UPDATE — Postgres
-- evaluates WITH CHECK against the *new* row — but it does NOT close DELETE:
-- DELETE has no new row, so it is governed by the USING expression alone, and
-- USING must stay permissive (it is what keeps a NULL-org platform system role
-- readable in every tenant context, without which RBAC reads an empty
-- permission set for SUPER_ADMIN and fails closed).
--
-- Measured on the live database after the first migration was applied, under
-- `SET LOCAL ROLE authenticated` with a valid tenant context:
--
--     DELETE FROM "RolePermission" WHERE "roleId" = '<platform system role>'  -> 1 row
--     DELETE FROM "Role"           WHERE "id"     = '<platform system role>'  -> 1 row
--
-- So a single valid tenant context could still strip the platform SUPER_ADMIN
-- role of its permissions, or delete the role outright (which cascades to its
-- RolePermission and Membership rows). That is the same privilege boundary the
-- first migration was written to defend, reachable through the one verb that
-- migration could not reach.
--
-- THE FIX
-- -------
-- A RESTRICTIVE policy, FOR DELETE only. Restrictive policies are ANDed with
-- the permissive ones rather than ORed, so this narrows DELETE — and ONLY
-- DELETE — without touching SELECT, INSERT or UPDATE behaviour in any way.
-- Reads are therefore provably unchanged: no SELECT-visible policy expression
-- is modified by this file.
--
-- The effect is a silent zero-row DELETE (the row is filtered out of the
-- delete's scan) rather than an error, which is the standard RLS shape for a
-- row that is out of scope for a write — the same shape a cross-tenant
-- `DELETE FROM "Customer"` already has.
--
-- A tenant deleting its OWN Role or RolePermission rows is unaffected: the
-- predicate is satisfied whenever the owning Role's organizationId equals the
-- active tenant. prisma/seed.ts and the schema tests run as `rawPrisma` /
-- `postgres` with no tenant context and are not governed by this either.
--
-- Named `tenant_delete_isolation`, deliberately NOT `tenant_isolation`: the
-- coverage tests enumerate policies by that name and count them, and keeping
-- the names distinct keeps "one permissive tenant_isolation policy per covered
-- table" true while making the extra restriction visible for what it is.
-- =============================================================================

CREATE POLICY tenant_delete_isolation ON "Role"
  AS RESTRICTIVE
  FOR DELETE
  USING ("organizationId" = current_setting('app.current_tenant_id', true));

CREATE POLICY tenant_delete_isolation ON "RolePermission"
  AS RESTRICTIVE
  FOR DELETE
  USING (EXISTS (
    SELECT 1 FROM "Role"
    WHERE "Role"."id" = "RolePermission"."roleId"
      AND "Role"."organizationId" = current_setting('app.current_tenant_id', true)
  ));
