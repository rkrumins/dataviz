/**
 * The Connections panel — the bottom-right surface that replaced the Edge
 * Legend, whose show/hide did nothing and whose counts were wrong.
 *
 * What these pin:
 * - The numbers are honest and plain: the collapsed pill carries the
 *   relationship total and how many types are hidden; the expanded
 *   sub-header separates the total from what is actually being PAINTED
 *   ("drawn", read from the overlay's own store, never re-derived).
 * - A hidden type keeps a row so it can be brought back, but shows no
 *   count — the model no longer contains its bundles, so any number there
 *   would be a lie.
 * - Hover and pin drive the overlay's highlight channel, and the hover can
 *   never be left stuck: leaving the row list clears it.
 * - The header button is the FIRST button in the panel — the canvas
 *   reserves the bottom band from `el.querySelector('button').offsetHeight`.
 */
import { render, screen, fireEvent, cleanup } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { ConnectionsPanel, type ConnectionsPanelProps } from '../ConnectionsPanel'
import type { ConnectionModel, ConnectionTypeRow } from '../connectionModel'
import type { EdgeTypeDefinition } from '@/utils/edgeTypeUtils'
import { useDrawnEdgesStore } from '@/store/drawnEdges'

// ─── Fixtures ────────────────────────────────────────────────────────────────

const ONTOLOGY: Record<string, Partial<EdgeTypeDefinition>> = {
  FLOWS_TO: {
    label: 'Flows to',
    description: 'Data moves from one place to the next',
    color: '#3b82f6',
    strokeStyle: 'solid',
  },
  DERIVES_FROM: {
    label: 'Derives from',
    description: 'Built out of another dataset',
    color: '#f59e0b',
    strokeStyle: 'dashed',
  },
  OWNS: { label: 'Owns', description: 'Responsible for', color: '#a855f7', strokeStyle: 'solid' },
  TAGGED_WITH: { label: 'Tagged with', description: 'Carries a label', color: '#22c55e', strokeStyle: 'dotted' },
}

const resolveType = (type: string): EdgeTypeDefinition => ({
  type,
  label: type,
  description: `Relationship type: ${type}`,
  color: '#888888',
  strokeStyle: 'solid',
  animated: false,
  icon: null,
  ...ONTOLOGY[type],
})

const typeRow = (over: Partial<ConnectionTypeRow> & { type: string }): ConnectionTypeRow => ({
  relationships: 1,
  bundles: 1,
  bundleIds: [],
  forward: 1,
  backward: 0,
  bidirectional: 0,
  ...over,
})

/** 47 relationships across two types — the brief's own worked example. */
const MODEL: ConnectionModel = {
  rows: [
    typeRow({ type: 'FLOWS_TO', relationships: 30, bundles: 2, bundleIds: ['b1', 'b2'], forward: 27, backward: 3 }),
    typeRow({ type: 'DERIVES_FROM', relationships: 17, bundles: 1, bundleIds: ['b3'], forward: 17, backward: 0 }),
  ],
  relationships: 47,
  bundles: 3,
  typeCount: 2,
  untyped: 0,
}

const EMPTY_HIDDEN: ReadonlySet<string> = new Set()

function mount(over: Partial<ConnectionsPanelProps> = {}) {
  const props: ConnectionsPanelProps = {
    model: MODEL,
    hiddenTypes: EMPTY_HIDDEN,
    resolveType,
    lineageOn: true,
    onToggleType: vi.fn(),
    onSoloType: vi.fn(),
    onShowAll: vi.fn(),
    onHighlight: vi.fn(),
    ...over,
  }
  const utils = render(<ConnectionsPanel {...props} />)
  return { ...utils, props }
}

const headerButton = () => screen.getByRole('button', { name: /connections/i })
const rowFor = (type: string) =>
  document.querySelector<HTMLElement>(`[data-connection-row="${type}"]`) as HTMLElement
const rowList = () => document.querySelector<HTMLElement>('[data-connection-rows]') as HTMLElement
const lastHighlight = (fn: ReturnType<typeof vi.fn>) => fn.mock.calls.at(-1)?.[0] as ReadonlySet<string> | null

// ─── Tests ───────────────────────────────────────────────────────────────────

