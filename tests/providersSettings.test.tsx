import * as React from 'react'
import { createMockValleyApi } from './mock'
import { initRuntime } from '../src/runtime'
import { initLocalization } from '../src/localization'
import { useReorderDrag } from '@valley/plugin-sdk/sandboxUi'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import type { AiConnectionStatus, AiProviderId } from '../src/types'
import type { UiMenuItem as MenuItem } from '@valley/plugin-sdk'

/**
 * Settings → AI Providers lists *connections*, not providers. These pin the
 * three things the old one-card-per-provider shape could not do: several
 * connections on one provider, a per-connection detail behind the chevron, and
 * a key saved against that connection's own id rather than the provider's.
 */
const openMenu = vi.hoisted(() => vi.fn<(items: MenuItem[], target: unknown) => Promise<string | null>>())


import { AiProvidersSection } from '../src/ProvidersSettings'

const providerNames: Record<string, string> = {
  anthropic: 'Anthropic (Claude)', openai: 'OpenAI', gemini: 'Google Gemini', deepseek: 'DeepSeek',
  kimi: 'Kimi (Moonshot)', xai: 'xAI (Grok)', ollama: 'Ollama (local)'
}

const connection = (over: Partial<AiConnectionStatus> & { id: string }): AiConnectionStatus => {
  const provider = over.provider ?? 'anthropic'
  return {
  provider: provider as AiProviderId,
  providerName: providerNames[provider] ?? provider,
  providerDescription: `${providerNames[provider] ?? provider} models`,
  providerIcon: provider,
  requiresKey: provider !== 'ollama',
  providerCapabilities: provider === 'ollama' ? ['chat', 'status'] : ['chat'],
  configured: true,
  authMode: 'key',
  authSources: { savedKey: true },
  baseUrl: 'https://api.anthropic.com',
  models: [{ provider: 'anthropic', id: 'claude-opus-4-8' }],
  createdAt: 1,
  ...over
  }
}

const invokeDriver = vi.fn<(namespace: string, method: string, payload: unknown) => Promise<{ ok: boolean; data?: unknown }>>()

/** Answer `listConnections` with `connections`; every other method resolves ok. */
const mount = async (connections: AiConnectionStatus[]): Promise<void> => {
  invokeDriver.mockImplementation(async (_driver, method) =>
    method === 'listConnections' ? { ok: true, data: { connections } } : { ok: true, data: {} }
  )
  render(<AiProvidersSection />)
  await waitFor(() => expect(invokeDriver).toHaveBeenCalledWith('ai', 'listConnections', {}))
}

beforeEach(() => {
  invokeDriver.mockReset()
  openMenu.mockReset()
  const mock = createMockValleyApi()
  mock.api.ui.openMenu = openMenu
  mock.api.ui.settings.useReorderDrag = useReorderDrag
  mock.api.backend.call = async (qualified, payload) => {
    const [namespace, method] = qualified.split('.')
    const result = await invokeDriver(namespace, method, payload)
    if (!result.ok) throw new Error('Request failed')
    return result.data as never
  }
  initRuntime(mock.api)
  initLocalization(mock.api)
})

afterEach(() => {
  vi.clearAllMocks()
})

