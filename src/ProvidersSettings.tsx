import type { FC, ReactNode } from 'react'
import { React, api } from './runtime'
// simple-icons dropped its OpenAI mark, so that one comes from Remix instead.
import { SiAnthropic, SiGooglegemini, SiMoonshotai, SiOllama } from './settingsIcons'
import { RiDeepseekFill, RiGrokAiFill, RiOpenaiFill } from './settingsIcons'
import { LuChevronLeft, LuChevronRight, LuPlug, LuPlus, LuTrash2, LuTriangleAlert } from './settingsIcons'
import type { AiConnectionStatus, AiProviderId } from './types'
const Button: typeof api.ui.settings.Button = (props) => React.createElement(api.ui.settings.Button, props)
const Row: typeof api.ui.settings.Row = (props) => React.createElement(api.ui.settings.Row, props)
const TextField: typeof api.ui.settings.TextField = (props) => React.createElement(api.ui.settings.TextField, props)
const useReorderDrag: typeof api.ui.settings.useReorderDrag = (props) => api.ui.settings.useReorderDrag(props)
const openMenu: typeof api.ui.openMenu = (...args) => api.ui.openMenu(...args)
import type { UiMenuItem as MenuItem } from '@valley/plugin-sdk'

import { uiText, connectionProviderText } from './localization'


const providerGlyph = (icon: string): ReactNode => {
  if (icon === 'anthropic') return <SiAnthropic />
  if (icon === 'openai') return <RiOpenaiFill />
  if (icon === 'gemini') return <SiGooglegemini />
  if (icon === 'deepseek') return <RiDeepseekFill />
  if (icon === 'kimi') return <SiMoonshotai />
  if (icon === 'xai') return <RiGrokAiFill />
  if (icon === 'ollama') return <SiOllama />
  return <LuPlug />
}

interface AiResult<T> {
  ok: boolean
  error?: string
  data?: T
}

async function invokeAi<T>(method: string, payload: unknown = {}): Promise<AiResult<T>> {
  try { return { ok: true, data: await api.backend.call(`ai.${method}`, payload) as T } }
  catch (error) { return { ok: false, error: error instanceof Error ? error.message : String(error) } }
}

/** The id a provider's default connection carries — the provider id itself. */
const isDefaultConnection = (c: AiConnectionStatus): boolean => c.id === c.provider

const connectionName = (connection: AiConnectionStatus): string => connection.label || connectionProviderText(connection.provider, 'name', connection.providerName)

/** Which surface the section is showing — the list, or one connection. */
type View = { kind: 'list' } | { kind: 'connection'; id: string }

export const AiProvidersSection: FC = () => {
  const [connections, setConnections] = React.useState<AiConnectionStatus[] | null>(null)
  const [view, setView] = React.useState<View>({ kind: 'list' })
  const [error, setError] = React.useState<string | null>(null)

  const refresh = React.useCallback(async () => {
    const res = await invokeAi<{ connections: AiConnectionStatus[] }>('listConnections')
    if (res.ok && res.data) setConnections(res.data.connections)
    else {
      setConnections([])
      setError(res.error ?? null)
    }
  }, [])

  React.useEffect(() => {
    void refresh()
  }, [refresh])

  /** The `+` picker: choose a provider, get a fresh connection, land on its detail. */
  const addConnection = async (anchor: HTMLElement): Promise<void> => {
    const providers = [...new Map(connections?.map((connection) => [connection.provider, connection]) ?? []).values()]
    const items: MenuItem[] = providers.map((provider) => ({
      id: provider.provider,
      icon: providerGlyph(provider.providerIcon),
      label: connectionProviderText(provider.provider, 'name', provider.providerName),
      description: connectionProviderText(provider.provider, 'description', provider.providerDescription)
    }))
    const picked = (await openMenu(items, { anchor, align: 'start' })) as AiProviderId | null
    if (!picked) return
    const res = await invokeAi<{ connection: { id: string } }>('addConnection', { provider: picked })
    await refresh()
    if (res.ok && res.data) setView({ kind: 'connection', id: res.data.connection.id })
  }

  if (connections === null) {
    return (
      <section className="settings-section aip-section">
        <div className="aip-empty">{uiText('auto.a5dcb93d831d')}</div>
      </section>
    )
  }

  if (view.kind === 'connection') {
    const connection = connections.find((c) => c.id === view.id)
    if (connection) {
      return (
        <ConnectionDetail
          key={connection.id}
          connection={connection}
          error={error}
          onBack={() => setView({ kind: 'list' })}
          onChanged={refresh}
          onRemoved={() => {
            setView({ kind: 'list' })
            void refresh()
          }}
        />
      )
    }
  }

  /** Optimistic: paint the new order at once, persist behind it. */
  const reorderConnections = (ids: string[]): void => {
    setConnections((current) => {
      if (!current) return current
      const byId = new Map(current.map((c) => [c.id, c]))
      return ids.map((id) => byId.get(id)).filter((c): c is AiConnectionStatus => Boolean(c))
    })
    void invokeAi('reorderConnections', { connectionIds: ids })
  }

  return (
    <ConnectionList
      connections={connections}
      error={error}
      setView={setView}
      addConnection={addConnection}
      onReorder={reorderConnections}
    />
  )
}

