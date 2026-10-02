'use client'

import { useEffect, useState } from 'react'
import Link from 'next/link'
import { useSession } from 'next-auth/react'
import { useParams } from 'next/navigation'
import { getMembershipById } from '@/server/actions/staff-memberships'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { Button } from '@/components/ui/button'

interface MembershipDetail {
  id: string
  status: string
  startDate: Date
  endDate: Date
  customer: {
    firstName: string
    lastName: string
    user: {
      id: string
      email: string
      name: string
    }
    bookings: Array<{
      id: string
      status: string
      createdAt: Date
    }>
  }
  membershipPlan: {
    id: string
    name: string
    price: number
    durationValue: number
    durationUnit: string
  }
}

export default function MembershipDetailPage() {
  const { data: session } = useSession()
  const params = useParams<{ id: string }>()
  const [membership, setMembership] = useState<MembershipDetail | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    const loadMembership = async () => {
      try {
        if (!session?.user || !params.id) return
        const user = session.user as any
        const data = await getMembershipById(user.organizationId || '', params.id)
        setMembership(data as any)
      } catch (err) {
        setError(err instanceof Error ? err.message : 'Failed to load membership')
      } finally {
        setLoading(false)
      }
    }

    loadMembership()
  }, [session, params.id])

  if (loading) return <div className="flex items-center justify-center min-h-screen">Loading...</div>
  if (!membership) return <div className="flex items-center justify-center min-h-screen">Membership not found</div>

  const isExpired = new Date(membership.endDate) < new Date()
  const daysRemaining = Math.ceil(
    (new Date(membership.endDate).getTime() - new Date().getTime()) / (1000 * 60 * 60 * 24)
  )

  return (
    <div className="space-y-6 p-6">
      <div>
        <Link href="/staff/memberships">
          <Button variant="outline" className="mb-4">← Back to Memberships</Button>
        </Link>
        <h1 className="text-3xl font-serif font-bold text-stone-900">
          {membership.customer.firstName} {membership.customer.lastName}
        </h1>
        <p className="text-stone-600">{membership.membershipPlan.name}</p>
      </div>

      {error && <div className="bg-red-50 border border-red-200 text-red-700 px-4 py-3 rounded">{error}</div>}

      <div className="grid gap-6 md:grid-cols-2">
        {/* Customer Info */}
        <Card className="border-stone-200">
          <CardHeader>
            <CardTitle className="text-lg">Customer Information</CardTitle>
          </CardHeader>
          <CardContent className="space-y-4">
            <div>
              <p className="text-sm font-medium text-stone-600">Name</p>
              <p className="text-stone-900">{membership.customer.user.name}</p>
            </div>
            <div>
              <p className="text-sm font-medium text-stone-600">Email</p>
              <p className="text-stone-900">{membership.customer.user.email}</p>
            </div>
          </CardContent>
        </Card>

        {/* Membership Details */}
        <Card className={`border-stone-200 ${isExpired ? 'border-red-300 bg-red-50' : 'border-green-300 bg-green-50'}`}>
          <CardHeader>
            <CardTitle className="text-lg">Membership Status</CardTitle>
          </CardHeader>
          <CardContent className="space-y-4">
            <div>
              <p className="text-sm font-medium text-stone-600">Status</p>
              <span className={`inline-block text-xs px-2 py-1 rounded ${
                membership.status === 'ACTIVE' && !isExpired
                  ? 'bg-green-100 text-green-700'
                  : isExpired
                    ? 'bg-red-100 text-red-700'
                    : 'bg-stone-100 text-stone-700'
              }`}>
                {membership.status}
              </span>
            </div>
            <div>
              <p className="text-sm font-medium text-stone-600">
                {isExpired ? 'Expired On' : 'Expires On'}
              </p>
              <p className="text-stone-900">
                {new Date(membership.endDate).toLocaleDateString()}
              </p>
            </div>
            {!isExpired && (
              <div>
                <p className="text-sm font-medium text-stone-600">Days Remaining</p>
                <p className="text-stone-900">{daysRemaining} days</p>
              </div>
            )}
          </CardContent>
        </Card>

        {/* Plan Details */}
        <Card className="border-stone-200">
          <CardHeader>
            <CardTitle className="text-lg">Plan Details</CardTitle>
          </CardHeader>
          <CardContent className="space-y-4">
            <div>
              <p className="text-sm font-medium text-stone-600">Plan Name</p>
              <p className="text-stone-900">{membership.membershipPlan.name}</p>
            </div>
            <div>
              <p className="text-sm font-medium text-stone-600">Price</p>
              <p className="text-stone-900">${membership.membershipPlan.price.toFixed(2)}</p>
            </div>
            <div>
              <p className="text-sm font-medium text-stone-600">Duration</p>
              <p className="text-stone-900">
                Every {membership.membershipPlan.durationValue} {membership.membershipPlan.durationUnit}
              </p>
            </div>
          </CardContent>
        </Card>

        {/* Joined Date */}
        <Card className="border-stone-200">
          <CardHeader>
            <CardTitle className="text-lg">Timeline</CardTitle>
          </CardHeader>
          <CardContent className="space-y-4">
            <div>
              <p className="text-sm font-medium text-stone-600">Started</p>
              <p className="text-stone-900">
                {new Date(membership.startDate).toLocaleDateString()}
              </p>
            </div>
          </CardContent>
        </Card>
      </div>

      {/* Bookings */}
      <Card className="border-stone-200">
        <CardHeader>
          <CardTitle className="text-lg">
            Bookings ({membership.customer.bookings.length})
          </CardTitle>
        </CardHeader>
        <CardContent>
          {membership.customer.bookings.length === 0 ? (
            <p className="text-stone-600">No bookings under this membership</p>
          ) : (
            <div className="space-y-2">
              {membership.customer.bookings.map((booking) => (
                <div key={booking.id} className="flex items-center justify-between py-2 border-b border-stone-100 last:border-0">
                  <span className="text-sm text-stone-900">
                    {new Date(booking.createdAt).toLocaleDateString()}
                  </span>
                  <span className={`text-xs px-2 py-1 rounded ${
                    booking.status === 'CONFIRMED'
                      ? 'bg-green-100 text-green-700'
                      : booking.status === 'PENDING'
                        ? 'bg-yellow-100 text-yellow-700'
                        : 'bg-stone-100 text-stone-700'
                  }`}>
                    {booking.status}
                  </span>
                </div>
              ))}
            </div>
          )}
        </CardContent>
      </Card>
    </div>
  )
}
