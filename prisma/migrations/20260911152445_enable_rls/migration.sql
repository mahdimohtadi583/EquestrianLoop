-- =============================================================================
-- Task 9: Postgres Row-Level Security — the second, independent tenant-isolation
-- boundary, backstopping the application-level boundary in src/db/client.ts.
--
-- MODEL
-- -----
-- Every tenant-scoped table gets RLS enabled plus one permissive policy named
-- `tenant_isolation`. The policy is created with neither FOR nor TO, so it is
-- `FOR ALL TO PUBLIC` — it applies to SELECT/INSERT/UPDATE/DELETE for every
-- role. Because no WITH CHECK clause is given, Postgres reuses the USING
-- expression as the WITH CHECK expression, so the same predicate that decides
-- which rows are *visible* also decides which rows may be *written*. That is
-- what stops `INSERT ... (organizationId) VALUES ('<other tenant>')` and
-- `UPDATE ... SET "organizationId" = '<other tenant>'` from inside a valid
-- tenant context.
--
-- The predicate keys on the transaction-local GUC `app.current_tenant_id`, set
-- by `withTenantContext()` (src/server/tenant/context.ts) via `SET LOCAL`.
-- `current_setting('app.current_tenant_id', true)` — note the `true`, meaning
-- "missing_ok" — returns NULL when the GUC was never set, and `col = NULL` is
-- NULL, which is not TRUE, so a query issued with *no* tenant context sees zero
-- rows. The layer fails closed.
--
-- FORCE ROW LEVEL SECURITY
-- ------------------------
-- Postgres exempts a table's owner from that table's own policies unless the
-- table is marked FORCE. Every table below is therefore marked FORCE as well as
-- ENABLE, unconditionally: it is a no-op when the runtime role is not the owner
-- and a real fix when it is an owner that does not also hold BYPASSRLS.
--
-- It is NOT sufficient on this deployment, and that is a hard Postgres
-- invariant rather than a configuration bug: the role behind DATABASE_URL here
-- is Supabase's `postgres`, which has rolbypassrls = true (measured, see the
-- task report). BYPASSRLS outranks FORCE. Closing that gap requires pointing
-- the runtime connection at a role without BYPASSRLS — an infrastructure and
-- credentials decision, deliberately not taken inside this migration.
-- tests/db/rls-security.test.ts proves the policies below genuinely enforce, by
-- running the same queries under `SET LOCAL ROLE authenticated` (a role that is
-- neither the table owner nor a BYPASSRLS holder).
--
-- JOIN / EXTENSION TABLES
-- -----------------------
-- Trainer, RolePermission, MembershipPlanService and MembershipPlanBranch carry
-- no `organizationId` column of their own. They are NOT left unprotected:
-- each gets a policy whose predicate is an EXISTS subquery against its owning
-- parent row. A direct, unjoined `SELECT * FROM "Trainer"` therefore still
-- resolves per-row against `Staff.organizationId`.
--
-- (Those EXISTS subqueries are themselves subject to the parent table's own
-- RLS policy, since policy expressions run as the querying role. That is
-- harmless and self-consistent here — the parent's policy tests exactly the
-- same predicate — and it can only ever narrow the result, never widen it.)
--
-- DELIBERATELY NOT COVERED
-- ------------------------
-- `Subscription` and `AuditLog` also have an `organizationId` column, but they
-- are platform-scoped by design: src/db/client.ts exposes them on the platform
-- client precisely so platform-level code can read them *without* a tenant
-- context (billing administration, cross-tenant audit review), and AuditLog's
-- organizationId is nullable for platform-level events. Enabling a tenant
-- policy on them would make every platform read return zero rows the moment the
-- runtime role stops bypassing RLS. Their exemption is asserted explicitly, by
-- name, in tests/db/rls-security.test.ts, so it stays a decision rather than an
-- oversight; any *new* model with an organizationId will fail that test until it
-- is either given a policy or consciously added to the exemption list.
-- =============================================================================

-- -----------------------------------------------------------------------------
-- 1. Tenant-scoped tables with a NOT NULL "organizationId" column (18 tables).
-- -----------------------------------------------------------------------------

ALTER TABLE "Branch" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "Branch" FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON "Branch"
  USING ("organizationId" = current_setting('app.current_tenant_id', true));

ALTER TABLE "Membership" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "Membership" FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON "Membership"
  USING ("organizationId" = current_setting('app.current_tenant_id', true));

ALTER TABLE "Customer" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "Customer" FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON "Customer"
  USING ("organizationId" = current_setting('app.current_tenant_id', true));

ALTER TABLE "Staff" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "Staff" FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON "Staff"
  USING ("organizationId" = current_setting('app.current_tenant_id', true));

ALTER TABLE "Horse" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "Horse" FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON "Horse"
  USING ("organizationId" = current_setting('app.current_tenant_id', true));

ALTER TABLE "Service" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "Service" FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON "Service"
  USING ("organizationId" = current_setting('app.current_tenant_id', true));

ALTER TABLE "BlockedTime" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "BlockedTime" FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON "BlockedTime"
  USING ("organizationId" = current_setting('app.current_tenant_id', true));

ALTER TABLE "RidingSession" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "RidingSession" FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON "RidingSession"
  USING ("organizationId" = current_setting('app.current_tenant_id', true));

ALTER TABLE "Booking" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "Booking" FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON "Booking"
  USING ("organizationId" = current_setting('app.current_tenant_id', true));

ALTER TABLE "CheckIn" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "CheckIn" FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON "CheckIn"
  USING ("organizationId" = current_setting('app.current_tenant_id', true));

