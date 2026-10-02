'use client'

import { useSession } from 'next-auth/react'
import { useRouter } from 'next/navigation'
import { useEffect } from 'react'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { Button } from '@/components/ui/button'

export default function StaffDashboardPage() {
  const router = useRouter()
  const { data: session, status } = useSession()

  useEffect(() => {
    if (status === 'unauthenticated') {
      router.push('/staff/sign-in')
    }
    const user = session?.user as any
    if (session && user?.type !== 'STAFF') {
      router.push('/staff/sign-in')
    }
  }, [status, session, router])

  if (status === 'loading') {
    return <div className="flex items-center justify-center min-h-screen">Loading...</div>
  }

  if (status === 'unauthenticated' || !session) {
    return null
  }

  const user = session.user as any
  if (user?.type !== 'STAFF') {
    return null
  }

  return (
    <div className="min-h-screen bg-stone-50">
      {/* Navigation */}
      <nav className="border-b border-stone-200 bg-white">
        <div className="mx-auto max-w-6xl px-4 py-4 sm:px-6 lg:px-8">
          <div className="flex items-center justify-between">
            <h1 className="text-2xl font-serif font-bold text-stone-900">Staff Portal</h1>
            <div className="text-sm text-stone-600">{user?.email}</div>
          </div>
        </div>
      </nav>

      {/* Main Content */}
      <main className="mx-auto max-w-6xl px-4 py-8 sm:px-6 lg:px-8">
        <div className="grid gap-6 md:grid-cols-2">
          {/* User Info Card */}
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
              <div>
                <p className="text-sm font-medium text-stone-600">Role</p>
                <p className="text-stone-900">Staff</p>
              </div>
            </CardContent>
          </Card>

          {/* Quick Actions Card */}
          <Card className="border-stone-200">
            <CardHeader>
              <CardTitle className="text-lg">Quick Actions</CardTitle>
            </CardHeader>
            <CardContent className="space-y-3">
              <Button variant="outline" className="w-full justify-start">
                View Bookings
              </Button>
              <Button variant="outline" className="w-full justify-start">
                Manage Customers
              </Button>
              <Button variant="outline" className="w-full justify-start">
                Organization Settings
              </Button>
            </CardContent>
          </Card>
        </div>

        {/* Stats Section */}
        <div className="mt-8 grid gap-6 md:grid-cols-3">
          <Card className="border-stone-200">
            <CardContent className="pt-6">
              <div className="text-center">
                <p className="text-3xl font-bold text-stone-900">—</p>
                <p className="mt-2 text-sm text-stone-600">Active Bookings</p>
              </div>
            </CardContent>
          </Card>
          <Card className="border-stone-200">
            <CardContent className="pt-6">
              <div className="text-center">
                <p className="text-3xl font-bold text-stone-900">—</p>
                <p className="mt-2 text-sm text-stone-600">Total Customers</p>
              </div>
            </CardContent>
          </Card>
          <Card className="border-stone-200">
            <CardContent className="pt-6">
              <div className="text-center">
                <p className="text-3xl font-bold text-stone-900">—</p>
                <p className="mt-2 text-sm text-stone-600">This Month Revenue</p>
              </div>
            </CardContent>
          </Card>
        </div>
      </main>
    </div>
  )
}
