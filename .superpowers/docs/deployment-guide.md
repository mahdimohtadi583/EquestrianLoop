# Phase 0 Deployment Guide

**Status:** Ready for production deployment  
**Environments:** Development, Staging, Production  

## Environment Variables Checklist

### Required (Must Set in Production)

| Variable | Purpose | Format | Notes |
|----------|---------|--------|-------|
| `DATABASE_URL` | App runtime DB connection | `postgresql://app_runtime.<ref>:pass@host:6543/postgres?pgbouncer=true` | Must use restricted role (not postgres superuser) |
| `DIRECT_URL` | Schema migration DB connection | `postgresql://postgres.<ref>:pass@host:5432/postgres` | Used only for `prisma migrate` and `prisma db seed` |
| `NEXTAUTH_SECRET` | JWT signing key | Cryptographically random string (32+ chars) | Generate with: `openssl rand -base64 32` |
| `STRIPE_SECRET_KEY` | Stripe API key | `sk_live_...` | Live key for production, test key for dev |
| `STRIPE_WEBHOOK_SECRET` | Stripe webhook verification | `whsec_...` | From Stripe Dashboard webhooks settings |

### Optional (Development Only)

| Variable | Purpose | Default |
|----------|---------|---------|
| `NEXTAUTH_URL` | NextAuth callback URL | `http://localhost:3000` |
| `SUPABASE_URL` | Supabase project URL | Optional (not used in Phase 0) |
| `SUPABASE_SERVICE_ROLE_KEY` | Supabase service key | Optional (not used in Phase 0) |

### Development Setup

1. Copy `.env.example` to `.env`
2. Generate `NEXTAUTH_SECRET`: `openssl rand -base64 32`
3. Add Stripe test keys from Stripe Dashboard
4. Set `DATABASE_URL` and `DIRECT_URL` to local/test Supabase project
5. Set `NEXTAUTH_URL=http://localhost:3000`

### Production Setup

1. Generate new `NEXTAUTH_SECRET`: `openssl rand -base64 32`
2. Use Stripe **live** keys (not test)
3. Use Supabase **production** project
4. Ensure `DATABASE_URL` uses **restricted `app_runtime` role** (not `postgres`)
5. Ensure `DIRECT_URL` uses **owner `postgres` role** but only for migrations
6. Set `NEXTAUTH_URL` to your domain: `https://yourdomain.com`

## Supabase Production Configuration

### Database Role Setup

**CRITICAL:** Use restricted role for application runtime

```sql
-- Create restricted app_runtime role (if not exists)
CREATE ROLE app_runtime WITH LOGIN PASSWORD 'strong_password';
ALTER ROLE app_runtime NOSUPERUSER NOBYPASSRLS NOCREATEDB NOREPLICATOR;

-- Grant minimal privileges
GRANT USAGE ON SCHEMA public TO app_runtime;
GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO app_runtime;
GRANT USAGE ON ALL SEQUENCES IN SCHEMA public TO app_runtime;

-- Disable specific dangerous privileges
REVOKE TRUNCATE ON ALL TABLES IN SCHEMA public FROM app_runtime;
REVOKE REFERENCES ON ALL TABLES IN SCHEMA public FROM app_runtime;
```

### RLS Policies

All tables have RLS policies requiring `current_setting('tenant.organization_id')`. Verify:

```sql
SELECT * FROM pg_policies 
WHERE polname ILIKE '%tenant%';
```

Should show policies for: `customer`, `staff`, `booking`, `horse`, etc.

### Connection Pooling

- **Development:** Use unpooled endpoint (port 5432) for migrations
- **Production:** Use pooled endpoint (port 6543, transaction mode) for app runtime
- Both should use different roles: `postgres` (owner) vs `app_runtime` (restricted)

## Stripe Configuration

### Webhook Setup

1. Go to Stripe Dashboard → Developers → Webhooks
2. Add endpoint: `https://yourdomain.com/api/webhooks/stripe`
3. Select events:
   - `checkout.session.completed`
   - `invoice.payment_succeeded`
   - `invoice.payment_failed`
   - `customer.subscription.deleted`
