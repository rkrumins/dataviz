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
import { mergeDragPositions, mergeMeasured } from '../FocusGraphView'

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

/**
 * THE SIZE REACT FLOW HANDS BACK, and why dropping it broke three
 * separate things.
 *
 * `adoptUserNodes` re-adopts a node whenever the object identity for its
 * id changes and reads `measured` off the object it is GIVEN, not out of
 * its own lookup. This component rebuilds node objects constantly — a
 * drag rebuilds the dragged one, a selection rebuilds the selected one,
 * any layout change rebuilds all of them — so every rebuilt node arrived
 * with no size and React Flow counted it uninitialized. Reported live:
 * a dragged card vanished along with its wires (React Flow error 015 in
 * the console: "trying to drag a node that is not initialized"), the
 * image export was fitted to a board that measured short, and the lens
 * sometimes opened blank because `getFitViewNodes` keeps only nodes with
 * a measured width and height — with none, it fits an empty set and the
 * viewport lands nowhere near the board.
 */
describe('mergeMeasured', () => {
  const EMPTY: ReadonlyMap<string, { width: number; height: number }> = new Map()
  const dim = (id: string, width: number, height: number) =>
    ({ id, type: 'dimensions', dimensions: { width, height } }) as unknown as NodeChange<Node>

  it('keeps the size React Flow reports', () => {
    const next = mergeMeasured(EMPTY, [dim('a', 290, 36)])
    expect(next?.get('a')).toEqual({ width: 290, height: 36 })
  })

  it('returns null when a batch says nothing about sizes, so no state churns', () => {
    const move = { id: 'a', type: 'position', position: { x: 1, y: 2 } } as unknown as NodeChange<Node>
    expect(mergeMeasured(EMPTY, [move])).toBeNull()
  })

  it('returns null when every size is one it already had', () => {
    const first = mergeMeasured(EMPTY, [dim('a', 290, 36)])!
    // The identical measurement arriving again must not rebuild the map:
    // `baseNodes` depends on it, so a fresh map on every batch would
    // rebuild every node object on the board for nothing.
    expect(mergeMeasured(first, [dim('a', 290, 36)])).toBeNull()
  })

  it('IGNORES a zero measurement — a node mid-teardown reports one', () => {
    // Worse than storing nothing: 0 reads as "measured" at every call
    // site that checks for a size, including the fit-view filter.
    expect(mergeMeasured(EMPTY, [dim('a', 0, 0)])).toBeNull()
    const had = mergeMeasured(EMPTY, [dim('a', 290, 36)])!
    expect(mergeMeasured(had, [dim('a', 0, 0)])).toBeNull()
    expect(had.get('a')).toEqual({ width: 290, height: 36 })
  })

  it('folds a whole batch, which is how they arrive at mount', () => {
    const next = mergeMeasured(EMPTY, [dim('a', 290, 36), dim('b', 310, 448), dim('c', 240, 64)])!
    expect(next.size).toBe(3)
    expect(next.get('b')).toEqual({ width: 310, height: 448 })
  })

  it('leaves the map it was given untouched', () => {
    const first = mergeMeasured(EMPTY, [dim('a', 290, 36)])!
    mergeMeasured(first, [dim('b', 1, 2)])
    expect(first.has('b')).toBe(false)
  })
})
