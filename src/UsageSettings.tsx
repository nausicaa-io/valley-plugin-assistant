import type { FC } from 'react'
import { React, api } from './runtime'
import { LuChevronDown, LuChevronRight, LuExternalLink } from './settingsIcons'
import type { AiCacheStats, AiConnectionStatus, AiOllamaStatus, AiProviderBalance, AiProviderBalanceResult, AiUsageDatedBucket, AiUsageStats } from './types'
import { useUsageTheme, type TextColorTheme } from './usageCharts'

import { UsageAreaChart as ValleyAreaChart, UsageBarChart as ValleyGroupedBarChart } from './usageCharts'

import { UsageTabs as Tabs } from './UsageTabs'

import { uiText, connectionProviderText } from './localization'
const formatDate = (value: Date | string | number, options: Intl.DateTimeFormatOptions): string => new Intl.DateTimeFormat(api.ui.language(), options).format(new Date(value))


type Grain = 'daily' | 'weekly' | 'monthly'

const GRAINS: { id: Grain; labelKey: string }[] = [
  { id: 'daily', labelKey: 'auto.728298d3dbf4' },
  { id: 'weekly', labelKey: 'auto.158f3da59275' },
  { id: 'monthly', labelKey: 'auto.d31edb7b8a94' }
]

const money = (n: number): string => `$${n.toFixed(n < 1 && n > 0 ? 4 : 2)}`
const tokens = (n: number): string =>
  n >= 1_000_000 ? `${(n / 1_000_000).toFixed(1)}M` : n >= 1_000 ? `${(n / 1_000).toFixed(1)}K` : `${n}`

function formatBalance(b: AiProviderBalance): string {
  const symbol = b.currency === 'USD' ? '$' : b.currency === 'CNY' ? '¥' : ''
  return `${symbol}${b.available.toFixed(2)}${symbol ? '' : ` ${b.currency}`}`
}



/** Axis label for a trend period — always includes year. */
function periodLabel(period: string, grain: Grain, dateFormat: string): string {
  if (grain === 'monthly') {
    const d = new Date(`${period}-01T00:00:00`)
    return Number.isNaN(d.getTime()) ? period : formatDate(d, { month: 'short', year: 'numeric' })
  }
  const parts = period.split('-')
  if (parts.length < 3) return period
  const [yyyy, mm, dd] = parts
  const lower = dateFormat.toLowerCase()
  const sep = lower.match(/[^a-z\d]/)?.[0] ?? '-'
  return lower.startsWith('d') ? `${dd}${sep}${mm}${sep}${yyyy}` : `${mm}${sep}${dd}${sep}${yyyy}`
}

/** Full date for tooltip, respecting the user's preferred date format. */
function periodTooltip(period: string, grain: Grain, dateFormat: string): string {
  if (grain === 'monthly') return period
  const parts = period.split('-')
  if (parts.length < 3) return period
  const [yyyy, mm, dd] = parts
  const lower = dateFormat.toLowerCase()
  const sep = lower.match(/[^a-z\d]/)?.[0] ?? '-'
  if (lower.startsWith('d')) return `${dd}${sep}${mm}${sep}${yyyy}`
  if (lower.startsWith('m')) return `${mm}${sep}${dd}${sep}${yyyy}`
  return period
}

async function invokeAi<T>(method: string, payload: unknown = {}): Promise<T | undefined> {
  try { return await api.backend.call(`ai.${method}`, payload) as T } catch { return undefined }
}

/** One provider's live balance fetch state (stale-while-revalidate). */
interface BalanceState {
  value: AiProviderBalance | null
  loading: boolean
}

/** One connection paired with its ledger rollup — what a card renders. */
interface ConnectionRow {
  connection: AiConnectionStatus
  usage?: AiUsageStats['byConnection'][number]
}

/**
 * Split the connections into what is worth showing. **Active** is a working
 * credential. **Retired** is recorded spend with no working credential — the
 * money is still yours to account for, so it must not vanish. Everything else
 * (never configured, never used) is dropped rather than rendered as `$0.00`.
 */
export function splitConnections(
  connections: AiConnectionStatus[],
  byConnection: AiUsageStats['byConnection']
): { active: ConnectionRow[]; retired: ConnectionRow[] } {
  const usageById = new Map(byConnection.map((u) => [u.connectionId, u]))
  const active: ConnectionRow[] = []
  const retired: ConnectionRow[] = []
  for (const connection of connections) {
    const row: ConnectionRow = { connection, usage: usageById.get(connection.id) }
    if (connection.configured) active.push(row)
    else if ((row.usage?.allTime.costUsd ?? 0) > 0 || (row.usage?.allTime.calls ?? 0) > 0) retired.push(row)
  }
  const sort = (rows: ConnectionRow[]): ConnectionRow[] =>
    rows.sort((a, b) => (b.usage?.allTime.costUsd ?? 0) - (a.usage?.allTime.costUsd ?? 0))
  return { active: sort(active), retired: sort(retired) }
}

