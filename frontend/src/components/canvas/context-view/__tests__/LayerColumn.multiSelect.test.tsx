/**
 * LayerColumn — building a selection with the mouse and the keyboard.
 *
 * The row click used to drop its event, so a modifier could never reach the
 * store: every click was a plain single select and there was no way to hold
 * more than one entity. The column resolves the SHIFT range itself, because
 * it owns the order the rows are actually drawn in — a collapsed subtree
 * contributes nothing to a range the user can see — and ADDS it to what is
 * already held, which may be in another column.
 */
import { render, fireEvent } from '@testing-library/react'
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import type { ComponentProps } from 'react'

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

function renderColumn(extra: Partial<ComponentProps<typeof LayerColumn>> = {}) {
    installJsdomLayout()
    const onSelect = vi.fn()
    const onSelectRange = vi.fn()
    const onContextMenu = vi.fn()
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
                    onContextMenu={onContextMenu}
                    onDoubleClick={vi.fn()}
                    isTracing={false}
                    traceFocusId={null}
                    traceNodes={new Set<string>()}
                    traceContextSet={new Set<string>()}
                    onRevealSearchHit={vi.fn()}
                    overscan={200}
                    {...extra}
                />
            </ViewRowSearchContext.Provider>
        </ViewSearchSessionContext.Provider>,
    )
    const scroller = document.querySelector<HTMLElement>('.custom-scrollbar')
    if (!scroller) throw new Error('no layer scroller rendered')
    return { onSelect, onSelectRange, onContextMenu, scroller }
}

/** The row card carries `layer-node-<id>`. */
const row = (id: string) => {
    const el = document.getElementById(`layer-node-${id}`)
    if (!el) throw new Error(`no row rendered for ${id}`)
    return el
}
const clickRow = (id: string, init: Partial<MouseEvent> = {}) => fireEvent.click(row(id), init)

beforeEach(() => {
    useCanvasStore.setState({ lastNodeClick: { nodeId: null, seq: 0 }, selectedNodeIds: [] })
})

afterEach(() => {
    vi.restoreAllMocks()
})

/** A Mac, where Ctrl-click is the system's secondary click. */
const onAMac = () => vi.spyOn(navigator, 'platform', 'get').mockReturnValue('MacIntel')

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

    it('adds the range to what is already held, in this column or another', () => {
        const { onSelectRange } = renderColumn()
        useCanvasStore.setState({
            selectedNodeIds: ['elsewhere', 'A'],
            lastNodeClick: { nodeId: 'A', seq: 1 },
        })

        clickRow('C', { shiftKey: true })
        expect(onSelectRange).toHaveBeenCalledWith(['elsewhere', 'A', 'B', 'C'])
    })

    it('toggles the row in when there is no anchor to range from', () => {
        const { onSelect, onSelectRange } = renderColumn()
        // Nothing clicked yet — shift must not quietly do nothing, nor
        // replace what is held.
        clickRow('C', { shiftKey: true })
        expect(onSelectRange).not.toHaveBeenCalled()
        expect(onSelect).toHaveBeenCalledWith('C', true)
    })

    it('toggles the row in when the anchor belongs to another column', () => {
        const { onSelect, onSelectRange } = renderColumn()
        useCanvasStore.setState({ lastNodeClick: { nodeId: 'elsewhere', seq: 1 } })

        clickRow('C', { shiftKey: true })
        expect(onSelectRange).not.toHaveBeenCalled()
        expect(onSelect).toHaveBeenCalledWith('C', true)
    })

    it('a shift-press does not smear a text selection across the rows', () => {
        renderColumn()
        // fireEvent answers false when the default was prevented.
        expect(fireEvent.mouseDown(row('C'), { shiftKey: true })).toBe(false)
        expect(fireEvent.mouseDown(row('C'))).toBe(true)
    })

    it('a shift-press still hands the column the keyboard', () => {
        const { scroller } = renderColumn()
        fireEvent.mouseDown(row('C'), { shiftKey: true })
        expect(document.activeElement).toBe(scroller)
    })

    it('a shift-press in a field inside the row is the field’s own', () => {
        renderColumn()
        // Stands in for a group row's rename field.
        const field = document.createElement('input')
        row('C').appendChild(field)
        expect(fireEvent.mouseDown(field, { shiftKey: true })).toBe(true)
    })
})

