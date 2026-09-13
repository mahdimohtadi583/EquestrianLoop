import { prisma } from '@/db/client'
import { verifyPassword } from './password'

export async function verifyCredentials(email: string, password: string) {
  const user = await prisma.user.findUnique({ where: { email } })
  if (!user) return null
  const valid = await verifyPassword(password, user.passwordHash)
  if (!valid) return null
  return { id: user.id, email: user.email, name: user.name, type: user.type }
}
