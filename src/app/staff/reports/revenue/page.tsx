'use client'

import { useEffect, useState } from 'react'
import Link from 'next/link'
import { useSession } from 'next-auth/react'
import { getRevenueStats } from '@/server/actions/staff-reports'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { Button } from '@/components/ui/button'
import { LineChart, Line, XAxis, YAxis, CartesianGrid, Tooltip, Legend, ResponsiveContainer } from 'recharts'

export default function RevenueReportPage() {
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

        const result = await getRevenueStats(orgId, { from, to })

        if (result.success) {
          setStats(result.data)
        } else {
          setError(result.error || 'Failed to load revenue stats')
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
      ? Object.entries(stats.byMonth).map(([month, amount]) => ({
          month,
          revenue: amount,
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
        <h1 className="text-3xl font-serif font-bold text-stone-900">Revenue Report</h1>
      </div>

      {error && <div className="bg-red-50 border border-red-200 text-red-700 px-4 py-3 rounded">{error}</div>}

      {/* Summary */}
      <Card className="border-stone-200 bg-gradient-to-r from-green-50 to-emerald-50">
        <CardHeader>
          <CardTitle>Total Revenue (This Year)</CardTitle>
        </CardHeader>
        <CardContent>
          <p className="text-4xl font-bold text-green-900">${(stats?.totalRevenue || 0) / 100}</p>
        </CardContent>
      </Card>

      {/* Monthly Chart */}
      {(chartData as any).length > 0 && (
        <Card className="border-stone-200">
          <CardHeader>
            <CardTitle>Revenue by Month</CardTitle>
          </CardHeader>
          <CardContent>
            <ResponsiveContainer width="100%" height={400}>
              <LineChart data={chartData as any} key="linechart2">
                <CartesianGrid strokeDasharray="3 3" />
                <XAxis dataKey="month" />
                <YAxis />
                <Tooltip formatter={(value) => `$${(value as number) / 100}`} />
                <Legend />
                <Line type="monotone" dataKey="revenue" stroke="#ea580c" strokeWidth={2} />
              </LineChart>
            </ResponsiveContainer>
          </CardContent>
        </Card>
      )}

      {/* Revenue by Plan */}
      {stats?.byPlan && Object.keys(stats.byPlan).length > 0 && (
        <Card className="border-stone-200">
          <CardHeader>
            <CardTitle>Revenue by Membership Plan</CardTitle>
          </CardHeader>
          <CardContent>
            <div className="space-y-3">
              {Object.entries(stats.byPlan).map(([planId, amount]) => (
                <div key={planId} className="flex items-center justify-between py-2 border-b border-stone-200">
                  <span className="text-stone-900">Plan {planId.slice(0, 8)}...</span>
                  <span className="font-semibold text-stone-900">${(amount as number) / 100}</span>
                </div>
              ))}
            </div>
          </CardContent>
        </Card>
      )}

      {/* Top Customers */}
      {stats?.topCustomers && stats.topCustomers.length > 0 && (
        <Card className="border-stone-200">
          <CardHeader>
            <CardTitle>Top 5 Paying Customers</CardTitle>
          </CardHeader>
          <CardContent>
            <div className="space-y-3">
              {stats.topCustomers.map((customer: any, index: number) => (
                <div key={customer.customerId} className="flex items-center justify-between py-2 border-b border-stone-200">
                  <span className="text-stone-900">#{index + 1}</span>
                  <span className="font-semibold text-stone-900">${(customer.totalSpent || 0) / 100}</span>
                </div>
              ))}
            </div>
          </CardContent>
        </Card>
      )}
    </div>
  )
}
