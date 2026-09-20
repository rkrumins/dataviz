/**
 * An ANCHORED column draws the anchor's children as its rows, so the anchor row
 * that normally carries "Load more" is never on screen. Without a column-level
 * one, a 5000-child container rendered its first page and silently swallowed
 * the rest — nothing left to expand.
 *
 * The row stands in for the anchor, so clicking it routes into exactly the same
 * paged `loadChildren(anchorUrn)` every expandable row already uses.
 */
import { render, screen, fireEvent } from '@testing-library/react'
import { describe, it, expect, vi } from 'vitest'

import { installJsdomLayout } from '@/test/canvasHarness'
import { stubSession } from '@/test/stubSearchSession'
import {
    ViewRowSearchContext,
    ViewSearchSessionContext,
} from '@/components/canvas/search/session/ViewSearchSessionContext'
import type { ViewLayerConfig } from '@/types/schema'

import { LayerColumn } from '../LayerColumn'
import type { HierarchyNode } from '../types'

const ANCHOR = 'urn:finance'
const layer: ViewLayerConfig = {
    id: 'L1', name: 'Financial Services', entityTypes: [], order: 0, color: '#4488ff',
    anchorUrn: ANCHOR,
}

function node(id: string): HierarchyNode {
    return {
        id, urn: id, typeId: 'dataset', name: id, data: {}, children: [],
        depth: 0, entityTypeOption: 'dataset', tags: [],
    }
}

/** The anchor's first page, already promoted into the column's rows. */
const NODES = [node('Payments'), node('Ledger')]

function renderColumn(anchorMore?: { anchorUrn: string; remaining: number }) {
    installJsdomLayout()
    const onLoadMore = vi.fn()
    const session = stubSession()
    render(
        <ViewSearchSessionContext.Provider value={session}>
            <ViewRowSearchContext.Provider value={session.rowSearch}>
                <LayerColumn
                    layer={layer}
                    schema={null}
                    nodes={NODES}
                    anchorMore={anchorMore}
                    selectedNodeId={null}
                    expandedNodes={new Set()}
                    searchResults={new Set<string>()}
                    onSelect={vi.fn()}
                    onToggle={vi.fn()}
                    onContextMenu={vi.fn()}
                    onDoubleClick={vi.fn()}
                    onLoadMore={onLoadMore}
                    isTracing={false}
                    traceFocusId={null}
                    traceNodes={new Set<string>()}
                    traceContextSet={new Set<string>()}
                    onRevealSearchHit={vi.fn()}
                    overscan={200}
                />
            </ViewRowSearchContext.Provider>
        </ViewSearchSessionContext.Provider>
    )
    return { onLoadMore }
}

describe('LayerColumn — paging an anchored column', () => {
    it('renders the page it was given', () => {
        renderColumn({ anchorUrn: ANCHOR, remaining: 4998 })
        expect(screen.getByText('Payments')).toBeInTheDocument()
        expect(screen.getByText('Ledger')).toBeInTheDocument()
    })

    it('offers the remainder, which the anchor row can no longer do', () => {
        renderColumn({ anchorUrn: ANCHOR, remaining: 4998 })
        expect(screen.getByRole('button', { name: /Load 100 more of 4,998 remaining/ })).toBeInTheDocument()
    })

    it('asks the ANCHOR for the next page, not one of the rows', () => {
        // LoadMoreItem keys off node.id; standing in for the anchor is what puts
        // the click on the same paged path as every expandable row.
        const { onLoadMore } = renderColumn({ anchorUrn: ANCHOR, remaining: 4998 })
        fireEvent.click(screen.getByRole('button', { name: /Load 100 more/ }))
        expect(onLoadMore).toHaveBeenCalled()
        expect(onLoadMore.mock.calls[0][0]).toBe(ANCHOR)
    })

    it('shows nothing extra once the column holds the lot', () => {
        renderColumn(undefined)
        expect(screen.getByText('Payments')).toBeInTheDocument()
        expect(screen.queryByText(/more/i)).not.toBeInTheDocument()
    })
})
