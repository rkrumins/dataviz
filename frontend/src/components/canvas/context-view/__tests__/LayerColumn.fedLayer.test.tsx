/**
 * A list or subset view's layer, which pages to its end however many rows it has: its header
 * says how much of it is loaded; its foot row names the next page and what is still to come;
 * it offers the one sort it can keep as it loads; while its first page is on its way it shows
 * ghosts, and with none it says "No members"; a failed page says so, with a Retry; matches of
 * the canvas's search it hasn't loaded are counted, with ways to them; and it tells the canvas
 * how far its reader is from the end of what it holds.
 */
import { fireEvent, render, screen } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'

import {
  ViewRowSearchContext,
  ViewSearchSessionContext,
} from '@/components/canvas/search/session/ViewSearchSessionContext'
import { installJsdomLayout } from '@/test/canvasHarness'
import { stubSession } from '@/test/stubSearchSession'
import type { ViewLayerConfig } from '@/types/schema'

import { LayerColumn } from '../LayerColumn'
import type { HierarchyNode } from '../types'

// A list view's layer names no types or rules of its own: its members come from the server.
const layer: ViewLayerConfig = { id: 'L1', name: 'Tables', entityTypes: [], order: 0, color: '#2563eb' }

function node(id: string): HierarchyNode {
  return { id, urn: id, typeId: 'table', name: `${id} name`, data: {}, children: [], depth: 0, entityTypeOption: 'table', tags: [] }
}

type Extra = Partial<React.ComponentProps<typeof LayerColumn>>
type Feed = NonNullable<Extra['subsetFeed']>
const feed = (over: Partial<Feed> = {}): Feed => ({
  delivered: 1200, total: 50820, status: 'complete', countStatus: 'exact', stale: false, asOf: null, capped: false, ...over,
})

function renderColumn(extra: Extra = {}) {
  const session = stubSession()
  const base = {
    layer, schema: null, nodes: [node('A'), node('B')],
    selectedNodeId: null, expandedNodes: new Set<string>(), searchResults: new Set<string>(),
    onSelect: vi.fn(), onSelectRange: vi.fn(), onToggle: vi.fn(), onContextMenu: vi.fn(), onDoubleClick: vi.fn(),
    traceFocusId: null, traceNodes: new Set<string>(), traceContextSet: new Set<string>(), isTracing: false, overscan: 200,
  }
  return render(
    <ViewSearchSessionContext.Provider value={session}>
      <ViewRowSearchContext.Provider value={session.rowSearch}>
        <LayerColumn {...base} {...extra} />
      </ViewRowSearchContext.Provider>
    </ViewSearchSessionContext.Provider>,
  )
}

