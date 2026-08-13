/**
 * focus-layout — the walk-model layout engine.
 *
 * Several names here are SALVAGED from focus-graph.test.ts on purpose:
 * the old builder's honesty rules (one card per entity, a filter that
 * dims rather than removes, caps that say what they capped, dead ends
 * that are a data-source claim) are contracts of the LENS, not of one
 * implementation, so the new builder is held to the same ones. Where the
 * old test asserted a two-level nesting cap, this one asserts the cap is
 * gone.
 */
import { describe, it, expect } from 'vitest'
import { buildLensSubgraph, type LensSubgraph, type LensFrontierEntry } from '../lens-subgraph'
import type { LensWalkNode } from '../closure-adapter'
import {
    buildFocusLayout,
    initialLensViewState,
    revealKey,
    walkStatusKey,
    REVEAL_PAGE,
    type LensViewState,
    type FocusLayoutInput,
} from '../focus-layout'
import { FRAME_CHILD_CAP, type FocusCard } from '../focus-graph'

// ── fixtures ─────────────────────────────────────────────────────────

const wnode = (
    urn: string,
    type = 'dataset',
    label = urn,
    data: Record<string, unknown> = {},
): LensWalkNode => ({
    id: urn,
    type: 'generic',
    position: { x: 0, y: 0 },
    data: { urn, label, type, ...data },
    urn,
    displayName: label,
    entityType: type,
}) as unknown as LensWalkNode

interface Shape {
    focus: string
    nodes: LensWalkNode[]
    hops: Array<[string, string] | [string, string, string]>
    contains: Array<[string, string]>
    frontierUp?: LensFrontierEntry[]
    frontierDown?: LensFrontierEntry[]
}

function subgraph(shape: Shape): LensSubgraph<LensWalkNode> {
    return buildLensSubgraph<LensWalkNode>({
        focusUrn: shape.focus,
        nodes: shape.nodes,
        lineageEdges: shape.hops.map(([s, t, type], i) => ({
            id: `h${i}`, sourceUrn: s, targetUrn: t, edgeType: type ?? 'DERIVES_FROM',
        })),
        containmentEdges: shape.contains.map(([s, t]) => ({ sourceUrn: s, targetUrn: t })),
        frontierUp: shape.frontierUp,
        frontierDown: shape.frontierDown,
    })
}

function layout(
    sg: LensSubgraph<LensWalkNode>,
    view: LensViewState = initialLensViewState(sg),
    over: Partial<FocusLayoutInput> = {},
) {
    return buildFocusLayout({
        sg,
        view,
        query: '',
        hiddenTypes: new Set(),
        extendStatus: new Map(),
        childrenAll: new Map(),
        childrenAllStatus: new Map(),
        walkStatus: 'done',
        ...over,
    })
}

const withReveal = (view: LensViewState, key: string, pages: number): LensViewState =>
    ({ ...view, revealed: new Map([...view.revealed, [key, pages]]) })

const cardFor = (g: { cards: FocusCard[] }, urn: string) => g.cards.find(c => c.nodeId === urn)
const urns = (g: { cards: FocusCard[] }) => g.cards.map(c => c.nodeId).filter(Boolean) as string[]

/** The reported estate, as a walk model: DATADOMAIN ⊃ APPLICATION ⊃
 *  CONTAINER ⊃ CONTAINER ⊃ DATABASE ⊃ three tables, all upstream of a
 *  table focal that lives in its own container. */
