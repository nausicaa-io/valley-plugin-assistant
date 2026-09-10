import { React, api } from './runtime'
import type { FC, ReactNode } from 'react'
import type { MainWorkspaceViewProps } from '@valley/plugin-sdk'
import type { AiMessage, AiProviderId, AiToolCall } from './types'
import type { GuardDangerousMode, PermissionRequest } from '@valley/plugin-sdk/guard/types'
import { assetUrlForRelPath } from '@valley/plugin-sdk/fileTypes'
import { usePluginSetting, useAssistant } from './hooks'
import {
  Check,
  ChevronRight,
  CircleCheck,
  Copy,
  Folder,
  Hand,
  Send,
  Stop,
  Telegram,
  Tool,
  Warning,
  WhatsApp,
  X
} from './icons'
import type { InboundAttachment } from './types'
import { uiText } from './localization'

/** Classify a dropped/picked File into an ingest kind; video is unsupported. */
function attachmentKind(file: File): InboundAttachment['kind'] | null {
  if (file.type.startsWith('video/')) return null
  if (file.type.startsWith('image/')) return 'image'
  if (file.type === 'application/pdf' || /\.pdf$/i.test(file.name)) return 'pdf'
  if (file.type.startsWith('audio/')) return 'audio'
  return 'file'
}

/** Where a picked/dropped attachment is written when Chat settings name no folder. */
export const DEFAULT_ATTACH_INBOX = 'Meadow/Chorus/Chats/inbox'

/** Read a File's bytes as a base64 string (no data-URL prefix). */
function fileToBase64(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader()
    reader.onload = () => resolve(String(reader.result).split(',')[1] ?? '')
    reader.onerror = () => reject(reader.error)
    reader.readAsDataURL(file)
  })
}

type ApprovalAction = 'allow-once' | 'skip' | 'always-allow' | 'always-ask' | 'block'

/** mm:ss left until a dangerous-mode bypass expires. */
function countdown(expiresAt: number | null, now: number): string {
  const ms = Math.max(0, (expiresAt ?? 0) - now)
  const total = Math.round(ms / 1000)
  return `${Math.floor(total / 60)}:${String(total % 60).padStart(2, '0')}`
}

function dangerousActive(d: GuardDangerousMode | null, now: number): boolean {
  return Boolean(d?.enabled) && d!.expiresAt != null && d!.expiresAt > now
}

/** The Guard approval card — one prompt, the full button set (C4.4). */
const ApprovalCard: FC<{ request: PermissionRequest; onRespond: (a: ApprovalAction) => void }> = ({ request, onRespond }) => {
  const targetLabel = request.target.path ?? request.target.id ?? request.actionLabel
  let args = ''
  try {
    args = JSON.stringify(request.argsPreview, null, 2)
  } catch {
    args = String(request.argsPreview)
  }
  return (
    <div className="assistant-approval">
      <div className="assistant-approval-text">
        {uiText('auto.3ad0e3698278')}{' '}<code>{request.actionLabel}</code>
        {targetLabel !== request.actionLabel && <span className="assistant-approval-target"> · {targetLabel}</span>}?
      </div>
      <div className="assistant-approval-actions">
        <button className="assistant-btn" onClick={() => onRespond('allow-once')}>
          <Check className="" /> {uiText('auto.c551e6cf17a5')}</button>
        <button className="assistant-btn assistant-btn-ghost" onClick={() => onRespond('skip')}>
          <X className="" /> {uiText('auto.3da474537ac3')}</button>
        {request.canRememberApproval && (
          <button className="assistant-btn assistant-btn-ghost" onClick={() => onRespond('always-allow')}>
            {uiText('auto.611a1cce4ffe')}</button>
        )}
        <button className="assistant-btn assistant-btn-ghost" onClick={() => onRespond('always-ask')}>
          {uiText('auto.065b047a8bc3')}</button>
        <button className="assistant-btn assistant-btn-ghost assistant-btn-danger" onClick={() => onRespond('block')}>
          {uiText('auto.08991ac33209')}</button>
      </div>
      {(args && args !== '{}' && args !== 'undefined') && (
        <details className="assistant-approval-details">
          <summary>{uiText('auto.dc3decbb9384')}</summary>
          <pre className="assistant-approval-args">{args}</pre>
          {request.diffPreview && <pre className="assistant-approval-args">{request.diffPreview}</pre>}
        </details>
      )}
    </div>
  )
}

