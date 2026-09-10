# EquestrianLoop — Foundation Architecture & Design Spec

**Date:** 2026-09-10
**Status:** Approved for implementation planning
**Scope:** Phase 0 (Foundation) of a multi-phase SaaS build. Later phases are listed for context but are not specified in implementation-ready detail here.

## 1. Product Summary

EquestrianLoop is a paid, multi-tenant SaaS platform for equestrian clubs, horse farms, and riding schools to manage customers, horses, trainers, staff, bookings, riding sessions, check-ins, loyalty, rewards, payments, notifications, and reporting — plus a customer-facing portal (including self-service booking) and a platform-level Super Admin dashboard.

**Business model:** paid-only. No free plan, no free trial, anywhere in the product. This is enforced structurally, not just by configuration (see §6).

## 2. Multi-Tenancy Strategy

Shared database, shared schema. Every tenant-scoped table carries `organizationId`. Isolation is enforced at two independent layers:

- **Application layer:** all data access goes through a server-only layer that injects `organizationId` from the verified session. Server Actions and route handlers never accept a tenant identifier from client input.
- **Database layer (defense in depth):** Postgres Row-Level Security policies on every tenant table, keyed to a `app.current_tenant_id` session variable set via `SET LOCAL` inside each request's transaction, sourced only from the server-verified session — never from the URL or request body.

Tenant routing is path-based: `/[orgSlug]/...`. `orgSlug` is resolved to an `organizationId` server-side and cross-checked against the caller's `Membership` (staff) or `Customer` record (customer) before any query runs; the URL segment is a routing convenience, not an authorization input. Subdomain-based routing (`club.equestrianloop.com`) is a documented future upgrade (middleware-only change, no schema impact) — deferred because it adds wildcard DNS/SSL/local-dev complexity with no security benefit over the above.

Global **Super Admin** is a structurally separate path: `User.type = SUPER_ADMIN`, no `Membership` row, no `organizationId` in session context, operates under `/admin`. Super Admin code paths are never shared with tenant-scoped RBAC checks.

## 3. Identity Model

Three distinct kinds of principal, modeled as one `User` table with a `type` discriminator, because they have almost nothing in common beyond "logs in":

- `SUPER_ADMIN` — platform operator. No `Membership`, no `Customer` row.
- `STAFF` — linked 1:1 to a `Staff` record, which is linked to `Membership` rows (their access grants per organization/branch/role).
- `CUSTOMER` — linked to one or more `Customer` records (one per organization they patronize — a rider visiting two different stables gets two `Customer` rows under one `User`, since loyalty balances and booking history are club-specific).

**Customers never have administrative permissions, structurally, not just by configuration.** Customer authorization (`requireCustomer()`) and staff authorization (`requirePermission()`) are separate guard functions with no shared code path. There is no permission flag that, if misconfigured, could grant a customer admin capability — the customer request path never evaluates `Role`/`Permission` at all.

> **Naming note — three unrelated "membership" concepts, kept separate in both schema and authorization logic, never conflated:**
> 1. **`Subscription`** — the *club's* paid subscription to EquestrianLoop (§6).
> 2. **`Membership`** — a *staff* user's access grant (org/branch/role) for RBAC (§5).
> 3. **`MembershipPlan` / `CustomerMembership`** — a plan the *club* sells to *its own customers* (e.g. "Gold: 8 sessions/month"), detailed in §10. `CustomerMembership` carries zero RBAC weight — it can restrict or extend a customer's *booking* privileges (§10) but can never grant any staff/admin permission; that grant path only exists via `Membership`/`Role`/`Permission` and customers are structurally excluded from it (§3 above).

## 4. Authentication Strategy

Auth.js (NextAuth) v5, Credentials provider, Prisma adapter, **database sessions** (session state re-derived from the DB on every request, not trusted from a client-held JWT). Passwords hashed with bcrypt.

- **Staff** accounts are created via invite (email + org + role → sets password on first login).
- **Customer** accounts are created either by staff (front-desk enters name/email → invite email to set password) or by customer self-signup against a specific club's public signup link. Both converge on the same `User(type=CUSTOMER)` + `Customer` row creation.

