import { afterEach, describe, expect, it, vi } from 'vitest'
import type { ChannelMessage } from '../src/types'
import type { RunAgentOptions } from '../src/agent/loop'
import { renderToStaticMarkup } from 'react-dom/server'
import { initLocalization } from '../src/localization'
import en from '../locales/en.json'
import de from '../locales/de.json'
import es from '../locales/es.json'
import fr from '../locales/fr.json'
import zhCN from '../locales/zh-CN.json'

/**
 * The rich PermissionRequest store (C8): approvals carry a short requestId and an
 * expiry, the in-app card is driven by `snapshot.pending`, and — critically — a
 * turn parked on an approval never freezes other chats (runs are serialized
 * per-chat, concurrent across chats) and expires to a deny that frees the queue.
 *
 * The agent loop is replaced with a test stub so each test drives approvals
 * precisely; the stub parks (awaits `requestApproval`) only for chosen chats.
 */
const hooks = vi.hoisted(() => ({ impl: null as null | ((opts: RunAgentOptions) => Promise<void>) }))
vi.mock('../src/agent/loop', () => ({
  runAgent: async (opts: RunAgentOptions) => {
    if (hooks.impl) await hooks.impl(opts)
    else opts.onMessage({ role: 'assistant', content: 'ok' })
  },
  streamOnce: async () => ({ text: '', toolCalls: [] })
}))

import { createMockValleyApi } from './mock'
import { getStore, disposeStore } from '../src/store'

afterEach(() => {
  hooks.impl = null
  disposeStore()
  vi.useRealTimers()
})

const tick = (): Promise<void> => new Promise((r) => setTimeout(r, 0))
async function until(pred: () => boolean, tries = 80): Promise<void> {
  for (let i = 0; i < tries && !pred(); i++) await tick()
}
const inbound = (text: string, chatRef: string, extra: Partial<ChannelMessage> = {}): ChannelMessage => ({
  channelId: 'telegram',
  chatRef,
  text,
  ts: Date.now(),
  ...extra
})
const draft = (): Parameters<NonNullable<RunAgentOptions['requestApproval']>>[0] => ({
  caller: 'channel',
  target: { kind: 'tool', id: 'write_note', sideEffect: 'write' },
  actionLabel: 'write_note',
  argsPreview: {},
  canRememberApproval: false
})
const sends = (mock: ReturnType<typeof createMockValleyApi>): string[] =>
  mock.driverCalls.filter((c) => c.driver === 'channels' && c.method === 'send').map((c) => (c.payload as { text: string }).text)
const buttonChats = (mock: ReturnType<typeof createMockValleyApi>): string[] =>
  mock.driverCalls.filter((c) => c.driver === 'channels' && c.method === 'sendButtons').map((c) => (c.payload as { chatRef: string }).chatRef)

