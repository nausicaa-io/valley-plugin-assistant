import { AiProvidersSection } from './ProvidersSettings'
import { UsageBillingSection } from './UsageSettings'
import { AiHarnessesSection } from './HarnessSettings'
import { React, api } from './runtime'
import type { FC, ReactNode } from 'react'
import type { AiChatSummary, AiChatThread, AiConnectionStatus, AiPersonality, ChannelInfo, CustomCommand, RoutingConfig } from './types'
import { useAssistant, usePluginSetting } from './hooks'
import { BUILTIN_COMMANDS } from './channelCommands'
import { flattenModels, modelValue, parseModelValue, type ModelRef } from './models'
import { Chat, ChevronLeft, ChevronRight, Telegram, WhatsApp } from './icons'
import { DEFAULT_ATTACH_INBOX } from './Page'
import { uiText } from './localization'
import { changeConversation, updateConversation } from './commands'

type Section = 'settings' | 'chat' | 'telegram' | 'whatsapp'

const WHATSAPP_GRAPH_VERSION = 'v25.0'
const WHATSAPP_WEBHOOK_PORT = 8787

const SettingsRow: typeof api.ui.settings.Row = (props) => React.createElement(api.ui.settings.Row, props)
const Button: typeof api.ui.settings.Button = (props) => React.createElement(api.ui.settings.Button, props)
const IconButton: typeof api.ui.settings.IconButton = (props) => React.createElement(api.ui.settings.IconButton, props)
const NumberField: typeof api.ui.settings.NumberField = (props) => React.createElement(api.ui.settings.NumberField, props)
const ReadOnlyValue: typeof api.ui.settings.ReadOnlyValue = (props) => React.createElement(api.ui.settings.ReadOnlyValue, props)
const TextField: typeof api.ui.settings.TextField = (props) => React.createElement(api.ui.settings.TextField, props)
const Toggle: typeof api.ui.settings.Toggle = (props) => React.createElement(api.ui.settings.Toggle, props)
const VaultFolderField: typeof api.ui.settings.VaultFolderField = (props) =>
  React.createElement(api.ui.settings.VaultFolderField, props)

/** The right-hand half of a kit Row: the field, plus any button that belongs to it. */
const RowControl: FC<{ children: ReactNode }> = ({ children }) => <div className="settings-row-control">{children}</div>

// ── The shared list-page chrome (same classes as AI Providers / Accounts) ──────

/** A list page: a 34px header band with an optional `+`, then full-bleed rows. */
const ListPage: FC<{ title: string; addLabel?: string; onAdd?: () => void; children: ReactNode }> = ({
  title,
  addLabel,
  onAdd,
  children
}) => (
  <section className="settings-section settings-listpage">
    <div className="settings-listpage-header">
      <h4 className="settings-label">{title}</h4>
      {onAdd && addLabel && (
        <Button className="settings-listpage-add" size="small" aria-label={addLabel} title={addLabel} onClick={onAdd}>
          +
        </Button>
      )}
    </div>
    <div className="settings-list">{children}</div>
  </section>
)

/** One full-bleed row: glyph, name + sub-line, optional badge, chevron. */
const ListRow: FC<{ glyph: ReactNode; name: string; sub: ReactNode; badge?: ReactNode; onOpen: () => void }> = ({
  glyph,
  name,
  sub,
  badge,
  onOpen
}) => (
  <div
    className="settings-list-row"
    role="button"
    tabIndex={0}
    onClick={onOpen}
    onKeyDown={(e) => {
      if (e.key === 'Enter' || e.key === ' ') {
        e.preventDefault()
        onOpen()
      }
    }}
  >
    <span className="settings-list-glyph">{glyph}</span>
    <span className="settings-list-meta">
      <span className="settings-list-name">{name}</span>
      <span className="settings-list-sub">{sub}</span>
    </span>
    {badge}
    <ChevronRight className="settings-list-chevron" />
  </div>
)

/** A detail page's own band: a chevron back to the list, then this page's name. */
const CrumbBand: FC<{ backTo: string; current: string; onBack: () => void }> = ({ backTo, current, onBack }) => (
  <div className="settings-listpage-crumbs">
    <button type="button" className="settings-listpage-back" aria-label={uiText('auto.b70b6ab0baad', { p0: backTo })} title={uiText('auto.b70b6ab0baad', { p0: backTo })} onClick={onBack}>
      <ChevronLeft className="" />
    </button>
    <span className="settings-crumb settings-crumb-current">{current}</span>
  </div>
)

// ── Model / router helpers ────────────────────────────────────────────────────

/** A model picker (Auto + every configured provider:model). */
const ModelSelect: FC<{ value?: ModelRef | null; connections: AiConnectionStatus[]; onChange: (m: ModelRef | null) => void }> = ({
  value,
  connections,
  onChange
}) => {
  // The host's styled dropdown — never a raw `<select>`, whose popup Chromium
  // hands to the OS unthemed and which ignores the native/custom menu setting.
  const { SelectField } = api.ui.settings
  return (
    <SelectField
      value={modelValue(value)}
      onChange={(v) => onChange(parseModelValue(v, connections))}
      ariaLabel={uiText('auto.c6b95ed103e0')}
      options={[
        { value: '', label: uiText('auto.c6b95ed103e0') },
        ...flattenModels(connections).map((o) => ({ value: o.value, label: o.label }))
      ]}
    />
  )
}

/**
 * Pick how inbound attachments (images/PDFs) are read: markitdown (text extraction)
 * or a vision model. `value`/`onChange` use `''` for "inherit" (default/connection),
 * `'markitdown'`, or a `provider:model` id. `includeInherit` adds the inherit option
 * for the per-connection/per-chat scopes (the global default has no inherit).
 */
