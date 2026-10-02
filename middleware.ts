import { NextResponse } from 'next/server'
import type { NextRequest } from 'next/server'
import { auth } from '@/server/auth/config'

/**
 * Task 13: Route protection middleware
 *
 * Protects routes based on NextAuth v5 JWT session:
 * 1. /staff routes require STAFF or ADMIN role
 * 2. /customer routes require CUSTOMER role
 * 3. Auth sign-in routes redirect authenticated users
 * 4. Unauthenticated users to protected routes redirect to /staff/sign-in
 */

export async function middleware(request: NextRequest) {
  const { pathname } = request.nextUrl
  const session = await auth()
  const userType = (session?.user as any)?.type as string | undefined

  // Auth routes: redirect authenticated users
  if (pathname === '/staff/sign-in' || pathname === '/customer/sign-in') {
    if (session?.user?.id) {
      // User is logged in, redirect to appropriate dashboard
      const redirectPath = userType === 'CUSTOMER' ? '/customer/portal' : '/staff/dashboard'
      return NextResponse.redirect(new URL(redirectPath, request.url))
    }
    // User not logged in, allow access to sign-in page
    return NextResponse.next()
  }

  // Staff routes: require STAFF or ADMIN
  if (pathname.startsWith('/staff/')) {
    if (!session?.user?.id || (userType !== 'STAFF' && userType !== 'ADMIN')) {
      return NextResponse.redirect(new URL('/staff/sign-in', request.url))
    }
    return NextResponse.next()
  }

  // Customer routes: require CUSTOMER role exclusively
  if (pathname.startsWith('/customer/')) {
    if (!session?.user?.id || userType !== 'CUSTOMER') {
      return NextResponse.redirect(new URL('/customer/sign-in', request.url))
    }
    return NextResponse.next()
  }

  // Default: allow public routes
  return NextResponse.next()
}

export const config = {
  matcher: [
    // Protect /staff/** and /customer/** routes
    '/staff/:path*',
    '/customer/:path*',
    // Protect auth routes to redirect logged-in users
    '/staff/sign-in',
    '/customer/sign-in',
  ],
}
