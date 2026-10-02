# Production Launch Checklist

**Last Updated:** 2026-10-02  
**Status:** Ready for Phase 3 launch preparation

Complete all items below before deploying EquestrianLoop to production.

## Pre-Launch (Before First Deploy)

### Security & Secrets

- [ ] Generate strong NEXTAUTH_SECRET (minimum 32 random characters)
  - Command: `openssl rand -base64 32`
  - Store in Vercel "Environment Variables" (not in git)
  
- [ ] Verify NEXTAUTH_URL matches your production domain (HTTPS required)
  - Example: `https://equestrianloop.com`
  - Not `http://localhost:3000`

- [ ] Set all Stripe credentials
  - [ ] STRIPE_SECRET_KEY (starts with `sk_live_*` in production)
  - [ ] STRIPE_PUBLISHABLE_KEY (starts with `pk_live_*` in production)
  - [ ] STRIPE_WEBHOOK_SECRET (from Webhook endpoints)

- [ ] Verify Resend API key and domain
  - [ ] RESEND_API_KEY set in Vercel
  - [ ] EMAIL_FROM domain verified in Resend dashboard
  - [ ] Resend sending quota sufficient

- [ ] Database credentials are secure
  - [ ] DATABASE_URL uses app_runtime role (NOT postgres superuser)
  - [ ] DIRECT_URL uses postgres role (for migrations only)
  - [ ] Both credentials differ from local development

### Database Setup

- [ ] Supabase organization configured
  - [ ] PostgreSQL version 14+ confirmed
  - [ ] Connection pooling enabled (pgBouncer, transaction mode)
  - [ ] Network access configured (IP whitelist if needed)

- [ ] Row-Level Security verified
  - [ ] All RLS policies in place
  - [ ] Set app_runtime role to NOBYPASSRLS
  - [ ] Verify with: `SELECT * FROM information_schema.enabled_roles;`

- [ ] Database backups enabled
  - [ ] Automated daily backups enabled
  - [ ] Backup retention: minimum 7 days
  - [ ] Test restore procedure

- [ ] All migrations applied
  - Run locally: `npx prisma migrate deploy`
  - Verify schema matches with: `npx prisma db pull`

- [ ] Production database seeded (if needed)
  - [ ] Permission records created
  - [ ] Test organization created (for QA)

### Application Configuration

- [ ] All environment variables set in Vercel
  - [ ] No missing required variables
  - [ ] No development values in production
  - Verify: Run `npm run prestart` locally with Vercel env

- [ ] Vercel project configured
  - [ ] Custom domain configured
  - [ ] SSL certificate enabled (auto via Vercel)
  - [ ] Environment: `production`

- [ ] Security headers verified in next.config.ts
  - [ ] CSP headers configured
  - [ ] HSTS enabled (Strict-Transport-Security)
  - [ ] X-Frame-Options: DENY
  - [ ] X-Content-Type-Options: nosniff
  - Run: `curl -I https://your-domain.com`

- [ ] TypeScript and build verified
  - [ ] `npx tsc --noEmit` passes
  - [ ] `npm run build` succeeds locally
  - [ ] No TypeScript warnings

### External Services

- [ ] Stripe webhook configured
  - [ ] Webhook URL: `https://your-domain.com/api/webhooks/stripe`
  - [ ] Events subscribed: `charge.succeeded`, `charge.failed`, `invoice.payment_succeeded`
  - [ ] Signing secret stored in STRIPE_WEBHOOK_SECRET
  - [ ] Test webhook: use Stripe CLI or test endpoint

- [ ] Resend email service tested
  - [ ] Send test email from your domain
  - [ ] Verify delivery
  - [ ] Check DKIM/SPF records if needed

- [ ] Sentry configured (if error tracking needed)
  - [ ] SENTRY_DSN set in Vercel
  - [ ] Test error: trigger an error and verify in Sentry dashboard
  - [ ] Performance monitoring configured

- [ ] Rate limiting configured (optional)
  - [ ] If using Upstash Redis:
    - [ ] UPSTASH_REDIS_REST_URL set
    - [ ] UPSTASH_REDIS_REST_TOKEN set
  - [ ] If using in-memory: acceptable for single-instance deployments

### Code Quality

- [ ] All tests pass
  - [ ] Run: `npm test`
  - [ ] Target: 196+ passing tests

- [ ] No console.log statements with sensitive data
  - Grep: `grep -r "console\." src/ | grep -i "password\|secret\|token\|key"`
  - Should be empty

- [ ] No hardcoded credentials in code
  - Grep: `grep -r "sk_\|pk_\|api_" src/`
  - Should only find imports/example comments

- [ ] Linting passes
  - [ ] Run: `npm run lint`
  - [ ] Fix all errors before deploy

### Testing

- [ ] Manual QA checklist
  - [ ] Customer sign-up flow works end-to-end
  - [ ] Email verification emails deliver
  - [ ] Password reset flow works
  - [ ] Stripe payment flow processes
  - [ ] Rate limiting triggers appropriately
  - [ ] Audit logging captures actions

