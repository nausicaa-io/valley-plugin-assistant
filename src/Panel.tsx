import { React, api } from './runtime'
import type { FC } from 'react'
import type { AiChatSummary } from './types'
import { usePluginSetting, useAssistant } from './hooks'
import { Chat, Pencil, Pin, Plus, Telegram, Trash, WhatsApp, X } from './icons'
import { uiText } from './localization'

/**
 * Left-sidebar panel: a conversation list, a New-chat button, and a quick prompt
 * that opens the full chat page. Clicking a conversation opens it in the main
 * workspace tab.
 */
type SourceFilter = 'all' | 'chat' | 'telegram' | 'whatsapp'

function useChatMenu(onRename: (id: string) => void): {
  openChatMenu: (e: React.MouseEvent, thread: AiChatSummary) => void
} {
  const { store } = useAssistant()

  const openChatMenu = (e: React.MouseEvent, thread: AiChatSummary): void => {
    e.preventDefault()
    e.stopPropagation()
    const point = { x: e.clientX, y: e.clientY }
    void api.ui.openMenu([
      { label: uiText('auto.d3f4cb898fbe'), icon: <Pencil className="" />, onSelect: () => onRename(thread.id) },
      {
        label: thread.pinned ? uiText('auto.2eba6a03b89a') : uiText('auto.9c918414710c'),
        icon: <Pin className="" />,
        onSelect: () => store.setPinned(thread.id, !thread.pinned)
      },
      { type: 'separator' },
      { label: uiText('auto.751e4570c26b'), icon: <X className="" />, onSelect: () => store.clearChat(thread.id) },
      {
        label: uiText('auto.f6fdbe48dc54'),
        icon: <Trash className="" />,
        danger: true,
        onSelect: () => api.ui.openMenu([
          { label: uiText('auto.77dfd2135f4d') },
          { label: uiText('auto.de434676e430'), danger: true, onSelect: () => store.deleteChat(thread.id) }
        ], point)
      }
    ], point)
  }

  return { openChatMenu }
}

function sortPinned(arr: AiChatSummary[]): AiChatSummary[] {
  return [...arr].sort((a, b) => (b.pinned ? 1 : 0) - (a.pinned ? 1 : 0))
}