ALTER TABLE "MembershipPlan" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "MembershipPlan" FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON "MembershipPlan"
  USING ("organizationId" = current_setting('app.current_tenant_id', true));

ALTER TABLE "CustomerMembership" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "CustomerMembership" FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON "CustomerMembership"
  USING ("organizationId" = current_setting('app.current_tenant_id', true));

ALTER TABLE "LoyaltyAccount" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "LoyaltyAccount" FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON "LoyaltyAccount"
  USING ("organizationId" = current_setting('app.current_tenant_id', true));

ALTER TABLE "LoyaltyTransaction" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "LoyaltyTransaction" FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON "LoyaltyTransaction"
  USING ("organizationId" = current_setting('app.current_tenant_id', true));

ALTER TABLE "Reward" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "Reward" FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON "Reward"
  USING ("organizationId" = current_setting('app.current_tenant_id', true));

ALTER TABLE "RewardRedemption" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "RewardRedemption" FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON "RewardRedemption"
  USING ("organizationId" = current_setting('app.current_tenant_id', true));

ALTER TABLE "Payment" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "Payment" FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON "Payment"
  USING ("organizationId" = current_setting('app.current_tenant_id', true));

ALTER TABLE "Notification" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "Notification" FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON "Notification"
  USING ("organizationId" = current_setting('app.current_tenant_id', true));

-- -----------------------------------------------------------------------------
-- 2. Role — tenant-scoped, but "organizationId" is NULLABLE.
--
-- A NULL organizationId marks a platform-level system role (the SUPER_ADMIN
-- role seeded once for the whole installation, see prisma/seed.ts). Those rows
-- are a global catalog, not one tenant's data, so they stay visible in every
-- tenant context.
--
-- Note the consequence for writes: because WITH CHECK falls back to USING, this
-- also permits a tenant-context transaction to create or update a Role with a
-- NULL organizationId. That is accepted deliberately — it is the same trust
-- boundary the seed already relies on, and narrowing it would need a separate
-- WITH CHECK clause that forbade NULL, which would in turn break seeding and
-- any future platform-role maintenance run through a tenant transaction.
-- -----------------------------------------------------------------------------

ALTER TABLE "Role" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "Role" FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON "Role"
  USING ("organizationId" IS NULL OR "organizationId" = current_setting('app.current_tenant_id', true));

-- -----------------------------------------------------------------------------
-- 3. Join / extension tables with no "organizationId" column of their own.
--
-- Each row's tenant is defined by the row it hangs off. The policy resolves
-- that relationship inside Postgres with an EXISTS subquery, so the isolation
-- holds even for a query that performs no join itself:
--
--     SELECT * FROM "Trainer";            -- still filtered, per row
--
-- Join columns below were read off prisma/schema.prisma directly:
--   Trainer.staffId                -> Staff.id                 (1:1, @unique)
--   RolePermission.roleId          -> Role.id                  (composite PK)
--   MembershipPlanService.membershipPlanId -> MembershipPlan.id (composite PK)
--   MembershipPlanBranch.membershipPlanId  -> MembershipPlan.id (composite PK)
-- -----------------------------------------------------------------------------

ALTER TABLE "Trainer" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "Trainer" FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON "Trainer"
  USING (EXISTS (
    SELECT 1 FROM "Staff"
    WHERE "Staff"."id" = "Trainer"."staffId"
      AND "Staff"."organizationId" = current_setting('app.current_tenant_id', true)
  ));

-- RolePermission deliberately mirrors Role's own `IS NULL OR = ...` predicate
-- rather than copying Trainer's stricter shape.
--
-- Reasoning: a RolePermission row carries no data of its own beyond the pair
-- (roleId, permissionId). Its entire sensitivity is its parent Role's — so the
-- correct rule is "visible exactly when its Role is visible", and Role's policy
-- says a NULL-org system role is visible in every tenant context. Making
-- RolePermission stricter than Role would mean every tenant could see the
-- system SUPER_ADMIN role but would read its permission set as *empty*; since
-- RBAC checks fail closed on an empty permission set, that is not a tighter
-- security posture, it is a silent authorization break with no isolation gain
-- (the permission keys themselves are a public, hard-coded catalog —
-- src/config/permissions.ts — not tenant data). Consistency with Role is
-- therefore both the safe and the correct semantics.
ALTER TABLE "RolePermission" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "RolePermission" FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON "RolePermission"
  USING (EXISTS (
    SELECT 1 FROM "Role"
    WHERE "Role"."id" = "RolePermission"."roleId"
      AND ("Role"."organizationId" IS NULL
           OR "Role"."organizationId" = current_setting('app.current_tenant_id', true))
  ));

ALTER TABLE "MembershipPlanService" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "MembershipPlanService" FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON "MembershipPlanService"
  USING (EXISTS (
    SELECT 1 FROM "MembershipPlan"
    WHERE "MembershipPlan"."id" = "MembershipPlanService"."membershipPlanId"
      AND "MembershipPlan"."organizationId" = current_setting('app.current_tenant_id', true)
  ));

ALTER TABLE "MembershipPlanBranch" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "MembershipPlanBranch" FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON "MembershipPlanBranch"
  USING (EXISTS (
    SELECT 1 FROM "MembershipPlan"
    WHERE "MembershipPlan"."id" = "MembershipPlanBranch"."membershipPlanId"
      AND "MembershipPlan"."organizationId" = current_setting('app.current_tenant_id', true)
  ));
