# EquestrianLoop

A modern multi-tenant equestrian facility management platform built with Next.js, TypeScript, and PostgreSQL.

## Features

- **Multi-Tenant Architecture**: Separate organizations, staff, and customers
- **Authentication**: NextAuth v5 with JWT
- **Booking Management**: Staff scheduling and customer self-service
- **Membership & Loyalty**: Plans, subscriptions, and reward tracking
- **Payment Processing**: Stripe integration
- **Email Notifications**: Resend for transactional emails
- **Audit Logging**: Full action tracking with organization isolation
- **Rate Limiting**: Brute-force protection on auth endpoints
- **Email Verification**: Mandatory account verification
- **Password Reset**: Secure token-based password recovery

## Tech Stack

- **Framework**: Next.js 16 with App Router
- **Language**: TypeScript (strict mode)
- **Database**: PostgreSQL with Supabase + Row-Level Security
- **ORM**: Prisma v7.10.0
- **Auth**: NextAuth.js v5
- **UI**: shadcn/ui + Tailwind CSS
- **Testing**: Vitest
- **Deployment**: Vercel
- **Payments**: Stripe
- **Email**: Resend
- **Rate Limiting**: Upstash Redis (or in-memory fallback)
- **Error Tracking**: Sentry (optional)

## Getting Started

### Prerequisites

- Node.js 20+
- npm 10+
- PostgreSQL database (Supabase recommended)

### Local Development

1. **Clone and install**:
   ```bash
   git clone <repository>
   cd phase-0-foundation
   npm ci
   ```

2. **Configure environment**:
   ```bash
   cp .env.example .env
   # Edit .env with your local values
   ```

3. **Set up database**:
   ```bash
   npx prisma migrate dev
   npx prisma db seed
   ```

4. **Start dev server**:
   ```bash
   npm run dev
   ```

   Open [http://localhost:3000](http://localhost:3000)

5. **Run tests**:
   ```bash
   npm test
   ```

### Environment Variables

See `.env.example` for local development and `.env.production.example` for production.

**Required (all environments)**:
- `DATABASE_URL` - PostgreSQL connection string (app_runtime role)
- `DIRECT_URL` - PostgreSQL owner role (for migrations)
- `NEXTAUTH_SECRET` - 32+ character random string for JWT signing
- `NEXTAUTH_URL` - Application URL (http://localhost:3000 for dev)
- `STRIPE_SECRET_KEY` - Stripe API key
- `STRIPE_WEBHOOK_SECRET` - Stripe webhook signing key
- `RESEND_API_KEY` - Resend email API key
- `EMAIL_FROM` - From address for transactional emails

**Optional**:
- `UPSTASH_REDIS_REST_URL`, `UPSTASH_REDIS_REST_TOKEN` - For distributed rate limiting
- `SENTRY_DSN` - For error tracking and monitoring

## Development

### Project Structure

```
src/
├── app/               # Next.js App Router pages
├── components/        # Reusable React components
├── server/
│   ├── actions/       # Server actions (mutations)
│   ├── auth/          # Authentication logic
│   ├── audit/         # Audit logging
│   ├── rate-limit/    # Rate limiting
│   └── tenant/        # Multi-tenant context
├── db/               # Database access layer (with RLS)
└── lib/              # Utilities

prisma/
├── schema.prisma     # Database schema
└── migrations/       # Schema migrations

tests/
├── server/           # Server action tests
└── db/               # Database tests
```

### Key Principles

1. **TDD First**: Write failing tests before implementation
2. **Type Safety**: TypeScript strict mode enforced
3. **Security**: RLS policies, rate limiting, input validation
4. **Multi-Tenancy**: All queries scoped to organization
5. **Fire-and-Forget**: Audit logging and emails never block operations

### Common Tasks

**Run tests**:
```bash
npm test
```

**TypeScript check**:
```bash
npx tsc --noEmit
```

**Build for production**:
```bash
npm run build
```

**Lint**:
```bash
npm run lint
```

**Create database migration**:
```bash
npx prisma migrate dev --name description_here
```

## Deployment

### To Vercel

1. **Connect GitHub repository** to Vercel
2. **Add environment variables** in Vercel dashboard (see `.env.production.example`)
3. **Enable GitHub integration** for CI/CD
4. **Push to main** to trigger automatic deployment

### Required GitHub Secrets

For CI/CD and automatic deployment:

- `VERCEL_TOKEN` - Vercel deployment token
- `VERCEL_ORG_ID` - Your Vercel organization ID
- `VERCEL_PROJECT_ID` - Your Vercel project ID
- `VERCEL_DOMAIN` - Your production domain (for smoke tests)
- `SLACK_WEBHOOK` (optional) - Slack notifications

### Generate Tokens

**Vercel Token**:
1. Go to [vercel.com/account/tokens](https://vercel.com/account/tokens)
2. Create a new token with access to your project
3. Add to GitHub as `VERCEL_TOKEN`

### Production Checklist

See `.superpowers/docs/launch-checklist.md` for complete pre-launch checklist.

### Monitoring

- **Health Check**: `GET /api/health` - Returns status and timestamp
- **Error Tracking**: Sentry integration (if configured)
- **Logs**: Vercel dashboard and function logs

## Database

### Architecture

- **PostgreSQL** on Supabase with RLS enabled
- **Row-Level Security** enforces tenant isolation at database level
- **Connection pooling** via Supabase pgBouncer (transaction mode)
- **Prisma ORM** with relation guards in src/db/client.ts

### Migrations

Migrations are created with:
```bash
npx prisma migrate dev --name description
```

All migrations are stored in `prisma/migrations/` and tracked in git.

### Testing

Tests use the raw PostgreSQL role (for isolation) but production uses app_runtime role (with RLS).

## Security

### Authentication
- **NextAuth.js v5** with Credentials provider
- **JWT tokens** signed with NEXTAUTH_SECRET
- **Session validation** on every request

### Data Security
- **Row-Level Security** policies at database level
- **Tenant context** enforced via withTenantContext()
- **No relation traversal** across tenant boundaries
- **Input validation** on all server actions

### API Security
- **HTTPS only** in production (HSTS header)
- **CSP headers** to prevent injection attacks
- **Rate limiting** on auth endpoints
- **CSRF protection** via Next.js built-in

### Secrets
- **NEXTAUTH_SECRET** must be 32+ characters
- **Database passwords** never committed to git
- **API keys** stored as environment variables only
- **.env files** added to .gitignore

## Performance

- **Edge caching** for public static assets
- **Database indexing** on common query patterns
- **Connection pooling** for database efficiency
- **Image optimization** via Next.js Image component

## Troubleshooting

### Database Connection Issues

If you see `ENOTFOUND` errors:
1. Verify DATABASE_URL is correct
2. Check Supabase network access settings
3. Ensure IP allowlist includes your location

### Auth Failures

If login isn't working:
1. Verify NEXTAUTH_SECRET is set
2. Check NEXTAUTH_URL matches your domain
3. Verify user credentials in database

### Tests Failing

If tests fail:
1. Ensure PostgreSQL is running
2. Check .env.test is set correctly
3. Run `npx prisma migrate dev` to sync schema
4. Try `npm test -- --reporter=verbose` for details

## Contributing

This is a reference implementation. For changes:

1. Create a feature branch from main
2. Make changes following TDD principles
3. Ensure `npm test` and `npm run build` pass
4. Submit pull request with description

## License

Private repository.

## Support

For issues, check:
- [.superpowers/](docs/.superpowers/) - Implementation notes
- Commit messages - Implementation details
- Test files - Behavior examples