function collateralEstate(): LensSubgraph<LensWalkNode> {
    const nodes = [
        wnode('DOM', 'DATADOMAIN', 'Finance'),
        wnode('APP', 'APPLICATION', 'RiskApp'),
        wnode('CTR1', 'CONTAINER', 'PROD'),
        wnode('CTR2', 'CONTAINER', 'CURATED'),
        wnode('DB', 'DATABASE', 'RISK_DB', { childCount: 12 }),
        wnode('FT', 'dataset', 'fin_marts'),
        wnode('F', 'dataset', 'collaterals'),
        wnode('t0', 'dataset', 'loan_positions'),
        wnode('t1', 'dataset', 'collateral_valuations'),
        wnode('t2', 'dataset', 'fx_rates'),
    ]
    return subgraph({
        focus: 'F',
        nodes,
        contains: [
            ['DOM', 'APP'], ['APP', 'CTR1'], ['CTR1', 'CTR2'], ['CTR2', 'DB'],
            ['DB', 't0'], ['DB', 't1'], ['DB', 't2'],
            ['FT', 'F'],
        ],
        hops: [['t0', 'F'], ['t1', 'F'], ['t2', 'F']],
    })
}

// ── initial state ────────────────────────────────────────────────────

describe('focus-layout — initial view state', () => {
    it('opens the focus spine and one page in each direction, nothing else', () => {
        const sg = collateralEstate()
        const view = initialLensViewState(sg)
        expect([...view.expandedContainment].sort()).toEqual(['F', 'FT'])
        expect([...view.revealed.entries()].sort()).toEqual([['in:F', 1], ['out:F', 1]])
        expect(view.collapsedContainment.size).toBe(0)
        expect(view.frameShowAll.size).toBe(0)
        expect(view.selection).toBeNull()
        expect(REVEAL_PAGE).toBe(12)
    })

    it('lands with the focus already on the board, nested in its own container', () => {
        const g = layout(collateralEstate())
        const focus = cardFor(g, 'F')
        expect(focus).toBeDefined()
        expect(focus!.frameId).toBe(cardFor(g, 'FT')!.id)
        expect(cardFor(g, 'FT')!.kind).toBe('frame')
    })
})

// ── population and the answer grain ──────────────────────────────────

describe('focus-layout — the answer grain', () => {
    it('auto-opens a pass-through spine and stops at the first branch', () => {
        const g = layout(collateralEstate())
        // Every single-child level between the group root and the branch
        // is a frame you can see through...
        for (const spine of ['DOM', 'APP', 'CTR1', 'CTR2']) {
            expect(cardFor(g, spine)!.kind).toBe('frame')
        }
        // ...and the branch itself is the answer grain: one card standing
        // for its three tables, not three loose cards.
        expect(cardFor(g, 'DB')!.kind).toBe('entity')
        expect(cardFor(g, 't0')).toBeUndefined()
        expect(cardFor(g, 'DB')!.contents).toEqual({ onLineage: 3, total: 12 })
    })

    it('opens the branch when the user asks, and the tables become cards', () => {
        const sg = collateralEstate()
        const base = initialLensViewState(sg)
        const g = layout(sg, { ...base, expandedContainment: new Set([...base.expandedContainment, 'DB']) })
        expect(cardFor(g, 'DB')!.kind).toBe('frame')
        for (const t of ['t0', 't1', 't2']) expect(cardFor(g, t)!.frameId).toBe(cardFor(g, 'DB')!.id)
    })

    it('collapsedContainment overrides the auto-opened spine', () => {
        const sg = collateralEstate()
        const g = layout(sg, { ...initialLensViewState(sg), collapsedContainment: new Set(['CTR1']) })
        expect(cardFor(g, 'CTR1')!.kind).toBe('entity')
        expect(cardFor(g, 'CTR2')).toBeUndefined()
        expect(cardFor(g, 'DB')).toBeUndefined()
    })

    it('accrues the whole bundle weight onto the nearest visible ancestor', () => {
        const sg = collateralEstate()
        const g = layout(sg, { ...initialLensViewState(sg), collapsedContainment: new Set(['CTR1']) })
        // Three raw hops, one drawn line, and it says three.
        const into = g.edges.filter(e => e.target === cardFor(g, 'F')!.id)
        expect(into).toHaveLength(1)
        expect(into[0].count).toBe(3)
        expect(into[0].source).toBe(cardFor(g, 'CTR1')!.id)
    })
})

