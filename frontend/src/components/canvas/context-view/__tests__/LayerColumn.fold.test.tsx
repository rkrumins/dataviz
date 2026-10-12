/**
 * A FOLDED column — a spine the canvas's fold window made of it.
 *
 * What it must do is narrow and all of it is about lineage: a line into a
 * folded layer has to land somewhere (the fold anchors), the spine has to
 * say how much lineage it holds, and a reveal into it must survive the
 * fold rather than scroll a list that is not there.
 */
import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import {
    ViewRowSearchContext,
    ViewSearchSessionContext,
} from '@/components/canvas/search/session/ViewSearchSessionContext'
import { installJsdomLayout } from '@/test/canvasHarness'
import { stubSession } from '@/test/stubSearchSession'
import type { ViewLayerConfig } from '@/types/schema'

import { LayerColumn } from '../LayerColumn'
import type { HierarchyNode } from '../types'


const layer: ViewLayerConfig = {
    id: 'L1', name: 'Report', entityTypes: [], order: 0, color: '#e11d48',
}

function node(id: string, children: HierarchyNode[] = []): HierarchyNode {
    return {
        id, urn: id, typeId: 'dataset', name: `${id} name`, data: {}, children,
        depth: 0, entityTypeOption: 'dataset', tags: [],
    }
}

type Extra = Partial<React.ComponentProps<typeof LayerColumn>>

function renderColumn(extra: Extra = {}) {
    const session = stubSession()
    const base = {
        layer,
        schema: null,
        nodes: [node('A'), node('B'), node('C')],
        selectedNodeId: null,
        expandedNodes: new Set<string>(),
        searchResults: new Set<string>(),
        onSelect: vi.fn(),
        onSelectRange: vi.fn(),
        onToggle: vi.fn(),
        onContextMenu: vi.fn(),
        onDoubleClick: vi.fn(),
        traceFocusId: null,
        traceNodes: new Set<string>(),
        traceContextSet: new Set<string>(),
        isTracing: false,
        overscan: 200,
    }
    const tree = (more: Extra) => (
        <ViewSearchSessionContext.Provider value={session}>
            <ViewRowSearchContext.Provider value={session.rowSearch}>
                <LayerColumn {...base} {...extra} {...more} />
            </ViewRowSearchContext.Provider>
        </ViewSearchSessionContext.Provider>
    )
    const view = render(tree({}))
    return { ...view, rerenderWith: (more: Extra) => view.rerender(tree(more)) }
}

const anchors = (container: HTMLElement) =>
    [...container.querySelectorAll<HTMLElement>('[data-fold-anchor]')]

beforeEach(() => { installJsdomLayout() })
afterEach(() => { vi.restoreAllMocks() })


describe('LayerColumn — folded into a spine', () => {
    it('renders no rows, and one anchor per row a line lands on, under the row’s own id', () => {
        const { container } = renderColumn({
            isFolded: true,
            onFoldChange: vi.fn(),
            foldPorts: new Map([['B', { in: 2, out: 0 }], ['C', { in: 0, out: 1 }]]),
        })

        const found = anchors(container)
        expect(found.map(a => a.id)).toEqual(['layer-node-B', 'layer-node-C'])
        // The row's name rides along for the edge overlay's hover card.
        expect(found.map(a => a.getAttribute('data-label'))).toEqual(['B name', 'C name'])
        // Anchors are the only elements carrying these ids — no row for A,
        // and no second element for B or C.
        expect(container.querySelectorAll('[id^="layer-node-"]')).toHaveLength(2)
    })

    it('pins arriving lines on the left edge and leaving lines on the right', () => {
        const { container } = renderColumn({
            isFolded: true,
            onFoldChange: vi.fn(),
            foldPorts: new Map([['B', { in: 1, out: 0 }], ['C', { in: 0, out: 3 }]]),
        })
        const [b, c] = anchors(container)
        expect(b.querySelectorAll('span')).toHaveLength(1)
        expect(b.querySelector('span')!.className).toContain('left-0')
        expect(c.querySelector('span')!.className).toContain('right-0')
    })

    it('is one button that unfolds the layer, by click or by key', () => {
        const onFoldChange = vi.fn()
        renderColumn({ isFolded: true, onFoldChange })

        const spine = screen.getByRole('button', { name: /^Unfold Report/ })
        fireEvent.click(spine)
        expect(onFoldChange).toHaveBeenLastCalledWith('L1', false)

        onFoldChange.mockClear()
        fireEvent.keyDown(spine, { key: 'Enter' })
        expect(onFoldChange).toHaveBeenLastCalledWith('L1', false)
    })

    it('says how many lines land on it, in the right number', () => {
        renderColumn({
            isFolded: true,
            onFoldChange: vi.fn(),
            foldPorts: new Map([['B', { in: 1, out: 0 }]]),
        })
        expect(screen.getByRole('button', { name: /1 line from the open layers lands here/ })).toBeInTheDocument()
    })

    it('still speaks for lines that run only to other folded layers', () => {
        renderColumn({ isFolded: true, onFoldChange: vi.fn(), foldUndrawnLines: 3 })
        expect(screen.getByRole('button', { name: /3 lines run to other folded layers/ })).toBeInTheDocument()
    })
})


describe('LayerColumn — the fold control', () => {
    it('offers to fold an open column when the canvas can fold it', () => {
        const onFoldChange = vi.fn()
        renderColumn({ onFoldChange })
        fireEvent.click(screen.getByTitle('Fold this layer'))
        expect(onFoldChange).toHaveBeenCalledWith('L1', true)
    })

    it('has no fold control when nobody can act on it', () => {
        renderColumn()
        expect(screen.queryByTitle('Fold this layer')).toBeNull()
    })

    it('renders no anchors while open', () => {
        const { container } = renderColumn({
            onFoldChange: vi.fn(),
            foldPorts: new Map([['B', { in: 1, out: 0 }]]),
        })
        expect(anchors(container)).toHaveLength(0)
    })
})


describe('LayerColumn — a reveal into a folded layer', () => {
    it('waits for the layer to open instead of spending the reveal on the spine', async () => {
        const scrollIntoView = vi.spyOn(Element.prototype, 'scrollIntoView').mockImplementation(() => {})
        const { rerenderWith } = renderColumn({ isFolded: true, onFoldChange: vi.fn() })

        rerenderWith({ isFolded: true, revealTarget: { id: 'C', pulse: 1 } })
        await new Promise(r => setTimeout(r, 250))
        expect(scrollIntoView).not.toHaveBeenCalled()

        rerenderWith({ isFolded: false, revealTarget: { id: 'C', pulse: 1 } })
        await waitFor(() => expect(scrollIntoView).toHaveBeenCalled())
    })
})