const AttachmentParserSelect: FC<{
  value: string
  connections: AiConnectionStatus[]
  includeInherit?: boolean
  onChange: (v: string) => void
}> = ({ value, connections, includeInherit, onChange }) => {
  const visionModels = flattenModels(connections.filter((connection) =>
    connection.providerCapabilities.includes('vision-image') || connection.providerCapabilities.includes('vision-pdf')
  ))
  const { SelectField } = api.ui.settings
  return (
    <SelectField
      value={value}
      onChange={onChange}
      ariaLabel={uiText('auto.815665832408')}
      options={[
        ...(includeInherit ? [{ value: '', label: uiText('auto.a4a1f1fdd70e') }] : []),
        { value: 'markitdown', label: uiText('auto.815665832408') },
        ...visionModels.map((o) => ({ value: o.value, label: uiText('auto.d54d7a7dae11', { p0: o.label }) }))
      ]}
    />
  )
}

// ── Custom-command editor (reusable across the three scopes) ───────────────────

const slugify = (s: string): string => s.toLowerCase().replace(/^\/+/, '').replace(/[^a-z0-9_-]+/g, '-').replace(/^-+|-+$/g, '')

const CommandEditor: FC<{ commands: CustomCommand[]; onSave: (commands: CustomCommand[]) => Promise<void>; emptyHint?: string }> = ({
  commands,
  onSave,
  emptyHint
}) => {
  const [draft, setDraft] = React.useState<CustomCommand[]>(() => commands.map((c) => ({ ...c })))
  const [note, setNote] = React.useState('')
  const flash = (m: string): void => {
    setNote(m)
    window.setTimeout(() => setNote(''), 2000)
  }
  const patch = (i: number, next: Partial<CustomCommand>): void => setDraft((d) => d.map((c, j) => (j === i ? { ...c, ...next } : c)))
  const remove = (i: number): void => setDraft((d) => d.filter((_, j) => j !== i))
  const add = (): void => setDraft((d) => [...d, { name: '', prompt: '' }])

  const conflicts = draft.some((c) => BUILTIN_COMMANDS.includes(c.name))
  const save = async (): Promise<void> => {
    const clean = draft
      .map((c) => ({ ...c, name: slugify(c.name) }))
      .filter((c) => c.name && c.prompt.trim() && !BUILTIN_COMMANDS.includes(c.name))
    await onSave(clean)
    setDraft(clean.map((c) => ({ ...c })))
    flash('Saved.')
  }

  return (
    <div className="assistant-cmd-editor">
      {draft.length === 0 && <p className="assistant-empty">{emptyHint ?? uiText('auto.a4efb6b9f3b0')}</p>}
      {draft.map((c, i) => (
        <div className="assistant-cmd-row" key={i}>
          <div className="assistant-cmd-head">
            <span className="assistant-cmd-slash">/</span>
            <TextField
              className="assistant-input assistant-cmd-name"
              value={c.name}
              onChange={(name) => patch(i, { name })}
              placeholder={uiText('auto.6ae999552a0d')}
              ariaLabel={uiText('auto.999fc746249a')}
            />
            <TextField
              className="assistant-input assistant-cmd-desc"
              value={c.description ?? ''}
              onChange={(description) => patch(i, { description })}
              placeholder={uiText('auto.b3fac8331db0')}
              ariaLabel={uiText('auto.c885bcd19fa6')}
            />
            <IconButton className="assistant-btn assistant-btn-ghost assistant-btn-sm" size="small" onClick={() => remove(i)} ariaLabel={uiText('auto.6d91fca9bd39')}>
              ✕
            </IconButton>
          </div>
          <textarea
            className="assistant-textarea"
            rows={2}
            value={c.prompt}
            onChange={(e) => patch(i, { prompt: e.target.value })}
            placeholder={uiText('auto.c60568344332')}
            aria-label={uiText('auto.d617ae525a06')}
          />
          {BUILTIN_COMMANDS.includes(slugify(c.name)) && (
            <span className="assistant-set-status assistant-set-err">/{slugify(c.name)} {uiText('auto.ec7926ad8580')}</span>
          )}
        </div>
      ))}
      <div className="assistant-cmd-actions">
        <Button className="assistant-btn assistant-btn-ghost assistant-btn-sm" variant="ghost" size="small" onClick={add}>
          {uiText('auto.3433cdd70663')}</Button>
        <Button className="assistant-btn assistant-btn-sm" variant="primary" size="small" onClick={save} disabled={conflicts}>
          {uiText('auto.501e8582e34a')}</Button>
        {note && <span className="assistant-set-status ok">{note}</span>}
      </div>
    </div>
  )
}

const BUILTIN_INFO: { name: string; desc: string; instant?: boolean }[] = [
  { name: 'clear', desc: "Forget this chat's earlier messages (keeps saved memory).", instant: true },
  { name: 'model', desc: 'Show or change the AI model for this chat.', instant: true },
  { name: 'profile', desc: "Show or change this chat's personality." },
  { name: 'guard', desc: 'Show the permission policy for this chat.' },
  { name: 'help', desc: 'List the available commands.' }
]

/**
 * The built-in slash commands plus the *overall* custom commands. This scope is
 * genuinely global: `store.runInAppCommand` reads the same list the channel turns
 * do, so a command defined here works in-app and over every connection.
 */
