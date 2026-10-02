export const dynamic = 'force-dynamic'

export async function GET(request: Request) {
  const { handlers } = await import('@/server/auth/config')
  return handlers.GET(request)
}

export async function POST(request: Request) {
  const { handlers } = await import('@/server/auth/config')
  return handlers.POST(request)
}
