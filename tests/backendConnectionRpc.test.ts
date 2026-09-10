import './backendFileFixture'
// @vitest-environment node
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { promises as fs } from 'fs'
import { join } from 'path'
import { tmpdir } from 'os'

// Reversible safeStorage stand-in so a key really round-trips through the driver.


import { aiDriver } from '../src/backend/aiRpc'
import type { AiConnectionStatus } from '../src/types'

/**
 * The connection methods as the renderer actually reaches them: through the
 * driver's zod schemas. The store suite covers the behaviour — this covers the
 * IPC surface, where a wrong schema is invisible to a direct-call test.
 */
let root: string
beforeEach(async () => {
  root = await fs.mkdtemp(join(tmpdir(), 'aiconndrv-'))
})
afterEach(async () => {
  await fs.rm(root, { recursive: true, force: true })
})

/** Validate through the method's schema exactly as the IPC layer does, then run. */
async function call<T>(method: string, payload: unknown = {}): Promise<T> {
  const entry = aiDriver[method as keyof typeof aiDriver]
  if (!entry) throw new Error(`no such ai method: ${method}`)
  const parsed = entry.schema ? entry.schema.parse(payload) : payload
  return (await entry.run(root, parsed)) as T
}

const list = (): Promise<{ connections: AiConnectionStatus[] }> => call('listConnections')

describe('ai driver — connections', () => {
  it('adds, labels and lists a second connection for one provider', async () => {
    const { connection } = await call<{ connection: { id: string } }>('addConnection', {
      provider: 'anthropic',
      label: 'Work'
    })
    await call('updateConnection', { connectionId: connection.id, label: 'Work laptop' })

    const { connections } = await list()
    const anthropic = connections.filter((c) => c.provider === 'anthropic')
    expect(anthropic).toHaveLength(2)
    expect(anthropic.find((c) => c.id === connection.id)?.label).toBe('Work laptop')
  })

  it('stores a key against the connection and reports it without returning it', async () => {
    const { connection } = await call<{ connection: { id: string } }>('addConnection', { provider: 'anthropic' })
    await call('setConnectionKey', { connectionId: connection.id, key: 'sk-ant-supersecret-77' })

    const { connections } = await list()
    const target = connections.find((c) => c.id === connection.id)!
    expect(target.configured).toBe(true)
    expect(target.authMode).toBe('key')
    expect(JSON.stringify(connections)).not.toContain('supersecret')
  })

  it('clears a key with an empty string', async () => {
    await call('setConnectionKey', { connectionId: 'anthropic', key: 'sk-ant-temp' })
    await call('setConnectionKey', { connectionId: 'anthropic', key: '' })
    const { connections } = await list()
    expect(connections.find((c) => c.id === 'anthropic')?.configured).toBe(false)
  })

  it('setKey still targets the provider’s default connection (legacy SDK callers)', async () => {
    await call('setKey', { provider: 'anthropic', key: 'sk-ant-legacy' })
    const { connections } = await list()
    expect(connections.find((c) => c.id === 'anthropic')?.configured).toBe(true)
  })

  it('setBaseUrl still targets the provider’s default connection', async () => {
    await call('setBaseUrl', { provider: 'openai', baseUrl: 'https://proxy.example.com' })
    const { connections } = await list()
    expect(connections.find((c) => c.id === 'openai')?.baseUrl).toBe('https://proxy.example.com')
  })

  it('rejects a connection id that could escape its secret/cache namespace', async () => {
    for (const bad of ['../escape', 'has space', 'UPPER', '', 'a'.repeat(100)]) {
      expect(() => aiDriver.setConnectionKey.schema!.parse({ connectionId: bad, key: 'x' })).toThrow()
    }
  })

  it('removes a connection and keeps the provider’s default', async () => {
    const { connection } = await call<{ connection: { id: string } }>('addConnection', { provider: 'anthropic' })
    await call('removeConnection', { connectionId: connection.id })
    const { connections } = await list()
    expect(connections.find((c) => c.id === connection.id)).toBeUndefined()
    expect(connections.find((c) => c.id === 'anthropic')).toBeDefined()
  })

  it('accepts a chat request that names a connection, and one that does not', async () => {
    const base = { requestId: 'r1', provider: 'anthropic', model: 'claude-opus-4-8', messages: [] }
    expect(() => aiDriver.chat.schema!.parse(base)).not.toThrow()
    expect(() => aiDriver.chat.schema!.parse({ ...base, connectionId: 'anthropic-2' })).not.toThrow()
    expect(() => aiDriver.chat.schema!.parse({ ...base, connectionId: '../nope' })).toThrow()
  })

  it('providerStatus stays one row per provider however many connections exist', async () => {
    await call('addConnection', { provider: 'anthropic', label: 'Work' })
    const { providers } = await call<{ providers: { provider: string }[] }>('providerStatus')
    expect(providers.filter((p) => p.provider === 'anthropic')).toHaveLength(1)
  })
})