const CommandsCard: FC<{ scopeNote: string }> = ({ scopeNote }) => {
  const [overall, setOverall] = React.useState<CustomCommand[] | null>(null)
  React.useEffect(() => {
    void api.assistant.listCommands().then((res) => setOverall(res.data?.commands ?? []))
  }, [])
  return (
    <div className="assistant-provider">
      <div className="assistant-provider-head">
        <span className="assistant-provider-title">
          <span className="assistant-provider-name">{uiText('auto.fc2aa6a195a7')}</span>
        </span>
        <span className="assistant-badge">{uiText('auto.18946bbfe54c')}</span>
      </div>
      <p className="assistant-sub">
        {uiText('auto.6ace8ca7e342')}<code>/clear</code> {uiText('auto.cffa50a32cb1')}<code>/model</code> {uiText('auto.df6ad19037c9')}{' '}
        <strong>{uiText('auto.f9da5e459359')}</strong> {uiText('auto.3562a048ee80')}</p>
      <div className="assistant-builtins">
        {BUILTIN_INFO.map((b) => (
          <div className="assistant-builtin-row" key={b.name}>
            <code className="assistant-cmd-tag">/{b.name}</code>
            <span className="assistant-builtin-desc">{b.desc}</span>
            {b.instant && <span className="assistant-badge ok">{uiText('auto.a86195669ed7')}</span>}
          </div>
        ))}
      </div>
      <SettingsRow title={uiText('auto.dcde3d69862b')} description={scopeNote}>
        <span />
      </SettingsRow>
      {overall === null ? (
        <p className="assistant-empty">{uiText('auto.33ce417454bf')}</p>
      ) : (
        <CommandEditor
          commands={overall}
          onSave={(commands) => api.assistant.saveCommands(commands).then(() => undefined)}
          emptyHint="No overall custom commands yet."
        />
      )}
    </div>
  )
}

// ── A file-path field (relative path + Open button) ────────────────────────────

const FilePathField: FC<{ path?: string }> = ({ path }) => {
  if (!path) return <span className="assistant-set-status">—</span>
  return (
    <>
      <code className="assistant-path">{path}</code>
      <Button className="assistant-btn assistant-btn-ghost assistant-btn-sm" variant="ghost" size="small" onClick={() => api.workspace.openFile(path)}>
        {uiText('auto.cf9b77061f7b')}</Button>
    </>
  )
}

// ── Settings sub-section: which remote channels the sidebar shows ─────────────

const SettingsPane: FC = () => {
  const showTelegram = usePluginSetting('showTelegram', true)
  const showWhatsApp = usePluginSetting('showWhatsApp', true)

  return (
    <>
      <h4 className="settings-label">{uiText('auto.fff9cd7fa74f')}</h4>
      <SettingsRow title={uiText('auto.edbea9ff1a78')} description={uiText('auto.5994dbc995fe')}>
        <RowControl>
          <Toggle checked={showTelegram} onChange={(v) => void api.settings.set('showTelegram', v)} label={uiText('auto.edbea9ff1a78')} />
        </RowControl>
      </SettingsRow>
      <SettingsRow title="WhatsApp" description={uiText('auto.bcbd3ccca966')}>
        <RowControl>
          <Toggle checked={showWhatsApp} onChange={(v) => void api.settings.set('showWhatsApp', v)} label="WhatsApp" />
        </RowControl>
      </SettingsRow>
    </>
  )
}

// ── Chat sub-section ──────────────────────────────────────────────────────────

/** The defaults every new in-app chat starts from, plus composer behaviour. */
const ChatDefaults: FC<{ personalities: AiPersonality[]; connections: AiConnectionStatus[] }> = ({ personalities, connections }) => {
  const { SelectField } = api.ui.settings
  const defaultProfileId = usePluginSetting('defaultProfileId', '')
  const defaultModel = usePluginSetting('defaultModel', '')
  const parser = usePluginSetting('attachmentParser', 'markitdown')
  const sendOnEnter = usePluginSetting('sendOnEnter', true)
  const showTimestamps = usePluginSetting('showTimestamps', true)
  const attachmentFolder = usePluginSetting('attachmentFolder', DEFAULT_ATTACH_INBOX)

  return (
    <>
      <h4 className="settings-label">{uiText('auto.8a86943c2e2b')}</h4>
      <SettingsRow title={uiText('auto.2981a383917f')} description={uiText('auto.57f417ba8dae')}>
        <RowControl>
          <SelectField
            value={defaultProfileId}
            onChange={(v) => void api.settings.set('defaultProfileId', v)}
            ariaLabel={uiText('auto.2981a383917f')}
            options={[
              { value: '', label: uiText('auto.808d7dca8a74') },
              ...personalities.filter((p) => !p.isDefault).map((p) => ({ value: p.id, label: p.name }))
            ]}
          />
        </RowControl>
      </SettingsRow>
      <SettingsRow title={uiText('auto.6dcf16e1c5d3')} description={uiText('auto.4cbb84ea2e24')}>
        <RowControl>
          <ModelSelect
            value={parseModelValue(defaultModel, connections)}
            connections={connections}
            onChange={(m) => void api.settings.set('defaultModel', modelValue(m))}
          />
        </RowControl>
      </SettingsRow>
      <SettingsRow title={uiText('auto.909447ccca66')} description={uiText('auto.94677ff82158')}>
        <RowControl>
          <AttachmentParserSelect value={parser} connections={connections} onChange={(v) => void api.settings.set('attachmentParser', v)} />
        </RowControl>
      </SettingsRow>

      <h4 className="settings-label">{uiText('auto.10c35d71ded7')}</h4>
      <SettingsRow title={uiText('auto.6538cb9c31dc')} description={uiText('auto.c849e526f30f')}>
        <RowControl>
          <Toggle checked={sendOnEnter} onChange={(v) => void api.settings.set('sendOnEnter', v)} label={uiText('auto.6538cb9c31dc')} />
        </RowControl>
      </SettingsRow>
      <SettingsRow title={uiText('auto.88220a9dabbe')} description={uiText('auto.d8f1d5da9ea4')}>
        <RowControl>
          <Toggle checked={showTimestamps} onChange={(v) => void api.settings.set('showTimestamps', v)} label={uiText('auto.88220a9dabbe')} />
        </RowControl>
      </SettingsRow>
      <SettingsRow title={uiText('auto.b31da2770f6e')} description={uiText('auto.c4eea020917e')}>
        <RowControl>
          <VaultFolderField
            value={attachmentFolder}
            onChange={() => undefined}
            onCommit={(v) => void api.settings.set('attachmentFolder', v.trim() || DEFAULT_ATTACH_INBOX)}
            placeholder={DEFAULT_ATTACH_INBOX}
            ariaLabel={uiText('auto.b31da2770f6e')}
          />
        </RowControl>
      </SettingsRow>
    </>
  )
}

