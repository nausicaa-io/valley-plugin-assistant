import { afterEach, describe, expect, it, vi } from 'vitest'
import type { ChannelMessage } from '../src/types'
import type { GuardLayers } from '@valley/plugin-sdk/guard/types'
import type { RunAgentOptions } from '../src/agent/loop'

/**
 * Per-chat guard overrides (spec §4.4): a remembered approval choice ("Always
 * allow/ask/block here", in-app or Telegram) persists to the chat's
 * `guard-overrides.json` and is loaded back as the `chat` guard layer on the next
 * session — narrow-only (the resolver clamps it; resolve.test.ts covers that).
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
})

const tick = (): Promise<void> => new Promise((r) => setTimeout(r, 0))
async function until(pred: () => boolean, tries = 80): Promise<void> {
  for (let i = 0; i < tries && !pred(); i++) await tick()
}
const inbound = (text: string, chatRef: string): ChannelMessage => ({ channelId: 'telegram', chatRef, text, ts: Date.now() })
const draft = (): Parameters<NonNullable<RunAgentOptions['requestApproval']>>[0] => ({
  caller: 'agent',
  target: { kind: 'tool', id: 'write_note', sideEffect: 'write' },
  actionLabel: 'write_note',
  argsPreview: {},
  canRememberApproval: false
})
const saves = (mock: ReturnType<typeof createMockValleyApi>): { chatId: string; overrides: GuardLayers['chat'] }[] =>
  mock.driverCalls.filter((c) => c.driver === 'ai' && c.method === 'saveGuardOverrides').map((c) => c.payload as { chatId: string; overrides: GuardLayers['chat'] })

describe('assistant store — per-chat guard overrides', () => {
  it('persists a remembered "block here" to guard-overrides.json', async () => {
    const mock = createMockValleyApi()
    hooks.impl = async (opts) => {
      await opts.requestApproval(draft())
      opts.onMessage({ role: 'assistant', content: 'done' })
    }
    const store = getStore(mock.api)
    await until(() => Boolean(store.getSnapshot().active))

    void store.send('write a note')
    await until(() => Boolean(store.getSnapshot().pending))
    const pending = store.getSnapshot().pending!
    store.respond(pending.requestId, 'block')

    await until(() => saves(mock).length > 0)
    const saved = saves(mock).at(-1)!
    expect(saved.chatId).toBe(pending.chatId)
    expect(saved.overrides?.tools?.write_note?.decision).toBe('deny')
    // The persisted record round-trips through the mock's store.
    expect(mock.guardOverrides.get(pending.chatId)?.tools?.write_note?.decision).toBe('deny')
  })

  it('loads persisted overrides as the chat guard layer on a later session', async () => {
    const mock = createMockValleyApi()
    // Seed an override as if a previous session remembered it (telegram chat id is deterministic).
    await mock.api.assistant.saveGuardOverrides('tg-telegram-777', { tools: { write_note: { decision: 'deny' } } })

    let captured: GuardLayers | undefined
    hooks.impl = async (opts) => {
      captured = opts.guardLayers
      opts.onMessage({ role: 'assistant', content: 'reply' })
    }
    const store = getStore(mock.api)
    await until(() => store.getSnapshot().ready)

    mock.emitChannelMessage(inbound('hello', '777'))
    await until(() => captured != null)
    expect(captured?.chat?.tools?.write_note?.decision).toBe('deny')
  })

  it('a Telegram "block here" button persists a narrowing too', async () => {
    const mock = createMockValleyApi()
    hooks.impl = async (opts) => {
      const ok = await opts.requestApproval({ ...draft(), caller: 'telegram' })
      opts.onMessage({ role: 'assistant', content: ok ? 'did it' : 'blocked' })
    }
    const store = getStore(mock.api)
    await until(() => store.getSnapshot().ready)

    mock.emitChannelMessage(inbound('write a note', '888'))
    await until(() => mock.pendingApprovals.size > 0)
    const rec = [...mock.pendingApprovals.values()][0]
    mock.emitChannelMessage({ channelId: 'telegram', chatRef: '888', text: '', data: `block:${rec.requestId}`, ts: Date.now() })

    await until(() => saves(mock).some((s) => s.overrides?.tools?.write_note?.decision === 'deny'))
    expect(mock.guardOverrides.get('tg-telegram-888')?.tools?.write_note?.decision).toBe('deny')
  })
})
