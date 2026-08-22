import { describe, it, expect } from 'vitest'
import { applyCondensation, MIN_CONDENSE_RUN } from '../condensation'
import type { FocusCard, FocusEdge, FocusGraph } from '../focus-cards'

const card = (id: string, overrides: Partial<FocusCard> = {}): FocusCard => ({
    id, kind: 'entity', nodeId: id, band: 0,
    x: 0, y: 0, w: 240, h: 64, label: id, description: null, freshness: null, type: 'dataset',
    parentId: null, parentLabel: null, count: 1, flowsIn: 1, flowsOut: 1, drawnIn: 1, drawnOut: 1, flowsInExact: true, flowsOutExact: true, showType: false,
    edgeTypeNorm: '', frameId: null, depth: 0, frameEmpty: false, nameLines: 1, connected: true,
    gutterLanes: 0,
    frameShowingAll: false, frameConnectedCount: 0, frameLoaded: 0, frameTotal: -1,
    frameHasMore: false, frameSearchedCount: 0, frameSearchedExact: true, frameSharedEdgeType: '',
    ancestry: [], ancestryIds: [], frameOffset: 0, frameWindowSize: 0, frameRows: [],
    canOpenChildren: false, childrenOpen: false, expandKey: null, expanded: false, wired: true,
    deadEnd: false, fetch: null, dimmed: false, pillUp: null, pillDown: null, contents: null,
    ...overrides,
})

const edge = (id: string, source: string, target: string, count = 1, edgeTypeNorm = ''): FocusEdge => ({
    id, source, target, count, edgeTypeNorm, dimmed: false, cycleBack: false,
    cycleAnchor: false, labelVisible: false, labelT: 0.5, grainCoarse: false,
    sameAncestorFrame: null, inFrameLane: null, seamSlotted: false,
})

const graphOf = (cards: FocusCard[], edges: FocusEdge[]): FocusGraph => ({
    cards, edges, bundledWires: [], hiddenByChips: 0, hiddenByChipsIn: 0, hiddenByChipsOut: 0,
    modelHasUpstream: true, modelHasDownstream: true, hopsAtCoarserGrain: 0,
    focusRecovered: false, walkedThrough: new Set(), bundled: new Set(), drawnRank: new Map(), bandTotals: new Map(),
})

/** A -> B -> C -> D -> E: B, C, D are degree-1 pass-through. */
function straightRun(): FocusGraph {
    return graphOf(
        ['A', 'B', 'C', 'D', 'E'].map(id => card(id)),
        [edge('e1', 'A', 'B'), edge('e2', 'B', 'C'), edge('e3', 'C', 'D'), edge('e4', 'D', 'E')],
    )
}

