# EquestrianLoop — Foundation Architecture & Design Spec

**Date:** 2026-09-10
**Status:** Approved for implementation planning
**Scope:** Phase 0 (Foundation) of a multi-phase SaaS build. Later phases are listed for context but are not specified in implementation-ready detail here.

## 1. Product Summary

EquestrianLoop is a paid, multi-tenant SaaS platform for equestrian clubs, horse farms, and riding schools to manage customers, horses, trainers, staff, bookings, riding sessions, check-ins, loyalty, rewards, payments, notifications, and reporting — plus a customer-facing portal and a platform-level Super Admin dashboard.

**Business model:** paid-only. No free plan, no free trial, anywhere in the product. This is enforced structurally, not just by configuration (see §7).

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

## 4. Authentication Strategy

Auth.js (NextAuth) v5, Credentials provider, Prisma adapter, **database sessions** (session state re-derived from the DB on every request, not trusted from a client-held JWT). Passwords hashed with bcrypt.

- **Staff** accounts are created via invite (email + org + role → sets password on first login).
- **Customer** accounts are created either by staff (front-desk enters name/email → invite email to set password) or by customer self-signup against a specific club's public signup link. Both converge on the same `User(type=CUSTOMER)` + `Customer` row creation.

Chosen over Clerk/WorkOS: those give faster org/invite UX out of the box, but bill per-MAU — expensive once a club's full customer roster (not just staff) is in the system — and add an external vendor holding tenant data. Revisit only if invite/session UX becomes a real bottleneck.

## 5. Role & Permission Strategy

Real `Role` / `Permission` / `RolePermission` tables, not hardcoded enums, so custom roles are possible later. Foundation phase seeds fixed defaults only — a custom-role-builder UI is explicitly out of scope for now:

- Per-organization roles: `OWNER`, `ADMIN`, `MANAGER`, `TRAINER`, `FRONT_DESK`.
- Platform role: `SUPER_ADMIN` (no `organizationId`).
- Permission catalog (strings): `customers.manage`, `horses.manage`, `staff.manage`, `bookings.manage`, `sessions.manage`, `checkins.manage`, `loyalty.manage`, `rewards.manage`, `billing.manage`, `reports.view`, `settings.manage`.

Foundation: one role per user per organization (`Membership` unique on `(userId, organizationId)`). Branch-level permission scoping (`Membership.branchId`) is modeled in the schema now but not enforced in UI until a later phase.

## 6. Billing Architecture (provider-agnostic)

Billing is defined as a domain interface, not a Stripe integration:

```
server/billing/PaymentProvider.ts       — interface
server/billing/providers/StripeProvider.ts — first implementation
server/billing/BillingService.ts        — domain service; app code depends on this, never on a provider directly
```

`PaymentProvider` interface (conceptual):

```
createCustomer(org) -> providerCustomerId
createCheckoutSession(org, planId) -> checkoutUrl   // must never configure a trial period
cancelSubscription(providerSubscriptionId) -> void
handleWebhookEvent(rawPayload, signature) -> NormalizedBillingEvent
```

The `Subscription` table itself is provider-agnostic — no Stripe-shaped columns:

- `provider` (string, e.g. `"stripe"`)
- `providerCustomerId`, `providerSubscriptionId` (opaque strings)
- `planId`, `status`, `currentPeriodEnd`

Webhook endpoint is `/api/webhooks/[provider]`, dispatching to the matching `PaymentProvider.handleWebhookEvent`. Adding a second provider later means implementing the interface and registering it — no changes to `BillingService`, the `Subscription` schema, or any UI that reads subscription status.

**No-trial guarantee is structural:** `SubscriptionStatus` has no `TRIALING` value at all (`INCOMPLETE | ACTIVE | PAST_DUE | CANCELED | UNPAID`). It's not "unused," it's unrepresentable. Tenant-app access gating is a single check: `status === 'ACTIVE'`.

## 7. Storage Architecture (provider-agnostic)

Same pattern as billing:

