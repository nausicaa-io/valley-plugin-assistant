import * as React from 'react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import type { AiChatThread } from '../src/types'
import type { RunAgentOptions } from '../src/agent/loop'

/**
 * Settings → Assistant decides whether a remote channel appears in the Chats
 * sidebar at all. Switching one off has to take BOTH its filter button and its
 * thread group away — a filter with no visible button is a dead end.
 */
vi.mock('../src/agent/loop', () => ({
  runAgent: async (opts: RunAgentOptions) => opts.onMessage({ role: 'assistant', content: 'ok' }),
  streamOnce: async () => ({ text: '', toolCalls: [] })
}))

import { createMockValleyApi } from './mock'
import { initRuntime } from '../src/runtime'
import { getStore, disposeStore } from '../src/store'
import { Panel } from '../src/Panel'

afterEach(() => {
  cleanup()
  disposeStore()
})

const thread = (id: string, title: string, source?: AiChatThread['source']): AiChatThread => ({
  id,
  title,
  createdAt: 1,
  updatedAt: 1,
  messages: [],
  ...(source ? { source, channelId: source, chatRef: '1', channelName: `${source} bot` } : {})
})

/** Mount the panel with one chat per source and the given plugin settings. */
async function mountPanel(settings: Record<string, unknown>): Promise<void> {
  const mock = createMockValleyApi({ settings })
  for (const t of [thread('c1', 'Local note'), thread('t1', 'Field notes', 'telegram'), thread('w1', 'Survey log', 'whatsapp')]) {
    mock.chatThreads.set(t.id, t)
  }
  initRuntime(mock.api)
  getStore(mock.api)
  render(<Panel />)
  // The in-app chat is never hidden, so it is the signal that threads loaded.
  await waitFor(() => expect(screen.getByText('Local note')).toBeTruthy())
}

describe('assistant sidebar — channel visibility', () => {
  it('shows both channel filters and both groups by default', async () => {
    await mountPanel({})
    expect(screen.getByLabelText('Filter Telegram chats')).toBeTruthy()
    expect(screen.getByLabelText('Filter WhatsApp chats')).toBeTruthy()
    expect(screen.getByText('Survey log')).toBeTruthy()
  })

  it('takes a switched-off channel out of the header and the list', async () => {
    await mountPanel({ showTelegram: false })
    expect(screen.queryByLabelText('Filter Telegram chats')).toBeNull()
    expect(screen.queryByText('Field notes')).toBeNull()
    // The other channel is untouched.
    expect(screen.getByLabelText('Filter WhatsApp chats')).toBeTruthy()
    expect(screen.getByText('Survey log')).toBeTruthy()
  })

  it('can switch both off, leaving only the in-app conversations', async () => {
    await mountPanel({ showTelegram: false, showWhatsApp: false })
    expect(screen.queryByLabelText('Filter Telegram chats')).toBeNull()
    expect(screen.queryByLabelText('Filter WhatsApp chats')).toBeNull()
    expect(screen.queryByText('Survey log')).toBeNull()
    expect(screen.getByText('Local note')).toBeTruthy()
  })

  it('drops a filter back to "all" when its channel is switched off under it', async () => {
    const mock = createMockValleyApi({ settings: { showTelegram: true } })
    for (const t of [thread('c1', 'Local note'), thread('t1', 'Field notes', 'telegram')]) mock.chatThreads.set(t.id, t)
    initRuntime(mock.api)
    getStore(mock.api)
    const { rerender } = render(<Panel />)
    await waitFor(() => expect(screen.getByText('Field notes')).toBeTruthy())

    // Filter down to Telegram only — the in-app chat drops out of the list.
    fireEvent.click(screen.getByLabelText('Filter Telegram chats'))
    expect(screen.queryByText('Local note')).toBeNull()

    // Now switch Telegram off: the panel must fall back to showing everything
    // rather than an empty list with no button to undo it.
    ;(mock.api.settings.get() as Record<string, unknown>).showTelegram = false
    rerender(<Panel />)
    await waitFor(() => expect(screen.getByText('Local note')).toBeTruthy())
    expect(screen.queryByText('Field notes')).toBeNull()
  })
})
