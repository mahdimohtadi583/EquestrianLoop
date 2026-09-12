-- =============================================================================
-- Task 9 security hardening, Part C: every enforced foreign key from one
-- tenant-scoped table to ANOTHER tenant-scoped table must stay inside one
-- tenant.
--
-- THE SYSTEMIC HOLE THIS CLOSES
-- -----------------------------
-- 20260911152445_enable_rls gave each tenant-scoped table a policy that tests
-- exactly one thing: `"organizationId" = current_setting('app.current_tenant_id',
-- true)`. That is the row's OWN tenant column, and nothing else. Two earlier
-- rounds patched two instances of the resulting gap one at a time
-- (20260911201510_fix_membership_plan_join_tenant_matching for
-- MembershipPlanService/MembershipPlanBranch's second FK, and
-- 20260911205920_restrict_membership_role_to_own_tenant for Membership.roleId).
-- An independent adversarial review then observed that the pattern — "check only
-- the row's own organizationId" — is systemic rather than a pair of oversights,
-- and the project owner authorised a full mechanical audit.
--
-- THE AUDIT
-- ---------
-- Every foreign-key constraint in schema `public` was enumerated from
-- `pg_constraint` directly (joined to pg_class/pg_attribute for names, and to
-- pg_attribute.attnotnull for nullability), NOT from any hand-written list —
-- 49 constraints in total. Each was classified:
--
--   * 24 SAFE BY CONSTRUCTION — the referenced table is not tenant data, so
--     there is no cross-tenant question to ask: the 20 `*.organizationId ->
--     Organization.id` keys, the 3 `*.userId -> User.id` keys (Customer,
--     Membership, Staff), and RolePermission.permissionId -> Permission.id (a
--     fixed global catalog, locked read-only by
--     20260911205351_lock_down_permission_catalog_writes).
--
--   * 7 ALREADY PROTECTED BY AN RLS POLICY — the 4 columnless join/extension
--     tables' EXISTS policies (Trainer.staffId, RolePermission.roleId,
--     MembershipPlanService.membershipPlanId/serviceId,
--     MembershipPlanBranch.membershipPlanId/branchId) and Membership.roleId.
--     Deliberately not re-touched by this migration.
--
--   * 0 PROTECTED BY ANOTHER DATABASE CONSTRAINT. Checked rather than assumed:
--     every one of the 49 constraints is single-column on both sides
--     (`array_length(conkey,1) = 1`), so there is no composite foreign key
--     carrying `organizationId` on both ends anywhere in this schema, and no
--     other DB-level mechanism that would make a cross-tenant reference
--     impossible. This category is empty, and saying so is part of the audit.
--
--   * 18 POTENTIALLY CROSS-TENANT — a real, enforced FK; the owning table is
--     tenant-scoped; the referenced table is tenant-scoped too; and nothing
--     validated that the two agree. These are what this migration fixes, and
--     they span 11 tables.
--
-- Plain-scalar forward references that carry NO foreign-key constraint at all
-- (Booking.paymentId, Booking.customerMembershipId, CustomerMembership.paymentId,
-- Payment.bookingId, Notification.recipientUserId, CheckIn.checkedInByStaffId,
-- BlockedTime.branchId/trainerId/horseId, LoyaltyTransaction.sourceId) are out of
-- scope here by design: they are protected only by application logic, adding a
-- constraint to them would be a schema change, and an RLS predicate cannot be
-- attached to a reference the database does not model. They are listed in the
-- Task 9 report so the classification stays a decision rather than an omission.
--
-- WHAT THE EXPLOIT ACTUALLY IS, MEASURED
-- --------------------------------------
-- Every one of the 18 was reproduced live on this deployment (PostgreSQL 17.6)
-- BEFORE this migration, on a direct connection authenticated as the real
-- `app_runtime` role (rolsuper = false, rolbypassrls = false, not the table
-- owner — verified in the same session), with a valid tenant context and no
-- `SET ROLE` proxy of any kind. All 18 INSERTs landed a row, as did three
-- representative UPDATEs that re-pointed an existing legitimate row at a foreign
-- one. Verbatim results are in the Task 9 report, Part C.
--
-- It is not a read leak. The resulting row carries the attacker's own
-- organizationId, so it stays scoped to the attacker under the existing SELECT
-- predicate, and the foreign row it references remains invisible behind its own
-- policy. It is a cross-tenant referential-integrity coupling: one tenant's row
-- holding a durable, enforced reference into another tenant's data. Consequences
-- that follow from the FK being real:
--
--   * the victim's `DELETE FROM "Branch"/"Service"/"Reward"/...` now fails with a
--     foreign-key violation naming a row the victim cannot see (the RESTRICT
--     keys), or silently cascades into the attacker's rows (the CASCADE keys) —
--     a denial-of-service and a data-integrity coupling across a boundary that
--     is supposed to be absolute;
--   * `ON DELETE SET NULL` keys let the victim's delete silently mutate the
--     attacker's row;
--   * every future task that resolves one of these relations (scheduling,
--     check-in, loyalty, billing) would read another tenant's Branch, Service,
--     Horse, Trainer, Customer, Reward or LoyaltyAccount through a row that
--     looks perfectly well-formed. Nothing reads them today, which makes this
--     latent rather than live — and silent when it stops being latent.
--
-- THE SHAPE OF THE FIX, REASONED PER TABLE RATHER THAN COPIED
-- ----------------------------------------------------------
-- All 11 tables fixed here carry their own NOT NULL `organizationId`. That fact
-- decides the USING/WITH CHECK split, and it decides it the same way for all 11 —
-- but for Membership's reason from round 3, NOT for Role's reason from rounds 1-2.
-- Spelled out, because the two look alike and are not:
--
--   * USING is left EXACTLY as it was (`"organizationId" = current_setting(...)`).
--     Three independent reasons:
--
--       - READ. A row's tenant is stated directly by its own NOT NULL
--         organizationId. Whether its foreign keys are sane is a referential-
--         integrity question, not a visibility question. Folding the FK checks
--         into USING would make any pre-existing malformed row (e.g. one created
--         through the hole this migration closes, before it was closed) silently
--         INVISIBLE to the tenant that owns it — hiding exactly the rows an
--         operator needs to see in order to clean them up.
--
--       - OLD ROW OF UPDATE, and DELETE. Both are governed by USING, and USING
--         here already admits only rows of the caller's own organization. Unlike
--         "Role"/"RolePermission" — whose USING deliberately admits foreign,
--         NULL-org platform rows and therefore needed the RESTRICTIVE FOR UPDATE
--         / FOR DELETE policies of rounds 1 and 2 — none of these 11 tables has
--         any platform-scoped row to protect, and none can have one, because the
--         column is NOT NULL. So no RESTRICTIVE policy is warranted on any of
--         them, and none is added. Each stays a single-policy table.
--
--       - A widened USING would also change query PLANS for ordinary tenant
--         reads on the hottest tables in the schema (Booking, RidingSession),
--         adding a subquery per row for no security gain.
--
--   * WITH CHECK becomes explicit and carries the FK conjuncts. This is the
--     entire attack surface — creating, or re-pointing, a row at a target
--     outside its tenant — and WITH CHECK is precisely the clause Postgres
--     applies to the row an INSERT or an UPDATE produces. Stating it explicitly
--     also ends Postgres's implicit reuse of USING as WITH CHECK, which is what
--     let the unchecked foreign keys through in the first place.
--
--   * The tenant-match conjunct is RESTATED inside every WITH CHECK. Naming
--     WITH CHECK explicitly replaces the implicit copy of USING, so omitting it
--     would re-open plain cross-tenant INSERT on these tables — a far worse hole
--     than the one being closed. This is the same trap round 3 called out on
--     Membership.
--
-- HOW EACH CONJUNCT IS WRITTEN
-- ----------------------------
-- `AND EXISTS (SELECT 1 FROM "<Parent>" WHERE "<Parent>"."id" = "<Child>"."<fk>"
--              AND "<Parent>"."organizationId" = "<Child>"."organizationId")`
--
-- Note the right-hand side: the parent's organizationId is compared to the
-- CHILD ROW'S OWN organizationId, not to `current_setting(...)` directly. That
-- is round 3's Membership shape, and it is deliberate — it states an intra-row
-- invariant ("this row's parent is in this row's organization") that holds
-- independently of who is asking, while the separate `"organizationId" =
-- current_setting(...)` conjunct in the same WITH CHECK pins the row to the
-- caller. Together they are strictly stronger than either alone and they cannot
-- disagree.
--
-- Each subquery runs as the querying role and is therefore itself subject to the
-- parent table's own RLS policy. That can only ever NARROW the result, never
-- widen it: another tenant's parent row is invisible, so EXISTS is false, and
-- even if it were visible the equality test would reject it. Both halves of the
-- rejection are independent, which is what makes this robust to a future change
-- in either policy.
--
-- NULLABLE FOREIGN KEYS — read off `pg_attribute.attnotnull`, per column
-- ---------------------------------------------------------------------
-- Five of the 18 columns are genuinely optional, and for those the conjunct is
-- `("<fk>" IS NULL OR EXISTS (...))` so that leaving the relationship unset
-- stays legal while a NON-NULL value pointing at another tenant is still
-- rejected. Making any of them effectively mandatory would be a schema change
-- smuggled in through a policy, which is expressly not the intent:
--
--     Staff.branchId          NULL-able  (a staff member not assigned to a branch)
--     Membership.branchId     NULL-able  (an org-wide membership, no home branch)
--     RidingSession.trainerId NULL-able  (Service.requiresTrainer = false)
--     RidingSession.horseId   NULL-able  (Service.requiresHorse = false)
--     Payment.customerId      NULL-able  (a payment not attributable to a customer)
--
-- The other 13 columns are NOT NULL in the database, so no IS NULL branch is
-- written for them — adding one there would be dead code that invited a reader
-- to think the column was optional. Both facts were verified live and the NULL
-- cases are asserted by the regression tests.
--
-- TWO-HOP CHAINS — each policy validates its own DIRECT foreign keys only
-- ----------------------------------------------------------------------
-- CheckIn -> Booking -> {Customer, RidingSession}, and
-- RewardRedemption -> LoyaltyTransaction -> LoyaltyAccount -> Customer, are
-- chains. CheckIn's policy confirms only that the "Booking" it references is in
-- CheckIn's own organization; it does NOT re-validate Booking's own foreign
-- keys, because Booking's policy below does that job for every Booking row an
-- RLS-subject role can create or modify. Re-validating would duplicate the
-- check, couple the two policies, and still add no guarantee — the invariant is
-- established once, at the edge where the row is written. This is the intended
-- design, stated here so a later reader does not mistake it for an omission.
--
-- WHY NOTHING LEGITIMATE BREAKS
-- -----------------------------
-- Every row the application has any way to create links rows of one single
-- organization, so all conjuncts hold. prisma/seed.ts and Tasks 3-8's
-- schema-verification tests run through `rawPrisma` as `postgres` — BYPASSRLS,
-- and the table owner — with no tenant context, so they are not governed by
-- these predicates at all. Same-tenant writes, NULL writes for every nullable
-- column, and ordinary tenant reads were all re-verified live on the
-- `app_runtime` connection after this migration; see the Task 9 report, Part C.
--
-- ALTER POLICY, not CREATE: every policy below already exists, and this
-- migration changes no Prisma model. It was produced with
-- `npx prisma migrate dev --name ... --create-only` and then hand-written — the
-- same two-step pattern every other RLS migration in this project uses, since
-- RLS policies are not modelled in schema.prisma.
-- =============================================================================


