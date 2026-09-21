/**
 * LayerColumn — building a selection with the mouse.
 *
 * The row click used to drop its event, so a modifier could never reach the
 * store: every click was a plain single select and there was no way to hold
 * more than one entity. The column resolves the SHIFT range itself, because
 * it owns the order the rows are actually drawn in — a collapsed subtree
 * contributes nothing to a range the user can see.
 */
import { render, fireEvent } from '@testing-library/react'
import { describe, it, expect, vi, beforeEach } from 'vitest'

import { installJsdomLayout } from '@/test/canvasHarness'
import { stubSession } from '@/test/stubSearchSession'
import {
    ViewRowSearchContext,
    ViewSearchSessionContext,
} from '@/components/canvas/search/session/ViewSearchSessionContext'
import { useCanvasStore } from '@/store/canvas'
import type { ViewLayerConfig } from '@/types/schema'

import { LayerColumn } from '../LayerColumn'
import type { HierarchyNode } from '../types'

const layer: ViewLayerConfig = {
    id: 'L1', name: 'Data', entityTypes: [], order: 0, color: '#4488ff',
}

function node(id: string): HierarchyNode {
    return {
        id, urn: id, typeId: 'dataset', name: id, data: {}, children: [],
        depth: 0, entityTypeOption: 'dataset', tags: [],
    }
}

const NODES = [node('A'), node('B'), node('C'), node('D')]

function renderColumn() {
    installJsdomLayout()
    const onSelect = vi.fn()
    const onSelectRange = vi.fn()
    const session = stubSession()
    render(
        <ViewSearchSessionContext.Provider value={session}>
            <ViewRowSearchContext.Provider value={session.rowSearch}>
                <LayerColumn
                    layer={layer}
                    schema={null}
                    nodes={NODES}
                    selectedNodeId={null}
                    expandedNodes={new Set()}
                    searchResults={new Set<string>()}
                    onSelect={onSelect}
                    onSelectRange={onSelectRange}
                    onToggle={vi.fn()}
                    onContextMenu={vi.fn()}
                    onDoubleClick={vi.fn()}
                    isTracing={false}
                    traceFocusId={null}
                    traceNodes={new Set<string>()}
                    traceContextSet={new Set<string>()}
                    onRevealSearchHit={vi.fn()}
                    overscan={200}
                />
            </ViewRowSearchContext.Provider>
        </ViewSearchSessionContext.Provider>,
    )
    return { onSelect, onSelectRange }
}

/** The row card carries `layer-node-<id>`; click its rendered label. */
const clickRow = (id: string, init: Partial<MouseEvent> = {}) => {
    const row = document.getElementById(`layer-node-${id}`)
    if (!row) throw new Error(`no row rendered for ${id}`)
    fireEvent.click(row, init)
}

beforeEach(() => {
    useCanvasStore.setState({ lastNodeClick: { nodeId: null, seq: 0 } })
})

describe('LayerColumn — modifier clicks', () => {
    it('a plain click is a single select', () => {
        const { onSelect, onSelectRange } = renderColumn()
        clickRow('B')
        expect(onSelect).toHaveBeenCalledWith('B', false)
        expect(onSelectRange).not.toHaveBeenCalled()
    })

    it('cmd/ctrl-click asks to toggle rather than replace', () => {
        const { onSelect } = renderColumn()
        clickRow('B', { metaKey: true })
        expect(onSelect).toHaveBeenCalledWith('B', true)

        clickRow('C', { ctrlKey: true })
        expect(onSelect).toHaveBeenCalledWith('C', true)
    })

    it('shift-click takes every visible row from the anchor to here', () => {
        const { onSelectRange } = renderColumn()
        useCanvasStore.setState({ lastNodeClick: { nodeId: 'A', seq: 1 } })

        clickRow('C', { shiftKey: true })
        expect(onSelectRange).toHaveBeenCalledWith(['A', 'B', 'C'])
    })

    it('reads a range backwards just as well', () => {
        const { onSelectRange } = renderColumn()
        useCanvasStore.setState({ lastNodeClick: { nodeId: 'D', seq: 1 } })

        clickRow('B', { shiftKey: true })
        expect(onSelectRange).toHaveBeenCalledWith(['B', 'C', 'D'])
    })

    it('falls back to a plain select when there is no anchor to range from', () => {
        const { onSelect, onSelectRange } = renderColumn()
        // Nothing clicked yet — shift must not quietly do nothing.
        clickRow('C', { shiftKey: true })
        expect(onSelectRange).not.toHaveBeenCalled()
        expect(onSelect).toHaveBeenCalledWith('C', false)
    })

    it('falls back when the anchor belongs to another column', () => {
        const { onSelect, onSelectRange } = renderColumn()
        useCanvasStore.setState({ lastNodeClick: { nodeId: 'elsewhere', seq: 1 } })

        clickRow('C', { shiftKey: true })
        expect(onSelectRange).not.toHaveBeenCalled()
        expect(onSelect).toHaveBeenCalledWith('C', false)
    })
})
