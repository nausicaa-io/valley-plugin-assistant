import './backendFileFixture'
// @vitest-environment node
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { promises as fs } from 'fs'
import { join, dirname } from 'path'
import { tmpdir } from 'os'

// Same reversible safeStorage stand-in the secrets suite uses, so a key really
// round-trips and the file on disk never holds plaintext.


import {
  addConnection,
  defaultConnectionId,
  listConnections,
  readProviderStatus,
  removeConnection,
  reorderConnections,
  resolveConnection,
  updateConnection
} from '../src/backend/store'
import { secretState, providerKey, setSecret } from '../src/backend/secrets'
import { providersPath } from '../src/backend/paths'

let root: string
beforeEach(async () => {
  root = await fs.mkdtemp(join(tmpdir(), 'connections-'))
})
afterEach(async () => {
  await fs.rm(root, { recursive: true, force: true })
})

/** Write a pre-connections `provider.json` — the shape shipped before this feature. */
async function seedLegacyConfig(config: Record<string, unknown>): Promise<void> {
  const file = providersPath(root)
  await fs.mkdir(dirname(file), { recursive: true })
  await fs.writeFile(file, JSON.stringify(config), 'utf8')
}

const byId = <T extends { id: string }>(list: T[], id: string): T | undefined => list.find((c) => c.id === id)

