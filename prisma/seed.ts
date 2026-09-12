// Seed script: one of the two sanctioned importers of `rawPrisma` named in
// src/db/raw-client.ts's own header comment (the other is schema-verification
// tests). It sits outside the request-handling application layer the
// rawPrisma/prisma split protects, and it needs `permission`/`role` writes
// that are tenant-scoped-adjacent but not reachable through withTenantContext
// (RLS/Task 9) at seed time. It also cannot construct a bare `new
// PrismaClient()` the way the Task 3 brief originally sketched: schema.prisma
// declares `datasource db { provider = "postgresql" }` with no `url`, because
// this project connects exclusively through the `@prisma/adapter-pg` driver
// adapter (see src/db/raw-client.ts) — a client built without that adapter
// has no connection string to use. Importing the already-configured
// `rawPrisma` singleton avoids duplicating that wiring here.
// MUST stay above the raw-client import: it re-points DATABASE_URL at the
// owner connection for real seed runs, and raw-client resolves its connection
// string at load time. No-op under NODE_ENV=test. See prisma/seed-connection.ts.
import './seed-connection'
import { rawPrisma as prisma } from '../src/db/raw-client'
import { PERMISSIONS, DEFAULT_ROLE_PERMISSIONS } from '../src/config/permissions'

export async function seedGlobalPermissions() {
  for (const key of PERMISSIONS) {
    await prisma.permission.upsert({
      where: { key },
      update: {},
      create: { key, description: key },
    })
  }
}

export async function seedDefaultRolesForOrganization(organizationId: string) {
  const allPermissions = await prisma.permission.findMany()
  const byKey = Object.fromEntries(allPermissions.map((p) => [p.key, p.id]))

  for (const [roleName, permissionKeys] of Object.entries(DEFAULT_ROLE_PERMISSIONS)) {
    const role = await prisma.role.create({
      data: { organizationId, name: roleName, isSystemRole: true },
    })
    await prisma.rolePermission.createMany({
      data: permissionKeys.map((key) => ({ roleId: role.id, permissionId: byKey[key] })),
    })
  }
}

async function main() {
  await seedGlobalPermissions()
}

if (require.main === module) {
  main().finally(() => prisma.$disconnect())
}
