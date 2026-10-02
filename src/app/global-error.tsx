'use client'

import { useEffect } from 'react'

export default function GlobalError({ error }: { error: Error & { digest?: string } }) {
  useEffect(() => {
    // Log to console in development
    console.error('Global error:', error)

    // Note: In production with Sentry configured, errors are captured via
    // the Sentry next/js plugin. See docs/sentry-setup.md for configuration.
  }, [error])

  return (
    <html>
      <body className="bg-stone-50">
        <div className="min-h-screen flex items-center justify-center p-6">
          <div className="max-w-md w-full space-y-6">
            <div className="text-center">
              <h1 className="text-4xl font-bold text-stone-900 mb-2">500</h1>
              <h2 className="text-xl font-semibold text-stone-700 mb-4">Something went wrong</h2>
              <p className="text-sm text-stone-600 mb-6">
                An unexpected error occurred. Our team has been notified.
              </p>

              {process.env.NODE_ENV === 'development' && error?.message && (
                <div className="mb-6 p-4 bg-red-50 border border-red-200 rounded-lg text-left">
                  <p className="text-xs font-mono text-red-700 break-words">{error.message}</p>
                  {error.digest && (
                    <p className="text-xs text-red-600 mt-2">Error ID: {error.digest}</p>
                  )}
                </div>
              )}
            </div>

            <div className="space-y-3">
              <a
                href="/"
                className="block w-full px-4 py-2 bg-stone-900 text-white rounded-lg text-center font-medium hover:bg-stone-800 transition"
              >
                Go Home
              </a>
              <a
                href="/"
                className="block w-full px-4 py-2 border border-stone-300 text-stone-900 rounded-lg text-center font-medium hover:bg-stone-50 transition"
              >
                Contact Support
              </a>
            </div>

            <p className="text-xs text-center text-stone-500">
              If this error persists, please try refreshing the page.
            </p>
          </div>
        </div>
      </body>
    </html>
  )
}
