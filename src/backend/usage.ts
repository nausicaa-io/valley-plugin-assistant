import { runExclusive } from './fileQueue'
import { backendApi } from './runtime'
import type { AiBudget, AiProviderId, AiUsageBucket, AiUsageDatedBucket, AiUsageEntry, AiUsageStats, AiUsageTrend } from '../types'
import { costFor } from './pricing'

/**
 * Owns the token/cost ledger. Every model call is appended here from the engine
 * (main process), and the renderer reads only derived aggregates. The on-disk
 * file is encrypted with the OS keychain (`safeStorage`) when available, so
 * editing it by hand corrupts it — a tampered/garbage file reads back as empty
 * rather than as forged numbers. The cost is computed here via the in-code
 * pricing table, never trusted from outside.
 */
interface Ledger {
  entries: AiUsageEntry[]
  budget: AiBudget
}

/** A fresh empty ledger — never share array/object references (callers mutate). */
const empty = (): Ledger => ({ entries: [], budget: {} })
/** Cap the stored ledger so it can't grow without bound (rollups stay correct). */
const MAX_ENTRIES = 50_000
/** How many recent entries to surface to the UI. */
const RECENT_LIMIT = 200

async function read(): Promise<Ledger> {
  const source = await backendApi().sealed.openRead('usage')
  if (!source) return empty()
  const decoder = new TextDecoder()
  let text = ''
  try {
    for (;;) {
      const chunk = await backendApi().sealed.readChunk(source.handle, 1024 * 1024)
      text += decoder.decode(Uint8Array.from(atob(chunk.base64), (value) => value.charCodeAt(0)), { stream: !chunk.done })
      if (chunk.done) break
    }
    const parsed = JSON.parse(text) as Partial<Ledger>
    return { entries: Array.isArray(parsed.entries) ? parsed.entries : [], budget: parsed.budget && typeof parsed.budget === 'object' ? parsed.budget : {} }
  } finally { await backendApi().sealed.close(source.handle).catch(() => undefined) }
}
async function write(ledger: Ledger): Promise<void> {
  const bytes = new TextEncoder().encode(JSON.stringify(ledger))
  const handle = await backendApi().sealed.beginWrite('usage', bytes.length)
  try {
    for (let offset = 0; offset < bytes.length; offset += 1024 * 1024) {
      const chunk = bytes.subarray(offset, offset + 1024 * 1024)
      let binary = ''
      for (let start = 0; start < chunk.length; start += 32768) binary += String.fromCharCode(...chunk.subarray(start, start + 32768))
      await backendApi().sealed.writeChunk(handle, btoa(binary))
    }
    await backendApi().sealed.commitWrite(handle)
  } catch (error) { await backendApi().sealed.close(handle).catch(() => undefined); throw error }
}

/** Append one metered model call. Cost is computed here from the pricing table. */
export async function recordUsage(input: {
  provider: AiProviderId
  /** Which credential was billed; omitted means the provider's default connection. */
  connectionId?: string
  model: string
  inputTokens: number
  outputTokens: number
  origin: 'ui' | 'channel' | 'harness'
}): Promise<void> {
  if (!input.inputTokens && !input.outputTokens) return
  return runExclusive('usage', async () => {
    const ledger = await read()
    const entry: AiUsageEntry = {
      ts: Date.now(),
      provider: input.provider,
      ...(input.connectionId ? { connectionId: input.connectionId } : {}),
      model: input.model,
      inputTokens: Math.max(0, Math.round(input.inputTokens)),
      outputTokens: Math.max(0, Math.round(input.outputTokens)),
      costUsd: costFor(input.provider, input.model, input.inputTokens, input.outputTokens),
      origin: input.origin
    }
    ledger.entries.push(entry)
    if (ledger.entries.length > MAX_ENTRIES) ledger.entries = ledger.entries.slice(-MAX_ENTRIES)
    await write(ledger)
  })
}

export async function setBudget(budget: AiBudget): Promise<void> {
  return runExclusive('usage', async () => {
    const ledger = await read()
    ledger.budget = budget
    await write(ledger)
  })
}

/** Clear all recorded usage (explicit user action). Budget is preserved. */
export async function resetUsage(): Promise<void> {
  return runExclusive('usage', async () => {
    const ledger = await read()
    await write({ entries: [], budget: ledger.budget })
  })
}

// ── Rollups (derived on read so they can never drift from the ledger) ────────

function emptyBucket(): AiUsageBucket {
  return { inputTokens: 0, outputTokens: 0, costUsd: 0, calls: 0 }
}

function add(bucket: AiUsageBucket, e: AiUsageEntry): void {
  bucket.inputTokens += e.inputTokens
  bucket.outputTokens += e.outputTokens
  bucket.costUsd += e.costUsd
  bucket.calls += 1
}

function startOfMonth(now = new Date()): number {
  return new Date(now.getFullYear(), now.getMonth(), 1).getTime()
}

