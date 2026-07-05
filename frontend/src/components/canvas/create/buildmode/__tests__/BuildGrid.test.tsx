/**
 * BuildGrid — the whole point of Task 7 is virtualization, so the primary
 * test here renders 1000 store rows and asserts only a windowed subset ever
 * mounts in the DOM (not 1000 row components). A light edit test then
 * confirms a cell keystroke really does reach `buildRowsStore` (not just
 * local draft state).
 *
 * `useViewEntityTypes` is mocked because BuildGrid calls it directly for the
 * Type typeahead's options (see useGraphHydration.empty.test.ts for the same
 * `vi.hoisted` + `@/hooks/useViewSchema` mocking convention).
 */
import { render, screen, fireEvent } from '@testing-library/react'
import { describe, it, expect, beforeEach, beforeAll, vi } from 'vitest'
import type { EntityTypeSchema } from '@/types/schema'
import { useReferenceModelStore } from '@/store/referenceModelStore'
import { useBuildRowsStore } from '../buildRowsStore'
import { makeRow, type BuildRow } from '../buildRow'

const { entityTypes } = vi.hoisted(() => ({
  entityTypes: [
    {
      id: 'domain',
      name: 'Domain',
      pluralName: 'Domains',
      visual: { icon: 'Globe', color: '#6366f1' },
      fields: [],
      behavior: {},
      hierarchy: { level: 0, canContain: [], canBeContainedBy: [], defaultExpanded: false, rollUpFields: [] },
    },
  ],
}))

vi.mock('@/hooks/useViewSchema', () => ({
  useViewEntityTypes: () => entityTypes,
}))

import { BuildGrid } from '../BuildGrid'

const typeById = new Map<string, EntityTypeSchema>(entityTypes.map((t) => [t.id, t as unknown as EntityTypeSchema]))

const manyRows = (n: number): BuildRow[] =>
  Array.from({ length: n }, (_, i) => makeRow({ id: `r${i}`, name: `Row ${i}`, typeId: 'domain' }))

// jsdom performs no real layout, so every element's offsetHeight/clientHeight
// defaults to 0 — the virtualizer would then compute a degenerate zero-height
// viewport (which happens to "pass" a windowing assertion for the wrong
// reason). Mocking a real viewport height here makes the assertion below
// reflect the actual row-count math (~600px / 44px-per-row + overscan),
// not an accident of jsdom's lack of layout.
beforeAll(() => {
  Object.defineProperty(HTMLElement.prototype, 'offsetHeight', { configurable: true, value: 600 })
  Object.defineProperty(HTMLElement.prototype, 'clientHeight', { configurable: true, value: 600 })
})

describe('BuildGrid virtualization', () => {
  beforeEach(() => useBuildRowsStore.getState().reset())

  it('mounts only a windowed subset of DOM rows for 1000 store rows', () => {
    useBuildRowsStore.getState().setRows(manyRows(1000))
    const { container } = render(<BuildGrid rows={useBuildRowsStore.getState().rows} typeById={typeById} />)

    const renderedRows = container.querySelectorAll('[data-build-grid-row]')
    // ~600px viewport / 44px rows + overscan(12) on each side is well under
    // 100 — nowhere near mounting all 1000 rows.
    expect(renderedRows.length).toBeGreaterThan(0)
    expect(renderedRows.length).toBeLessThan(100)
  })
})

describe('BuildGrid editing', () => {
  beforeEach(() => useBuildRowsStore.getState().reset())

  it('typing in the Name cell updates buildRowsStore', () => {
    useBuildRowsStore.getState().setRows([makeRow({ id: 'a', name: 'Alpha', typeId: 'domain' })])
    render(<BuildGrid rows={useBuildRowsStore.getState().rows} typeById={typeById} />)

    const input = screen.getByDisplayValue('Alpha')
    fireEvent.change(input, { target: { value: 'Alpha Renamed' } })

    expect(useBuildRowsStore.getState().rows.find((r) => r.id === 'a')?.name).toBe('Alpha Renamed')
  })
})

