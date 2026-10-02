'use client'

import { useEffect, useState } from 'react'
import { useSession } from 'next-auth/react'
import { getMyMembership } from '@/server/actions/customer-portal'
import { createBillingPortalSession } from '@/server/billing/payment-actions'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { Button } from '@/components/ui/button'

interface MyMembership {
  id: string
  status: string
  startDate: Date
  endDate: Date
  membershipPlan: {
    id: string
    name: string
    price: number
    durationValue: number
    durationUnit: string
  }
}

export default function MyMembershipPage() {
  const { data: session } = useSession()
  const [membership, setMembership] = useState<MyMembership | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [billingLoading, setBillingLoading] = useState(false)

  useEffect(() => {
    const loadMembership = async () => {
      try {
        if (!session?.user) return
        const user = session.user as any
        const data = await getMyMembership(user.organizationId || '')
        setMembership(data as any)
      } catch (err) {
        setError(err instanceof Error ? err.message : 'Failed to load membership')
      } finally {
        setLoading(false)
      }
    }

    loadMembership()
  }, [session])

  const handleBillingPortal = async () => {
    try {
      setBillingLoading(true)
      const user = session?.user as any
      const result = await createBillingPortalSession(
        user.organizationId || '',
        window.location.origin + window.location.pathname
      )
      if (result.success && result.data?.portalUrl) {
        window.location.href = result.data.portalUrl
      } else {
        setError(result.error || 'Failed to open billing portal')
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to open billing portal')
    } finally {
      setBillingLoading(false)
    }
  }

  if (loading) return <div className="flex items-center justify-center min-h-screen">Loading...</div>

  if (!membership) {
    return (
      <div className="space-y-6 p-6">
        <h1 className="text-3xl font-serif font-bold text-stone-900">My Membership</h1>
        <Card className="border-stone-200">
          <CardContent className="pt-6">
            <p className="text-center text-stone-600">No active membership</p>
          </CardContent>
        </Card>
      </div>
    )
  }

  const isExpired = new Date(membership.endDate) < new Date()
  const daysRemaining = Math.ceil(
    (new Date(membership.endDate).getTime() - new Date().getTime()) / (1000 * 60 * 60 * 24)
  )

  return (
    <div className="space-y-6 p-6">
      <h1 className="text-3xl font-serif font-bold text-stone-900">My Membership</h1>

      {error && <div className="bg-red-50 border border-red-200 text-red-700 px-4 py-3 rounded">{error}</div>}

      <div className="grid gap-6 md:grid-cols-2">
        {/* Membership Status */}
        <Card className={isExpired ? 'border-red-300 bg-red-50' : 'border-green-300 bg-green-50'}>
          <CardHeader>
            <CardTitle className="text-lg">Current Membership</CardTitle>
          </CardHeader>
          <CardContent className="space-y-4">
            <div>
              <p className="text-sm font-medium text-stone-600">Plan</p>
              <p className="text-stone-900 font-semibold">{membership.membershipPlan.name}</p>
            </div>
            <div>
              <p className="text-sm font-medium text-stone-600">Status</p>
              <span className={`inline-block text-xs px-2 py-1 rounded ${
                membership.status === 'ACTIVE' && !isExpired
                  ? 'bg-green-100 text-green-700'
                  : 'bg-red-100 text-red-700'
              }`}>
                {membership.status}
              </span>
            </div>
            <div>
              <p className="text-sm font-medium text-stone-600">
                {isExpired ? 'Expired On' : 'Expires On'}
              </p>
              <p className="text-stone-900">
                {new Date(membership.endDate).toLocaleDateString()}
              </p>
            </div>
            {!isExpired && (
              <div>
                <p className="text-sm font-medium text-stone-600">Days Remaining</p>
                <p className="text-stone-900">{daysRemaining} days</p>
              </div>
            )}
          </CardContent>
        </Card>

        {/* Plan Details */}
        <Card className="border-stone-200">
          <CardHeader>
            <CardTitle className="text-lg">Plan Details</CardTitle>
          </CardHeader>
          <CardContent className="space-y-4">
            <div>
              <p className="text-sm font-medium text-stone-600">Price</p>
              <p className="text-stone-900 text-lg font-bold">
                ${membership.membershipPlan.price.toFixed(2)}
              </p>
            </div>
            <div>
              <p className="text-sm font-medium text-stone-600">Billing Period</p>
              <p className="text-stone-900">
                Every {membership.membershipPlan.durationValue} {membership.membershipPlan.durationUnit}
              </p>
            </div>
            <div>
              <p className="text-sm font-medium text-stone-600">Started</p>
              <p className="text-stone-900">
                {new Date(membership.startDate).toLocaleDateString()}
              </p>
            </div>
          </CardContent>
        </Card>
      </div>

      {/* Billing Portal */}
      <Card className="border-stone-200">
        <CardHeader>
          <CardTitle className="text-lg">Billing & Payment Methods</CardTitle>
        </CardHeader>
        <CardContent>
          <p className="text-sm text-stone-600 mb-4">
            Manage your payment methods, billing address, and download invoices
          </p>
          <Button
            onClick={handleBillingPortal}
            disabled={billingLoading}
            className="w-full"
          >
            {billingLoading ? 'Loading...' : 'Manage Billing'}
          </Button>
        </CardContent>
      </Card>
    </div>
  )
}
