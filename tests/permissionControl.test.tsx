import * as React from 'react'
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render } from '@testing-library/react'
import { createMockValleyApi } from './mock'
import { initRuntime } from '../src/runtime'

// The plugin's components read React + api off the shared runtime module (set in
// `register()` at runtime); seed it with the mock's real React before any render.
const mock = createMockValleyApi()
beforeAll(() => initRuntime(mock.api))

// Imported after initRuntime so the module's `runtime.React` is already assigned.
import { PermissionControl, type PermMode } from '../src/Page'

afterEach(cleanup)

/** Render the control and open its popover (the menu only mounts while open). */
function openMenu(active: PermMode, onPick: (m: PermMode) => void = vi.fn()): ReturnType<typeof render> {
  mock.menus.length = 0
  const utils = render(<PermissionControl active={active} onPick={onPick} />)
  fireEvent.click(utils.getByLabelText('Assistant permissions'))
  return utils
}

describe('PermissionControl', () => {
  it('offers all three permission levels', () => {
    openMenu('ask')
    expect(mock.menus.at(-1)?.map((item) => item.label)).toEqual([
      'Ask before acting',
      'Act without asking',
      'Dangerously skip permissions'
    ])
  })

  it('checks the active row — the danger level when a bypass is active', () => {
    openMenu('danger')
    expect(mock.menus.at(-1)?.find((item) => item.checked)?.label).toBe('Dangerously skip permissions')
  })

  it('emits "danger" when the dangerous level is picked', () => {
    const onPick = vi.fn()
    openMenu('act', onPick)
    mock.menus.at(-1)?.find((item) => item.label === 'Dangerously skip permissions')?.onSelect?.()
    expect(onPick).toHaveBeenCalledWith('danger')
  })

  it('the closed button mirrors the active mode glyph', () => {
    const { getByLabelText, rerender } = render(<PermissionControl active="ask" onPick={vi.fn()} />)
    const btn = (): HTMLElement => getByLabelText('Assistant permissions')
    expect(btn().querySelector('svg')).toBeTruthy() // hand
    expect(btn().textContent).not.toContain('»')

    rerender(<PermissionControl active="act" onPick={vi.fn()} />)
    expect(btn().textContent).toContain('»') // chevrons, not an svg
    expect(btn().querySelector('svg')).toBeFalsy()

    rerender(<PermissionControl active="danger" onPick={vi.fn()} />)
    expect(btn().querySelector('svg')).toBeTruthy() // warning triangle
  })

  it('emits "ask" and "act" for the two safe levels', () => {
    const askPick = vi.fn()
    openMenu('act', askPick)
    mock.menus.at(-1)?.find((item) => item.label === 'Ask before acting')?.onSelect?.()
    expect(askPick).toHaveBeenCalledWith('ask')

    cleanup()
    const actPick = vi.fn()
    openMenu('ask', actPick)
    mock.menus.at(-1)?.find((item) => item.label === 'Act without asking')?.onSelect?.()
    expect(actPick).toHaveBeenCalledWith('act')
  })
})
