import { afterEach, describe, expect, it, vi } from 'vitest'
import type { ChannelMessage } from '../src/types'
import type { AgentTool } from '../src/agent/tools'
import type { RunAgentOptions } from '../src/agent/loop'

/**
 * Store-level remote-channel behavior: button confirmations, `/clear`, and the
 * mid-run inbound queue (catch-up). The agent loop is replaced with a
 * test-controlled stub (`hooks.impl`) so each test drives the turn precisely.
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
async function until(pred: () => boolean, tries = 60): Promise<void> {
  for (let i = 0; i < tries && !pred(); i++) await tick()
}
const inbound = (text: string, extra: Partial<ChannelMessage> = {}): ChannelMessage => ({
  channelId: 'telegram',
  chatRef: '999',
  text,
  ts: Date.now(),
  ...extra
})
const fakeTool: AgentTool = { name: 'write_note', description: '', parameters: {}, sideEffect: 'write', run: async () => '' }
/** A minimal approval draft (the loop builds these from a tool + the resolution). */
const draft = (args: Record<string, unknown> = {}): Parameters<NonNullable<RunAgentOptions['requestApproval']>>[0] => ({
  caller: 'channel',
  target: { kind: 'tool', id: fakeTool.name, sideEffect: 'write' },
  actionLabel: fakeTool.name,
  argsPreview: args,
  canRememberApproval: false
})
const sends = (mock: ReturnType<typeof createMockValleyApi>): string[] =>
  mock.driverCalls.filter((c) => c.driver === 'channels' && c.method === 'send').map((c) => (c.payload as { text: string }).text)

describe('assistant store — channel interactions', () => {
  it('confirms a tool from a tapped button (sends inline buttons, resolves on data)', async () => {
    const mock = createMockValleyApi()
    hooks.impl = async (opts) => {
      const ok = await opts.requestApproval(draft({ path: 'x.md' }))
      opts.onMessage({ role: 'assistant', content: ok ? 'did it' : 'skipped' })
    }
    const store = getStore(mock.api)
    await until(() => Boolean(store.getSnapshot().active))

    mock.emitChannelMessage(inbound('please write a note'))
    await until(() => mock.driverCalls.some((c) => c.driver === 'channels' && c.method === 'sendButtons'))
    const prompt = mock.driverCalls.find((c) => c.method === 'sendButtons')!.payload as { buttons: { value: string }[] }
    // New protocol: callback_data = "<action>:<requestId>" (C9), under 64 bytes.
    const allow = prompt.buttons.find((b) => b.value.startsWith('allow:'))!.value
    expect(allow).toMatch(/^allow:\S+$/)
    expect(prompt.buttons.every((b) => b.value.length <= 64)).toBe(true)

    mock.emitChannelMessage(inbound('', { data: allow }))
    await until(() => sends(mock).includes('did it'))
    expect(sends(mock)).toContain('did it')
  })

  it('confirms a WhatsApp tool from an interactive reply button', async () => {
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
    hooks.impl = async (opts) => {
      const ok = await opts.requestApproval(draft({ path: 'x.md' }))
      opts.onMessage({ role: 'assistant', content: ok ? 'did it' : 'skipped' })
    }
    const store = getStore(mock.api)
    await until(() => Boolean(store.getSnapshot().active))

    mock.emitChannelMessage(inbound('please write a note', { channelId: 'whatsapp-1', chatRef: '15550100001' }))
    await until(() => mock.driverCalls.some((c) => c.driver === 'channels' && c.method === 'sendButtons'))
    const prompt = mock.driverCalls.find((c) => c.method === 'sendButtons')!.payload as {
      channelId: string
      chatRef: string
      buttons: { value: string }[]
    }
    expect(prompt).toMatchObject({ channelId: 'whatsapp-1', chatRef: '15550100001' })
    const allow = prompt.buttons.find((b) => b.value.startsWith('allow:'))!.value

    mock.emitChannelMessage(inbound('', { channelId: 'whatsapp-1', chatRef: '15550100001', data: allow }))
    await until(() => sends(mock).includes('did it'))
    expect(mock.chatThreads.get('wa-whatsapp-1-15550100001')?.source).toBe('whatsapp')
    expect(sends(mock)).toContain('did it')
  })

  it('confirms from a typed YES and declines anything else', async () => {
    const mock = createMockValleyApi()
    hooks.impl = async (opts) => {
      const ok = await opts.requestApproval(draft())
      opts.onMessage({ role: 'assistant', content: ok ? 'did it' : 'skipped' })
    }
    const store = getStore(mock.api)
    await until(() => Boolean(store.getSnapshot().active))

    mock.emitChannelMessage(inbound('do the thing'))
    await until(() => mock.driverCalls.some((c) => c.method === 'sendButtons'))
    mock.emitChannelMessage(inbound('nope'))
    await until(() => sends(mock).includes('skipped'))
    expect(sends(mock)).toContain('skipped')
  })

  it('/clear wipes the chat thread (keeping memory) and confirms', async () => {
    const mock = createMockValleyApi()
    const store = getStore(mock.api)
    await until(() => Boolean(store.getSnapshot().active))

    mock.emitChannelMessage(inbound('hello'))
    await until(() => mock.chatThreads.has('tg-telegram-999'))

    mock.emitChannelMessage(inbound('/clear'))
    await until(() => sends(mock).some((t) => t.toLowerCase().includes('cleared')))
    // /clear resets the active context via clearChat — NOT deleteChat — so the
    // chat's long-term memory.jsonl survives the reset (C12/§6.2).
    expect(mock.driverCalls.some((c) => c.driver === 'ai' && c.method === 'clearChat')).toBe(true)
    expect(mock.driverCalls.some((c) => c.driver === 'ai' && c.method === 'deleteChat')).toBe(false)
    expect(mock.chatThreads.has('tg-telegram-999')).toBe(false)
  })

  it('/clear works for a WhatsApp mirror thread', async () => {
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

    mock.emitChannelMessage(inbound('hello', { channelId: 'whatsapp-1', chatRef: '15550100001' }))
    await until(() => mock.chatThreads.has('wa-whatsapp-1-15550100001'))

    mock.emitChannelMessage(inbound('/clear', { channelId: 'whatsapp-1', chatRef: '15550100001' }))
    await until(() => sends(mock).some((t) => t.toLowerCase().includes('cleared')))
    expect(mock.driverCalls.some((c) => c.driver === 'ai' && c.method === 'clearChat' && (c.payload as { id: string }).id === 'wa-whatsapp-1-15550100001')).toBe(true)
    expect(mock.chatThreads.has('wa-whatsapp-1-15550100001')).toBe(false)
  })

  it('queues a message received mid-run and processes it in order, sharing history', async () => {
    const mock = createMockValleyApi()
    const gate: { release?: () => void } = {}
    const seenCounts: number[] = []
    hooks.impl = async (opts) => {
      seenCounts.push(opts.messages.length)
      await new Promise<void>((r) => {
        gate.release = r
      })
      opts.onMessage({ role: 'assistant', content: `reply ${seenCounts.length}` })
    }
    const store = getStore(mock.api)
    await until(() => Boolean(store.getSnapshot().active))

    mock.emitChannelMessage(inbound('first'))
    await until(() => store.getSnapshot().busy && Boolean(gate.release))

    // Second arrives while busy: queued, never dropped (no "Still working" reply).
    mock.emitChannelMessage(inbound('second'))
    await tick()
    expect(sends(mock).some((t) => t.includes('Still working'))).toBe(false)

    const releaseFirst = gate.release!
    gate.release = undefined
    releaseFirst()
    await until(() => Boolean(gate.release)) // the queued second run started
    gate.release!()
    await until(() => mock.driverCalls.filter((c) => c.driver === 'channels' && c.method === 'send').length >= 2)

    expect(seenCounts[0]).toBe(1) // first run: just the new user message
    expect(seenCounts[1]).toBe(3) // second run sees the first exchange + new user message
    const saved = mock.chatThreads.get('tg-telegram-999')
    expect(saved?.messages.map((m) => m.role)).toEqual(['user', 'assistant', 'user', 'assistant'])
  })
})

