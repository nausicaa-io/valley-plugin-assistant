import { afterEach, describe, expect, it, vi } from 'vitest'
import type { AiChatThread } from '../src/types'
import type { RunAgentOptions } from '../src/agent/loop'

/**
 * Speaking into a mirrored Telegram/WhatsApp conversation from the app.
 * `sendAsChannel` is the "as the bot" path: it delivers over the channel and
 * never starts an agent run, so the agent loop below must stay untouched.
 */
const hooks = vi.hoisted(() => ({ runs: 0 }))
vi.mock('../src/agent/loop', () => ({
  runAgent: async (opts: RunAgentOptions) => {
    hooks.runs += 1
    opts.onMessage({ role: 'assistant', content: 'ok' })
  },
  streamOnce: async () => ({ text: '', toolCalls: [] })
}))

import { createMockValleyApi } from './mock'
import { getStore, disposeStore } from '../src/store'

afterEach(() => {
  hooks.runs = 0
  disposeStore()
})

const tick = (): Promise<void> => new Promise((r) => setTimeout(r, 0))
async function until(pred: () => boolean, tries = 60): Promise<void> {
  for (let i = 0; i < tries && !pred(); i++) await tick()
}

const mirror = (): AiChatThread => ({
  id: 'tg-telegram-999',
  title: 'Field notes',
  createdAt: 1,
  updatedAt: 1,
  messages: [{ role: 'user', content: 'hello?' }],
  source: 'telegram',
  channelId: 'telegram',
  chatRef: '999',
  channelName: 'Field bot'
})

const sends = (mock: ReturnType<typeof createMockValleyApi>): { channelId: string; chatRef: string; text: string }[] =>
  mock.driverCalls
    .filter((c) => c.driver === 'channels' && c.method === 'send')
    .map((c) => c.payload as { channelId: string; chatRef: string; text: string })

/** Seed one mirrored remote thread and make it the active conversation. */
async function openMirror(mock: ReturnType<typeof createMockValleyApi>): Promise<ReturnType<typeof getStore>> {
  const thread = mirror()
  mock.chatThreads.set(thread.id, thread)
  const store = getStore(mock.api)
  await until(() => Boolean(store.getSnapshot().active))
  await store.openChat(thread.id)
  return store
}

describe('assistant store — replying into a remote chat', () => {
  it('delivers over the channel and mirrors the message once, with no agent run', async () => {
    const mock = createMockValleyApi()
    const store = await openMirror(mock)

    await store.sendAsChannel('  on my way  ')

    expect(sends(mock)).toEqual([{ channelId: 'telegram', chatRef: '999', text: 'on my way' }])
    expect(hooks.runs).toBe(0)
    const messages = store.getSnapshot().active?.messages ?? []
    expect(messages.filter((m) => m.content === 'on my way')).toHaveLength(1)
    // It is what the bot said, so it lands on the assistant side of the mirror.
    expect(messages.at(-1)?.role).toBe('assistant')
    expect(mock.chatThreads.get('tg-telegram-999')?.messages.at(-1)?.content).toBe('on my way')
  })

  it('appends nothing when the channel refuses the message', async () => {
    const mock = createMockValleyApi()
    const store = await openMirror(mock)
    const before = (store.getSnapshot().active?.messages ?? []).length
    vi.spyOn(mock.api.channels, 'send').mockRejectedValueOnce(new Error('chat not found'))

    await store.sendAsChannel('did it go?')

    expect(store.getSnapshot().active?.messages ?? []).toHaveLength(before)
    expect(store.getSnapshot().error).toBe('chat not found')
  })

  it('ignores an empty draft and a chat that is not a remote mirror', async () => {
    const mock = createMockValleyApi()
    const store = await openMirror(mock)

    await store.sendAsChannel('   ')
    expect(sends(mock)).toEqual([])

    store.newChat()
    await store.sendAsChannel('local chat')
    expect(sends(mock)).toEqual([])
  })
})

describe('assistant store — defaults for new chats', () => {
  it('seeds a new chat from the Chat settings personality and model', async () => {
    const mock = createMockValleyApi({
      settings: { defaultProfileId: 'coach', defaultModel: 'research:claude-opus-4-8' }
    })
    const config = await mock.api.assistant.getConfig()
    if (!config.ok || !config.data) throw new Error('Missing test assistant configuration')
    config.data.connections.push({
      id: 'research', provider: 'anthropic', createdAt: 1,
      providerName: 'Anthropic', providerDescription: '', providerIcon: '',
      providerCapabilities: [], requiresKey: true, baseUrl: 'https://api.anthropic.com',
      configured: true, models: []
    })
    const store = getStore(mock.api)
    await until(() => Boolean(store.getSnapshot().active))

    store.newChat()
    const active = store.getSnapshot().active
    expect(active?.profileId).toBe('coach')
    expect(active?.model).toEqual({ provider: 'anthropic', model: 'claude-opus-4-8', connectionId: 'research' })
  })

  it('leaves a new chat on Auto and the default personality when nothing is set', async () => {
    const mock = createMockValleyApi()
    const store = getStore(mock.api)
    await until(() => Boolean(store.getSnapshot().active))

    store.newChat()
    const active = store.getSnapshot().active
    expect(active?.profileId).toBeUndefined()
    expect(active?.model).toBeNull()
  })
})
