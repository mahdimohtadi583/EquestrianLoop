'use client'

import { useEffect, useState } from 'react'
import { useSession } from 'next-auth/react'
import { useParams } from 'next/navigation'
import { getCustomerById, awardLoyaltyPoints } from '@/server/actions/staff-customers'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { Button } from '@/components/ui/button'

interface CustomerDetail {
  id: string
  firstName: string
  lastName: string
  phone: string | null
  user: {
    id: string
    email: string
    name: string
  }
  memberships: Array<{
    id: string
    status: string
    startDate: Date
    endDate: Date
    membershipPlan: {
      id: string
      name: string
      price: number
    }
  }>
  bookings: Array<{
    id: string
    status: string
    createdAt: Date
    ridingSession: {
      id: string
      startsAt: Date
      horse: {
        id: string
        name: string
        breed: string | null
      } | null
    }
  }>
}

export default function CustomerDetailPage() {
  const { data: session } = useSession()
  const params = useParams<{ id: string }>()
  const [customer, setCustomer] = useState<CustomerDetail | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [loyaltyPoints, setLoyaltyPoints] = useState('')
  const [awarding, setAwarding] = useState(false)

  useEffect(() => {
    const loadCustomer = async () => {
      try {
        if (!session?.user || !params.id) return
        const user = session.user as any
        const data = await getCustomerById(user.organizationId || '', params.id)
        setCustomer(data as any)
      } catch (err) {
        setError(err instanceof Error ? err.message : 'Failed to load customer')
      } finally {
        setLoading(false)
      }
    }

    loadCustomer()
  }, [session, params.id])

  if (loading) return <div className="flex items-center justify-center min-h-screen">Loading...</div>
  if (!customer) return <div className="flex items-center justify-center min-h-screen">Customer not found</div>

  const activeMembership = customer.memberships[0]
  const upcomingBookings = customer.bookings.filter((b) => new Date(b.ridingSession.startsAt) > new Date())

  return (
    <div className="space-y-6 p-6">
      <div>
        <h1 className="text-3xl font-serif font-bold text-stone-900">
          {customer.firstName} {customer.lastName}
        </h1>
        <p className="text-stone-600">{customer.user.email}</p>
      </div>

      {error && <div className="bg-red-50 border border-red-200 text-red-700 px-4 py-3 rounded">{error}</div>}

      <div className="grid gap-6 md:grid-cols-2">
        {/* Profile Card */}
        <Card className="border-stone-200">
          <CardHeader>
            <CardTitle className="text-lg">Profile Information</CardTitle>
          </CardHeader>
          <CardContent className="space-y-4">
            <div>
              <p className="text-sm font-medium text-stone-600">Email</p>
              <p className="text-stone-900">{customer.user.email}</p>
            </div>
            <div>
              <p className="text-sm font-medium text-stone-600">Name</p>
              <p className="text-stone-900">{customer.user.name}</p>
            </div>
            {customer.phone && (
              <div>
                <p className="text-sm font-medium text-stone-600">Phone</p>
                <p className="text-stone-900">{customer.phone}</p>
              </div>
            )}
          </CardContent>
        </Card>

        {/* Membership Card */}
        {activeMembership && (
          <Card className="border-stone-200">
            <CardHeader>
              <CardTitle className="text-lg">Active Membership</CardTitle>
            </CardHeader>
            <CardContent className="space-y-4">
              <div>
                <div className="flex items-center gap-2">
                  <p className="text-sm font-medium text-stone-600">{activeMembership.membershipPlan.name}</p>
                  <span className={`text-xs px-2 py-1 rounded ${
                    activeMembership.status === 'ACTIVE'
                      ? 'bg-green-100 text-green-700'
                      : 'bg-stone-100 text-stone-700'
                  }`}>
                    {activeMembership.status}
                  </span>
                </div>
              </div>
              <div>
                <p className="text-sm font-medium text-stone-600">Price</p>
                <p className="text-stone-900">${activeMembership.membershipPlan.price.toFixed(2)}</p>
              </div>
              <div>
                <p className="text-sm font-medium text-stone-600">Valid Until</p>
                <p className="text-stone-900">
                  {new Date(activeMembership.endDate).toLocaleDateString()}
                </p>
              </div>
            </CardContent>
          </Card>
        )}
      </div>

      {/* Bookings Card */}
      <Card className="border-stone-200">
        <CardHeader>
          <CardTitle className="text-lg">
            Recent Bookings ({customer.bookings.length})
          </CardTitle>
        </CardHeader>
        <CardContent>
          {customer.bookings.length === 0 ? (
            <p className="text-stone-600">No bookings</p>
          ) : (
            <div className="space-y-3">
              {customer.bookings.map((booking) => (
                <div key={booking.id} className="flex items-center justify-between py-2 border-b border-stone-100 last:border-0">
                  <div>
                    <p className="font-medium text-stone-900">{booking.ridingSession.horse?.name || 'N/A'}</p>
                    <p className="text-sm text-stone-600">
                      {new Date(booking.ridingSession.startsAt).toLocaleString()}
                    </p>
                  </div>
                  <span className="text-xs px-2 py-1 rounded bg-stone-100 text-stone-700">
                    {booking.status}
                  </span>
                </div>
              ))}
            </div>
          )}
        </CardContent>
      </Card>

      {/* Upcoming Bookings */}
      {upcomingBookings.length > 0 && (
        <Card className="border-green-200 bg-green-50">
          <CardHeader>
            <CardTitle className="text-lg text-green-900">Upcoming Bookings ({upcomingBookings.length})</CardTitle>
          </CardHeader>
          <CardContent>
            <div className="space-y-3">
              {upcomingBookings.map((booking) => (
                <div key={booking.id} className="flex items-center justify-between py-2 border-b border-green-100 last:border-0">
                  <div>
                    <p className="font-medium text-stone-900">{booking.ridingSession.horse?.name || 'N/A'}</p>
                    <p className="text-sm text-stone-600">
                      {new Date(booking.ridingSession.startsAt).toLocaleString()}
                    </p>
                  </div>
                  <span className="text-xs px-2 py-1 rounded bg-green-100 text-green-700">Scheduled</span>
                </div>
              ))}
            </div>
          </CardContent>
        </Card>
      )}

      {/* Loyalty Points */}
      <Card className="border-stone-200">
        <CardHeader>
          <CardTitle className="text-lg">Award Loyalty Points</CardTitle>
        </CardHeader>
        <CardContent>
          <form
            onSubmit={async (e) => {
              e.preventDefault()
              setAwarding(true)
              try {
                if (!session?.user || !params.id) throw new Error('Not authenticated')
                const user = session.user as any
                const points = parseInt(loyaltyPoints)
                if (isNaN(points) || points <= 0) {
                  setError('Enter valid points')
                  return
                }

                const result = await awardLoyaltyPoints(
                  user.organizationId || '',
                  params.id,
                  points,
                  'Staff Award'
                )

                if (result.success) {
                  setLoyaltyPoints('')
                  setError(null)
                } else {
                  setError(result.error || 'Failed to award points')
                }
              } catch (err) {
                setError(err instanceof Error ? err.message : 'Failed to award points')
              } finally {
                setAwarding(false)
              }
            }}
            className="space-y-4"
          >
            <div>
              <label className="block text-sm font-medium text-stone-700 mb-2">Points to Award</label>
              <div className="flex gap-2">
                <input
                  type="number"
                  value={loyaltyPoints}
                  onChange={(e) => setLoyaltyPoints(e.target.value)}
                  min="1"
                  className="flex-1 px-3 py-2 border border-stone-300 rounded-md focus:outline-none focus:ring-2 focus:ring-stone-500"
                  placeholder="Enter points"
                />
                <Button type="submit" disabled={awarding}>
                  {awarding ? 'Awarding...' : 'Award'}
                </Button>
              </div>
            </div>
          </form>
        </CardContent>
      </Card>
    </div>
  )
}
