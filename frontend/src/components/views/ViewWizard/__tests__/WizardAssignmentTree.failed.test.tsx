/**
 * The Entity Browser says when a page FAILED, instead of looking empty.
 *
 * A failed expand used to be logged to the console and nothing else: the node
 * rendered expanded with no children under it — indistinguishable from a node
 * that has none. A failed "load more" looked like any other "Load more".
 *
 * Pinned here:
 *  - an expanded node whose FIRST page failed shows "Couldn't load · Retry",
 *    and Retry re-runs the first-page load (expand), not "load more";
 *  - a failed top-level page offers the same, retrying the top-level list.
 */
import { render, screen, fireEvent } from '@testing-library/react'
import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'

beforeAll(() => {
  class RO { observe() {} unobserve() {} disconnect() {} }
  ;(globalThis as { ResizeObserver?: unknown }).ResizeObserver = RO
  Object.defineProperty(HTMLElement.prototype, 'offsetHeight', { configurable: true, value: 900 })
  HTMLElement.prototype.getBoundingClientRect = function () {
    return { width: 600, height: 900, top: 0, left: 0, right: 600, bottom: 900, x: 0, y: 0, toJSON() {} } as DOMRect
  }
})

vi.mock('@/providers/GraphProviderContext', () => ({ useGraphProvider: () => ({}) }))

const fakeBrowser = {
  typeFilter: null as string | null,
  typesOnPathTo: () => null,
  topLevelIds: ['urn:a'],
  nodes: new Map([['urn:a', {
    node: { urn: 'urn:a', entityType: 'domain', displayName: 'Node A', properties: {} },
    // 4,000 children, none loaded: the first page failed.
    childIds: [] as string[], totalChildren: 4000, totalIsExact: true,
    hasMore: false, nextCursor: null, loaded: false,
  }]]),
  parentMap: new Map<string, string>(),
  isLoading: false,
  loadTopLevel: vi.fn(),
  setSearch: vi.fn(),
  setTypeFilter: vi.fn(),
  expandNode: vi.fn(),
  loadMoreChildren: vi.fn(),
  loadMoreTopLevel: vi.fn(),
  loadAllChildren: vi.fn().mockResolvedValue([] as string[]),
  loadAllTopLevel: vi.fn().mockResolvedValue(undefined),
  peekNode: (urn: string) => fakeBrowser.nodes.get(urn),
  topLevelHasMore: false,
  topLevelTotalCount: 1,
  topLevelMetadata: { rootTypeCount: 1, orphanCount: 0 },
  failedIds: new Set<string>(),
  loadingNodes: new Set<string>(),
}
vi.mock('@/hooks/useEntityBrowser', () => ({ useEntityBrowser: () => fakeBrowser }))

import { WizardAssignmentTree } from '../WizardAssignmentTree'
import type { ViewLayerConfig } from '@/types/schema'

const layers: ViewLayerConfig[] = [{ id: 'l1', name: 'Layer 1', entityTypes: [], order: 0 }]

function renderTree() {
  return render(
    <WizardAssignmentTree layers={layers} assignments={{}} onAssignmentChange={vi.fn()} onBulkAssign={vi.fn()} />,
  )
}

describe('WizardAssignmentTree — a page that failed says so', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    fakeBrowser.failedIds = new Set()
  })

  it("shows 'Couldn't load · Retry' under a node whose first page failed, and retries the FIRST page", () => {
    fakeBrowser.failedIds = new Set(['urn:a'])
    const { container } = renderTree()
    const chevron = container.querySelector('svg.lucide-chevron-right')?.closest('button')
    expect(chevron).toBeTruthy()
    fireEvent.click(chevron!)
    fakeBrowser.expandNode.mockClear()

    fireEvent.click(screen.getByRole('button', { name: /couldn't load · retry/i }))
    expect(fakeBrowser.expandNode).toHaveBeenCalledWith('urn:a')
    expect(fakeBrowser.loadMoreChildren).not.toHaveBeenCalled()
  })

  it('offers a retry when the top-level list failed to load more', () => {
    fakeBrowser.failedIds = new Set(['__top-level'])
    renderTree()
    fireEvent.click(screen.getByRole('button', { name: /couldn't load · retry/i }))
    expect(fakeBrowser.loadMoreTopLevel).toHaveBeenCalled()
  })

  it('shows no failure row when nothing failed', () => {
    renderTree()
    expect(screen.queryByRole('button', { name: /couldn't load/i })).not.toBeInTheDocument()
  })
})
