/**
 * T26 R2 — the invariant stage, pinned as the hostile-state battery the
 * brief calls for: a focal-excluding `drawn` graph with the focus still
 * in `fallback` (T28 R3 — genuinely reachable now only if `applyCondensation`
 * ever mishandled the focal; the generic contract itself does not know
 * or care why `drawn` lost it), condensed sets referencing gone cards
 * (dangling edges/frames), and an empty model (neither `drawn` nor
 * `fallback` has the focus). Each check is pinned in isolation from the
 * others, and the "clean input" case is pinned for referential
 * stability — the invariant stage must cost nothing when there is
 * nothing to fix.
 */
import { describe, it, expect, vi, afterEach } from 'vitest'
import { enforceLensInvariants } from '../invariants'
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

const edge = (id: string, source: string, target: string): FocusEdge => ({
    id, source, target, count: 1, edgeTypeNorm: '', dimmed: false, cycleBack: false,
    cycleAnchor: false, labelVisible: false, labelT: 0.5, grainCoarse: false,
    sameAncestorFrame: null, inFrameLane: null, seamSlotted: false,
})

const graphOf = (cards: FocusCard[], edges: FocusEdge[] = []): FocusGraph => ({
    cards, edges, hiddenByChips: 0, hiddenByChipsIn: 0, hiddenByChipsOut: 0,
    modelHasUpstream: true, modelHasDownstream: true, hopsAtCoarserGrain: 0,
    focusRecovered: false, walkedThrough: new Set(), bundled: new Set(), drawnRank: new Map(), bandTotals: new Map(),
})

describe('enforceLensInvariants — clean input costs nothing', () => {
    afterEach(() => vi.restoreAllMocks())

    it('a fully clean graph is returned by IDENTITY — no violations, no new object', () => {
        const g = graphOf([card('f', { kind: 'focal' }), card('a')], [edge('e1', 'f', 'a')])
        const { graph, violations } = enforceLensInvariants(g, g)
        expect(graph).toBe(g)
        expect(violations).toEqual([])
    })
})

describe('enforceLensInvariants — (a)/(b) the focal card is drawn; the board is never empty', () => {
    afterEach(() => vi.restoreAllMocks())

    it('drawn already has the focal — used as-is, fallback ignored', () => {
        const drawn = graphOf([card('f', { kind: 'focal' })])
        const fallback = graphOf([card('f', { kind: 'focal' }), card('a')])
        const { graph, violations } = enforceLensInvariants(drawn, fallback)
        expect(graph).toBe(drawn)
        expect(violations).toEqual([])
    })

    it('DRAWN LOST THE FOCAL — fallback still has it: falls back, dev-asserts', () => {
        const spy = vi.spyOn(console, 'error').mockImplementation(() => {})
        const drawn = graphOf([card('a')]) // no focal — an earlier pass dropped it somehow
        const fallback = graphOf([card('f', { kind: 'focal' }), card('a')])
        const { graph, violations } = enforceLensInvariants(drawn, fallback)
        expect(graph).toBe(fallback)
        expect(violations.map(v => v.code)).toEqual(['focal-missing'])
        expect(spy).toHaveBeenCalled()
    })

    it('NOTHING TO DRAW AT ALL — the ordinary empty state is not a violation, and says nothing', () => {
        // The lens just opened, the first fetch is in flight, it failed,
        // or the provider cannot walk: every pass produces an empty
        // graph and none of them LOST a focus — there was none in the
        // data. Asserting here logged a violation on every render of the
        // loading state and raised `focusRecovered`, so a lens that had
        // simply not finished fetching whispered "the rest of this walk
        // could not be placed" over its own spinner.
        const spy = vi.spyOn(console, 'error').mockImplementation(() => {})
        const drawn = graphOf([])
        const { graph, violations } = enforceLensInvariants(drawn, graphOf([]))
        expect(graph).toBe(drawn)
        expect(graph.focusRecovered).toBe(false)
        expect(violations).toEqual([])
        expect(spy).not.toHaveBeenCalled()
    })

    it('CARDS BUT NO FOCAL ANYWHERE — a genuine violation: forces focusRecovered so the whisper fires', () => {
        const spy = vi.spyOn(console, 'error').mockImplementation(() => {})
        const drawn = graphOf([card('a')])
        const fallback = graphOf([card('a')])
        const { graph, violations } = enforceLensInvariants(drawn, fallback)
        expect(graph.focusRecovered).toBe(true)
        expect(violations.map(v => v.code)).toEqual(['board-empty'])
        expect(spy).toHaveBeenCalled()
    })
})

describe('enforceLensInvariants — (c) every edge endpoint resolves to a drawn card', () => {
    afterEach(() => vi.restoreAllMocks())

    it('CONDENSED SET REFERENCING A GONE CARD — a dangling edge is dropped, not drawn floating', () => {
        vi.spyOn(console, 'error').mockImplementation(() => {})
        const drawn = graphOf(
            [card('f', { kind: 'focal' }), card('a')],
            [edge('e1', 'f', 'a'), edge('e2', 'f', 'GONE')],
        )
        const { graph, violations } = enforceLensInvariants(drawn, drawn)
        expect(graph.edges.map(e => e.id)).toEqual(['e1'])
        expect(violations.map(v => v.code)).toEqual(['dangling-edge'])
    })

})

describe('enforceLensInvariants — (d) cone/strata coherence: no card claims an undrawn frame', () => {
    afterEach(() => vi.restoreAllMocks())

    it('a card whose frameId is not drawn is promoted to top-level, not dropped', () => {
        vi.spyOn(console, 'error').mockImplementation(() => {})
        const drawn = graphOf([
            card('f', { kind: 'focal' }),
            card('row', { frameId: 'GONE_FRAME' }),
        ])
        const { graph, violations } = enforceLensInvariants(drawn, drawn)
        const row = graph.cards.find(c => c.id === 'row')
        expect(row).toBeDefined()
        expect(row!.frameId).toBeNull()
        expect(violations.map(v => v.code)).toEqual(['dangling-frame'])
    })

    it('a card whose frameId IS drawn is untouched', () => {
        const drawn = graphOf([
            card('f', { kind: 'focal' }),
            card('frame1', { kind: 'frame' }),
            card('row', { frameId: 'frame1' }),
        ])
        const { graph, violations } = enforceLensInvariants(drawn, drawn)
        expect(graph.cards.find(c => c.id === 'row')!.frameId).toBe('frame1')
        expect(violations).toEqual([])
    })
})

describe('enforceLensInvariants — hostile compound state: everything wrong at once', () => {
    it('missing focal, a dangling edge, AND a dangling frame — all four checks fire together, board still renders', () => {
        vi.spyOn(console, 'error').mockImplementation(() => {})
        const drawn = graphOf([card('a')]) // no focal at all
        const fallback = graphOf(
            [card('f', { kind: 'focal' }), card('a'), card('row', { frameId: 'GONE' })],
            [edge('e1', 'f', 'a'), edge('e2', 'f', 'GONE')],
        )
        const { graph, violations } = enforceLensInvariants(drawn, fallback)
        expect(graph.cards.some(c => c.kind === 'focal')).toBe(true)
        expect(graph.edges.map(e => e.id)).toEqual(['e1'])
        expect(graph.cards.find(c => c.id === 'row')!.frameId).toBeNull()
        expect(violations.map(v => v.code).sort()).toEqual(['dangling-edge', 'dangling-frame', 'focal-missing'])
    })
})