describe('LayerColumn — a list or subset view’s layer', () => {
  beforeEach(() => { installJsdomLayout() })

  it('says how much of a large layer is loaded', () => {
    renderColumn({ subsetFeed: feed() })
    expect(screen.getByTitle(/in this layer/).textContent).toBe('1,200 of 50,820 loaded')
  })

  it('all of it loaded, the count alone', () => {
    renderColumn({ subsetFeed: feed({ delivered: 2, total: 2 }) })
    expect(screen.getByTitle(/in this layer/).textContent).toBe('2')
  })

  it('its foot row names the next page and what is still to come', () => {
    const onFeedMore = vi.fn()
    renderColumn({
      subsetFeed: feed(), onFeedMore,
      feedMore: { loading: false, failed: false, remaining: 49_620, types: [], pageRows: 500 },
    })
    const row = screen.getByRole('button', { name: 'Load 500 more · 49,620 to go' })
    expect(row).toHaveTextContent('Load 500 more · 49,620 to go')
    fireEvent.click(row)
    expect(onFeedMore).toHaveBeenCalledWith('L1')
  })

  it('offers the one sort it can keep as it loads, in place of the sort menu', () => {
    renderColumn({ subsetFeed: feed(), onSetSortMode: vi.fn(), sortModesOffered: ['alpha-asc'] })
    expect(screen.getByRole('img', { name: 'Sorted by name as they load' })).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: /^Sort Tables/ })).not.toBeInTheDocument()
  })

  it('every sort, where it offers more than one', () => {
    renderColumn({ onSetSortMode: vi.fn() })
    expect(screen.getByRole('button', { name: /^Sort Tables/ })).toBeInTheDocument()
  })

  it('shows ghosts while its first page is on its way, and with none says “No members”', () => {
    const { unmount } = renderColumn({ nodes: [], feedPending: true, emptyText: 'No members' })
    expect(screen.getByText('Loading Tables entities…')).toBeInTheDocument()
    expect(screen.queryByText('No members')).not.toBeInTheDocument()
    unmount()
    renderColumn({ nodes: [], subsetFeed: feed({ delivered: 0, total: 0 }), emptyText: 'No members' })
    expect(screen.getByText('No members')).toBeInTheDocument()
  })

  it('a layer whose first page failed says so in place of its rows, with a Retry', () => {
    const onRetry = vi.fn()
    renderColumn({
      nodes: [], subsetFeed: feed({ delivered: 0, total: null, countStatus: 'lowerBound' }),
      feedMore: { loading: false, failed: false, remaining: null, types: [], pageRows: 500 },
      feedFailed: { message: 'The server is busy right now.', onRetry },
    })
    expect(screen.getByRole('alert')).toHaveTextContent('Couldn’t load this layer')
    expect(screen.getByText('The server is busy right now.')).toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: /Retry/ }))
    expect(onRetry).toHaveBeenCalledTimes(1)
  })

  it('a later page that failed is said on its foot row, whose click retries it', () => {
    const onRetry = vi.fn()
    const onFeedMore = vi.fn()
    renderColumn({
      subsetFeed: feed(), onFeedMore,
      feedMore: { loading: false, failed: false, remaining: 49_620, types: [], pageRows: 500 },
      feedFailed: { message: 'The server is busy right now.', onRetry },
    })
    expect(screen.queryByRole('alert')).not.toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: /couldn't load the next 500/i }))
    expect(onRetry).toHaveBeenCalledTimes(1)
    expect(onFeedMore).not.toHaveBeenCalled()
  })

  it('counts the matches of the search it hasn’t loaded, with ways to them', () => {
    const onNarrow = vi.fn()
    const onExport = vi.fn()
    renderColumn({ subsetFeed: feed(), notLoadedMatches: { count: 1240, onNarrow, onExport } })
    expect(screen.getByText('1,240 matches not loaded')).toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: /Narrow/ }))
    fireEvent.click(screen.getByRole('button', { name: /Export/ }))
    expect(onNarrow).toHaveBeenCalledTimes(1)
    expect(onExport).toHaveBeenCalledTimes(1)
  })

  it('past the canvas’s soft ceiling, says it loads on as it is scrolled', () => {
    renderColumn({
      subsetFeed: feed(), largeLayer: { loaded: 60_000 },
      feedMore: { loading: false, failed: false, remaining: 49_620, types: [], pageRows: 500 },
    })
    expect(screen.getByText(/60,000 rows on the canvas — the rest of this layer loads as you scroll to its end/)).toBeInTheDocument()
  })

  it('tells the canvas how many rows lie below what it shows — and nothing once it goes', () => {
    const onVisibleRows = vi.fn()
    const { unmount, container } = renderColumn({ subsetFeed: feed(), onVisibleRows })
    // Not laid out yet: nothing said. Once it scrolls, where it stands.
    expect(onVisibleRows).not.toHaveBeenCalledWith('L1', expect.any(Number))
    fireEvent.scroll(container.querySelector('.overflow-y-auto')!)
    expect(onVisibleRows).toHaveBeenCalledWith('L1', expect.any(Number))
    unmount()
    expect(onVisibleRows).toHaveBeenLastCalledWith('L1', null)
  })

  it('reads nothing ahead while it is tracing', () => {
    const onVisibleRows = vi.fn()
    renderColumn({ subsetFeed: feed(), onVisibleRows, isTracing: true })
    expect(onVisibleRows.mock.calls.every(([, below]) => below === null)).toBe(true)
  })
})