// ── List ─────────────────────────────────────────────────────────────────────

/** The short state word on a row — what the user must do next, if anything. */
function badgeFor(connection: AiConnectionStatus): { label: string; ok: boolean } {
  if (!connection.requiresKey) {
    return connection.configured ? { label: 'local', ok: true } : { label: uiText('auto.3be6269d134b'), ok: false }
  }
  if (connection.authSources?.savedKeyUnreadable) return { label: uiText('auto.f11c83a7416f'), ok: false }
  if (connection.authMode === 'env') return { label: uiText('auto.f2ce284ff80e'), ok: true }
  if (connection.authSources?.savedKey) return { label: 'connected', ok: true }
  return { label: uiText('auto.5d557567fbb3'), ok: false }
}

/** How a probe/save note reads: a result, a failure, or a plain progress line. */

const ProviderGlyph: FC<{ icon: string; large?: boolean }> = ({ icon, large }) => (
  <span className={`settings-list-glyph${large ? ' settings-list-glyph--lg' : ''}`}>
    {providerGlyph(icon)}
  </span>
)

const ConnectionList: FC<{
  connections: AiConnectionStatus[]
  error: string | null
  setView: (view: View) => void
  addConnection: (anchor: HTMLElement) => Promise<void>
  onReorder: (ids: string[]) => void
}> = ({ connections, error, setView, addConnection, onReorder }) => {
  // Stored order is the display order — no client-side sort, or a drag would
  // snap back the moment the list reloaded.
  const reorder = useReorderDrag({
    items: connections,
    getId: (connection) => connection.id,
    getLabel: (connection) => connectionName(connection),
    onReorder: (next) => onReorder(next.map((connection) => connection.id)),
    indicatorOnly: true
  })

  return (
    <section className="settings-section aip-section settings-listpage">
      <div className="settings-listpage-header">
        <h4 className="settings-label">{uiText('auto.8f3509b64e0e')}</h4>
        <Button
          className="settings-listpage-add"
          size="small"
          aria-label={uiText('auto.75c2ccfca467')}
          title={uiText('auto.75c2ccfca467')}
          onClick={(event) => void addConnection(event.currentTarget)}
        >
          <LuPlus />
        </Button>
      </div>

      {error && <div className="aip-error">{error}</div>}

      <div className="settings-list">
        {connections.map((connection) => {
          const badge = badgeFor(connection)
          // The row is its own drag handle — no grip glyph in the list.
          const row = reorder.getRowProps(connection)
          return (
            <div
              key={connection.id}
              className="settings-list-row"
              {...row}
              onClick={() => setView({ kind: 'connection', id: connection.id })}
              role="button"
              tabIndex={0}
              onKeyDown={(event) => {
                row.onKeyDown?.(event)
                if (event.defaultPrevented) return
                if (event.key === 'Enter' || event.key === ' ') {
                  event.preventDefault()
                  setView({ kind: 'connection', id: connection.id })
                }
              }}
            >
              <ProviderGlyph icon={connection.providerIcon} />
              <span className="settings-list-meta">
                <span className="settings-list-name">{connectionName(connection)}</span>
                <span className="settings-list-sub">
                  {connection.label ? `${connectionProviderText(connection.provider, 'name', connection.providerName)} · ` : ''}
                  {connection.models.length} {uiText('auto.5ba2688dffd7')}</span>
              </span>
              {connection.authSources?.savedKeyUnreadable && (
                <span className="aip-reauth" title={uiText('auto.e6b23de5fab6')}>
                  <LuTriangleAlert />
                </span>
              )}
              <span className={`aip-badge ${badge.ok ? 'ok' : 'off'}`}>
                <span className={`aip-dot ${badge.ok ? 'ok' : 'off'}`} />
                {badge.label}
              </span>
              <LuChevronRight className="settings-list-chevron" />
            </div>
          )
        })}
      </div>
      {reorder.liveRegion}
    </section>
  )
}

// ── Detail ───────────────────────────────────────────────────────────────────