const connectionName = (connection: AiConnectionStatus): string => connection.label || connectionProviderText(connection.provider, 'name', connection.providerName)

export const UsageBillingSection: FC = () => {
  const t = uiText
  const { ref, textColors, accentColor, accentFill } = useUsageTheme()
  const dateFormat = React.useSyncExternalStore(api.settings.core.subscribe, () => String(api.settings.core.get('dateFormat') ?? 'yyyy-MM-dd'))
  const [usage, setUsage] = React.useState<AiUsageStats | null>(null)
  const [connections, setConnections] = React.useState<AiConnectionStatus[]>([])
  const [grain, setGrain] = React.useState<Grain>('daily')
  const [cache, setCache] = React.useState<AiCacheStats | null>(null)
  const [balances, setBalances] = React.useState<Record<string, BalanceState>>({})
  const [ollama, setOllama] = React.useState<{ value: AiOllamaStatus | null; loading: boolean }>({ value: null, loading: false })
  const [showRetired, setShowRetired] = React.useState(false)

  // ── Phase 1: fast local reads (ledger + config) — render immediately. ───────
  const loadUsage = React.useCallback(async () => {
    const data = await invokeAi<AiUsageStats>('getUsage')
    if (!data) return
    setUsage(data)
  }, [])

  const loadConnections = React.useCallback(async () => {
    const data = await invokeAi<{ connections: AiConnectionStatus[] }>('listConnections')
    if (data) setConnections(data.connections)
  }, [])

  const loadCache = React.useCallback(async () => {
    const data = await invokeAi<AiCacheStats>('getCacheStats')
    if (data) setCache(data)
  }, [])

  React.useEffect(() => {
    void loadUsage()
    void loadConnections()
    void loadCache()
  }, [loadUsage, loadConnections, loadCache])

  // ── Phase 2: slow network reads, per card, never blocking the section. ──────
  const refreshBalance = React.useCallback((connection: AiConnectionStatus) => {
    const id = connection.id
    setBalances((s) => ({ ...s, [id]: { value: s[id]?.value ?? null, loading: true } }))
    void invokeAi<AiProviderBalanceResult>('getBalance', { provider: connection.provider, connectionId: id }).then((res) => {
      setBalances((s) => ({ ...s, [id]: { value: res?.balance ?? null, loading: false } }))
    })
  }, [])

  const refreshOllama = React.useCallback(() => {
    setOllama((o) => ({ value: o.value, loading: true }))
    void invokeAi<AiOllamaStatus>('ollamaStatus').then((res) => setOllama({ value: res ?? null, loading: false }))
  }, [])

  React.useEffect(() => {
    if (!connections.length) return
    for (const c of connections) {
      if (c.providerCapabilities.includes('balance') && c.configured) refreshBalance(c)
    }
    if (connections.some((c) => c.providerCapabilities.includes('status') && c.configured)) refreshOllama()
  }, [connections, refreshBalance, refreshOllama])

  const { active, retired } = React.useMemo(
    () => splitConnections(connections, usage?.byConnection ?? []),
    [connections, usage]
  )

  if (!usage) {
    return (
      <section ref={ref} className="settings-section usage-billing">
        <div className="ub-empty">{uiText('auto.6346c7978ffe')}</div>
      </section>
    )
  }

  const totalTokens = usage.allTime.inputTokens + usage.allTime.outputTokens
  const series = usage.trend[grain]

  const cardFor = (row: ConnectionRow): ReturnType<typeof ConnectionCard> => (
    <ConnectionCard
      key={row.connection.id}
      connection={row.connection}
      usage={row.usage}
      grain={grain}
      dateFormat={dateFormat}
      textColors={textColors}
      accentColor={accentColor}
      accentFill={accentFill}
      balance={balances[row.connection.id]}
      onRefreshBalance={row.connection.providerCapabilities.includes('balance') ? () => refreshBalance(row.connection) : undefined}
      ollama={row.connection.providerCapabilities.includes('status') ? ollama : undefined}
      onRefreshOllama={row.connection.providerCapabilities.includes('status') ? refreshOllama : undefined}
    />
  )

  return (
    <section ref={ref} className="settings-section usage-billing">
      {/* ── Overview ──────────────────────────────────────────────────────── */}
      <div className="ub-overview">
        <div className="ub-stats">
          <Stat label={uiText('auto.912c2eb1c016')} value={money(usage.allTime.costUsd)} sub={uiText('assistant.usage.monthSpend', { amount: money(usage.month.costUsd) })} />
          <Stat label={uiText('auto.e6dad16eef95')} value={tokens(totalTokens)} sub={uiText('assistant.usage.tokenSplit', { input: tokens(usage.allTime.inputTokens), output: tokens(usage.allTime.outputTokens) })} />
          <Stat label={uiText('auto.0a19b7e26b2b')} value={String(usage.allTime.calls)} sub={usage.since ? uiText('assistant.usage.since', { date: usage.since }) : uiText('assistant.usage.allTime')} />
          {cache && cache.hits > 0 && (
            <Stat
              label={uiText('auto.cf37892967d7')}
              value={String(cache.hits)}
              sub={cache.savedCostUsd > 0 ? uiText('assistant.usage.saved', { amount: money(cache.savedCostUsd) }) : uiText('assistant.usage.metadataCached')}
            />
          )}
        </div>
        <div className="ub-trend">
          <div className="ub-trend-head">
            <span className="ub-trend-title">{uiText('auto.49017beb5f15')}</span>
            <Tabs
              className="ub-grain"
              value={grain}
              onChange={(value) => setGrain(value as Grain)}
              tabs={GRAINS.map(({ id, labelKey }) => ({ id, label: t(labelKey) }))}
              ariaLabel={uiText('auto.49017beb5f15')}
            />
          </div>
          <div className="ub-trend-chart">
            <TrendChart series={series} grain={grain} textColors={textColors} height={150} dateFormat={dateFormat} accentColor={accentColor} accentFill={accentFill} />
          </div>
        </div>
      </div>

      {/* ── Active connections ────────────────────────────────────────────── */}
      <div className="ub-group">
        <h5 className="ub-group-title">
          {uiText('auto.7ee707b2943a')}<span className="ub-group-count">{active.length}</span>
        </h5>
        {active.length === 0 ? (
          <p className="ub-group-empty">{uiText('auto.06015a6b0e7e')}</p>
        ) : (
          <div className="ub-cards">{active.map(cardFor)}</div>
        )}
      </div>

      {/* ── Retired: spend on record, credential gone. Collapsed by default. ─ */}
      {retired.length > 0 && (
        <div className="ub-group">
          <button
            type="button"
            className="ub-group-toggle"
            aria-expanded={showRetired}
            onClick={() => setShowRetired((open) => !open)}
          >
            {showRetired ? <LuChevronDown aria-hidden /> : <LuChevronRight aria-hidden />}
            <h5 className="ub-group-title">
              {uiText('auto.37d1213e53ce')}<span className="ub-group-count">{retired.length}</span>
            </h5>
            <span className="ub-group-sub">
              {money(retired.reduce((sum, r) => sum + (r.usage?.allTime.costUsd ?? 0), 0))} {uiText('auto.afd1a1ac006e')}</span>
          </button>
          {showRetired && <div className="ub-cards">{retired.map(cardFor)}</div>}
        </div>
      )}
    </section>
  )
}

