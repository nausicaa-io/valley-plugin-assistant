import type { FC } from 'react'
import { React, api } from './runtime'
import { uiText } from './localization'
import type { ValleyAreaChartProps } from './charts/ValleyAreaChart'
import type { ValleyGroupedBarChartProps } from './charts/ValleyGroupedBarChart'
import type { TextColorTheme } from './charts/types'
export type { TextColorTheme } from './charts/types'

type ChartSpec = { kind: 'area'; props: ValleyAreaChartProps } | { kind: 'bar'; props: ValleyGroupedBarChartProps }
type ChartHandle = { update(spec: ChartSpec): void; destroy(): void }
type ChartIsland = { mount(element: HTMLElement, spec: ChartSpec, pluginApi: typeof api): ChartHandle }
const islands = new WeakMap<Document, Promise<ChartIsland>>()
function loadIsland(doc: Document): Promise<ChartIsland> {
  const previous = islands.get(doc)
  if (previous) return previous
  const pending = new Promise<ChartIsland>((resolve, reject) => {
    const script = doc.createElement('script')
    script.type = 'module'
    script.src = api.assets.url('charts.js')
    script.onload = () => {
      const island = (doc.defaultView as unknown as { valleyAssistantCharts?: ChartIsland }).valleyAssistantCharts
      if (island) resolve(island)
      else reject(new Error('Chart module did not initialize'))
    }
    script.onerror = () => reject(new Error('Chart module could not load'))
    doc.head.appendChild(script)
  })
  islands.set(doc, pending)
  void pending.catch(() => islands.delete(doc))
  return pending
}
function UsageChart(spec: ChartSpec): React.ReactElement {
  const element = React.useRef<HTMLDivElement>(null)
  const handle = React.useRef<ChartHandle | null>(null)
  const latest = React.useRef(spec)
  latest.current = spec
  const [error, setError] = React.useState(false)
  React.useEffect(() => {
    const host = element.current
    if (!host) return
    let live = true
    void loadIsland(host.ownerDocument).then((island) => {
      if (live) handle.current = island.mount(host, latest.current, api)
    }).catch(() => { if (live) setError(true) })
    return () => { live = false; handle.current?.destroy(); handle.current = null }
  }, [])
  React.useEffect(() => { handle.current?.update(spec) }, [spec])
  return <div style={{ height: spec.props.height === -1 ? '100%' : spec.props.height }}>
    <div ref={element} style={{ height: '100%' }} />
    {error && <span role="alert">{uiText('assistant.usage.chartError')}</span>}
  </div>
}
export const UsageAreaChart: FC<ValleyAreaChartProps> = (props) => <UsageChart kind="area" props={{ ...props, noDataText: uiText('assistant.usage.noData') }} />
export const UsageBarChart: FC<ValleyGroupedBarChartProps> = (props) => <UsageChart kind="bar" props={{ ...props, noDataText: uiText('assistant.usage.noData') }} />

export function useUsageTheme(): { ref: (element: HTMLElement | null) => void; textColors: TextColorTheme; accentColor: string; accentFill: string } {
  const [element, ref] = React.useState<HTMLElement | null>(null)
  const [theme, setTheme] = React.useState({
    textColors: { bodyColor: '#fff', bodyColorText: '#111', titleColorRGBA: '#666', lineColorRGBA: '#ddd' },
    accentColor: '#e91e8c', accentFill: 'rgba(233,30,140,0.12)'
  })
  React.useEffect(() => {
    const win = element?.ownerDocument.defaultView
    if (!element || !win) return
    const update = (): void => {
      const style = win.getComputedStyle(element)
      const value = (key: string, fallback: string): string => style.getPropertyValue(key).trim() || fallback
      setTheme({ textColors: { bodyColor: value('--surface-color', '#fff'), bodyColorText: value('--title-color', '#111'), titleColorRGBA: value('--text-color', '#666'), lineColorRGBA: value('--border-medium', '#ddd') }, accentColor: value('--accent-color', '#e91e8c'), accentFill: value('--accent-tint-bg', 'rgba(233,30,140,0.12)') })
    }
    update()
    const observer = new win.MutationObserver(update)
    observer.observe(element.ownerDocument.documentElement, { attributes: true })
    observer.observe(element.ownerDocument.head, { childList: true, subtree: true, characterData: true, attributes: true })
    return () => observer.disconnect()
  }, [element])
  return { ref, ...theme }
}
