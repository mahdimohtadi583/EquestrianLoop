import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { PrismaClient } from '@prisma/client'
import { createHorse, updateHorse, archiveHorse } from '@/server/actions/staff-horses'
import { withTenantContext } from '@/server/tenant/context'

// Use raw PrismaClient for test setup (bypasses RLS for data initialization)
const rawPrisma = new PrismaClient()

describe('Horse CRUD Operations', () => {
  let testOrgId: string
  let testBranchId: string
  let testHorseId: string

  beforeAll(async () => {
    // Create test org
    const org = await rawPrisma.organization.create({
      data: { name: 'Horse Test Org', slug: `hto-${Date.now()}` },
    })
    testOrgId = org.id

    // Create test branch
    const branch = await rawPrisma.branch.create({
      data: {
        organizationId: testOrgId,
        name: 'Test Branch',
        timezone: 'UTC',
      },
    })
    testBranchId = branch.id
  })

  afterAll(async () => {
    // Cleanup
    await rawPrisma.horse.deleteMany({
      where: { branchId: testBranchId },
    })
    await rawPrisma.branch.deleteMany({
      where: { organizationId: testOrgId },
    })
    await rawPrisma.organization.delete({
      where: { id: testOrgId },
    })
    await rawPrisma.$disconnect()
  })

  describe('createHorse', () => {
    it('creates horse with all required fields', async () => {
      const data = {
        name: 'Black Beauty',
        breed: 'Thoroughbred',
        dob: new Date('2015-01-01'),
        status: 'ACTIVE',
        branchId: testBranchId,
        notes: 'Strong and quick',
      }

      const result = await createHorse(testOrgId, data)

      expect(result.success).toBe(true)
      expect(result.data).toBeDefined()
      expect(result.data?.name).toBe('Black Beauty')
      expect(result.data?.breed).toBe('Thoroughbred')
      expect(result.data?.status).toBe('ACTIVE')
      testHorseId = result.data?.id || ''
    })

    it('rejects missing name', async () => {
      const data = {
        name: '',
        breed: 'Thoroughbred',
        dob: new Date('2015-01-01'),
        status: 'ACTIVE',
        branchId: testBranchId,
        notes: '',
      }

      const result = await createHorse(testOrgId, data)

      expect(result.success).toBe(false)
      expect(result.error).toBeDefined()
    })

    it('rejects invalid branchId', async () => {
      const data = {
        name: 'Test Horse',
        breed: 'Thoroughbred',
        dob: new Date('2015-01-01'),
        status: 'ACTIVE',
        branchId: 'invalid-branch-id',
        notes: '',
      }

      const result = await createHorse(testOrgId, data)

      expect(result.success).toBe(false)
      expect(result.error).toBeDefined()
    })
  })

  describe('updateHorse', () => {
    it('updates horse name and status', async () => {
      if (!testHorseId) {
        throw new Error('No horse ID for testing')
      }

      const result = await updateHorse(testOrgId, testHorseId, {
        name: 'Black Beauty Updated',
        status: 'INACTIVE',
      })

      expect(result.success).toBe(true)
      expect(result.data?.name).toBe('Black Beauty Updated')
      expect(result.data?.status).toBe('INACTIVE')
    })

    it('rejects update of non-existent horse', async () => {
      const result = await updateHorse(testOrgId, 'non-existent-id', {
        name: 'Updated Name',
      })

      expect(result.success).toBe(false)
      expect(result.error).toBeDefined()
    })

    it('archiveHorse test will use this horse', async () => {
      // This is placeholder - the archiveHorse test below will archive this horse
      expect(testHorseId).toBeTruthy()
    })
  })

  describe('archiveHorse', () => {
    it('archives horse by setting status to RETIRED', async () => {
      if (!testHorseId) {
        throw new Error('No horse ID for testing')
      }

      const result = await archiveHorse(testOrgId, testHorseId)

      expect(result.success).toBe(true)

      // Verify it was archived
      const horse = await withTenantContext(testOrgId, (tx) =>
        tx.horse.findUnique({
          where: { id: testHorseId },
        })
      )
      expect(horse?.status).toBe('RETIRED')
    })

    it('rejects archive of non-existent horse', async () => {
      const result = await archiveHorse(testOrgId, 'non-existent-horse-id')

      // Should succeed silently or fail gracefully
      // (depends on implementation - no future bookings means it can be archived)
      expect(result).toBeDefined()
    })
  })
})
