'use client'

import { useEffect, useState } from 'react'
import { useSession } from 'next-auth/react'
import { getMyBookings } from '@/server/actions/customer-portal'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { Button } from '@/components/ui/button'

interface MyBooking {
  id: string
  status: string
  ridingSession: {
    id: string
    startsAt: Date
    horse: {
      id: string
      name: string
      breed: string | null
    } | null
    service: {
      id: string
      name: string
    }
  }
}

export default function MyBookingsPage() {
  const { data: session } = useSession()
  const [bookings, setBookings] = useState<MyBooking[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    const loadBookings = async () => {
      try {
        if (!session?.user) return
        const user = session.user as any
        const data = await getMyBookings(user.organizationId || '')
        setBookings(data as any)
      } catch (err) {
        setError(err instanceof Error ? err.message : 'Failed to load bookings')
      } finally {
        setLoading(false)
      }
    }

    loadBookings()
  }, [session])

  if (loading) return <div className="flex items-center justify-center min-h-screen">Loading...</div>

  const upcomingBookings = bookings.filter((b) => new Date(b.ridingSession.startsAt) > new Date())
  const pastBookings = bookings.filter((b) => new Date(b.ridingSession.startsAt) <= new Date())

  return (
    <div className="space-y-6 p-6">
      <h1 className="text-3xl font-serif font-bold text-stone-900">My Bookings</h1>

      {error && <div className="bg-red-50 border border-red-200 text-red-700 px-4 py-3 rounded">{error}</div>}

      {/* Upcoming Bookings */}
      {upcomingBookings.length > 0 && (
        <div className="space-y-4">
          <h2 className="text-xl font-serif font-bold text-stone-900">Upcoming</h2>
          {upcomingBookings.map((booking) => (
            <Card key={booking.id} className="border-green-200 bg-green-50">
              <CardContent className="pt-6">
                <div className="flex items-center justify-between">
                  <div>
                    <p className="font-semibold text-stone-900">{booking.ridingSession.service.name}</p>
                    <p className="text-sm text-stone-600">
                      {booking.ridingSession.horse?.name || 'N/A'}
                    </p>
                    <p className="text-xs text-stone-500 mt-1">
                      {new Date(booking.ridingSession.startsAt).toLocaleString()}
                    </p>
                  </div>
                  <span className="text-xs px-2 py-1 rounded bg-green-100 text-green-700">
                    {booking.status}
                  </span>
                </div>
              </CardContent>
            </Card>
          ))}
        </div>
      )}

      {/* Past Bookings */}
      {pastBookings.length > 0 && (
        <div className="space-y-4">
          <h2 className="text-xl font-serif font-bold text-stone-900">Past</h2>
          {pastBookings.map((booking) => (
            <Card key={booking.id} className="border-stone-200">
              <CardContent className="pt-6">
                <div className="flex items-center justify-between">
                  <div>
                    <p className="font-semibold text-stone-900">{booking.ridingSession.service.name}</p>
                    <p className="text-sm text-stone-600">
                      {booking.ridingSession.horse?.name || 'N/A'}
                    </p>
                    <p className="text-xs text-stone-500 mt-1">
                      {new Date(booking.ridingSession.startsAt).toLocaleString()}
                    </p>
                  </div>
                  <span className="text-xs px-2 py-1 rounded bg-stone-100 text-stone-700">
                    {booking.status}
                  </span>
                </div>
              </CardContent>
            </Card>
          ))}
        </div>
      )}

      {bookings.length === 0 && (
        <Card className="border-stone-200">
          <CardContent className="pt-6">
            <p className="text-center text-stone-600">No bookings yet</p>
          </CardContent>
        </Card>
      )}
    </div>
  )
}
