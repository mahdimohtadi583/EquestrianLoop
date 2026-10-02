'use client'

import { useEffect, useState } from 'react'
import Link from 'next/link'
import { useSession } from 'next-auth/react'
import { getBookings } from '@/server/actions/staff-bookings'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { Button } from '@/components/ui/button'

interface Booking {
  id: string
  status: string
  createdAt: Date
  customer: {
    firstName: string
    lastName: string
    user: {
      email: string
    }
  }
  ridingSession: {
    startsAt: Date
    horse: {
      name: string
      breed: string | null
    } | null
    service: {
      name: string
    }
  }
}

export default function BookingsPage() {
  const { data: session } = useSession()
  const [bookings, setBookings] = useState<Booking[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    const loadBookings = async () => {
      try {
        if (!session?.user) return
        const user = session.user as any
        const data = await getBookings(user.organizationId || '')
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

  return (
    <div className="space-y-6 p-6">
      <div className="flex items-center justify-between">
        <h1 className="text-3xl font-serif font-bold text-stone-900">Bookings</h1>
      </div>

      {error && <div className="bg-red-50 border border-red-200 text-red-700 px-4 py-3 rounded">{error}</div>}

      <div className="space-y-4">
        {bookings.length === 0 ? (
          <Card className="border-stone-200">
            <CardContent className="pt-6">
              <p className="text-center text-stone-600">No bookings yet</p>
            </CardContent>
          </Card>
        ) : (
          bookings.map((booking) => (
            <Link key={booking.id} href={`/staff/bookings/${booking.id}`}>
              <Card className="border-stone-200 hover:shadow-md transition-shadow cursor-pointer">
                <CardContent className="pt-6">
                  <div className="flex items-center justify-between">
                    <div className="flex-1">
                      <div className="flex items-center gap-4">
                        <div>
                          <p className="font-semibold text-stone-900">
                            {booking.customer.firstName} {booking.customer.lastName}
                          </p>
                          <p className="text-sm text-stone-600">{booking.ridingSession.horse?.name || 'N/A'}</p>
                          <p className="text-xs text-stone-500 mt-1">{booking.ridingSession.service.name}</p>
                        </div>
                      </div>
                    </div>
                    <div className="text-right">
                      <p className="text-sm text-stone-600">
                        {new Date(booking.ridingSession.startsAt).toLocaleString()}
                      </p>
                      <span className={`inline-block text-xs px-2 py-1 rounded mt-2 ${
                        booking.status === 'CONFIRMED'
                          ? 'bg-green-100 text-green-700'
                          : booking.status === 'PENDING'
                            ? 'bg-yellow-100 text-yellow-700'
                            : 'bg-stone-100 text-stone-700'
                      }`}>
                        {booking.status}
                      </span>
                    </div>
                  </div>
                </CardContent>
              </Card>
            </Link>
          ))
        )}
      </div>
    </div>
  )
}