interface ActivityEntry {
  call?: AiToolCall
  result?: AiMessage
}

type RenderItem =
  | { kind: 'message'; message: AiMessage }
  | { kind: 'activity'; entries: ActivityEntry[] }

function prettyToolName(name?: string): string {
  if (!name) return uiText('auto.9a830c714bb2')
  return name
    .replace(/[_-]+/g, ' ')
    .replace(/\b\w/g, (c) => c.toUpperCase())
}

function formatArgs(args?: Record<string, unknown>): string {
  if (!args || Object.keys(args).length === 0) return ''
  try {
    return JSON.stringify(args, null, 2)
  } catch {
    return String(args)
  }
}

function resultPreview(text?: string): string {
  const compact = (text ?? '').replace(/\s+/g, ' ').trim()
  if (!compact) return ''
  return compact.length > 92 ? `${compact.slice(0, 92)}…` : compact
}

function activityTitle(entry: ActivityEntry): string {
  if (entry.call) return prettyToolName(entry.call.name)
  return uiText('auto.a2cbfa2169f4', { p0: prettyToolName(entry.result?.name) })
}

/** Unknown provider tools are intentionally rendered without owner-specific
 * knowledge; their descriptor name and result remain visible in the details. */
function toolStepIcon(_entry: ActivityEntry): ReactNode {
  return <Tool className="" />
}

function activityMeta(entries: ActivityEntry[]): string {
  const complete = entries.filter((entry) => entry.result).length
  if (entries.length === 1) return resultPreview(entries[0].result?.content) || (complete ? uiText('auto.e9b450d14bc2') : uiText('auto.73989d9c5926'))
  return complete === entries.length ? uiText('auto.e4f8607fc7e9', { p0: entries.length }) : uiText('auto.e4006181a5f5', { p0: complete, p1: entries.length })
}

function buildRenderItems(messages: AiMessage[]): RenderItem[] {
  const items: RenderItem[] = []
  let i = 0
  while (i < messages.length) {
    const message = messages[i]
    if (message.role === 'system') {
      i += 1
      continue
    }

    if (message.role === 'assistant' && message.toolCalls?.length) {
      if (message.content.trim()) {
        items.push({ kind: 'message', message: { ...message, toolCalls: undefined } })
      }

      const callIds = new Set(message.toolCalls.map((call) => call.id))
      const results: AiMessage[] = []
      let j = i + 1
      while (j < messages.length && messages[j].role === 'tool') {
        const toolCallId = messages[j].toolCallId
        if (toolCallId && !callIds.has(toolCallId)) break
        results.push(messages[j])
        j += 1
      }

      const usedResults = new Set<AiMessage>()
      const entries: ActivityEntry[] = message.toolCalls.map((call) => {
        const result =
          results.find((r) => r.toolCallId === call.id && !usedResults.has(r)) ??
          results.find((r) => r.name === call.name && !usedResults.has(r))
        if (result) usedResults.add(result)
        return { call, result }
      })
      results.filter((result) => !usedResults.has(result)).forEach((result) => entries.push({ result }))
      items.push({ kind: 'activity', entries })
      i = j
      continue
    }

    if (message.role === 'tool') {
      items.push({ kind: 'activity', entries: [{ result: message }] })
      i += 1
      continue
    }

    items.push({ kind: 'message', message })
    i += 1
  }
  return items
}

