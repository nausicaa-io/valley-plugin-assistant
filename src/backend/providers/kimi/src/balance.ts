import { brokerFetch } from '../../network'
import type { ProviderRuntimeContext } from '../../shared'

export async function getBalance(context: ProviderRuntimeContext) {
  if (!context.credentialHandle) return null
  try {
    const response = await brokerFetch(`${context.baseUrl.replace(/\/$/, '')}/users/me/balance`, {
      credential: { handle: context.credentialHandle, placement: 'header', name: 'authorization', prefix: 'Bearer ' }
    })
    if (!response.ok) return null
    const json = (await response.json()) as { data?: { available_balance?: number; voucher_balance?: number; cash_balance?: number } }
    const balance = json.data
    return balance ? {
      currency: /\.cn(\/|$)/.test(context.baseUrl) ? 'CNY' : 'USD',
      available: Number(balance.available_balance || 0),
      granted: Number(balance.voucher_balance || 0),
      toppedUp: Number(balance.cash_balance || 0)
    } : null
  } catch {
    return null
  }
}
