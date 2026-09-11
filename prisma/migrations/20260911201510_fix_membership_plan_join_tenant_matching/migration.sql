-- =============================================================================
-- Task 9, Fix Round 2 (part 2): make the MembershipPlan join tables check BOTH
-- ends of the link, not just the plan.
--
-- THE GAP
-- -------
-- 20260911152445_enable_rls gave "MembershipPlanService" and
-- "MembershipPlanBranch" an EXISTS policy resolving the row's tenant through its
-- owning "MembershipPlan". That is correct as far as it goes, but each of these
-- tables has TWO foreign keys, and only one of them was ever checked. The
-- `serviceId` / `branchId` side was completely unconstrained, so a tenant could
-- link its OWN plan to ANOTHER tenant's Service or Branch. Measured live under
-- `SET LOCAL ROLE authenticated` with a valid tenant context:
--
--     INSERT INTO "MembershipPlanService" ("membershipPlanId","serviceId")
--     VALUES ('<caller''s own plan>', '<other tenant''s service>');   -> 1 row
--
--     INSERT INTO "MembershipPlanBranch" ("membershipPlanId","branchId")
--     VALUES ('<caller''s own plan>', '<other tenant''s branch>');    -> 1 row
--
-- This is not a read leak — the resulting row hangs off the caller's own plan,
-- so the existing SELECT predicate keeps it scoped to the caller, and the
-- foreign Service/Branch row itself stays invisible behind its own policy. It is
-- a cross-tenant referential-integrity coupling: one tenant's plan holding a
-- durable, dangling reference into another tenant's data, which no application
-- code has any way to produce legitimately and which would make a later
-- `DELETE FROM "Service"` in the victim tenant silently cascade into the
-- attacker's plan.
--
-- THE FIX
-- -------
-- Widen each policy's predicate so a row qualifies only when BOTH ends belong to
-- the active tenant. Expressed as a second EXISTS ANDed onto the first rather
-- than as a three-table join, so each half reads as the independent claim it is
-- and mirrors the existing shape line for line.
--
-- Stated as USING only, exactly as the original policy was: these policies carry
-- no explicit WITH CHECK, so Postgres reuses the USING expression for the write
-- check too. That is the intended semantics here and is not the round-1 trap —
-- round 1 had to split the two clauses on "Role"/"RolePermission" precisely
-- because that table's read predicate was deliberately WIDER than its correct
-- write predicate (NULL-org platform rows must stay readable). No such asymmetry
-- exists here: a link row belongs to the caller's tenant if and only if both of
-- its ends do, for reads and for writes alike.
--
-- The join columns were read off prisma/schema.prisma:
--   MembershipPlanService.serviceId -> Service.id, Service.organizationId
--   MembershipPlanBranch.branchId   -> Branch.id,  Branch.organizationId
-- Both parents are themselves tenant-scoped tables carrying a plain
-- `organizationId = current_setting(...)` policy, so the added subqueries — which
-- run as the querying role and are therefore subject to those policies — test
-- exactly the same predicate they are nested inside. They can only ever narrow
-- the result, never widen it.
--
-- Nothing legitimate is lost: every row the application creates links a plan and
-- a service/branch of the same organization, so both EXISTS clauses hold. Rows
-- created by `rawPrisma` / `postgres` (seed, schema tests) bypass RLS entirely
-- and are unaffected.
--
-- ALTER POLICY, not CREATE: the policies already exist. Produced with
-- `prisma migrate dev --create-only` and then hand-written, the same two-step
-- pattern every other RLS migration in this project uses.
-- =============================================================================

ALTER POLICY tenant_isolation ON "MembershipPlanService"
  USING (
    EXISTS (
      SELECT 1 FROM "MembershipPlan"
      WHERE "MembershipPlan"."id" = "MembershipPlanService"."membershipPlanId"
        AND "MembershipPlan"."organizationId" = current_setting('app.current_tenant_id', true)
    )
    AND EXISTS (
      SELECT 1 FROM "Service"
      WHERE "Service"."id" = "MembershipPlanService"."serviceId"
        AND "Service"."organizationId" = current_setting('app.current_tenant_id', true)
    )
  );

ALTER POLICY tenant_isolation ON "MembershipPlanBranch"
  USING (
    EXISTS (
      SELECT 1 FROM "MembershipPlan"
      WHERE "MembershipPlan"."id" = "MembershipPlanBranch"."membershipPlanId"
        AND "MembershipPlan"."organizationId" = current_setting('app.current_tenant_id', true)
    )
    AND EXISTS (
      SELECT 1 FROM "Branch"
      WHERE "Branch"."id" = "MembershipPlanBranch"."branchId"
        AND "Branch"."organizationId" = current_setting('app.current_tenant_id', true)
    )
  );
