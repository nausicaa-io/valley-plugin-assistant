import { afterEach, describe, expect, it, vi } from 'vitest'
import type { AiChatThread } from '../src/types'
import type { RunAgentOptions } from '../src/agent/loop'

// Replace the agent loop with a deterministic stub: one assistant reply, no network.
vi.mock('../src/agent/loop', () => ({
  runAgent: async (opts: RunAgentOptions) => {
    opts.onMessage({ role: 'assistant', content: 'Reply from agent.' })
  },
  streamOnce: async () => ({ text: '', toolCalls: [] })
}))

import { createMockValleyApi } from './mock'
import { getStore, disposeStore } from '../src/store'

afterEach(() => disposeStore())

const tick = (): Promise<void> => new Promise((r) => setTimeout(r, 0))
async function until(pred: () => boolean, tries = 30): Promise<void> {
  for (let i = 0; i < tries && !pred(); i++) await tick()
}

describe('assistant store — channel conversations', () => {
  it('routes an inbound telegram message to its own read-only thread, not the active UI chat', async () => {
    const mock = createMockValleyApi()
    const store = getStore(mock.api)
    await until(() => Boolean(store.getSnapshot().active)) // init() settles + newChat
    const uiThreadId = store.getSnapshot().active?.id
    expect(store.getSnapshot().active?.messages).toHaveLength(0)

    mock.emitChannelMessage({ channelId: 'telegram', chatRef: 'test-chat-1001', from: 'Fern', text: 'hi', ts: Date.now() })
    await until(() => mock.driverCalls.some((c) => c.driver === 'channels' && c.method === 'send'))

    // The active in-app chat is untouched — the channel turn never bleeds into it.
    const snap = store.getSnapshot()
    expect(snap.active?.id).toBe(uiThreadId)
    expect(snap.active?.messages).toHaveLength(0)

    // A separate, telegram-sourced thread was created and persisted.
    const saved = mock.driverCalls
      .filter((c) => c.driver === 'ai' && c.method === 'saveChat')
      .map((c) => (c.payload as { thread: AiChatThread }).thread)
    const tg = saved.filter((t) => t.source === 'telegram').at(-1)
    expect(tg).toBeDefined()
    expect(tg?.id).toBe('tg-telegram-test-chat-1001')
    expect(tg?.chatRef).toBe('test-chat-1001')
    expect(tg?.channelName).toBe('Telegram')
    expect(tg?.messages.map((m) => m.role)).toEqual(['user', 'assistant'])

    // The agent's reply was sent back out over the channel.
    expect(
      mock.driverCalls.some(
        (c) => c.driver === 'channels' && c.method === 'send' && (c.payload as { text: string }).text === 'Reply from agent.'
      )
    ).toBe(true)
  })

  it('routes an inbound WhatsApp message to a read-only WhatsApp mirror thread', async () => {
    const mock = createMockValleyApi({
      channels: [
        {
          id: 'whatsapp-1',
          type: 'whatsapp',
          name: 'Fungi Channel',
          displayName: 'Fungi Channel',
          configured: true,
          running: true,
          allowFrom: ['15550100001']
        }
      ]
    })
    const store = getStore(mock.api)
    await until(() => Boolean(store.getSnapshot().active))
    const uiThreadId = store.getSnapshot().active?.id

    mock.emitChannelMessage({ channelId: 'whatsapp-1', chatRef: '15550100001', from: 'Fern', text: 'hello', ts: Date.now() })
    await until(() => mock.chatThreads.has('wa-whatsapp-1-15550100001'))

    expect(store.getSnapshot().active?.id).toBe(uiThreadId)
    const wa = mock.chatThreads.get('wa-whatsapp-1-15550100001')
    expect(wa).toMatchObject({
      source: 'whatsapp',
      channelId: 'whatsapp-1',
      chatRef: '15550100001',
      channelName: 'Fungi Channel',
      title: 'Fungi Channel · Fern'
    })
    expect(wa?.messages.map((m) => m.role)).toEqual(['user', 'assistant'])
    expect(
      mock.driverCalls.some(
        (c) =>
          c.driver === 'channels' &&
          c.method === 'send' &&
          (c.payload as { channelId: string; chatRef: string; text: string }).channelId === 'whatsapp-1' &&
          (c.payload as { channelId: string; chatRef: string; text: string }).text === 'Reply from agent.'
      )
    ).toBe(true)
  })
})
