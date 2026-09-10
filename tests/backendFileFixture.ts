import { beforeEach, vi } from 'vitest'
import type { PluginBackendApi } from '@valley/plugin-sdk'
import { initBackend } from '../src/backend/runtime'

vi.mock('../src/backend/filesystem', async (original) => {
  const actual = await original<typeof import('../src/backend/filesystem')>()
  const fs = await import('node:fs/promises')
  const path = await import('node:path')
  return {
    ...actual, ...fs,
    storageLocation: async (file: string) => ({ handle: 'fixture-storage', path: file }),
    atomicWriteFile: async (file: string, content: string) => {
      await fs.mkdir(path.dirname(file), { recursive: true })
      const temporary = `${file}.${crypto.randomUUID()}.tmp`
      await fs.writeFile(temporary, content)
      await fs.rename(temporary, file)
    }
  }
})

vi.mock('../src/backend/channels/network', () => ({ telegramFetch: (...args: Parameters<typeof fetch>) => fetch(...args), uploadFile: vi.fn() }))

vi.mock('../src/backend/providers/network', () => ({ brokerFetch: (...args: Parameters<typeof fetch>) => fetch(...args) }))

beforeEach(() => {
  const credentials = new Set<string>()
  initBackend({
    accounts: { list: async () => [] },
    credentials: { state: async (key: string) => credentials.has(key) ? 'ok' : 'absent', set: async (key: string, value: string) => { if (value) credentials.add(key); else credentials.delete(key) }, delete: async (key: string) => { credentials.delete(key) }, handle: async (key: string) => credentials.has(key) ? `opaque:${key}` : null },
    rpc: { emit: vi.fn() }
  } as unknown as PluginBackendApi)
})
