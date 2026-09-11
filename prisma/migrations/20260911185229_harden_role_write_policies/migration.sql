-- =============================================================================
-- Task 9, Fix Round 1: split USING from WITH CHECK on "Role" and "RolePermission".
--
-- THE HOLE THIS CLOSES
-- --------------------
-- 20260911152445_enable_rls created both policies with a USING clause only.
-- Postgres then reuses the USING expression as the WITH CHECK expression, so
-- the *permissive read* predicate — which deliberately allows NULL-org platform
-- system roles to stay visible in every tenant context — was also governing
-- *writes*. That handed any single valid tenant context a privilege-escalation
-- path, verified live:
--
--   * INSERT/DELETE of "RolePermission" rows against the NULL-org platform
--     SUPER_ADMIN role (granting or stripping platform-wide permissions),
--   * UPDATE of that platform role's own name,
--   * UPDATE of the tenant's own "Role" SET "organizationId" = NULL, promoting a
--     tenant role to platform scope.
--
-- THE FIX
-- -------
-- USING stays exactly as it was — read behaviour is unchanged, and must be: a
-- NULL-org system role has to remain visible in every tenant context, otherwise
-- RBAC reads an empty permission set for SUPER_ADMIN and fails closed, which is
-- an authorization break with no isolation gain (the permission keys are a
-- public, hard-coded catalog in src/config/permissions.ts, not tenant data).
--
-- WITH CHECK becomes strict and is now stated explicitly: a tenant context may
-- only ever write rows whose owning "Role"."organizationId" equals its own
-- tenant id — never NULL, never another tenant's. "Visible" and "writable" are
-- deliberately no longer the same set for these two tables.
--
-- WHY THIS BREAKS NOTHING
-- -----------------------
-- Platform-role maintenance (prisma/seed.ts) runs as `rawPrisma`/`postgres`
-- with no tenant context at all, never inside withTenantContext, so it is not
-- governed by these predicates. tests/db/rbac-schema.test.ts likewise creates
-- roles and role-permissions through rawPrisma. Both were re-run against the
-- live database after this migration; see the Task 9 report, Fix Round 1.
--
-- ALTER POLICY, not CREATE: the policies already exist and the Prisma schema is
-- unchanged by this migration (RLS policies are not modelled in schema.prisma),
-- so this file was produced with `prisma migrate dev --create-only` and then
-- hand-written — the same two-step pattern Tasks 6/7/9 use.
-- =============================================================================

ALTER POLICY tenant_isolation ON "Role"
  USING ("organizationId" IS NULL OR "organizationId" = current_setting('app.current_tenant_id', true))
  WITH CHECK ("organizationId" = current_setting('app.current_tenant_id', true));

ALTER POLICY tenant_isolation ON "RolePermission"
  USING (EXISTS (
    SELECT 1 FROM "Role"
    WHERE "Role"."id" = "RolePermission"."roleId"
      AND ("Role"."organizationId" IS NULL
           OR "Role"."organizationId" = current_setting('app.current_tenant_id', true))
  ))
  WITH CHECK (EXISTS (
    SELECT 1 FROM "Role"
    WHERE "Role"."id" = "RolePermission"."roleId"
      AND "Role"."organizationId" = current_setting('app.current_tenant_id', true)
  ));