/** One conversation's own settings: personality, model, parser, chat-scoped commands. */
export const ChatDetail: FC<{
  summary: AiChatSummary
  personalities: AiPersonality[]
  connections: AiConnectionStatus[]
  backTo: string
  onBack: () => void
  onChanged: () => Promise<void>
  embedded?: boolean
}> = ({ summary, personalities, connections, backTo, onBack, onChanged, embedded }) => {
  const { SelectField } = api.ui.settings
  const [thread, setThread] = React.useState<AiChatThread | null>(null)
  const [confirmDel, setConfirmDel] = React.useState(false)
  const [error, setError] = React.useState('')

  React.useEffect(() => {
    let live = true
    void api.assistant.readChat(summary.id).then((res) => {
      if (!live) return
      if (res.ok && res.data?.thread) { setThread(res.data.thread); setError('') }
      else setError(uiText('assistant.surface.missing'))
    }).catch(() => { if (live) setError(uiText('assistant.surface.missing')) })
    return () => {
      live = false
    }
  }, [summary.id])

  // Patch the loaded thread + persist (saveChat appends only new messages, so this
  // is a settings-only write that preserves the conversation).
  const persist = async (patch: Partial<AiChatThread>): Promise<void> => {
    if (!thread) return
    try {
      const result = await updateConversation(api, summary.id, patch)
      setThread(result.value)
      setError('')
      await onChanged()
    } catch { setError(api.ui.t('error.commandFailed')) }
  }
  const remove = async (): Promise<void> => {
    try {
      await changeConversation(api, summary.id, 'delete-chat')
      onBack()
      await onChanged()
    } catch { setError(api.ui.t('error.commandFailed')) }
  }

  const profile = personalities.find((p) => p.id === (thread?.profileId ?? summary.profileId))
  return (
    <>
      {!embedded && <CrumbBand backTo={backTo} current={summary.title || 'Untitled'} onBack={onBack} />}
      {error && <p className="assistant-empty" role="alert">{error}</p>}
      {!thread && !error && <p className="assistant-empty">{uiText('auto.33ce417454bf')}</p>}
      {thread && (
        <>
          <SettingsRow title={uiText('assistant.surface.title')}><TextField value={thread.title} ariaLabel={uiText('assistant.surface.title')} onChange={(title) => setThread({ ...thread, title })} onCommit={(title) => void persist({ title })} /></SettingsRow>
          <SettingsRow title={uiText('assistant.surface.pinned')}><Toggle checked={thread.pinned === true} onChange={(pinned) => void persist({ pinned })} label={uiText('assistant.surface.pinned')} /></SettingsRow>
          <SettingsRow title={uiText('auto.ed58f29743f8')} description={uiText('auto.3e250bc5884e')}>
            <RowControl>
              <SelectField
                value={thread.profileId ?? ''}
                onChange={(value) => void persist({ profileId: value || undefined })}
                ariaLabel={uiText('auto.808d7dca8a74')}
                options={[
                  { value: '', label: uiText('auto.808d7dca8a74') },
                  ...personalities.filter((p) => !p.isDefault).map((p) => ({ value: p.id, label: p.name }))
                ]}
              />
            </RowControl>
          </SettingsRow>
          {profile?.instructionsPath && (
            <SettingsRow title="">
              <RowControl>
                <FilePathField path={profile.instructionsPath} />
              </RowControl>
            </SettingsRow>
          )}
          <SettingsRow title={uiText('auto.6dcf16e1c5d3')} description={uiText('auto.4f0414d88905')}>
            <RowControl>
              <ModelSelect value={thread.model} connections={connections} onChange={(m) => void persist({ model: m })} />
            </RowControl>
          </SettingsRow>
          <SettingsRow title={uiText('auto.909447ccca66')} description={uiText('auto.d53e5c797f3d')}>
            <RowControl>
              <AttachmentParserSelect
                value={thread.attachmentParser ?? ''}
                connections={connections}
                includeInherit
                onChange={(v) => void persist({ attachmentParser: v || undefined })}
              />
            </RowControl>
          </SettingsRow>
          <SettingsRow title={uiText('auto.633cad38d705')} description={uiText('auto.efe9cd7a946c')}>
            <span />
          </SettingsRow>
          <CommandEditor commands={thread.commands ?? []} onSave={(commands) => persist({ commands })} />
          <SettingsRow title="">
            <RowControl>
              {confirmDel ? (
                <>
                  <Button variant="danger" size="small" onClick={remove}>
                    {uiText('auto.c9f2829e382c')}</Button>
                  <Button variant="ghost" size="small" onClick={() => setConfirmDel(false)}>
                    {uiText('auto.77dfd2135f4d')}</Button>
                </>
              ) : (
                <Button variant="ghost" size="small" onClick={() => setConfirmDel(true)}>
                  {uiText('auto.db9121e79c1c')}</Button>
              )}
            </RowControl>
          </SettingsRow>
        </>
      )}
    </>
  )
}

