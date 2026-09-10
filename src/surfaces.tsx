import type { ValleyPluginApi } from './api'
import { METADATA_PANEL_SEGMENT_V1, PLUGIN_SURFACE_V1, type PluginInspectionSubject } from '@valley/plugin-sdk'
import type { AiPersonality } from './types'
import { api, React } from './runtime'
import { useAssistant } from './hooks'
import { getStore } from './store'
import { readConversation } from './commands'
import { ChatDetail } from './Settings'
import { uiText } from './localization'

function Properties({ subject }: { subject?: PluginInspectionSubject }): React.ReactElement {
  const { snap, store } = useAssistant()
  const [personalities, setPersonalities] = React.useState<AiPersonality[]>([])
  React.useEffect(() => { let live = true; void api.assistant.listPersonalities().then((result) => { if (live) setPersonalities(result.data?.personalities ?? []) }); return () => { live = false } }, [])
  const id = subject?.item?.id
  const summary = snap.threads.find((thread) => thread.id === id)
  if (!id) return <div className="right-panel-body props-info"><dl className="props-info-table"><div className="props-info-row"><dt className="props-info-key">{uiText('assistant.surface.conversations')}</dt><dd className="props-info-value">{snap.threads.length}</dd></div></dl></div>
  if (!summary) return <div className="right-panel-body" role="alert">{uiText('assistant.surface.missing')}</div>
  return <div className="right-panel-body"><ChatDetail key={id} summary={summary} personalities={personalities} connections={snap.config?.connections ?? []} embedded backTo="" onBack={() => {}} onChanged={() => store.reloadThreads()} /></div>
}

export function registerAssistantSurfaces(pluginApi: ValleyPluginApi): () => void {
  const store = getStore(pluginApi)
  const surfaces = ['main_workspace', 'left_sidebar', 'right_sidebar'] as const
  const offs = surfaces.map((surface) => pluginApi.interop.extensions.provide(PLUGIN_SURFACE_V1, {
    id: `assistant.${surface}`, surface, subscribe: store.subscribe,
    getSnapshot: () => {
      const snap = store.getSnapshot()
      const selected = snap.threads.find((thread) => thread.id === snap.active?.id)
      return { title: selected?.title || uiText('manifest.name'), view: {},
        ...(selected ? { item: { id: selected.id, title: selected.title, state: { chatId: selected.id } } } : {}),
        navigation: { canGoBack: snap.canGoBack, canGoForward: snap.canGoForward, goBack: () => store.goBack(), goForward: () => store.goForward() }
      }
    },
    restore: async (state) => {
      await store.whenReady
      if (state.chatId === undefined) return
      if (typeof state.chatId !== 'string' || !state.chatId) throw new Error('Invalid conversation bookmark. Choose another conversation.')
      await readConversation(pluginApi, state.chatId)
      await store.openChat(state.chatId)
    }
  }))
  offs.push(pluginApi.interop.extensions.provide(METADATA_PANEL_SEGMENT_V1, {
    id: 'assistant.properties', label: 'Conversation', labelKey: 'assistant.surface.conversation', icon: 'chat', pluginSurfaces: ['main_workspace'], editCommand: 'update-properties',
    inspect: async ({ subject }) => {
      if (!subject?.item) return [{ id: 'count', label: uiText('assistant.surface.conversations'), value: store.getSnapshot().threads.length, readOnly: true }]
      const thread = await readConversation(pluginApi, subject.item.id)
      return [
        { id: 'title', label: uiText('assistant.surface.title'), value: thread.title, type: 'text' },
        { id: 'pinned', label: uiText('assistant.surface.pinned'), value: thread.pinned === true, type: 'boolean' },
        { id: 'model', label: uiText('auto.6dcf16e1c5d3'), value: thread.model ? { ...thread.model } : null, type: 'json' },
        { id: 'profileId', label: uiText('auto.ed58f29743f8'), value: thread.profileId ?? '', type: 'text' },
        { id: 'attachmentParser', label: uiText('auto.909447ccca66'), value: thread.attachmentParser ?? '', type: 'text' },
        { id: 'commands', label: uiText('auto.633cad38d705'), value: (thread.commands ?? []).map((command) => ({ ...command })), type: 'json' }
      ]
    },
    render: ({ subject }) => <Properties subject={subject} />
  }))
  return () => offs.forEach((off) => off())
}
