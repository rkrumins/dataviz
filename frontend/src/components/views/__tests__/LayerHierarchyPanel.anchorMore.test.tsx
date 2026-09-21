/**
 * The wizard rail's "more" row for an ANCHORED column.
 *
 * The row used to size itself from the anchor's looked-up child count, and to
 * appear only when that count exceeded what was loaded. A lookup that failed
 * once left the count at zero — and the row, and every child past the first
 * page, simply never appeared. Now:
 *  - the server's hasMore decides; an unknown size reads "more", never zero,
 *    and the column's badge says "N+";
 *  - a failed page offers a retry, rather than looking finished;
 *  - scrolling the row into view fetches, once per growth of the column — it
 *    does not re-fire until something landed, and not while failed.
 */
import { act, render, screen, fireEvent } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { ViewLayerConfig } from '@/types/schema'
import type { UseLogicalNodesReturn } from '@/hooks/useLogicalNodes'
import type { WizardEntityIndex } from '@/components/views/ViewWizard/useWizardEntityIndex'

import { LayerHierarchyPanel, type AnchorMore, type LayerRootRow } from '../LayerHierarchyPanel'

const ANCHOR = 'urn:finance'
const layers: ViewLayerConfig[] = [
  { id: 'l1', name: 'Financial Services', entityTypes: [], order: 0, anchorUrn: ANCHOR },
]
const logicalNodes: UseLogicalNodesReturn = {
  addNode: vi.fn(), renameNode: vi.fn(), deleteNode: vi.fn(), moveNode: vi.fn(),
  toggleCollapse: vi.fn(), nodesForLayer: () => [], nodePathLabel: (_l: string, n: string) => n,
  canUndo: false, canRedo: false, undo: vi.fn(), redo: vi.fn(),
}
const index: WizardEntityIndex = {
  resolve: () => undefined,
  childrenOf: () => [],
  loadChildren: vi.fn().mockResolvedValue(undefined),
  loadMoreChildren: vi.fn().mockResolvedValue(undefined),
  isLoading: () => false,
  childPageState: () => ({ hasMore: true, failed: false }),
}

const rows = (n: number): LayerRootRow[] => Array.from({ length: n }, (_, i) => ({
  id: `urn:c${i}`, urn: `urn:c${i}`, name: `Child ${i}`, typeId: 'system', childCount: 0, rulePlaced: false,
}))

let fire: ((entries: { isIntersecting: boolean }[]) => void) | null = null

function renderRail(anchorMore: AnchorMore, held = 3) {
  const onLoadMoreAnchor = vi.fn()
  const view = render(
    <LayerHierarchyPanel
      layers={layers}
      assignments={{ [ANCHOR]: { layerId: 'l1', inheritsChildren: true } }}
      rootsByLayer={new Map([['l1', rows(held)]])}
      anchorMoreByLayer={new Map([['l1', anchorMore]])}
      onLoadMoreAnchor={onLoadMoreAnchor}
      activeTarget={null}
      logicalNodes={logicalNodes}
      entityIndex={index}
      onSetActiveTarget={vi.fn()}
      onDrop={vi.fn()}
      onUnassign={vi.fn()}
      onReorderLayers={vi.fn()}
      onAddLayer={vi.fn()}
      onRenameLayer={vi.fn()}
      onDeleteLayer={vi.fn()}
      onClearLayer={vi.fn()}
    />,
  )
  return { onLoadMoreAnchor, view }
}

describe('LayerHierarchyPanel — an anchored column past its first page', () => {
  beforeEach(() => {
    vi.useFakeTimers()
    fire = null
    vi.stubGlobal('IntersectionObserver', class {
      constructor(cb: (entries: { isIntersecting: boolean }[]) => void) { fire = cb }
      observe() {}
      unobserve() {}
      disconnect() {}
      takeRecords() { return [] }
    })
  })
  afterEach(() => {
    vi.useRealTimers()
    vi.unstubAllGlobals()
  })

  it('offers "more" when the server has more but the size is unknown — never zero', () => {
    const { onLoadMoreAnchor } = renderRail({ anchorUrn: ANCHOR, remaining: null, failed: false })
    expect(screen.getByText('In this column (3+)')).toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: /show 50 more/i }))
    expect(onLoadMoreAnchor).toHaveBeenCalledWith(ANCHOR)
  })

  it('offers a retry when the last page failed', () => {
    const { onLoadMoreAnchor } = renderRail({ anchorUrn: ANCHOR, remaining: null, failed: true })
    fireEvent.click(screen.getByRole('button', { name: /couldn't load the next/i }))
    expect(onLoadMoreAnchor).toHaveBeenCalledWith(ANCHOR)
  })

  it('fetches when scrolled into view, once per growth of the column', () => {
    const { onLoadMoreAnchor, view } = renderRail({ anchorUrn: ANCHOR, remaining: 4000, failed: false })
    const dwell = () => {
      act(() => { fire!([{ isIntersecting: true }]) })
      act(() => { vi.advanceTimersByTime(300) })
    }
    dwell()
    expect(onLoadMoreAnchor).toHaveBeenCalledTimes(1)
    dwell()                                   // nothing landed: must not re-fire
    expect(onLoadMoreAnchor).toHaveBeenCalledTimes(1)

    view.rerender(
      <LayerHierarchyPanel
        layers={layers}
        assignments={{ [ANCHOR]: { layerId: 'l1', inheritsChildren: true } }}
        rootsByLayer={new Map([['l1', rows(6)]])}              // a page landed
        anchorMoreByLayer={new Map([['l1', { anchorUrn: ANCHOR, remaining: 3997, failed: false }]])}
        onLoadMoreAnchor={onLoadMoreAnchor}
        activeTarget={null}
        logicalNodes={logicalNodes}
        entityIndex={index}
        onSetActiveTarget={vi.fn()}
        onDrop={vi.fn()}
        onUnassign={vi.fn()}
        onReorderLayers={vi.fn()}
        onAddLayer={vi.fn()}
        onRenameLayer={vi.fn()}
        onDeleteLayer={vi.fn()}
        onClearLayer={vi.fn()}
      />,
    )
    dwell()
    expect(onLoadMoreAnchor).toHaveBeenCalledTimes(2)
  })

  it('does not auto-fetch while the last page is failed', () => {
    const { onLoadMoreAnchor } = renderRail({ anchorUrn: ANCHOR, remaining: null, failed: true })
    expect(fire).toBeNull()
    act(() => { vi.advanceTimersByTime(1000) })
    expect(onLoadMoreAnchor).not.toHaveBeenCalled()
  })
})