-- -----------------------------------------------------------------------------
-- 1. "Staff".branchId -> "Branch"                                    NULLABLE
--
-- A Staff row is tenant-scoped; Branch is too. Nothing checked that a staff
-- member's home branch belonged to the same organization.
--
-- NULLABLE: Staff.branchId is optional (a staff member with no branch
-- assignment), so the conjunct admits NULL. Only a non-null value pointing
-- outside the tenant is refused.
-- -----------------------------------------------------------------------------
ALTER POLICY tenant_isolation ON "Staff"
  USING ("organizationId" = current_setting('app.current_tenant_id', true))
  WITH CHECK (
    "organizationId" = current_setting('app.current_tenant_id', true)
    AND (
      "branchId" IS NULL
      OR EXISTS (
        SELECT 1 FROM "Branch"
        WHERE "Branch"."id" = "Staff"."branchId"
          AND "Branch"."organizationId" = "Staff"."organizationId"
      )
    )
  );


-- -----------------------------------------------------------------------------
-- 2. "Horse".branchId -> "Branch"                                    NOT NULL
--
-- Horse.branchId is NOT NULL in the database (every horse is stabled at a
-- branch), so there is no IS NULL branch. The FK is ON DELETE RESTRICT, so
-- before this fix a cross-tenant Horse made the victim's `DELETE FROM "Branch"`
-- fail against an invisible row.
-- -----------------------------------------------------------------------------
ALTER POLICY tenant_isolation ON "Horse"
  USING ("organizationId" = current_setting('app.current_tenant_id', true))
  WITH CHECK (
    "organizationId" = current_setting('app.current_tenant_id', true)
    AND EXISTS (
      SELECT 1 FROM "Branch"
      WHERE "Branch"."id" = "Horse"."branchId"
        AND "Branch"."organizationId" = "Horse"."organizationId"
    )
  );


