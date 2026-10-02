'use client'

import { useSession } from 'next-auth/react'
import { useRouter, useParams } from 'next/navigation'
import { useEffect } from 'react'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { Button } from '@/components/ui/button'

export default function CustomerPortalPage() {
  const router = useRouter()
  const params = useParams<{ orgSlug: string }>()
  const { data: session, status } = useSession()

  useEffect(() => {
    if (status === 'unauthenticated') {
      router.push(`/${params.orgSlug}/sign-in`)
    }
    const user = session?.user as any
    if (session && user?.type !== 'CUSTOMER') {
      router.push(`/${params.orgSlug}/sign-in`)
    }
  }, [status, session, router, params.orgSlug])

  if (status === 'loading') {
    return <div className="flex items-center justify-center min-h-screen">Loading...</div>
  }

  if (status === 'unauthenticated' || !session) {
    return null
  }

  const user = session.user as any
  if (user?.type !== 'CUSTOMER') {
    return null
  }

  return (
    <div className="min-h-screen bg-stone-50">
      {/* Navigation */}
      <nav className="border-b border-stone-200 bg-white">
        <div className="mx-auto max-w-6xl px-4 py-4 sm:px-6 lg:px-8">
          <div className="flex items-center justify-between">
            <h1 className="text-2xl font-serif font-bold text-stone-900">Customer Portal</h1>
            <div className="text-sm text-stone-600">{user?.email}</div>
          </div>
        </div>
      </nav>

      {/* Main Content */}
      <main className="mx-auto max-w-6xl px-4 py-8 sm:px-6 lg:px-8">
        <div className="grid gap-6 md:grid-cols-2">
          {/* Profile Card */}
          <Card className="border-stone-200">
            <CardHeader>
              <CardTitle className="text-lg">Your Profile</CardTitle>
            </CardHeader>
            <CardContent className="space-y-4">
              <div>
                <p className="text-sm font-medium text-stone-600">Name</p>
                <p className="text-stone-900">{user?.name || 'N/A'}</p>
              </div>
              <div>
                <p className="text-sm font-medium text-stone-600">Email</p>
                <p className="text-stone-900">{user?.email}</p>
              </div>
            </CardContent>
          </Card>

          {/* Membership Card */}
          <Card className="border-stone-200">
            <CardHeader>
              <CardTitle className="text-lg">Membership</CardTitle>
            </CardHeader>
            <CardContent className="space-y-4">
              <div>
                <p className="text-sm font-medium text-stone-600">Status</p>
                <p className="text-stone-900">Active</p>
              </div>
              <Button variant="outline" className="w-full">
                Manage Billing
              </Button>
            </CardContent>
          </Card>
        </div>

        {/* Bookings Section */}
        <div className="mt-8">
          <Card className="border-stone-200">
            <CardHeader>
              <CardTitle className="text-lg">Your Bookings</CardTitle>
            </CardHeader>
            <CardContent>
              <p className="text-sm text-stone-600">No bookings yet</p>
            </CardContent>
          </Card>
        </div>
      </main>
    </div>
  )
}