const ConnectionDetail: FC<{
  connection: AiConnectionStatus
  error: string | null
  onBack: () => void
  onChanged: () => Promise<void>
  onRemoved: () => void
}> = ({ connection, error, onBack, onChanged, onRemoved }) => {
  const { id, provider, baseUrl } = connection
  const [name, setName] = React.useState(connection.label ?? '')
  const [key, setKey] = React.useState('')
  const [url, setUrl] = React.useState(baseUrl)
  const [note, setNote] = React.useState('')
  const [tone, setTone] = React.useState('')
  const [confirmDeleteKey, setConfirmDeleteKey] = React.useState(false)
  const [confirmRemove, setConfirmRemove] = React.useState(false)
  const requiresKey = connection.requiresKey
  const hasSavedKey = Boolean(connection.authSources?.savedKey)
  // `savedKey` is true for an unreadable cipher too, so without this the detail
  // reads "connected" for a key every request will fail on. The usual cause is
  // an app rename: safeStorage derives its key from the app name, and there is
  // no migration path, so the old ciphertext is dead and must be re-entered.
  const keyUnreadable = Boolean(connection.authSources?.savedKeyUnreadable)

  const rename = async (label: string): Promise<void> => {
    await invokeAi('updateConnection', { connectionId: id, label })
    await onChanged()
  }
  const saveKey = async (): Promise<void> => {
    const result = await invokeAi('setConnectionKey', { connectionId: id, key })
    setTone(result.ok ? 'ok' : 'aip-err')
    if (!result.ok) { setNote(result.error ?? uiText('assistant.providers.saveFailed')); return }
    setKey('')
    setNote(uiText('auto.6b158b71de7d'))
    await onChanged()
  }
  const deleteKey = async (): Promise<void> => {
    const result = await invokeAi('setConnectionKey', { connectionId: id, key: '' })
    setTone(result.ok ? 'ok' : 'aip-err')
    if (!result.ok) { setNote(result.error ?? uiText('assistant.providers.saveFailed')); return }
    setConfirmDeleteKey(false)
    setKey('')
    setNote(uiText('auto.5a9fd5af5840'))
    await onChanged()
  }
  const saveUrl = async (): Promise<void> => {
    const result = await invokeAi('updateConnection', { connectionId: id, baseUrl: url })
    setTone(result.ok ? 'ok' : 'aip-err')
    if (!result.ok) { setNote(result.error ?? uiText('assistant.providers.saveFailed')); return }
    setNote(uiText('auto.3d888df92742'))
    await onChanged()
  }
  const remove = async (): Promise<void> => {
    await invokeAi('removeConnection', { connectionId: id })
    onRemoved()
  }
  const test = async (): Promise<void> => {
    setNote(uiText('auto.95c4564a945f'))
    setTone('')
    // Probe the URL currently in the box, live (skip cache) and strict (fail on a
    // broken/unauthorized endpoint instead of returning the static default list).
    const res = await invokeAi<{ models: unknown[] }>('listModels', {
      provider,
      connectionId: id,
      baseUrl: url,
      noCache: true,
      strict: true
    })
    setTone(res.ok ? 'ok' : 'aip-err')
    setNote(
      res.ok
        // `ok` with a payload that carries no `models` is a real shape (a driver
        // returning `{}`), so the chain must not stop at `data`.
        ? uiText('auto.1e2476c7ad27', { p0: res.data?.models?.length ?? 0 })
        : uiText('auto.8e2fe99af63e', { p0: res.error })
    )
  }

  const apiKeyHint =
    connection.authMode === 'env'
      ? uiText('auto.42c5c5b56738')
      : keyUnreadable
        ? uiText('auto.e880093b1c4c')
        : hasSavedKey
          ? uiText('auto.584e57070841')
          : uiText('auto.b60ec2626e5b')
  const keyPlaceholder = keyUnreadable ? uiText('assistant.providers.pasteAgain') : hasSavedKey ? uiText('assistant.providers.savedKey') : uiText('assistant.providers.pasteKey')

  return (
    <section className="settings-section aip-section">
      {/* A sub-page band: a chevron back to the list, then this page's own name. */}
      <div className="settings-listpage-crumbs">
        <button
          type="button"
          className="settings-listpage-back"
          aria-label={uiText('auto.b70b6ab0baad', { p0: uiText('settings.section.aiProviders') })}
          title={uiText('auto.b70b6ab0baad', { p0: uiText('settings.section.aiProviders') })}
          onClick={onBack}
        >
          <LuChevronLeft />
        </button>
        <span className="settings-crumb settings-crumb-current">{connectionName(connection)}</span>
      </div>

      {error && <div className="aip-error">{error}</div>}

      <div className="aip-detail-identity">
        <ProviderGlyph icon={connection.providerIcon} large />
        <div className="settings-list-meta">
          <span className="settings-list-name">{connectionProviderText(connection.provider, 'name', connection.providerName)}</span>
          <span className="settings-list-sub">
            {!requiresKey ? uiText('auto.365cd35c0cc4') : uiText('auto.1664a5dc008c')}
            {connection.providerSettingsUrl && (
              <>
                {' '}
                <a className="aip-link" href={connection.providerSettingsUrl} onClick={(event) => { event.preventDefault(); void api.files.openExternalUrl(event.currentTarget.href) }}>
                  {uiText('auto.c3cdda019a8a')}
                </a>
              </>
            )}
          </span>
        </div>
      </div>

      <Row title={uiText('auto.709a23220f2c')}>
        <TextField
          value={name}
          onChange={setName}
          onCommit={(value) => void rename(value)}
          placeholder={connectionProviderText(connection.provider, 'name', connection.providerName)}
          ariaLabel={uiText('auto.5584ef8e0ccb')}
        />
      </Row>

      {/* No "Provider" row: the identity band above already names it, and it was
          never editable. */}

      {/* The credential is a settings row like every other one — its state line
          is the row's description, not a boxed card wedged into the page. */}
      {requiresKey && (
        <Row title={uiText('auto.cf678cab87dc')} description={apiKeyHint}>
          <span className="settings-row-control">
            <TextField
              type="password"
              placeholder={keyPlaceholder}
              value={key}
              onChange={setKey}
              ariaLabel={uiText('auto.cf678cab87dc')}
            />
            {/* Both Save buttons read "Save"; the aria-labels keep them apart. */}
            <Button
              variant="primary"
              size="small"
              aria-label={uiText('auto.d8e28f4da7a9')}
              onClick={saveKey}
              disabled={!key}
            >
              {uiText('auto.efc007a393f6')}
            </Button>
            {hasSavedKey && (
              <span className="settings-row-control-aside">
                {confirmDeleteKey ? (
                  <>
                    <Button variant="danger" size="small" onClick={deleteKey}>
                      {uiText('auto.c9f2829e382c')}
                    </Button>
                    <Button variant="ghost" size="small" onClick={() => setConfirmDeleteKey(false)}>
                      {uiText('auto.77dfd2135f4d')}
                    </Button>
                  </>
                ) : (
                  <Button className="aip-delete-link" variant="ghost" size="small" onClick={() => setConfirmDeleteKey(true)}>
                    {uiText('auto.6675db26c5c0')}
                  </Button>
                )}
              </span>
            )}
          </span>
        </Row>
      )}

      <Row
        title={uiText('auto.1dbd61f556fe')}
        description={!requiresKey ? uiText('auto.779d8d5225c1') : uiText('auto.568c15795f81')}
      >
        <span className="settings-row-control">
          <TextField value={url} onChange={setUrl} ariaLabel={uiText('auto.1dbd61f556fe')} />
          <Button size="small" aria-label={uiText('auto.ce3afc8e9c37')} onClick={saveUrl}>
            {uiText('auto.efc007a393f6')}
          </Button>
        </span>
      </Row>

      {/* The probe and the destructive action are settings rows like the rest —
          each says what it does before you press it. The probe's result lands
          under its own description rather than floating on the page. */}
      <Row
        title={uiText('auto.ccf66f074649')}
        description={uiText('auto.befc74d0b16a')}
        extra={note ? <span className={`aip-status ${tone}`}>{note}</span> : null}
      >
        <Button size="small" aria-label={uiText('auto.ccf66f074649')} onClick={test}>
          {uiText('auto.640ab2bae07b')}</Button>
      </Row>

      {/* Deleting takes two presses — the first only arms it. A stray click on a
          red button must never cost a saved key. */}
      <Row
        title={uiText('auto.dfa71a6fbcd2')}
        description={
          isDefaultConnection(connection)
            ? uiText('auto.bf658cc39789')
            : uiText('auto.54c60c90ac23')
        }
      >
        {confirmRemove ? (
          <span className="settings-row-control">
            <Button variant="danger" size="small" onClick={() => void remove()}>
              <LuTrash2 />
              {uiText('auto.c9f2829e382c')}
            </Button>
            <Button variant="ghost" size="small" onClick={() => setConfirmRemove(false)}>
              {uiText('auto.77dfd2135f4d')}
            </Button>
          </span>
        ) : (
          <Button
            variant="danger"
            size="small"
            aria-label={isDefaultConnection(connection) ? uiText('auto.c8373415aec4') : uiText('auto.6a47f6fa1d07')}
            onClick={() => setConfirmRemove(true)}
          >
            <LuTrash2 />
            {uiText('auto.f6fdbe48dc54')}
          </Button>
        )}
      </Row>
    </section>
  )
}
