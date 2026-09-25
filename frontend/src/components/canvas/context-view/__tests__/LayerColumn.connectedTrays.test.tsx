/**
 * The Anchor Rail's trays, and the lines that dock to them.
 *
 * The focused entity's lines to partners scrolled out of a column dock to
 * that column's tray, or to its hint pill when trays are off. Opening a tray
 * from its hint, or switching trays on or off, moves where they dock, so the
 * column asks the canvas to draw them again (`onAnimationComplete`, which
 * schedules an overlay pass). Without it the lines stayed on the old pill
 * until the next scroll.
 */
import { act, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'

import {
  ViewRowSearchContext,
  ViewSearchSessionContext,
} from '@/components/canvas/search/session/ViewSearchSessionContext'
import { useAnchorRailStore } from '@/store/anchorRail'
import { usePreferencesStore } from '@/store/preferences'
import { installJsdomLayout } from '@/test/canvasHarness'
import { stubSession } from '@/test/stubSearchSession'
import type { ViewLayerConfig } from '@/types/schema'

import { LayerColumn } from '../LayerColumn'
import type { HierarchyNode } from '../types'

const layer: ViewLayerConfig = { id: 'L1', name: 'Data', entityTypes: [], order: 0, color: '#4488ff' }

const node = (id: string): HierarchyNode => ({
  id, urn: id, typeId: 'dataset', name: id, data: { label: id }, children: [],
  depth: 0, entityTypeOption: 'dataset', tags: [],
})

afterEach(() => {
  useAnchorRailStore.getState().clear()
  usePreferencesStore.setState({ showConnectedTrays: true })
})

function renderColumn(onAnimationComplete: () => void) {
  installJsdomLayout()
  const session = stubSession({})
  render(
    <ViewSearchSessionContext.Provider value={session}>
      <ViewRowSearchContext.Provider value={session.rowSearch}>
        <LayerColumn
          layer={layer}
          schema={null}
          nodes={[node('a'), node('b')]}
          selectedNodeId={null}
          expandedNodes={new Set()}
          searchResults={new Set<string>()}
          onSelect={vi.fn()}
          onSelectRange={vi.fn()}
          onToggle={vi.fn()}
          onContextMenu={vi.fn()}
          onDoubleClick={vi.fn()}
          traceFocusId={null}
          traceNodes={new Set<string>()}
          traceContextSet={new Set<string>()}
          onRevealSearchHit={vi.fn()}
          onAnimationComplete={onAnimationComplete}
          overscan={200}
        />
      </ViewRowSearchContext.Provider>
    </ViewSearchSessionContext.Provider>,
  )
}

describe('LayerColumn — connected trays', () => {
  it('opening a tray from its hint, or switching trays, redraws the lines', () => {
    usePreferencesStore.setState({ showConnectedTrays: false })
    useAnchorRailStore.getState().publish(new Map([
      ['L1', { proxies: [{ nodeId: 'far', count: 3, color: '#888', direction: 'down' }], moreCount: 0 }],
    ]), 'a')
    const redraw = vi.fn()
    renderColumn(redraw)

    const hint = screen.getByRole('button', { name: /1 connected/ })
    redraw.mockClear()
    fireEvent.click(hint)
    expect(screen.getByText('Connected, below')).toBeInTheDocument()
    expect(redraw).toHaveBeenCalled()

    redraw.mockClear()
    act(() => { usePreferencesStore.setState({ showConnectedTrays: true }) })
    expect(redraw).toHaveBeenCalled()
  })
})