-- -----------------------------------------------------------------------------
-- 3. "RidingSession" — four foreign keys, two of them nullable, and one that
--    resolves through a columnless extension table.
--
--      branchId   -> "Branch"   NOT NULL
--      serviceId  -> "Service"  NOT NULL
--      trainerId  -> "Trainer"  NULLABLE   (Service.requiresTrainer = false)
--      horseId    -> "Horse"    NULLABLE   (Service.requiresHorse   = false)
--
-- THE "Trainer" CASE, which is not like the other three.
-- "Trainer" carries NO organizationId column of its own — its tenant is defined
-- by its parent "Staff" row, which is why 20260911152445_enable_rls gave it an
-- EXISTS policy against "Staff" instead. That existing policy is correct and is
-- deliberately NOT touched here; it answers "is this Trainer row visible to the
-- caller?". It does not answer the question RidingSession needs answered, which
-- is "does the Trainer this row references belong to THIS ROW'S organization?" —
-- so the conjunct below joins Trainer to Staff itself and compares
-- Staff.organizationId to RidingSession.organizationId. Relying on Trainer's own
-- policy to filter the subquery would be a weaker guarantee resting on a
-- different table's predicate; this states the invariant directly.
-- -----------------------------------------------------------------------------
ALTER POLICY tenant_isolation ON "RidingSession"
  USING ("organizationId" = current_setting('app.current_tenant_id', true))
  WITH CHECK (
    "organizationId" = current_setting('app.current_tenant_id', true)
    AND EXISTS (
      SELECT 1 FROM "Branch"
      WHERE "Branch"."id" = "RidingSession"."branchId"
        AND "Branch"."organizationId" = "RidingSession"."organizationId"
    )
    AND EXISTS (
      SELECT 1 FROM "Service"
      WHERE "Service"."id" = "RidingSession"."serviceId"
        AND "Service"."organizationId" = "RidingSession"."organizationId"
    )
    AND (
      "trainerId" IS NULL
      OR EXISTS (
        SELECT 1 FROM "Trainer"
        JOIN "Staff" ON "Staff"."id" = "Trainer"."staffId"
        WHERE "Trainer"."id" = "RidingSession"."trainerId"
          AND "Staff"."organizationId" = "RidingSession"."organizationId"
      )
    )
    AND (
      "horseId" IS NULL
      OR EXISTS (
        SELECT 1 FROM "Horse"
        WHERE "Horse"."id" = "RidingSession"."horseId"
          AND "Horse"."organizationId" = "RidingSession"."organizationId"
      )
    )
  );