4. Copy signing secret → `STRIPE_WEBHOOK_SECRET`

### API Keys

1. Get **Publishable Key** from Dashboard (use in frontend, if needed)
2. Get **Secret Key** from Dashboard → `STRIPE_SECRET_KEY`
3. For production: use Live keys (not Test)

## Deployment Checklist

### Pre-Deployment (Dev/Staging)

- [ ] All tests passing: `npm test` → 188 tests pass
- [ ] TypeScript clean: `npx tsc --noEmit` → 0 errors
- [ ] Build passes: `npm run build` → ✅
- [ ] Security audit passed (check `.superpowers/docs/security-audit-phase-0.md`)
- [ ] Middleware protecting all routes
- [ ] All server actions have role guards
- [ ] No direct prisma imports in pages

### Environment Setup

- [ ] `DATABASE_URL` set (test/staging DB)
- [ ] `DIRECT_URL` set (migration role)
- [ ] `NEXTAUTH_SECRET` generated and set
- [ ] Stripe test keys configured and set
- [ ] All `.env` vars loaded without errors

### Database Verification

- [ ] Migrations run successfully: `npx prisma migrate deploy`
- [ ] Seed data loaded (optional): `npx prisma db seed`
- [ ] RLS policies active: `SELECT * FROM pg_policies`
- [ ] App role has correct permissions

### Application Testing

- [ ] Homepage loads: `http://localhost:3000`
- [ ] Staff signup/login works
- [ ] Customer signup/login works
- [ ] Staff dashboard accessible
- [ ] Customer portal accessible
- [ ] Stripe webhook receives events (manual test)

### Production Deployment (Vercel)

1. **Set environment variables** in Vercel Dashboard
   - `DATABASE_URL` (use production Supabase)
   - `DIRECT_URL` (production owner role)
   - `NEXTAUTH_SECRET` (generate new)
   - `NEXTAUTH_URL=https://yourdomain.com`
   - `STRIPE_SECRET_KEY` (live key)
   - `STRIPE_WEBHOOK_SECRET` (live webhook secret)

2. **Deploy branch** to production

3. **Run post-deployment checks**
   ```bash
   npx prisma migrate deploy  # On deployment, if needed
   npm run build              # Build verification
   npm test                   # Sanity check
   ```

4. **Verify in production**
   - Homepage loads
   - Sign-in redirects work
   - Stripe webhooks configured and sending

## Monitoring & Maintenance

### Health Checks

- Monitor auth failures: Check `NEXTAUTH_SECRET` rotation schedule
- Monitor database: Verify connection pool health
- Monitor Stripe webhooks: Check webhook delivery success rate
- Monitor errors: Set up error tracking (Sentry, LogRocket, etc.)

### Backup Strategy

- **Database:** Use Supabase automated backups (daily)
- **Code:** Git repository (already backed up)
- **Secrets:** Use infrastructure secret manager (AWS Secrets, Vercel, etc.)

### Update Strategy

- **Dependencies:** Regular `npm update`, run tests before deploying
- **Database migrations:** Test locally first, then deploy to staging, then prod
- **Stripe updates:** New webhook events added when moving to Phase 1

## Rollback Procedure

1. **Application:** Deploy previous commit with `vercel rollback`
2. **Database:** Use Supabase backup to restore (point-in-time recovery)
3. **Stripe:** Webhooks will still hit old endpoint; monitor for events
4. **Verify:** Run tests and manual checks before declaring recovery complete

## Phase 1 Deployment Additions

When Phase 1 launches, add to deployment checklist:

- [ ] Email verification configured (SendGrid/Resend)
- [ ] Rate limiting configured (Vercel edge middleware)
- [ ] Audit logging enabled
- [ ] Password reset flow tested
- [ ] 2FA setup instructions documented

---

**Status:** Phase 0 is production-ready. Use this guide for deployment.
