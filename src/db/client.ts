import { rawPrisma } from './raw-client'

// `permission` is included here even though it isn't a User/Organization/Subscription/AuditLog
// peer: it's a fixed, global catalog (the ~13 permission-key rows seeded once in Task 3), not
// per-tenant data, and it carries no organizationId column for RLS to key on in the first place.
const PLATFORM_MODEL_KEYS = new Set(['user', 'organization', 'subscription', 'auditLog', 'permission'])
const ALSO_ALLOWED = new Set(['$connect', '$disconnect'])

export class TenantScopedModelAccessError extends Error {
  constructor(prop: string) {
    super(
      `Blocked direct access to prisma.${prop} — this is not one of the platform-level models ` +
        `(user, organization, subscription, auditLog, permission). Tenant-scoped models, and any ` +
        `transaction or raw SQL, must go through withTenantContext(organizationId, (tx) => ...) from ` +
        `'@/server/tenant/context' so the Postgres RLS session variable is set before the query runs.`
    )
    this.name = 'TenantScopedModelAccessError'
  }
}

type PlatformScopedClient = Pick<typeof rawPrisma, 'user' | 'organization' | 'subscription' | 'auditLog' | 'permission' | '$connect' | '$disconnect'>

export const prisma: PlatformScopedClient = new Proxy(rawPrisma, {
  get(target, prop, receiver) {
    if (
      typeof prop === 'string' &&
      !PLATFORM_MODEL_KEYS.has(prop) &&
      !ALSO_ALLOWED.has(prop) &&
      !prop.startsWith('_') // Allow internal Prisma properties like _clientVersion, _engine, etc.
    ) {
      throw new TenantScopedModelAccessError(prop)
    }
    return Reflect.get(target, prop, receiver)
  },
}) as PlatformScopedClient