-- -----------------------------------------------------------------------------
-- 4. "Booking" — two foreign keys, both NOT NULL.
--
--      customerId      -> "Customer"       NOT NULL
--      ridingSessionId -> "RidingSession"  NOT NULL
--
-- The most consequential pair in the schema: a Booking is the row that joins a
-- person to a session, so a cross-tenant Booking is one tenant holding a
-- reservation against another tenant's capacity, or against another tenant's
-- customer. customerId is ON DELETE CASCADE, so before this fix the victim
-- deleting their own Customer silently deleted the attacker's Booking.
--
-- Booking.paymentId and Booking.customerMembershipId are deliberately absent
-- from this predicate: they are plain scalars with no foreign-key constraint in
-- the database (an original design decision recorded in schema.prisma), so they
-- fall in the "protected only by application logic" class and are out of scope.
-- -----------------------------------------------------------------------------
ALTER POLICY tenant_isolation ON "Booking"
  USING ("organizationId" = current_setting('app.current_tenant_id', true))
  WITH CHECK (
    "organizationId" = current_setting('app.current_tenant_id', true)
    AND EXISTS (
      SELECT 1 FROM "Customer"
      WHERE "Customer"."id" = "Booking"."customerId"
        AND "Customer"."organizationId" = "Booking"."organizationId"
    )
    AND EXISTS (
      SELECT 1 FROM "RidingSession"
      WHERE "RidingSession"."id" = "Booking"."ridingSessionId"
        AND "RidingSession"."organizationId" = "Booking"."organizationId"
    )
  );


