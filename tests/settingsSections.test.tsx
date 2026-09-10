import * as React from 'react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import type { AiChatThread, ChannelInfo } from '../src/types'
import type { RunAgentOptions } from '../src/agent/loop'

/**
 * The Assistant settings panes are built from the shared list-page chrome that
 * AI Providers and Accounts established (`settings-listpage*` / `settings-list*`),
 * not from a per-plugin fork. The parent pane is now only the sidebar-channel
 * toggles — the AI-Provider link and the personality cards live in their own
 * shared sections — and a channel pane is only its connection list: setup steps
 * and the commands card belong elsewhere, not stacked above the list.
 */
vi.mock('../src/agent/loop', () => ({
  runAgent: async (opts: RunAgentOptions) => opts.onMessage({ role: 'assistant', content: 'ok' }),
  streamOnce: async () => ({ text: '', toolCalls: [] })
}))

import { createMockValleyApi } from './mock'
import { initRuntime } from '../src/runtime'
import { getStore, disposeStore } from '../src/store'
import { ChatDetail, Settings } from '../src/Settings'
import { registerAssistantCommands } from '../src/commands'
import { registerAssistantSurfaces } from '../src/surfaces'
import { METADATA_PANEL_SEGMENT_V1, PLUGIN_SURFACE_V1 } from '@valley/plugin-sdk'
import { initLocalization, uiText } from '../src/localization'

afterEach(() => {
  cleanup()
  disposeStore()
})

const channel = (id: string, name: string, patch: Partial<ChannelInfo> = {}): ChannelInfo => ({
  id,
  type: 'telegram',
  name,
  displayName: name,
  configured: true,
  running: true,
  ...patch
})

const mirror = (id: string, title: string, channelId: string): AiChatThread => ({
  id,
  title,
  createdAt: 1,
  updatedAt: 1,
  messages: [],
  source: 'telegram',
  channelId,
  chatRef: '1',
  channelName: 'Field bot'
})

/** Mount one settings section against a seeded mock and wait for its content. */
async function mountSection(
  section: string,
  options: Parameters<typeof createMockValleyApi>[0] = {}
): Promise<{ container: HTMLElement }> {
  const mock = createMockValleyApi(options)
  for (const t of options.channels?.length ? [mirror('t1', 'Field notes', options.channels[0].id)] : []) {
    mock.chatThreads.set(t.id, t)
  }
  initRuntime(mock.api)
  getStore(mock.api)
  const { container } = render(<Settings section={section} />)
  await waitFor(() => expect(container.querySelector('.assistant-settings')?.textContent).toBeTruthy())
  return { container }
}

describe('assistant settings — parent pane', () => {
  it('drops the global attachment parser and the personality add row', async () => {
    const { container } = await mountSection('settings')
    expect(container.textContent).not.toContain('New personality')
    expect(container.querySelectorAll('[aria-label="Attachment parser"]')).toHaveLength(0)
  })

  it('carries the channel toggles alone — no provider link, no personalities', async () => {
    const { container } = await mountSection('settings')
    expect(container.textContent).toContain('Channels in the sidebar')
    expect(container.textContent).not.toContain('AI providers & Guards')
    expect(container.textContent).not.toContain('Personalities')
    const headings = [...container.querySelectorAll('.assistant-settings > .settings-label')].map((h) => h.textContent)
    expect(headings).toEqual(['Channels in the sidebar'])
  })

  it('offers a sidebar toggle per remote channel and persists it', async () => {
    const mock = createMockValleyApi()
    initRuntime(mock.api)
    getStore(mock.api)
    const { container } = await act(async () => render(<Settings section="settings" />))
    await waitFor(() => expect(container.textContent).toContain('Channels in the sidebar'))

    await act(async () => fireEvent.click(screen.getByLabelText('Telegram')))
    expect(
      mock.driverCalls.find((c) => c.method === 'updatePluginSettings' && (c.payload as { key: string }).key === 'showTelegram')?.payload
    ).toMatchObject({ key: 'showTelegram', value: false })
  })
})