/** The `model · personality · date` sub-line every conversation row carries. */
function chatSubLine(c: AiChatSummary): string {
  const parts = [c.model ? `${c.model.provider} · ${c.model.model}` : 'Auto']
  if (c.profileId && c.profileId !== 'default') parts.push(c.profileId)
  parts.push(new Date(c.updatedAt).toLocaleDateString(api.ui.language()))
  return parts.join(' · ')
}

const ChatPane: FC<{ personalities: AiPersonality[]; connections: AiConnectionStatus[] }> = ({ personalities, connections }) => {
  const [chats, setChats] = React.useState<AiChatSummary[]>([])
  const [selected, setSelected] = React.useState<string | null>(null)
  const refresh = React.useCallback(async () => {
    const res = await api.assistant.listChats()
    setChats((res.data?.chats ?? []).filter((c) => !c.source))
  }, [])
  React.useEffect(() => {
    void refresh()
  }, [refresh])

  const current = selected ? chats.find((c) => c.id === selected) ?? null : null
  if (current) {
    return (
      <ChatDetail
        summary={current}
        personalities={personalities}
        connections={connections}
        backTo="Chat"
        onBack={() => setSelected(null)}
        onChanged={refresh}
      />
    )
  }

  return (
    <>
      <ChatDefaults personalities={personalities} connections={connections} />
      <CommandsCard scopeNote="apply to every chat (overridable per connection / per chat)" />
      <ListPage title={uiText('auto.07c59b44128d')}>
        {chats.length === 0 && <p className="assistant-empty">{uiText('auto.265928933f22')}</p>}
        {chats.map((c) => (
          <ListRow
            key={c.id}
            glyph={<Chat className="" />}
            name={c.title || 'Untitled'}
            sub={chatSubLine(c)}
            onOpen={() => setSelected(c.id)}
          />
        ))}
      </ListPage>
    </>
  )
}

// ── Remote-channel sub-sections ────────────────────────────────────────────────