-- -----------------------------------------------------------------------------
-- 5. "CheckIn".bookingId -> "Booking"                                NOT NULL
--
-- TWO-HOP: this validates only the DIRECT key. Booking's own customerId and
-- ridingSessionId are validated by Booking's policy above, at the point the
-- Booking row is written, so re-checking them here would be duplication rather
-- than defence. See the TWO-HOP CHAINS note in the header.
--
-- CheckIn.checkedInByStaffId is a plain scalar with no FK constraint and is
-- therefore out of scope (application logic only).
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
  );


-- -----------------------------------------------------------------------------
-- 6. "CustomerMembership" — two foreign keys, both NOT NULL.
--
--      customerId       -> "Customer"        NOT NULL
--      membershipPlanId -> "MembershipPlan"  NOT NULL
--
-- The direct analogue of round 2's MembershipPlanService/Branch fix, one level
-- up: that round stopped a plan being linked to a foreign Service or Branch;
-- this stops a *subscription to* a plan crossing tenants in either direction.
--
-- CustomerMembership.paymentId is a plain scalar with no FK constraint — out of
-- scope, application logic only.
-- -----------------------------------------------------------------------------
ALTER POLICY tenant_isolation ON "CustomerMembership"
  USING ("organizationId" = current_setting('app.current_tenant_id', true))
  WITH CHECK (
    "organizationId" = current_setting('app.current_tenant_id', true)
    AND EXISTS (
      SELECT 1 FROM "Customer"
      WHERE "Customer"."id" = "CustomerMembership"."customerId"
        AND "Customer"."organizationId" = "CustomerMembership"."organizationId"
    )
    AND EXISTS (
      SELECT 1 FROM "MembershipPlan"
      WHERE "MembershipPlan"."id" = "CustomerMembership"."membershipPlanId"
        AND "MembershipPlan"."organizationId" = "CustomerMembership"."organizationId"
    )
  );


-- -----------------------------------------------------------------------------
-- 7. "LoyaltyAccount".customerId -> "Customer"                       NOT NULL
--
-- customerId is additionally UNIQUE (one account per customer), so before this
-- fix a tenant could claim the only loyalty-account slot belonging to another
-- tenant's customer — denying the victim the ability to ever create the account
-- their own application flow requires. That is a cross-tenant write amplifying
-- into a functional lockout, on top of the reference itself.
-- -----------------------------------------------------------------------------
ALTER POLICY tenant_isolation ON "LoyaltyAccount"
  USING ("organizationId" = current_setting('app.current_tenant_id', true))
  WITH CHECK (
    "organizationId" = current_setting('app.current_tenant_id', true)
    AND EXISTS (
      SELECT 1 FROM "Customer"
      WHERE "Customer"."id" = "LoyaltyAccount"."customerId"
        AND "Customer"."organizationId" = "LoyaltyAccount"."organizationId"
    )
  );


-- -----------------------------------------------------------------------------
-- 8. "LoyaltyTransaction".loyaltyAccountId -> "LoyaltyAccount"       NOT NULL
--
-- Points are money-adjacent. A cross-tenant transaction row credits or debits
-- another tenant's ledger, and the FK is ON DELETE CASCADE, so the victim
-- closing their own loyalty account silently destroys the attacker's rows too.
--
-- LoyaltyTransaction.sourceId is an untyped polymorphic scalar with no FK
-- constraint — out of scope, application logic only.
-- -----------------------------------------------------------------------------
ALTER POLICY tenant_isolation ON "LoyaltyTransaction"
  USING ("organizationId" = current_setting('app.current_tenant_id', true))
  WITH CHECK (
    "organizationId" = current_setting('app.current_tenant_id', true)
    AND EXISTS (
      SELECT 1 FROM "LoyaltyAccount"
      WHERE "LoyaltyAccount"."id" = "LoyaltyTransaction"."loyaltyAccountId"
        AND "LoyaltyAccount"."organizationId" = "LoyaltyTransaction"."organizationId"
    )
  );


