import { describe, it, expect, afterAll } from 'vitest'
import { prisma } from '@/db/client'
import { hashPassword } from '@/server/auth/password'
import { verifyCredentials } from '@/server/auth/credentials'

describe('verifyCredentials', () => {
  afterAll(async () => {
    await prisma.$disconnect()
  })

  it('returns the user for correct credentials', async () => {
    const email = `cred-${Date.now()}@test.com`
    await prisma.user.create({
      data: { email, passwordHash: await hashPassword('s3cret-pass'), type: 'STAFF', name: 'Cred User' },
    })
    const result = await verifyCredentials(email, 's3cret-pass')
    expect(result?.email).toBe(email)
    expect(result?.type).toBe('STAFF')
  })

  it('returns null for a wrong password', async () => {
    const email = `cred2-${Date.now()}@test.com`
    await prisma.user.create({
      data: { email, passwordHash: await hashPassword('s3cret-pass'), type: 'STAFF', name: 'Cred User 2' },
    })
    expect(await verifyCredentials(email, 'wrong')).toBeNull()
  })

  it('returns null for a nonexistent email', async () => {
    expect(await verifyCredentials('nobody@test.com', 'whatever')).toBeNull()
  })
})