const Stat: FC<{ label: string; value: string; sub?: string }> = ({ label, value, sub }) => (
  <div className="ub-stat">
    <span className="ub-stat-label">{label}</span>
    <span className="ub-stat-value">{value}</span>
    {sub && <span className="ub-stat-sub">{sub}</span>}
  </div>
)

/** Daily → area chart; weekly/monthly → bars. */
const TrendChart: FC<{ series: AiUsageDatedBucket[]; grain: Grain; textColors: TextColorTheme; height: number; dateFormat: string; accentColor: string; accentFill: string; hideYAxis?: boolean }> = ({
  series,
  grain,
  textColors,
  height,
  dateFormat,
  accentColor,
  accentFill,
  hideYAxis = false
}) => {
  const labels = series.map((s) => periodLabel(s.period, grain, dateFormat))
  const titles = series.map((s) => periodTooltip(s.period, grain, dateFormat))
  const data = series.map((s) => Number(s.costUsd.toFixed(4)))
  if (grain === 'daily') {
    return <ValleyAreaChart labels={labels} data={data} tooltipTitles={titles} textColors={textColors} color={accentColor} fillColor={accentFill} unit="$" height={height} hideYAxis={hideYAxis} />
  }
  return (
    <ValleyGroupedBarChart
      labels={labels}
      series={[{ label: uiText('auto.14eeee8d4078'), data, color: accentColor }]}
      tooltipTitles={titles}
      textColors={textColors}
      unit="$"
      legend={false}
      height={height}
    />
  )
}

