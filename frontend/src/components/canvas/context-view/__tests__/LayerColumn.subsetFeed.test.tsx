/**
 * A subset view's layer: its header counts the search's matches as the server
 * does — what the column lists, of how many — not the entities and children
 * loaded; it says when the count is still rising or the answer is a recent one;
 * an empty layer has no matches; and a capped layer says how many it shows and
 * how to reach the rest.
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

const layer: ViewLayerConfig = { id: 'L1', name: 'Tables', entityTypes: ['table'], order: 0, color: '#2563eb' }

function node(id: string, data: Record<string, unknown> = {}): HierarchyNode {
  return { id, urn: id, typeId: 'table', name: `${id} name`, data, children: [], depth: 0, entityTypeOption: 'table', tags: [] }
}

type Extra = Partial<React.ComponentProps<typeof LayerColumn>>
type Feed = NonNullable<Extra['subsetFeed']>

const feed = (over: Partial<Feed> = {}): Feed => ({
  delivered: 2, total: 2, status: 'complete', countStatus: 'exact', stale: false, asOf: null, capped: false, ...over,
})

function renderColumn(extra: Extra = {}) {
  const session = stubSession()
  const base = {
    layer, schema: null,
    // A matched table with 5,000 children: a subset counts matches, never children.
    nodes: [node('A', { childCount: 5000 }), node('B')],
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

const pill = () => screen.getByTitle(/in this layer/)

describe('LayerColumn — a subset layer', () => {
  beforeEach(() => { installJsdomLayout() })

  it('counts its matches as the server does, not the children of what it lists', () => {
    renderColumn({ subsetFeed: feed({ delivered: 2, total: 80412 }) })
    expect(pill().textContent).toBe('2/80,412')
    expect(pill().getAttribute('title')).toBe('2 of 80,412 matches in this layer')
  })

  it('a count still rising is a floor, said so', () => {
    renderColumn({ subsetFeed: feed({ delivered: 2, total: null, status: 'running', countStatus: 'lowerBound' }) })
    expect(pill().textContent).toBe('2/2+')
    expect(pill().getAttribute('title')).toBe('2 matches so far in this layer')
    expect(screen.getByLabelText('still counting')).toBeInTheDocument()
  })

  it('a recent answer says when it was read', () => {
    renderColumn({ subsetFeed: feed({ stale: true, asOf: '2026-11-03T10:42:00Z' }) })
    expect(pill().getAttribute('title')).toMatch(/— as of .+, a fresh answer is on its way$/)
  })

  it('an empty layer has no matches', () => {
    renderColumn({ nodes: [], subsetFeed: feed({ delivered: 0, total: 0 }), emptyText: 'No matches' })
    expect(screen.getByText('No matches')).toBeInTheDocument()
  })

  it('a capped layer says how many it shows, and offers the ways to the rest', () => {
    const onSearchInLayer = vi.fn()
    const onExportLayer = vi.fn()
    renderColumn({ subsetFeed: feed({ delivered: 2000, total: 80412, capped: true }), onSearchInLayer, onExportLayer })
    expect(screen.getByText('Showing 2,000 of 80,412')).toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: /Search in this layer/ }))
    expect(onSearchInLayer).toHaveBeenCalledWith('L1')
    fireEvent.click(screen.getByRole('button', { name: /Export/ }))
    expect(onExportLayer).toHaveBeenCalledWith('L1')
  })

  it('an uncapped layer offers no foot', () => {
    renderColumn({ subsetFeed: feed(), onSearchInLayer: vi.fn() })
    expect(screen.queryByRole('button', { name: /Search in this layer/ })).not.toBeInTheDocument()
  })
})