- [ ] Monitor startup
  - [ ] Application starts without errors
  - [ ] Health endpoint responds: `GET /api/health`
  - [ ] Database connection successful

### Documentation

- [ ] README.md up to date
  - [ ] Deployment instructions included
  - [ ] Environment variable list complete
  - [ ] Troubleshooting guide included

- [ ] Team documentation complete
  - [ ] GitHub secrets documented
  - [ ] Monitoring dashboard links shared
  - [ ] On-call procedures documented
  - [ ] Runbook for common issues

## Launch Day

### Pre-Launch Verification (30 mins before)

- [ ] Staging deployment successful
  - [ ] All checks passed on staging domain
  - [ ] No errors in logs

- [ ] Final database backup
  - [ ] Backup taken
  - [ ] Backup verified restorable

- [ ] Notify team
  - [ ] Slack message posted
  - [ ] On-call engineer alerted
  - [ ] Rollback plan reviewed

### Deployment

- [ ] Push to main branch
  - [ ] GitHub Actions CI passes
  - [ ] All checks green

- [ ] Monitor deployment
  - [ ] Vercel build succeeds
  - [ ] No Sentry error spikes
  - [ ] Application health endpoint responds

- [ ] Smoke tests
  - [ ] Health endpoint: `GET https://your-domain.com/api/health`
  - [ ] Root path loads: `GET https://your-domain.com`
  - [ ] No 500 errors in Vercel logs

### Post-Launch (First hour)

- [ ] Monitor metrics
  - [ ] Error rate normal
  - [ ] Response times normal
  - [ ] No pending errors in Sentry

- [ ] Verify critical features
  - [ ] Sign-in works
  - [ ] Email sends (test verification email)
  - [ ] Database queries respond quickly

- [ ] Check logs
  - [ ] No "database connection failed" errors
  - [ ] No "missing environment variable" errors
  - [ ] No authentication errors

- [ ] Communicate status
  - [ ] Post success message to team
  - [ ] Update status page if applicable

## Ongoing Monitoring

### Daily

- [ ] Check error rate in Sentry
- [ ] Verify database health
- [ ] Monitor API response times

### Weekly

- [ ] Review audit logs for anomalies
- [ ] Check rate limit metrics
- [ ] Verify email delivery rates

### Monthly

- [ ] Database backup verification
- [ ] Security update checks
- [ ] Performance analysis

## Rollback Plan

If critical issues occur after launch:

1. **Immediate (within 5 minutes)**
   - Kill Vercel deployment or revert commit
   - Notify team in Slack
   - Begin investigation

2. **Short-term (within 30 minutes)**
   - Identify root cause
   - Decide: hotfix or rollback
   - If rollback: revert to previous commit
   - Verify rollback successful

3. **Post-mortem (within 24 hours)**
   - Document what went wrong
   - Identify prevention measures
   - Update checklists/runbooks

## Troubleshooting Guide

### Application won't start
- Check all env vars set in Vercel
- Run `npm run prestart` locally to validate
- Check DATABASE_URL format is correct
- Verify Supabase connection accessible from Vercel region

### Database connection fails
- Verify DATABASE_URL is correct (app_runtime role)
- Check Supabase network access settings
- Verify connection pooler settings (transaction mode)
- Test connection locally: `psql $DATABASE_URL -c "SELECT 1"`

### Auth isn't working
- Verify NEXTAUTH_SECRET set (32+ chars)
- Verify NEXTAUTH_URL matches domain (https required)
- Check cookie domain in NextAuth config
- Clear browser cookies and try again

### Emails not sending
- Verify RESEND_API_KEY set
- Verify EMAIL_FROM domain verified in Resend
- Check Resend dashboard for delivery logs
- Test with: `curl -X POST https://api.resend.com/emails -H "Authorization: Bearer $RESEND_API_KEY"`

### Stripe webhooks not received
- Verify webhook URL in Stripe dashboard
- Verify STRIPE_WEBHOOK_SECRET matches Stripe dashboard
- Test with Stripe CLI: `stripe listen --forward-to your-domain.com/api/webhooks/stripe`
- Check Vercel function logs for webhook requests

## Success Criteria

✅ Launch is successful when:

- All checks on this list completed
- Application loads without errors
- Health endpoint responds with 200 OK
- No critical errors in Sentry (within first hour)
- All required env vars set
- Database connection stable
- Email delivery confirmed
- Team confirms no critical issues

## Additional Resources

- [Next.js Deployment Guide](https://nextjs.org/docs/deployment)
- [Vercel Docs](https://vercel.com/docs)
- [Supabase RLS Guide](https://supabase.com/docs/guides/auth/row-level-security)
- [Stripe Webhook Guide](https://stripe.com/docs/webhooks)
- [Resend Documentation](https://resend.com/docs)

---

**Remember:** Production is not the place to experiment. Verify everything locally first, then follow this checklist precisely.
