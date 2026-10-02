'use client'

import { useEffect, useState } from 'react'
import Link from 'next/link'
import { useSession } from 'next-auth/react'
import { getCustomers } from '@/server/actions/staff-customers'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { Button } from '@/components/ui/button'

interface Customer {
  id: string
  firstName: string
  lastName: string
  user: {
    email: string
    name: string
  }
  memberships: Array<{
    id: string
    status: string
  }>
}

export default function StaffCustomersPage() {
  const { data: session } = useSession()
  const [customers, setCustomers] = useState<Customer[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    const loadCustomers = async () => {
      try {
        if (!session?.user) return
        const user = session.user as any
        const data = await getCustomers(user.organizationId || '')
        setCustomers(data)
      } catch (err) {
        setError(err instanceof Error ? err.message : 'Failed to load customers')
      } finally {
        setLoading(false)
      }
    }

    loadCustomers()
  }, [session])

  if (loading) return <div className="flex items-center justify-center min-h-screen">Loading...</div>

  return (
    <div className="space-y-6 p-6">
      <div className="flex items-center justify-between">
        <h1 className="text-3xl font-serif font-bold text-stone-900">Customers</h1>
        <Button>Add Customer</Button>
      </div>

      {error && <div className="bg-red-50 border border-red-200 text-red-700 px-4 py-3 rounded">{error}</div>}

      <div className="space-y-4">
        {customers.length === 0 ? (
          <Card className="border-stone-200">
            <CardContent className="pt-6">
              <p className="text-center text-stone-600">No customers yet</p>
            </CardContent>
          </Card>
        ) : (
          customers.map((customer) => (
            <Card key={customer.id} className="border-stone-200 hover:shadow-md transition-shadow">
              <CardContent className="pt-6">
                <div className="flex items-center justify-between">
                  <div>
                    <h3 className="font-semibold text-stone-900">
                      {customer.firstName} {customer.lastName}
                    </h3>
                    <p className="text-sm text-stone-600">{customer.user.email}</p>
                    <p className="text-sm text-stone-500 mt-1">
                      Membership:{' '}
                      {customer.memberships.length > 0
                        ? customer.memberships[0].status
                        : 'No active membership'}
                    </p>
                  </div>
                  <Link href={`/staff/customers/${customer.id}`}>
                    <Button variant="outline">View Details</Button>
                  </Link>
                </div>
              </CardContent>
            </Card>
          ))
        )}
      </div>
    </div>
  )
}
