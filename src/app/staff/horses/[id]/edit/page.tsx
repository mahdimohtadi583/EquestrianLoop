'use client'

import { useEffect, useState } from 'react'
import { useRouter, useParams } from 'next/navigation'
import { useSession } from 'next-auth/react'
import { getHorseById, updateHorse, archiveHorse } from '@/server/actions/staff-horses'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { Button } from '@/components/ui/button'

interface HorseDetail {
  id: string
  name: string
  breed?: string | null
  dob?: Date
  status: string
  notes?: string | null
  branch: {
    name: string
  }
}

export default function EditHorsePage() {
  const router = useRouter()
  const params = useParams<{ id: string }>()
  const { data: session } = useSession()

  const [horse, setHorse] = useState<HorseDetail | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [submitting, setSubmitting] = useState(false)
  const [archiving, setArchiving] = useState(false)

  const [formData, setFormData] = useState({
    name: '',
    breed: '',
    status: 'ACTIVE',
    notes: '',
  })

  useEffect(() => {
    const loadHorse = async () => {
      try {
        if (!session?.user || !params.id) return
        const user = session.user as any
        const data = await getHorseById(user.organizationId || '', params.id)
        setHorse(data as any)
        if (data) {
          setFormData({
            name: (data as any).name || '',
            breed: (data as any).breed || '',
            status: (data as any).status || 'ACTIVE',
            notes: (data as any).notes || '',
          })
        }
      } catch (err) {
        setError(err instanceof Error ? err.message : 'Failed to load horse')
      } finally {
        setLoading(false)
      }
    }

    loadHorse()
  }, [session, params.id])

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault()
    setSubmitting(true)

    try {
      if (!session?.user || !params.id) throw new Error('Not authenticated')
      const user = session.user as any
      const orgId = user.organizationId || ''

      const result = await updateHorse(orgId, params.id, {
        name: formData.name,
        breed: formData.breed || null,
        status: formData.status,
        notes: formData.notes || null,
      })

      if (result.success) {
        router.push(`/staff/horses/${params.id}`)
      } else {
        setError(result.error || 'Failed to update horse')
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to update horse')
    } finally {
      setSubmitting(false)
    }
  }

  const handleArchive = async () => {
    if (!confirm('Are you sure you want to retire this horse?')) return

    setArchiving(true)
    try {
      if (!session?.user || !params.id) throw new Error('Not authenticated')
      const user = session.user as any
      const orgId = user.organizationId || ''

      const result = await archiveHorse(orgId, params.id)

      if (result.success) {
        router.push('/staff/horses')
      } else {
        setError(result.error || 'Failed to archive horse')
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to archive horse')
    } finally {
      setArchiving(false)
    }
  }

  if (loading) return <div className="flex items-center justify-center min-h-screen">Loading...</div>
  if (!horse) return <div className="flex items-center justify-center min-h-screen">Horse not found</div>

  return (
    <div className="space-y-6 p-6 max-w-2xl">
      <div>
        <Button variant="outline" onClick={() => router.back()} className="mb-4">
          ← Back
        </Button>
        <h1 className="text-3xl font-serif font-bold text-stone-900">Edit Horse: {horse.name}</h1>
      </div>

      {error && <div className="bg-red-50 border border-red-200 text-red-700 px-4 py-3 rounded">{error}</div>}

      <Card className="border-stone-200">
        <CardHeader>
          <CardTitle>Horse Information</CardTitle>
        </CardHeader>
        <CardContent className="space-y-4">
          <div>
            <p className="text-sm font-medium text-stone-600">Branch</p>
            <p className="text-stone-900">{horse.branch.name}</p>
          </div>
          {horse.dob && (
            <div>
              <p className="text-sm font-medium text-stone-600">Date of Birth</p>
              <p className="text-stone-900">{new Date(horse.dob).toLocaleDateString()}</p>
            </div>
          )}
        </CardContent>
      </Card>

      <Card className="border-stone-200">
        <CardHeader>
          <CardTitle>Update Details</CardTitle>
        </CardHeader>
        <CardContent>
          <form onSubmit={handleSubmit} className="space-y-4">
            <div>
              <label className="block text-sm font-medium text-stone-700 mb-2">Name *</label>
              <input
                type="text"
                value={formData.name}
                onChange={(e) => setFormData({ ...formData, name: e.target.value })}
                className="w-full px-3 py-2 border border-stone-300 rounded-md focus:outline-none focus:ring-2 focus:ring-stone-500"
                required
              />
            </div>

            <div>
              <label className="block text-sm font-medium text-stone-700 mb-2">Breed</label>
              <input
                type="text"
                value={formData.breed}
                onChange={(e) => setFormData({ ...formData, breed: e.target.value })}
                className="w-full px-3 py-2 border border-stone-300 rounded-md focus:outline-none focus:ring-2 focus:ring-stone-500"
              />
            </div>

            <div>
              <label className="block text-sm font-medium text-stone-700 mb-2">Status *</label>
              <select
                value={formData.status}
                onChange={(e) => setFormData({ ...formData, status: e.target.value })}
                className="w-full px-3 py-2 border border-stone-300 rounded-md focus:outline-none focus:ring-2 focus:ring-stone-500"
                required
              >
                <option value="ACTIVE">Active</option>
                <option value="INACTIVE">Inactive</option>
                <option value="RETIRED">Retired</option>
              </select>
            </div>

            <div>
              <label className="block text-sm font-medium text-stone-700 mb-2">Notes</label>
              <textarea
                value={formData.notes}
                onChange={(e) => setFormData({ ...formData, notes: e.target.value })}
                className="w-full px-3 py-2 border border-stone-300 rounded-md focus:outline-none focus:ring-2 focus:ring-stone-500"
                rows={3}
              />
            </div>

            <div className="flex gap-3 pt-4">
              <Button type="submit" disabled={submitting} className="flex-1">
                {submitting ? 'Saving...' : 'Save Changes'}
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

          {horse.status !== 'RETIRED' && (
            <div className="mt-6 pt-6 border-t border-stone-200">
              <Button
                onClick={handleArchive}
                disabled={archiving}
                className="w-full bg-red-600 hover:bg-red-700"
              >
                {archiving ? 'Retiring...' : 'Retire Horse'}
              </Button>
            </div>
          )}
        </CardContent>
      </Card>
    </div>
  )
}
