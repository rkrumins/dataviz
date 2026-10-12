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

function renderColumn(
    anchorMore?: { anchorUrn: string; remaining: number },
    opts: { nodes?: HierarchyNode[]; anchorIssue?: 'missing' | 'duplicate'; failedNodes?: Set<string> } = {},
) {
    installJsdomLayout()
    const onLoadMore = vi.fn()
    const session = stubSession()
    render(
        <ViewSearchSessionContext.Provider value={session}>
            <ViewRowSearchContext.Provider value={session.rowSearch}>
                <LayerColumn
                    layer={layer}
                    schema={null}
                    nodes={opts.nodes ?? NODES}
                    anchorMore={anchorMore}
                    anchorIssue={opts.anchorIssue}
                    failedNodes={opts.failedNodes}
                    selectedNodeId={null}
                    expandedNodes={new Set()}
                    searchResults={new Set<string>()}
                    onSelect={vi.fn()}
                    onSelectRange={vi.fn()}
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

    it('offers the first page when it never arrived, instead of calling the column empty', () => {
        // Hydration leaves a failed first page to the column; the column must
        // still have a row to ask again with.
        renderColumn({ anchorUrn: ANCHOR, remaining: 300 }, { nodes: [] })
        expect(screen.getByRole('button', { name: /Load 100 more of 300 remaining/ })).toBeInTheDocument()
        expect(screen.queryByText(/No assigned entities yet/i)).not.toBeInTheDocument()
    })

    it('says the page failed and waits for a Retry', () => {
        renderColumn({ anchorUrn: ANCHOR, remaining: 300 }, { nodes: [], failedNodes: new Set([ANCHOR]) })
        expect(screen.getByRole('button', { name: /couldn't load the next 100\. retry/i })).toBeInTheDocument()
    })

    it('shows nothing extra once the column holds the lot', () => {
        renderColumn(undefined)
        expect(screen.getByText('Payments')).toBeInTheDocument()
        expect(screen.queryByText(/more/i)).not.toBeInTheDocument()
    })
})

describe('LayerColumn — an anchored column that can never fill', () => {
    // Both render as an ordinary empty column otherwise, and "No assigned
    // entities yet" is untrue in both: the column was built around an entity,
    // and why it is empty has nothing to do with assignment.
    it('says so when the entity was deleted at source', () => {
        renderColumn(undefined, { nodes: [], anchorIssue: 'missing' })
        expect(screen.getByText(/entity is gone/i)).toBeInTheDocument()
        expect(screen.getByText(/removed from the source/i)).toBeInTheDocument()
        expect(screen.queryByText(/No assigned entities yet/i)).not.toBeInTheDocument()
    })

    it('says so when another column already holds that entity', () => {
        renderColumn(undefined, { nodes: [], anchorIssue: 'duplicate' })
        expect(screen.getByText(/Another column holds this entity/i)).toBeInTheDocument()
        expect(screen.getByText(/only the first can show it/i)).toBeInTheDocument()
    })

    it('keeps the ordinary empty state for an ordinary empty column', () => {
        renderColumn(undefined, { nodes: [] })
        expect(screen.getByText(/No assigned entities yet/i)).toBeInTheDocument()
    })
})