```
server/storage/StorageProvider.ts          — interface: upload(file, path), getUrl(path), delete(path)
server/storage/providers/SupabaseStorageProvider.ts — first implementation
server/storage/StorageService.ts           — what app code (e.g. horse photo upload) actually calls
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

## 10. Customer Portal

Path: `/[orgSlug]/portal/...`, fully separate layout from the staff dashboard, mobile-first. Foundation phase ships the shell + real (not placeholder) screens for: Profile, Upcoming Bookings, Past Sessions, Loyalty Balance, Loyalty Transaction History, Rewards catalog, Reward Redemption, Membership status, Notifications, and the personal QR code. Booking creation/management *by* the customer (self-service booking) is not implied by the brief and is out of scope unless requested — the portal is read/self-manage focused for now (profile edits, viewing, redeeming, notifications), not a booking engine.

## 11. Data Model

Enums: `UserType(SUPER_ADMIN, STAFF, CUSTOMER)` · `SubscriptionStatus(INCOMPLETE, ACTIVE, PAST_DUE, CANCELED, UNPAID)` · `BookingStatus(PENDING, CONFIRMED, CANCELED, COMPLETED, NO_SHOW)` · `RidingSessionStatus(SCHEDULED, IN_PROGRESS, COMPLETED, CANCELED)` · `CheckInMethod(QR_SCAN, MANUAL)` · `LoyaltyTransactionType(EARN, REDEEM, ADJUSTMENT, EXPIRATION)` · `NotificationChannel(EMAIL, SMS, IN_APP)` · `PaymentStatus(PENDING, SUCCEEDED, FAILED, REFUNDED)`.

**Platform-level** (no `organizationId`):
- `User` — id, email (unique), passwordHash, type, name, phone, timestamps
- `Organization` — id, name, slug (unique), status (independent of billing — Super Admin can suspend regardless of `Subscription.status`), settings (JSON: branding, loyalty rules)
- `Branch` — id, organizationId, name, address, timezone
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
- `RidingSession` — id, organizationId, branchId, trainerId (nullable), horseId (nullable), startsAt, endsAt, capacity, status
- `Booking` — id, organizationId, customerId, ridingSessionId, status
- `CheckIn` — id, organizationId, bookingId (unique), method, checkedInAt, checkedInByStaffId
- `LoyaltyAccount` — id, organizationId, customerId (unique), balance
- `LoyaltyTransaction` — id, organizationId, loyaltyAccountId, type, points, sourceType, sourceId — unique(organizationId, sourceType, sourceId) where sourceId is not null
- `Reward` — id, organizationId, name, description, pointsCost, isActive
- `RewardRedemption` — id, organizationId, customerId, rewardId, loyaltyTransactionId, status
- `Payment` — id, organizationId, customerId (nullable), bookingId (nullable), amount, currency, status, method — this is the club's own revenue record (e.g. a customer paying for a session), distinct from the platform `Subscription`
- `Notification` — id, organizationId, recipientUserId (nullable), channel, type, payload (JSON), status, sentAt

Not built yet, deliberately: a custom-role builder, branch-level permission enforcement in UI, background job scheduler, email/SMS provider integration (needed by Phase 5 Notifications — Resend/Twilio not yet chosen).

## 12. Folder Structure

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
          /customers /horses /trainers /staff /bookings
          /sessions /check-ins /loyalty /rewards /payments
          /notifications /reports /settings
        /portal                    # customer portal (separate layout, mobile-first)
          /profile /bookings /sessions /loyalty /rewards
          /membership /notifications /qr-code
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
    /db                            # Prisma client singleton, tenant-scoped query helpers
    /lib  /types  /hooks
    /config                        # site.ts, plans.ts, permissions.ts
  /public
  /docs/superpowers/specs
```

## 13. UI/UX Direction

Premium commercial SaaS, not a generic admin template. shadcn/ui (`new-york` style), Tailwind v4, Recharts (via shadcn chart components), Lucide icons. Palette: deep forest/saddle-brown/cream rather than default blue; no heavy gradients. Strong typographic hierarchy, generous spacing, refined cards, subtle motion via Tailwind transitions (not a heavy animation library).

UI is part of the definition of done for every phase — foundation-phase screens (auth, empty dashboard states, landing page) ship fully styled, not as unstyled scaffolding. Two experiences get special performance/UX attention in their respective phases:

- **Reception/check-in** — tablet/mobile-optimized, minimal taps from QR scan to confirmed check-in.
- **Customer portal** — mobile-first throughout, not a responsive afterthought of the staff dashboard.

## 14. Development Phases

- **Phase 0 (this spec)** — scaffold; schema + migrations; staff + customer auth; tenant isolation + RLS; RBAC core; billing abstraction (Stripe as first provider) with subscription gating; storage abstraction; landing page; Super Admin shell; styled empty dashboard + portal shells.
- **Phase 1** — Org onboarding + subscription activation flow end-to-end.
- **Phase 2** — Customer CRM, Horse profiles, Trainers, Staff; customer portal profile/notifications screens.
- **Phase 3** — Booking calendar, Riding Sessions, Reception/check-in (QR scan flow).
- **Phase 4** — Loyalty engine (idempotent award service) + Loyalty dashboard + Rewards + redemption, wired into the portal.
- **Phase 5** — Club-facing Payments, Notifications (email/SMS provider decision).
- **Phase 6** — Reports & Analytics.
- **Phase 7** — Audit log UI, branch-level permission enforcement, custom roles, responsive/motion polish pass.

## 15. Technical Risks

- Tenant data leakage — mitigated by two independent layers (app-level filter + RLS).
- Duplicate loyalty point awards — mitigated by DB-level unique constraint, not caller discipline (§8).
- Billing/storage provider lock-in — mitigated by the interface boundary (§6, §7); a second provider is an implementation, not a rewrite.
- RBAC scope creep if the custom-role UI gets pulled forward before it's needed.
- Path→subdomain routing migration, if done later — low risk, middleware-only.
- Timezone/DST correctness for bookings across branches in different timezones.
- Background jobs (reminders, scheduled loyalty runs) need a scheduler (Inngest or trigger.dev) — not decided, not needed until Phase 5.

## 16. Assumptions & Open Questions (flagged, not blocking)

- One active `Subscription` per organization (no multi-plan/add-on billing) for foundation.
- One `Role` per user per organization; branch-level scoping modeled but not enforced until Phase 7.
- Customer self-service booking (creating a new booking from the portal) is not in scope unless explicitly requested — portal is view/manage-your-own-data plus redemption, not a booking engine, in this spec.
- Email/SMS provider for invites and notifications not yet chosen (candidate: Resend for email).
- Background job scheduler not yet chosen (candidate: Inngest or trigger.dev).