const ConnectionCard: FC<{
  connection: AiConnectionStatus
  usage?: AiUsageStats['byConnection'][number]
  grain: Grain
  dateFormat: string
  textColors: TextColorTheme
  accentColor: string
  accentFill: string
  balance?: BalanceState
  onRefreshBalance?: () => void
  ollama?: { value: AiOllamaStatus | null; loading: boolean }
  onRefreshOllama?: () => void
}> = ({ connection, usage, grain, dateFormat, textColors, accentColor, accentFill, balance, onRefreshBalance, ollama, onRefreshOllama }) => {
  const month = usage?.month
  const spent = month?.costUsd ?? 0
  const isLocal = !connection.requiresKey
  const series = usage?.trend[grain] ?? []
  const hasData = series.some((s) => s.costUsd > 0)
  const name = connectionName(connection)

  return (
    <div className={`ub-card ${connection.configured ? '' : 'ub-card--off'}`}>
      <div className="ub-card-head">
        <span className="ub-card-title">{name}</span>
        <span
          className={`ub-dot ${connection.configured ? 'ok' : 'off'}`}
          title={connection.configured ? uiText('auto.668c5fffd24d') : uiText('auto.811931bba8d1')}
        />
      </div>
      {/* Only a labelled connection needs its provider spelled out — an unlabelled
          one already shows the provider name as its title. */}
      {connection.label && <span className="ub-card-sub">{connectionProviderText(connection.provider, 'name', connection.providerName)}</span>}
      {!connection.configured && usage && (
        <span className="ub-card-sub">{uiText('auto.d808326bc96e')}{formatDate(usage.lastUsedAt, { dateStyle: 'medium' })}</span>
      )}

      {/* Balance / money-left slot */}
      <div className="ub-card-balance">
        {isLocal ? (
          <OllamaSlot ollama={ollama} baseUrl={connection.baseUrl} onRefresh={onRefreshOllama} />
        ) : onRefreshBalance ? (
          <BalanceSlot balance={balance} onRefresh={onRefreshBalance} />
        ) : (
          <span className="ub-balance-est" title={uiText('auto.08a36b07903f')}>
            {money(spent)} <span className="ub-muted">{uiText('auto.d48c0536fb1d')}</span>
          </span>
        )}
      </div>

      {/* Token split + cost */}
      {!isLocal && (
        <div className="ub-card-meta">
          <span>{tokens(month?.inputTokens ?? 0)} {uiText('auto.ee578fffa2a2')}{' '}{tokens(month?.outputTokens ?? 0)} {uiText('auto.cadc91415a09')}</span>
          <span className="ub-card-cost">{money(spent)}</span>
        </div>
      )}

      {hasData && (
        <div className="ub-card-spark">
          <TrendChart series={series} grain={grain} textColors={textColors} accentColor={accentColor} accentFill={accentFill} dateFormat={dateFormat} height={150} />
        </div>
      )}

      {connection.providerSettingsUrl && (
        <a className="ub-card-link" href={connection.providerSettingsUrl} onClick={(event) => { event.preventDefault(); void api.files.openExternalUrl(event.currentTarget.href) }}>
          {new URL(connection.providerSettingsUrl).hostname} <LuExternalLink />
        </a>
      )}
    </div>
  )
}

const BalanceSlot: FC<{ balance?: BalanceState; onRefresh: () => void }> = ({ balance, onRefresh }) => {
  if (balance?.value) {
    return (
      <button className="ub-balance" onClick={onRefresh} title={uiText('auto.932e2e52a56b')}>
        <span className="ub-balance-amt">{formatBalance(balance.value)}</span>
        <span className="ub-muted">{uiText('auto.12c0f1fbadc4')}{' '}{balance.loading ? ' · …' : ''}</span>
      </button>
    )
  }
  if (balance?.loading || !balance) return <span className="ub-skeleton" aria-label={uiText('auto.eb1274eb9450')} />
  return (
    <button className="ub-balance ub-balance--none" onClick={onRefresh} title={uiText('auto.9f5cd8a2e880')}>
      <span className="ub-muted">{uiText('auto.e4347f30f1c1')}</span>
    </button>
  )
}

const OllamaSlot: FC<{ ollama?: { value: AiOllamaStatus | null; loading: boolean }; baseUrl?: string; onRefresh?: () => void }> = ({
  ollama,
  baseUrl,
  onRefresh
}) => {
  if (ollama?.loading && !ollama.value) return <span className="ub-skeleton" aria-label={uiText('auto.e2a1642ea2c4')} />
  const s = ollama?.value
  if (s?.running) {
    return (
      <button className="ub-ollama" onClick={onRefresh} title={uiText('auto.56e3badc4e6c')}>
        <span className="ub-dot ok" /> {uiText('auto.73989d9c5926')}{' '}{s.version ? ` v${s.version}` : ''} · {uiText('localization.usage.models', { count: s.models.length })}
      </button>
    )
  }
  return (
    <button className="ub-ollama ub-ollama--off" onClick={onRefresh} title={uiText('auto.9f5cd8a2e880')}>
      <span className="ub-dot off" /> {uiText('auto.ec5967e55595')}{' '}{baseUrl ?? 'localhost:11434'}
    </button>
  )
}