describe('assistant store — quiz answer buttons', () => {
  const choices = [
    { value: 'A', label: 'A' },
    { value: 'B', label: 'B' }
  ]

  it('a native tap sends the choice as a user turn with the question image attached', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => ({ ok: true, arrayBuffer: async () => new Uint8Array([1, 2, 3]).buffer }))
    )
    const mock = createMockValleyApi()
    const store = getStore(mock.api)
    await until(() => Boolean(store.getSnapshot().active))

    // First turn arms the quiz prompt (the quiz_next tool would do this via inApp).
    hooks.impl = async (opts) => {
      opts.inApp?.postImage('q.jpg')
      opts.inApp?.setQuiz('src.jsonl', choices, 'q.jpg')
      opts.onMessage({ role: 'assistant', content: 'Frage 1 …' })
    }
    await store.send('start the quiz')
    await until(() => Boolean(store.getSnapshot().active?.quiz))
    expect(store.getSnapshot().active?.quiz?.choices.map((c) => c.value)).toEqual(['A', 'B'])

    // Tapping a button answers: a new 'A' user turn, with the image attached for grading.
    let answered: { content: string; hasImage: boolean } | null = null
    hooks.impl = async (opts) => {
      const last = opts.messages[opts.messages.length - 1]
      answered = { content: last.content, hasImage: Boolean(last.attachments?.length) }
      opts.onMessage({ role: 'assistant', content: 'Richtig!' })
    }
    await store.answerQuiz('A')
    await until(() => answered != null)
    expect(answered).toEqual({ content: 'A', hasImage: true })
    // The prompt is consumed by the turn.
    expect(store.getSnapshot().active?.quiz).toBeNull()
    vi.unstubAllGlobals()
  })

  it('a tap in the telegram mirror runs a channel turn and routes the reply back to Telegram', async () => {
    const mock = createMockValleyApi()
    const store = getStore(mock.api)
    await until(() => Boolean(store.getSnapshot().active))

    // Create the telegram mirror thread, then view it (make it active).
    mock.emitChannelMessage(inbound('hi'))
    await until(() => mock.chatThreads.has('tg-telegram-999'))
    await store.openChat('tg-telegram-999')

    // Arm the quiz on the now-active mirror thread via a channel turn.
    hooks.impl = async (opts) => {
      opts.inApp?.setQuiz('src.jsonl', choices, 'q.jpg')
      opts.onMessage({ role: 'assistant', content: 'Frage …' })
    }
    mock.emitChannelMessage(inbound('next question'))
    await until(() => Boolean(store.getSnapshot().active?.quiz))

    // Tap a button in the mirror → the bot's grading reply reaches Telegram.
    hooks.impl = async (opts) => {
      expect(opts.channel).toMatchObject({ channelId: 'telegram', chatRef: '999' })
      opts.onMessage({ role: 'assistant', content: 'Falsch.' })
    }
    await store.answerQuiz('B')
    await until(() => sends(mock).includes('Falsch.'))
    expect(sends(mock)).toContain('Falsch.')
  })
})
