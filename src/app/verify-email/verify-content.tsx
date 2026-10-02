'use client'

import { useEffect, useState } from 'react'
import { useSearchParams, useRouter } from 'next/navigation'
import { useSession } from 'next-auth/react'
import { verifyEmail, resendVerificationEmail } from '@/server/actions/auth-verification'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { Button } from '@/components/ui/button'

export default function VerifyEmailContent() {
  const searchParams = useSearchParams()
  const router = useRouter()
  const { data: session } = useSession()

  const [status, setStatus] = useState<'loading' | 'success' | 'error' | 'idle'>('idle')
  const [error, setError] = useState<string | null>(null)
  const [resending, setResending] = useState(false)

  const token = searchParams.get('token')

  useEffect(() => {
    // If token is provided in URL, verify it
    if (token) {
      const verifyToken = async () => {
        setStatus('loading')
        try {
          const result = await verifyEmail(token)

          if (result.success) {
            setStatus('success')
            setError(null)
            // Redirect after 3 seconds
            setTimeout(() => {
              const userType = (session?.user as any)?.type
              if (userType === 'STAFF') {
                router.push('/staff/dashboard')
              } else {
                router.push('/')
              }
            }, 3000)
          } else {
            setStatus('error')
            setError(result.error || 'Failed to verify email')
          }
        } catch (err) {
          setStatus('error')
          setError(err instanceof Error ? err.message : 'Failed to verify email')
        }
      }

      verifyToken()
    }
  }, [token, session, router])

  const handleResend = async () => {
    if (!session?.user?.id) return

    setResending(true)
    try {
      const result = await resendVerificationEmail(session.user.id)

      if (result.success) {
        setError('Verification email sent! Check your inbox.')
        setStatus('idle')
      } else {
        setError(result.error || 'Failed to resend email')
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to resend email')
    } finally {
      setResending(false)
    }
  }

  return (
    <div className="min-h-screen flex items-center justify-center p-6">
      <Card className="w-full max-w-md border-stone-200">
        <CardHeader>
          <CardTitle className="text-center">Verify Your Email</CardTitle>
        </CardHeader>
        <CardContent className="space-y-4">
          {status === 'loading' && (
            <div className="text-center space-y-2">
              <div className="inline-block animate-spin rounded-full h-8 w-8 border-b-2 border-stone-900"></div>
              <p className="text-stone-600">Verifying your email...</p>
            </div>
          )}

          {status === 'success' && (
            <div className="text-center space-y-2">
              <div className="text-4xl">✅</div>
              <p className="text-stone-900 font-semibold">Email Verified!</p>
              <p className="text-sm text-stone-600">Your email has been verified successfully.</p>
              <p className="text-xs text-stone-500">Redirecting in 3 seconds...</p>
            </div>
          )}

          {status === 'error' && (
            <div className="space-y-4">
              <div className="bg-red-50 border border-red-200 text-red-700 px-4 py-3 rounded text-sm">
                {error}
              </div>

              {!token && (
                <div className="text-center space-y-2">
                  <p className="text-stone-600 text-sm">
                    We sent a verification link to your email. Click the link in your email to verify.
                  </p>
                </div>
              )}

              {session?.user?.id && (
                <Button onClick={handleResend} disabled={resending} className="w-full">
                  {resending ? 'Sending...' : 'Resend Verification Email'}
                </Button>
              )}
            </div>
          )}

          {status === 'idle' && !token && (
            <div className="space-y-4">
              <p className="text-stone-600 text-center">
                We sent a verification link to your email address. Please check your inbox and click the link to verify
                your account.
              </p>

              <div className="bg-blue-50 border border-blue-200 text-blue-700 px-4 py-3 rounded text-sm">
                <p className="font-semibold mb-1">Didn't receive the email?</p>
                <ul className="list-disc list-inside space-y-1 text-xs">
                  <li>Check your spam or junk folder</li>
                  <li>Make sure you used the correct email address</li>
                </ul>
              </div>

              {session?.user?.id && (
                <Button onClick={handleResend} disabled={resending} variant="outline" className="w-full">
                  {resending ? 'Sending...' : 'Resend Verification Email'}
                </Button>
              )}
            </div>
          )}
        </CardContent>
      </Card>
    </div>
  )
}