describe('assistant store — pending approvals', () => {
  it('an approval wait does not block other chats (C8)', async () => {
    const mock = createMockValleyApi()
    // Chat "aaa" parks on an approval forever; "bbb" runs normally.
    hooks.impl = async (opts) => {
      if (opts.conversationId?.includes('aaa')) {
        const ok = await opts.requestApproval(draft())
        opts.onMessage({ role: 'assistant', content: ok ? 'approved' : 'declined' })
      } else {
        opts.onMessage({ role: 'assistant', content: 'bbb reply' })
      }
    }
    const store = getStore(mock.api)
    await until(() => Boolean(store.getSnapshot().active))

    mock.emitChannelMessage(inbound('do a write', 'aaa'))
    await until(() => buttonChats(mock).includes('aaa')) // aaa parked on its prompt

    mock.emitChannelMessage(inbound('hello', 'bbb'))
    await until(() => sends(mock).includes('bbb reply')) // bbb ran while aaa parked

    expect(sends(mock)).toContain('bbb reply')
    expect(sends(mock)).not.toContain('approved') // aaa is still waiting, not resolved
    expect(sends(mock)).not.toContain('declined')
    expect(store.getSnapshot().busy).toBe(true) // aaa's run is still in flight (parked)
  })

  it('exposes a requestId on the in-app card and resolves it via respond()', async () => {
    const mock = createMockValleyApi()
    hooks.impl = async (opts) => {
      const ok = await opts.requestApproval(draft())
      opts.onMessage({ role: 'assistant', content: ok ? 'approved' : 'declined' })
    }
    const store = getStore(mock.api)
    await until(() => Boolean(store.getSnapshot().active))

    void store.send('please write a note')
    await until(() => Boolean(store.getSnapshot().pending))

    const pending = store.getSnapshot().pending!
    expect(pending.requestId).toBeTruthy()
    expect(pending.caller).toBe('agent')
    expect(pending.chatId).toBe(store.getSnapshot().active?.id)
    expect(mock.api.ui.confirm).not.toHaveBeenCalled()

    store.respond(pending.requestId, 'skip')
    await until(() => store.getSnapshot().pending == null)
    const msgs = store.getSnapshot().active?.messages ?? []
    expect(msgs.at(-1)).toMatchObject({ role: 'assistant', content: 'declined' })
  })

  it('stop() while parked on an in-app approval resolves it declined and unwedges the run', async () => {
    const mock = createMockValleyApi()
    hooks.impl = async (opts) => {
      const ok = await opts.requestApproval(draft())
      opts.onMessage({ role: 'assistant', content: ok ? 'approved' : 'declined' })
    }
    const store = getStore(mock.api)
    await until(() => Boolean(store.getSnapshot().active))

    void store.send('please write a note')
    await until(() => Boolean(store.getSnapshot().pending))
    expect(store.getSnapshot().busy).toBe(true)

    // Cancelling the run must settle the parked approval (as a decline), clear the
    // card, and free the chat — a stop can never wedge on a dangling confirmation.
    store.stop()
    await until(() => store.getSnapshot().pending == null && !store.getSnapshot().busy)
    expect(store.getSnapshot().pending).toBeNull()
    expect(store.getSnapshot().busy).toBe(false)

    // The chat accepts a fresh turn afterwards.
    hooks.impl = async (opts) => opts.onMessage({ role: 'assistant', content: 'fresh reply' })
    void store.send('hello again')
    await until(() => (store.getSnapshot().active?.messages ?? []).some((m) => m.content === 'fresh reply'))
    expect((store.getSnapshot().active?.messages ?? []).some((m) => m.content === 'fresh reply')).toBe(true)
  })

  it('expires a channel approval after 24h → denies and frees the chat (C8)', async () => {
    // Fake timers so the approval's 24h expiry timeout is captured and fired.
    vi.useFakeTimers()
    const mock = createMockValleyApi()
    // The first turn for "ccc" parks on an approval; later turns just reply.
    let parkOnce = true
    hooks.impl = async (opts) => {
      if (opts.conversationId?.includes('ccc') && parkOnce) {
        parkOnce = false
        const ok = await opts.requestApproval(draft())
        opts.onMessage({ role: 'assistant', content: ok ? 'approved' : 'declined' })
      } else {
        opts.onMessage({ role: 'assistant', content: 'fresh reply' })
      }
    }
    getStore(mock.api)
    await vi.advanceTimersByTimeAsync(0) // flush init

    mock.emitChannelMessage(inbound('first', 'ccc'))
    await vi.advanceTimersByTimeAsync(0) // run starts and parks on its prompt
    expect(buttonChats(mock)).toContain('ccc')
    expect(sends(mock)).not.toContain('declined')

    // Jump past the 24h hard expiry: the pending approval resolves to deny and the
    // run finishes — the chat is no longer stuck on a dangling confirmation.
    await vi.advanceTimersByTimeAsync(24 * 60 * 60 * 1000 + 1000)
    vi.useRealTimers()
    await until(() => sends(mock).includes('declined'))
    expect(sends(mock)).toContain('declined') // expiry → deny outcome

    // The chat is freed: a brand-new message runs normally (not blocked by the
    // expired approval).
    mock.emitChannelMessage(inbound('hello again', 'ccc'))
    await until(() => sends(mock).includes('fresh reply'))
    expect(sends(mock)).toContain('fresh reply')
  })

  it('tapping an expired button reports it expired (no pending left)', async () => {
    const mock = createMockValleyApi()
    const store = getStore(mock.api)
    await until(() => Boolean(store.getSnapshot().active))
    // No confirmation is pending for "zzz": a stray button tap is answered, not run.
    mock.emitChannelMessage(inbound('', 'zzz', { data: 'yes' }))
    await until(() => sends(mock).some((t) => t.toLowerCase().includes('expired')))
    expect(sends(mock).some((t) => t.toLowerCase().includes('expired'))).toBe(true)
  })

  it('persists a channel approval to runtime and clears it on resolve (C8)', async () => {
    const mock = createMockValleyApi()
    hooks.impl = async (opts) => {
      const ok = await opts.requestApproval(draft())
      opts.onMessage({ role: 'assistant', content: ok ? 'approved' : 'declined' })
    }
    const store = getStore(mock.api)
    await until(() => Boolean(store.getSnapshot().active))

    mock.emitChannelMessage(inbound('write a note', 'aaa'))
    await until(() => mock.pendingApprovals.size > 0) // persisted while pending
    const rec = [...mock.pendingApprovals.values()][0]
    expect(rec.channelId).toBe('telegram')
    expect(rec.chatRef).toBe('aaa')

    // The tapped button's `<action>:<requestId>` resolves and clears the record.
    mock.emitChannelMessage(inbound('', 'aaa', { data: `allow:${rec.requestId}` }))
    await until(() => sends(mock).includes('approved'))
    expect(mock.pendingApprovals.size).toBe(0)
  })

  it('recovers a stale pending approval on restart → expires + clears it (C8)', async () => {
    const mock = createMockValleyApi()
    // Seed a record as if a prior session left a confirmation pending.
    await mock.api.assistant.addPending({
      requestId: 'rold',
      channelId: 'telegram',
      chatRef: '5',
      chatId: 'tg-telegram-5',
      actionLabel: 'write_note',
      createdAt: Date.now() - 1000,
      expiresAt: Date.now() + 60_000
    })
    expect(mock.pendingApprovals.size).toBe(1)

    const store = getStore(mock.api)
    await until(() => store.getSnapshot().ready)
    // The dead record (its run is gone) is audited expired and cleared on launch.
    expect(mock.pendingApprovals.size).toBe(0)
    expect(
      mock.driverCalls.some(
        (c) => c.driver === 'ai' && c.method === 'appendGuardAudit' && (c.payload as { entry: { decision: string } }).entry.decision === 'expired'
      )
    ).toBe(true)
    // A later tap on that recovered request reports expired (never silently dropped).
    mock.emitChannelMessage(inbound('', '5', { data: 'allow:rold' }))
    await until(() => sends(mock).some((t) => t.toLowerCase().includes('expired')))
    expect(sends(mock).some((t) => t.toLowerCase().includes('expired'))).toBe(true)
  })
})

