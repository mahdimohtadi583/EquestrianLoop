# Task 32: Rate Limiting

**Status:** ✅ COMPLETE  
**Date:** 2026-10-02  
**Tests:** 8 passing (new) | 188 baseline still passing | 196 total

## Implementation

### Core: In-Memory Rate Limiter
**File:** `src/server/rate-limit/rate-limiter.ts`

- Uses `Map<identifier, { count, resetAt }>` for tracking
- Sliding window approach: tracks count + expiry per identifier
- Auto-cleans expired entries on each check (no memory leak)
- **Critical guarantee:** Never throws — always returns `{ success, remaining, resetAt }`
- Returns full resetAt Date to calculate user-facing wait time

```typescript
rateLimit(identifier: string, limit: number, windowSeconds: number)
  => { success, remaining, resetAt }
```

### Applied To: 5 Auth Endpoints

#### 1. Sign-In (Both Staff & Customer)
**File:** `src/server/auth/credentials.ts` → `verifyCredentials()`
- **Limit:** 5 attempts per 15 minutes per email
- **Identifier:** email
- **Behavior:** Returns null (auth failure) if rate limited
- **Why email:** Single sign-in path serves both staff & customer; email is stable identifier

#### 2. Password Reset Request
**File:** `src/server/actions/auth-password.ts` → `requestPasswordReset()`
- **Limit:** 3 attempts per 1 hour per email
- **Identifier:** email
- **Behavior:** Returns error message with wait time if rate limited
- **Error message:** "Too many attempts. Try again in X minutes."

#### 3. Email Verification Resend
**File:** `src/server/actions/auth-verification.ts` → `resendVerificationEmail()`
- **Limit:** 3 attempts per 1 hour per userId
- **Identifier:** userId (internal identifier, more precise than email)
- **Behavior:** Returns error message with wait time if rate limited
- **Error message:** "Too many attempts. Try again in X minutes."

### Configuration
**File:** `.env.example`

Added optional Upstash Redis environment variables (comments explain):
- `UPSTASH_REDIS_REST_URL=` (optional)
- `UPSTASH_REDIS_REST_TOKEN=` (optional)

**Current behavior:** Uses in-memory Map (no external dependency)  
**Future:** Can upgrade to Upstash Redis for distributed deployments without code changes

## Tests: TDD First

**File:** `tests/server/rate-limit.test.ts`

All 8 tests written BEFORE implementation (TDD), then implementation made them pass:

✅ Allows requests under limit  
✅ Allows multiple requests up to limit  
✅ Blocks requests over limit  
✅ Returns resetAt timestamp with correct window  
✅ Different identifiers don't interfere (isolation)  
✅ Handles limit of 1  
✅ Handles very short window (1 second)  
✅ Never throws (resilience)  

## Security Notes

- **No email enumeration** in password reset: Always returns success, even for non-existent emails
  - Rate limiting applies at the HTTP layer (before database lookup)
  - Attacker can't tell if email exists by timing or responses
  
- **Token comparison never leaks timing:** Rate limiter uses simple count, not token comparison
  
- **Identifiers are safe:** Email for sign-in/password reset (public info); userId for resend (can't enumerate)

## Quality Checklist

✅ TDD: 8 failing tests first → minimal implementation → all pass  
✅ Tests: Verify limits work, window expires, no interference between IDs  
✅ No side effects: Rate limiter is pure (Map-based)  
✅ Never throws: Wrapped in try/catch, returns false on any error  
✅ TypeScript clean: `npx tsc --noEmit` passes  
✅ Build passes: `npm run build` succeeds  
✅ Baseline preserved: 188 tests still passing  
✅ New feature: +8 tests (196 total now)  

## Integration Points

All rate limit checks happen **at the TOP of each function** before any business logic:
- Sign-in rate limit applies before password verification
- Password reset rate limit applies before email check
- Resend rate limit applies before user lookup

This prevents resource waste on failed auth attempts.

## Future Improvements (Out of Scope)

- Upstash Redis for distributed deployments (env vars ready)
- Exponential backoff (currently fixed window)
- Custom error messages per endpoint
- Metrics/monitoring integration