/** One connection's full detail (reached from the list; a back band returns). */
const ConnectionDetail: FC<{
  channel: ChannelInfo
  personalities: AiPersonality[]
  connections: AiConnectionStatus[]
  chats: AiChatSummary[]
  onBack: () => void
  onChanged: () => Promise<void>
  refreshChats: () => Promise<void>
}> = ({ channel, personalities, connections, chats, onBack, onChanged, refreshChats }) => {
  const isWhatsApp = channel.type === 'whatsapp'
  const channelTitle = isWhatsApp ? 'WhatsApp' : uiText('auto.edbea9ff1a78')
  const remoteSource = isWhatsApp ? 'whatsapp' : 'telegram'
  const [token, setToken] = React.useState('')
  const [verifyToken, setVerifyToken] = React.useState('')
  const [appSecret, setAppSecret] = React.useState('')
  const [allow, setAllow] = React.useState((channel.allowFrom ?? []).join(', '))
  const [name, setName] = React.useState(channel.name)
  const [instr, setInstr] = React.useState(channel.instructionsPath ?? '')
  const [phoneNumberId, setPhoneNumberId] = React.useState(channel.phoneNumberId ?? '')
  const [graphVersion, setGraphVersion] = React.useState(channel.graphVersion ?? WHATSAPP_GRAPH_VERSION)
  const [webhookPort, setWebhookPort] = React.useState<number | null>(channel.webhookPort ?? WHATSAPP_WEBHOOK_PORT)
  const [publicCallbackUrl, setPublicCallbackUrl] = React.useState(channel.publicCallbackUrl ?? '')
  const [confirmDel, setConfirmDel] = React.useState(false)
  const [openChat, setOpenChat] = React.useState<string | null>(null)

  React.useEffect(() => setName(channel.name), [channel.name])
  React.useEffect(() => setInstr(channel.instructionsPath ?? ''), [channel.instructionsPath])
  React.useEffect(() => setPhoneNumberId(channel.phoneNumberId ?? ''), [channel.phoneNumberId])
  React.useEffect(() => setGraphVersion(channel.graphVersion ?? WHATSAPP_GRAPH_VERSION), [channel.graphVersion])
  React.useEffect(() => setWebhookPort(channel.webhookPort ?? WHATSAPP_WEBHOOK_PORT), [channel.webhookPort])
  React.useEffect(() => setPublicCallbackUrl(channel.publicCallbackUrl ?? ''), [channel.publicCallbackUrl])

  const saveToken = async (): Promise<void> => {
    const next = token.trim()
    if (!next) return
    await api.channels.setSecret(channel.id, next)
    setToken('')
    await onChanged()
  }
  const saveSecretField = async (key: 'verifyToken' | 'appSecret', secret: string, setter: (v: string) => void): Promise<void> => {
    const next = secret.trim()
    if (!next) return
    await api.channels.setSecretField(channel.id, key, next)
    setter('')
    await onChanged()
  }
  const saveAllow = async (): Promise<void> => {
    await api.channels.setConfig(channel.id, { allowFrom: allow.split(',').map((s) => s.trim()).filter(Boolean) })
    await onChanged()
  }
  const savePhoneNumberId = async (): Promise<void> => {
    const next = phoneNumberId.trim()
    if (next === (channel.phoneNumberId ?? '')) return
    await api.channels.setConfig(channel.id, { phoneNumberId: next || null })
    await onChanged()
  }
  const saveGraphVersion = async (): Promise<void> => {
    const next = graphVersion.trim() || WHATSAPP_GRAPH_VERSION
    if (next === (channel.graphVersion ?? WHATSAPP_GRAPH_VERSION)) return
    await api.channels.setConfig(channel.id, { graphVersion: next })
    await onChanged()
  }
  const saveWebhookPort = async (port: number | null): Promise<void> => {
    if (port == null || port === (channel.webhookPort ?? WHATSAPP_WEBHOOK_PORT)) return
    await api.channels.setConfig(channel.id, { webhookPort: port })
    await onChanged()
  }
  const savePublicCallbackUrl = async (): Promise<void> => {
    const next = publicCallbackUrl.trim()
    if (next === (channel.publicCallbackUrl ?? '')) return
    await api.channels.setConfig(channel.id, { publicCallbackUrl: next || null })
    await onChanged()
  }
  const saveInstructions = async (): Promise<void> => {
    const next = instr.trim()
    if (next === (channel.instructionsPath ?? '')) return
    await api.channels.setConfig(channel.id, { instructionsPath: next || null })
    await onChanged()
  }
  const saveRouter = async (m: ModelRef | null): Promise<void> => {
    const routing: RoutingConfig | null = m ? { auto: false, default: m, rules: [] } : null
    await api.channels.setConfig(channel.id, { defaultRouting: routing })
    await onChanged()
  }
  const saveParser = async (v: string): Promise<void> => {
    await api.channels.setConfig(channel.id, { attachmentParser: v || null })
    await onChanged()
  }
  const saveName = async (): Promise<void> => {
    const next = name.trim()
    if (!next || next === channel.name) return
    await api.channels.rename(channel.id, next)
    await onChanged()
  }
  const toggle = async (): Promise<void> => {
    if (channel.running) await api.channels.stop(channel.id)
    else await api.channels.start(channel.id)
    await onChanged()
  }
  const remove = async (): Promise<void> => {
    await api.channels.remove(channel.id)
    onBack()
    await onChanged()
  }

  const myChats = chats.filter((c) => c.source === remoteSource && c.channelId === channel.id)
  const current = openChat ? myChats.find((c) => c.id === openChat) ?? null : null
  if (current) {
    return (
      <ChatDetail
        summary={current}
        personalities={personalities}
        connections={connections}
        backTo={channel.displayName}
        onBack={() => setOpenChat(null)}
        onChanged={refreshChats}
      />
    )
  }

  const dot = channel.running ? 'ok' : channel.configured ? 'warn' : 'off'
  return (
    <>
      <CrumbBand backTo={channelTitle} current={channel.displayName} onBack={onBack} />

      <div className="assistant-detail-identity">
        <span className="settings-list-glyph settings-list-glyph--lg">
          {isWhatsApp ? <WhatsApp className="assistant-wa-ico" /> : <Telegram className="assistant-tg-ico" />}
        </span>
        <span className="settings-list-meta">
          <span className="settings-list-name">{channel.displayName}</span>
          <span className="settings-list-sub">
            <span className={`assistant-dot ${dot}`} />{' '}
            {channel.running ? uiText('auto.73989d9c5926') : channel.configured ? uiText('auto.668c5fffd24d') : uiText('auto.67f2141f8c48')}
          </span>
        </span>
      </div>

      <SettingsRow title={uiText('auto.709a23220f2c')} description={uiText('auto.6dca055ffb8c')}>
        <RowControl>
          <TextField value={name} onChange={setName} onCommit={() => void saveName()} placeholder={uiText('auto.b78a4818850b')} ariaLabel={uiText('auto.709a23220f2c')} />
        </RowControl>
      </SettingsRow>
      <SettingsRow
        title={isWhatsApp ? uiText('auto.f69d5c7e6ea9') : uiText('auto.617a9b4cdbe6')}
        description={
          channel.configured
            ? uiText('auto.906b0c36659c')
            : isWhatsApp
              ? uiText('auto.934cd3231c84')
              : uiText('auto.690dd2f1e88f')
        }
      >
        <RowControl>
          <TextField
            type="password"
            placeholder={channel.configured ? uiText('auto.934684063338') : uiText('auto.f9a26b9b5d61')}
            value={token}
            onChange={setToken}
            ariaLabel={isWhatsApp ? uiText('auto.f69d5c7e6ea9') : uiText('auto.617a9b4cdbe6')}
          />
          <Button variant="primary" size="small" onClick={saveToken} disabled={!token}>
            {uiText('auto.efc007a393f6')}</Button>
        </RowControl>
      </SettingsRow>
      {isWhatsApp && (
        <>
          <SettingsRow title={uiText('auto.9bac39e4c734')} description={uiText('auto.93eae5bab731')}>
            <RowControl>
              <TextField
                value={phoneNumberId}
                onChange={setPhoneNumberId}
                onCommit={() => void savePhoneNumberId()}
                placeholder={uiText('auto.a94367d25d28')}
                ariaLabel={uiText('auto.9bac39e4c734')}
              />
            </RowControl>
          </SettingsRow>
          <SettingsRow title={uiText('auto.f952bc03ff37')} description={uiText('auto.a5e4ce27162b')}>
            <RowControl>
              <TextField
                type="password"
                placeholder={uiText('auto.8a8cfc172661')}
                value={verifyToken}
                onChange={setVerifyToken}
                ariaLabel={uiText('auto.f952bc03ff37')}
              />
              <Button variant="primary" size="small" onClick={() => void saveSecretField('verifyToken', verifyToken, setVerifyToken)} disabled={!verifyToken}>
                {uiText('auto.efc007a393f6')}</Button>
            </RowControl>
          </SettingsRow>
          <SettingsRow title={uiText('auto.b2bd6aa20a30')} description={uiText('auto.15fa16c6edcb')}>
            <RowControl>
              <TextField type="password" placeholder={uiText('auto.0b70589c7979')} value={appSecret} onChange={setAppSecret} ariaLabel={uiText('auto.b2bd6aa20a30')} />
              <Button variant="primary" size="small" onClick={() => void saveSecretField('appSecret', appSecret, setAppSecret)} disabled={!appSecret}>
                {uiText('auto.efc007a393f6')}</Button>
            </RowControl>
          </SettingsRow>
          <SettingsRow title={uiText('auto.ddf0afe0b122')} description={uiText('auto.b281f37d6d70')}>
            <RowControl>
              <TextField
                value={graphVersion}
                onChange={setGraphVersion}
                onCommit={() => void saveGraphVersion()}
                placeholder={WHATSAPP_GRAPH_VERSION}
                ariaLabel={uiText('auto.ddf0afe0b122')}
              />
            </RowControl>
          </SettingsRow>
          <SettingsRow title={uiText('auto.362bd8a3ea15')} description={uiText('auto.f5f2d25ab0de')}>
            <RowControl>
              <NumberField
                value={webhookPort}
                onChange={setWebhookPort}
                onCommit={(port) => void saveWebhookPort(port)}
                min={1}
                max={65535}
                ariaLabel={uiText('auto.362bd8a3ea15')}
              />
            </RowControl>
          </SettingsRow>
          <SettingsRow title={uiText('auto.c77e77b10f1e')} description={uiText('auto.5df5a9893af6')}>
            <RowControl>
              <ReadOnlyValue value={channel.webhookLocalUrl} ariaLabel={uiText('auto.c77e77b10f1e')} monospace />
            </RowControl>
          </SettingsRow>
          <SettingsRow title={uiText('auto.e3457d876b5c')} description={uiText('auto.dd09e47926aa')}>
            <RowControl>
              <TextField
                value={publicCallbackUrl}
                onChange={setPublicCallbackUrl}
                onCommit={() => void savePublicCallbackUrl()}
                placeholder="https://your-domain.example/assistant/whatsapp/..."
                ariaLabel={uiText('auto.e3457d876b5c')}
              />
            </RowControl>
          </SettingsRow>
        </>
      )}
      <SettingsRow
        title={isWhatsApp ? uiText('auto.e58b32b80ad3') : uiText('auto.14ab352fcdd9')}
        description={isWhatsApp ? uiText('auto.4e456e56a3df') : uiText('auto.930363794f9c')}
      >
        <RowControl>
          <TextField
            value={allow}
            onChange={setAllow}
            onCommit={() => void saveAllow()}
            placeholder={isWhatsApp ? uiText('auto.ea9876ad13be') : uiText('auto.ea5968fd153e')}
            ariaLabel={isWhatsApp ? uiText('auto.e58b32b80ad3') : uiText('auto.14ab352fcdd9')}
          />
        </RowControl>
      </SettingsRow>
      <SettingsRow title={uiText('auto.ed58f29743f8')} description={uiText('auto.82eedc18a56e')}>
        <RowControl>
          <TextField
            value={instr}
            onChange={setInstr}
            onCommit={() => void saveInstructions()}
            placeholder={uiText('auto.7c1596cc8ea7')}
            spellCheck={false}
            ariaLabel={uiText('auto.ed58f29743f8')}
          />
        </RowControl>
      </SettingsRow>
      {channel.instructionsPath && (
        <SettingsRow title="">
          <RowControl>
            <FilePathField path={channel.instructionsPath} />
          </RowControl>
        </SettingsRow>
      )}
      <SettingsRow title={uiText('auto.6dcf16e1c5d3')} description={uiText('auto.c251d4b1cf77')}>
        <RowControl>
          <ModelSelect value={channel.defaultRouting?.default ?? null} connections={connections} onChange={(m) => void saveRouter(m)} />
        </RowControl>
      </SettingsRow>
      <SettingsRow title={uiText('auto.909447ccca66')} description={uiText('auto.3ed875d2525b', { p0: isWhatsApp ? 'number' : 'bot' })}>
        <RowControl>
          <AttachmentParserSelect value={channel.attachmentParser ?? ''} connections={connections} includeInherit onChange={(v) => void saveParser(v)} />
        </RowControl>
      </SettingsRow>
      <SettingsRow title="">
        <RowControl>
          <Button variant="primary" size="small" onClick={toggle} disabled={!channel.configured}>
            {channel.running ? uiText('auto.9e253470c876') : uiText('auto.952f375412e8')}
          </Button>
          {confirmDel ? (
            <>
              <Button variant="danger" size="small" onClick={remove}>
                {uiText('auto.2a8865aab33b')}</Button>
              <Button variant="ghost" size="small" onClick={() => setConfirmDel(false)}>
                {uiText('auto.77dfd2135f4d')}</Button>
            </>
          ) : (
            <Button variant="ghost" size="small" onClick={() => setConfirmDel(true)}>
              {uiText('auto.e963907dac5c')}</Button>
          )}
          {channel.error && <span className="settings-row-control-aside assistant-set-err">{channel.error}</span>}
        </RowControl>
      </SettingsRow>

      <div className="assistant-provider">
        <div className="assistant-provider-head">
          <span className="assistant-provider-title">
            <span className="assistant-provider-name">{uiText('auto.059504c0d3fd')}</span>
          </span>
          <span className="assistant-badge">{uiText('auto.a94f25350631')}</span>
        </div>
        <p className="assistant-sub">{uiText('auto.7ceb91d6eaa0')}</p>
        <CommandEditor
          commands={channel.commands ?? []}
          onSave={(commands) => api.channels.setConfig(channel.id, { commands }).then(() => onChanged())}
          emptyHint={uiText('assistant.commands.empty')}
        />
      </div>

      <ListPage title={uiText('auto.0c6a9d1088dc')}>
        {myChats.length === 0 && (
          <p className="assistant-empty">{uiText('auto.c4e8bda7b10c')}{isWhatsApp ? uiText('auto.aa0e4a50986c') : uiText('assistant.channel.bot')} {uiText('auto.6427b40d3d23')}</p>
        )}
        {myChats.map((c) => (
          <ListRow
            key={c.id}
            glyph={isWhatsApp ? <WhatsApp className="assistant-wa-ico" /> : <Telegram className="assistant-tg-ico" />}
            name={c.title || uiText('assistant.chat.untitled')}
            sub={chatSubLine(c)}
            onOpen={() => setOpenChat(c.id)}
          />
        ))}
      </ListPage>
    </>
  )
}

