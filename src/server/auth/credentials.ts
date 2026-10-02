import { prisma } from '@/db/client'
import { verifyPassword } from './password'
import { rateLimit } from '@/server/rate-limit/rate-limiter'

export async function verifyCredentials(email: string, password: string) {
  // Rate limit: 5 attempts per 15 minutes per email
  const rateLimitResult = await rateLimit(email, 5, 900)
  if (!rateLimitResult.success) {
    return null
  }

  const user = await prisma.user.findUnique({ where: { email } })
  if (!user) return null
  const valid = await verifyPassword(password, user.passwordHash)
  if (!valid) return null
  return { id: user.id, email: user.email, name: user.name, type: user.type }
}