describe('ConnectionsPanel', () => {
  beforeEach(() => {
    useDrawnEdgesStore.setState({ drawn: 0 })
  })
  afterEach(() => {
    cleanup()
    vi.restoreAllMocks()
  })

  it('the collapsed pill reads Connections and the relationship total', () => {
    mount()
    const header = headerButton()
    expect(header.textContent).toMatch(/Connections/)
    expect(header.textContent).toMatch(/47/)
    expect(header.textContent).not.toMatch(/hidden/)
  })

  it('the collapsed pill appends "· 2 hidden" while types are hidden', () => {
    mount({ hiddenTypes: new Set(['OWNS', 'TAGGED_WITH']) })
    expect(headerButton().textContent).toMatch(/47 · 2 hidden/)
  })

  it('the expanded header reads {n} connections · {d} drawn · {t} types', () => {
    useDrawnEdgesStore.setState({ drawn: 12 })
    mount({ defaultExpanded: true })
    expect(screen.getByText('47 connections · 12 drawn · 2 types')).toBeTruthy()
  })

  it('Lineage off shows "Lineage is off" and renders no totals', () => {
    useDrawnEdgesStore.setState({ drawn: 12 })
    const { container } = mount({ lineageOn: false, defaultExpanded: true })
    expect(screen.getByText('Lineage is off')).toBeTruthy()
    expect(screen.getByText('Turn Lineage on in the header to see connections.')).toBeTruthy()
    expect(headerButton().textContent).toMatch(/Off/)
    // No number of any kind while lineage is off — not the total, not "drawn".
    expect(container.textContent).not.toMatch(/\d/)
  })

  it('a hidden type gets a dimmed row with no count and a control that restores it', () => {
    const onToggleType = vi.fn()
    mount({ hiddenTypes: new Set(['OWNS']), defaultExpanded: true, onToggleType })

    const hidden = rowFor('OWNS')
    expect(hidden).toBeTruthy()
    expect(hidden.textContent).toMatch(/Owns/)
    expect(hidden.className).toMatch(/opacity-/)
    // No count, no direction split — the model no longer holds its bundles.
    expect(hidden.textContent).not.toMatch(/\d/)
    expect(hidden.textContent).not.toMatch(/→|←/)

    // Hidden rows come after every visible one.
    const order = [...document.querySelectorAll('[data-connection-row]')].map(
      (el) => el.getAttribute('data-connection-row'),
    )
    expect(order).toEqual(['FLOWS_TO', 'DERIVES_FROM', 'OWNS'])

    fireEvent.click(screen.getByTitle('Show this type'))
    expect(onToggleType).toHaveBeenCalledWith('OWNS')
  })

  it('hovering a row emits that type bundle ids; leaving emits null', () => {
    const onHighlight = vi.fn()
    mount({ defaultExpanded: true, onHighlight })
    onHighlight.mockClear()

    fireEvent.mouseEnter(rowFor('FLOWS_TO'))
    expect([...(lastHighlight(onHighlight) ?? [])]).toEqual(['b1', 'b2'])

    // Leaving the LIST (not just the row) must clear it — a highlight can
    // never be left stuck when the pointer leaves the panel.
    fireEvent.mouseLeave(rowList())
    expect(lastHighlight(onHighlight)).toBeNull()
  })

  it('clicking a row pins the highlight; clicking it again clears it', () => {
    const onHighlight = vi.fn()
    mount({ defaultExpanded: true, onHighlight })
    onHighlight.mockClear()

    fireEvent.click(rowFor('DERIVES_FROM'))
    expect([...(lastHighlight(onHighlight) ?? [])]).toEqual(['b3'])

    // A pin survives the pointer leaving.
    fireEvent.mouseLeave(rowList())
    expect([...(lastHighlight(onHighlight) ?? [])]).toEqual(['b3'])

    fireEvent.click(rowFor('DERIVES_FROM'))
    expect(lastHighlight(onHighlight)).toBeNull()
  })

  it('Only calls onSoloType with every type the panel knows, visible and hidden', () => {
    const onSoloType = vi.fn()
    mount({ hiddenTypes: new Set(['OWNS']), defaultExpanded: true, onSoloType })

    const only = rowFor('FLOWS_TO').querySelector<HTMLElement>('[data-connection-only]')!
    fireEvent.click(only)

    expect(onSoloType).toHaveBeenCalledTimes(1)
    const [type, allTypes] = onSoloType.mock.calls[0] as [string, string[]]
    expect(type).toBe('FLOWS_TO')
    expect([...allTypes].sort()).toEqual(['DERIVES_FROM', 'FLOWS_TO', 'OWNS'])
  })

  it('Show all renders only while something is hidden', () => {
    const onShowAll = vi.fn()
    const { unmount } = mount({ defaultExpanded: true })
    expect(screen.queryByRole('button', { name: 'Show all' })).toBeNull()
    unmount()

    mount({ hiddenTypes: new Set(['OWNS']), defaultExpanded: true, onShowAll })
    fireEvent.click(screen.getByRole('button', { name: 'Show all' }))
    expect(onShowAll).toHaveBeenCalledTimes(1)
  })

  it('the swatch is dashed for a dashed ontology type and solid for a solid one', () => {
    mount({ defaultExpanded: true })
    const dash = (type: string) =>
      rowFor(type).querySelector('svg line')?.getAttribute('stroke-dasharray')
    expect(dash('FLOWS_TO')).toBe('none')
    expect(dash('DERIVES_FROM')).toBe('6,3')
  })

  it('the header button is the first button in the panel', () => {
    // ContextViewCanvas's measureLegendHeader reserves the bottom band from
    // `el.querySelector('button').offsetHeight` — the collapsed header must
    // be that button, in every state, or the band is measured from a row.
    const { container } = mount({ hiddenTypes: new Set(['OWNS']), defaultExpanded: true })
    const first = container.querySelector('button')
    expect(first).toBe(headerButton())
  })
})
