import { brokerFetch } from '../../network'
import type { ProviderRuntimeContext } from '../../shared'

export async function getBalance(context: ProviderRuntimeContext) {
  if (!context.credentialHandle) return null
  try {
    const response = await brokerFetch(`${new URL(context.baseUrl).origin}/user/balance`, {
      credential: { handle: context.credentialHandle, placement: 'header', name: 'authorization', prefix: 'Bearer ' }
    })
    if (!response.ok) return null
    const json = (await response.json()) as {
      balance_infos?: Array<{ currency?: string; total_balance?: string; granted_balance?: string; topped_up_balance?: string }>
    }
    const balance = json.balance_infos?.[0]
    if (!balance) return null
    return {
      currency: balance.currency || 'USD',
      available: Number(balance.total_balance || 0),
      granted: Number(balance.granted_balance || 0),
      toppedUp: Number(balance.topped_up_balance || 0)
    }
  } catch {
    return null
  }
}