const ActivityBlock: FC<{ entries: ActivityEntry[] }> = ({ entries }) => {
  const title = entries.length === 1 ? activityTitle(entries[0]) : uiText('auto.98fa5e74846e', { p0: entries.length })
  const meta = activityMeta(entries)
  const allDone = entries.length > 0 && entries.every((entry) => entry.result)
  return (
    <details className="assistant-activity">
      <summary>
        <ChevronRight className="assistant-activity-caret" />
        <span className="assistant-activity-text">
          <span className="assistant-activity-title">{title}</span>
          {meta && <span className="assistant-activity-meta">({meta})</span>}
        </span>
      </summary>
      <div className="assistant-activity-body">
        {entries.map((entry, index) => {
          const args = formatArgs(entry.call?.arguments)
          return (
            <div key={`${entry.call?.id ?? entry.result?.toolCallId ?? entry.result?.name ?? 'tool'}-${index}`} className="assistant-activity-step">
              <div className="assistant-activity-step-head">
                <span className="assistant-activity-step-ico" aria-hidden="true">{toolStepIcon(entry)}</span>
                <span className="assistant-activity-step-title">{activityTitle(entry)}</span>
              </div>
              {args && <pre className="assistant-activity-args">{args}</pre>}
              {entry.result?.content && <div className="assistant-activity-output">{entry.result.content}</div>}
            </div>
          )
        })}
        {allDone && (
          <div className="assistant-activity-step assistant-activity-done">
            <div className="assistant-activity-step-head">
              <span className="assistant-activity-step-ico" aria-hidden="true"><CircleCheck className="" /></span>
              <span className="assistant-activity-step-title">{uiText('auto.e9b450d14bc2')}</span>
            </div>
          </div>
        )}
      </div>
    </details>
  )
}

/** Render a message bubble as Notes Markdown via the host reading-view renderer:
 *  bold/italic, code blocks, KaTeX math, links, and `[[wikilinks]]` / `![[embeds]]`.
 *  The HTML is DOMPurify-sanitized by the host; we resolve embed/asset images to
 *  vault asset URLs and wire clicks — wikilinks open the file in a tab, external
 *  links open in the browser. */
const BubbleContent: FC<{ content: string }> = ({ content }) => {
  const [html, setHtml] = React.useState('')
  React.useEffect(() => {
    let active = true
    setHtml('')
    void api.markdown.render(content, { breaks: true }).then((value) => { if (active) setHtml(value) }).catch(() => { if (active) setHtml('') })
    return () => { active = false }
  }, [content])
  const rootRef = React.useRef<HTMLDivElement | null>(null)

  React.useEffect(() => {
    const root = rootRef.current
    if (!root) return
    root.querySelectorAll<HTMLImageElement>('img.md-embed[data-embed], img.md-asset[data-src]').forEach((img) => {
      const ref = img.dataset.embed ?? img.dataset.src
      if (!ref) return
      const rel = api.workspace.resolveWikilink(ref) ?? ref
      img.src = assetUrlForRelPath(rel)
      img.classList.add('assistant-bubble-image')
    })
  }, [html])

  const onClick = (e: React.MouseEvent): void => {
    const el = (e.target as Element | null)?.nodeType === 1 ? e.target as Element : null
    if (!el) return
    const wiki = el.closest('a.wikilink') as HTMLElement | null
    if (wiki) {
      e.preventDefault()
      const target = wiki.dataset.wikilink
      if (target && !target.startsWith('#')) api.workspace.openFile(api.workspace.resolveWikilink(target) ?? target)
      return
    }
    const link = el.closest('a[href]') as HTMLAnchorElement | null
    if (link) {
      const href = link.getAttribute('href') ?? ''
      if (href && href !== '#' && !href.startsWith('#')) {
        e.preventDefault()
        void api.files.openExternalUrl(href)
      }
    }
  }

  return (
    <div
      ref={rootRef}
      className="assistant-bubble-md markdown-body"
      onClick={onClick}
      dangerouslySetInnerHTML={{ __html: html }}
    />
  )
}

/** Format an epoch (ms) using the user's General-settings date + time format. */
function formatSendTime(ts: number, dateFormat: string, timeFormat: '24h' | '12h'): string {
  const d = new Date(ts)
  const y = d.getFullYear()
  const mo = String(d.getMonth() + 1).padStart(2, '0')
  const day = String(d.getDate()).padStart(2, '0')
  const datePart = (dateFormat || 'yyyy-mm-dd').replace('yyyy', String(y)).replace(/m{2}/i, mo).replace('dd', day)
  const timePart = new Intl.DateTimeFormat(api.ui.language(), {
    hour: '2-digit',
    minute: '2-digit',
    hour12: timeFormat === '12h'
  }).format(d)
  return `${datePart} · ${timePart}`
}

