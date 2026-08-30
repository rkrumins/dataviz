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
import { render, screen, fireEvent, cleanup, within, act } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { ConnectionsPanel, type ConnectionsPanelProps } from '../ConnectionsPanel'
import type { ConnectionModel, ConnectionTypeRow } from '../connectionModel'
import type { EdgeTypeDefinition } from '@/utils/edgeTypeUtils'
import { useDrawnEdgesStore } from '@/store/drawnEdges'
import { unitMeaning } from '../connectionUnits'

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
  const update = (next: Partial<ConnectionsPanelProps>) =>
    utils.rerender(<ConnectionsPanel {...props} {...next} />)
  return { ...utils, props, update }
}

/** A model built from rows alone — for the pin-reconciliation tests. */
const modelOf = (rows: ConnectionModel['rows']): ConnectionModel => ({
  rows,
  relationships: rows.reduce((n, r) => n + r.relationships, 0),
  bundles: rows.reduce((n, r) => n + r.bundles, 0),
  typeCount: rows.length,
  untyped: 0,
})

// The panel's own header, not a row's pin. Now that both say "Flows", a
// loose name match finds two: the header ("Flows 47") and the pin for the
// FLOWS_TO row ("Flows to 30"). `data-dock-header` is the marker the canvas
// itself measures the reserved band from, so it is the right handle; the
// accessible NAME is pinned separately, below.
const headerButton = () =>
  document.querySelector<HTMLElement>('button[data-dock-header]') as HTMLElement
const rowFor = (type: string) =>
  document.querySelector<HTMLElement>(`[data-connection-row="${type}"]`) as HTMLElement
const rowList = () => document.querySelector<HTMLElement>('[data-connection-rows]') as HTMLElement
const lastHighlight = (fn: ReturnType<typeof vi.fn>) => fn.mock.calls.at(-1)?.[0] as ReadonlySet<string> | null
const DIRECTION_TITLE = '→ flows with the layer order · ← flows back upstream · ⇄ both ways'

// ─── Tests ───────────────────────────────────────────────────────────────────