// ── N-level nesting ──────────────────────────────────────────────────

describe('focus-layout — nesting', () => {
    /** Node ⊃ Node ⊃ Node ⊃ Node: one entity type at every level, which
     *  no type→level map can describe. */
    function recursiveEstate(): LensSubgraph<LensWalkNode> {
        const nodes = [wnode('F', 'Node', 'focus'), wnode('FP', 'Node', 'focus_parent')]
        const contains: Array<[string, string]> = [['FP', 'F']]
        const hops: Array<[string, string]> = []
        // R ⊃ R1 ⊃ R2 ⊃ {leafA, leafB} — a spine of Nodes, then a branch.
        for (const [parent, child] of [['R', 'R1'], ['R1', 'R2']] as Array<[string, string]>) {
            contains.push([parent, child])
        }
        nodes.push(wnode('R', 'Node', 'estate'), wnode('R1', 'Node', 'estate_1'), wnode('R2', 'Node', 'estate_2'))
        for (const leaf of ['leafA', 'leafB']) {
            nodes.push(wnode(leaf, 'Node', leaf))
            contains.push(['R2', leaf])
            hops.push([leaf, 'F'])
        }
        return subgraph({ focus: 'F', nodes, contains, hops })
    }

    it('nests to N levels — the outer rect encloses the inner, three deep', () => {
        const sg = recursiveEstate()
        const base = initialLensViewState(sg)
        const g = layout(sg, { ...base, expandedContainment: new Set([...base.expandedContainment, 'R2']) })
        const byId = new Map(g.cards.map(c => [c.id, c]))
        const chain = ['R', 'R1', 'R2'].map(u => cardFor(g, u)!)
        expect(chain.every(c => c.kind === 'frame')).toBe(true)
        // Each level is genuinely INSIDE the one above it, geometrically.
        for (const card of g.cards) {
            if (!card.frameId) continue
            const host = byId.get(card.frameId)!
            expect(card.x).toBeGreaterThanOrEqual(host.x)
            expect(card.y).toBeGreaterThanOrEqual(host.y)
            expect(card.x + card.w).toBeLessThanOrEqual(host.x + host.w + 0.001)
            expect(card.y + card.h).toBeLessThanOrEqual(host.y + host.h + 0.001)
        }
        // Three levels of hosting, not the old two-level promotion cap.
        const depthOf = (c: FocusCard) => {
            let d = 0
            let host = c.frameId
            while (host) { d++; host = byId.get(host)!.frameId }
            return d
        }
        expect(depthOf(cardFor(g, 'leafA')!)).toBe(3)
        expect(g.cards.filter(c => c.kind === 'frame')).toHaveLength(4)   // R, R1, R2, FP
    })
})

// ── reveal paging ────────────────────────────────────────────────────

/** `n` separate upstream roots, root i carrying `weights[i]` raw hops
 *  into the focus, so the reveal ranking has something to rank. */
function fanIn(weights: number[], labels?: string[]): LensSubgraph<LensWalkNode> {
    const nodes = [wnode('F', 'dataset', 'focus')]
    const hops: Array<[string, string]> = []
    weights.forEach((w, i) => {
        const urn = `u${String(i).padStart(2, '0')}`
        nodes.push(wnode(urn, 'dataset', labels?.[i] ?? urn))
        for (let k = 0; k < w; k++) hops.push([urn, 'F'])
    })
    return subgraph({ focus: 'F', nodes, contains: [], hops })
}

