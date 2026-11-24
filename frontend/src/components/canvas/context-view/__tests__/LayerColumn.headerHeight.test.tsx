/**
 * Every open layer header is one height.
 *
 * A long name used to wrap and push the count under it, and a description
 * added up to two more lines, so neighbouring headers ended at different
 * heights and the rows below them did not line up. Now the title row has one
 * height whatever it holds: the name up to two lines and then an ellipsis,
 * the count and the order marks at the row's end, and the description in the
 * card the name opens. jsdom has no layout, so the height is read where it is
 * set; the Context View harness is where the headers are measured.
 */
import { fireEvent, render, screen } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'

import {
  ViewRowSearchContext,
  ViewSearchSessionContext,
} from '@/components/canvas/search/session/ViewSearchSessionContext'
import { usePersonaStore } from '@/store/persona'
import { installJsdomLayout } from '@/test/canvasHarness'
import { stubSession } from '@/test/stubSearchSession'
import type { ViewLayerConfig } from '@/types/schema'

import { LayerColumn } from '../LayerColumn'

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

describe('LayerColumn header — one height', () => {
  it('gives the title row the same height whatever the name, the description or the order', () => {
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
    expect(heights[0]).toMatch(/^\d+px$/)
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
