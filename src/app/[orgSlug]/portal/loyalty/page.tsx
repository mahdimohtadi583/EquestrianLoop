'use client'

import { useEffect, useState } from 'react'
import { useSession } from 'next-auth/react'
import { getLoyaltyBalance, redeemReward } from '@/server/actions/customer-portal'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { Button } from '@/components/ui/button'

interface LoyaltyAccount {
  id: string
  balance: number
  transactions: Array<{
    id: string
    type: string
    points: number
    sourceType: string
    createdAt: Date
  }>
}

interface Reward {
  id: string
  name: string
  description?: string
  pointsCost: number
  isActive: boolean
}

export default function LoyaltyPage() {
  const { data: session } = useSession()
  const [loyalty, setLoyalty] = useState<LoyaltyAccount | null>(null)
  const [rewards, setRewards] = useState<Reward[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [redeeming, setRedeeming] = useState<string | null>(null)

  useEffect(() => {
    const loadLoyalty = async () => {
      try {
        if (!session?.user) return
        const user = session.user as any
        const data = await getLoyaltyBalance(user.organizationId || '')
        setLoyalty(data as any)

        // Note: In a real app, we'd fetch available rewards from a server action
        // For now, showing structure only
        setRewards([])
      } catch (err) {
        setError(err instanceof Error ? err.message : 'Failed to load loyalty data')
      } finally {
        setLoading(false)
      }
    }

    loadLoyalty()
  }, [session])

  const handleRedeem = async (rewardId: string) => {
    setRedeeming(rewardId)
    try {
      if (!session?.user) throw new Error('Not authenticated')
      const user = session.user as any

      const result = await redeemReward(user.organizationId || '', rewardId)

      if (result.success) {
        // Reload loyalty balance
        const data = await getLoyaltyBalance(user.organizationId || '')
        setLoyalty(data as any)
        setError(null)
      } else {
        setError(result.error || 'Failed to redeem reward')
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to redeem reward')
    } finally {
      setRedeeming(null)
    }
  }

  if (loading) return <div className="flex items-center justify-center min-h-screen">Loading...</div>

  return (
    <div className="space-y-6 p-6">
      <div>
        <h1 className="text-3xl font-serif font-bold text-stone-900">Loyalty Rewards</h1>
      </div>

      {error && <div className="bg-red-50 border border-red-200 text-red-700 px-4 py-3 rounded">{error}</div>}

      {loyalty ? (
        <>
          <Card className="border-stone-200 bg-gradient-to-r from-stone-50 to-stone-100">
            <CardHeader>
              <CardTitle>Your Points Balance</CardTitle>
            </CardHeader>
            <CardContent>
              <div className="text-4xl font-bold text-stone-900 mb-2">{loyalty.balance}</div>
              <p className="text-stone-600">Total loyalty points</p>
            </CardContent>
          </Card>

          <Card className="border-stone-200">
            <CardHeader>
              <CardTitle>Available Rewards</CardTitle>
            </CardHeader>
            <CardContent>
              {rewards.length === 0 ? (
                <p className="text-center text-stone-600 py-8">No rewards available at this time</p>
              ) : (
                <div className="grid gap-4 md:grid-cols-2">
                  {rewards
                    .filter((r) => r.isActive)
                    .map((reward) => (
                      <div
                        key={reward.id}
                        className="border border-stone-200 rounded-lg p-4 space-y-3"
                      >
                        <div>
                          <h3 className="font-semibold text-stone-900">{reward.name}</h3>
                          {reward.description && (
                            <p className="text-sm text-stone-600">{reward.description}</p>
                          )}
                        </div>
                        <div className="flex items-center justify-between">
                          <span className="text-lg font-semibold text-stone-900">
                            {reward.pointsCost} pts
                          </span>
                          <Button
                            onClick={() => handleRedeem(reward.id)}
                            disabled={
                              redeeming === reward.id || loyalty.balance < reward.pointsCost
                            }
                            size="sm"
                          >
                            {redeeming === reward.id ? 'Redeeming...' : 'Redeem'}
                          </Button>
                        </div>
                      </div>
                    ))}
                </div>
              )}
            </CardContent>
          </Card>

          <Card className="border-stone-200">
            <CardHeader>
              <CardTitle>Transaction History</CardTitle>
            </CardHeader>
            <CardContent>
              {loyalty.transactions.length === 0 ? (
                <p className="text-center text-stone-600 py-8">No transactions yet</p>
              ) : (
                <div className="space-y-2">
                  {loyalty.transactions.map((tx) => (
                    <div key={tx.id} className="flex items-center justify-between py-2 border-b border-stone-200">
                      <div>
                        <p className="font-medium text-stone-900">{tx.sourceType}</p>
                        <p className="text-xs text-stone-600">{new Date(tx.createdAt).toLocaleString()}</p>
                      </div>
                      <span
                        className={`font-semibold ${
                          tx.points > 0 ? 'text-green-600' : 'text-red-600'
                        }`}
                      >
                        {tx.points > 0 ? '+' : ''}{tx.points}
                      </span>
                    </div>
                  ))}
                </div>
              )}
            </CardContent>
          </Card>
        </>
      ) : (
        <Card className="border-stone-200">
          <CardContent className="pt-6">
            <p className="text-center text-stone-600">No loyalty account found</p>
          </CardContent>
        </Card>
      )}
    </div>
  )
}