describe('Settings → AI Providers', () => {
  it('lists two connections on the same provider side by side', async () => {
    await mount([
      connection({ id: 'anthropic', label: 'Personal' }),
      connection({ id: 'anthropic-2', label: 'Work' })
    ])
    await screen.findByText('Personal')
    expect(screen.getByText('Work')).toBeTruthy()
    // Both rows show their own state, rather than collapsing to one provider tile.
    expect(screen.getAllByText('connected')).toHaveLength(2)
  })

  it('falls back to the provider name for an unlabelled connection', async () => {
    await mount([connection({ id: 'anthropic' })])
    expect(await screen.findByText('Anthropic')).toBeTruthy()
  })

  it('reports each connection’s own credential state', async () => {
    await mount([
      connection({ id: 'anthropic', label: 'Personal' }),
      connection({
        id: 'anthropic-2',
        label: 'Work',
        configured: false,
        authMode: 'none',
        authSources: { savedKey: false }
      })
    ])
    await screen.findByText('Personal')
    expect(screen.getByText('connected')).toBeTruthy()
    expect(screen.getByText('no credential')).toBeTruthy()
  })

  it('surfaces an undecryptable key as its own state, not as "connected"', async () => {
    await mount([
      connection({
        id: 'anthropic',
        label: 'Personal',
        configured: false,
        authSources: { savedKey: true, savedKeyUnreadable: true }
      })
    ])
    expect(await screen.findByText('key unreadable')).toBeTruthy()
  })

  it('adds a connection through the provider menu and opens its detail', async () => {
    invokeDriver.mockImplementation(async (_driver, method) => {
      if (method === 'listConnections') {
        return { ok: true, data: { connections: [
          connection({ id: 'anthropic' }),
          connection({ id: 'openai', provider: 'openai' }),
          connection({ id: 'gemini', provider: 'gemini' }),
          connection({ id: 'deepseek', provider: 'deepseek' }),
          connection({ id: 'kimi', provider: 'kimi' }),
          connection({ id: 'xai', provider: 'xai' }),
          connection({ id: 'ollama', provider: 'ollama', configured: true })
        ] } }
      }
      if (method === 'addConnection') return { ok: true, data: { connection: { id: 'anthropic-2' } } }
      return { ok: true, data: {} }
    })
    openMenu.mockResolvedValue('anthropic')
    render(<AiProvidersSection />)

    const add = await screen.findByRole('button', { name: 'Add a provider connection' })
    fireEvent.click(add)

    await waitFor(() => expect(openMenu).toHaveBeenCalled())
    // The menu offers every provider, not just the unconfigured ones.
    expect(openMenu.mock.calls[0][0].map((item) => item.id)).toEqual([
      'anthropic',
      'openai',
      'gemini',
      'deepseek',
      'kimi',
      'xai',
      'ollama'
    ])
    await waitFor(() =>
      expect(invokeDriver).toHaveBeenCalledWith('ai', 'addConnection', { provider: 'anthropic' })
    )
  })

  it('saves a key against the connection id, never the provider id', async () => {
    await mount([connection({ id: 'anthropic-2', label: 'Work', configured: false, authSources: {} })])
    fireEvent.click(await screen.findByText('Work'))

    const field = await screen.findByLabelText('API key')
    fireEvent.change(field, { target: { value: 'sk-ant-work' } })
    // The key's Save and the base URL's Save must not share an accessible name.
    fireEvent.click(screen.getByRole('button', { name: 'Save API key' }))

    await waitFor(() =>
      expect(invokeDriver).toHaveBeenCalledWith('ai', 'setConnectionKey', {
        connectionId: 'anthropic-2',
        key: 'sk-ant-work'
      })
    )
  })

  it('pastes the key into a settings row, and comes back by the breadcrumb', async () => {
    await mount([connection({ id: 'anthropic-2', label: 'Work' })])
    fireEvent.click(await screen.findByText('Work'))

    // A labelled settings row like every other one — never a boxed card.
    const keyRow = (await screen.findByLabelText('API key')).closest('.settings-path-row')
    expect(keyRow).toBeTruthy()
    expect(keyRow?.querySelector('.settings-toggle-title')?.textContent).toBe('API key')
    fireEvent.click(screen.getByRole('button', { name: 'Back to AI Providers' }))
    await waitFor(() => expect(document.querySelectorAll('.settings-list-row')).toHaveLength(1))
  })

  it('tests a connection against its own id and base URL', async () => {
    await mount([connection({ id: 'anthropic-2', label: 'Work', baseUrl: 'https://proxy.example.com' })])
    fireEvent.click(await screen.findByText('Work'))
    fireEvent.click(screen.getByRole('button', { name: 'Test connection' }))

    await waitFor(() =>
      expect(invokeDriver).toHaveBeenCalledWith('ai', 'listModels', {
        provider: 'anthropic',
        connectionId: 'anthropic-2',
        baseUrl: 'https://proxy.example.com',
        noCache: true,
        strict: true
      })
    )
  })

  it('persists a new connection order when a row is moved', async () => {
    await mount([
      connection({ id: 'anthropic', label: 'Personal' }),
      connection({ id: 'anthropic-2', label: 'Work' }),
      connection({ id: 'openai', provider: 'openai' })
    ])
    await screen.findByText('Personal')

    // The keyboard path, not a synthetic drag: jsdom has no layout, so the
    // pointer path's midpoint maths would be asserting on zeroed rects. The row
    // is its own handle — the list carries no grip glyph.
    expect(document.querySelector('.settings-list-grip')).toBeNull()
    const rows = document.querySelectorAll('.settings-list-row')
    fireEvent.keyDown(rows[2] as HTMLElement, { key: 'Home' })

    await waitFor(() =>
      expect(invokeDriver).toHaveBeenCalledWith('ai', 'reorderConnections', {
        connectionIds: ['openai', 'anthropic', 'anthropic-2']
      })
    )
  })

  it('uses only the insertion line as the pointer drag preview', async () => {
    await mount([connection({ id: 'anthropic', label: 'Personal' })])
    await screen.findByText('Personal')
    const setDragImage = vi.fn()
    fireEvent.dragStart(document.querySelector('.settings-list-row') as HTMLElement, {
      dataTransfer: { effectAllowed: '', setData: vi.fn(), setDragImage }
    })
    expect(setDragImage).toHaveBeenCalled()
  })

  it('shows the moved order immediately, without waiting for the write', async () => {
    await mount([connection({ id: 'anthropic', label: 'Personal' }), connection({ id: 'anthropic-2', label: 'Work' })])
    await screen.findByText('Personal')

    const rows = document.querySelectorAll('.settings-list-row')
    fireEvent.keyDown(rows[1] as HTMLElement, { key: 'Home' })

    await waitFor(() => {
      const names = [...document.querySelectorAll('.settings-list-name')].map((n) => n.textContent)
      expect(names).toEqual(['Work', 'Personal'])
    })
  })

  it('renders connections in the order the store returned them', async () => {
    // Stored order is the display order — the section must not re-sort.
    await mount([
      connection({ id: 'openai', provider: 'openai', label: 'Second' }),
      connection({ id: 'anthropic', label: 'First' })
    ])
    await screen.findByText('Second')
    const names = [...document.querySelectorAll('.settings-list-name')].map((n) => n.textContent)
    expect(names).toEqual(['Second', 'First'])
  })

  it('removes a connection by its own id, but only once the delete is confirmed', async () => {
    await mount([connection({ id: 'anthropic-2', label: 'Work' })])
    fireEvent.click(await screen.findByText('Work'))

    // The first press only arms it — a stray click must not cost a saved key.
    fireEvent.click(screen.getByRole('button', { name: 'Remove this connection' }))
    expect(invokeDriver).not.toHaveBeenCalledWith('ai', 'removeConnection', expect.anything())

    fireEvent.click(await screen.findByRole('button', { name: 'Confirm delete' }))
    await waitFor(() =>
      expect(invokeDriver).toHaveBeenCalledWith('ai', 'removeConnection', { connectionId: 'anthropic-2' })
    )
  })

  it('backs out of a delete without touching the connection', async () => {
    await mount([connection({ id: 'anthropic-2', label: 'Work' })])
    fireEvent.click(await screen.findByText('Work'))
    fireEvent.click(screen.getByRole('button', { name: 'Remove this connection' }))
    fireEvent.click(await screen.findByRole('button', { name: 'Cancel' }))

    await screen.findByRole('button', { name: 'Remove this connection' })
    expect(invokeDriver).not.toHaveBeenCalledWith('ai', 'removeConnection', expect.anything())
  })
  it('keeps the entered key and reports a rejected save', async () => {
    await mount([connection({ id: 'anthropic-2', label: 'Work', configured: false, authSources: {} })])
    fireEvent.click(await screen.findByText('Work'))
    const field = await screen.findByLabelText('API key')
    fireEvent.change(field, { target: { value: 'unsaved-fixture-key' } })
    invokeDriver.mockResolvedValue({ ok: false })
    fireEvent.click(screen.getByRole('button', { name: 'Save API key' }))
    expect(await screen.findByText('Request failed')).toHaveClass('aip-err')
    expect(field).toHaveValue('unsaved-fixture-key')
  })

})
