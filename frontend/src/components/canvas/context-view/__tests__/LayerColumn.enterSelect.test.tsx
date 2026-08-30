/**
 * Enter on a focused tree row selects that row — and must stop there.
 *
 * The column's keydown handler runs on a plain scroller <div> (tabIndex=0, no
 * role), and it neither preventDefaults nor stops propagation on Enter. The
 * native event therefore carried on past the React root to `document`, where
 * useCanvasKeyboard is listening with `enabled: true` for every canvas — so
 * one Enter both selected the row AND fired `onEdit`, opening the edit dialog
 * the user never asked for.
 *
 * Worse, `onEdit` reads the selection through a ref written during render, and
 * React has NOT flushed the `onSelect` state update by the time the event
 * reaches document — so the dialog opened on the PREVIOUSLY selected node.
 */
import { render, fireEvent } from '@testing-library/react'
import { renderHook } from '@testing-library/react'
import { describe, it, expect, vi } from 'vitest'

import { installJsdomLayout } from '@/test/canvasHarness'
import { stubSession } from '@/test/stubSearchSession'
import {
    ViewRowSearchContext,
    ViewSearchSessionContext,
} from '@/components/canvas/search/session/ViewSearchSessionContext'
import { useCanvasKeyboard } from '@/hooks/useCanvasKeyboard'
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

/** The column, with the canvas keyboard hook mounted alongside it exactly as
 *  ContextViewCanvas mounts it: on `document`, always enabled. */
function renderColumnWithCanvasKeyboard() {
    installJsdomLayout()
    const onSelect = vi.fn()
    const onEdit = vi.fn()
    renderHook(() => useCanvasKeyboard({ enabled: true, handlers: { onEdit } }))
    const session = stubSession()
    render(
        <ViewSearchSessionContext.Provider value={session}>
            <ViewRowSearchContext.Provider value={session.rowSearch}>
                <LayerColumn
                    layer={layer}
                    schema={null}
                    nodes={[node('A'), node('B')]}
                    selectedNodeId={null}
                    expandedNodes={new Set()}
                    searchResults={new Set<string>()}
                    onSelect={onSelect}
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
    const scroller = document.querySelector<HTMLElement>('.custom-scrollbar')
    if (!scroller) throw new Error('no layer scroller rendered')
    return { scroller, onSelect, onEdit }
}

describe('LayerColumn — Enter on a focused row', () => {
    it('selects the row without also firing the canvas edit shortcut', () => {
        const { scroller, onSelect, onEdit } = renderColumnWithCanvasKeyboard()

        // Roving focus starts at -1; one ArrowDown parks it on the first row.
        fireEvent.keyDown(scroller, { key: 'ArrowDown' })
        fireEvent.keyDown(scroller, { key: 'Enter' })

        expect(onSelect).toHaveBeenCalledTimes(1)
        expect(onSelect).toHaveBeenCalledWith('A')
        expect(onEdit).not.toHaveBeenCalled()
    })
})