export const Panel: FC = () => {
  const { store, snap } = useAssistant()
  const [filter, setFilter] = React.useState<SourceFilter>('all')
  const [renamingId, setRenamingId] = React.useState<string | null>(null)
  // Settings → Assistant decides whether a remote channel shows up here at all.
  const showTelegram = usePluginSetting('showTelegram', true)
  const showWhatsApp = usePluginSetting('showWhatsApp', true)

  const { openChatMenu } = useChatMenu(setRenamingId)

  // A filter pointing at a channel that was just switched off would leave the
  // list empty with no visible button to switch back.
  React.useEffect(() => {
    if (filter === 'telegram' && !showTelegram) setFilter('all')
    if (filter === 'whatsapp' && !showWhatsApp) setFilter('all')
  }, [filter, showTelegram, showWhatsApp])

  const openChat = (id: string): void => {
    void store.openChat(id)
    api.workspace.openMainTab()
  }

  const telegram = snap.threads.filter((t) => t.source === 'telegram')
  const whatsapp = snap.threads.filter((t) => t.source === 'whatsapp')
  const chats = snap.threads.filter((t) => !t.source)
  const danger = Boolean(snap.dangerous?.enabled)

  const toggleFilter = (src: SourceFilter): void => {
    setFilter((f) => (f === src ? 'all' : src))
  }

  const visibleChats = sortPinned(filter === 'all' || filter === 'chat' ? chats : [])
  const visibleTelegram = sortPinned(showTelegram && (filter === 'all' || filter === 'telegram') ? telegram : [])
  const visibleWhatsapp = sortPinned(showWhatsApp && (filter === 'all' || filter === 'whatsapp') ? whatsapp : [])

  const ThreadRow: FC<{ t: AiChatSummary; source?: AiChatSummary['source'] }> = ({ t, source }) => {
    const [rename, setRename] = React.useState(t.title)
    const inputRef = React.useRef<HTMLInputElement>(null)
    const editing = renamingId === t.id

    React.useEffect(() => {
      if (editing) {
        setRename(t.title)
        setTimeout(() => inputRef.current?.select(), 0)
      }
    }, [editing, t.title])

    const commitEdit = (): void => {
      const trimmed = rename.trim()
      if (trimmed && trimmed !== t.title) void store.renameChat(t.id, trimmed)
      setRenamingId(null)
    }

    return (
      <div
        className={`assistant-thread-row ${snap.active?.id === t.id ? 'active' : ''}`}
        onClick={() => !editing && openChat(t.id)}
        onContextMenu={(e) => openChatMenu(e, t)}
      >
        {source === 'telegram' && <Telegram className="assistant-ico assistant-tg-ico" />}
        {source === 'whatsapp' && <WhatsApp className="assistant-ico assistant-wa-ico" />}
        {t.pinned && !editing && <Pin className="assistant-thread-pin" />}
        {editing ? (
          <input
            ref={inputRef}
            className="assistant-thread-rename"
            value={rename}
            onClick={(e) => e.stopPropagation()}
            onChange={(e) => setRename(e.target.value)}
            onBlur={commitEdit}
            onKeyDown={(e) => {
              if (e.key === 'Enter') { e.preventDefault(); commitEdit() }
              if (e.key === 'Escape') { e.preventDefault(); setRenamingId(null) }
            }}
          />
        ) : (
          <span className="assistant-thread-title">{t.title}</span>
        )}
      </div>
    )
  }

  return (
    <div className="assistant-panel">
      <div className="panel-header assistant-panel-head">
        <span className="panel-title">{uiText('auto.6c9e84c6c121')}</span>
        <div className="assistant-source-filters">
          <button
            className={`assistant-source-btn${filter === 'chat' ? ' active' : ''}`}
            title={uiText('auto.f6ebd2cd8c82')}
            aria-label={uiText('auto.eeda87dc04bf')}
            onClick={() => toggleFilter('chat')}
          >
            <Chat className="" />
          </button>
          {showTelegram && (
            <button
              className={`assistant-source-btn assistant-tg-btn${filter === 'telegram' ? ' active' : ''}`}
              title={uiText('auto.edbea9ff1a78')}
              aria-label={uiText('auto.e89013db2363')}
              onClick={() => toggleFilter('telegram')}
            >
              <Telegram className="" />
            </button>
          )}
          {showWhatsApp && (
            <button
              className={`assistant-source-btn assistant-wa-btn${filter === 'whatsapp' ? ' active' : ''}`}
              title="WhatsApp"
              aria-label={uiText('auto.894acc676465')}
              onClick={() => toggleFilter('whatsapp')}
            >
              <WhatsApp className="" />
            </button>
          )}
        </div>
        {danger && (
          <button
            className="assistant-danger-chip"
            title={uiText('auto.5cdf2ff5e66f')}
            onClick={() => void store.disableDangerousMode()}
          >
            {uiText('auto.1977b0ec7885')}</button>
        )}
        <button
          className="assistant-iconbtn"
          style={{ marginLeft: 'auto' }}
          title={uiText('auto.009bf6b90cde')}
          aria-label={uiText('auto.009bf6b90cde')}
          onClick={() => {
            store.newChat()
            api.workspace.openMainTab()
          }}
        >
          <Plus className="" />
        </button>
      </div>

      <div className="assistant-thread-list">
        {visibleChats.length + visibleTelegram.length + visibleWhatsapp.length === 0 && (
          <div className="assistant-empty">{uiText('auto.265928933f22')}</div>
        )}
        {visibleChats.map((t) => (
          <ThreadRow key={t.id} t={t} />
        ))}
        {visibleTelegram.length > 0 && (
          <>
            <div className="assistant-thread-group-label">
              <Telegram className="assistant-tg-ico" /> {uiText('auto.edbea9ff1a78')}</div>
            {visibleTelegram.map((t) => (
              <ThreadRow key={t.id} t={t} source="telegram" />
            ))}
          </>
        )}
        {visibleWhatsapp.length > 0 && (
          <>
            <div className="assistant-thread-group-label">
              <WhatsApp className="assistant-wa-ico" /> WhatsApp
            </div>
            {visibleWhatsapp.map((t) => (
              <ThreadRow key={t.id} t={t} source="whatsapp" />
            ))}
          </>
        )}
      </div>
    </div>
  )
}
