'use client'

import { useState } from 'react'
import { useRouter } from 'next/navigation'
import { createStaffAccount } from '@/server/actions/staff-auth'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'

interface StaffSignUpPageProps {
  organizationId: string
}

export default function StaffSignUpPage({ organizationId }: StaffSignUpPageProps) {
  const router = useRouter()
  const [formData, setFormData] = useState({
    email: '',
    password: '',
    name: '',
    roleId: '',
    branchId: '',
  })
  const [error, setError] = useState<string | null>(null)
  const [submitting, setSubmitting] = useState(false)

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault()
    setSubmitting(true)
    setError(null)

    try {
      await createStaffAccount({
        organizationId,
        email: formData.email,
        password: formData.password,
        name: formData.name,
        roleId: formData.roleId,
        branchId: formData.branchId || undefined,
      })
      router.push('/staff/sign-in')
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Sign up failed. Please try again.')
      setSubmitting(false)
    }
  }

  return (
    <div className="flex min-h-screen items-center justify-center bg-stone-50 px-4">
      <Card className="w-full max-w-sm border-stone-200 shadow-sm">
        <CardHeader>
          <CardTitle className="font-serif text-2xl text-stone-900">Staff sign up</CardTitle>
        </CardHeader>
        <CardContent>
          <form onSubmit={handleSubmit} className="space-y-4">
            <div className="space-y-1.5">
              <Label htmlFor="email">Email</Label>
              <Input
                id="email"
                type="email"
                value={formData.email}
                onChange={(e) => setFormData({ ...formData, email: e.target.value })}
                required
              />
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="password">Password</Label>
              <Input
                id="password"
                type="password"
                value={formData.password}
                onChange={(e) => setFormData({ ...formData, password: e.target.value })}
                required
              />
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="name">Name</Label>
              <Input
                id="name"
                type="text"
                value={formData.name}
                onChange={(e) => setFormData({ ...formData, name: e.target.value })}
                required
              />
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="roleId">Role ID</Label>
              <Input
                id="roleId"
                type="text"
                value={formData.roleId}
                onChange={(e) => setFormData({ ...formData, roleId: e.target.value })}
                required
              />
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="branchId">Branch ID (Optional)</Label>
              <Input
                id="branchId"
                type="text"
                value={formData.branchId}
                onChange={(e) => setFormData({ ...formData, branchId: e.target.value })}
              />
            </div>
            {error && <p className="text-sm text-red-600">{error}</p>}
            <Button type="submit" className="w-full" disabled={submitting}>
              {submitting ? 'Signing up…' : 'Sign up'}
            </Button>
          </form>
        </CardContent>
      </Card>
    </div>
  )
}