/** Copy button + send time revealed on hover under a message (either side). */
const MessageMeta: FC<{ content: string; ts?: number; showTime: boolean }> = ({ content, ts, showTime }) => {
  const [copied, setCopied] = React.useState(false)
  const copy = React.useCallback(() => {
    void navigator.clipboard.writeText(content).then(() => {
      setCopied(true)
      setTimeout(() => setCopied(false), 1500)
    })
  }, [content])
  const { dateFormat, timeFormat } = api.getState()
  return (
    <div className="assistant-msg-meta">
      <button
        type="button"
        className="assistant-copy-btn"
        onClick={copy}
        title={uiText('auto.26902efda37d')}
        aria-label={uiText('auto.26902efda37d')}
      >
        {copied ? <Check className="assistant-copy-icon" /> : <Copy className="assistant-copy-icon" />}
      </button>
      {showTime && ts != null && <span className="assistant-msg-time">{formatSendTime(ts, dateFormat, timeFormat)}</span>}
    </div>
  )
}

/** One message row: user / assistant text. */
const MessageRow: FC<{ message: AiMessage; showMeta?: boolean; copyText?: string; showTime: boolean }> = ({
  message,
  showMeta,
  copyText,
  showTime
}) => {
  if (message.role === 'tool') return <ActivityBlock entries={[{ result: message }]} />
  if (message.role === 'system') return null
  const mine = message.role === 'user'
  return (
    <div className={`assistant-msg ${mine ? 'mine' : 'theirs'}`}>
      {message.content && (
        <div className="assistant-bubble">
          <BubbleContent content={message.content} />
        </div>
      )}
      {showMeta && <MessageMeta content={copyText ?? message.content} ts={message.ts} showTime={showTime} />}
    </div>
  )
}

/**
 * The copy + timestamp row belongs only at the *end of each assistant turn* —
 * one per response, not after every interim message. A turn ends at the last
 * assistant message before the next user message (or the conversation end); its
 * copy yields the whole turn's text. Returns, per render-item index, the joined
 * turn text (or undefined when that item is not a turn end).
 */
function turnEndCopyText(items: RenderItem[]): (string | undefined)[] {
  const out: (string | undefined)[] = items.map(() => undefined)
  for (let i = 0; i < items.length; i++) {
    const it = items[i]
    if (it.kind !== 'message' || it.message.role !== 'assistant') continue
    let isEnd = true
    for (let j = i + 1; j < items.length; j++) {
      const nx = items[j]
      if (nx.kind === 'message' && nx.message.role === 'user') break
      if (nx.kind === 'message' && nx.message.role === 'assistant') {
        isEnd = false
        break
      }
    }
    if (!isEnd) continue
    // Gather this turn's assistant text: walk back to the previous user message.
    const parts: string[] = []
    for (let k = i; k >= 0; k--) {
      const m = items[k]
      if (m.kind === 'message' && m.message.role === 'user') break
      if (m.kind === 'message' && m.message.role === 'assistant' && m.message.content) parts.unshift(m.message.content)
    }
    if (parts.length) out[i] = parts.join('\n\n')
  }
  return out
}

/** Claude-style "the model is responding" indicator (pure-CSS, no rAF). */
const ThinkingIndicator: FC<{ phase: 'thinking' | 'working' }> = ({ phase }) => (
  <div className="assistant-run-status" role="status">
    <span className="assistant-run-label">
      {phase === 'working' ? uiText('auto.3b4dfc971393') : uiText('auto.d08d8da0b3e1')}
      <span className="assistant-think-dots" aria-hidden="true" />
    </span>
  </div>
)

/** The three composer permission levels — mirror Claude Code's default / acceptEdits / bypass. */
export type PermMode = 'ask' | 'act' | 'danger'

/**
 * Claude-style permission control: a hand button on the composer's left that opens
 * a popover to switch between "Ask before acting" (guard confirm), "Act without
 * asking" (guard allow), and "Dangerously skip permissions" (a time-boxed bypass
 * that converts every confirm → allow). Active state reflects the real guard policy
 * or an active dangerous-mode bypass.
 */