-- -----------------------------------------------------------------------------
-- 9. "RewardRedemption" — three foreign keys, all NOT NULL.
--
--      customerId           -> "Customer"            NOT NULL
--      rewardId             -> "Reward"              NOT NULL
--      loyaltyTransactionId -> "LoyaltyTransaction"  NOT NULL, UNIQUE
--
-- TWO-HOP on the third key: LoyaltyTransaction's own loyaltyAccountId is
-- validated by its policy (block 8) when that row is written, so this checks
-- only that the LoyaltyTransaction itself is in the same organization.
-- -----------------------------------------------------------------------------
ALTER POLICY tenant_isolation ON "RewardRedemption"
  USING ("organizationId" = current_setting('app.current_tenant_id', true))
  WITH CHECK (
    "organizationId" = current_setting('app.current_tenant_id', true)
    AND EXISTS (
      SELECT 1 FROM "Customer"
      WHERE "Customer"."id" = "RewardRedemption"."customerId"
        AND "Customer"."organizationId" = "RewardRedemption"."organizationId"
    )
    AND EXISTS (
      SELECT 1 FROM "Reward"
      WHERE "Reward"."id" = "RewardRedemption"."rewardId"
        AND "Reward"."organizationId" = "RewardRedemption"."organizationId"
    )
    AND EXISTS (
      SELECT 1 FROM "LoyaltyTransaction"
      WHERE "LoyaltyTransaction"."id" = "RewardRedemption"."loyaltyTransactionId"
        AND "LoyaltyTransaction"."organizationId" = "RewardRedemption"."organizationId"
    )
  );


-- -----------------------------------------------------------------------------
-- 10. "Payment".customerId -> "Customer"                             NULLABLE
--
-- NULLABLE: Payment.customerId is optional — a payment need not be attributable
-- to a customer (platform-level or unattributed settlement). So the conjunct
-- admits NULL and rejects only a non-null cross-tenant value. The FK is
-- ON DELETE SET NULL, which before this fix meant the victim deleting their own
-- Customer silently mutated the attacker's Payment row.
--
-- Payment.bookingId is a plain scalar with no FK constraint — out of scope,
-- application logic only.
-- -----------------------------------------------------------------------------
ALTER POLICY tenant_isolation ON "Payment"
  USING ("organizationId" = current_setting('app.current_tenant_id', true))
  WITH CHECK (
    "organizationId" = current_setting('app.current_tenant_id', true)
    AND (
      "customerId" IS NULL
      OR EXISTS (
        SELECT 1 FROM "Customer"
        WHERE "Customer"."id" = "Payment"."customerId"
          AND "Customer"."organizationId" = "Payment"."organizationId"
      )
    )
  );


-- -----------------------------------------------------------------------------
-- 11. "Membership".branchId -> "Branch"                              NULLABLE
--
-- Membership's policy already carries the roleId conjunct added by
-- 20260911205920_restrict_membership_role_to_own_tenant. That conjunct is
-- reproduced here VERBATIM, unchanged, because ALTER POLICY replaces the whole
-- WITH CHECK expression rather than appending to it — dropping it would silently
-- re-open the privilege escalation round 3 closed. This is the only place in
-- this migration where an earlier round's work is restated, and it is restated
-- rather than re-decided.
--
-- The second FK, branchId, was never checked: a tenant could give one of its own
-- memberships a home branch belonging to another organization.
--
-- NULLABLE: Membership.branchId is optional (an organization-wide membership
-- with no home branch), so NULL is admitted.
-- -----------------------------------------------------------------------------
ALTER POLICY tenant_isolation ON "Membership"
  USING ("organizationId" = current_setting('app.current_tenant_id', true))
  WITH CHECK (
    "organizationId" = current_setting('app.current_tenant_id', true)
    AND EXISTS (
      SELECT 1 FROM "Role"
      WHERE "Role"."id" = "Membership"."roleId"
        AND "Role"."organizationId" = "Membership"."organizationId"
    )
    AND (
      "branchId" IS NULL
      OR EXISTS (
        SELECT 1 FROM "Branch"
        WHERE "Branch"."id" = "Membership"."branchId"
          AND "Branch"."organizationId" = "Membership"."organizationId"
      )
    )
  );