function monthLabel(ts: number): string {
  const d = new Date(ts)
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`
}

function dayLabel(ts: number): string {
  const d = new Date(ts)
  return `${monthLabel(ts)}-${String(d.getDate()).padStart(2, '0')}`
}

// Week key = the local Monday that starts the week, as a "YYYY-MM-DD" date. Using
// the week-start date (rather than an ISO week number) keeps the label sortable
// and dodges week-53 / year-straddle edge cases. Local time throughout, so a late
// entry lands in the user's real calendar week, not a UTC-shifted one.
function weekLabel(ts: number): string {
  const d = new Date(ts)
  d.setHours(0, 0, 0, 0)
  const mondayOffset = (d.getDay() + 6) % 7 // getDay(): 0=Sun..6=Sat → 0=Mon..6=Sun
  d.setDate(d.getDate() - mondayOffset)
  return dayLabel(d.getTime())
}

/** Accumulate one entry into a label-keyed bucket map (creates the bucket lazily). */
function bump(map: Map<string, AiUsageBucket>, key: string, e: AiUsageEntry): void {
  let b = map.get(key)
  if (!b) {
    b = emptyBucket()
    map.set(key, b)
  }
  add(b, e)
}

/** Sorted, trimmed dated series (oldest→newest, last `limit` periods). */
function seriesFrom(map: Map<string, AiUsageBucket>, limit: number): AiUsageDatedBucket[] {
  return [...map.entries()]
    .sort((a, b) => a[0].localeCompare(b[0]))
    .slice(-limit)
    .map(([period, b]) => ({ period, ...b }))
}

/** Three-granularity time series, each maintained in its own label-keyed map. */
interface TrendMaps {
  daily: Map<string, AiUsageBucket>
  weekly: Map<string, AiUsageBucket>
  monthly: Map<string, AiUsageBucket>
}

const emptyTrendMaps = (): TrendMaps => ({ daily: new Map(), weekly: new Map(), monthly: new Map() })

function bumpTrend(maps: TrendMaps, e: AiUsageEntry): void {
  bump(maps.daily, dayLabel(e.ts), e)
  bump(maps.weekly, weekLabel(e.ts), e)
  bump(maps.monthly, monthLabel(e.ts), e)
}

const DAILY_WINDOW = 30
const WEEKLY_WINDOW = 12
const MONTHLY_WINDOW = 12

function trendFrom(maps: TrendMaps): AiUsageTrend {
  return {
    daily: seriesFrom(maps.daily, DAILY_WINDOW),
    weekly: seriesFrom(maps.weekly, WEEKLY_WINDOW),
    monthly: seriesFrom(maps.monthly, MONTHLY_WINDOW)
  }
}

export async function readUsage(): Promise<AiUsageStats> {
  const ledger = await read()
  const monthStart = startOfMonth()

  const month = emptyBucket()
  const allTime = emptyBucket()
  const globalTrend = emptyTrendMaps()
  const byProvider = new Map<AiProviderId, { month: AiUsageBucket; allTime: AiUsageBucket; trend: TrendMaps }>()
  const byConnection = new Map<
    string,
    { provider: AiProviderId; month: AiUsageBucket; allTime: AiUsageBucket; trend: TrendMaps; lastUsedAt: number }
  >()
  const byModel = new Map<string, { provider: AiProviderId; model: string; month: AiUsageBucket }>()
  const byDay = new Map<string, number>()

  for (const e of ledger.entries) {
    const inMonth = e.ts >= monthStart
    add(allTime, e)
    bumpTrend(globalTrend, e)
    const prov = byProvider.get(e.provider) ?? { month: emptyBucket(), allTime: emptyBucket(), trend: emptyTrendMaps() }
    add(prov.allTime, e)
    bumpTrend(prov.trend, e)
    // An entry written before connections existed carries no `connectionId`; it
    // belongs to the provider's default connection, whose id IS the provider id.
    const connectionId = e.connectionId ?? e.provider
    const conn = byConnection.get(connectionId) ?? {
      provider: e.provider,
      month: emptyBucket(),
      allTime: emptyBucket(),
      trend: emptyTrendMaps(),
      lastUsedAt: 0
    }
    add(conn.allTime, e)
    bumpTrend(conn.trend, e)
    conn.lastUsedAt = Math.max(conn.lastUsedAt, e.ts)
    if (inMonth) add(conn.month, e)
    byConnection.set(connectionId, conn)
    if (inMonth) {
      add(month, e)
      add(prov.month, e)
      const key = `${e.provider}:${e.model}`
      const m = byModel.get(key) ?? { provider: e.provider, model: e.model, month: emptyBucket() }
      add(m.month, e)
      byModel.set(key, m)
      byDay.set(dayLabel(e.ts), (byDay.get(dayLabel(e.ts)) ?? 0) + e.costUsd)
    }
    byProvider.set(e.provider, prov)
  }

  const recentEntries = ledger.entries.slice(-RECENT_LIMIT).reverse()

  return {
    month,
    allTime,
    byProvider: [...byProvider.entries()]
      .map(([provider, b]) => ({ provider, month: b.month, allTime: b.allTime, trend: trendFrom(b.trend) }))
      .sort((a, b) => b.allTime.costUsd - a.allTime.costUsd),
    byConnection: [...byConnection.entries()]
      .map(([connectionId, b]) => ({
        connectionId,
        provider: b.provider,
        month: b.month,
        allTime: b.allTime,
        trend: trendFrom(b.trend),
        lastUsedAt: b.lastUsedAt
      }))
      .sort((a, b) => b.allTime.costUsd - a.allTime.costUsd),
    byModel: [...byModel.values()].sort((a, b) => b.month.costUsd - a.month.costUsd),
    byDay: [...byDay.entries()].map(([day, costUsd]) => ({ day, costUsd })).sort((a, b) => a.day.localeCompare(b.day)),
    trend: trendFrom(globalTrend),
    budget: ledger.budget,
    recentEntries,
    since: ledger.entries[0] ? monthLabel(ledger.entries[0].ts) : null
  }
}