describe('focus-layout — reveal paging', () => {
    it('reveals the heaviest first, breaking ties by label, and pages accumulate', () => {
        // 14 groups: two heavy, the rest weight 1 with labels that sort
        // in the OPPOSITE order to their urns, so a passing test cannot
        // be urn order by accident.
        const weights = [1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 5, 3]
        const labels = weights.map((_, i) => `z${String(99 - i).padStart(2, '0')}`)
        const sg = fanIn(weights, labels)
        const g1 = layout(sg)
        const shown = urns(g1).filter(u => u !== 'F')
        expect(shown).toHaveLength(REVEAL_PAGE)
        // Heaviest two lead, then weight-1 groups in LABEL order.
        expect(shown.slice(0, 2)).toEqual(['u12', 'u13'])
        expect(shown.slice(2, 5)).toEqual(['u11', 'u10', 'u09'])
        // Page 2 adds the rest without re-ordering what was already there.
        const g2 = layout(sg, withReveal(initialLensViewState(sg), 'in:F', 2))
        const shown2 = urns(g2).filter(u => u !== 'F')
        expect(shown2).toHaveLength(14)
        expect(shown2.slice(0, REVEAL_PAGE)).toEqual(shown)
    })

    it('caps the reveal with an exact remaining count — never a silent truncation', () => {
        const sg = fanIn(new Array(20).fill(1))
        const g = layout(sg)
        expect(urns(g).filter(u => u !== 'F')).toHaveLength(REVEAL_PAGE)
        const pill = cardFor(g, 'F')!.pillUp
        expect(pill).toMatchObject({ kind: 'reveal', count: 8, key: 'in:F' })
        // And it drains honestly rather than looping forever.
        const g2 = layout(sg, withReveal(initialLensViewState(sg), 'in:F', 2))
        expect(urns(g2).filter(u => u !== 'F')).toHaveLength(20)
        expect(cardFor(g2, 'F')!.pillUp).toBeNull()
    })
})

// ── pills ────────────────────────────────────────────────────────────