Chosen over Clerk/WorkOS: those give faster org/invite UX out of the box, but bill per-MAU — expensive once a club's full customer roster (not just staff) is in the system — and add an external vendor holding tenant data. Revisit only if invite/session UX becomes a real bottleneck.

## 5. Role & Permission Strategy

Real `Role` / `Permission` / `RolePermission` tables, not hardcoded enums, so custom roles are possible later. Foundation phase seeds fixed defaults only — a custom-role-builder UI is explicitly out of scope for now:

- Per-organization roles: `OWNER`, `ADMIN`, `MANAGER`, `TRAINER`, `FRONT_DESK`.
- Platform role: `SUPER_ADMIN` (no `organizationId`).
- Permission catalog (strings): `customers.manage`, `horses.manage`, `staff.manage`, `services.manage`, `bookings.manage`, `sessions.manage`, `checkins.manage`, `loyalty.manage`, `rewards.manage`, `memberships.manage`, `billing.manage`, `reports.view`, `settings.manage`.

Foundation: one role per user per organization (`Membership` unique on `(userId, organizationId)`). Branch-level permission scoping (`Membership.branchId`) is modeled in the schema now but not enforced in UI until a later phase.

## 6. Billing Architecture (provider-agnostic)

Billing is defined as a domain interface, not a Stripe integration:

```
server/billing/PaymentProvider.ts          — interface
server/billing/providers/StripeProvider.ts — first implementation
server/billing/BillingService.ts           — domain service; app code depends on this, never on a provider directly
```

`PaymentProvider` interface (conceptual):

```
createCustomer(org) -> providerCustomerId
createCheckoutSession(org, planId) -> checkoutUrl        // must never configure a trial period
cancelSubscription(providerSubscriptionId) -> void
createOneOffCharge(payerRef, amount, currency, metadata) -> ProviderChargeResult   // used by paid bookings, §10
handleWebhookEvent(rawPayload, signature) -> NormalizedBillingEvent
```

The `Subscription` table itself is provider-agnostic — no Stripe-shaped columns:

- `provider` (string, e.g. `"stripe"`)
- `providerCustomerId`, `providerSubscriptionId` (opaque strings)
- `planId`, `status`, `currentPeriodEnd`

Webhook endpoint is `/api/webhooks/[provider]`, dispatching to the matching `PaymentProvider.handleWebhookEvent`. Adding a second provider later means implementing the interface and registering it — no changes to `BillingService`, the `Subscription` schema, or any UI that reads subscription status. The same interface backs both recurring platform billing and one-off booking payments (§10), so a provider swap covers both without touching the booking domain.

**No-trial guarantee is structural:** `SubscriptionStatus` has no `TRIALING` value at all (`INCOMPLETE | ACTIVE | PAST_DUE | CANCELED | UNPAID`). It's not "unused," it's unrepresentable. Tenant-app access gating is a single check: `status === 'ACTIVE'`.

## 7. Storage Architecture (provider-agnostic)

Same pattern as billing:

```
server/storage/StorageProvider.ts                   — interface: upload(file, path), getUrl(path), delete(path)
server/storage/providers/SupabaseStorageProvider.ts — first implementation
server/storage/StorageService.ts                    — what app code (e.g. horse photo upload) actually calls
```

Application/domain code (Horse profiles, future club branding assets) never imports a Supabase SDK type or calls a Supabase-specific API directly — only `StorageService`.

## 8. Loyalty Architecture (core differentiator — foundational)

**Flow:** Booking → Check-in → Riding Session → Session Completed → Loyalty Eligibility Check → Idempotent Points Award → Loyalty Transaction → Updated Balance → Customer Progress.

**Ledger, not counter.** `LoyaltyTransaction` is the source of truth (append-only). `LoyaltyAccount.balance` is a denormalized cache, updated only inside the same DB transaction as the ledger insert that produced it — never mutated independently. It can always be rebuilt by re-summing the ledger.

