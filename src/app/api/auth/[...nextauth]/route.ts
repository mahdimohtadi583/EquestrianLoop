import type { NextRequest } from 'next/server'

export const dynamic = 'force-dynamic'

export async function GET(request: NextRequest) {
  const { handlers } = await import('@/server/auth/config')
  return handlers.GET(request)
}

export async function POST(request: NextRequest) {
  const { handlers } = await import('@/server/auth/config')
  return handlers.POST(request)
}
