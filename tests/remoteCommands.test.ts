import { afterEach, describe, expect, it, vi } from 'vitest'
import type { AssistantConfig, ChannelMessage } from '../src/types'

/**
 * Store-level remote slash-commands over a channel (spec §7.1): `/help`, `/model`,
 * `/profile`, `/guard`. Each is handled in the store and answered over the channel
 * — never forwarded to the model (the agent loop is stubbed and must not run).
 */
const ran = vi.hoisted(() => ({ count: 0 }))
vi.mock('../src/agent/loop', () => ({
  runAgent: async () => {
    ran.count++
  },
  streamOnce: async () => ({ text: '', toolCalls: [] })
}))

import { createMockValleyApi } from './mock'
import { getStore, disposeStore } from '../src/store'

afterEach(() => {
  ran.count = 0
  disposeStore()
})

const tick = (): Promise<void> => new Promise((r) => setTimeout(r, 0))
async function until(pred: () => boolean, tries = 60): Promise<void> {
  for (let i = 0; i < tries && !pred(); i++) await tick()
}
const inbound = (text: string): ChannelMessage => ({ channelId: 'telegram', chatRef: '999', text, ts: Date.now() })
const sends = (mock: ReturnType<typeof createMockValleyApi>): string[] =>
  mock.driverCalls.filter((c) => c.driver === 'channels' && c.method === 'send').map((c) => (c.payload as { text: string }).text)

const config = (): AssistantConfig => ({
  instructions: '',
  rules: [],
  routing: { auto: true, default: { provider: 'anthropic', model: 'claude-opus-4-8' }, rules: [] },
  guard: {
    defaultWrite: { decision: 'confirm', allowPreApproval: false },
    tools: {},
    commands: {},
    files: {
      visitMode: 'allow-listed-only',
      defaultRead: { decision: 'allow' },
      defaultWrite: { decision: 'confirm', allowPreApproval: false },
      allowedToVisit: ['**/*.md'],
      allowedToWrite: ['**/*.md'],
      blocked: ['.valley/assistant'],
      readOverrides: {},
      writeOverrides: {}
    },
    dangerousMode: { enabled: false, scope: 'off', expiresAt: null, maxTtlMinutes: 60 },
    pluginPresets: {}
  },
  providers: [
    { provider: 'openai', configured: true, authMode: 'key', authSources: { envKey: false, savedKey: true }, baseUrl: '', models: [{ provider: 'openai', id: 'gpt-5.5', tools: true }] }
  ],
  // The default connection's id IS the provider id, which is what keeps a
  // `provider:model` ref like `openai:gpt-5.5` resolving.
  connections: [
    {
      id: 'openai',
      provider: 'openai',
      providerName: 'OpenAI',
      providerDescription: 'OpenAI provider',
      providerIcon: 'openai',
      requiresKey: true,
      providerCapabilities: ['chat', 'models'],
      configured: true,
      authMode: 'key',
      authSources: { envKey: false, savedKey: true },
      baseUrl: '',
      models: [{ provider: 'openai', id: 'gpt-5.5', tools: true }],
      createdAt: 0
    }
  ]
})

describe('assistant store — remote slash-commands', () => {
  it('/help lists commands without running the agent', async () => {
    const mock = createMockValleyApi({ aiConfig: config() })
    const store = getStore(mock.api)
    await until(() => store.getSnapshot().ready)
    mock.emitChannelMessage(inbound('/help'))
    await until(() => sends(mock).some((t) => t.includes('/model')))
    expect(sends(mock).some((t) => t.startsWith('Commands:'))).toBe(true)
    expect(ran.count).toBe(0)
  })

  it('/model sets a per-chat model override (provider:model) and persists it', async () => {
    const mock = createMockValleyApi({ aiConfig: config() })
    const store = getStore(mock.api)
    await until(() => store.getSnapshot().ready)
    mock.emitChannelMessage(inbound('/model openai:gpt-5.5'))
    await until(() => sends(mock).some((t) => t.includes('Model set')))
    expect(mock.chatThreads.get('tg-telegram-999')?.model).toEqual({ provider: 'openai', model: 'gpt-5.5' })
    // …and a bare id resolves against the one configured provider that exposes it.
    mock.emitChannelMessage(inbound('/model auto'))
    await until(() => sends(mock).some((t) => t.includes('Auto')))
    expect(mock.chatThreads.get('tg-telegram-999')?.model).toBeNull()
  })

  it('/model asks to disambiguate when several providers expose the id', async () => {
    const cfg = config()
    cfg.providers = [
      { provider: 'openai', configured: true, authMode: 'key', authSources: { envKey: false, savedKey: true }, baseUrl: '', models: [{ provider: 'openai', id: 'shared', tools: true }] },
      { provider: 'deepseek', configured: true, authMode: 'key', authSources: { envKey: false, savedKey: true }, baseUrl: '', models: [{ provider: 'deepseek', id: 'shared', tools: true }] }
    ]
    const mock = createMockValleyApi({ aiConfig: cfg })
    const store = getStore(mock.api)
    await until(() => store.getSnapshot().ready)
    mock.emitChannelMessage(inbound('/model shared'))
    await until(() => sends(mock).some((t) => t.toLowerCase().includes('pick one')))
    expect(mock.chatThreads.get('tg-telegram-999')?.model).toBeUndefined()
  })

  it('/profile sets the personality when it exists', async () => {
    const mock = createMockValleyApi({ aiConfig: config() })
    const store = getStore(mock.api)
    await until(() => store.getSnapshot().ready)
    await mock.api.assistant.savePersonality({ id: 'mycology', name: 'Mycology', isDefault: false, instructions: '', routing: config().routing })
    mock.emitChannelMessage(inbound('/profile mycology'))
    await until(() => sends(mock).some((t) => t.includes('Personality set to Mycology')))
    expect(mock.chatThreads.get('tg-telegram-999')?.profileId).toBe('mycology')
  })

  it('/guard reports the effective policy for the chat', async () => {
    const mock = createMockValleyApi({ aiConfig: config() })
    const store = getStore(mock.api)
    await until(() => store.getSnapshot().ready)
    mock.emitChannelMessage(inbound('/guard'))
    await until(() => sends(mock).some((t) => t.includes('Guard policy')))
    const text = sends(mock).find((t) => t.includes('Guard policy'))!
    expect(text).toContain('allow-listed only')
    expect(text).toContain('Dangerous mode: off')
  })

  it('rejects an unknown command', async () => {
    const mock = createMockValleyApi({ aiConfig: config() })
    const store = getStore(mock.api)
    await until(() => store.getSnapshot().ready)
    mock.emitChannelMessage(inbound('/wat'))
    await until(() => sends(mock).some((t) => t.includes('Unknown command')))
    expect(ran.count).toBe(0)
  })
})

