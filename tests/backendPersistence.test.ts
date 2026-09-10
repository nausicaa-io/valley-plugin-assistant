// @vitest-environment node
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { PluginCredentialApi } from '@valley/plugin-sdk/pluginNetwork'
import type { PluginBackendApi } from '@valley/plugin-sdk'
import { initBackend } from '../src/backend/runtime'
import { releaseFileAccess, readFile, writeFile, storageLocation } from '../src/backend/filesystem'
import { readChat, saveChat, appendMemory, readMemory } from '../src/backend/store'
import { getCredential, providerKey, setSecret } from '../src/backend/secrets'
import { recordUsage, readUsage } from '../src/backend/usage'
vi.mock('../src/backend/providers', () => ({ ensureProviderPackages: async () => {}, listAiProviders: () => [], getAiProvider: () => undefined }))
const files = new Map<string, Uint8Array>()
const grants = new Map<string, string>()
let ledger: Uint8Array | null = null
let writing: Uint8Array[] = []
let readOffset = 0
const encoder = new TextEncoder(), decoder = new TextDecoder()
const locate = (location: { handle: string; path: string }) => `${grants.get(location.handle)}/${location.path}`.replace(/\/$/, '')
const credentials = { state: vi.fn<PluginCredentialApi['state']>(async () => 'ok'), handle: vi.fn<PluginCredentialApi['handle']>(async () => 'opaque-handle'), set: vi.fn<PluginCredentialApi['set']>(), delete: vi.fn<PluginCredentialApi['delete']>() }
const api: { storage: Pick<PluginBackendApi['storage'], 'open'|'close'|'stat'|'readBytes'|'write'|'writeBytes'|'mkdir'|'move'|'remove'|'list'>; credentials: typeof credentials; sealed: Pick<PluginBackendApi['sealed'], 'openRead'|'readChunk'|'beginWrite'|'writeChunk'|'commitWrite'|'close'> } = {
  storage: {
    open: vi.fn<PluginBackendApi['storage']['open']>(async ({ area, path }) => { const handle = crypto.randomUUID(); grants.set(handle, area === 'metadata' ? `.valley/${path}` : path); return { handle, path, kind: 'directory', mode: 'write' } }),
    close: async (handle: string) => { grants.delete(handle) },
    stat: async (location) => { const path = locate(location), value = files.get(path); return value ? { name: path.split('/').at(-1) ?? '', kind: 'file', size: value.length, mtimeMs: 1 } : null },
    readBytes: async (location, { offset = 0, maxBytes = 1024 } = {}) => { const value = files.get(locate(location)); if (!value) throw new Error('missing'); const bytes = value.subarray(offset, offset + maxBytes); return { base64: Buffer.from(bytes).toString('base64'), nextOffset: offset + bytes.length, done: offset + bytes.length >= value.length } },
    write: async (location, text, append) => { const path = locate(location), previous = append ? files.get(path) ?? new Uint8Array() : new Uint8Array(); const value = encoder.encode(text), next = new Uint8Array(previous.length + value.length); next.set(previous); next.set(value, previous.length); files.set(path, next) },
    writeBytes: async (location, base64, append) => { const path = locate(location), previous = append ? files.get(path) ?? new Uint8Array() : new Uint8Array(); const value = Buffer.from(base64, 'base64'), next = new Uint8Array(previous.length + value.length); next.set(previous); next.set(value, previous.length); files.set(path, next) },
    mkdir: async () => {},
    move: async (from, to) => { const value = files.get(locate(from)); if (!value) throw new Error('missing'); files.set(locate(to), value); files.delete(locate(from)) },
    remove: async (location) => { files.delete(locate(location)) },
    list: async (location) => { const prefix = locate(location) + '/'; return [...new Set([...files.keys()].filter((path) => path.startsWith(prefix)).map((path) => path.slice(prefix.length).split('/')[0]))].map((name) => ({ name, kind: files.has(prefix + name) ? 'file' : 'directory', size: 0, mtimeMs: 1 })) }
  },
  credentials,
  sealed: {
    openRead: async () => { readOffset = 0; return ledger ? { handle: 'read', bytes: ledger.length } : null },
    readChunk: async (_handle, maximum) => { const bytes = ledger!.subarray(readOffset, readOffset + Math.min(maximum ?? 1024, 7)); readOffset += bytes.length; return { base64: Buffer.from(bytes).toString('base64'), done: readOffset >= ledger!.length } },
    beginWrite: async () => { writing = []; return 'write' },
    writeChunk: async (_handle, base64) => { writing.push(Buffer.from(base64, 'base64')) },
    commitWrite: async () => { ledger = Buffer.concat(writing) }, close: async () => {}
  }
}
beforeEach(() => { files.clear(); grants.clear(); ledger = null; vi.clearAllMocks(); initBackend(api as unknown as PluginBackendApi) })
afterEach(async () => { await releaseFileAccess() })
describe('Assistant package persistence', () => {
  it('reads existing chats and appends only new messages at the same saved paths', async () => {
    const directory = 'Meadow/Chorus/Chats/old'
    files.set(`${directory}/settings.json`, encoder.encode(JSON.stringify({ id: 'old', title: 'Blüten', createdAt: 1, updatedAt: 2 })))
    const initial = JSON.stringify({ role: 'user', content: 'Grüsse ä ö ü ß' }) + '\n'
    files.set(`${directory}/thread.jsonl`, encoder.encode(initial))
    const thread = await readChat('/vault', 'old')
    expect(thread?.messages[0].content).toBe('Grüsse ä ö ü ß')
    thread!.messages.push({ role: 'assistant', content: 'Antwort' })
    await saveChat('/vault', thread!)
    expect(decoder.decode(files.get(`${directory}/thread.jsonl`))).toBe(initial + JSON.stringify(thread!.messages[1]) + '\n')
    await appendMemory('/vault', thread!, { id: 'one', summary: 'Blüten erinnern', createdAt: 3 })
    expect((await readMemory('/vault', 'old'))[0].summary).toBe('Blüten erinnern')
    expect([...files.keys()].some((path) => path.includes('plugins/assistant'))).toBe(false)
  })
  it('preserves Unicode across text chunks and arbitrary binary attachment bytes', async () => {
    const text = 'a'.repeat(256 * 1024 - 1) + '🪷 ä ö ü ß'
    await writeFile('/vault/.valley/assistant/large.txt', text)
    expect(await readFile('/vault/.valley/assistant/large.txt')).toBe(text)
    const binary = Uint8Array.from([0, 255, 128, 42])
    await writeFile('/vault/Meadow/Chorus/attachment.bin', binary)
    expect(files.get('Meadow/Chorus/attachment.bin')).toEqual(binary)
    await expect(storageLocation('/vault/unapproved/secret')).rejects.toThrow('no storage binding')
  })
  it('keeps legacy encrypted credential paths in the broker and returns only opaque handles', async () => {
    const endpoint = { host: 'api.example.test', port: 443, security: 'tls' as const }
    const key = providerKey('custom')
    expect(await getCredential('/vault', key, [endpoint])).toBe('opaque-handle')
    const source = credentials.handle.mock.calls[0][1]!
    expect(('location' in source.store ? source.store.location.path : '')).toBe('provider-secrets.json')
    expect(source.endpoints).toEqual([endpoint])
    await setSecret('/vault', key, 'new-key', [endpoint])
    expect(credentials.set).toHaveBeenCalledWith(key, 'new-key', [endpoint], expect.objectContaining({ location: expect.objectContaining({ path: 'provider-secrets.json' }) }))
    expect(files.size).toBe(0)
  })
  it('serializes simultaneous metering and decodes the existing sealed ledger through bounded chunks', async () => {
    ledger = encoder.encode(JSON.stringify({ entries: [], budget: { monthlyUsd: 20 } }))
    await Promise.all(Array.from({ length: 8 }, (_, index) => recordUsage({ provider: 'openai', model: `model-${index}`, inputTokens: 10, outputTokens: 5, origin: 'ui' })))
    const usage = await readUsage()
    expect(usage.allTime.calls).toBe(8)
    expect(usage.allTime.inputTokens).toBe(80)
    expect(usage.budget).toEqual({ monthlyUsd: 20 })
  })
})