export const PermissionControl: FC<{
  active: PermMode
  disabled?: boolean
  onPick: (mode: PermMode) => void
}> = ({ active, disabled, onPick }) => {
  const handTitle =
    active === 'danger'
      ? uiText('auto.fa29173eedd5')
      : active === 'act'
        ? uiText('auto.256abbf7776a')
        : uiText('auto.6a9db7250ec0')

  // The closed button mirrors the menu's selected glyph so the active level reads at a glance.
  const activeGlyph =
    active === 'danger' ? (
      <Warning className="" />
    ) : active === 'act' ? (
      <span className="assistant-perm-chevrons" aria-hidden="true">»</span>
    ) : (
      <Hand className="" />
    )

  return (
    <div className="assistant-perm" onMouseDown={(e) => e.stopPropagation()}>
      <button
        type="button"
        className={`assistant-hand-btn${active !== 'ask' ? ' is-open' : ''}${active === 'danger' ? ' is-danger' : ''}`}
        title={handTitle}
        aria-label={uiText('auto.91dd0270b66c')}
        aria-haspopup="menu"
        disabled={disabled}
        onClick={(e) => void api.ui.openMenu([
          {
            label: uiText('auto.bcdeabe156d1'),
            description: uiText('auto.5a70f9d8047b'),
            icon: <Hand className="" />,
            type: 'radio',
            checked: active === 'ask',
            onSelect: () => onPick('ask')
          },
          {
            label: uiText('auto.16dd7d1dc9c4'),
            description: uiText('auto.e3cd4d7527f5'),
            icon: <span className="assistant-perm-chevrons" aria-hidden="true">»</span>,
            type: 'radio',
            checked: active === 'act',
            onSelect: () => onPick('act')
          },
          {
            label: uiText('auto.18054d9b20ab'),
            description: uiText('auto.4921b1d7618c'),
            icon: <Warning className="" />,
            type: 'radio',
            checked: active === 'danger',
            danger: true,
            onSelect: () => onPick('danger')
          }
        ], { anchor: e.currentTarget })}
      >
        {activeGlyph}
      </button>
    </div>
  )
}

/** The full agent chat — main workspace tab. */
export const Page: FC<MainWorkspaceViewProps> = ({ navigation }) => <ChatView navigation={navigation} />

export const SidebarPage: FC = () => <ChatView />