describe('ConnectionsPanel', () => {
  beforeEach(() => {
    useDrawnEdgesStore.setState({ drawn: 0 })
  })
  afterEach(() => {
    cleanup()
    vi.restoreAllMocks()
  })

  it('the collapsed pill reads Flows and the flow total', () => {
    mount()
    const header = headerButton()
    expect(header.textContent).toMatch(/Flows/)
    expect(header.textContent).not.toMatch(/Connections/)
    // The accessible name follows the label — a screen reader hears "Flows"
    // too. `expanded` separates it from the FLOWS_TO row's pin, which is
    // aria-pressed rather than aria-expanded.
    expect(screen.getByRole('button', { name: /^Flows/, expanded: false })).toBe(header)
    expect(header.textContent).toMatch(/47/)
    expect(header.textContent).not.toMatch(/hidden/)
  })

  it('the collapsed pill appends "· 2 hidden" while types are hidden', () => {
    mount({ hiddenTypes: new Set(['OWNS', 'TAGGED_WITH']) })
    expect(headerButton().textContent).toMatch(/47 · 2 hidden/)
  })

  it('the expanded header names the unit of every number it shows', () => {
    // The total and the drawn count are DIFFERENT units — the whole reason
    // the two numbers disagree. Each says which it is, and the line carries
    // both definitions for the reader who wants them.
    useDrawnEdgesStore.setState({ drawn: 12 })
    mount({ defaultExpanded: true })
    const line = screen.getByText('47 underlying flows · 12 lines drawn · 2 types')
    expect(line.getAttribute('title')).toContain(unitMeaning('flows'))
    expect(line.getAttribute('title')).toContain(unitMeaning('lines'))
  })

  it('a row says its count is in underlying flows', () => {
    mount({ defaultExpanded: true })
    const title = rowFor('FLOWS_TO').getAttribute('title') ?? ''
    expect(title).toContain('30 underlying flows in view carry this type')
    expect(title).toContain(unitMeaning('flows'))
  })

  it('Lineage off shows "Lineage is off" and renders no totals', () => {
    useDrawnEdgesStore.setState({ drawn: 12 })
    const { container } = mount({ lineageOn: false, defaultExpanded: true })
    expect(screen.getByText('Lineage is off')).toBeTruthy()
    expect(screen.getByText('Turn Lineage on in the header to see flows.')).toBeTruthy()
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

    // Its tooltip names the kind too — what is not drawn is flows.
    expect(hidden.getAttribute('title')).toContain('Its flows are not drawn and not counted.')

    fireEvent.click(screen.getByTitle('Show this type'))
    expect(onToggleType).toHaveBeenCalledWith('OWNS')
  })

  it('an empty board says there are no flows, not no connections', () => {
    mount({ model: modelOf([]), defaultExpanded: true })
    expect(screen.getByText('No flows in view')).toBeTruthy()
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

  // ─── Fix round 1 ───────────────────────────────────────────────────────────

  it('collapsing the panel clears a hovered highlight', () => {
    // React fires no mouseleave when the row list unmounts, so a pointer
    // resting on a row while the panel is collapsed by keyboard would leave
    // the board dimmed behind a closed panel.
    const onHighlight = vi.fn()
    mount({ defaultExpanded: true, onHighlight })
    fireEvent.mouseEnter(rowFor('FLOWS_TO'))
    expect([...(lastHighlight(onHighlight) ?? [])]).toEqual(['b1', 'b2'])

    fireEvent.click(headerButton())
    expect(lastHighlight(onHighlight)).toBeNull()
  })

  it('a pin whose type leaves the model is dropped, not re-lit later', () => {
    const onHighlight = vi.fn()
    const { update } = mount({ defaultExpanded: true, onHighlight })
    fireEvent.click(rowFor('FLOWS_TO'))
    expect([...(lastHighlight(onHighlight) ?? [])]).toEqual(['b1', 'b2'])

    // The type is hidden / the view is switched / a trace begins.
    update({ model: modelOf([MODEL.rows[1]]) })
    expect(lastHighlight(onHighlight)).toBeNull()

    // The type comes back (Show all). Nothing the user did asks for it to be
    // lit again, so the panel must stay quiet.
    onHighlight.mockClear()
    update({ model: MODEL })
    expect(onHighlight.mock.calls.every(([ids]) => ids === null)).toBe(true)
  })

  it('the row list is height-capped and scrolls on its own', () => {
    mount({ defaultExpanded: true })
    expect(rowList().className).toMatch(/max-h-\[45vh\]/)
    expect(rowList().className).toMatch(/overflow-y-auto/)
  })

  it('Only never passes the same type twice', () => {
    const onSoloType = vi.fn()
    // A transient where the projection has not yet dropped the hidden type.
    mount({ hiddenTypes: new Set(['FLOWS_TO']), defaultExpanded: true, onSoloType })
    fireEvent.click(rowFor('FLOWS_TO').querySelector<HTMLElement>('[data-connection-only]')!)
    const [, allTypes] = onSoloType.mock.calls[0] as [string, string[]]
    expect(allTypes.length).toBe(new Set(allTypes).size)
  })

  it('hidden rows sort by the label the reader sees, not the key', () => {
    const labels: Record<string, string> = { ALPHA: 'Zulu link', ZULU: 'Alpha link' }
    mount({
      model: modelOf([]),
      hiddenTypes: new Set(['ALPHA', 'ZULU']),
      defaultExpanded: true,
      resolveType: (type) => ({ ...resolveType(type), label: labels[type] ?? type }),
    })
    const order = [...document.querySelectorAll('[data-connection-row]')].map(
      (el) => el.getAttribute('data-connection-row'),
    )
    expect(order).toEqual(['ZULU', 'ALPHA'])
  })

  it('the direction split is formatted like every other number on the surface', () => {
    mount({
      model: modelOf([
        typeRow({ type: 'FLOWS_TO', relationships: 15650, bundles: 9, forward: 12000, backward: 3400, bidirectional: 250 }),
      ]),
      defaultExpanded: true,
    })
    const split = within(rowFor('FLOWS_TO')).getByTitle(
      '→ flows with the layer order · ← flows back upstream · ⇄ both ways',
    )
    expect(split.textContent).toBe(
      `→ ${(12000).toLocaleString()} · ← ${(3400).toLocaleString()} · ⇄ ${(250).toLocaleString()}`,
    )
  })

  it('the header button reports whether it is expanded', () => {
    mount()
    expect(headerButton().getAttribute('aria-expanded')).toBe('false')
    fireEvent.click(headerButton())
    expect(headerButton().getAttribute('aria-expanded')).toBe('true')
  })

  it('the pin is a real button: focus spotlights, Enter and Space pin and unpin it', async () => {
    // The row is a plain div — it holds the Eye and Only buttons, so it can
    // never be a button itself. The PIN is, which is how a screen reader
    // hears the type's name, a role, and whether it is currently pinned.
    const user = userEvent.setup()
    const onHighlight = vi.fn()
    mount({ defaultExpanded: true, onHighlight })
    const row = rowFor('FLOWS_TO')
    expect(row.getAttribute('tabindex')).toBeNull()

    const pin = within(row).getByRole('button', { name: /^Flows to/ })
    expect(pin.getAttribute('aria-pressed')).toBe('false')

    // Focus counts as hover — which is also what reveals the Only control.
    // (A real focus, not fireEvent: `user.keyboard` types into whatever the
    // document says is active.)
    act(() => pin.focus())
    expect([...(lastHighlight(onHighlight) ?? [])]).toEqual(['b1', 'b2'])

    // Enter pins it — the highlight then survives focus leaving the row.
    await user.keyboard('{Enter}')
    expect(pin.getAttribute('aria-pressed')).toBe('true')
    fireEvent.blur(pin)
    expect([...(lastHighlight(onHighlight) ?? [])]).toEqual(['b1', 'b2'])

    // Space unpins it: the native button owns both keys, so nothing here has
    // to intercept them (or preventDefault the page scroll by hand).
    act(() => pin.focus())
    await user.keyboard(' ')
    expect(pin.getAttribute('aria-pressed')).toBe('false')
    fireEvent.blur(pin)
    expect(lastHighlight(onHighlight)).toBeNull()
  })

  it('a click on the pin pins the type exactly once, not twice', () => {
    // The row div pins too (a pointer convenience: click anywhere on the
    // row), so the button's own click has to stop there — counted twice it
    // would pin and immediately unpin.
    const onHighlight = vi.fn()
    mount({ defaultExpanded: true, onHighlight })
    const pin = within(rowFor('FLOWS_TO')).getByRole('button', { name: /^Flows to/ })

    fireEvent.click(pin)
    expect(pin.getAttribute('aria-pressed')).toBe('true')
    fireEvent.mouseLeave(rowList())
    expect([...(lastHighlight(onHighlight) ?? [])]).toEqual(['b1', 'b2'])
  })

  it('says what a row does, whenever there is a row to do it to', () => {
    const hint = 'Hover a row to spotlight its lines · click to keep it lit.'
    const { unmount } = mount({ defaultExpanded: true })
    expect(screen.getByText(hint)).toBeTruthy()
    unmount()

    mount({ model: modelOf([]), hiddenTypes: new Set(['OWNS']), defaultExpanded: true })
    expect(screen.queryByText(hint)).toBeNull()
  })

  it('drops the description line when the ontology has nothing to say', () => {
    mount({
      defaultExpanded: true,
      resolveType: (type) =>
        type === 'FLOWS_TO' ? { ...resolveType(type), description: '' } : resolveType(type),
    })
    expect(rowFor('FLOWS_TO').querySelector('[data-connection-description]')).toBeNull()
    expect(rowFor('DERIVES_FROM').querySelector('[data-connection-description]')?.textContent).toBe(
      'Built out of another dataset',
    )
  })

  it('entering or leaving a trace drops the pin and the hover', () => {
    // The panel is NOT keyed on trace state — entering a trace must not
    // collapse it out from under the reader. So the pin has to be dropped
    // here: browse bundle ids mean nothing to the trace's wires, and the
    // trace's mean nothing to browse. Reconciled as the prop ARRIVES, the
    // same idiom the model reconciliation uses.
    const onHighlight = vi.fn()
    const { update } = mount({ defaultExpanded: true, onHighlight })
    fireEvent.click(rowFor('FLOWS_TO'))
    expect([...(lastHighlight(onHighlight) ?? [])]).toEqual(['b1', 'b2'])

    update({ traceMode: true })
    expect(lastHighlight(onHighlight)).toBeNull()

    // ...and on the way back out, a hover is dropped just the same.
    fireEvent.mouseEnter(rowFor('DERIVES_FROM'))
    expect([...(lastHighlight(onHighlight) ?? [])]).toEqual(['b3'])
    update({ traceMode: false })
    expect(lastHighlight(onHighlight)).toBeNull()
  })

  it('only the trace row tooltip says hiding a shared type leaves the count alone', () => {
    // Browse really does subtract — the projection drops those relationships
    // per member. A trace cannot: its lines carry a total, not a list, so
    // the reader is told rather than left to wonder why nothing moved.
    const clause =
      'During a trace, a line that carries several types keeps its full underlying-flow count when one of them is hidden.'
    const { unmount } = mount({ defaultExpanded: true })
    expect(rowFor('FLOWS_TO').getAttribute('title')).not.toMatch(/During a trace/)
    unmount()

    mount({ defaultExpanded: true, traceMode: true })
    expect(rowFor('FLOWS_TO').getAttribute('title')).toContain(clause)
  })

  it('the trace-mode footer says the toggles apply to this trace only', () => {
    const { unmount } = mount({ defaultExpanded: true })
    expect(screen.queryByText('Applies to this trace only.')).toBeNull()
    unmount()

    mount({ defaultExpanded: true, traceMode: true })
    expect(screen.getByText('Applies to this trace only.')).toBeTruthy()
  })

  // ─── Fix round 2 (live browser check) ──────────────────────────────────────

  it("the row label keeps its own line — Only never sits in the label's flow", () => {
    // Measured in Chromium at the panel's real 256px width: the label and the
    // description had computed width ZERO, squeezed out by an opacity-0 `Only`
    // button that was still taking 34px of the flex line, the count and a
    // min-width direction split. The reader saw a swatch and two numbers and
    // never the type's NAME — the one thing the row exists to say.
    mount({ defaultExpanded: true })
    const row = rowFor('FLOWS_TO')

    const label = within(row).getByText('Flows to')
    expect(label.className.split(/\s+/)).toEqual(expect.arrayContaining(['truncate', 'min-w-0', 'flex-1']))

    // `Only` is display:none until the row is hovered or holds focus, so it
    // takes no space in any line — and CSS owns that, never React state.
    const only = row.querySelector<HTMLElement>('[data-connection-only]')!
    expect(only.className.split(/\s+/)).toEqual(
      expect.arrayContaining(['hidden', 'group-hover/row:inline-flex', 'group-focus-within/row:inline-flex']),
    )

    // It takes the direction split's slot rather than a slot of its own.
    const split = within(row).getByTitle(
      '→ flows with the layer order · ← flows back upstream · ⇄ both ways',
    )
    expect(split.className.split(/\s+/)).toEqual(
      expect.arrayContaining(['group-hover/row:hidden', 'group-focus-within/row:hidden']),
    )
  })

  // ─── Fix round 3 (the dock: one surface, two panels) ───────────────────────

  it('the description wraps instead of being cut off mid-word', () => {
    // Measured at the dock's real 320px: the description was hard-truncated to
    // one line — "Many detailed flows…" — while the direction split sat on the
    // same line taking the rest of it. A sentence the ontology wrote to explain
    // the type is worth two lines; it is never worth half of one.
    mount({
      defaultExpanded: true,
      resolveType: (type) => ({
        ...resolveType(type),
        label: 'Combined flow',
        description: 'Many detailed flows between two items, shown as one connection.',
      }),
    })
    const desc = rowFor('FLOWS_TO').querySelector<HTMLElement>('[data-connection-description]')!
    expect(desc.textContent).toBe('Many detailed flows between two items, shown as one connection.')
    expect(desc.className.split(/\s+/)).toEqual(expect.arrayContaining(['line-clamp-2']))
    expect(desc.className).not.toMatch(/\btruncate\b/)
  })

  it('the description has the line to itself — the direction split never shares it', () => {
    mount({ defaultExpanded: true })
    const row = rowFor('FLOWS_TO')
    const desc = row.querySelector<HTMLElement>('[data-connection-description]')!
    const split = within(row).getByTitle(DIRECTION_TITLE)
    expect(desc.parentElement).toBe(row)
    expect(split.parentElement).not.toBe(desc.parentElement)
    expect(desc.contains(split)).toBe(false)
  })

  it('a type with nothing to say leaves no empty slot behind', () => {
    // The description is a LINE of the row, not a box inside one: with no
    // description there must be no element and no gap where one would be.
    mount({
      defaultExpanded: true,
      resolveType: (type) =>
        type === 'FLOWS_TO' ? { ...resolveType(type), description: '' } : resolveType(type),
    })
    expect(rowFor('FLOWS_TO').querySelector('[data-connection-description]')).toBeNull()
    expect(rowFor('FLOWS_TO').children).toHaveLength(2)
    expect(rowFor('DERIVES_FROM').children).toHaveLength(3)
  })

  it('a long ontology label keeps the whole top line to itself', () => {
    const label = 'Physically materialises into a downstream reporting table'
    mount({
      defaultExpanded: true,
      resolveType: (type) => ({ ...resolveType(type), label }),
    })
    const row = rowFor('FLOWS_TO')
    const labelEl = within(row).getByText(label)
    // Nothing but the swatch and the count shares the label's line, so the
    // name loses characters only when the panel itself runs out of width.
    const topLine = row.children[0]
    expect(topLine.contains(labelEl)).toBe(true)
    expect(topLine.contains(row.querySelector('[data-connection-description]')!)).toBe(false)
    expect(topLine.contains(within(row).getByTitle(DIRECTION_TITLE))).toBe(false)
  })

  it('the rows read at the Data loads card scale, and every number is tabular', () => {
    // 13px primary / 11px secondary, the same as the notification cards the
    // panel above it records — the two panels are one dock, not two designs.
    mount({ hiddenTypes: new Set(['OWNS']), defaultExpanded: true })
    const row = rowFor('FLOWS_TO')

    expect(within(row).getByText('Flows to').className).toMatch(/text-\[13px\]/)
    expect(within(row).getByText('30').className).toMatch(/text-\[13px\]/)
    expect(row.querySelector('[data-connection-description]')!.className).toMatch(/text-\[11px\]/)

    const split = within(row).getByTitle(DIRECTION_TITLE)
    expect(split.className).toMatch(/text-\[11px\]/)
    // Counts and the split are read against each other down the column.
    expect(split.className).toMatch(/tabular-nums/)
    expect(within(row).getByText('30').className).toMatch(/tabular-nums/)
    // A hidden row is still a row: same label scale, so nothing jumps.
    expect(within(rowFor('OWNS')).getByText('Owns').className).toMatch(/text-\[13px\]/)
  })
})
