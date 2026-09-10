import * as React from 'react'
import { act, cleanup, render } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { MainWorkspaceNavigation, MainWorkspaceViewProps } from '@valley/plugin-sdk'
import { createMockValleyApi } from './mock'
import config from '../config.json'
import { register } from '../src/index'
import { getStore } from '../src/store'

let dispose: (() => void) | undefined
afterEach(() => { cleanup(); dispose?.(); dispose = undefined })

describe('declared Assistant view slots', () => {
  it('renders the shared chat in the sidebar while only the main view owns navigation', async () => {
    const mock = createMockValleyApi({ manifest: { id: 'assistant' } })
    mock.chatThreads.set('canopy', { id: 'canopy', title: 'Canopy report', createdAt: 1, updatedAt: 1, messages: [] })
    mock.chatThreads.set('meadow', { id: 'meadow', title: 'Meadow report', createdAt: 2, updatedAt: 2, messages: [] })
    dispose = register(mock.api)
    const store = getStore(mock.api)
    await store.whenReady
    await store.openChat('canopy')
    await store.openChat('meadow')
    const views = new Map(vi.mocked(mock.api.registerView).mock.calls)
    const Sidebar = views.get(config.uiSlots.right_sidebar) as React.ComponentType
    const Main = views.get(config.uiSlots.main_workspace) as React.ComponentType<MainWorkspaceViewProps>
    expect(Sidebar).toBeDefined()
    expect(Main).toBeDefined()

    const sidebar = render(<Sidebar />)
    expect(sidebar.container.querySelector('.assistant-page-title')).toHaveTextContent('Meadow report')
    expect(sidebar.container.querySelector('.assistant-messages')).toBeInTheDocument()
    expect(sidebar.container.querySelector('textarea')).toBeInTheDocument()

    const setController = vi.fn<MainWorkspaceNavigation['setController']>()
    const main = render(<Main navigation={{ setController }} />)
    expect(setController).toHaveBeenLastCalledWith(expect.objectContaining({ canGoBack: true, canGoForward: false }))
    await act(async () => { await setController.mock.calls.at(-1)?.[0]?.goBack() })
    expect(main.container.querySelector('.assistant-page-title')).toHaveTextContent('Canopy report')
    expect(sidebar.container.querySelector('.assistant-page-title')).toHaveTextContent('Canopy report')
    expect(setController).toHaveBeenLastCalledWith(expect.objectContaining({ canGoForward: true }))

    const callsBeforeSidebarUnmount = setController.mock.calls.length
    sidebar.unmount()
    expect(setController).toHaveBeenCalledTimes(callsBeforeSidebarUnmount)
    main.unmount()
    expect(setController).toHaveBeenLastCalledWith(null)
  })
})
