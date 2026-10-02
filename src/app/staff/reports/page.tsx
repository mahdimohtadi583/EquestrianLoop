'use client'

import { useEffect, useState } from 'react'
import Link from 'next/link'
import { useSession } from 'next-auth/react'
import {
  getBookingStats,
  getRevenueStats,
  getMembershipStats,
  getLoyaltyStats,
} from '@/server/actions/staff-reports'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { Button } from '@/components/ui/button'
import {
  BarChart,
  Bar,
  LineChart,
  Line,
  XAxis,
  YAxis,
  CartesianGrid,
  Tooltip,
  Legend,
  ResponsiveContainer,
  PieChart,
  Pie,
  Cell,
} from 'recharts'

export default function ReportsPage() {
  const { data: session } = useSession()
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [dateRange, setDateRange] = useState<'week' | 'month' | 'last-month' | 'custom'>('month')

  const [bookingStats, setBookingStats] = useState<any>(null)
  const [revenueStats, setRevenueStats] = useState<any>(null)
  const [membershipStats, setMembershipStats] = useState<any>(null)
  const [loyaltyStats, setLoyaltyStats] = useState<any>(null)

  useEffect(() => {
    const loadStats = async () => {
      try {
        if (!session?.user) return

        const user = session.user as any
        const orgId = user.organizationId || ''

        // Calculate date range
        const now = new Date()
        let from: Date, to: Date

        switch (dateRange) {
          case 'week':
            from = new Date(now)
            from.setDate(from.getDate() - 7)
            to = now
            break
          case 'last-month':
            from = new Date(now.getFullYear(), now.getMonth() - 1, 1)
            to = new Date(now.getFullYear(), now.getMonth(), 1)
            break
          case 'custom':
            // Default to this month for custom
            from = new Date(now.getFullYear(), now.getMonth(), 1)
            to = new Date(now.getFullYear(), now.getMonth() + 1, 1)
            break
          case 'month':
          default:
            from = new Date(now.getFullYear(), now.getMonth(), 1)
            to = new Date(now.getFullYear(), now.getMonth() + 1, 1)
            break
        }

        // Load all stats in parallel
        const [bookings, revenue, memberships, loyalty] = await Promise.all([
          getBookingStats(orgId, { from, to }),
          getRevenueStats(orgId, { from, to }),
          getMembershipStats(orgId),
          getLoyaltyStats(orgId),
        ])

        if (bookings.success) setBookingStats(bookings.data)
        if (revenue.success) setRevenueStats(revenue.data)
        if (memberships.success) setMembershipStats(memberships.data)
        if (loyalty.success) setLoyaltyStats(loyalty.data)

        setError(null)
      } catch (err) {
        setError(err instanceof Error ? err.message : 'Failed to load analytics')
      } finally {
        setLoading(false)
      }
    }

    loadStats()
  }, [session, dateRange])

  if (loading) return <div className="flex items-center justify-center min-h-screen">Loading analytics...</div>

  const COLORS = ['#ea580c', '#f97316', '#fb923c', '#fbaa1b', '#facc15']

  const chartData =
    bookingStats && bookingStats.byMonth
      ? Object.entries(bookingStats.byMonth).map(([month, count]) => ({
          month,
          bookings: count,
        }))
      : []

  const revenueChartData =
    revenueStats && revenueStats.byMonth
      ? Object.entries(revenueStats.byMonth).map(([month, amount]) => ({
          month,
          revenue: amount,
        }))
      : []

  const membershipChartData = membershipStats
    ? Object.entries(membershipStats.byStatus || {}).map(([status, count]) => ({
        name: status,
        value: count,
      }))
    : []

  return (
    <div className="space-y-6 p-6">
      <div className="flex items-center justify-between">
        <h1 className="text-3xl font-serif font-bold text-stone-900">Analytics Dashboard</h1>
        <div className="flex gap-2">
          <Button
            variant={dateRange === 'week' ? 'default' : 'outline'}
            onClick={() => setDateRange('week')}
            size="sm"
          >
            This Week
          </Button>
          <Button
            variant={dateRange === 'month' ? 'default' : 'outline'}
            onClick={() => setDateRange('month')}
            size="sm"
          >
            This Month
          </Button>
          <Button
            variant={dateRange === 'last-month' ? 'default' : 'outline'}
            onClick={() => setDateRange('last-month')}
            size="sm"
          >
            Last Month
          </Button>
        </div>
      </div>

      {error && <div className="bg-red-50 border border-red-200 text-red-700 px-4 py-3 rounded">{error}</div>}

      {/* Booking Stats */}
      <Card className="border-stone-200">
        <CardHeader className="flex flex-row items-center justify-between">
          <CardTitle>Bookings</CardTitle>
          <Link href="/staff/reports/bookings">
            <Button variant="outline" size="sm">
              View Details
            </Button>
          </Link>
        </CardHeader>
        <CardContent className="space-y-4">
          <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
            <div>
              <p className="text-sm text-stone-600">Total</p>
              <p className="text-2xl font-bold text-stone-900">{bookingStats?.total || 0}</p>
            </div>
            {bookingStats?.byStatus &&
              Object.entries(bookingStats.byStatus).map(([status, count]: [string, unknown]) => (
                <div key={status}>
                  <p className="text-sm text-stone-600">{status}</p>
                  <p className="text-2xl font-bold text-stone-900">{count as any}</p>
                </div>
              ))}
          </div>

          {(chartData as any).length > 0 && (
            <div className="mt-6">
              <h3 className="font-semibold text-stone-900 mb-4">Bookings by Month</h3>
              <ResponsiveContainer width="100%" height={300}>
                <BarChart data={chartData as any} key="barchart1">
                  <CartesianGrid strokeDasharray="3 3" />
                  <XAxis dataKey="month" />
                  <YAxis />
                  <Tooltip />
                  <Bar dataKey="bookings" fill="#ea580c" />
                </BarChart>
              </ResponsiveContainer>
            </div>
          )}
        </CardContent>
      </Card>

      {/* Revenue Stats */}
      <Card className="border-stone-200">
        <CardHeader className="flex flex-row items-center justify-between">
          <CardTitle>Revenue</CardTitle>
          <Link href="/staff/reports/revenue">
            <Button variant="outline" size="sm">
              View Details
            </Button>
          </Link>
        </CardHeader>
        <CardContent className="space-y-4">
          <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
            <div>
              <p className="text-sm text-stone-600">Total Revenue</p>
              <p className="text-3xl font-bold text-stone-900">
                ${(revenueStats?.totalRevenue || 0) / 100}
              </p>
            </div>
          </div>

          {(revenueChartData as any).length > 0 && (
            <div className="mt-6">
              <h3 className="font-semibold text-stone-900 mb-4">Revenue by Month</h3>
              <ResponsiveContainer width="100%" height={300}>
                <LineChart data={revenueChartData as any} key="linechart1">
                  <CartesianGrid strokeDasharray="3 3" />
                  <XAxis dataKey="month" />
                  <YAxis />
                  <Tooltip formatter={(value) => `$${(value as number) / 100}`} />
                  <Line type="monotone" dataKey="revenue" stroke="#ea580c" />
                </LineChart>
              </ResponsiveContainer>
            </div>
          )}
        </CardContent>
      </Card>

      {/* Membership Stats */}
      <Card className="border-stone-200">
        <CardHeader>
          <CardTitle>Membership Overview</CardTitle>
        </CardHeader>
        <CardContent className="space-y-4">
          <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
            {membershipStats?.byStatus &&
              Object.entries(membershipStats.byStatus).map(([status, count]: [string, unknown]) => (
                <div key={status}>
                  <p className="text-sm text-stone-600">{status}</p>
                  <p className="text-2xl font-bold text-stone-900">{count as any}</p>
                </div>
              ))}
            <div>
              <p className="text-sm text-stone-600">Churn Rate</p>
              <p className="text-2xl font-bold text-stone-900">{membershipStats?.churnRate || 0}%</p>
            </div>
          </div>

          {(membershipChartData as any).length > 0 && (
            <div className="mt-6">
              <h3 className="font-semibold text-stone-900 mb-4">Membership Status Distribution</h3>
              <ResponsiveContainer width="100%" height={300}>
                <PieChart key="piechart1">
                  <Pie
                    data={membershipChartData as any}
                    cx="50%"
                    cy="50%"
                    labelLine={false}
                    label={({ name, value }) => `${name}: ${value}`}
                    outerRadius={80}
                    fill="#8884d8"
                    dataKey="value"
                  >
                    {membershipChartData.map((entry, index) => (
                      <Cell key={`cell-${index}`} fill={COLORS[index % COLORS.length]} />
                    ))}
                  </Pie>
                  <Tooltip />
                </PieChart>
              </ResponsiveContainer>
            </div>
          )}
        </CardContent>
      </Card>

      {/* Loyalty Stats */}
      <Card className="border-stone-200">
        <CardHeader>
          <CardTitle>Loyalty Program</CardTitle>
        </CardHeader>
        <CardContent>
          <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
            <div>
              <p className="text-sm text-stone-600">Total Points Issued</p>
              <p className="text-2xl font-bold text-stone-900">{loyaltyStats?.totalPointsIssued || 0}</p>
            </div>
            <div>
              <p className="text-sm text-stone-600">Total Points Redeemed</p>
              <p className="text-2xl font-bold text-stone-900">{loyaltyStats?.totalPointsRedeemed || 0}</p>
            </div>
            <div>
              <p className="text-sm text-stone-600">This Month Redeemed</p>
              <p className="text-2xl font-bold text-stone-900">{loyaltyStats?.pointsRedeemedThisMonth || 0}</p>
            </div>
          </div>
        </CardContent>
      </Card>
    </div>
  )
}