**Idempotency is enforced at the database, not by caller discipline.** `LoyaltyTransaction` has a unique constraint on `(organizationId, sourceType, sourceId)`. Awarding points for a completed session inserts a row with `sourceType = 'SESSION_COMPLETION'`, `sourceId = ridingSessionId`. A retried webhook, a double-tap on "complete session," or a re-run background job all attempt the same insert — the second attempt hits the unique constraint and is caught as a no-op (returns the existing transaction) rather than double-crediting. This makes the guarantee independent of how many places end up calling the award path.

**Single entry point.** `server/loyalty/LoyaltyService.ts` exposes `awardPointsForSession(sessionId)` as the *only* code path allowed to create an `EARN` transaction from a session. It: confirms the session is `COMPLETED`, confirms a `CheckIn` exists for it, computes the point value from the org's loyalty rules (`Organization.settings`), and performs the idempotent insert + balance update in one DB transaction. Every future trigger (manual staff action now, an automated completion job later) calls this one function — correctness doesn't depend on every caller remembering to check for duplicates.

Redemption (`RewardRedemption`) follows the same ledger pattern: a `REDEEM` transaction (negative points) linked to the redemption row, in one transaction with a balance check (no overdraft).

## 9. Customer QR Identity & Check-in Architecture

Every `Customer` gets a `qrToken`: a unique, non-guessable random string generated at creation (not the customer's database ID — avoids enumeration). The QR code is rendered client-side from this token; no image is stored.

**Designed-for-but-not-yet-built flow** (data model and service boundaries exist now; scanning UI is a later phase):

```
Staff scans QR → CheckInService.findCustomerByQrToken(orgId, token)
              → resolves today's relevant Booking for that customer
              → CheckInService.confirmCheckIn(bookingId, staffId)
              → (on session completion) LoyaltyService.awardPointsForSession(sessionId)
```

`findCustomerByQrToken` scopes the lookup to the scanning staff member's `organizationId` — a token only resolves within the tenant that issued it.

## 10. Self-Service Booking & Availability Architecture

**Controls, at two levels:**

- `Organization.customerSelfBookingEnabled` (boolean, default `false`) — master switch for the whole club.
- `Service.customerBookingEnabled` (boolean, default `false`) — per-service override. A service is bookable by customers only when **both** switches are on (e.g. a club enables self-booking generally, but leaves it off for "Private Training" while it's on for "Horse Riding").

**Flow** (every step backed by a real query, never a static list): select service (filtered to customer-bookable services) → select branch (branches offering it) → select date → `AvailabilityService.getAvailableSlots()` returns real open slots → select trainer, if `Service.trainerSelectable` → select horse, if `Service.horseSelectable` → review (price, cancellation/reschedule policy shown) → payment, if `Service.requiresPaymentAtBooking` → `BookingService.createBooking()` → `Notification` sent.

**Scheduling types.** `Service.schedulingType`:
- `FIXED_SESSION` — customer books a seat in a pre-scheduled `RidingSession` staff already created. Typical for group lessons.
- `DYNAMIC` — customer picks any open start time within operating hours/duration/resource availability, and a `RidingSession` is created at booking time. Typical for private lessons.

One `AvailabilityService` interface serves both; slot generation differs underneath — `FIXED_SESSION` queries existing sessions with `bookedCount < capacity`; `DYNAMIC` generates candidate start times across the branch's operating hours at the service's duration increment, then excludes any that conflict with the relevant trainer's/horse's existing sessions or `BlockedTime` entries.

**Availability inputs** (all real, never approximated): branch operating hours (`Branch.operatingHours`), trainer schedule (`RidingSession` assignments + `BlockedTime`), horse schedule (same), service capacity, existing `Booking`s, `BlockedTime` (branch/trainer/horse-scoped closures), the customer's `CustomerMembership` restrictions and booking-limit counters, and the service's cancellation/reschedule policy (shown at review time, not a slot-generation input).

**"Never expose unavailable slots as bookable" is enforced twice.** `AvailabilityService` is the only source of truth the UI reads from, and `BookingService.createBooking()` independently re-derives availability at write time, inside the same DB transaction that inserts the `Booking` (and, for `DYNAMIC` services, the `RidingSession`) — it never trusts that a slot fetched moments earlier is still open. Races between two customers booking the same private trainer/horse slot are closed with a DB-level exclusion constraint on that resource's booked time ranges (Postgres `EXCLUDE USING gist` over a `tstzrange`, or equivalent row-locking — exact mechanism is an implementation-time choice), not just an application-level check.

**Booking limits & membership restrictions.** `Service.maxBookingsPerCustomerPerWeek` (nullable — null means no limit) caps how many active bookings of that service a customer can hold; usage is computed by counting the customer's `Booking` rows in the relevant window, not a separate usage-counter table, to avoid overbuilding. `CustomerMembership` (a customer's enrollment in a `MembershipPlan`, e.g. "Gold: 8 sessions/month") can further restrict or extend this — the exact interaction (plan quota vs. per-service cap) is enforced by `BookingService` at write time, alongside the availability check.

**Membership plans (`MembershipPlan` / `CustomerMembership`).** A club can define multiple `MembershipPlan` records (e.g. "Gold," "Silver," pay-per-ride has no plan at all); a customer may hold **only one active `CustomerMembership` at a time** — an intentional MVP limitation, enforced at the database with a partial unique index (`UNIQUE (organizationId, customerId) WHERE status = 'ACTIVE'`), the same "DB enforces the invariant, not caller discipline" pattern used for loyalty idempotency (§8) and booking races above. `server/membership/MembershipService.ts` is the sole entry point for activating a membership; attempting to activate a second one while one is already active fails the constraint and surfaces as a clear "customer already has an active membership" error rather than silently succeeding or double-activating. Expired/canceled `CustomerMembership` rows are never deleted — they remain for history and reporting.

A plan's `allowedServices` / `allowedBranches` (empty = unrestricted, applies everywhere) narrow which `Service`/`Branch` combinations get its benefits (discount, loyalty bonus, self-booking eligibility, booking quota). Precedence for self-booking is strictly narrowing, never widening: effective self-booking eligibility = `Organization.customerSelfBookingEnabled` AND `Service.customerBookingEnabled` AND (customer has no active membership OR their plan's `allowsSelfBooking` is true) — a plan can take away self-booking for a customer it applies to, but a plan can never turn self-booking on for a club/service that has it switched off. `bookingPriorityWeight` is captured on `MembershipPlan` now (architecture-ready) but nothing reads it yet — it exists so a future waitlist/priority-access feature doesn't require a schema change, not because Phase 0 implements prioritization.