describe('focus-layout — the ⊕ pill tells one of three truths', () => {
    /** `U2 → U → focus`, with U's own upstream page already revealed, so
     *  nothing is left to reveal locally and the pill has to speak about
     *  what is beyond the model instead. */
    const frontierCase = (entry: Partial<LensFrontierEntry> & { urn: string }) => subgraph({
        focus: 'F',
        nodes: [wnode('F'), wnode('U'), wnode('U2')],
        contains: [],
        hops: [['U2', 'U'], ['U', 'F']],
        frontierUp: [{ totalCount: null, nextCursor: null, ...entry }],
    })
    const drilled = (sg: LensSubgraph<LensWalkNode>) => withReveal(initialLensViewState(sg), 'in:U', 1)

    it('offers to extend with the exact remainder the server reported', () => {
        // U has one hop in the model and the server says it has 8.
        const sg = frontierCase({ urn: 'U', totalCount: 8 })
        const g = layout(sg, drilled(sg))
        expect(cardFor(g, 'U2')).toBeDefined()
        expect(cardFor(g, 'U')!.pillUp).toEqual({
            kind: 'extend', count: 7, key: 'in:U', cursor: undefined, status: undefined,
        })
    })

    it('offers a countless chevron when the server does not know the total', () => {
        const sg = frontierCase({ urn: 'U', totalCount: null })
        expect(cardFor(layout(sg, drilled(sg)), 'U')!.pillUp).toMatchObject({ kind: 'extend', count: null })
    })

    it('offers to PAGE, carrying the cursor verbatim, when one was reported', () => {
        const sg = frontierCase({ urn: 'U', totalCount: 40, nextCursor: 'eyJvIjoxMH0=' })
        expect(cardFor(layout(sg, drilled(sg)), 'U')!.pillUp)
            .toMatchObject({ kind: 'page', cursor: 'eyJvIjoxMH0=', count: 39 })
    })

    it('a reveal that is still in hand outranks a fetch — free before costly', () => {
        // Same model, but U's upstream page has NOT been revealed: U2 is
        // already downloaded, so the honest offer is to show it, not to
        // go back to the server.
        const sg = frontierCase({ urn: 'U', totalCount: 8 })
        const g = layout(sg)
        expect(cardFor(g, 'U2')).toBeUndefined()
        expect(cardFor(g, 'U')!.pillUp).toMatchObject({ kind: 'reveal', count: 1 })
    })

    it('passes the in-flight status through to the pill it belongs to', () => {
        const sg = frontierCase({ urn: 'U', totalCount: 8 })
        const loading = layout(sg, drilled(sg), {
            extendStatus: new Map([[walkStatusKey('in', 'U'), 'loading']]),
        })
        expect(cardFor(loading, 'U')!.pillUp!.status).toBe('loading')
        const failed = layout(sg, drilled(sg), {
            extendStatus: new Map([[walkStatusKey('in', 'U'), 'error']]),
        })
        expect(cardFor(failed, 'U')!.pillUp!.status).toBe('error')
        expect(walkStatusKey('in', 'U')).toBe('up:U')
        expect(walkStatusKey('out', 'U')).toBe('down:U')
        expect(revealKey('in', 'U')).toBe('in:U')
    })

    it('drained: no pill at all, and the dead end is stated once', () => {
        // No frontier entry anywhere — the walk genuinely ends at U.
        const sg = subgraph({ focus: 'F', nodes: [wnode('F'), wnode('U')], contains: [], hops: [['U', 'F']] })
        const g = layout(sg)
        const u = cardFor(g, 'U')!
        expect(u.pillUp).toBeNull()
        expect(u.pillDown).toBeNull()
        expect(u.deadEnd).toBe(true)
    })

    it('never claims a dead end while the walk is still in flight', () => {
        const sg = subgraph({ focus: 'F', nodes: [wnode('F'), wnode('U')], contains: [], hops: [['U', 'F']] })
        const g = layout(sg, initialLensViewState(sg), { walkStatus: 'loading' })
        expect(cardFor(g, 'U')!.deadEnd).toBe(false)
    })

    it('a remainder of zero is drained, not a pill promising nothing', () => {
        const sg = frontierCase({ urn: 'U', totalCount: 1 })
        const g = layout(sg, drilled(sg))
        expect(cardFor(g, 'U')!.pillUp).toBeNull()
        expect(cardFor(g, 'U')!.deadEnd).toBe(true)
    })

    it('a container carries the frontier of everything inside it', () => {
        const sg = subgraph({
            focus: 'F',
            nodes: [wnode('F'), wnode('T', 'dataset', 'src_table'), wnode('c0'), wnode('c1')],
            contains: [['T', 'c0'], ['T', 'c1']],
            hops: [['c0', 'F'], ['c1', 'F']],
            frontierUp: [
                { urn: 'c0', totalCount: 4, nextCursor: null },
                { urn: 'c1', totalCount: 3, nextCursor: null },
            ],
        })
        // T is the branch (two children), so it is one collapsed card —
        // and its pill has to speak for both columns beneath it: neither
        // has any upstream in the model yet, so the whole 4 + 3 is left.
        const g = layout(sg)
        expect(cardFor(g, 'T')!.kind).toBe('entity')
        expect(cardFor(g, 'T')!.pillUp).toMatchObject({ kind: 'extend', count: 7, key: 'in:T' })
    })
})

// ── cycles ───────────────────────────────────────────────────────────

describe('focus-layout — cycle badge', () => {
    it('stamps only the hop that closes the loop', () => {
        const sg = subgraph({
            focus: 'F',
            nodes: [wnode('F'), wnode('A'), wnode('B')],
            contains: [],
            hops: [['F', 'A'], ['A', 'B'], ['B', 'A']],
        })
        // B only exists once the walk steps out of A — one hop at a time.
        const g = layout(sg, withReveal(initialLensViewState(sg), 'out:A', 1))
        const byPair = new Map(g.edges.map(e => [`${e.source} ${e.target}`, e]))
        const id = (u: string) => cardFor(g, u)!.id
        expect(byPair.get(`${id('B')} ${id('A')}`)!.cycleBack).toBe(true)
        expect(byPair.get(`${id('F')} ${id('A')}`)!.cycleBack).toBe(false)
        expect(byPair.get(`${id('A')} ${id('B')}`)!.cycleBack).toBe(false)
    })

    it('does not stamp a diamond — two paths to one node is not a cycle', () => {
        const sg = subgraph({
            focus: 'F',
            nodes: [wnode('F'), wnode('A'), wnode('B'), wnode('D')],
            contains: [],
            hops: [['F', 'A'], ['F', 'B'], ['A', 'D'], ['B', 'D']],
        })
        const g = layout(sg)
        expect(g.edges.some(e => e.cycleBack)).toBe(false)
    })
})