describe('ai connections', () => {
  it('seeds one default connection per provider, keyed by the provider id', async () => {
    const connections = await listConnections(root)
    // The default id being the provider id is the whole compatibility story:
    // it keeps `provider:<id>` secrets and `provider:model` refs valid.
    expect(byId(connections, 'anthropic')?.provider).toBe('anthropic')
    expect(defaultConnectionId('anthropic')).toBe('anthropic')
    for (const provider of ['anthropic', 'openai', 'gemini', 'deepseek', 'kimi', 'xai', 'ollama']) {
      expect(byId(connections, provider)).toBeDefined()
    }
  })

  it('leaves historical provider settings unchanged while creating current connections', async () => {
    await seedLegacyConfig({ baseUrls: { anthropic: 'https://gateway.example.com' } })
    const bytes = await fs.readFile(providersPath(root), 'utf8')
    expect(byId(await listConnections(root), 'anthropic')?.baseUrl).not.toBe('https://gateway.example.com')
    expect(await fs.readFile(providersPath(root), 'utf8')).toBe(bytes)
  })

  it('does not read or relocate a historical Settings provider file', async () => {
    const historical = join(root, '.valley/settings/assistant-providers.json')
    const bytes = JSON.stringify({ baseUrls: { anthropic: 'https://historical.example.com' } })
    await fs.mkdir(dirname(historical), { recursive: true })
    await fs.writeFile(historical, bytes)
    expect(byId(await listConnections(root), 'anthropic')?.baseUrl).not.toBe('https://historical.example.com')
    expect(await fs.readFile(historical, 'utf8')).toBe(bytes)
  })

  it('resolves a pre-existing provider-keyed secret with no migration', async () => {
    await setSecret(root, providerKey('anthropic'), 'sk-ant-legacy-key', [{ host: 'api.anthropic.com', port: 443, security: 'tls' }])
    const resolved = await resolveConnection(root, { provider: 'anthropic' })
    expect(resolved.connectionId).toBe('anthropic')
    expect(resolved.credentialHandle).toBe('opaque:provider:anthropic')
    expect(byId(await listConnections(root), 'anthropic')?.configured).toBe(true)
  })

  it('holds several connections for one provider, each with its own key', async () => {
    const work = await addConnection(root, { provider: 'anthropic', label: 'Work' })
    expect(work.id).not.toBe('anthropic')
    await setSecret(root, providerKey('anthropic'), 'sk-ant-personal', [{ host: 'api.anthropic.com', port: 443, security: 'tls' }])
    await setSecret(root, providerKey(work.id), 'sk-ant-work', [{ host: 'api.anthropic.com', port: 443, security: 'tls' }])

    const connections = await listConnections(root)
    const anthropic = connections.filter((c) => c.provider === 'anthropic')
    expect(anthropic).toHaveLength(2)
    expect(anthropic.every((c) => c.configured)).toBe(true)
    expect((await resolveConnection(root, { provider: 'anthropic' })).credentialHandle).toBe('opaque:provider:anthropic')
    expect((await resolveConnection(root, { provider: 'anthropic', connectionId: work.id })).credentialHandle).toBe(`opaque:provider:${work.id}`)
  })

  it('gives each connection its own base URL', async () => {
    const gateway = await addConnection(root, { provider: 'openai', label: 'Gateway' })
    await updateConnection(root, gateway.id, { baseUrl: 'https://proxy.example.com' })
    const resolved = await resolveConnection(root, { provider: 'openai', connectionId: gateway.id })
    expect(resolved.baseUrl).toBe('https://proxy.example.com')
    // The default connection keeps the provider default — they do not share state.
    const fallback = await resolveConnection(root, { provider: 'openai' })
    expect(fallback.baseUrl).not.toBe('https://proxy.example.com')
  })

  it('removing a connection deletes only its own secret', async () => {
    const work = await addConnection(root, { provider: 'anthropic', label: 'Work' })
    await setSecret(root, providerKey('anthropic'), 'sk-ant-personal', [{ host: 'api.anthropic.com', port: 443, security: 'tls' }])
    await setSecret(root, providerKey(work.id), 'sk-ant-work', [{ host: 'api.anthropic.com', port: 443, security: 'tls' }])

    await removeConnection(root, work.id)
    expect(await secretState(root, providerKey(work.id))).toBe('absent')
    expect(await secretState(root, providerKey('anthropic'))).toBe('ok')
    expect((await listConnections(root)).filter((c) => c.provider === 'anthropic')).toHaveLength(1)
  })

  it('keeps a provider’s default connection on removal, clearing it instead', async () => {
    await setSecret(root, providerKey('anthropic'), 'sk-ant-personal', [{ host: 'api.anthropic.com', port: 443, security: 'tls' }])
    await updateConnection(root, 'anthropic', { label: 'Personal', baseUrl: 'https://gateway.example.com' })

    await removeConnection(root, 'anthropic')
    const anthropic = byId(await listConnections(root), 'anthropic')
    // The default is `resolveConnection`'s fallback target, so it must survive.
    expect(anthropic).toBeDefined()
    expect(anthropic?.label).toBeUndefined()
    expect(anthropic?.baseUrl).not.toBe('https://gateway.example.com')
    expect(anthropic?.configured).toBe(false)
  })

  it('falls back to the provider default when the connection id is unknown', async () => {
    await setSecret(root, providerKey('anthropic'), 'sk-ant-personal', [{ host: 'api.anthropic.com', port: 443, security: 'tls' }])
    // A chat pinned to a since-deleted connection must keep running, not error.
    const resolved = await resolveConnection(root, { provider: 'anthropic', connectionId: 'anthropic-gone' })
    expect(resolved.connectionId).toBe('anthropic')
    expect(resolved.credentialHandle).toBe('opaque:provider:anthropic')
  })

  it('persists a user-chosen order, and listing honours it', async () => {
    const work = await addConnection(root, { provider: 'anthropic', label: 'Work' })
    const before = (await listConnections(root)).map((c) => c.id)
    // Move the new one to the front.
    await reorderConnections(root, [work.id, ...before.filter((id) => id !== work.id)])
    expect((await listConnections(root)).map((c) => c.id)[0]).toBe(work.id)
  })

  it('keeps a connection the caller omitted, rather than dropping it', async () => {
    const work = await addConnection(root, { provider: 'anthropic', label: 'Work' })
    // A stale renderer list that predates `work` must not delete it.
    await reorderConnections(root, ['openai', 'anthropic'])
    const ids = (await listConnections(root)).map((c) => c.id)
    expect(ids.slice(0, 2)).toEqual(['openai', 'anthropic'])
    expect(ids).toContain(work.id)
  })

  it('ignores an unknown id in a reorder', async () => {
    await reorderConnections(root, ['nope', 'openai'])
    const ids = (await listConnections(root)).map((c) => c.id)
    expect(ids[0]).toBe('openai')
    expect(ids).not.toContain('nope')
  })

  it('readProviderStatus stays provider-grained for existing SDK consumers', async () => {
    const work = await addConnection(root, { provider: 'anthropic', label: 'Work' })
    await setSecret(root, providerKey(work.id), 'sk-ant-work', [{ host: 'api.anthropic.com', port: 443, security: 'tls' }])
    const status = await readProviderStatus(root)
    expect(status.filter((s) => s.provider === 'anthropic')).toHaveLength(1)
    // Any configured connection makes the provider configured.
    expect(status.find((s) => s.provider === 'anthropic')?.configured).toBe(true)
    expect(JSON.stringify(status)).not.toContain('sk-ant-work')
  })

  it('never returns key material from listConnections', async () => {
    await setSecret(root, providerKey('anthropic'), 'sk-ant-supersecret-4242', [{ host: 'api.anthropic.com', port: 443, security: 'tls' }])
    expect(JSON.stringify(await listConnections(root))).not.toContain('supersecret')
  })
})
