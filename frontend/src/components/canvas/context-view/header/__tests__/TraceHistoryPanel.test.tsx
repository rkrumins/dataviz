/**
 * TraceHistoryPanel — the "pick up where you left off" launcher under the
 * header's Trace Lineage control. Purely presentational: rows lead with
 * their direction glyph in the EXACT wire colors the trace will draw
 * (cyan feeds in / amber flows out / violet both), resume fires by stack
 * index, and an empty history is an invitation, never a blank.
 */
import { render, screen, fireEvent } from '@testing-library/react'
import { describe, it, expect, vi } from 'vitest'
import { createRef } from 'react'
import { TraceHistoryPanel, type TraceHistoryPanelEntry } from '../TraceHistoryPanel'

const entries: TraceHistoryPanelEntry[] = [
  { index: 2, label: 'int_clean_products_t1', mode: 'up', timestamp: Date.now() - 2 * 60_000 },
  { index: 1, label: 'clean_opportunities', mode: 'down', timestamp: Date.now() - 18 * 60_000 },
  { index: 0, label: 'Snowflake', mode: 'both', timestamp: Date.now() - 60 * 60_000 },
]

function renderPanel(over: Partial<Parameters<typeof TraceHistoryPanel>[0]> = {}) {
  const trigger = document.createElement('button')
  document.body.appendChild(trigger)
  const triggerRef = createRef<HTMLElement>() as React.RefObject<HTMLElement | null>
  ;(triggerRef as { current: HTMLElement | null }).current = trigger
  const props = {
    entries,
    onResume: vi.fn(),
    onClear: vi.fn(),
    onClose: vi.fn(),
    triggerRef,
    ...over,
  }
  render(<TraceHistoryPanel {...props} />)
  return props
}

describe('TraceHistoryPanel', () => {
  it('lists every trail with its mode glyph in the wire colors, newest first', () => {
    renderPanel()
    expect(screen.getByText(/pick up where you left off/i)).toBeInTheDocument()
    const rows = screen.getAllByRole('menuitem')
    expect(rows.map(r => r.textContent)).toEqual([
      expect.stringContaining('int_clean_products_t1'),
      expect.stringContaining('clean_opportunities'),
      expect.stringContaining('Snowflake'),
    ])
    expect(rows[0]!.querySelector('[data-mode="up"]')?.className).toMatch(/cyan/)
    expect(rows[1]!.querySelector('[data-mode="down"]')?.className).toMatch(/amber/)
    expect(rows[2]!.querySelector('[data-mode="both"]')?.className).toMatch(/violet/)
    expect(screen.getByText(/2m ago/i)).toBeInTheDocument()
  })

  it('resuming a trail fires its STACK index', () => {
    const props = renderPanel()
    fireEvent.click(screen.getByText('clean_opportunities'))
    expect(props.onResume).toHaveBeenCalledWith(1)
  })

  it('Clear history clears; Escape closes', () => {
    const props = renderPanel()
    fireEvent.click(screen.getByRole('button', { name: /clear history/i }))
    expect(props.onClear).toHaveBeenCalledTimes(1)
    fireEvent.keyDown(window, { key: 'Escape' })
    expect(props.onClose).toHaveBeenCalled()
  })

  it('an empty history is an invitation to act, not a blank', () => {
    renderPanel({ entries: [] })
    expect(screen.getByText(/select an entity/i)).toBeInTheDocument()
    expect(screen.queryByRole('menuitem')).toBeNull()
    expect(screen.queryByRole('button', { name: /clear history/i })).toBeNull()
  })
})
