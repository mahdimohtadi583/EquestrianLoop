'use client'

import { useState, useEffect } from 'react'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'

const ACTION_COLORS: Record<string, string> = {
  USER_LOGIN: 'bg-blue-100 text-blue-800',
  BOOKING_CREATED: 'bg-green-100 text-green-800',
  BOOKING_CANCELLED: 'bg-orange-100 text-orange-800',
  HORSE_CREATED: 'bg-purple-100 text-purple-800',
  HORSE_ARCHIVED: 'bg-gray-100 text-gray-800',
  MEMBERSHIP_CANCELLED: 'bg-red-100 text-red-800',
  PASSWORD_RESET: 'bg-yellow-100 text-yellow-800',
  EMAIL_VERIFIED: 'bg-teal-100 text-teal-800',
  LOYALTY_REDEEMED: 'bg-pink-100 text-pink-800',
  REWARD_REDEEMED: 'bg-indigo-100 text-indigo-800',
}

const ACTION_LABELS: Record<string, string> = {
  USER_LOGIN: 'User Login',
  BOOKING_CREATED: 'Booking Created',
  BOOKING_CANCELLED: 'Booking Cancelled',
  HORSE_CREATED: 'Horse Created',
  HORSE_ARCHIVED: 'Horse Archived',
  MEMBERSHIP_CANCELLED: 'Membership Cancelled',
  PASSWORD_RESET: 'Password Reset',
  EMAIL_VERIFIED: 'Email Verified',
  LOYALTY_REDEEMED: 'Loyalty Redeemed',
  REWARD_REDEEMED: 'Reward Redeemed',
}

interface AuditLogEntry {
  id: string
  organizationId: string
  userId: string | null
  action: string
  resource: string
  resourceId: string | null
  metadata: any
  ipAddress: string | null
  createdAt: Date
}

export default function AuditLogContent() {
  const [logs, setLogs] = useState<AuditLogEntry[]>([])
  const [filteredLogs, setFilteredLogs] = useState<AuditLogEntry[]>([])
  const [selectedAction, setSelectedAction] = useState<string>('')
  const [loading, setLoading] = useState(true)

  useEffect(() => {
    // In a real implementation, this would fetch from the server
    // For now, this is a placeholder structure
    setLoading(false)
    setLogs([])
    setFilteredLogs([])
  }, [])

  useEffect(() => {
    if (selectedAction) {
      setFilteredLogs(logs.filter((log) => log.action === selectedAction))
    } else {
      setFilteredLogs(logs)
    }
  }, [logs, selectedAction])

  if (loading) {
    return <div className="text-stone-600">Loading audit logs...</div>
  }

  const uniqueActions = Array.from(new Set(logs.map((log) => log.action))).sort()

  return (
    <Card className="border-stone-200">
      <CardHeader className="border-b border-stone-200">
        <div className="flex items-center justify-between">
          <CardTitle>Activity History</CardTitle>
          <div className="flex items-center gap-3">
            <label className="text-sm font-medium text-stone-700">Filter by action:</label>
            <select
              value={selectedAction}
              onChange={(e) => setSelectedAction(e.target.value)}
              className="px-3 py-1 text-sm border border-stone-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-stone-500"
            >
              <option value="">All Actions</option>
              {uniqueActions.map((action) => (
                <option key={action} value={action}>
                  {ACTION_LABELS[action] || action}
                </option>
              ))}
            </select>
          </div>
        </div>
      </CardHeader>

      <CardContent className="p-0">
        {filteredLogs.length === 0 ? (
          <div className="p-6 text-center text-stone-500">
            {logs.length === 0 ? 'No audit logs yet' : 'No matching audit logs'}
          </div>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b border-stone-200 bg-stone-50">
                  <th className="px-6 py-3 text-left font-medium text-stone-700">Timestamp</th>
                  <th className="px-6 py-3 text-left font-medium text-stone-700">Action</th>
                  <th className="px-6 py-3 text-left font-medium text-stone-700">Resource</th>
                  <th className="px-6 py-3 text-left font-medium text-stone-700">Resource ID</th>
                  <th className="px-6 py-3 text-left font-medium text-stone-700">User ID</th>
                </tr>
              </thead>
              <tbody>
                {filteredLogs.map((log) => (
                  <tr key={log.id} className="border-b border-stone-200 hover:bg-stone-50">
                    <td className="px-6 py-3 text-stone-900">
                      {new Date(log.createdAt).toLocaleString()}
                    </td>
                    <td className="px-6 py-3">
                      <span className={`inline-block px-2 py-1 rounded text-xs font-medium ${ACTION_COLORS[log.action] || 'bg-gray-100 text-gray-800'}`}>
                        {ACTION_LABELS[log.action] || log.action}
                      </span>
                    </td>
                    <td className="px-6 py-3 text-stone-900">{log.resource}</td>
                    <td className="px-6 py-3 text-stone-700 font-mono text-xs">{log.resourceId || '—'}</td>
                    <td className="px-6 py-3 text-stone-700 font-mono text-xs">{log.userId || '—'}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </CardContent>
    </Card>
  )
}
