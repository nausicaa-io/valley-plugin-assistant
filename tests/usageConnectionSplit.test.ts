import { describe, expect, it } from 'vitest'
import type { AiConnectionStatus, AiUsageStats } from '../src/types'
import { splitConnections } from '../src/UsageSettings'

/**
 * Usage & Billing shows what actually matters: connections that are live now,
 * and — collapsed — ones whose spend is on record but whose credential is gone.
 * A provider that was never configured and never used is not a row of `$0.00`.
 */
const connection = (over: Partial<AiConnectionStatus> & { id: string }): AiConnectionStatus => ({
  provider: 'anthropic',
  providerName: 'Anthropic',
  providerDescription: 'Chat provider',
  providerIcon: 'anthropic',
  requiresKey: true,
  providerCapabilities: ['chat'],
  authMode: 'none',
  authSources: {},
  configured: false,
  baseUrl: 'https://api.anthropic.com',
  models: [],
  createdAt: 0,
  ...over
})

const bucket = (costUsd: number, calls = 1) => ({ inputTokens: 0, outputTokens: 0, costUsd, calls })

const rollup = (
  connectionId: string,
  costUsd: number,
  over: Partial<AiUsageStats['byConnection'][number]> = {}
): AiUsageStats['byConnection'][number] => ({
  connectionId,
  provider: 'anthropic',
  month: bucket(costUsd),
  allTime: bucket(costUsd),
  trend: { daily: [], weekly: [], monthly: [] },
  lastUsedAt: 1_700_000_000_000,
  ...over
})

describe('splitConnections', () => {
  it('puts a working credential under active, spend-without-credential under retired', () => {
    const { active, retired } = splitConnections(
      [
        connection({ id: 'anthropic', label: 'Personal', configured: true }),
        connection({ id: 'anthropic-2', label: 'Work' })
      ],
      [rollup('anthropic', 12.4), rollup('anthropic-2', 0.86)]
    )
    expect(active.map((r) => r.connection.id)).toEqual(['anthropic'])
    expect(retired.map((r) => r.connection.id)).toEqual(['anthropic-2'])
  })

  it('hides a connection that was never configured and never used', () => {
    const { active, retired } = splitConnections(
      [connection({ id: 'xai', provider: 'xai' }), connection({ id: 'deepseek', provider: 'deepseek' })],
      []
    )
    expect(active).toEqual([])
    expect(retired).toEqual([])
  })

  it('keeps a configured connection active even with no spend yet', () => {
    const { active } = splitConnections([connection({ id: 'ollama', provider: 'ollama', configured: true })], [])
    expect(active.map((r) => r.connection.id)).toEqual(['ollama'])
  })

  it('retires a connection whose only record is calls, not dollars (a free local model)', () => {
    const { retired } = splitConnections(
      [connection({ id: 'ollama', provider: 'ollama' })],
      [rollup('ollama', 0, { provider: 'ollama', month: bucket(0, 4), allTime: bucket(0, 4) })]
    )
    expect(retired.map((r) => r.connection.id)).toEqual(['ollama'])
  })

  it('orders each group by spend, so the expensive connection leads', () => {
    const { active } = splitConnections(
      [
        connection({ id: 'anthropic', label: 'Cheap', configured: true }),
        connection({ id: 'anthropic-2', label: 'Pricey', configured: true })
      ],
      [rollup('anthropic', 1.5), rollup('anthropic-2', 20)]
    )
    expect(active.map((r) => r.connection.label)).toEqual(['Pricey', 'Cheap'])
  })

  it('pairs each connection with its own rollup, never the provider’s total', () => {
    const { active } = splitConnections(
      [
        connection({ id: 'anthropic', label: 'Personal', configured: true }),
        connection({ id: 'anthropic-2', label: 'Work', configured: true })
      ],
      [rollup('anthropic', 5), rollup('anthropic-2', 11)]
    )
    expect(active.map((r) => r.usage?.allTime.costUsd)).toEqual([11, 5])
  })
})
