// @vitest-environment node
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { PluginBackendApi } from '@valley/plugin-sdk'
import { initBackend } from '../src/backend/runtime'
import { recordUsage, readUsage, setBudget, resetUsage } from '../src/backend/usage'
import { costFor } from '../src/backend/pricing'
let ledger: Uint8Array | null = null
let writing: Uint8Array[] = []
beforeEach(() => {
  ledger = null
  initBackend({ sealed: {
    openRead: async () => ledger ? { handle: 'fixture-read', bytes: ledger.length } : null,
    readChunk: async () => ({ base64: Buffer.from(ledger!).toString('base64'), done: true }),
    beginWrite: async () => { writing = []; return 'fixture-write' },
    writeChunk: async (_handle: string, base64: string) => { writing.push(Buffer.from(base64, 'base64')) },
    commitWrite: async () => { ledger = Buffer.concat(writing) }, close: async () => {}
  } } as unknown as PluginBackendApi)
})
describe('pricing', () => {
  it('computes cost from the per-million table', () => {
    // Opus: $5/1M in, $25/1M out → 1M in + 1M out = $30
    expect(costFor('anthropic', 'claude-opus-4-8', 1_000_000, 1_000_000)).toBeCloseTo(30)
    // Haiku: $1/$5
    expect(costFor('anthropic', 'claude-haiku-4-5', 2_000_000, 0)).toBeCloseTo(2)
  })
  it('charges nothing for local Ollama, subscription providers, or unknown models', () => {
    expect(costFor('ollama', 'llama3', 1_000_000, 1_000_000)).toBe(0)
    expect(costFor('openai-codex', 'gpt-5.5', 1_000_000, 1_000_000)).toBe(0)
    // Claude Pro/Max subscription (Box B) is not Platform-API billed per token.
    expect(costFor('anthropic-claude', 'claude-opus-4-8', 1_000_000, 1_000_000)).toBe(0)
    expect(costFor('openai', 'totally-made-up', 1_000_000, 1_000_000)).toBe(0)
  })
})

describe('usage trend (local-time rollups)', () => {
  it('buckets daily/weekly/monthly in local time and mirrors them per provider', async () => {
    vi.useFakeTimers()
    try {
      // Two calls on the SAME local calendar day — one just after midnight, one
      // late evening. A UTC bucketer would split the late one onto the next day.
      vi.setSystemTime(new Date(2026, 2, 10, 0, 30)) // Mar 10 2026, 00:30 local
      await recordUsage({ provider: 'anthropic', model: 'claude-opus-4-8', inputTokens: 1000, outputTokens: 500, origin: 'ui' })
      vi.setSystemTime(new Date(2026, 2, 10, 23, 30)) // Mar 10 2026, 23:30 local
      await recordUsage({ provider: 'anthropic', model: 'claude-opus-4-8', inputTokens: 1000, outputTokens: 500, origin: 'ui' })

      const u = await readUsage()

      // Both land in ONE local day, not split across a UTC midnight.
      const day = '2026-03-10'
      const daily = u.trend.daily.filter((d) => d.period === day)
      expect(daily).toHaveLength(1)
      expect(daily[0].calls).toBe(2)

      // Weekly key = the local Monday of that week (computed the same way the impl does).
      const monday = new Date(2026, 2, 10)
      monday.setDate(monday.getDate() - ((monday.getDay() + 6) % 7))
      const expectedMonday = `${monday.getFullYear()}-${String(monday.getMonth() + 1).padStart(2, '0')}-${String(monday.getDate()).padStart(2, '0')}`
      expect(u.trend.weekly).toHaveLength(1)
      expect(u.trend.weekly[0].period).toBe(expectedMonday)
      expect(u.trend.monthly).toEqual([expect.objectContaining({ period: '2026-03', calls: 2 })])

      // Per-provider trend mirrors the global one.
      const prov = u.byProvider.find((p) => p.provider === 'anthropic')!
      expect(prov.trend.daily.find((d) => d.period === day)?.calls).toBe(2)
    } finally {
      vi.useRealTimers()
    }
  })
})

