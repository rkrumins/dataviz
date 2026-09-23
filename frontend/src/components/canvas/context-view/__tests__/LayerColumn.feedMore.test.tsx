/**
 * An open ('all') view's column pages the TYPES it holds by rule. Its foot
 * carries a column-level row for that — the way an anchored column's does for
 * its anchor — so a type with thousands of entities stays reachable instead of
 * stopping silently at the first page.
 *
 * The row asks the canvas for the next page of THIS column's feeds (by layer
 * id), says when a page failed, and is absent once the feeds are exhausted.
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

const layer: ViewLayerConfig = {
    id: 'L-domains', name: 'Domains', entityTypes: ['domain'], order: 0, color: '#4488ff',
}

function node(id: string): HierarchyNode {
    return {
        id, urn: id, typeId: 'domain', name: id, data: {}, children: [],
        depth: 0, entityTypeOption: 'domain', tags: [],
    }
}

function renderColumn(feedMore?: { loading: boolean; failed: boolean }) {
    installJsdomLayout()
    const onFeedMore = vi.fn()
    const session = stubSession()
    render(
        <ViewSearchSessionContext.Provider value={session}>
            <ViewRowSearchContext.Provider value={session.rowSearch}>
                <LayerColumn
                    layer={layer}
                    schema={null}
                    nodes={[node('Agriculture'), node('Automotive')]}
                    feedMore={feedMore}
                    onFeedMore={onFeedMore}
                    selectedNodeId={null}
                    expandedNodes={new Set()}
                    searchResults={new Set<string>()}
                    onSelect={vi.fn()}
                    onSelectRange={vi.fn()}
                    onToggle={vi.fn()}
                    onContextMenu={vi.fn()}
                    onDoubleClick={vi.fn()}
                    onLoadMore={vi.fn()}
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
    return { onFeedMore }
}

describe('LayerColumn — paging an open view by type', () => {
    it('offers more at the foot of the column and asks for THIS column', () => {
        const { onFeedMore } = renderColumn({ loading: false, failed: false })
        fireEvent.click(screen.getByRole('button', { name: 'Load more' }))
        expect(onFeedMore).toHaveBeenCalledWith('L-domains')
    })

    it('says a page failed and retries on click', () => {
        const { onFeedMore } = renderColumn({ loading: false, failed: true })
        fireEvent.click(screen.getByRole('button', { name: /couldn't load the next/i }))
        expect(onFeedMore).toHaveBeenCalledWith('L-domains')
    })

    it('draws no row once the feeds are exhausted', () => {
        renderColumn(undefined)
        expect(screen.queryByRole('button', { name: 'Load more' })).not.toBeInTheDocument()
        expect(screen.getByText('Agriculture')).toBeInTheDocument()
    })
})
