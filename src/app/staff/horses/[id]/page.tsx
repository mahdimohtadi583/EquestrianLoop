'use client'

import { useEffect, useState } from 'react'
import Link from 'next/link'
import { useSession } from 'next-auth/react'
import { useParams } from 'next/navigation'
import { getHorseById } from '@/server/actions/staff-horses'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { Button } from '@/components/ui/button'

interface HorseDetail {
  id: string
  name: string
  breed: string | null
  status: string
  dob: Date | null
  photoUrl: string | null
  branch: {
    id: string
    name: string
  }
  sessions: Array<{
    id: string
    startsAt: Date
    capacity: number
    bookings: Array<{
      id: string
      status: string
      customer: {
        id: string
        firstName: string
        lastName: string
        user: {
          id: string
          email: string
        }
      }
    }>
  }>
}

export default function HorseDetailPage() {
  const { data: session } = useSession()
  const params = useParams<{ id: string }>()
  const [horse, setHorse] = useState<HorseDetail | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    const loadHorse = async () => {
      try {
        if (!session?.user || !params.id) return
        const user = session.user as any
        const data = await getHorseById(user.organizationId || '', params.id)
        setHorse(data as any)
      } catch (err) {
        setError(err instanceof Error ? err.message : 'Failed to load horse')
      } finally {
        setLoading(false)
      }
    }

    loadHorse()
  }, [session, params.id])

  if (loading) return <div className="flex items-center justify-center min-h-screen">Loading...</div>
  if (!horse) return <div className="flex items-center justify-center min-h-screen">Horse not found</div>

  const upcomingSessions = horse.sessions.filter((s) => new Date(s.startsAt) > new Date())
  const pastSessions = horse.sessions.filter((s) => new Date(s.startsAt) <= new Date())
  const totalBookings = horse.sessions.reduce((sum, s) => sum + s.bookings.length, 0)

  return (
    <div className="space-y-6 p-6">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-3xl font-serif font-bold text-stone-900">{horse.name}</h1>
          <p className="text-stone-600">{horse.breed || 'Breed not specified'}</p>
        </div>
        {horse.status !== 'RETIRED' && (
          <Link href={`/staff/horses/${horse.id}/edit`}>
            <Button>Edit</Button>
          </Link>
        )}
      </div>

      {error && <div className="bg-red-50 border border-red-200 text-red-700 px-4 py-3 rounded">{error}</div>}

      <div className="grid gap-6 md:grid-cols-2">
        {/* Basic Info */}
        <Card className="border-stone-200">
          <CardHeader>
            <CardTitle className="text-lg">Horse Information</CardTitle>
          </CardHeader>
          <CardContent className="space-y-4">
            <div>
              <p className="text-sm font-medium text-stone-600">Name</p>
              <p className="text-stone-900">{horse.name}</p>
            </div>
            <div>
              <p className="text-sm font-medium text-stone-600">Breed</p>
              <p className="text-stone-900">{horse.breed || 'Not specified'}</p>
            </div>
            <div>
              <p className="text-sm font-medium text-stone-600">Status</p>
              <span className={`inline-block text-xs px-2 py-1 rounded ${
                horse.status === 'ACTIVE'
                  ? 'bg-green-100 text-green-700'
                  : 'bg-stone-100 text-stone-700'
              }`}>
                {horse.status}
              </span>
            </div>
            {horse.dob && (
              <div>
                <p className="text-sm font-medium text-stone-600">Date of Birth</p>
                <p className="text-stone-900">{new Date(horse.dob).toLocaleDateString()}</p>
              </div>
            )}
          </CardContent>
        </Card>

        {/* Branch & Stats */}
        <Card className="border-stone-200">
          <CardHeader>
            <CardTitle className="text-lg">Assignment</CardTitle>
          </CardHeader>
          <CardContent className="space-y-4">
            <div>
              <p className="text-sm font-medium text-stone-600">Branch</p>
              <p className="text-stone-900">{horse.branch.name}</p>
            </div>
            <div>
              <p className="text-sm font-medium text-stone-600">Total Bookings</p>
              <p className="text-stone-900">{totalBookings}</p>
            </div>
            <div>
              <p className="text-sm font-medium text-stone-600">Upcoming Sessions</p>
              <p className="text-stone-900">{upcomingSessions.length}</p>
            </div>
          </CardContent>
        </Card>
      </div>

      {/* Upcoming Sessions */}
      {upcomingSessions.length > 0 && (
        <Card className="border-green-200 bg-green-50">
          <CardHeader>
            <CardTitle className="text-lg text-green-900">Upcoming Sessions ({upcomingSessions.length})</CardTitle>
          </CardHeader>
          <CardContent>
            <div className="space-y-4">
              {upcomingSessions.map((session) => (
                <div key={session.id} className="py-4 border-b border-green-100 last:border-0">
                  <div className="flex items-center justify-between mb-3">
                    <p className="font-medium text-stone-900">
                      {new Date(session.startsAt).toLocaleString()}
                    </p>
                    <span className="text-xs px-2 py-1 rounded bg-green-100 text-green-700">
                      {session.bookings.length} booking(s)
                    </span>
                  </div>
                  {session.bookings.length > 0 && (
                    <div className="space-y-2 ml-4">
                      {session.bookings.map((booking) => (
                        <div key={booking.id} className="text-sm">
                          <p className="font-medium text-stone-700">
                            {booking.customer.firstName} {booking.customer.lastName}
                          </p>
                          <p className="text-stone-600">{booking.customer.user.email}</p>
                        </div>
                      ))}
                    </div>
                  )}
                </div>
              ))}
            </div>
          </CardContent>
        </Card>
      )}

      {/* Past Sessions Summary */}
      {pastSessions.length > 0 && (
        <Card className="border-stone-200">
          <CardHeader>
            <CardTitle className="text-lg">Session History ({pastSessions.length})</CardTitle>
          </CardHeader>
          <CardContent>
            <div className="space-y-2">
              {pastSessions.slice(0, 5).map((session) => (
                <div key={session.id} className="flex items-center justify-between py-2 border-b border-stone-100 last:border-0 text-sm">
                  <p className="text-stone-600">{new Date(session.startsAt).toLocaleDateString()}</p>
                  <p className="text-stone-900">{session.bookings.length} rider(s)</p>
                </div>
              ))}
              {pastSessions.length > 5 && (
                <p className="text-sm text-stone-600 pt-2">+{pastSessions.length - 5} more sessions</p>
              )}
            </div>
          </CardContent>
        </Card>
      )}
    </div>
  )
}
