'use client'

import { useEffect, useState } from 'react'
import Link from 'next/link'
import { useSession } from 'next-auth/react'
import { useParams } from 'next/navigation'
import { getBookingById } from '@/server/actions/staff-bookings'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { Button } from '@/components/ui/button'

interface BookingDetail {
  id: string
  status: string
  createdAt: Date
  customer: {
    firstName: string
    lastName: string
    user: {
      id: string
      email: string
      name: string
    }
    memberships: Array<{
      id: string
      status: string
      endDate: Date
    }>
  }
  ridingSession: {
    id: string
    startsAt: Date
    capacity: number
    horse: {
      id: string
      name: string
      breed: string | null
      status: string
    } | null
    service: {
      id: string
      name: string
      durationMinutes: number
    }
    trainer: any
  }
  checkIn: any
}

export default function BookingDetailPage() {
  const { data: session } = useSession()
  const params = useParams<{ id: string }>()
  const [booking, setBooking] = useState<BookingDetail | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    const loadBooking = async () => {
      try {
        if (!session?.user || !params.id) return
        const user = session.user as any
        const data = await getBookingById(user.organizationId || '', params.id)
        setBooking(data as any)
      } catch (err) {
        setError(err instanceof Error ? err.message : 'Failed to load booking')
      } finally {
        setLoading(false)
      }
    }

    loadBooking()
  }, [session, params.id])

  if (loading) return <div className="flex items-center justify-center min-h-screen">Loading...</div>
  if (!booking) return <div className="flex items-center justify-center min-h-screen">Booking not found</div>

  const activeMembership = booking.customer.memberships.find((m) => m.status === 'ACTIVE')

  return (
    <div className="space-y-6 p-6">
      <div>
        <Link href="/staff/bookings">
          <Button variant="outline" className="mb-4">← Back to Bookings</Button>
        </Link>
        <h1 className="text-3xl font-serif font-bold text-stone-900">
          Booking: {booking.customer.firstName} {booking.customer.lastName}
        </h1>
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
              <p className="text-stone-900">{booking.customer.user.name}</p>
            </div>
            <div>
              <p className="text-sm font-medium text-stone-600">Email</p>
              <p className="text-stone-900">{booking.customer.user.email}</p>
            </div>
            <div>
              <p className="text-sm font-medium text-stone-600">Membership Status</p>
              <span className={`inline-block text-xs px-2 py-1 rounded ${
                activeMembership?.status === 'ACTIVE'
                  ? 'bg-green-100 text-green-700'
                  : 'bg-stone-100 text-stone-700'
              }`}>
                {activeMembership?.status || 'No active membership'}
              </span>
            </div>
          </CardContent>
        </Card>

        {/* Session Info */}
        <Card className="border-stone-200">
          <CardHeader>
            <CardTitle className="text-lg">Session Details</CardTitle>
          </CardHeader>
          <CardContent className="space-y-4">
            <div>
              <p className="text-sm font-medium text-stone-600">Service</p>
              <p className="text-stone-900">{booking.ridingSession.service.name}</p>
            </div>
            <div>
              <p className="text-sm font-medium text-stone-600">Duration</p>
              <p className="text-stone-900">{booking.ridingSession.service.durationMinutes} minutes</p>
            </div>
            <div>
              <p className="text-sm font-medium text-stone-600">Date & Time</p>
              <p className="text-stone-900">
                {new Date(booking.ridingSession.startsAt).toLocaleString()}
              </p>
            </div>
          </CardContent>
        </Card>

        {/* Horse Info */}
        {booking.ridingSession.horse && (
          <Card className="border-stone-200">
            <CardHeader>
              <CardTitle className="text-lg">Horse</CardTitle>
            </CardHeader>
            <CardContent className="space-y-4">
              <div>
                <p className="text-sm font-medium text-stone-600">Name</p>
                <p className="text-stone-900">{booking.ridingSession.horse.name}</p>
              </div>
              <div>
                <p className="text-sm font-medium text-stone-600">Breed</p>
                <p className="text-stone-900">{booking.ridingSession.horse.breed || 'Not specified'}</p>
              </div>
              <div>
                <p className="text-sm font-medium text-stone-600">Status</p>
                <span className={`inline-block text-xs px-2 py-1 rounded ${
                  booking.ridingSession.horse.status === 'ACTIVE'
                    ? 'bg-green-100 text-green-700'
                    : 'bg-stone-100 text-stone-700'
                }`}>
                  {booking.ridingSession.horse.status}
                </span>
              </div>
            </CardContent>
          </Card>
        )}

        {/* Booking Status */}
        <Card className="border-stone-200">
          <CardHeader>
            <CardTitle className="text-lg">Booking Status</CardTitle>
          </CardHeader>
          <CardContent className="space-y-4">
            <div>
              <p className="text-sm font-medium text-stone-600">Status</p>
              <span className={`inline-block text-xs px-2 py-1 rounded ${
                booking.status === 'CONFIRMED'
                  ? 'bg-green-100 text-green-700'
                  : booking.status === 'PENDING'
                    ? 'bg-yellow-100 text-yellow-700'
                    : 'bg-red-100 text-red-700'
              }`}>
                {booking.status}
              </span>
            </div>
            <div>
              <p className="text-sm font-medium text-stone-600">Created</p>
              <p className="text-stone-900">
                {new Date(booking.createdAt).toLocaleDateString()}
              </p>
            </div>
            {booking.checkIn && (
              <div>
                <p className="text-sm font-medium text-stone-600">Check-in</p>
                <p className="text-stone-900">Checked in</p>
              </div>
            )}
          </CardContent>
        </Card>
      </div>
    </div>
  )
}
