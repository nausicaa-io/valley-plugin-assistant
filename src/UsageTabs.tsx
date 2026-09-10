import type { FC, KeyboardEvent } from 'react'
import { React } from './runtime'

export const UsageTabs: FC<{ value: string; onChange(id: string): void; tabs: { id: string; label: string }[]; ariaLabel: string; className?: string }> = ({ value, onChange, tabs, ariaLabel, className }) => {
  const ref = React.useRef<HTMLDivElement>(null)
  const move = (event: KeyboardEvent<HTMLDivElement>): void => {
    const index = tabs.findIndex((tab) => tab.id === value)
    const delta = event.key === 'ArrowRight' ? 1 : event.key === 'ArrowLeft' ? -1 : 0
    const next = delta ? (index + delta + tabs.length) % tabs.length : event.key === 'Home' ? 0 : event.key === 'End' ? tabs.length - 1 : -1
    const target = tabs[next]
    if (!target) return
    event.preventDefault()
    onChange(target.id)
    ref.current?.querySelectorAll<HTMLButtonElement>('[role="tab"]')[next]?.focus()
  }
  return <div ref={ref} className={`settings-tabs ${className ?? ''}`} role="tablist" aria-label={ariaLabel} onKeyDown={move}>
    {tabs.map((tab) => <button key={tab.id} type="button" role="tab" className={`settings-tab ${value === tab.id ? 'active' : ''}`} aria-selected={value === tab.id} tabIndex={value === tab.id ? 0 : -1} onClick={() => onChange(tab.id)}>{tab.label}</button>)}
  </div>
}