const ChannelPane: FC<{
  type: 'telegram' | 'whatsapp'
  label: string
  addLabel: string
  personalities: AiPersonality[]
  connections: AiConnectionStatus[]
}> = ({ type, label, addLabel, personalities, connections }) => {
  const [channels, setChannels] = React.useState<ChannelInfo[]>([])
  const [chats, setChats] = React.useState<AiChatSummary[]>([])
  const [selected, setSelected] = React.useState<string | null>(null)
  const source = type === 'whatsapp' ? 'whatsapp' : 'telegram'

  const refreshChannels = React.useCallback(async () => {
    const res = await api.channels.list()
    setChannels(res.data?.channels ?? [])
  }, [])
  const refreshChats = React.useCallback(async () => {
    const res = await api.assistant.listChats()
    setChats(res.data?.chats ?? [])
  }, [])
  React.useEffect(() => {
    void refreshChannels()
    void refreshChats()
  }, [refreshChannels, refreshChats])

  const refreshAll = React.useCallback(async () => {
    await Promise.all([refreshChannels(), refreshChats()])
  }, [refreshChannels, refreshChats])

  // Stored order is the display order — the list must not re-sort, or the pane
  // would disagree with the channel manager about which connection is which.
  const filteredChannels = channels.filter((c) => c.type === type)
  const current = selected ? filteredChannels.find((c) => c.id === selected) ?? null : null

  if (current) {
    return (
      <ConnectionDetail
        channel={current}
        personalities={personalities}
        connections={connections}
        chats={chats}
        onBack={() => setSelected(null)}
        onChanged={refreshAll}
        refreshChats={refreshChats}
      />
    )
  }

  const add = async (): Promise<void> => {
    const res = await api.channels.add(type, `${label} ${filteredChannels.length + 1}`)
    await refreshChannels()
    if (res.data?.id) setSelected(res.data.id)
  }

  return (
    <>
      <ListPage title={uiText('auto.8f3509b64e0e')} addLabel={addLabel} onAdd={() => void add()}>
        {filteredChannels.length === 0 && <p className="assistant-empty">{uiText('auto.032029fdbd4e')}</p>}
        {filteredChannels.map((c) => {
          const dot = c.running ? 'ok' : c.configured ? 'warn' : 'off'
          const chatCount = chats.filter((t) => t.source === source && t.channelId === c.id).length
          return (
            <ListRow
              key={c.id}
              glyph={type === 'whatsapp' ? <WhatsApp className="assistant-wa-ico" /> : <Telegram className="assistant-tg-ico" />}
              name={c.displayName}
              sub={`${c.running ? 'running' : c.configured ? 'configured' : 'not configured'} · ${chatCount} chat${chatCount === 1 ? '' : 's'}`}
              badge={<span className={`assistant-dot ${dot}`} />}
              onOpen={() => setSelected(c.id)}
            />
          )
        })}
      </ListPage>
    </>
  )
}

