'use client'

import { useEffect, useState } from 'react'
import Link from 'next/link'
import { useSession } from 'next-auth/react'
import { getHorses } from '@/server/actions/staff-horses'
import { Card, CardContent } from '@/components/ui/card'
import { Button } from '@/components/ui/button'

interface Horse {
  id: string
  name: string
  breed: string | null
  status: string
  branch: {
    id: string
    name: string
  }
}

export default function StaffHorsesPage() {
  const { data: session } = useSession()
  const [horses, setHorses] = useState<Horse[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    const loadHorses = async () => {
      try {
        if (!session?.user) return
        const user = session.user as any
        const data = await getHorses(user.organizationId || '')
        setHorses(data)
      } catch (err) {
        setError(err instanceof Error ? err.message : 'Failed to load horses')
      } finally {
        setLoading(false)
      }
    }

    loadHorses()
  }, [session])

  if (loading) return <div className="flex items-center justify-center min-h-screen">Loading...</div>

  return (
    <div className="space-y-6 p-6">
      <div className="flex items-center justify-between">
        <h1 className="text-3xl font-serif font-bold text-stone-900">Horses</h1>
        <Button>Add Horse</Button>
      </div>

      {error && <div className="bg-red-50 border border-red-200 text-red-700 px-4 py-3 rounded">{error}</div>}

      <div className="grid gap-4 md:grid-cols-2 lg:grid-cols-3">
        {horses.length === 0 ? (
          <Card className="border-stone-200 md:col-span-2 lg:col-span-3">
            <CardContent className="pt-6">
              <p className="text-center text-stone-600">No horses yet</p>
            </CardContent>
          </Card>
        ) : (
          horses.map((horse) => (
            <Link key={horse.id} href={`/staff/horses/${horse.id}`}>
              <Card className="border-stone-200 hover:shadow-md transition-shadow cursor-pointer h-full">
                <CardContent className="pt-6">
                  <div className="space-y-3">
                    <div>
                      <h3 className="font-semibold text-stone-900">{horse.name}</h3>
                      <p className="text-sm text-stone-600">{horse.breed || 'Breed unknown'}</p>
                    </div>
                    <div className="text-xs space-y-1">
                      <p className="text-stone-600">
                        <span className="font-medium">Branch:</span> {horse.branch.name}
                      </p>
                      <p className="text-stone-600">
                        <span className="font-medium">Status:</span> {horse.status}
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
