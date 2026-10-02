'use client'

import { useState } from 'react'
import Link from 'next/link'
import { requestPasswordReset } from '@/server/actions/auth-password'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { Button } from '@/components/ui/button'

export default function ForgotPasswordPage() {
  const [email, setEmail] = useState('')
  const [submitted, setSubmitted] = useState(false)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault()
    setLoading(true)
    setError(null)

    try {
      const result = await requestPasswordReset(email)

      if (result.success) {
        setSubmitted(true)
        setEmail('')
      } else {
        setError(result.error || 'Failed to request password reset')
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
          <CardTitle>Forgot Password</CardTitle>
        </CardHeader>
        <CardContent className="space-y-6">
          {!submitted ? (
            <>
              <p className="text-sm text-stone-600">
                Enter your email address and we'll send you a link to reset your password.
              </p>

              <form onSubmit={handleSubmit} className="space-y-4">
                {error && <div className="bg-red-50 border border-red-200 text-red-700 px-4 py-3 rounded text-sm">{error}</div>}

                <div>
                  <label className="block text-sm font-medium text-stone-700 mb-2">Email Address</label>
                  <input
                    type="email"
                    value={email}
                    onChange={(e) => setEmail(e.target.value)}
                    className="w-full px-4 py-2 border border-stone-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-stone-500"
                    placeholder="your@email.com"
                    required
                  />
                </div>

                <Button type="submit" disabled={loading} className="w-full">
                  {loading ? 'Sending...' : 'Send Reset Link'}
                </Button>
              </form>

              <div className="text-center">
                <p className="text-sm text-stone-600">
                  Remember your password?{' '}
                  <Link href="/staff/sign-in" className="text-stone-900 font-semibold hover:underline">
                    Sign in
                  </Link>
                </p>
              </div>
            </>
          ) : (
            <div className="space-y-4 text-center">
              <div className="text-4xl">📧</div>
              <p className="text-stone-900 font-semibold">Check your email</p>
              <p className="text-sm text-stone-600">
                If an account exists with the email you entered, you'll receive a password reset link. Check your inbox
                and spam folder.
              </p>
              <p className="text-xs text-stone-500">The reset link will expire in 1 hour.</p>

              <Button variant="outline" onClick={() => setSubmitted(false)} className="w-full">
                Try Another Email
              </Button>
            </div>
          )}
        </CardContent>
      </Card>
    </div>
  )
}
