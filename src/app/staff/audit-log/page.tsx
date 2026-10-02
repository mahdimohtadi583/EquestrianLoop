import { Suspense } from 'react'
import AuditLogContent from './audit-log-content'

export const metadata = {
  title: 'Audit Log',
}

export default async function AuditLogPage() {
  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-3xl font-bold text-stone-900">Audit Log</h1>
        <p className="text-sm text-stone-600 mt-2">Activity history for your organization</p>
      </div>

      <Suspense fallback={<div className="text-stone-600">Loading audit logs...</div>}>
        <AuditLogContent />
      </Suspense>
    </div>
  )
}