describe('assistant settings — channel list page', () => {
  it('renders connections as shared list rows under a header band with +', async () => {
    const { container } = await mountSection('telegram', {
      channels: [channel('telegram', 'Field bot'), channel('telegram-2', 'Reading bot', { running: false, configured: false })]
    })
    await waitFor(() => expect(container.querySelectorAll('.settings-list-row').length).toBe(2))

    expect(container.querySelector('.settings-listpage-header')).toBeTruthy()
    expect(screen.getByLabelText('Add Telegram connection')).toBeTruthy()
    const names = [...container.querySelectorAll('.settings-list-name')].map((n) => n.textContent)
    expect(names).toEqual(['Field bot', 'Reading bot'])
    const subs = [...container.querySelectorAll('.settings-list-sub')].map((n) => n.textContent)
    expect(subs[0]).toContain('running')
    expect(subs[1]).toContain('not configured')
  })

  it('shows the connection list alone — no setup card, no commands card', async () => {
    const { container } = await mountSection('telegram', { channels: [channel('telegram', 'Field bot')] })
    await waitFor(() => expect(container.querySelectorAll('.settings-list-row').length).toBe(1))

    expect(container.textContent).not.toContain('Telegram bot setup')
    expect(container.textContent).not.toContain('BotFather')
    expect(container.querySelectorAll('.assistant-provider')).toHaveLength(0)
    expect(container.querySelectorAll('.settings-listpage')).toHaveLength(1)
  })

  it('opens a connection into a detail page led by the back band', async () => {
    const { container } = await mountSection('telegram', { channels: [channel('telegram', 'Field bot')] })
    await waitFor(() => expect(container.querySelectorAll('.settings-list-row').length).toBe(1))

    fireEvent.click(container.querySelector('.settings-list-row')!)
    await waitFor(() => expect(container.querySelector('.settings-listpage-crumbs')).toBeTruthy())
    expect(container.querySelector('.settings-crumb-current')?.textContent).toBe('Field bot')
    expect(screen.getByLabelText('Bot token')).toBeTruthy()

    fireEvent.click(screen.getByLabelText('Back to Telegram'))
    await waitFor(() => expect(container.querySelector('.settings-listpage-crumbs')).toBeNull())
    expect(container.querySelectorAll('.settings-list-row').length).toBe(1)
  })

  it('reaches a connection detail with the keyboard', async () => {
    const { container } = await mountSection('telegram', { channels: [channel('telegram', 'Field bot')] })
    await waitFor(() => expect(container.querySelectorAll('.settings-list-row').length).toBe(1))

    fireEvent.keyDown(container.querySelector('.settings-list-row')!, { key: 'Enter' })
    await waitFor(() => expect(container.querySelector('.settings-crumb-current')?.textContent).toBe('Field bot'))
  })
})