describe('LayerColumn — Ctrl-click on a Mac', () => {
    it('toggles the row, as the hint says, instead of opening the menu', () => {
        onAMac()
        const { onSelect, onContextMenu } = renderColumn()
        // A Mac delivers Ctrl-click as a contextmenu on the primary button.
        fireEvent.contextMenu(row('B'), { ctrlKey: true, button: 0 })
        expect(onSelect).toHaveBeenCalledWith('B', true)
        expect(onContextMenu).not.toHaveBeenCalled()
    })

    it('a real right-click still opens the menu', () => {
        onAMac()
        const { onSelect, onContextMenu } = renderColumn()
        fireEvent.contextMenu(row('B'), { button: 2 })
        expect(onContextMenu).toHaveBeenCalledTimes(1)
        expect(onSelect).not.toHaveBeenCalled()
    })

    it('the click that may trail a Ctrl-click does not toggle the row back out', () => {
        onAMac()
        const { onSelect } = renderColumn()
        fireEvent.contextMenu(row('B'), { ctrlKey: true, button: 0 })
        clickRow('B', { ctrlKey: true })
        expect(onSelect).toHaveBeenCalledTimes(1)
    })

    it('off a Mac, a Ctrl-press contextmenu opens the menu as it always has', () => {
        const { onSelect, onContextMenu } = renderColumn()
        fireEvent.contextMenu(row('B'), { ctrlKey: true, button: 0 })
        expect(onContextMenu).toHaveBeenCalledTimes(1)
        expect(onSelect).not.toHaveBeenCalled()
    })
})

describe('LayerColumn — the keyboard’s Cmd-click', () => {
    it('Space toggles the focused row', () => {
        const { onSelect, scroller } = renderColumn()
        fireEvent.keyDown(scroller, { key: 'ArrowDown' })
        fireEvent.keyDown(scroller, { key: 'ArrowDown' })
        // Prevented: Space would otherwise scroll the column.
        expect(fireEvent.keyDown(scroller, { key: ' ' })).toBe(false)
        expect(onSelect).toHaveBeenCalledWith('B', true)
    })

    it('Cmd/Ctrl+Enter toggles the focused row; plain Enter still selects it alone', () => {
        const { onSelect, scroller } = renderColumn()
        fireEvent.keyDown(scroller, { key: 'ArrowDown' })
        fireEvent.keyDown(scroller, { key: 'Enter', metaKey: true })
        expect(onSelect).toHaveBeenLastCalledWith('A', true)
        fireEvent.keyDown(scroller, { key: 'Enter', ctrlKey: true })
        expect(onSelect).toHaveBeenLastCalledWith('A', true)

        fireEvent.keyDown(scroller, { key: 'Enter' })
        expect(onSelect).toHaveBeenLastCalledWith('A')
    })

    it('leaves Space to a field inside the column', () => {
        const { onSelect, scroller } = renderColumn()
        fireEvent.keyDown(scroller, { key: 'ArrowDown' })
        const field = document.createElement('input')
        scroller.appendChild(field)
        expect(fireEvent.keyDown(field, { key: ' ' })).toBe(true)
        expect(onSelect).not.toHaveBeenCalled()
    })
})

describe('LayerColumn — a multi-selection’s lineage partners', () => {
    it('stay at full strength with their ring; rows off the lines still dim', () => {
        renderColumn({
            selectedNodeIds: new Set(['A', 'B']),
            highlightedNodes: new Set(['A', 'B', 'C']),
            isHighlightActive: true,
        })
        const partner = row('C').className
        expect(partner).toContain('ring-blue-400/40')
        expect(partner).not.toContain('opacity-60')
        expect(partner).not.toContain('opacity-40')

        expect(row('D').className).toContain('opacity-40')
    })

    it('with no lines lit, an unselected row takes the gentler selection dim', () => {
        renderColumn({ selectedNodeIds: new Set(['A', 'B']) })
        expect(row('C').className).toContain('opacity-60')
    })
})
