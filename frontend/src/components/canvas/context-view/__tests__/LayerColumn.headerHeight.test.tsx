/**
 * Every open layer header is one height — at each of Display › Header size's
 * sizes.
 *
 * A long name used to wrap and push the count under it, and a description
 * added up to two more lines, so neighbouring headers ended at different
 * heights and the rows below them did not line up. Now the title row has one
 * height whatever it holds: the name up to its lines and then an ellipsis,
 * the count and the order marks at the row's end, and the description in the
 * card the name opens. jsdom has no layout, so the height is read where it is
 * set; the Context View harness is where the headers are measured.
 */
import { fireEvent, render, screen } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import {
  ViewRowSearchContext,
  ViewSearchSessionContext,
} from '@/components/canvas/search/session/ViewSearchSessionContext'
import { usePersonaStore } from '@/store/persona'
import { usePreferencesStore, type CanvasHeaderSize } from '@/store/preferences'
import { installJsdomLayout } from '@/test/canvasHarness'
import { stubSession } from '@/test/stubSearchSession'
import type { ViewLayerConfig } from '@/types/schema'

import { LayerColumn } from '../LayerColumn'
import { layerHeaderTokens } from '../density'

const SHORT = 'BI'
const LONG = 'Curated reporting marts for finance and the executive leadership team'
const UNBROKEN = 'Averyveryverylongnamewithnospacesatallthatkeepsgoing'
const ABOUT = 'Where every record starts: the tills, the web shop and the CRM'

function renderHeader(layer: Partial<ViewLayerConfig>, extra: Partial<React.ComponentProps<typeof LayerColumn>> = {}) {
  const session = stubSession()
  const full: ViewLayerConfig = { id: 'L1', name: SHORT, entityTypes: [], order: 0, color: '#4488ff', ...layer }
  const utils = render(
    <ViewSearchSessionContext.Provider value={session}>
      <ViewRowSearchContext.Provider value={session.rowSearch}>
        <LayerColumn
          layer={full} schema={null} nodes={[]} selectedNodeId={null}
          expandedNodes={new Set<string>()} searchResults={new Set<string>()}
          onSelect={vi.fn()} onSelectRange={vi.fn()} onToggle={vi.fn()} onContextMenu={vi.fn()}
          onDoubleClick={vi.fn()} traceFocusId={null} traceNodes={new Set<string>()}
          traceContextSet={new Set<string>()} overscan={200}
          onRenameLayer={vi.fn()} onSetSortMode={vi.fn()} onFoldChange={vi.fn()}
          {...extra}
        />
      </ViewRowSearchContext.Provider>
    </ViewSearchSessionContext.Provider>,
  )
  return { ...utils, layer: full }
}

/** The height the open header's title row is given. */
function titleRowHeight(name: string): string {
  const header = screen.getByRole('group', { name })
  const row = [...header.children].find((el): el is HTMLElement => el instanceof HTMLElement && !!el.style.height)
  expect(row, 'the title row has a set height').toBeDefined()
  return row!.style.height
}

beforeEach(() => {
  installJsdomLayout()
  usePersonaStore.setState({ mode: 'technical' })
})
afterEach(() => usePreferencesStore.setState({ canvasHeaderSize: 'comfortable' }))

const SIZES: CanvasHeaderSize[] = ['compact', 'comfortable', 'spacious']