describe('assistant settings — chat pane', () => {
  it('saves and deletes human conversation edits directly while commands use the same domain helpers', async () => {
    const mock = createMockValleyApi({ manifest: { id: 'assistant' } })
    const thread = { id: 'canopy', title: 'Canopy report', createdAt: 1, updatedAt: 1, messages: [] }
    mock.chatThreads.set(thread.id, thread)
    initRuntime(mock.api)
    initLocalization(mock.api)
    await getStore(mock.api).whenReady
    const offCommands = registerAssistantCommands(mock.api)
    const dispatch = vi.spyOn(mock.api.commands, 'executeOwn')
    const execute = vi.spyOn(mock.api.commands, 'execute')
    const onBack = vi.fn()
    try {
      render(<ChatDetail summary={thread} personalities={[]} connections={[]} backTo="Chat" onBack={onBack} onChanged={async () => {}} />)
      const title = await screen.findByRole('textbox', { name: uiText('assistant.surface.title') })
      fireEvent.change(title, { target: { value: 'Meadow report' } })
      await act(async () => { fireEvent.blur(title) })
      expect(mock.chatThreads.get(thread.id)?.title).toBe('Meadow report')
      expect(dispatch).not.toHaveBeenCalled()
      expect(execute).not.toHaveBeenCalled()
      await act(async () => { expect(await mock.api.commands.executeOwn('update-chat', { id: thread.id, patch: { pinned: true } })).toMatchObject({ ok: true }) })
      expect(mock.chatThreads.get(thread.id)?.pinned).toBe(true)
      dispatch.mockClear()
      fireEvent.click(screen.getByRole('button', { name: uiText('auto.db9121e79c1c') }))
      await act(async () => { fireEvent.click(screen.getByRole('button', { name: uiText('auto.c9f2829e382c') })) })
      expect(mock.chatThreads.has(thread.id)).toBe(false)
      expect(onBack).toHaveBeenCalledOnce()
      expect(dispatch).not.toHaveBeenCalled()
      expect(execute).not.toHaveBeenCalled()
    } finally { offCommands() }
  })

  it('awaits history navigation and keeps the current conversation and history position when its target is missing', async () => {
    const mock = createMockValleyApi({ manifest: { id: 'assistant' } })
    const canopy = { id: 'canopy', title: 'Canopy report', createdAt: 1, updatedAt: 1, messages: [] }
    mock.chatThreads.set('canopy', canopy)
    mock.chatThreads.set('meadow', { ...canopy, id: 'meadow', title: 'Meadow report' })
    initRuntime(mock.api)
    const store = getStore(mock.api)
    await store.whenReady
    await store.openChat('canopy')
    await store.openChat('meadow')
    mock.chatThreads.delete('canopy')
    await expect(store.goBack()).rejects.toThrow()
    expect(store.getSnapshot()).toMatchObject({ active: { id: 'meadow' }, canGoBack: true, canGoForward: false })
    mock.chatThreads.set('canopy', canopy)
    await expect(store.goBack()).resolves.toBe(true)
    expect(store.getSnapshot()).toMatchObject({ active: { id: 'canopy' }, canGoForward: true })
    await expect(store.goForward()).resolves.toBe(true)
    expect(store.getSnapshot().active?.id).toBe('meadow')
  })

  it('restores an explicit conversation and edits its Properties without exposing human-only policy fields', async () => {
    const mock = createMockValleyApi({ manifest: { id: 'assistant' } })
    mock.chatThreads.set('canopy', { id: 'canopy', title: 'Canopy report', createdAt: 1, updatedAt: 1, messages: [] })
    mock.chatThreads.set('meadow', { id: 'meadow', title: 'Meadow report', createdAt: 2, updatedAt: 2, messages: [] })
    initRuntime(mock.api)
    const store = getStore(mock.api)
    const offCommands = registerAssistantCommands(mock.api)
    const offSurfaces = registerAssistantSurfaces(mock.api)
    const surface = mock.api.interop.extensions.providers(PLUGIN_SURFACE_V1).find((provider) => provider.extension.surface === 'main_workspace')!.extension
    await surface.restore({ chatId: 'canopy' }, undefined, { background: true })
    expect(store.getSnapshot().active?.id).toBe('canopy')
    expect(mock.api.workspace.openMainTab).not.toHaveBeenCalled()
    const snapshot = surface.getSnapshot()!
    const subject = { pluginId: 'assistant', surface: 'main_workspace' as const, view: snapshot.view, item: snapshot.item }
    const properties = mock.api.interop.extensions.providers(METADATA_PANEL_SEGMENT_V1)[0].extension
    expect(await properties.inspect?.({ relPath: '', kind: 'unsupported', subject })).toEqual(expect.arrayContaining([{ id: 'pinned', label: expect.any(String), value: false, type: 'boolean' }]))
    expect(await mock.api.commands.executeOwn('update-properties', { subject, values: { title: 'Canopy 2026', pinned: true } })).toMatchObject({ ok: true })
    expect(mock.chatThreads.get('canopy')).toMatchObject({ title: 'Canopy 2026', pinned: true })
    expect(mock.chatThreads.get('meadow')?.title).toBe('Meadow report')
    for (const values of [{ guard: { defaultWrite: { decision: 'allow' } } }, { dangerousMode: { enabled: true } }, { approvalToken: 'injected' }]) {
      expect(await mock.api.commands.executeOwn('update-properties', { subject, values })).toMatchObject({ ok: false })
      expect(await mock.api.commands.executeOwn('update-chat', { id: 'canopy', patch: values })).toMatchObject({ ok: false })
    }
    await expect(surface.restore({ chatId: 'deleted' }, undefined, { background: true })).rejects.toThrow('no longer exists')
    expect(store.getSnapshot().active?.id).toBe('canopy')
    expect(mock.driverCalls.some((call) => /Guard|Dangerous|Approval/.test(call.method) && !call.method.startsWith('get'))).toBe(false)
    offSurfaces(); offCommands()
  })

  it('leads with the defaults a new chat starts from', async () => {
    const { container } = await mountSection('chat')
    await waitFor(() => expect(container.textContent).toContain('New chats'))
    expect(screen.getByLabelText('Personality')).toBeTruthy()
    expect(screen.getByLabelText('Send with Enter')).toBeTruthy()
    expect(screen.getByLabelText('Attachment folder')).toBeTruthy()
  })

  it('lists conversations as shared list rows', async () => {
    const mock = createMockValleyApi()
    mock.chatThreads.set('c1', { id: 'c1', title: 'Local note', createdAt: 1, updatedAt: 1, messages: [] })
    initRuntime(mock.api)
    getStore(mock.api)
    const { container } = render(<Settings section="chat" />)
    await waitFor(() => expect(container.querySelector('.settings-list-name')?.textContent).toBe('Local note'))
    expect(container.querySelector('.settings-list-row')).toBeTruthy()
  })
})
