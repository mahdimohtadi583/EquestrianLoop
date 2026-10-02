'use client'

import { Suspense, useState } from 'react'
import ResetPasswordContent from './reset-content'

export default function ResetPasswordPage() {
  return (
    <Suspense fallback={<div className="min-h-screen flex items-center justify-center">Loading...</div>}>
      <ResetPasswordContent />
    </Suspense>
  )
}
