import { NextResponse } from 'next/server'

export const runtime = 'nodejs'

/**
 * Health check endpoint for monitoring and CI/CD pipelines
 *
 * GET /api/health
 * - No authentication required
 * - Returns basic health status
 * - Used by: Vercel deployments, monitoring services, smoke tests
 */
export async function GET() {
  return NextResponse.json(
    {
      status: 'ok',
      timestamp: new Date().toISOString(),
      version: '1.0.0',
    },
    {
      status: 200,
      headers: {
        'Cache-Control': 'no-cache, no-store, must-revalidate',
        'Pragma': 'no-cache',
        'Expires': '0',
      },
    }
  )
}
