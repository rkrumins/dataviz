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
import { useState } from 'react'
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

// Stable across renders, as the canvas's memoized lane nodes are: the column
// resets its roving focus whenever this array's identity changes, so a fresh
// literal per render would park focusIndex back at -1 between keystrokes.
const NODES = [node('A'), node('B')]

/** The column, with the canvas keyboard hook mounted alongside it exactly as
 *  ContextViewCanvas mounts it: on `document`, always enabled. The canvas owns
 *  the selection and feeds it back in as `selectedNodeId`, which is what tells a
 *  second Enter that the row it is on is already the selected one. */
function renderColumnWithCanvasKeyboard() {
    installJsdomLayout()
    const onSelect = vi.fn()
    const onEdit = vi.fn()
    renderHook(() => useCanvasKeyboard({ enabled: true, handlers: { onEdit } }))
    const session = stubSession()
    function Harness() {
        const [selected, setSelected] = useState<string | null>(null)
        return (
            <ViewSearchSessionContext.Provider value={session}>
                <ViewRowSearchContext.Provider value={session.rowSearch}>
                    <LayerColumn
                        layer={layer}
                        schema={null}
                        nodes={NODES}
                        selectedNodeId={selected}
                        expandedNodes={new Set()}
                        searchResults={new Set<string>()}
                        onSelect={(id) => { onSelect(id); setSelected(id) }}
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
            </ViewSearchSessionContext.Provider>
        )
    }
    render(<Harness />)
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

    it('lets the NEXT Enter through once that row is the selected one — "Enter — Edit Selected"', () => {
        // Swallowing every Enter kills the documented shortcut for anyone navigating by keyboard:
        // once focus has landed on a row, each Enter re-selects the row it is already on and is
        // eaten again, so the entity drawer can never open from the keyboard. Only the keystroke
        // that actually CHANGES the selection has a reason to end at the React root.
        const { scroller, onSelect, onEdit } = renderColumnWithCanvasKeyboard()

        fireEvent.keyDown(scroller, { key: 'ArrowDown' })
        fireEvent.keyDown(scroller, { key: 'Enter' })   // selects 'A'
        expect(onEdit).not.toHaveBeenCalled()

        fireEvent.keyDown(scroller, { key: 'Enter' })   // 'A' is already selected → edit it
        expect(onSelect).toHaveBeenCalledTimes(1)
        expect(onEdit).toHaveBeenCalledTimes(1)
    })
})