const ChatView: FC<{ navigation?: MainWorkspaceViewProps['navigation'] }> = ({ navigation }) => {
  const { store, snap } = useAssistant()
  React.useEffect(() => {
    if (!navigation) return
    navigation.setController({
      canGoBack: snap.canGoBack,
      canGoForward: snap.canGoForward,
      goBack: () => store.goBack(),
      goForward: () => store.goForward()
    })
    return () => navigation.setController(null)
  }, [navigation, snap.canGoBack, snap.canGoForward, store])
  // The host's styled dropdown — never a raw `<select>`, whose popup Chromium
  // hands to the OS unthemed and which ignores the native/custom menu setting.
  const { SelectField } = api.ui.settings
  const [draft, setDraft] = React.useState('')
  const scrollRef = React.useRef<HTMLDivElement | null>(null)
  const inputRef = React.useRef<HTMLTextAreaElement | null>(null)
  // Composer behaviour lives in Settings → Assistant → Chat.
  const sendOnEnter = usePluginSetting('sendOnEnter', true)
  const showTimestamps = usePluginSetting('showTimestamps', true)
  const attachFolder = usePluginSetting('attachmentFolder', DEFAULT_ATTACH_INBOX)

  const messages = React.useMemo(() => snap.active?.messages ?? [], [snap.active?.messages])
  const renderItems = React.useMemo(() => buildRenderItems(messages), [messages])
  const turnCopy = React.useMemo(() => turnEndCopyText(renderItems), [renderItems])
  const source = snap.active?.source
  const readOnly = Boolean(source)
  const RemoteIcon = source === 'whatsapp' ? WhatsApp : Telegram
  const remoteLabel = source === 'whatsapp' ? 'WhatsApp' : uiText('auto.edbea9ff1a78')
  const remoteIconClass = source === 'whatsapp' ? 'assistant-wa-ico' : 'assistant-tg-ico'

  // Tick once a second while a bypass is active so the countdown stays live (the
  // snapshot itself doesn't change every second).
  const [now, setNow] = React.useState(() => Date.now())
  const danger = dangerousActive(snap.dangerous, now)
  React.useEffect(() => {
    if (!snap.dangerous?.enabled) return
    const t = setInterval(() => setNow(Date.now()), 1000)
    return () => clearInterval(t)
  }, [snap.dangerous?.enabled])
  const fitInput = React.useCallback((el = inputRef.current): void => {
    if (!el) return
    el.style.height = 'auto'
    el.style.height = `${Math.min(el.scrollHeight, 220)}px`
  }, [])

  React.useLayoutEffect(() => {
    fitInput()
  }, [draft, fitInput])

  React.useEffect(() => {
    const el = scrollRef.current
    if (el) el.scrollTop = el.scrollHeight
  }, [messages.length, snap.streamingText, snap.pending])

  const [attachments, setAttachments] = React.useState<InboundAttachment[]>([])
  const [dropping, setDropping] = React.useState(false)
  const [attaching, setAttaching] = React.useState(false)
  const fileInputRef = React.useRef<HTMLInputElement | null>(null)

  const addFiles = React.useCallback(async (files: FileList | File[]): Promise<void> => {
    const list = Array.from(files)
    if (!list.length) return
    setAttaching(true)
    try {
      for (const file of list) {
        const kind = attachmentKind(file)
        if (!kind) continue // skip unsupported (video)
        const base64 = await fileToBase64(file)
        const safe = file.name.replace(/[^A-Za-z0-9._-]+/g, '_').replace(/^\.+/, '_') || 'file'
        const folder = attachFolder.replace(/\/+$/, '') || DEFAULT_ATTACH_INBOX
        const path = `${folder}/${Date.now()}-${safe}`
        const res = await api.drivers.files.writeBinary(path, base64)
        if (res.ok) setAttachments((a) => [...a, { kind, path, fileName: file.name, mime: file.type || undefined }])
      }
    } finally {
      setAttaching(false)
    }
  }, [attachFolder])

  const submit = (): void => {
    const text = draft.trim()
    if ((!text && attachments.length === 0) || snap.activeBusy || attaching) return
    const atts = attachments
    setDraft('')
    setAttachments([])
    void store.send(text, atts.length ? atts : undefined)
  }

  /** Speak into a mirrored Telegram/WhatsApp conversation as the bot (no model call). */
  const submitAsChannel = (): void => {
    const text = draft.trim()
    // A turn already running in this chat owns the thread; the store would drop
    // the message, so keep the draft rather than clearing it into nothing.
    if (!text || snap.activeBusy) return
    setDraft('')
    void store.sendAsChannel(text)
  }

  /** Enter sends unless the user set the composer to ⌘/Ctrl+Enter. */
  const composerKeyDown = (e: React.KeyboardEvent, send: () => void): void => {
    if (e.key !== 'Enter') return
    const wantsSend = sendOnEnter ? !e.shiftKey && !api.ui.hasModKey(e) : api.ui.hasModKey(e)
    if (!wantsSend) return
    e.preventDefault()
    send()
  }

  const overrideValue = snap.active?.model ? `${snap.active.model.provider}::${snap.active.model.model}` : 'auto'
  const providers = snap.config?.providers ?? []
  // A chat can be pinned to a model the provider no longer lists (retired id, an
  // Ollama model since removed). Show it rather than letting the select fall back
  // to "Auto" and misreport what the chat will run.
  const unlistedOverride =
    snap.active?.model && !providers.some((p) => p.provider === snap.active?.model?.provider && p.models.some((m) => m.id === snap.active?.model?.model))
      ? snap.active.model
      : null

  // Permission control (Claude-style): a live bypass ⇒ "danger"; an auto-approved
  // write default (allow) ⇒ "act"; otherwise "ask".
  const writeDecision = snap.config?.guard.defaultWrite.decision
  const permActive: PermMode = danger ? 'danger' : writeDecision === 'allow' ? 'act' : 'ask'
  const onPickMode = (mode: PermMode): void => {
    if (mode === 'danger') {
      void store.enableDangerousMode('session', snap.config?.guard.dangerousMode.maxTtlMinutes ?? 60)
      return
    }
    void store.setDefaultWrite(mode === 'act' ? 'allow' : 'confirm')
    void store.disableDangerousMode()
  }

  return (
    <div className="assistant-page">
      <div className="assistant-page-head">
        <div className="assistant-page-title-wrap">
          <div className="assistant-page-title">
            {readOnly && <RemoteIcon className={`assistant-ico ${remoteIconClass}`} />}
            {snap.active?.title ?? uiText('auto.8010d1f4d069')}
          </div>
          {readOnly && <div className="assistant-page-subtitle">{remoteLabel} {uiText('auto.ffff80d25a26')}</div>}
        </div>
        {danger && (
          <button
            className="assistant-danger-chip"
            title={uiText('auto.c8726270369b')}
            onClick={() => void store.disableDangerousMode()}
          >
            {uiText('auto.1977b0ec7885')}{' '}{countdown(snap.dangerous?.expiresAt ?? null, now)}
          </button>
        )}
        {snap.streaming && <span className="assistant-live-pill">{snap.phase === 'working' ? uiText('auto.3b4dfc971393') : uiText('auto.d08d8da0b3e1')}</span>}
      </div>

      <div className="assistant-messages" ref={scrollRef}>
        {messages.length === 0 && !snap.streaming && !readOnly && (
          <div className="assistant-welcome">
            <p>{uiText('auto.4925e26326de')}{' '}<em>{uiText('auto.76f3b5a7170a')}</em> {uiText('auto.91bb4a2dd748')}</p>
            <p>{uiText('auto.8436eeee3f2d')}</p>
          </div>
        )}
        {renderItems.map((item, i) =>
          item.kind === 'message' ? (
            <MessageRow
              key={i}
              message={item.message}
              showMeta={turnCopy[i] != null || item.message.role === 'user'}
              copyText={turnCopy[i]}
              showTime={showTimestamps}
            />
          ) : (
            <ActivityBlock key={i} entries={item.entries} />
          )
        )}
        {snap.streaming && snap.streamingText && (
          <div className="assistant-msg theirs">
            <div className="assistant-bubble assistant-streaming">
              {snap.streamingText}
              <span className="assistant-stream-caret" aria-hidden="true" />
            </div>
          </div>
        )}
        {snap.streaming && !snap.streamingText && !snap.pending && <ThinkingIndicator phase={snap.phase} />}

        {snap.pending && (
          <ApprovalCard request={snap.pending} onRespond={(a) => store.respond(snap.pending!.requestId, a)} />
        )}

        {snap.active?.quiz && (
          <div className="assistant-quiz-choices">
            {snap.active.quiz.choices.map((c) => (
              <button
                key={c.value}
                className="assistant-btn assistant-btn-ghost"
                disabled={snap.activeBusy}
                onClick={() => void store.answerQuiz(c.value)}
              >
                {c.label}
              </button>
            ))}
          </div>
        )}
      </div>

      {readOnly ? (
        // A mirrored remote conversation: what you type is delivered over the
        // channel as the bot itself — no model call, no tools, no approvals.
        <div className="assistant-composer assistant-composer-channel">
          <div className="assistant-channel-banner">
            <RemoteIcon className={remoteIconClass} />
            <span>
              {remoteLabel} · {snap.active?.channelName ?? remoteLabel} {uiText('auto.d87dda032189')}</span>
          </div>
          <textarea
            className="assistant-composer-input"
            placeholder={uiText('auto.ca438ab19dde', { p0: remoteLabel })}
            aria-label={uiText('auto.4acf92d96289', { p0: remoteLabel })}
            rows={1}
            value={draft}
            disabled={snap.activeBusy}
            onChange={(e) => {
              setDraft(e.target.value)
              fitInput(e.currentTarget)
            }}
            onKeyDown={(e) => composerKeyDown(e, submitAsChannel)}
          />
          <div className="assistant-composer-toolbar">
            <div className="assistant-composer-left" />
            <button
              className="assistant-send-round"
              title={uiText('auto.dfb39fbb41ff', { p0: remoteLabel })}
              aria-label={uiText('auto.dfb39fbb41ff', { p0: remoteLabel })}
              onClick={submitAsChannel}
              disabled={!draft.trim() || snap.activeBusy}
            >
              <Send className="" />
            </button>
          </div>
        </div>
      ) : (
        <div
          className={`assistant-composer${snap.streaming ? ' is-streaming' : ''}${danger ? ' is-dangerous' : ''}${dropping ? ' is-drop' : ''}`}
          onDragOver={(e) => {
            e.preventDefault()
            setDropping(true)
          }}
          onDragLeave={() => setDropping(false)}
          onDrop={(e) => {
            e.preventDefault()
            setDropping(false)
            if (e.dataTransfer?.files?.length) void addFiles(e.dataTransfer.files)
          }}
        >
          {attachments.length > 0 && (
            <div className="assistant-attach-chips">
              {attachments.map((a, i) => (
                <span className="assistant-attach-chip" key={a.path}>
                  {a.fileName} ({a.kind})
                  <button title={uiText('auto.e963907dac5c')} onClick={() => setAttachments((list) => list.filter((_, j) => j !== i))}>
                    <X className="" />
                  </button>
                </span>
              ))}
            </div>
          )}
          {danger && (
            <div className="assistant-danger-warning" role="status">
              {uiText('auto.7cffa1950772')}{' '}{countdown(snap.dangerous?.expiresAt ?? null, now)} {uiText('auto.c04fece4c361')}{' '}<button className="assistant-danger-off" onClick={() => void store.disableDangerousMode()}>
                {uiText('auto.8807c2b3fd0f')}</button>
            </div>
          )}
          <textarea
            ref={inputRef}
            className="assistant-composer-input"
            placeholder={snap.activeBusy ? uiText('auto.13b7bfcac438') : uiText('auto.24bf2a34e6f4')}
            rows={1}
            value={draft}
            disabled={snap.activeBusy}
            onChange={(e) => {
              setDraft(e.target.value)
              fitInput(e.currentTarget)
            }}
            onKeyDown={(e) => composerKeyDown(e, submit)}
          />
          <div className="assistant-composer-toolbar">
            <div className="assistant-composer-left">
              <button
                className="assistant-attach-btn"
                title={uiText('auto.2d6c04901b6c')}
                aria-label={uiText('auto.ae85e4ee1e6c')}
                disabled={snap.activeBusy || attaching}
                onClick={() => fileInputRef.current?.click()}
              >
                <Folder className="" />
              </button>
              <PermissionControl active={permActive} disabled={snap.activeBusy} onPick={onPickMode} />
              <input
                ref={fileInputRef}
                type="file"
                multiple
                accept="image/*,application/pdf,audio/*"
                style={{ display: 'none' }}
                onChange={(e) => {
                  if (e.target.files?.length) void addFiles(e.target.files)
                  e.target.value = ''
                }}
              />
            </div>
            <div className="assistant-composer-right">
              <div className="assistant-model-wrap">
                <SelectField
                  className="assistant-model-select"
                  value={overrideValue}
                  ariaLabel={uiText('auto.c614ba7c453c')}
                  onChange={(v) => {
                    if (v === 'auto') store.setModelOverride(null)
                    else {
                      const [provider, model] = v.split('::')
                      store.setModelOverride({ provider: provider as AiProviderId, model })
                    }
                  }}
                  options={[
                    { value: 'auto', label: uiText('auto.c614ba7c453c') },
                    ...(unlistedOverride
                      ? [{
                          value: `${unlistedOverride.provider}::${unlistedOverride.model}`,
                          label: `${unlistedOverride.provider} · ${unlistedOverride.model}`
                        }]
                      : []),
                    // The shared field has no option groups, so each row carries
                    // its provider inline — the same `provider · model` shape the
                    // unlisted-override row and the route caption already use.
                    ...providers.flatMap((p) =>
                      p.models.map((m) => ({
                        value: `${p.provider}::${m.id}`,
                        label: `${p.provider} · ${m.label ?? m.id}`
                      }))
                    )
                  ]}
                />
              </div>
              {overrideValue === 'auto' && snap.lastModel && (
                <span className="assistant-route-caption" title={snap.lastModel.reason}>
                  → {snap.lastModel.provider} · {snap.lastModel.model}
                </span>
              )}
            </div>
            {snap.streaming ? (
              <button className="assistant-send-round assistant-send-stop" title={uiText('auto.9e253470c876')} aria-label={uiText('auto.9e253470c876')} onClick={() => store.stop()}>
                <Stop className="" />
              </button>
            ) : (
              <button
                className="assistant-send-round"
                title={uiText('auto.9bc2575c3930')}
                aria-label={uiText('auto.9bc2575c3930')}
                onClick={submit}
                disabled={(!draft.trim() && attachments.length === 0) || snap.activeBusy || attaching}
              >
                <Send className="" />
              </button>
            )}
          </div>
        </div>
      )}
    </div>
  )
}