describe('condensation — applyCondensation', () => {
    it('collapses a maximal degree-1 run into one connector edge', () => {
        const g = applyCondensation(straightRun(), new Set())
        const ids = g.cards.map(c => c.id).sort()
        expect(ids).toEqual(['A', 'E'])
        expect(g.edges).toHaveLength(1)
        const [e] = g.edges
        expect(e.source).toBe('A')
        expect(e.target).toBe('E')
        expect(e.count).toBe(4)   // 4 raw hops folded in, honestly summed
        expect(e.condensed).toEqual({ connectorId: 'condense:A>E', steps: 3 })
    })

    it('a run shorter than MIN_CONDENSE_RUN stays uncondensed', () => {
        expect(MIN_CONDENSE_RUN).toBeGreaterThanOrEqual(2)
        // A -> B -> C: exactly one interior card.
        const g = graphOf(
            ['A', 'B', 'C'].map(id => card(id)),
            [edge('e1', 'A', 'B'), edge('e2', 'B', 'C')],
        )
        const out = applyCondensation(g, new Set())
        expect(out).toBe(g)   // no-op — identity preserved, nothing to fold
    })

    it('a branch point breaks the run — mirrors walkLongChain\'s fan-in', () => {
        // A -> B -> C -> D, plus X -> C (C now has in-degree 2: not pass-through).
        const g = graphOf(
            ['A', 'B', 'C', 'D', 'X'].map(id => card(id)),
            [edge('e1', 'A', 'B'), edge('e2', 'B', 'C'), edge('e3', 'C', 'D'), edge('eX', 'X', 'C')],
        )
        const out = applyCondensation(g, new Set())
        // A->B->C is too short to condense (1 interior card, B) on its own,
        // and C->D is a single hop with nothing to fold either — the whole
        // picture survives untouched.
        expect(out.cards.map(c => c.id).sort()).toEqual(['A', 'B', 'C', 'D', 'X'])
    })

    it('never swallows the focal card — it BOUNDS a run rather than joining one, even at degree 1/1', () => {
        // X -> F(focal) -> A -> B -> C -> D: A,B,C are a foldable run.
        const g = graphOf(
            [card('X'), card('F', { kind: 'focal' }), card('A'), card('B'), card('C'), card('D')],
            [edge('e0', 'X', 'F'), edge('e1', 'F', 'A'), edge('e2', 'A', 'B'), edge('e3', 'B', 'C'), edge('e4', 'C', 'D')],
        )
        const out = applyCondensation(g, new Set())
        expect(out.cards.some(c => c.id === 'F')).toBe(true)
        expect(out.cards.map(c => c.id).sort()).toEqual(['D', 'F', 'X'].sort())
        // The run is folded FROM the focal, not swallowing it.
        expect(out.edges).toHaveLength(2)   // X->F kept, F->D condensed
        const condensed = out.edges.find(e => e.condensed)
        expect(condensed?.source).toBe('F')
        expect(condensed?.target).toBe('D')
    })

    it('never swallows a row-holding frame card — it BOUNDS a run rather than joining one', () => {
        const g = graphOf(
            [card('X'), card('Frame', { kind: 'frame' }), card('A'), card('B'), card('C'), card('D')],
            [edge('e0', 'X', 'Frame'), edge('e1', 'Frame', 'A'), edge('e2', 'A', 'B'), edge('e3', 'B', 'C'), edge('e4', 'C', 'D')],
        )
        const out = applyCondensation(g, new Set())
        expect(out.cards.some(c => c.id === 'Frame')).toBe(true)
        const condensed = out.edges.find(e => e.condensed)
        expect(condensed?.source).toBe('Frame')
        expect(condensed?.target).toBe('D')
    })

    it('never folds a card that lives INSIDE a frame — a frame drawn from its rows would be left empty', () => {
        // A -> r1 -> r2 -> D, where r1 and r2 are the only ROWS of two
        // open frames. Folding them hides them from their frames, and a
        // frame is nothing but its rows: the board keeps a box whose
        // header still says "1 on this lineage · of 12" over an empty
        // body, with no card left to click onward from. Reported live.
        const g = graphOf(
            [
                card('A'), card('D'),
                card('F1', { kind: 'frame' }), card('F2', { kind: 'frame' }),
                card('r1', { frameId: 'F1' }), card('r2', { frameId: 'F2' }),
            ],
            [edge('e1', 'A', 'r1'), edge('e2', 'r1', 'r2'), edge('e3', 'r2', 'D')],
        )
        const out = applyCondensation(g, new Set())
        expect(out).toBe(g)   // nothing foldable: identity, untouched
        expect(out.cards.map(c => c.id)).toContain('r1')
        expect(out.cards.map(c => c.id)).toContain('r2')
    })

    it('an explicitly unfolded run (condensedOpen) stays fully drawn, with a re-condense marker on its boundary', () => {
        const g = straightRun()
        const out = applyCondensation(g, new Set(['condense:A>E']))
        expect(out.cards.map(c => c.id).sort()).toEqual(['A', 'B', 'C', 'D', 'E'])
        expect(out.edges).toHaveLength(4)
        const a = out.cards.find(c => c.id === 'A')!
        expect(a.condenseRun).toEqual({ connectorId: 'condense:A>E', dir: 'out', steps: 3 })
    })

    it('a mixed edge type across the run reports the honest blank rather than picking one', () => {
        const g = graphOf(
            ['A', 'B', 'C'].map(id => card(id)),
            [edge('e1', 'A', 'B', 1, 'DERIVES'), edge('e2', 'B', 'C', 1, 'COPIES')],
        )
        // Too short to condense at MIN_CONDENSE_RUN=2 with one interior card —
        // extend to a proper 2-interior run to exercise the type merge.
        const g2 = graphOf(
            ['A', 'B', 'C', 'D'].map(id => card(id)),
            [edge('e1', 'A', 'B', 1, 'DERIVES'), edge('e2', 'B', 'C', 1, 'COPIES'), edge('e3', 'C', 'D', 1, 'COPIES')],
        )
        expect(applyCondensation(g, new Set())).toBe(g)
        const out = applyCondensation(g2, new Set())
        expect(out.edges[0].edgeTypeNorm).toBe('')
    })

    it('is a no-op when nothing in the picture is a maximal pass-through run', () => {
        const g = graphOf([card('A'), card('B')], [edge('e1', 'A', 'B')])
        expect(applyCondensation(g, new Set())).toBe(g)
    })
})
