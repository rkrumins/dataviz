/**
 * "TRACING N ENTITIES" — the dock's focus chip for a combined trace.
 *
 * A trace of a multi-selection has no one name, and the chip used to show
 * the first seed's as if it were the whole trace. With two or more seeds it
 * says how many, and opens the list of them: each with its type, each one
 * removable. Escape closes that list and nothing else — the trace behind it
 * stays up.
 */
import { afterEach, describe, expect, it, vi } from 'vitest'
import { fireEvent, render, screen, within } from '@testing-library/react'
import { TraceDockTitleBar } from '../TraceDockTitleBar'
import type { TraceSeed } from '../TraceSeedsPopover'
import type { UseUnifiedTraceResult } from '@/hooks/useUnifiedTrace'
import type { HierarchyNode } from '@/types/hierarchy'

const trace = {
  status: 'success',
  error: null,
  focusId: 'orders',
  result: null,
  isTracing: true,
  isLoading: false,
  config: { upstreamDepth: 25, downstreamDepth: 25 },
  setConfig: vi.fn(),
  showUpstream: true,
  showDownstream: true,
  setShowUpstream: vi.fn(),
  setShowDownstream: vi.fn(),
  retrace: vi.fn(async () => {}),
  upstreamCount: 3,
  downstreamCount: 2,
  statistics: { totalNodes: 7, totalEdges: 5, upstreamCount: 3, downstreamCount: 2 },
  drilldowns: new Map(),
  traceHistory: [],
  jumpToHistoryEntry: vi.fn(async () => {}),
  clearTraceHistory: vi.fn(),
  collapseDrilldown: vi.fn(),
} as unknown as UseUnifiedTraceResult

const ORDERS: TraceSeed = { urn: 'urn:orders', label: 'orders', typeId: 'dataset' }
const SALES: TraceSeed = { urn: 'urn:sales', label: 'sales', typeId: 'dataset' }
const DASH: TraceSeed = { urn: 'urn:dash', label: 'Revenue dashboard', typeId: 'dashboard' }

function renderBar(seeds: readonly TraceSeed[], focusLabel = `${seeds.length} entities`) {
  const onRemoveSeed = vi.fn()
  const onExit = vi.fn()
  const props = {
    trace,
    displayMap: new Map<string, HierarchyNode>(),
    expanded: false,
    onToggleExpanded: vi.fn(),
    onExit,
    nativeMode: true,
    onRemoveSeed,
  }
  const view = render(<TraceDockTitleBar {...props} seeds={seeds} focusLabel={focusLabel} />)
  const rerender = (next: readonly TraceSeed[], label = `${next.length} entities`) =>
    view.rerender(<TraceDockTitleBar {...props} seeds={next} focusLabel={label} />)
  return { onRemoveSeed, onExit, rerender }
}

const openList = () => fireEvent.click(screen.getByRole('button', { name: /tracing \d+ entities/i }))
const list = () => screen.queryByRole('dialog', { name: 'Traced entities' })

afterEach(() => vi.clearAllMocks())

