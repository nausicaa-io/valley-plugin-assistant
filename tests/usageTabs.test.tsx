import * as React from 'react'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, beforeEach, expect, it } from 'vitest'
import { createMockValleyApi } from './mock'
import { initRuntime } from '../src/runtime'
import { UsageTabs } from '../src/UsageTabs'

beforeEach(() => initRuntime(createMockValleyApi().api))
afterEach(cleanup)

function Tabs(): React.ReactElement {
  const [value, onChange] = React.useState('daily')
  return <UsageTabs value={value} onChange={onChange} ariaLabel="Spending" tabs={[{ id: 'daily', label: 'Daily' }, { id: 'weekly', label: 'Weekly' }, { id: 'monthly', label: 'Monthly' }]} />
}

it('moves selection and focus together with arrows and Home/End', () => {
  render(<Tabs />)
  const daily = screen.getByRole('tab', { name: 'Daily' })
  daily.focus()
  fireEvent.keyDown(daily, { key: 'ArrowRight' })
  const weekly = screen.getByRole('tab', { name: 'Weekly' })
  expect(weekly).toHaveFocus()
  expect(weekly).toHaveAttribute('aria-selected', 'true')
  expect(daily).toHaveAttribute('tabindex', '-1')
  fireEvent.keyDown(weekly, { key: 'End' })
  expect(screen.getByRole('tab', { name: 'Monthly' })).toHaveFocus()
  fireEvent.keyDown(screen.getByRole('tab', { name: 'Monthly' }), { key: 'Home' })
  expect(daily).toHaveFocus()
  fireEvent.keyDown(daily, { key: 'ArrowLeft' })
  expect(screen.getByRole('tab', { name: 'Monthly' })).toHaveAttribute('aria-selected', 'true')
})

it('changes the selected grain on click while retaining one tab stop', () => {
  render(<Tabs />)
  fireEvent.click(screen.getByRole('tab', { name: 'Monthly' }))
  expect(screen.getAllByRole('tab').filter((tab) => tab.tabIndex === 0)).toEqual([screen.getByRole('tab', { name: 'Monthly' })])
})
