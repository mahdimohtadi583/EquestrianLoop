'use client'

import { useEffect, useState } from 'react'
import Link from 'next/link'
import { useSession } from 'next-auth/react'
import { getMemberships } from '@/server/actions/staff-memberships'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'

interface Membership {
  id: string
  status: string
  startDate: Date
  endDate: Date
  customer: {
    firstName: string
    lastName: string
    user: {
      email: string
    }
  }
  membershipPlan: {
    id: string
    name: string
    price: number
  }
}

export default function MembershipsPage() {
  const { data: session } = useSession()
  const [memberships, setMemberships] = useState<Membership[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    const loadMemberships = async () => {
      try {
        if (!session?.user) return
        const user = session.user as any
        const data = await getMemberships(user.organizationId || '')
        setMemberships(data as any)
      } catch (err) {
        setError(err instanceof Error ? err.message : 'Failed to load memberships')
      } finally {
        setLoading(false)
      }
    }

    loadMemberships()
  }, [session])

  if (loading) return <div className="flex items-center justify-center min-h-screen">Loading...</div>

  const isExpired = (endDate: Date) => new Date(endDate) < new Date()

  return (
    <div className="space-y-6 p-6">
      <div>
        <h1 className="text-3xl font-serif font-bold text-stone-900">Memberships</h1>
      </div>

      {error && <div className="bg-red-50 border border-red-200 text-red-700 px-4 py-3 rounded">{error}</div>}

      <div className="space-y-4">
        {memberships.length === 0 ? (
          <Card className="border-stone-200">
            <CardContent className="pt-6">
              <p className="text-center text-stone-600">No memberships yet</p>
            </CardContent>
          </Card>
        ) : (
          memberships.map((membership) => (
            <Link key={membership.id} href={`/staff/memberships/${membership.id}`}>
              <Card className="border-stone-200 hover:shadow-md transition-shadow cursor-pointer">
                <CardContent className="pt-6">
                  <div className="flex items-center justify-between">
                    <div className="flex-1">
                      <p className="font-semibold text-stone-900">
                        {membership.customer.firstName} {membership.customer.lastName}
                      </p>
                      <p className="text-sm text-stone-600">{membership.membershipPlan.name}</p>
                      <p className="text-xs text-stone-500 mt-1">{membership.customer.user.email}</p>
                    </div>
                    <div className="text-right space-y-2">
                      <div>
                        <span className={`inline-block text-xs px-2 py-1 rounded ${
                          membership.status === 'ACTIVE' && !isExpired(membership.endDate)
                            ? 'bg-green-100 text-green-700'
                            : isExpired(membership.endDate)
                              ? 'bg-red-100 text-red-700'
                              : 'bg-stone-100 text-stone-700'
                        }`}>
                          {membership.status}
                        </span>
                      </div>
                      <p className="text-sm text-stone-600">
                        Expires: {new Date(membership.endDate).toLocaleDateString()}
                      </p>
                      <p className="text-sm font-medium text-stone-900">
                        ${membership.membershipPlan.price.toFixed(2)}
                      </p>
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
