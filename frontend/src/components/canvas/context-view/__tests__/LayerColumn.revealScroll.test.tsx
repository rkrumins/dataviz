/**
 * Where a revealed row LANDS.
 *
 * Two scrolls bring a revealed hit into view, and they have to agree. The
 * virtualizer scrolls the column to `align: 'center'`; a DOM
 * `scrollIntoView` then follows, two frames later, to bring the column
 * itself horizontally on screen. That second call also has an opinion
 * about the vertical axis, and `block: 'nearest'` is the opinion "put it
 * just barely inside the box" — which, against a smooth scroll still in
 * flight, is how a revealed row ends up at y=953 of a 1000px viewport:
 * technically visible, sitting on the fold, with nothing under it.
 *
 * Both scrolls now ask for the same thing.
 */
import { render, waitFor } from '@testing-library/react'
import { describe, it, expect, vi, afterEach, beforeEach } from 'vitest'

import {
    ViewRowSearchContext,
    ViewSearchSessionContext,
} from '@/components/canvas/search/session/ViewSearchSessionContext'
import type { ViewSearchSession } from '@/components/canvas/search/session/useViewSearchSessionController'
import { installJsdomLayout } from '@/test/canvasHarness'
import { stubSession } from '@/test/stubSearchSession'
import type { ViewLayerConfig } from '@/types/schema'

import { LayerColumn } from '../LayerColumn'
import type { HierarchyNode } from '../types'


const layer: ViewLayerConfig = {
    id: 'L1', name: 'Data', entityTypes: [], order: 0, color: '#4488ff',
}

function node(id: string, children: HierarchyNode[] = []): HierarchyNode {
    return {
        id, urn: id, typeId: 'dataset', name: id, data: {}, children,
        depth: 0, entityTypeOption: 'dataset', tags: [],
    }
}

/** A column holding a parent and the child a reveal walks down to. */
function renderColumn(session: ViewSearchSession) {
    const props = {
        layer,
        schema: null,
        nodes: [node('P', [node('C1')])],
        selectedNodeId: null,
        expandedNodes: new Set(['P']),
        searchResults: new Set<string>(),
        onSelect: vi.fn(),
        onToggle: vi.fn(),
        onContextMenu: vi.fn(),
        onDoubleClick: vi.fn(),
        traceFocusId: null,
        traceNodes: new Set<string>(),
        traceContextSet: new Set<string>(),
        isTracing: false,
        // jsdom gives the scroller a 40px viewport; without this the rows
        // sit below the virtualizer's window and never mount.
        overscan: 200,
    }
    const tree = (revealTarget: { id: string; pulse: number } | null) => (
        <ViewSearchSessionContext.Provider value={session}>
            <ViewRowSearchContext.Provider value={session.rowSearch}>
                <LayerColumn {...props} revealTarget={revealTarget} />
            </ViewRowSearchContext.Provider>
        </ViewSearchSessionContext.Provider>
    )
    const view = render(tree(null))
    return { reveal: (id: string) => view.rerender(tree({ id, pulse: 1 })) }
}

// BEFORE the spy, not after: the harness assigns
// `Element.prototype.scrollIntoView` on its FIRST call only, so a spy
// installed ahead of it is silently replaced — and the file's first test
// is the only one that ever sees it happen.
beforeEach(() => { installJsdomLayout() })
afterEach(() => { vi.restoreAllMocks() })

/** The spy the reveal's second scroll lands on. */
function watchScrollIntoView() {
    return vi.spyOn(Element.prototype, 'scrollIntoView').mockImplementation(() => {})
}


describe('LayerColumn — where a revealed row lands', () => {
    it('centres the row rather than nudging it onto the fold', async () => {
        const scrollIntoView = watchScrollIntoView()
        const { reveal } = renderColumn(stubSession())

        reveal('C1')

        await waitFor(() => expect(scrollIntoView).toHaveBeenCalled())
        expect(scrollIntoView).toHaveBeenCalledWith(
            expect.objectContaining({ block: 'center' }),
        )
    })

    // The horizontal half is the whole reason this DOM call exists: the
    // virtualizer centres the row inside its OWN column, and a column that
    // sits off-screen leaves the reader panning for it by hand.
    it('still brings the column itself horizontally on screen', async () => {
        const scrollIntoView = watchScrollIntoView()
        const { reveal } = renderColumn(stubSession())

        reveal('C1')

        await waitFor(() => expect(scrollIntoView).toHaveBeenCalled())
        expect(scrollIntoView).toHaveBeenCalledWith(
            expect.objectContaining({ inline: 'center' }),
        )
    })
})