// ── the honesty rules, carried over from the old builder ─────────────

describe('focus-layout — one card per entity', () => {
    it('draws a node that sits on BOTH sides of the focus exactly once', () => {
        const sg = subgraph({
            focus: 'F',
            nodes: [wnode('F'), wnode('X')],
            contains: [],
            hops: [['X', 'F'], ['F', 'X']],
        })
        const g = layout(sg)
        const ids = urns(g)
        expect(ids.filter(u => u === 'X')).toHaveLength(1)
        expect(new Set(ids).size).toBe(ids.length)
        expect(new Set(g.cards.map(c => c.id)).size).toBe(g.cards.length)
    })

    it('never emits two edges with the same id', () => {
        const g = layout(collateralEstate())
        const ids = g.edges.map(e => e.id)
        expect(new Set(ids).size).toBe(ids.length)
    })
})

describe('focus-layout — filters', () => {
    it('the text filter DIMS misses and never removes them', () => {
        const sg = collateralEstate()
        const all = layout(sg)
        const filtered = layout(sg, initialLensViewState(sg), { query: 'RISK_DB' })
        expect(filtered.cards).toHaveLength(all.cards.length)
        expect(cardFor(filtered, 'DB')!.dimmed).toBe(false)
        expect(cardFor(filtered, 'DOM')!.dimmed).toBe(true)
    })

    it('the type chips REMOVE, and the removed count is reported per direction', () => {
        const sg = collateralEstate()
        const g = layout(sg, initialLensViewState(sg), { hiddenTypes: new Set(['DATADOMAIN']) })
        expect(cardFor(g, 'DOM')).toBeUndefined()
        // The whole estate inside it goes with it, and says so — the four
        // containers below it and the three tables at the bottom.
        expect(cardFor(g, 'DB')).toBeUndefined()
        expect(g.hiddenByChips).toBe(8)
        expect(g.hiddenByChipsIn).toBe(8)
        expect(g.hiddenByChipsOut).toBe(0)
        // The focus is never chipped away by its own type.
        const keepFocus = layout(sg, initialLensViewState(sg), { hiddenTypes: new Set(['dataset']) })
        expect(cardFor(keepFocus, 'F')).toBeDefined()
    })
})

describe('focus-layout — dead-end honesty', () => {
    it('an unwalked direction is never claimed as a dead end', () => {
        // Downstream was never fetched — the model simply has no edge
        // there yet, and a frontier entry says the walk can continue.
        const sg = subgraph({
            focus: 'F',
            nodes: [wnode('F'), wnode('U')],
            contains: [],
            hops: [['U', 'F']],
            frontierDown: [{ urn: 'F', totalCount: null, nextCursor: null }],
        })
        const g = layout(sg)
        expect(cardFor(g, 'F')!.deadEnd).toBe(false)
        expect(cardFor(g, 'F')!.pillDown).toMatchObject({ kind: 'extend', count: null })
    })
})

