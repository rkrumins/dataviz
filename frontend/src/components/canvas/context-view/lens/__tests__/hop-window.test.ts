import { describe, it, expect } from 'vitest'
import { applyHopWindow, bandRangeOf, HOP_WINDOW } from '../hop-window'
import { BAND_GAP, CARD_W, type FocusCard, type FocusEdge, type FocusGraph } from '../focus-cards'

const card = (id: string, band: number, overrides: Partial<FocusCard> = {}): FocusCard => ({
    id, kind: 'entity', nodeId: id, band,
    x: 0, y: 0, w: 240, h: 64, label: id, description: null, freshness: null, type: 'dataset',
    parentId: null, parentLabel: null, count: 1, flowsIn: 1, flowsOut: 1, showType: false,
    edgeTypeNorm: '', frameId: null, depth: 0, frameEmpty: false, connected: true,
    frameShowingAll: false, frameConnectedCount: 0, frameLoaded: 0, frameTotal: -1,
    frameHasMore: false, frameSearchedCount: 0, frameSearchedExact: true, frameSharedEdgeType: '',
    ancestry: [], ancestryIds: [], frameOffset: 0, frameWindowSize: 0, frameRows: [],
    canOpenChildren: false, childrenOpen: false, expandKey: null, expanded: false, wired: true,
    deadEnd: false, fetch: null, dimmed: false, pillUp: null, pillDown: null, contents: null,
    ...overrides,
})

const edge = (id: string, source: string, target: string, count = 1): FocusEdge => ({
    id, source, target, count, edgeTypeNorm: '', dimmed: false, cycleBack: false,
    cycleAnchor: false, labelVisible: false, labelT: 0.5, grainCoarse: false,
    sameAncestorFrame: null, seamSlotted: false,
})

/** A straight chain: band -N .. N, focal at 0, one hop per link. */
function chain(n: number): FocusGraph {
    const cards: FocusCard[] = [card('f', 0, { kind: 'focal', id: 'f', nodeId: 'F' })]
    const edges: FocusEdge[] = []
    for (let i = 1; i <= n; i++) {
        cards.push(card(`up${i}`, -i))
        edges.push(edge(`e:up${i}`, `up${i}`, i === 1 ? 'f' : `up${i - 1}`))
    }
    for (let i = 1; i <= n; i++) {
        cards.push(card(`dn${i}`, i))
        edges.push(edge(`e:dn${i}`, i === 1 ? 'f' : `dn${i - 1}`, `dn${i}`))
    }
    return {
        cards, edges, hiddenByChips: 0, hiddenByChipsIn: 0, hiddenByChipsOut: 0,
        modelHasUpstream: true, modelHasDownstream: true, hopsAtCoarserGrain: 0,
        focusRecovered: false, walkedThrough: new Set(), drawnRank: new Map(), bandTotals: new Map(),
    }
}

describe('hop-window — bandRangeOf', () => {
    it('reads the full top-level band span, ignoring frame children', () => {
        const g = chain(3)
        expect(bandRangeOf(g)).toEqual({ min: -3, max: 3 })
    })
    it('null on an empty board', () => {
        expect(bandRangeOf({ ...chain(0), cards: [] })).toBeNull()
    })
})

