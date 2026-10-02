'use client'

import { useEffect, useState } from 'react'
import { useSearchParams, useRouter } from 'next/navigation'
import Link from 'next/link'
import { resetPassword } from '@/server/actions/auth-password'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { Button } from '@/components/ui/button'

export default function ResetPasswordContent() {
  const searchParams = useSearchParams()
  const router = useRouter()
  const token = searchParams.get('token')

  const [password, setPassword] = useState('')
  const [confirmPassword, setConfirmPassword] = useState('')
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [success, setSuccess] = useState(false)

  useEffect(() => {
    if (!token) {
      setError('Invalid reset link. Missing token.')
    }
  }, [token])

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault()
    setError(null)

    // Validate passwords match
    if (password !== confirmPassword) {
      setError('Passwords do not match')
      return
    }

    // Validate password length
    if (password.length < 8) {
      setError('Password must be at least 8 characters')
      return
    }

    setLoading(true)

    try {
      if (!token) {
        setError('Invalid reset link')
        return
      }

      const result = await resetPassword(token, password)

      if (result.success) {
        setSuccess(true)
        // Redirect to sign-in after 3 seconds
        setTimeout(() => {
          router.push('/staff/sign-in')
        }, 3000)
      } else {
        setError(result.error || 'Failed to reset password')
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : 'An error occurred')
    } finally {
      setLoading(false)
    }
  }

  return (
    <div className="min-h-screen flex items-center justify-center p-6 bg-stone-50">
      <Card className="w-full max-w-md border-stone-200">
        <CardHeader>
          <CardTitle>Reset Your Password</CardTitle>
        </CardHeader>
        <CardContent className="space-y-4">
          {!token && (
            <div className="bg-red-50 border border-red-200 text-red-700 px-4 py-3 rounded text-sm">
              Invalid reset link. Please request a new one from the forgot password page.
            </div>
          )}

          {success ? (
            <div className="space-y-4 text-center">
              <div className="text-4xl">✅</div>
              <p className="text-stone-900 font-semibold">Password Reset Successfully</p>
              <p className="text-sm text-stone-600">Your password has been reset. You can now sign in with your new password.</p>
              <p className="text-xs text-stone-500">Redirecting to sign-in in 3 seconds...</p>
            </div>
          ) : (
            <form onSubmit={handleSubmit} className="space-y-4">
              {error && <div className="bg-red-50 border border-red-200 text-red-700 px-4 py-3 rounded text-sm">{error}</div>}

              <div>
                <label className="block text-sm font-medium text-stone-700 mb-2">New Password</label>
                <input
                  type="password"
                  value={password}
                  onChange={(e) => setPassword(e.target.value)}
                  className="w-full px-4 py-2 border border-stone-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-stone-500"
                  placeholder="••••••••"
                  required
                />
                <p className="text-xs text-stone-500 mt-2">
                  At least 8 characters, 1 uppercase letter, 1 number
                </p>
              </div>

              <div>
                <label className="block text-sm font-medium text-stone-700 mb-2">Confirm Password</label>
                <input
                  type="password"
                  value={confirmPassword}
                  onChange={(e) => setConfirmPassword(e.target.value)}
                  className="w-full px-4 py-2 border border-stone-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-stone-500"
                  placeholder="••••••••"
                  required
                />
              </div>

              <Button type="submit" disabled={loading || !token} className="w-full">
                {loading ? 'Resetting...' : 'Reset Password'}
              </Button>
            </form>
          )}

          <div className="text-center">
            <p className="text-sm text-stone-600">
              <Link href="/forgot-password" className="text-stone-900 font-semibold hover:underline">
                Request a new reset link
              </Link>
            </p>
          </div>
        </CardContent>
      </Card>
    </div>
  )
}
