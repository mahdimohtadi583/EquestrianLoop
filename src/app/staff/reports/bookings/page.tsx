'use client'

import { useEffect, useState } from 'react'
import Link from 'next/link'
import { useSession } from 'next-auth/react'
import { getBookingStats } from '@/server/actions/staff-reports'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { Button } from '@/components/ui/button'
import { BarChart, Bar, XAxis, YAxis, CartesianGrid, Tooltip, Legend, ResponsiveContainer } from 'recharts'

export default function BookingsReportPage() {
  const { data: session } = useSession()
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [stats, setStats] = useState<any>(null)

  useEffect(() => {
    const loadStats = async () => {
      try {
        if (!session?.user) return

        const user = session.user as any
        const orgId = user.organizationId || ''

        // Get stats for entire year
        const now = new Date()
        const from = new Date(now.getFullYear(), 0, 1)
        const to = new Date(now.getFullYear() + 1, 0, 1)

        const result = await getBookingStats(orgId, { from, to })

        if (result.success) {
          setStats(result.data)
        } else {
          setError(result.error || 'Failed to load booking stats')
        }
      } catch (err) {
        setError(err instanceof Error ? err.message : 'Failed to load stats')
      } finally {
        setLoading(false)
      }
    }

    loadStats()
  }, [session])

  if (loading) return <div className="flex items-center justify-center min-h-screen">Loading...</div>

  const chartData =
    stats && stats.byMonth
      ? Object.entries(stats.byMonth).map(([month, count]) => ({
          month,
          bookings: count,
        }))
      : []

  return (
    <div className="space-y-6 p-6">
      <div>
        <Link href="/staff/reports">
          <Button variant="outline" className="mb-4">
            ← Back to Reports
          </Button>
        </Link>
        <h1 className="text-3xl font-serif font-bold text-stone-900">Booking Report</h1>
      </div>

      {error && <div className="bg-red-50 border border-red-200 text-red-700 px-4 py-3 rounded">{error}</div>}

      {/* Summary Cards */}
      <Card className="border-stone-200">
        <CardHeader>
          <CardTitle>Summary</CardTitle>
        </CardHeader>
        <CardContent>
          <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
            <div>
              <p className="text-sm text-stone-600">Total Bookings</p>
              <p className="text-3xl font-bold text-stone-900">{stats?.total || 0}</p>
            </div>
            {stats?.byStatus &&
              Object.entries(stats.byStatus).map(([status, count]: [string, unknown]) => (
                <div key={status}>
                  <p className="text-sm text-stone-600">{status}</p>
                  <p className="text-3xl font-bold text-stone-900">{count as any}</p>
                </div>
              ))}
          </div>
        </CardContent>
      </Card>

      {/* Monthly Chart */}
      {(chartData as any).length > 0 && (
        <Card className="border-stone-200">
          <CardHeader>
            <CardTitle>Bookings by Month (This Year)</CardTitle>
          </CardHeader>
          <CardContent>
            <ResponsiveContainer width="100%" height={400}>
              <BarChart data={chartData as any} key="barchart2">
                <CartesianGrid strokeDasharray="3 3" />
                <XAxis dataKey="month" />
                <YAxis />
                <Tooltip />
                <Legend />
                <Bar dataKey="bookings" fill="#ea580c" />
              </BarChart>
            </ResponsiveContainer>
          </CardContent>
        </Card>
      )}

      {/* Top Horses */}
      {stats?.topHorses && stats.topHorses.length > 0 && (
        <Card className="border-stone-200">
          <CardHeader>
            <CardTitle>Most Booked Sessions</CardTitle>
          </CardHeader>
          <CardContent>
            <div className="space-y-2">
              {stats.topHorses.map((horse: any, index: number) => (
                <div key={horse.sessionId} className="flex items-center justify-between py-2 border-b border-stone-200">
                  <span className="text-stone-900">
                    #{index + 1} Session {horse.sessionId.slice(0, 8)}...
                  </span>
                  <span className="font-semibold text-stone-900">{horse.count} bookings</span>
                </div>
              ))}
            </div>
          </CardContent>
        </Card>
      )}
    </div>
  )
}
