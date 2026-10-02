#!/usr/bin/env node

/**
 * Environment variable validator
 * Run this as a prestart script to catch missing vars before server starts
 *
 * Usage: npx ts-node scripts/check-env.ts
 */

const REQUIRED_VARS = [
  'DATABASE_URL',
  'DIRECT_URL',
  'NEXTAUTH_SECRET',
  'NEXTAUTH_URL',
  'STRIPE_SECRET_KEY',
  'STRIPE_WEBHOOK_SECRET',
  'RESEND_API_KEY',
  'EMAIL_FROM',
]

const OPTIONAL_VARS = [
  'UPSTASH_REDIS_REST_URL',
  'UPSTASH_REDIS_REST_TOKEN',
  'SENTRY_DSN',
]

function checkEnv() {
  const missing: string[] = []
  const empty: string[] = []

  // Check required variables
  for (const varName of REQUIRED_VARS) {
    if (!(varName in process.env)) {
      missing.push(varName)
    } else if (!process.env[varName]?.trim()) {
      empty.push(varName)
    }
  }

  // Check optional variables with warnings
  const notSet: string[] = []
  for (const varName of OPTIONAL_VARS) {
    if (!(varName in process.env) || !process.env[varName]?.trim()) {
      notSet.push(varName)
    }
  }

  // Report missing required variables
  if (missing.length > 0 || empty.length > 0) {
    console.error('\n❌ STARTUP FAILED: Missing or empty environment variables\n')

    if (missing.length > 0) {
      console.error('Not set at all:')
      missing.forEach(v => console.error(`  - ${v}`))
    }

    if (empty.length > 0) {
      console.error('Empty values:')
      empty.forEach(v => console.error(`  - ${v}`))
    }

    console.error('\nSet these variables before starting the server.')
    console.error('See .env.example or .env.production.example for details.\n')

    process.exit(1)
  }

  // Warn about unset optional variables
  if (notSet.length > 0) {
    console.warn('\n⚠️  Optional features disabled (env vars not set):\n')
    notSet.forEach(v => console.warn(`  - ${v}`))
    console.warn('')
  }

  // Validate specific variable formats
  validateSecrets()

  console.log('✅ Environment variables validated\n')
}

function validateSecrets() {
  const secret = process.env.NEXTAUTH_SECRET
  if (secret && secret.length < 32) {
    console.warn('⚠️  NEXTAUTH_SECRET is shorter than 32 characters (recommended: 32+)')
  }

  const url = process.env.NEXTAUTH_URL
  if (url && !url.startsWith('http://') && !url.startsWith('https://')) {
    console.error('❌ NEXTAUTH_URL must start with http:// or https://')
    process.exit(1)
  }

  if (url && url.startsWith('http://') && process.env.NODE_ENV === 'production') {
    console.error('❌ NEXTAUTH_URL must use https:// in production')
    process.exit(1)
  }

  const emailFrom = process.env.EMAIL_FROM
  if (emailFrom && !emailFrom.includes('@')) {
    console.error('❌ EMAIL_FROM must be a valid email address')
    process.exit(1)
  }
}

// Run validation
checkEnv()