describe('assistant command-bus approvals', () => {
  async function startWithoutConversation(mock: ReturnType<typeof createMockValleyApi>) {
    initLocalization(mock.api)
    const register = vi.spyOn(mock.api.guard, 'registerRuntime')
    const store = getStore(mock.api)
    vi.spyOn(store, 'newChat').mockImplementation(() => {})
    await store.whenReady
    expect(store.getSnapshot().active).toBeNull()
    return { store, bridge: register.mock.calls[0][0] }
  }

  it.each([
    ['en', en], ['de', de], ['es', es], ['fr', fr], ['zh-CN', zhCN]
  ] as const)('shows an independent confirmation in %s and allows only this invocation', async (_language, catalog) => {
    const mock = createMockValleyApi()
    mock.api.ui.t = (key, params) => (catalog[key as keyof typeof catalog] ?? key)
      .replace(/\{\{([^}]+)\}\}/g, (_match, name: string) => String(params?.[name] ?? ''))
    const { store, bridge } = await startWithoutConversation(mock)
    vi.mocked(mock.api.ui.confirm).mockResolvedValueOnce('allow-once').mockResolvedValueOnce(null)
    const request = { ...draft(), caller: 'plugin' as const, pluginId: 'renamed-browser', actionLabel: 'Open example.com', argsPreview: { url: 'https://example.com' }, diffPreview: 'One browser tab', canRememberApproval: true }

    await expect(bridge.requestApproval(request)).resolves.toBe(true)
    await expect(bridge.requestApproval(request)).resolves.toBe(false)

    expect(mock.api.ui.confirm).toHaveBeenCalledTimes(2)
    const options = vi.mocked(mock.api.ui.confirm).mock.calls[0][0]
    expect(options.title).toBe(catalog['assistant.guard.confirmTitle'])
    expect(options.actions).toEqual([
      { label: catalog['auto.77dfd2135f4d'], value: 'cancel', variant: 'ghost' },
      { label: catalog['auto.c551e6cf17a5'], value: 'allow-once', variant: 'primary' }
    ])
    const message = renderToStaticMarkup(mock.api.React.createElement('div', null, options.message))
    expect(message).toContain('Open example.com')
    expect(message).toContain('https://example.com')
    expect(message).toContain('One browser tab')
    expect(store.getSnapshot().pending).toBeNull()
    expect(mock.pendingApprovals.size).toBe(0)
    expect(mock.guardOverrides.size).toBe(0)
    expect(mock.driverCalls.some((call) => call.method === 'saveGuardOverrides')).toBe(false)
  })

  it.each(['cancel', null, 'unexpected'])('denies a %s response', async (choice) => {
    const mock = createMockValleyApi()
    const { bridge } = await startWithoutConversation(mock)
    vi.mocked(mock.api.ui.confirm).mockResolvedValue(choice)
    await expect(bridge.requestApproval(draft())).resolves.toBe(false)
  })

  it('denies when the shared confirmation fails', async () => {
    const mock = createMockValleyApi()
    const { bridge } = await startWithoutConversation(mock)
    vi.mocked(mock.api.ui.confirm).mockRejectedValue(new Error('Surface unavailable'))
    await expect(bridge.requestApproval(draft())).resolves.toBe(false)
  })

  it.each(['dispose', 'prepareUnload'] as const)('settles pending confirmations on %s and ignores late approval', async (transition) => {
    const mock = createMockValleyApi()
    const { store, bridge } = await startWithoutConversation(mock)
    let choose!: (value: string) => void
    vi.mocked(mock.api.ui.confirm).mockImplementation(() => new Promise((resolve) => { choose = resolve }))
    const approval = bridge.requestApproval(draft())
    await until(() => vi.mocked(mock.api.ui.confirm).mock.calls.length > 0)
    await store[transition]()
    await expect(approval).resolves.toBe(false)
    choose('allow-once')
    await expect(approval).resolves.toBe(false)
    await expect(bridge.requestApproval(draft())).resolves.toBe(false)
    expect(mock.api.ui.confirm).toHaveBeenCalledTimes(1)
  })
})