describe('focus-layout — frames page instead of growing', () => {
    it('shows one fixed window of children and reports the rest', () => {
        const nodes = [wnode('F'), wnode('T', 'dataset', 'wide_table', { childCount: 40 })]
        const contains: Array<[string, string]> = []
        const hops: Array<[string, string]> = []
        for (let i = 0; i < 20; i++) {
            const c = `w${String(i).padStart(2, '0')}`
            nodes.push(wnode(c, 'schemaField', `column_${String(i).padStart(2, '0')}`))
            contains.push(['T', c])
            hops.push([c, 'F'])
        }
        const sg = subgraph({ focus: 'F', nodes, contains, hops })
        const base = initialLensViewState(sg)
        const open = { ...base, expandedContainment: new Set([...base.expandedContainment, 'T']) }
        const g = layout(sg, open)
        const frame = cardFor(g, 'T')!
        const rows = g.cards.filter(c => c.frameId === frame.id)
        expect(rows).toHaveLength(FRAME_CHILD_CAP)
        expect(frame.frameLoaded).toBe(20)
        expect(rows.map(r => r.nodeId)).toEqual(['w00', 'w01', 'w02', 'w03', 'w04', 'w05', 'w06', 'w07'])
        // A later page is the SAME window moved, not a taller frame.
        const paged = layout(sg, { ...open, framePages: new Map([['T', 1]]) })
        const pagedRows = paged.cards.filter(c => c.frameId === cardFor(paged, 'T')!.id)
        expect(pagedRows).toHaveLength(FRAME_CHILD_CAP)
        expect(pagedRows[0].nodeId).toBe('w08')
        expect(cardFor(paged, 'T')!.h).toBe(frame.h)
    })

    it('the All roster shows what is inside but off the lineage, marked', () => {
        const sg = subgraph({
            focus: 'F',
            nodes: [wnode('F'), wnode('T', 'dataset', 'src'), wnode('c0', 'schemaField', 'amount')],
            contains: [['T', 'c0']],
            hops: [['c0', 'F']],
        })
        const base = initialLensViewState(sg)
        const g = layout(sg, {
            ...base,
            expandedContainment: new Set([...base.expandedContainment, 'T']),
            frameShowAll: new Set(['T']),
        }, {
            childrenAll: new Map([['T', {
                children: [wnode('c0', 'schemaField', 'amount'), wnode('c9', 'schemaField', 'unused_col')],
                hasMore: false,
                total: 2,
            }]]),
            childrenAllStatus: new Map([['T', 'done']]),
        })
        expect(cardFor(g, 'c0')!.connected).toBe(true)
        expect(cardFor(g, 'c9')!.connected).toBe(false)
        expect(cardFor(g, 'T')!.frameShowingAll).toBe(true)
        expect(cardFor(g, 'T')!.frameTotal).toBe(2)
    })
})

describe('focus-layout — determinism', () => {
    it('two builds of the same input are identical, cards, edges and geometry', () => {
        const sg = collateralEstate()
        const view = withReveal(initialLensViewState(sg), 'in:F', 2)
        const a = layout(sg, view)
        const b = layout(sg, view)
        expect(JSON.stringify(a.cards)).toEqual(JSON.stringify(b.cards))
        expect(JSON.stringify(a.edges)).toEqual(JSON.stringify(b.edges))
        expect([...a.bandTotals.entries()]).toEqual([...b.bandTotals.entries()])
    })

    it('bands the cards by signed hop distance, focus at column zero', () => {
        const sg = subgraph({
            focus: 'F',
            nodes: [wnode('F'), wnode('U1'), wnode('U2'), wnode('D1')],
            contains: [],
            hops: [['U2', 'U1'], ['U1', 'F'], ['F', 'D1']],
        })
        const g = layout(sg, withReveal(initialLensViewState(sg), 'in:U1', 1))
        expect(cardFor(g, 'F')!.band).toBe(0)
        expect(cardFor(g, 'U1')!.band).toBe(-1)
        expect(cardFor(g, 'U2')!.band).toBe(-2)
        expect(cardFor(g, 'D1')!.band).toBe(1)
        expect(cardFor(g, 'U2')!.x).toBeLessThan(cardFor(g, 'U1')!.x)
        expect(cardFor(g, 'D1')!.x).toBeGreaterThan(cardFor(g, 'F')!.x)
    })
})
