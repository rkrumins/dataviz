/**
 * LIVE DRAG — the rule behind "the card follows the pointer".
 *
 * `FocusGraphView`'s `nodes` prop is CONTROLLED from the built layout,
 * so React Flow's own store is re-seeded from it on every render. A drag
 * it is never told about is painted straight back to where the layout
 * says the card belongs, which is exactly what was reported: "I am not
 * getting an indication that it is actually being moved and only when I
 * release it I see that it was moved".
 *
 * Telling it is `onNodesChange`; this is the fold behind it. Pinned as a
 * pure function because jsdom has no layout — React Flow's pointer maths
 * never runs there, so a DOM-level drag test can only assert a ceiling
 * (see perf.test.tsx's own drag budget for that half).
 */
import { describe, it, expect } from 'vitest'
import type { Node, NodeChange, XYPosition } from '@xyflow/react'
import { mergeDragPositions } from '../FocusGraphView'

const EMPTY: ReadonlyMap<string, XYPosition> = new Map()
const at = (id: string, x: number, y: number): NodeChange<Node> =>
    ({ type: 'position', id, position: { x, y }, dragging: true })

describe('mergeDragPositions', () => {
    it('records where the dragged card is now', () => {
        const out = mergeDragPositions(EMPTY, [at('n:a', 40, 24)])
        expect(out?.get('n:a')).toEqual({ x: 40, y: 24 })
    })

    it('keeps the last position of a gesture, frame after frame', () => {
        let live = mergeDragPositions(EMPTY, [at('n:a', 10, 10)])!
        live = mergeDragPositions(live, [at('n:a', 20, 15)])!
        live = mergeDragPositions(live, [at('n:a', 31, 19)])!
        expect(live.get('n:a')).toEqual({ x: 31, y: 19 })
        expect(live.size).toBe(1)
    })

    it('leaves cards nobody is dragging exactly where they were', () => {
        const before = new Map([['n:a', { x: 1, y: 2 }]])
        const out = mergeDragPositions(before, [at('n:b', 9, 9)])!
        expect(out.get('n:a')).toEqual({ x: 1, y: 2 })
        expect(out.get('n:b')).toEqual({ x: 9, y: 9 })
    })

    it('NULL when the batch carries no position — a drag frame pays for nothing else', () => {
        // React Flow reports selection, dimensions and removals through
        // the same channel; none of them may cost a state update here.
        const noise: NodeChange<Node>[] = [
            { type: 'select', id: 'n:a', selected: true },
            { type: 'dimensions', id: 'n:a', dimensions: { width: 240, height: 64 } },
            { type: 'remove', id: 'n:gone' },
        ]
        expect(mergeDragPositions(EMPTY, noise)).toBeNull()
    })

    it('a position change with no position at all is not a move', () => {
        expect(mergeDragPositions(EMPTY, [{ type: 'position', id: 'n:a', dragging: true }])).toBeNull()
    })

    it('never mutates the map it was given — the previous frame stays valid', () => {
        const before = new Map([['n:a', { x: 1, y: 2 }]])
        mergeDragPositions(before, [at('n:a', 99, 99)])
        expect(before.get('n:a')).toEqual({ x: 1, y: 2 })
    })
})