const TelegramPane: FC<{ personalities: AiPersonality[]; connections: AiConnectionStatus[] }> = ({ personalities, connections }) => (
  <ChannelPane
    type="telegram"
    label={uiText('auto.edbea9ff1a78')}
    addLabel="Add Telegram connection"
    personalities={personalities}
    connections={connections}
  />
)

const WhatsAppPane: FC<{ personalities: AiPersonality[]; connections: AiConnectionStatus[] }> = ({ personalities, connections }) => (
  <ChannelPane
    type="whatsapp"
    label="WhatsApp"
    addLabel="Add WhatsApp connection"
    personalities={personalities}
    connections={connections}
  />
)

// ── Shell ──────────────────────────────────────────────────────────────────────

export const Settings: FC<{ section?: string }> = ({ section }) => {
  const { snap } = useAssistant()
  const [personalities, setPersonalities] = React.useState<AiPersonality[]>([])

  React.useEffect(() => {
    void api.assistant.listPersonalities().then((res) => setPersonalities(res.data?.personalities ?? []))
  }, [])

  if (section === 'providers') return <AiProvidersSection />
  if (section === 'usage') return <UsageBillingSection />
  if (section === 'harnesses') return <AiHarnessesSection />

  if (!snap.config) return <div className="assistant-settings">{uiText('auto.33ce417454bf')}</div>

  const sub: Section = section === 'chat' || section === 'telegram' || section === 'whatsapp' ? section : 'settings'
  const connections = snap.config.connections
  return (
    <div className="assistant-settings">
      {sub === 'settings' && <SettingsPane />}
      {sub === 'chat' && <ChatPane personalities={personalities} connections={connections} />}
      {sub === 'telegram' && <TelegramPane personalities={personalities} connections={connections} />}
      {sub === 'whatsapp' && <WhatsAppPane personalities={personalities} connections={connections} />}
    </div>
  )
}
