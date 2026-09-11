import { describe, it, expect, afterAll } from 'vitest'
// Schema-verification tests sit outside the application layer the rawPrisma/prisma
// split (Task 2) protects, so they use rawPrisma directly — aliased to `prisma` here
// purely so the rest of this file's assertions don't need renaming.
import { rawPrisma as prisma } from '@/db/raw-client'
import { seedGlobalPermissions, seedDefaultRolesForOrganization } from '../../prisma/seed'

describe('RBAC schema', () => {
  afterAll(async () => {
    await prisma.$disconnect()
  })

  it('seeds default roles with the correct permission sets per organization', async () => {
    await seedGlobalPermissions()
    const org = await prisma.organization.create({
      data: { name: 'RBAC Test', slug: `rbac-test-${Date.now()}` },
    })
    await seedDefaultRolesForOrganization(org.id)

    const ownerRole = await prisma.role.findFirstOrThrow({
      where: { organizationId: org.id, name: 'OWNER' },
      include: { permissions: { include: { permission: true } } },
    })
    expect(ownerRole.permissions.map((rp) => rp.permission.key)).toContain('billing.manage')

    const trainerRole = await prisma.role.findFirstOrThrow({
      where: { organizationId: org.id, name: 'TRAINER' },
      include: { permissions: { include: { permission: true } } },
    })
    expect(trainerRole.permissions.map((rp) => rp.permission.key)).not.toContain('billing.manage')
    // Explicit timeout: seeding 13 global permissions plus 5 roles (each with
    // its own createMany of RolePermission rows) against a live, remote
    // Supabase pooler is a couple dozen sequential round-trips, which exceeds
    // vitest's 5s default on a cold connection — matches the pattern already
    // used for other multi-round-trip tests in tests/db/tenant-access-boundary.test.ts.
  }, 30_000)

  it('enforces one role per user per organization', async () => {
    const org = await prisma.organization.create({
      data: { name: 'Membership Test', slug: `membership-test-${Date.now()}` },
    })
    const user = await prisma.user.create({
      data: { email: `staff-${Date.now()}@test.com`, passwordHash: 'x', type: 'STAFF', name: 'Staff One' },
    })
    const role = await prisma.role.create({ data: { organizationId: org.id, name: 'CUSTOM' } })
    await prisma.membership.create({ data: { userId: user.id, organizationId: org.id, roleId: role.id } })

    await expect(
      prisma.membership.create({ data: { userId: user.id, organizationId: org.id, roleId: role.id } })
    ).rejects.toThrow()
  }, 30_000)
})