describe('assistant store — custom commands', () => {
  it('expands an overall custom command into a turn (channel)', async () => {
    const mock = createMockValleyApi({ aiConfig: config() })
    const store = getStore(mock.api)
    await until(() => store.getSnapshot().ready)
    await mock.api.assistant.saveCommands([{ name: 'fieldlog', prompt: 'Summarize the habitat observations.' }])
    mock.emitChannelMessage(inbound('/fieldlog'))
    await until(() => ran.count === 1)
    // The expanded prompt is the turn's user message — not the literal "/fieldlog".
    const last = mock.chatThreads.get('tg-telegram-999')?.messages.at(-1)
    expect(last).toMatchObject({ role: 'user', content: 'Summarize the habitat observations.' })
  })

  it('a per-chat custom command overrides the overall one and passes {args}', async () => {
    const mock = createMockValleyApi({ aiConfig: config() })
    const store = getStore(mock.api)
    await until(() => store.getSnapshot().ready)
    await mock.api.assistant.saveCommands([{ name: 'note', prompt: 'overall note' }])
    // Seed the chat thread with its own `note` command.
    await mock.api.assistant.saveChat({
      id: 'tg-telegram-999',
      title: 'T',
      createdAt: 1,
      updatedAt: 1,
      messages: [],
      source: 'telegram',
      channelId: 'telegram',
      chatRef: '999',
      commands: [{ name: 'note', prompt: 'Take a note: {args}' }]
    })
    mock.emitChannelMessage(inbound('/note record moss growth'))
    await until(() => ran.count === 1)
    const last = mock.chatThreads.get('tg-telegram-999')?.messages.at(-1)
    expect(last).toMatchObject({ role: 'user', content: 'Take a note: record moss growth' })
  })

  it('/clear works offline and an undiscovered provider is rejected without an agent run', async () => {
    const cfg = config()
    cfg.providers = [] // no provider keys, no network: built-ins must still work
    const mock = createMockValleyApi({ aiConfig: cfg })
    const store = getStore(mock.api)
    await until(() => store.getSnapshot().ready)

    mock.emitChannelMessage(inbound('/model anthropic:claude-opus-4-8'))
    await until(() => sends(mock).some((t) => t.includes('Unknown model')))
    expect(mock.chatThreads.get('tg-telegram-999')?.model).toBeUndefined()

    mock.emitChannelMessage(inbound('/clear'))
    await until(() => sends(mock).some((t) => t.toLowerCase().includes('cleared')))
    expect(ran.count).toBe(0)
  })

  it('handles in-app slash-commands in send() (/model instant, custom → turn)', async () => {
    const mock = createMockValleyApi({ aiConfig: config() })
    const store = getStore(mock.api)
    await until(() => store.getSnapshot().ready)
    await mock.api.assistant.saveCommands([{ name: 'survey', prompt: 'Plan the habitat survey.' }])

    // `/model` sets the active chat's model instantly, without running the agent.
    await store.send('/model openai:gpt-5.5')
    expect(store.getSnapshot().active?.model).toEqual({ provider: 'openai', model: 'gpt-5.5' })
    expect(ran.count).toBe(0)

    // A custom command expands into a normal turn.
    await store.send('/survey')
    await until(() => ran.count === 1)
    expect(store.getSnapshot().active?.messages.at(-1)).toMatchObject({ role: 'user', content: 'Plan the habitat survey.' })
  })
})