// The Layer column's default + options come from the view's OWN layers
// (`useReferenceModelStore`/`useLayers`), never hard-coded names — same
// `buildTypeLayerMap` the resolver (Task 1) uses.
describe('BuildGrid Layer column', () => {
  beforeEach(() => {
    useBuildRowsStore.getState().reset()
    useReferenceModelStore.getState().setLayers([
      { id: 'layer-1', name: 'Layer One', entityTypes: ['domain'], order: 0 },
      { id: 'layer-2', name: 'Layer Two', entityTypes: [], order: 1 },
    ])
  })

  it('defaults the Layer cell to the auto-by-type target derived from the view layers', () => {
    useBuildRowsStore.getState().setRows([makeRow({ id: 'a', name: 'Alpha', typeId: 'domain' })])
    render(<BuildGrid rows={useBuildRowsStore.getState().rows} typeById={typeById} />)

    expect(screen.getByRole('button', { name: 'Layer for Alpha' })).toHaveTextContent('Layer One')
  })

  it('picking a layer sets an override that wins over the auto-by-type default', () => {
    useBuildRowsStore.getState().setRows([makeRow({ id: 'a', name: 'Alpha', typeId: 'domain' })])
    const { rerender } = render(<BuildGrid rows={useBuildRowsStore.getState().rows} typeById={typeById} />)

    fireEvent.click(screen.getByRole('button', { name: 'Layer for Alpha' }))
    fireEvent.click(screen.getByRole('button', { name: 'Layer Two' }))

    expect(useBuildRowsStore.getState().rows.find((r) => r.id === 'a')?.layerId).toBe('layer-2')
    // BuildGrid's `rows` prop is BuildPanel's already-validated snapshot,
    // recomputed on every render from the live store — reflect that here by
    // re-rendering with the latest store snapshot (same as a real parent would).
    rerender(<BuildGrid rows={useBuildRowsStore.getState().rows} typeById={typeById} />)
    expect(screen.getByRole('button', { name: 'Layer for Alpha' })).toHaveTextContent('Layer Two')
  })

  it('clearing the override (Auto) reverts the row to the type-derived layer', () => {
    useBuildRowsStore.getState().setRows([
      { ...makeRow({ id: 'a', name: 'Alpha', typeId: 'domain' }), layerId: 'layer-2' },
    ])
    const { rerender } = render(<BuildGrid rows={useBuildRowsStore.getState().rows} typeById={typeById} />)

    expect(screen.getByRole('button', { name: 'Layer for Alpha' })).toHaveTextContent('Layer Two')

    fireEvent.click(screen.getByRole('button', { name: 'Layer for Alpha' }))
    fireEvent.click(screen.getByRole('button', { name: /^Auto/ }))

    expect(useBuildRowsStore.getState().rows.find((r) => r.id === 'a')?.layerId).toBeUndefined()
    rerender(<BuildGrid rows={useBuildRowsStore.getState().rows} typeById={typeById} />)
    expect(screen.getByRole('button', { name: 'Layer for Alpha' })).toHaveTextContent('Layer One')
  })

  // The type used here ('widget') is deliberately absent from every layer's
  // `entityTypes`, so `typeLayerMap` has no entry for it — the Grid must fall
  // back to `fallbackLayerId` (mirroring `resolveRowLayer`'s Apply-time
  // placement) instead of showing an empty '—' default.
  it('defaults an unmapped type\'s Layer cell to fallbackLayerId, matching Apply-time placement', () => {
    useBuildRowsStore.getState().setRows([makeRow({ id: 'a', name: 'Alpha', typeId: 'widget' })])
    render(<BuildGrid rows={useBuildRowsStore.getState().rows} typeById={typeById} fallbackLayerId="layer-2" />)

    expect(screen.getByRole('button', { name: 'Layer for Alpha' })).toHaveTextContent('Layer Two')
  })
})

// Task 5: a single checked row must be actionable (delete), select-all must
// select every row, and the toggle must be onChange-driven (not the old
// onChange-no-op + onClick-preventDefault pattern).
describe('BuildGrid selection', () => {
  beforeEach(() => useBuildRowsStore.getState().reset())

  const seed = () =>
    useBuildRowsStore.getState().setRows([
      makeRow({ id: 'a', name: 'Alpha', typeId: 'domain' }),
      makeRow({ id: 'b', name: 'Beta', typeId: 'domain' }),
    ])

  it('clicking a single row checkbox toggles its selection and exposes a delete action', () => {
    seed()
    render(<BuildGrid rows={useBuildRowsStore.getState().rows} typeById={typeById} />)

    expect(screen.queryByRole('button', { name: /delete/i })).not.toBeInTheDocument()

    fireEvent.click(screen.getByLabelText('Select Alpha'))

    expect(screen.getByText('1 selected')).toBeInTheDocument()
    expect(screen.getByRole('button', { name: /delete/i })).toBeInTheDocument()

    // toggling again clears it
    fireEvent.click(screen.getByLabelText('Select Alpha'))
    expect(screen.queryByText('1 selected')).not.toBeInTheDocument()
  })

  it('the header select-all checkbox selects every row', () => {
    seed()
    render(<BuildGrid rows={useBuildRowsStore.getState().rows} typeById={typeById} />)

    fireEvent.click(screen.getByLabelText('Select all rows'))

    expect(screen.getByText('2 selected')).toBeInTheDocument()
  })

  it('delete-selected removes the selected rows from the store', () => {
    seed()
    render(<BuildGrid rows={useBuildRowsStore.getState().rows} typeById={typeById} />)

    fireEvent.click(screen.getByLabelText('Select Alpha'))
    fireEvent.click(screen.getByRole('button', { name: /delete/i }))

    expect(useBuildRowsStore.getState().rows.map((r) => r.id)).toEqual(['b'])
  })
})