describe('hop-window — applyHopWindow', () => {
    it('is a no-op whenever the fetched extent already fits HOP_WINDOW', () => {
        const g = chain((HOP_WINDOW - 1) / 2)   // exactly HOP_WINDOW columns
        const { graph, window } = applyHopWindow(g, null)
        expect(window).toBeNull()
        expect(graph).toBe(g)
    })

    it('folds everything outside a centered window into exactly two chips', () => {
        const g = chain(10)   // 21 columns — walkLongChain's own shape
        const { graph, window } = applyHopWindow(g, null)
        expect(window).toEqual({ min: -3, max: 3 })
        const kinds = graph.cards.map(c => c.kind)
        expect(kinds.filter(k => k === 'fold')).toHaveLength(2)
        // Every card strictly inside the window survives; nothing outside does.
        const survivingBands = graph.cards.filter(c => c.kind !== 'fold').map(c => c.band)
        expect(Math.min(...survivingBands)).toBe(-3)
        expect(Math.max(...survivingBands)).toBe(3)
        expect(survivingBands).toHaveLength(7)
    })

    it('the fold chips state the exact folded hop/card count', () => {
        const g = chain(10)
        const { graph } = applyHopWindow(g, null)
        const foldIn = graph.cards.find(c => c.id === 'fold:in')!
        const foldOut = graph.cards.find(c => c.id === 'fold:out')!
        expect(foldIn.fold).toEqual({ dir: 'in', hops: 7, cards: 7, connections: 7 })
        expect(foldOut.fold).toEqual({ dir: 'out', hops: 7, cards: 7, connections: 7 })
    })

    it('positions each fold chip from its OWN band, not the flow origin (fix round 1 — a hardcoded x:0 stacked every chip on the focal)', () => {
        const g = chain(10)
        const { graph } = applyHopWindow(g, null)
        const foldIn = graph.cards.find(c => c.id === 'fold:in')!
        const foldOut = graph.cards.find(c => c.id === 'fold:out')!
        // The exact formula every ordinary card's own `x` comes from
        // (focus-cards.ts) — AND, directly, the historical bug's own
        // literal value, so a regression back to a hardcoded 0 fails
        // even if someone "fixes" the formula check by re-deriving it.
        expect(foldIn.x).toBe(foldIn.band * (CARD_W + BAND_GAP))
        expect(foldOut.x).toBe(foldOut.band * (CARD_W + BAND_GAP))
        expect(foldIn.x).not.toBe(0)
        expect(foldOut.x).not.toBe(0)
    })

    it('reroutes the boundary wire into the fold chip rather than dropping it silently', () => {
        const g = chain(10)
        const { graph } = applyHopWindow(g, null)
        const intoFoldIn = graph.edges.filter(e => e.target === 'fold:in' || e.source === 'fold:in')
        const intoFoldOut = graph.edges.filter(e => e.target === 'fold:out' || e.source === 'fold:out')
        expect(intoFoldIn.length).toBeGreaterThan(0)
        expect(intoFoldOut.length).toBeGreaterThan(0)
        // No edge whose BOTH endpoints vanished (a dangling reference React
        // Flow would refuse to draw) survives into the output.
        const ids = new Set(graph.cards.map(c => c.id))
        for (const e of graph.edges) {
            expect(ids.has(e.source)).toBe(true)
            expect(ids.has(e.target)).toBe(true)
        }
    })

    it('re-centering the window (rail jump) is pure — a new center recomputes the fold from the SAME graph', () => {
        const g = chain(10)
        const atMinus5 = applyHopWindow(g, -5)
        expect(atMinus5.window).toEqual({ min: -8, max: -2 })
        // -2 sits ON the new window's own edge — present, unfolded.
        expect(atMinus5.graph.cards.some(c => c.id === 'up2')).toBe(true)
        // -1 no longer does — it folded into the (now downstream-side) chip.
        expect(atMinus5.graph.cards.some(c => c.id === 'up1')).toBe(false)
        // The ORIGINAL graph object is untouched by computing this.
        expect(bandRangeOf(g)).toEqual({ min: -10, max: 10 })
    })

    it('clamps a window request near the fetched edge to still show a full HOP_WINDOW', () => {
        const g = chain(10)
        const { window } = applyHopWindow(g, -10)   // asking to center on the very edge
        expect(window).toEqual({ min: -10, max: -4 })
        expect(window!.max - window!.min + 1).toBe(HOP_WINDOW)
    })

    it('a card on the window edge keeps its OWN card, unfolded', () => {
        const g = chain(10)
        const { graph } = applyHopWindow(g, null)
        expect(graph.cards.some(c => c.id === 'up3')).toBe(true)
        expect(graph.cards.some(c => c.id === 'up4')).toBe(false)
    })
})

// T25 B — the depth control's own radius, honest at every setting: the
// fold chips must state exactly what they hide and the rail's own
// threshold must track the SAME radius, not the fixed HOP_WINDOW.
describe('hop-window — applyHopWindow at a caller-chosen radius (T25 B)', () => {
    it('depth 1 shows exactly one hop each way, everything else folded', () => {
        const g = chain(10)
        const { graph, window } = applyHopWindow(g, null, 1)
        expect(window).toEqual({ min: -1, max: 1 })
        const survivingBands = graph.cards.filter(c => c.kind !== 'fold').map(c => c.band)
        expect(survivingBands.sort((a, b) => a - b)).toEqual([-1, 0, 1])
        const foldIn = graph.cards.find(c => c.id === 'fold:in')!
        const foldOut = graph.cards.find(c => c.id === 'fold:out')!
        expect(foldIn.fold).toEqual({ dir: 'in', hops: 9, cards: 9, connections: 9 })
        expect(foldOut.fold).toEqual({ dir: 'out', hops: 9, cards: 9, connections: 9 })
    })

    it('depth 2 shows exactly two hops each way', () => {
        const g = chain(10)
        const { graph, window } = applyHopWindow(g, null, 2)
        expect(window).toEqual({ min: -2, max: 2 })
        const survivingBands = graph.cards.filter(c => c.kind !== 'fold').map(c => c.band)
        expect(survivingBands.sort((a, b) => a - b)).toEqual([-2, -1, 0, 1, 2])
    })

    it('is a no-op at a radius that already covers the whole fetched extent — nothing folds, no chips, no rail need', () => {
        const g = chain(3)   // -3..3, 7 columns
        const { graph, window } = applyHopWindow(g, null, 3)
        expect(window).toBeNull()
        expect(graph).toBe(g)
        expect(graph.cards.some(c => c.kind === 'fold')).toBe(false)
    })

    it('a smaller radius folds MORE than a larger one, from the exact same fetched graph', () => {
        const g = chain(10)
        const narrow = applyHopWindow(g, null, 1)
        const wide = applyHopWindow(g, null, 3)
        const narrowFold = narrow.graph.cards.find(c => c.id === 'fold:in')!.fold!.cards
        const wideFold = wide.graph.cards.find(c => c.id === 'fold:in')!.fold!.cards
        expect(narrowFold).toBeGreaterThan(wideFold)
        // Nothing fetched is ever lost — folding is a pure re-projection
        // over the SAME source graph, at either radius.
        expect(bandRangeOf(g)).toEqual({ min: -10, max: 10 })
    })

    it('the default radius (no third argument) is unchanged — every existing caller keeps HOP_WINDOW\'s own fixed radius', () => {
        const g = chain(10)
        const withDefault = applyHopWindow(g, null)
        const withExplicitThree = applyHopWindow(g, null, (HOP_WINDOW - 1) / 2)
        expect(withDefault.window).toEqual(withExplicitThree.window)
    })
})
