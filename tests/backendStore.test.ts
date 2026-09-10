import './backendFileFixture'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { promises as fs } from 'fs'
import { join } from 'path'
import { tmpdir } from 'os'
import type { AiChatThread } from '../src/types'



import {
  deleteChat,
  ensureScaffold,
  listChats,
  listPersonalities,
  normalizeCommands,
  readChat,
  readCommands,
  readConfig,
  saveChat,
  saveCommands,
  savePersonality
} from '../src/backend/store'

let root: string
beforeEach(async () => {
  root = await fs.mkdtemp(join(tmpdir(), 'assistant-store-'))
  vi.stubGlobal(
    'fetch',
    vi.fn(async () => {
      throw new Error('network disabled in tests')
    })
  )
})
afterEach(async () => {
  vi.unstubAllGlobals()
  await fs.rm(root, { recursive: true, force: true })
})

describe('assistant store', () => {
  it('scaffolds private runtime defaults without seeding a personality', async () => {
    await ensureScaffold(root)
    const dir = join(root, '.valley', 'assistant')
    expect(await fs.readFile(join(dir, 'README.md'), 'utf8')).toContain('.valley/assistant')
    expect(await fs.readFile(join(dir, 'rules', 'tone.md'), 'utf8')).toContain('Be concise and direct')
    await expect(fs.access(join(root, 'Meadow', 'Chorus', 'Personalities', 'default'))).rejects.toThrow()
  })

  it('readConfig reports provider status without leaking keys (Ollama needs none)', async () => {
    const cfg = await readConfig(root)
    expect(cfg.instructions.length).toBeGreaterThan(0)
    expect(cfg.providers.find((p) => p.provider === 'ollama')?.configured).toBe(true)
    expect(cfg.providers.find((p) => p.provider === 'anthropic')?.configured).toBe(false)
    // No secret values are ever present on the status object.
    expect(JSON.stringify(cfg.providers)).not.toContain('sk-')
  })

  it('readConfig reports live Ollama models for the chat selector', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => ({
        ok: true,
        json: async () => ({
          models: [{ name: 'qwen3.5:4b' }, { model: 'llama3.2:3b' }]
        })
      }))
    )

    const cfg = await readConfig(root)
    const ollama = cfg.providers.find((p) => p.provider === 'ollama')
    expect(ollama?.models.map((m) => m.id)).toEqual(['qwen3.5:4b', 'llama3.2:3b'])
  })

  it('round-trips chat threads (save → list → read → delete)', async () => {
    const thread: AiChatThread = {
      id: 'chat-1',
      title: 'Greeting',
      createdAt: 1,
      updatedAt: 2,
      model: null,
      messages: [
        { role: 'user', content: 'hello' },
        { role: 'assistant', content: 'hi there' }
      ]
    }
    await saveChat(root, thread)
    expect(await listChats(root)).toContainEqual({ id: 'chat-1', title: 'Greeting', updatedAt: 2 })
    const read = await readChat(root, 'chat-1')
    expect(read?.messages).toHaveLength(2)
    expect(read?.messages[1]).toMatchObject({ role: 'assistant', content: 'hi there' })
    await deleteChat(root, 'chat-1')
    expect(await readChat(root, 'chat-1')).toBeNull()
  })

  it('refuses an unsafe chat id', async () => {
    await expect(saveChat(root, { id: '../escape', title: 'x', createdAt: 1, updatedAt: 1, messages: [] })).rejects.toThrow()
  })

  it('normalizeCommands slugifies, drops invalid/duplicate, and strips leading slashes', () => {
    const out = normalizeCommands([
      { name: 'Stand Up', prompt: 'do standup' }, // name is not a slug → dropped (no auto-slug here; renderer slugifies)
      { name: '/brief', prompt: 'morning brief' }, // leading slash stripped
      { name: 'brief', prompt: 'second brief' }, // duplicate name → dropped
      { name: 'empty', prompt: '   ' }, // empty prompt → dropped
      { name: 'ok', prompt: 'fine', description: '  a note  ' },
      'garbage',
      null
    ])
    expect(out).toEqual([
      { name: 'brief', prompt: 'morning brief' },
      { name: 'ok', prompt: 'fine', description: 'a note' }
    ])
  })

  it('round-trips overall custom commands (Meadow/Chorus/commands.json)', async () => {
    expect(await readCommands(root)).toEqual([])
    await saveCommands(root, [{ name: 'fieldlog', prompt: 'Summarize the habitat survey.', description: 'daily' }])
    expect(await readCommands(root)).toEqual([{ name: 'fieldlog', prompt: 'Summarize the habitat survey.', description: 'daily' }])
    // The file is legible JSON at the documented path.
    const onDisk = JSON.parse(await fs.readFile(join(root, 'Meadow', 'Chorus', 'commands.json'), 'utf8'))
    expect(onDisk[0].name).toBe('fieldlog')
  })

  it('persists per-chat custom commands on the thread (settings.json)', async () => {
    const thread: AiChatThread = {
      id: 'chat-cmd',
      title: 'With commands',
      createdAt: 1,
      updatedAt: 2,
      model: null,
      messages: [{ role: 'user', content: 'hi' }],
      commands: [{ name: 'recap', prompt: 'Recap this chat.' }]
    }
    await saveChat(root, thread)
    const read = await readChat(root, 'chat-cmd')
    expect(read?.commands).toEqual([{ name: 'recap', prompt: 'Recap this chat.' }])
    // The summary surfaces the chat-scoped commands too.
    const summary = (await listChats(root)).find((c) => c.id === 'chat-cmd')
    expect(summary?.commands).toEqual([{ name: 'recap', prompt: 'Recap this chat.' }])
  })

  it('exposes a saved personality\'s instructions/routing as vault-relative paths', async () => {
    const cfg = await readConfig(root)
    await savePersonality(root, {
      id: 'default',
      name: 'Default',
      isDefault: true,
      instructions: cfg.instructions,
      routing: cfg.routing
    })
    const [def] = await listPersonalities(root)
    expect(def.id).toBe('default')
    expect(def.instructionsPath).toBe('Meadow/Chorus/Personalities/default/instructions.md')
    expect(def.routingPath).toBe('Meadow/Chorus/Personalities/default/routing.json')
  })

  it('persists telegram-sourced thread metadata through save → list → read', async () => {
    const thread: AiChatThread = {
      id: 'tg-telegram-test-chat-1001',
      title: 'Telegram · Fern',
      createdAt: 1,
      updatedAt: 2,
      model: null,
      messages: [{ role: 'user', content: 'hi from telegram' }],
      source: 'telegram',
      channelId: 'telegram',
      chatRef: 'test-chat-1001',
      channelName: 'Field bot'
    }
    await saveChat(root, thread)
    // The conversation list carries the source + connection name for sidebar grouping.
    expect(await listChats(root)).toContainEqual({
      id: 'tg-telegram-test-chat-1001',
      title: 'Telegram · Fern',
      updatedAt: 2,
      source: 'telegram',
      channelId: 'telegram',
      channelName: 'Field bot'
    })
    const read = await readChat(root, 'tg-telegram-test-chat-1001')
    expect(read).toMatchObject({ source: 'telegram', channelId: 'telegram', chatRef: 'test-chat-1001', channelName: 'Field bot' })
  })
})