describe('LayerColumn header — one height', () => {
  it.each(SIZES)('gives the title row the same height whatever the name, the description or the order (%s)', (size) => {
    usePreferencesStore.setState({ canvasHeaderSize: size })
    const heights: string[] = []
    for (const [layer, extra] of [
      [{ name: SHORT }, {}],
      [{ name: LONG }, {}],
      [{ name: UNBROKEN }, {}],
      [{ name: SHORT, description: ABOUT }, {}],
      [{ name: LONG, properties: { owner: 'data-eng' } }, {}],
      [{ name: SHORT }, { sortMode: 'custom' }],
      [{ name: LONG }, { sortMode: 'alpha-desc' }],
    ] as Array<[Partial<ViewLayerConfig>, Partial<React.ComponentProps<typeof LayerColumn>>]>) {
      const { unmount } = renderHeader(layer, extra)
      heights.push(titleRowHeight(layer.name!))
      unmount()
    }
    expect(new Set(heights).size).toBe(1)
    expect(heights[0]).toBe(`${layerHeaderTokens(size).rowPx}px`)
  })

  it('draws each size at its own height, Comfortable as the header has always been', () => {
    const rows = SIZES.map((size) => {
      usePreferencesStore.setState({ canvasHeaderSize: size })
      const { unmount } = renderHeader({ name: LONG })
      const row = titleRowHeight(LONG)
      unmount()
      return row
    })
    expect(new Set(rows).size).toBe(3)
    expect(SIZES.map((size) => layerHeaderTokens(size).heightPx)).toEqual([45, 64, 71])

    // Comfortable, the default: the 39px row, `py-3`, the 36px tile and two lines of a 14px name.
    usePreferencesStore.setState({ canvasHeaderSize: 'comfortable' })
    renderHeader({ name: LONG })
    expect(titleRowHeight(LONG)).toBe('39px')
    const header = screen.getByRole('group', { name: LONG })
    expect(header.className).toMatch(/\bpx-4 py-3\b/)
    expect(header.querySelector('.w-9.h-9.rounded-xl')).not.toBeNull()
    expect(screen.getByRole('heading', { name: LONG }).className).toMatch(/\btext-sm\b.*\bline-clamp-2\b/)
  })

  it('gives a compact header one line of name, and a spacious one a larger name and icon', () => {
    usePreferencesStore.setState({ canvasHeaderSize: 'compact' })
    const { unmount } = renderHeader({ name: LONG })
    expect(screen.getByRole('heading', { name: LONG }).className).toMatch(/\bline-clamp-1\b/)
    expect(screen.getByRole('group', { name: LONG }).className).toMatch(/\bpy-2\b/)
    expect(screen.getByRole('group', { name: LONG }).querySelector('.w-7.h-7')).not.toBeNull()
    unmount()

    usePreferencesStore.setState({ canvasHeaderSize: 'spacious' })
    renderHeader({ name: LONG })
    expect(screen.getByRole('heading', { name: LONG }).className).toMatch(/\btext-\[15px\].*\bline-clamp-2\b/)
    expect(screen.getByRole('group', { name: LONG }).className).toMatch(/\bpy-3\.5\b/)
    expect(screen.getByRole('group', { name: LONG }).querySelector('.w-10.h-10')).not.toBeNull()
  })

  it('lands a folded layer’s lines below a header of the size the open columns have', () => {
    for (const size of SIZES) {
      usePreferencesStore.setState({ canvasHeaderSize: size })
      const node = { id: 'a', urn: 'a', typeId: 'dataset', name: 'a', data: {}, children: [], depth: 0, entityTypeOption: 'dataset', tags: [] }
      const { container, unmount } = renderHeader({ name: SHORT }, {
        nodes: [node] as never, isFolded: true, foldPorts: new Map([['a', { in: 1, out: 0 }]]),
      })
      const anchors = container.querySelector<HTMLElement>('[data-fold-anchor]')!.parentElement!
      expect(anchors.style.top).toBe(`${layerHeaderTokens(size).heightPx}px`)
      unmount()
    }
  })

  it('keeps that height while the name is being changed', () => {
    renderHeader({ name: LONG })
    const before = titleRowHeight(LONG)
    fireEvent.click(screen.getByRole('button', { name: `Rename ${LONG}` }))
    expect(screen.getByRole('textbox', { name: `Rename ${LONG}` })).toBeInTheDocument()
    expect(titleRowHeight(LONG)).toBe(before)
  })

  it('caps the name at two lines, beside the count rather than over it', () => {
    renderHeader({ name: LONG })
    const name = screen.getByRole('heading', { name: LONG })
    expect(name.className).toMatch(/line-clamp-2/)
    const count = screen.getByTitle(/entities in the tree/)
    // One row: the title and the count are never wrapped onto separate lines.
    const box = name.parentElement!.parentElement!
    expect(box.contains(count)).toBe(true)
    expect(box.className).not.toMatch(/flex-wrap/)
  })
})

describe('LayerColumn header — what moved out of the row', () => {
  it('shows a description in the card the name opens, and marks that there is one', () => {
    renderHeader({ name: SHORT, description: ABOUT })
    const mark = screen.getByRole('img', { name: 'Has a description' })
    // Beside the name, never inside its clamp, where a long name's ellipsis would hide it.
    expect(screen.getByRole('heading', { name: SHORT }).contains(mark)).toBe(false)
    // Read out, but not printed in the header.
    expect(screen.getByText(ABOUT).className).toMatch(/sr-only/)
    fireEvent.mouseEnter(screen.getByRole('heading', { name: SHORT }).parentElement!)
    return screen.findByRole('tooltip').then((card) => expect(card).toHaveTextContent(ABOUT))
  })

  it('marks a custom order with a compact mark that says so, not a worded pill', () => {
    renderHeader({ name: SHORT }, { sortMode: 'custom' })
    expect(screen.getByRole('img', { name: 'Custom order' })).toBeInTheDocument()
    expect(screen.queryByText('Custom')).toBeNull()
  })

  it('leaves a folded layer’s spine to fill its column', () => {
    renderHeader({ name: LONG }, { isFolded: true })
    expect(screen.queryByRole('heading', { name: LONG })).toBeNull()
    const spine = screen.getByLabelText(new RegExp(`^Unfold ${LONG}`))
    expect([...spine.children].some((el) => !!(el as HTMLElement).style.height)).toBe(false)
  })
})