describe('TraceDockTitleBar — a combined trace', () => {
  it('names the trace "Tracing 2 entities" instead of the first seed', () => {
    renderBar([ORDERS, SALES])
    const chip = screen.getByRole('button', { name: /tracing 2 entities/i })
    expect(chip.getAttribute('aria-haspopup')).toBe('dialog')
    expect(chip.getAttribute('aria-expanded')).toBe('false')
    expect(screen.getByRole('toolbar', { name: 'Trace controls for 2 entities' })).toBeTruthy()
    expect(list()).toBeNull()
  })

  it('one seed keeps the ordinary focus chip', () => {
    renderBar([ORDERS], 'orders')
    expect(screen.queryByRole('button', { name: /tracing/i })).toBeNull()
    expect(screen.getByText('orders')).toBeTruthy()
  })

  it('opens the list of seeds, each with its type and a remove', () => {
    renderBar([ORDERS, SALES, DASH])
    openList()

    const panel = list()!
    expect(panel).toBeTruthy()
    expect(screen.getByRole('button', { name: /tracing 3 entities/i }).getAttribute('aria-expanded')).toBe('true')
    const rows = panel.querySelectorAll('[data-seed-row]')
    expect([...rows].map(r => r.querySelector('[title]')?.textContent)).toEqual(['orders', 'sales', 'Revenue dashboard'])
    expect(within(panel).getByText('dashboard')).toBeTruthy()
    expect(within(panel).getAllByText('dataset')).toHaveLength(2)
    // Focus lands in the list, on the first seed.
    expect(document.activeElement).toBe(rows[0])
  })

  it('removing a seed hands its urn back and keeps the list open on the rest', () => {
    const { onRemoveSeed, rerender } = renderBar([ORDERS, SALES, DASH])
    openList()

    fireEvent.click(screen.getByRole('button', { name: 'Remove sales from the trace' }))
    expect(onRemoveSeed).toHaveBeenCalledTimes(1)
    expect(onRemoveSeed).toHaveBeenCalledWith('urn:sales')

    rerender([ORDERS, DASH])
    const panel = list()!
    expect(panel).toBeTruthy()
    expect(panel.querySelectorAll('[data-seed-row]')).toHaveLength(2)
    expect(within(panel).queryByText('sales')).toBeNull()
    expect(screen.getByRole('button', { name: /tracing 2 entities/i })).toBeTruthy()
  })

  it('narrowed to one seed, the list closes with the chip', () => {
    const { rerender } = renderBar([ORDERS, SALES])
    openList()
    expect(list()).toBeTruthy()

    rerender([ORDERS], 'orders')
    expect(list()).toBeNull()
    expect(screen.queryByRole('button', { name: /tracing/i })).toBeNull()

    // A later combined trace starts with its list closed.
    rerender([ORDERS, SALES])
    expect(list()).toBeNull()
  })

  it('narrowed to one seed from the list, the keyboard stays in the dock', () => {
    const { rerender } = renderBar([ORDERS, SALES])
    openList()
    const remove = screen.getByRole('button', { name: 'Remove sales from the trace' })
    remove.focus()
    fireEvent.click(remove)

    // The X that held focus goes with the list, and the chip with it.
    rerender([ORDERS], 'orders')
    const toolbar = screen.getByRole('toolbar', { name: 'Trace controls for orders' })
    expect(document.activeElement).not.toBe(document.body)
    expect(toolbar.contains(document.activeElement)).toBe(true)
  })

  it('Delete on a seed removes it, as its X does', () => {
    const { onRemoveSeed } = renderBar([ORDERS, SALES, DASH])
    openList()
    const rows = [...list()!.querySelectorAll<HTMLElement>('[data-seed-row]')]
    rows[1].focus()
    // Stands in for the canvas's own Delete, which deletes the selection.
    const canvasDelete = vi.fn()
    document.addEventListener('keydown', canvasDelete)
    try {
      fireEvent.keyDown(rows[1], { key: 'Delete' })
      expect(onRemoveSeed).toHaveBeenCalledTimes(1)
      expect(onRemoveSeed).toHaveBeenCalledWith('urn:sales')
      expect(canvasDelete).not.toHaveBeenCalled()
    } finally {
      document.removeEventListener('keydown', canvasDelete)
    }
  })

  it('Escape closes only the list — the trace behind it is left alone', () => {
    const { onExit } = renderBar([ORDERS, SALES])
    // Stands in for the canvas's own Escape handler, which leaves the trace.
    const traceEscape = vi.fn()
    window.addEventListener('keydown', traceEscape)
    try {
      openList()
      expect(list()).toBeTruthy()

      fireEvent.keyDown(document.activeElement ?? document, { key: 'Escape' })

      expect(list()).toBeNull()
      expect(traceEscape).not.toHaveBeenCalled()
      expect(onExit).not.toHaveBeenCalled()
      // Focus goes back to the chip that opened it.
      expect(document.activeElement).toBe(screen.getByRole('button', { name: /tracing 2 entities/i }))
    } finally {
      window.removeEventListener('keydown', traceEscape)
    }
  })

  it('arrow keys move between the seeds', () => {
    renderBar([ORDERS, SALES, DASH])
    openList()
    const rows = [...list()!.querySelectorAll<HTMLElement>('[data-seed-row]')]

    fireEvent.keyDown(rows[0], { key: 'ArrowDown' })
    expect(document.activeElement).toBe(rows[1])
    fireEvent.keyDown(rows[1], { key: 'End' })
    expect(document.activeElement).toBe(rows[2])
    fireEvent.keyDown(rows[2], { key: 'ArrowDown' })
    expect(document.activeElement).toBe(rows[0])
  })
})