describe('usage ledger', () => {
  it('starts empty', async () => {
    const u = await readUsage()
    expect(u.allTime.calls).toBe(0)
    expect(u.byProvider).toEqual([])
    expect(u.since).toBeNull()
  })

  it('records calls and rolls them up by provider and model', async () => {
    await recordUsage({ provider: 'anthropic', model: 'claude-opus-4-8', inputTokens: 1000, outputTokens: 500, origin: 'ui' })
    await recordUsage({ provider: 'anthropic', model: 'claude-haiku-4-5', inputTokens: 2000, outputTokens: 0, origin: 'channel' })
    await recordUsage({ provider: 'ollama', model: 'llama3', inputTokens: 9999, outputTokens: 9999, origin: 'ui' })

    const u = await readUsage()
    expect(u.allTime.calls).toBe(3)
    expect(u.allTime.inputTokens).toBe(12_999)
    // anthropic rolls up two calls, ollama one
    const anthropic = u.byProvider.find((p) => p.provider === 'anthropic')!
    expect(anthropic.month.calls).toBe(2)
    expect(anthropic.month.costUsd).toBeGreaterThan(0)
    expect(u.byModel.map((m) => m.model)).toContain('claude-opus-4-8')
    // ollama is free
    expect(u.byProvider.find((p) => p.provider === 'ollama')!.month.costUsd).toBe(0)
    expect(u.recentEntries[0].provider).toBe('ollama') // newest first
    expect(u.since).toMatch(/^\d{4}-\d{2}$/)
  })

  it('ignores zero-token calls', async () => {
    await recordUsage({ provider: 'anthropic', model: 'claude-opus-4-8', inputTokens: 0, outputTokens: 0, origin: 'ui' })
    expect((await readUsage()).allTime.calls).toBe(0)
  })

  it('persists and reports the budget; left = budget − spend', async () => {
    await setBudget({ total: 50, perProvider: { anthropic: 30 } })
    await recordUsage({ provider: 'anthropic', model: 'claude-opus-4-8', inputTokens: 1_000_000, outputTokens: 0, origin: 'ui' })
    const u = await readUsage()
    expect(u.budget.total).toBe(50)
    expect(u.budget.perProvider?.anthropic).toBe(30)
    expect(u.month.costUsd).toBeCloseTo(5) // $5 for 1M opus input
  })

  it('reset clears entries but keeps the budget', async () => {
    await setBudget({ total: 20 })
    await recordUsage({ provider: 'openai', model: 'gpt-4o', inputTokens: 100, outputTokens: 100, origin: 'ui' })
    await resetUsage()
    const u = await readUsage()
    expect(u.allTime.calls).toBe(0)
    expect(u.budget.total).toBe(20)
  })

  it('rolls up per connection, so two keys on one provider are billed apart', async () => {
    await recordUsage({ provider: 'anthropic', connectionId: 'anthropic', model: 'claude-opus-4-8', inputTokens: 1_000_000, outputTokens: 0, origin: 'ui' })
    await recordUsage({ provider: 'anthropic', connectionId: 'anthropic-2', model: 'claude-opus-4-8', inputTokens: 2_000_000, outputTokens: 0, origin: 'ui' })

    const u = await readUsage()
    // One provider row, two connection rows — the provider rollup is unchanged.
    expect(u.byProvider.filter((p) => p.provider === 'anthropic')).toHaveLength(1)
    const personal = u.byConnection.find((c) => c.connectionId === 'anthropic')!
    const work = u.byConnection.find((c) => c.connectionId === 'anthropic-2')!
    expect(personal.allTime.costUsd).toBeCloseTo(5)
    expect(work.allTime.costUsd).toBeCloseTo(10)
    expect(work.provider).toBe('anthropic')
    expect(personal.lastUsedAt).toBeGreaterThan(0)
  })

  it('folds a pre-connections entry into the provider’s default connection', async () => {
    // No `connectionId` — written before connections existed. Its spend must
    // still surface, under the default connection (whose id IS the provider id).
    await recordUsage({ provider: 'anthropic', model: 'claude-opus-4-8', inputTokens: 1_000_000, outputTokens: 0, origin: 'ui' })
    const u = await readUsage()
    expect(u.byConnection.map((c) => c.connectionId)).toEqual(['anthropic'])
    expect(u.byConnection[0].allTime.costUsd).toBeCloseTo(5)
  })

})