**Cancellation & rescheduling.** `Service.cancellationAllowed` / `cancellationCutoffMinutes` and `reschedulingAllowed` / `reschedulingCutoffMinutes` define the policy — shown to the customer before they confirm a booking, and enforced server-side when they later try to cancel/reschedule (`now < session.startsAt - cutoffMinutes`). Rescheduling updates the existing `Booking`'s `ridingSessionId` (creating a new `RidingSession` for `DYNAMIC` services) rather than creating a new booking row; the change is recorded in `AuditLog`.

**Customer isolation.** Customer-facing booking Server Actions add a third isolation layer on top of platform and tenant isolation: every read/write is additionally scoped to `booking.customerId === session.customerId`. A customer can never fetch, cancel, or reschedule another customer's booking, even within the same organization.

**Staff parity, not a second code path.** Staff creating or modifying a booking on a customer's behalf (e.g. a phone booking) call the same `AvailabilityService` and `BookingService` as the portal — there is no looser staff-side path that could create an actually-unavailable booking. Staff simply aren't restricted by `customerBookingEnabled` or the customer's own booking limits.

**Payment sequencing.** "Payment if required" pulls a narrow slice of billing capability — one-off charges via `PaymentProvider.createOneOffCharge` — forward into the booking phase; broader payment reporting/reconciliation stays in its own later phase. See §15.

## 11. Customer Portal

Path: `/[orgSlug]/portal/...`, fully separate layout from the staff dashboard, mobile-first. Ships with real (not placeholder) screens for:

