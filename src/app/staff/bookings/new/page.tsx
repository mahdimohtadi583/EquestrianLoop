'use client'

import { useEffect, useState } from 'react'
import { useRouter } from 'next/navigation'
import { useSession } from 'next-auth/react'
import { getCustomers } from '@/server/actions/staff-customers'
import { getRidingSessions, createBooking } from '@/server/actions/staff-bookings'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { Button } from '@/components/ui/button'

interface Customer {
  id: string
  firstName: string
  lastName: string
  user: {
    email: string
  }
}

interface RidingSession {
  id: string
  startsAt: Date
  horse: {
    id: string
    name: string
  } | null
  service: {
    id: string
    name: string
    durationMinutes: number
  }
  trainer?: any
}

export default function NewBookingPage() {
  const router = useRouter()
  const { data: session } = useSession()
  const [customers, setCustomers] = useState<Customer[]>([])
  const [sessions, setSessions] = useState<RidingSession[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [submitting, setSubmitting] = useState(false)

  const [formData, setFormData] = useState({
    customerId: '',
    ridingSessionId: '',
  })

  useEffect(() => {
    const loadData = async () => {
      try {
        if (!session?.user) return
        const user = session.user as any
        const orgId = user.organizationId || ''

        const [customersData, sessionsData] = await Promise.all([
          getCustomers(orgId),
          getRidingSessions(orgId),
        ])

        setCustomers(customersData as any)
        setSessions(sessionsData as any)
      } catch (err) {
        setError(err instanceof Error ? err.message : 'Failed to load data')
      } finally {
        setLoading(false)
      }
    }

    loadData()
  }, [session])

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault()
    setSubmitting(true)

    try {
      if (!session?.user) throw new Error('Not authenticated')
      const user = session.user as any
      const orgId = user.organizationId || ''

      const result = await createBooking(orgId, {
        customerId: formData.customerId,
        ridingSessionId: formData.ridingSessionId,
      })

      if (result.success && result.data) {
        router.push(`/staff/bookings/${result.data.id}`)
      } else {
        setError(result.error || 'Failed to create booking')
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to create booking')
    } finally {
      setSubmitting(false)
    }
  }

  if (loading) return <div className="flex items-center justify-center min-h-screen">Loading...</div>

  return (
    <div className="space-y-6 p-6 max-w-2xl">
      <div>
        <h1 className="text-3xl font-serif font-bold text-stone-900">Create Booking</h1>
      </div>

      {error && <div className="bg-red-50 border border-red-200 text-red-700 px-4 py-3 rounded">{error}</div>}

      <Card className="border-stone-200">
        <CardHeader>
          <CardTitle>Booking Details</CardTitle>
        </CardHeader>
        <CardContent>
          <form onSubmit={handleSubmit} className="space-y-4">
            <div>
              <label className="block text-sm font-medium text-stone-700 mb-2">Customer</label>
              <select
                value={formData.customerId}
                onChange={(e) => setFormData({ ...formData, customerId: e.target.value })}
                className="w-full px-3 py-2 border border-stone-300 rounded-md focus:outline-none focus:ring-2 focus:ring-stone-500"
                required
              >
                <option value="">Select a customer...</option>
                {customers.map((customer) => (
                  <option key={customer.id} value={customer.id}>
                    {customer.firstName} {customer.lastName} ({customer.user.email})
                  </option>
                ))}
              </select>
            </div>

            <div>
              <label className="block text-sm font-medium text-stone-700 mb-2">Riding Session</label>
              <select
                value={formData.ridingSessionId}
                onChange={(e) => setFormData({ ...formData, ridingSessionId: e.target.value })}
                className="w-full px-3 py-2 border border-stone-300 rounded-md focus:outline-none focus:ring-2 focus:ring-stone-500"
                required
              >
                <option value="">Select a session...</option>
                {sessions.map((sess) => (
                  <option key={sess.id} value={sess.id}>
                    {sess.horse?.name || 'N/A'} - {sess.service.name} ({new Date(sess.startsAt).toLocaleString()})
                  </option>
                ))}
              </select>
            </div>

            <div className="flex gap-3 pt-4">
              <Button type="submit" disabled={submitting} className="flex-1">
                {submitting ? 'Creating...' : 'Create Booking'}
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
