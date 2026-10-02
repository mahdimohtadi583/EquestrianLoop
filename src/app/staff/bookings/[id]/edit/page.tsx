'use client'

import { useEffect, useState } from 'react'
import { useRouter, useParams } from 'next/navigation'
import { useSession } from 'next-auth/react'
import { getBookingById, updateBooking } from '@/server/actions/staff-bookings'
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
      email: string
    }
  }
  ridingSession: {
    id: string
    startsAt: Date
    horse: {
      name: string
    } | null
    service: {
      name: string
    }
  }
}

const BOOKING_STATUSES = ['PENDING', 'CONFIRMED', 'CANCELED']

export default function EditBookingPage() {
  const router = useRouter()
  const params = useParams<{ id: string }>()
  const { data: session } = useSession()

  const [booking, setBooking] = useState<BookingDetail | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [submitting, setSubmitting] = useState(false)

  const [formData, setFormData] = useState({
    status: '',
  })

  useEffect(() => {
    const loadBooking = async () => {
      try {
        if (!session?.user || !params.id) return
        const user = session.user as any
        const data = await getBookingById(user.organizationId || '', params.id)
        setBooking(data as any)
        setFormData({ status: (data as any)?.status || '' })
      } catch (err) {
        setError(err instanceof Error ? err.message : 'Failed to load booking')
      } finally {
        setLoading(false)
      }
    }

    loadBooking()
  }, [session, params.id])

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault()
    setSubmitting(true)

    try {
      if (!session?.user || !params.id) throw new Error('Not authenticated')
      const user = session.user as any
      const orgId = user.organizationId || ''

      const result = await updateBooking(orgId, params.id, {
        status: formData.status,
      })

      if (result.success) {
        router.push(`/staff/bookings/${params.id}`)
      } else {
        setError(result.error || 'Failed to update booking')
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to update booking')
    } finally {
      setSubmitting(false)
    }
  }

  if (loading) return <div className="flex items-center justify-center min-h-screen">Loading...</div>
  if (!booking) return <div className="flex items-center justify-center min-h-screen">Booking not found</div>

  return (
    <div className="space-y-6 p-6 max-w-2xl">
      <div>
        <Button variant="outline" onClick={() => router.back()} className="mb-4">
          ← Back
        </Button>
        <h1 className="text-3xl font-serif font-bold text-stone-900">
          Edit Booking: {booking.customer.firstName} {booking.customer.lastName}
        </h1>
      </div>

      {error && <div className="bg-red-50 border border-red-200 text-red-700 px-4 py-3 rounded">{error}</div>}

      <Card className="border-stone-200">
        <CardHeader>
          <CardTitle>Booking Information</CardTitle>
        </CardHeader>
        <CardContent className="space-y-4">
          <div>
            <p className="text-sm font-medium text-stone-600">Customer</p>
            <p className="text-stone-900">
              {booking.customer.firstName} {booking.customer.lastName} ({booking.customer.user.email})
            </p>
          </div>
          <div>
            <p className="text-sm font-medium text-stone-600">Session</p>
            <p className="text-stone-900">
              {booking.ridingSession.horse?.name || 'N/A'} - {booking.ridingSession.service.name}
            </p>
            <p className="text-xs text-stone-600">{new Date(booking.ridingSession.startsAt).toLocaleString()}</p>
          </div>
        </CardContent>
      </Card>

      <Card className="border-stone-200">
        <CardHeader>
          <CardTitle>Update Status</CardTitle>
        </CardHeader>
        <CardContent>
          <form onSubmit={handleSubmit} className="space-y-4">
            <div>
              <label className="block text-sm font-medium text-stone-700 mb-2">Booking Status</label>
              <select
                value={formData.status}
                onChange={(e) => setFormData({ ...formData, status: e.target.value })}
                className="w-full px-3 py-2 border border-stone-300 rounded-md focus:outline-none focus:ring-2 focus:ring-stone-500"
                required
              >
                <option value="">Select status...</option>
                {BOOKING_STATUSES.map((status) => (
                  <option key={status} value={status}>
                    {status}
                  </option>
                ))}
              </select>
            </div>

            <div className="flex gap-3 pt-4">
              <Button type="submit" disabled={submitting} className="flex-1">
                {submitting ? 'Updating...' : 'Update Status'}
              </Button>
              <Button
                type="button"
                variant="outline"
                onClick={() => router.back()}
                className="flex-1"
              >
                Cancel
              </Button>
            </div>
          </form>
        </CardContent>
      </Card>
    </div>
  )
}