- Book a Ride (self-service booking flow, §10, when enabled for the club/service)
- Upcoming bookings, booking history
- Reschedule / cancel a booking (when the service's policy allows it) and view the applicable cancellation/rescheduling rules up front
- Riding sessions (past)
- Loyalty balance and full transaction history
- Rewards catalog and redemption
- Membership (their `CustomerMembership`, if the club offers plans)
- Notifications
- Personal QR code

## 12. Data Model

**Enums:** `UserType(SUPER_ADMIN, STAFF, CUSTOMER)` · `SubscriptionStatus(INCOMPLETE, ACTIVE, PAST_DUE, CANCELED, UNPAID)` · `SchedulingType(FIXED_SESSION, DYNAMIC)` · `BookingStatus(PENDING, CONFIRMED, CANCELED, COMPLETED, NO_SHOW)` · `BookingCreatedVia(STAFF, CUSTOMER_SELF_SERVICE)` · `RidingSessionStatus(SCHEDULED, IN_PROGRESS, COMPLETED, CANCELED)` · `CheckInMethod(QR_SCAN, MANUAL)` · `LoyaltyTransactionType(EARN, REDEEM, ADJUSTMENT, EXPIRATION)` · `BlockedTimeScope(BRANCH, TRAINER, HORSE)` · `MembershipPeriod(WEEKLY, MONTHLY, ANNUAL)` · `CustomerMembershipStatus(ACTIVE, CANCELED, EXPIRED)` · `NotificationChannel(EMAIL, SMS, IN_APP)` · `PaymentStatus(PENDING, SUCCEEDED, FAILED, REFUNDED)`.

**Platform-level** (no `organizationId`):
- `User` — id, email (unique), passwordHash, type, name, phone, timestamps
- `Organization` — id, name, slug (unique), status (independent of billing — Super Admin can suspend regardless of `Subscription.status`), `customerSelfBookingEnabled` (boolean, default false), settings (JSON: branding, loyalty rules)
- `Branch` — id, organizationId, name, address, timezone, `operatingHours` (JSON, per weekday open/close ranges)
- `Subscription` — id, organizationId (unique), provider, providerCustomerId, providerSubscriptionId, planId, status, currentPeriodEnd
- `AuditLog` — id, organizationId (nullable), actorUserId, action, entityType, entityId, metadata (JSON), createdAt

**Tenant-scoped** (`organizationId` + RLS):
- `Membership` — id, userId, organizationId, branchId (nullable), roleId, invitedAt, acceptedAt — unique(userId, organizationId)
- `Role` — id, organizationId (nullable for the platform `SUPER_ADMIN` role), name, isSystemRole
- `Permission` — id, key (unique), description
- `RolePermission` — roleId, permissionId
- `Customer` — id, organizationId, userId, qrToken (unique), firstName, lastName, phone, notes — unique(organizationId, userId)
- `Staff` — id, organizationId, branchId, userId, title, employmentStart
- `Trainer` — id, staffId (unique), bio, specialties (string[]), certifications (string[])
- `Horse` — id, organizationId, branchId, name, breed, dob, notes, photoUrl, status
- `Service` — id, organizationId, name, description, durationMinutes, capacity, price, currency, `customerBookingEnabled` (boolean, default false), schedulingType, requiresTrainer, trainerSelectable, requiresHorse, horseSelectable, requiresPaymentAtBooking, maxBookingsPerCustomerPerWeek (nullable), cancellationAllowed, cancellationCutoffMinutes (nullable), reschedulingAllowed, reschedulingCutoffMinutes (nullable), isActive
- `BlockedTime` — id, organizationId, scope, branchId/trainerId/horseId (nullable, per scope), startsAt, endsAt, reason
- `RidingSession` — id, organizationId, branchId, serviceId, trainerId (nullable), horseId (nullable), startsAt, endsAt, capacity, status
- `Booking` — id, organizationId, customerId, ridingSessionId, status, createdVia, paymentId (nullable), customerMembershipId (nullable — the active membership a benefit/quota was applied under, if any; usage/remaining-sessions is derived by counting non-canceled `Booking`s against this field rather than a separately incremented counter, same ledger-over-counter approach as loyalty)
- `CheckIn` — id, organizationId, bookingId (unique), method, checkedInAt, checkedInByStaffId
- `MembershipPlan` — id, organizationId, name, description, price, durationValue, durationUnit (`MembershipPeriod`), maxSessions (nullable — null means unlimited), discountPercentage (nullable), loyaltyBonusMultiplier (nullable, default 1.0), allowsSelfBooking (boolean, default true), bookingPriorityWeight (int, default 0 — architecture-ready, unread by any Phase 0 logic), isActive — a plan the *club* sells to *its customers* (distinct from platform `Subscription` and staff `Membership`, see §3 naming note)
- `MembershipPlanService` — membershipPlanId, serviceId (join table; no rows for a plan = unrestricted, applies to all services)
- `MembershipPlanBranch` — membershipPlanId, branchId (join table; no rows for a plan = unrestricted, applies to all branches)
- `CustomerMembership` — id, organizationId, customerId, membershipPlanId, startDate, endDate (derived from plan duration at activation), status, paymentId (nullable), createdAt, updatedAt — unique partial index on `(organizationId, customerId) WHERE status = 'ACTIVE'` (see §10)
- `LoyaltyAccount` — id, organizationId, customerId (unique), balance
- `LoyaltyTransaction` — id, organizationId, loyaltyAccountId, type, points, sourceType, sourceId — unique(organizationId, sourceType, sourceId) where sourceId is not null
- `Reward` — id, organizationId, name, description, pointsCost, isActive
- `RewardRedemption` — id, organizationId, customerId, rewardId, loyaltyTransactionId, status
- `Payment` — id, organizationId, customerId (nullable), bookingId (nullable), amount, currency, status, method — the club's own revenue record (e.g. a customer paying for a booking), distinct from the platform `Subscription`
- `Notification` — id, organizationId, recipientUserId (nullable), channel, type, payload (JSON), status, sentAt

Not built yet, deliberately: a custom-role builder, branch-level permission enforcement in UI, background job scheduler, email/SMS provider integration, `MembershipPlan` management UI (schema exists from Phase 0; staff-facing CRUD is a later phase).

## 13. Folder Structure

```
/EquestrianLoop
  /prisma                          # schema.prisma + migrations
  /src
    /app
      /(marketing)                 # landing, pricing (paid-only)
      /(auth)                      # staff + customer sign-in, forgot-password
      /admin                       # Super Admin (platform-level)
        /organizations /subscriptions /analytics
      /[orgSlug]
        /(dashboard)               # staff app
          /customers /horses /trainers /staff /services /bookings
          /sessions /check-ins /loyalty /rewards /payments
          /notifications /reports /settings
        /portal                    # customer portal (separate layout, mobile-first)
          /book                    # self-service booking flow
          /bookings /sessions /loyalty /rewards
          /membership /notifications /qr-code /profile
      /api/webhooks/[provider]
      /api/auth/[...nextauth]
    /components/ui                 # shadcn primitives
    /components/shared             # data-table, page-header, stat-card, empty-state
    /features/<domain>             # per-domain components/hooks/schemas
    /server
      /actions/<domain>
      /auth                        # requirePermission(), requireCustomer(), getSession()
      /tenant                      # tenant resolution + RLS context
      /billing                     # PaymentProvider + BillingService
      /storage                     # StorageProvider + StorageService
      /loyalty                     # LoyaltyService
      /checkin                     # CheckInService
      /availability                # AvailabilityService — getAvailableSlots(), shared by portal + staff UI
      /booking                     # BookingService — createBooking(), reschedule(), cancel()
      /membership                  # MembershipService — activateMembership(), enforces one-active-per-customer
    /db                            # Prisma client singleton, tenant-scoped query helpers
    /lib  /types  /hooks
    /config                        # site.ts, plans.ts, permissions.ts
  /public
  /docs/superpowers/specs
```

## 14. UI/UX Direction

Premium commercial SaaS, not a generic admin template. shadcn/ui (`new-york` style), Tailwind v4, Recharts (via shadcn chart components), Lucide icons. Palette: deep forest/saddle-brown/cream rather than default blue; no heavy gradients. Strong typographic hierarchy, generous spacing, refined cards, subtle motion via Tailwind transitions (not a heavy animation library).

UI is part of the definition of done for every phase — foundation-phase screens (auth, empty dashboard states, landing page) ship fully styled, not as unstyled scaffolding. Three experiences get special performance/UX attention in their respective phases:

- **Reception/check-in** — tablet/mobile-optimized, minimal taps from QR scan to confirmed check-in.
- **Customer portal, including booking** — mobile-first throughout; the booking flow (service → slot → review → confirm) is the portal's centerpiece and must feel as fast and polished as a modern consumer booking app, not a ported admin form.
- **Booking calendar (staff side)** — dense, fast, tablet-usable for front-desk use.

## 15. Development Phases

- **Phase 0 (this spec)** — scaffold; full schema including `Service`/`BlockedTime`/`MembershipPlan`/`CustomerMembership` (defined now even though their engines/UI land later, to avoid painful migrations); staff + customer auth; tenant + customer isolation; RLS; RBAC core; billing abstraction (Stripe as first provider) with subscription gating; storage abstraction; landing page; Super Admin shell; styled empty dashboard + portal shells.
- **Phase 1** — Org onboarding + subscription activation flow end-to-end.
- **Phase 2** — Customer CRM, Horse profiles, Trainers, Staff; Service catalog CRUD (staff-side, including the `customerBookingEnabled` toggle); customer portal profile/notifications screens.
- **Phase 3** — `AvailabilityService` + staff-side booking calendar (staff create/reschedule/cancel bookings for customers) + Reception/check-in (QR scan flow).
- **Phase 4** — Self-service customer booking end-to-end (portal booking flow, §10), including one-off payment collection at booking time — built on Phase 3's availability engine, gated by `customerSelfBookingEnabled` / `Service.customerBookingEnabled`.
- **Phase 5** — Loyalty engine (idempotent award service) + Loyalty dashboard + Rewards + redemption, wired into the portal.
- **Phase 6** — Broader club-facing Payments (reporting/reconciliation) + Notifications provider integration (email/SMS).
- **Phase 7** — Reports & Analytics.
- **Phase 8** — Audit log UI, branch-level permission enforcement, custom roles, `MembershipPlan` management UI, responsive/motion polish pass.

## 16. Technical Risks

- Tenant data leakage — mitigated by two independent layers (app-level filter + RLS).
- Duplicate loyalty point awards — mitigated by DB-level unique constraint, not caller discipline (§8).
- Double-booking / race conditions on shared resources (trainer, horse, a private `DYNAMIC` slot) — mitigated by transactional re-validation plus a DB-level exclusion constraint, not just a UI-level slot list (§10).
- Billing/storage provider lock-in — mitigated by the interface boundary (§6, §7); a second provider is an implementation, not a rewrite.
- Booking-limit / membership-restriction logic complexity — kept intentionally minimal in foundation (counted from `Booking` rows, no separate usage ledger); revisit if real usage patterns need more nuance.
- RBAC scope creep if the custom-role UI gets pulled forward before it's needed.
- Path→subdomain routing migration, if done later — low risk, middleware-only.
- Timezone/DST correctness for bookings and operating hours across branches in different timezones.
- Background jobs (reminders, scheduled loyalty runs) need a scheduler (Inngest or trigger.dev) — not decided, not needed until Phase 6.

## 17. Assumptions & Open Questions (flagged, not blocking)

- One active `Subscription` per organization (no multi-plan/add-on platform billing) for foundation.
- One `Role` per user per organization; branch-level scoping modeled but not enforced until Phase 8.
- Only one active `CustomerMembership` per customer, enforced by a DB partial unique index — a deliberate MVP limitation (confirmed), not an oversight; historical/expired memberships are retained, never deleted.
- `MembershipPlan` management UI is Phase 8, though its schema (including `allowedServices`/`allowedBranches`/`bookingPriorityWeight`) exists from Phase 0.
- The exact DB mechanism for closing booking race conditions (Postgres `EXCLUDE USING gist` on a range type vs. transactional row-locking) is an implementation-time decision, not fixed here.
- Email/SMS provider for invites and notifications not yet chosen (candidate: Resend for email).
- Background job scheduler not yet chosen (candidate: Inngest or trigger.dev).
