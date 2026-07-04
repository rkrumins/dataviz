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
