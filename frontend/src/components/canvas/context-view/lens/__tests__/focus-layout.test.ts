/**
 * focus-layout — the walk-model layout engine.
 *
 * Several names here are SALVAGED from the retired focus-graph.test.ts
 * on purpose:
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
    pathToFocus,
    buildWalkExport,
    walkExportToCsv,
    REVEAL_PAGE,
    type LensViewState,
    type FocusLayoutInput,
} from '../focus-layout'
import { FOCAL_H, FRAME_CHILD_CAP, type FocusCard, type FocusEdge } from '../focus-cards'

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

    it('lands with the focus already on the board, at the top level, its container a breadcrumb', () => {
        const g = layout(collateralEstate())
        const focus = cardFor(g, 'F')
        expect(focus).toBeDefined()
        // R1: nothing ABOVE the focus is geometry. `fin_marts` is where
        // it lives, and the card says so in text rather than wrapping a
        // box around the thing the whole picture is about.
        expect(focus!.frameId).toBeNull()
        expect(cardFor(g, 'FT')).toBeUndefined()
        expect(focus!.ancestry).toEqual(['fin_marts'])
        expect(focus!.ancestryIds).toEqual(['FT'])
    })
})

// ── population and the answer grain ──────────────────────────────────

describe('focus-layout — the answer grain', () => {
    it('walks through the pass-through levels to the first branch, and draws none of them', () => {
        const g = layout(collateralEstate())
        // Every single-child level between the group root and the branch
        // is chrome the walk saw through — and chrome is not geometry.
        for (const skipped of ['DOM', 'APP', 'CTR1', 'CTR2']) {
            expect(cardFor(g, skipped)).toBeUndefined()
        }
        // The branch itself is the answer grain: one free-standing card
        // standing for its three tables, not three loose cards, and not
        // wrapped in four boxes either.
        const db = cardFor(g, 'DB')!
        expect(db.kind).toBe('entity')
        expect(db.frameId).toBeNull()
        expect(db.band).toBe(-1)
        expect(cardFor(g, 't0')).toBeUndefined()
        expect(db.contents).toEqual({ onLineage: 3, total: 12 })
        // The levels it was walked through are its breadcrumb.
        expect(db.ancestry).toEqual(['Finance', 'RiskApp', 'PROD', 'CURATED'])
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
     *  no type→level map can describe.
     *
     *  R BRANCHES (a leaf of its own beside the chain), so R is the
     *  presented grain — and everything below it is nesting the user
     *  asks for, one open at a time. */
    function recursiveEstate(): LensSubgraph<LensWalkNode> {
        const nodes = [wnode('F', 'Node', 'focus'), wnode('FP', 'Node', 'focus_parent')]
        const contains: Array<[string, string]> = [['FP', 'F']]
        const hops: Array<[string, string]> = [['leafC', 'F']]
        for (const [parent, child] of [['R', 'R1'], ['R1', 'R2']] as Array<[string, string]>) {
            contains.push([parent, child])
        }
        nodes.push(
            wnode('R', 'Node', 'estate'), wnode('R1', 'Node', 'estate_1'), wnode('R2', 'Node', 'estate_2'),
            wnode('leafC', 'Node', 'leafC'),
        )
        contains.push(['R', 'leafC'])
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
        const g = layout(sg, {
            ...base,
            expandedContainment: new Set([...base.expandedContainment, 'R', 'R1', 'R2']),
        })
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
        // R, R1, R2 — every one of them opened by hand. NOT the focus's
        // own parent FP, which is above the focus and therefore a
        // breadcrumb (R1), not a box.
        expect(g.cards.filter(c => c.kind === 'frame')).toHaveLength(3)
        expect(cardFor(g, 'FP')).toBeUndefined()
    })
})

// ── frames only where they clarify ───────────────────────────────────

/**
 * The reported live shape: the focus and its lineage partners live in
 * the SAME platform.
 *
 *   Snowflake ⊃ REPORTING (focus, holding two tables)
 *   Snowflake ⊃ GOLD ⊃ dim_customer      → upstream
 *   Snowflake ⊃ INT_T2                   → upstream
 *   BI ⊃ exec_dashboard                  → downstream, outside Snowflake
 *
 * Drawn as one Snowflake frame, this is the tower: focus and both
 * sources stacked in a single box, no hop columns, wires looping back
 * through it.
 */
function sharedPlatform(): LensSubgraph<LensWalkNode> {
    return subgraph({
        focus: 'REPORTING',
        nodes: [
            wnode('SNOW', 'PLATFORM', 'Snowflake', { childCount: 12 }),
            wnode('REPORTING', 'CONTAINER', 'REPORTING', { childCount: 9 }),
            wnode('rep_a', 'dataset', 'rpt_revenue'),
            wnode('rep_b', 'dataset', 'rpt_churn'),
            wnode('GOLD', 'CONTAINER', 'GOLD', { childCount: 6 }),
            wnode('gold_t', 'dataset', 'dim_customer'),
            wnode('INT_T2', 'CONTAINER', 'INTERMEDIATE_T2', { childCount: 4 }),
            wnode('BI', 'PLATFORM', 'BI', { childCount: 3 }),
            wnode('dash', 'dataset', 'exec_dashboard'),
        ],
        contains: [
            ['SNOW', 'REPORTING'], ['SNOW', 'GOLD'], ['SNOW', 'INT_T2'],
            ['REPORTING', 'rep_a'], ['REPORTING', 'rep_b'],
            ['GOLD', 'gold_t'],
            ['BI', 'dash'],
        ],
        hops: [
            ['gold_t', 'rep_a'], ['gold_t', 'rep_b'], ['INT_T2', 'rep_a'],
            ['rep_a', 'dash'],
        ],
    })
}

describe('focus-layout — frames only where they clarify', () => {
    it('R1: the focus is never inside an ancestor frame — the levels above it are breadcrumb data', () => {
        const g = layout(sharedPlatform())
        const focus = cardFor(g, 'REPORTING')!
        expect(focus.frameId).toBeNull()
        expect(focus.band).toBe(0)
        // The platform is gone from the GEOMETRY...
        expect(cardFor(g, 'SNOW')).toBeUndefined()
        // ...and present as the context every card already carries.
        expect(focus.ancestry).toEqual(['Snowflake'])
        expect(focus.ancestryIds).toEqual(['SNOW'])
    })

    it('R1: the focus is a COMPACT CARD, and what it holds is the contains-stack below it', () => {
        const g = layout(sharedPlatform())
        const focus = cardFor(g, 'REPORTING')!
        // Never a frame: the thing you asked about does not become a box
        // the rest of the board sits beside.
        expect(focus.kind).toBe('focal')
        expect(focus.h).toBe(FOCAL_H)
        expect(g.cards.some(c => c.frameId === focus.id)).toBe(false)

        // Its contents hang below it, in its own band, as one stack.
        const stack = g.cards.find(c => c.id === `co:REPORTING`)!
        expect(stack).toBeDefined()
        expect(stack.nodeId).toBeNull()
        expect(stack.band).toBe(0)
        expect(stack.frameId).toBeNull()
        expect(stack.expandKey).toBe('REPORTING')
        expect(stack.contents).toEqual({ onLineage: 2, total: 9 })
        expect(stack.y).toBeGreaterThan(focus.y + focus.h - 1)
        for (const table of ['rep_a', 'rep_b']) {
            expect(cardFor(g, table)!.frameId).toBe(stack.id)
        }
    })

    it('R1: a focus that holds nothing has no stack under it', () => {
        const g = layout(collateralEstate())
        expect(cardFor(g, 'F')!.kind).toBe('focal')
        expect(g.cards.some(c => c.id.startsWith('co:'))).toBe(false)
    })

    it('R1: the contains-stack closes to one card, and the rows go with it', () => {
        const sg = sharedPlatform()
        const base = initialLensViewState(sg)
        const g = layout(sg, { ...base, collapsedContainment: new Set(['REPORTING']) })
        const stack = g.cards.find(c => c.id === 'co:REPORTING')!
        expect(stack.childrenOpen).toBe(false)
        expect(g.cards.some(c => c.frameId === stack.id)).toBe(false)
        // Still says what is in there, so it can be opened again.
        expect(stack.contents).toEqual({ onLineage: 2, total: 9 })
    })

    it('R1b: every hop into the focus lands on the FOCAL card, whatever grain it was drawn at', () => {
        const g = layout(sharedPlatform())
        const focal = cardFor(g, 'REPORTING')!
        // Four raw hops reach two different tables INSIDE the focus, and
        // one leaves it — they arrive at, and leave from, the focal's own
        // ports as bundles, so the contains-stack rows carry no wires.
        for (const table of ['rep_a', 'rep_b']) {
            const row = cardFor(g, table)!
            expect(g.edges.some(e => e.source === row.id || e.target === row.id)).toBe(false)
        }
        const into = g.edges.filter(e => e.target === focal.id)
        expect(into).toHaveLength(2)
        // dim_customer reaches TWO of the focus's tables: one wire, and it
        // says two rather than pretending to be one hop.
        expect(into.find(e => e.source === cardFor(g, 'gold_t')!.id)!.count).toBe(2)
        expect(into.find(e => e.source === cardFor(g, 'INT_T2')!.id)!.count).toBe(1)
        expect(g.edges.filter(e => e.source === focal.id)).toHaveLength(1)
    })

    it('R1b: the focal speaks for its whole subtree — one ⊕, not one per row', () => {
        const sg = subgraph({
            focus: 'FT',
            nodes: [wnode('FT', 'dataset', 'orders'), wnode('c0'), wnode('c1'), wnode('U')],
            contains: [['FT', 'c0'], ['FT', 'c1']],
            hops: [['U', 'c0']],
            frontierUp: [{ urn: 'c0', totalCount: 7, nextCursor: null }],
        })
        const g = layout(sg)
        expect(cardFor(g, 'FT')!.pillUp).toMatchObject({ kind: 'extend', count: 6 })
        for (const row of ['c0', 'c1']) {
            expect(cardFor(g, row)!.pillUp).toBeNull()
            expect(cardFor(g, row)!.deadEnd).toBe(false)
        }
    })

    it('R2: an ancestor is NEVER a passive wrapper — not even around a single group', () => {
        const g = layout(sharedPlatform())
        // The platform, and every container the walk saw through on its
        // way to an answer: no card at all — not a collapsed one, not an
        // empty one, none.
        for (const skipped of ['SNOW', 'GOLD', 'BI']) {
            expect(urns(g)).not.toContain(skipped)
        }
        // What each group presented instead is free-standing, in its own
        // hop column, carrying the levels it was walked through.
        const source = cardFor(g, 'gold_t')!
        expect(source.frameId).toBeNull()
        expect(source.band).toBe(-1)
        expect(source.ancestry).toEqual(['Snowflake', 'GOLD'])
        const consumer = cardFor(g, 'dash')!
        expect(consumer.frameId).toBeNull()
        expect(consumer.band).toBe(1)
        expect(consumer.ancestry).toEqual(['BI'])
        // A container with nothing inside it on this lineage is its own
        // presented grain, and stands in its column as a card.
        expect(cardFor(g, 'INT_T2')!.band).toBe(-1)
        expect(cardFor(g, 'INT_T2')!.ancestry).toEqual(['Snowflake'])
    })

    it('R2: the whole estate spine is breadcrumb, however many levels deep', () => {
        // Five levels of containment over one answer. Not one of them is
        // a box; all five are text on the card that IS the answer.
        const g = layout(collateralEstate())
        for (const skipped of ['DOM', 'APP', 'CTR1', 'CTR2']) {
            expect(urns(g)).not.toContain(skipped)
        }
        expect(g.cards.filter(c => c.kind === 'frame')).toHaveLength(0)
        expect(cardFor(g, 'DB')!.ancestry).toEqual(['Finance', 'RiskApp', 'PROD', 'CURATED'])
    })

    it('R2: a frame comes from being OPENED — the presented entity, and containers inside it', () => {
        const sg = collateralEstate()
        const base = initialLensViewState(sg)
        // The user opens the presented entity: NOW it is a frame, and its
        // lineage-relevant contents are its rows.
        const g = layout(sg, { ...base, expandedContainment: new Set([...base.expandedContainment, 'DB']) })
        const db = cardFor(g, 'DB')!
        expect(db.kind).toBe('frame')
        expect(db.frameId).toBeNull()
        for (const t of ['t0', 't1', 't2']) expect(cardFor(g, t)!.frameId).toBe(db.id)
        // Still no wrappers above it.
        for (const skipped of ['DOM', 'APP', 'CTR1', 'CTR2']) {
            expect(urns(g)).not.toContain(skipped)
        }
    })

    it('R2: the answer grain never sees through an entity the data source put on a hop', () => {
        // `LAKE` has one child, so by shape alone it would be walked
        // through — but it is itself a source of the focus. It IS the
        // answer at its grain, so it is presented, and its wire has a
        // card to land on.
        const sg = subgraph({
            focus: 'F',
            nodes: [
                wnode('LAKE', 'PLATFORM', 'Lakehouse'),
                wnode('inner', 'dataset', 'raw_charges'),
                wnode('F', 'dataset', 'clean_charges'),
            ],
            contains: [['LAKE', 'inner']],
            hops: [['LAKE', 'F'], ['inner', 'F']],
        })
        const g = layout(sg)
        const lake = cardFor(g, 'LAKE')!
        expect(lake).toBeDefined()
        expect(lake.frameId).toBeNull()
        expect(lake.kind).toBe('entity')          // presented, not opened
        expect(g.edges.some(e => e.source === lake.id && e.target === cardFor(g, 'F')!.id)).toBe(true)
    })

    it('R3: the hop columns and their band headers come back', () => {
        const g = layout(sharedPlatform())
        // Left of the focus, right of the focus — the skeleton the tower
        // ate. Columns are x-ordered, and both directions have a header
        // with something in it.
        expect(cardFor(g, 'gold_t')!.x).toBeLessThan(cardFor(g, 'REPORTING')!.x)
        expect(cardFor(g, 'dash')!.x).toBeGreaterThan(cardFor(g, 'REPORTING')!.x)
        expect(g.bandTotals.get('band:in:1')?.shown).toBe(2)
        expect(g.bandTotals.get('band:out:1')?.shown).toBe(1)
        // Three raw hops arrive from the upstream column, and its header
        // says three rather than "2 cards".
        expect(g.bandTotals.get('band:in:1')?.connections).toBe(3)
    })

    it('R3: every wire still lands — skipping a level moves cards, it never drops a hop', () => {
        const g = layout(sharedPlatform())
        const byId = new Map(g.cards.map(c => [c.id, c.nodeId]))
        const drawn = g.edges.map(e => `${byId.get(e.source)}>${byId.get(e.target)}`).sort()
        // Four raw hops, three drawn wires — every one of them between
        // cards that are on the board, converging on the focal.
        expect(drawn).toEqual(['INT_T2>REPORTING', 'REPORTING>dash', 'gold_t>REPORTING'])
        expect(g.edges.reduce((n, e) => n + e.count, 0)).toBe(4)
    })

    it('the export names a parent only when the picture has one — no dangling ids', () => {
        const g = layout(sharedPlatform())
        const payload = buildWalkExport(g, 'REPORTING', () => 'now')
        const urns = new Set(payload.nodes.map(n => n.urn))
        for (const node of payload.nodes) {
            if (node.parentUrn !== null) expect(urns.has(node.parentUrn)).toBe(true)
            expect(node.parentUrn === null).toBe(node.depth === 0)
        }
        // dim_customer really is inside GOLD, and really is top-level here.
        expect(payload.nodes.find(n => n.urn === 'gold_t')?.parentUrn).toBeNull()
        // ...while the focus's own contents keep the parent they are
        // drawn inside — the contains-stack is the focus's card.
        expect(payload.nodes.find(n => n.urn === 'rep_a')?.parentUrn).toBe('REPORTING')
    })

    it('R6: an empty SIDE is the model\'s answer, and an empty band is not', () => {
        // The shared platform has upstream AND downstream in the model —
        // whatever geometry does with them.
        const shared = layout(sharedPlatform())
        expect(shared.modelHasUpstream).toBe(true)
        expect(shared.modelHasDownstream).toBe(true)

        // Downstream only: the upstream side is genuinely empty, and
        // that is the ONE case the whisper may be made in.
        const oneWay = layout(subgraph({
            focus: 'F',
            nodes: [wnode('F'), wnode('D')],
            contains: [],
            hops: [['F', 'D']],
        }))
        expect(oneWay.modelHasUpstream).toBe(false)
        expect(oneWay.modelHasDownstream).toBe(true)
    })

    it('R5: a single hop has no ×N to draw', () => {
        const g = layout(fanIn([1]))
        expect(g.edges).toHaveLength(1)
        expect(g.edges[0].count).toBe(1)
        expect(g.edges[0].labelVisible).toBe(false)
    })

    it('R5: a bundle of several hops with a run to sit on IS labelled', () => {
        const g = layout(fanIn([3]))
        expect(g.edges[0].count).toBe(3)
        expect(g.edges[0].labelVisible).toBe(true)
    })

    it('R5: a bundle whose drawn line is too short to hold a badge does not get one', () => {
        // A row inside an opened frame, one column over: the wire is a
        // ~70px stub, and a pill on it floats free of both ends. This is
        // the shape that produced badge confetti.
        const sg = subgraph({
            focus: 'F',
            nodes: [
                wnode('F', 'dataset', 'clean_charges'),
                wnode('UT', 'dataset', 'raw_charges', { childCount: 8 }),
                wnode('u1', 'schemaField', 'charge_id'),
                wnode('u2', 'schemaField', 'amount'),
            ],
            contains: [['UT', 'u1'], ['UT', 'u2']],
            hops: [['u1', 'F'], ['u1', 'F', 'JOINS'], ['u2', 'F']],
        })
        const base = initialLensViewState(sg)
        const g = layout(sg, { ...base, expandedContainment: new Set([...base.expandedContainment, 'UT']) })
        const wire = g.edges.find(e => e.source === cardFor(g, 'u1')!.id)!
        expect(wire.count).toBe(2)
        expect(wire.labelVisible).toBe(false)
    })

    it('R6: a frontier the data source reported is not an empty side, even with nothing in hand', () => {
        const g = layout(subgraph({
            focus: 'F',
            nodes: [wnode('F')],
            contains: [],
            hops: [],
            frontierUp: [{ urn: 'F', totalCount: 5, nextCursor: null }],
        }))
        expect(g.modelHasUpstream).toBe(true)
        expect(g.modelHasDownstream).toBe(false)
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

    it('never offers a reveal the click cannot deliver', () => {
        // c2 lives INSIDE T and is only reachable by a hop from c1, which
        // is also inside T. While T is collapsed it stands for c1 — and a
        // pill there would act on T, whose own reveal treats c2 as
        // internal and admits nothing. So T must stay silent, and the
        // offer must appear once T is opened and c1 can speak for itself.
        const sg = subgraph({
            focus: 'F',
            nodes: [wnode('F'), wnode('T', 'dataset', 'src'), wnode('c1'), wnode('c2'), wnode('c3')],
            // c1 and c3 both reach the focus, so T BRANCHES and stays a
            // single collapsed card standing for both of them.
            contains: [['T', 'c1'], ['T', 'c2'], ['T', 'c3']],
            hops: [['c1', 'F'], ['c3', 'F'], ['c2', 'c1']],
        })
        const closed = layout(sg)
        expect(cardFor(closed, 'T')!.kind).toBe('entity')
        expect(cardFor(closed, 'T')!.pillUp).toBeNull()

        const base = initialLensViewState(sg)
        const opened = { ...base, expandedContainment: new Set([...base.expandedContainment, 'T']) }
        const open = layout(sg, opened)
        expect(cardFor(open, 'c1')!.pillUp).toMatchObject({ kind: 'reveal', count: 1, key: 'in:c1' })
        // And clicking it delivers exactly what it promised.
        const revealed = layout(sg, { ...opened, revealed: new Map([...opened.revealed, ['in:c1', 1]]) })
        expect(cardFor(revealed, 'c2')).toBeDefined()
        expect(cardFor(revealed, 'c1')!.pillUp).toBeNull()
    })

    it('spends a page only on what it introduces — a shared neighbour is free', () => {
        // A and B both feed the focus and SHARE twelve upstream sources;
        // B has one more of its own, ranked last. Reveal A first and its
        // twelve fill the whole ranking prefix of B's page — so slicing
        // the raw ranking spent B's entire page on cards already drawn and
        // B's "+1" did nothing, forever.
        const nodes = [wnode('F'), wnode('A', 'dataset', 'a_table'), wnode('B', 'dataset', 'b_table')]
        const hops: Array<[string, string]> = [['A', 'F'], ['B', 'F']]
        for (let i = 0; i < 12; i++) {
            const s = `s${String(i).padStart(2, '0')}`
            nodes.push(wnode(s, 'dataset', `shared_${String(i).padStart(2, '0')}`))
            hops.push([s, 'A'])
            // Two hops into B, so every shared source outranks the extra.
            hops.push([s, 'B'], [s, 'B'])
        }
        nodes.push(wnode('X', 'dataset', 'only_b_has_me'))
        hops.push(['X', 'B'])
        const sg = subgraph({ focus: 'F', nodes, contains: [], hops })

        const afterA = withReveal(initialLensViewState(sg), 'in:A', 1)
        const g1 = layout(sg, afterA)
        expect(cardFor(g1, 's00')).toBeDefined()
        expect(cardFor(g1, 'X')).toBeUndefined()
        expect(cardFor(g1, 'B')!.pillUp).toMatchObject({ kind: 'reveal', count: 1, key: 'in:B' })

        // Clicking B's ⊕ must actually deliver the one it promised.
        const g2 = layout(sg, withReveal(afterA, 'in:B', 1))
        expect(cardFor(g2, 'X')).toBeDefined()
        expect(cardFor(g2, 'B')!.pillUp).toBeNull()
        // ...and it stays a walk, not a dump: the shared twelve were free,
        // but a page is still a page.
        expect(g2.cards.filter(c => c.nodeId?.startsWith('s')).length).toBe(12)
    })

    it('a page delivers a page, and the badge is the remainder', () => {
        const sg = fanIn(new Array(20).fill(1))
        const one = layout(sg)
        expect(urns(one).filter(u => u !== 'F')).toHaveLength(REVEAL_PAGE)
        expect(cardFor(one, 'F')!.pillUp).toMatchObject({ count: 20 - REVEAL_PAGE })
        // One more page: exactly the remainder arrives, and the ⊕ retires.
        const two = layout(sg, withReveal(initialLensViewState(sg), 'in:F', 2))
        expect(urns(two).filter(u => u !== 'F')).toHaveLength(20)
        expect(cardFor(two, 'F')!.pillUp).toBeNull()
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
        // No stamp either: U2 is drawn upstream of U, so the picture
        // already says where that side goes. The stamp is for a side
        // with NOTHING on it — see the drained test above.
        expect(cardFor(g, 'U')!.deadEnd).toBe(false)
        expect(cardFor(g, 'U2')!.deadEnd).toBe(true)
    })

    it('one frontier is offered once, at the grain that can act on it', () => {
        // Five containment levels above a column with more upstream. Only
        // the column's own card may carry that ⊕ — an ancestor repeating
        // it is four controls that cannot be told apart, stacked in the
        // gutter on top of each other. Those ancestors are now breadcrumb
        // rather than geometry, so there is nowhere for a copy to go.
        const sg = subgraph({
            focus: 'F',
            nodes: [
                wnode('F'), wnode('L0', 'Node', 'estate'), wnode('L1', 'Node', 'zone'),
                wnode('L2', 'Node', 'db'), wnode('leaf', 'Node', 'the_table'),
            ],
            contains: [['L0', 'L1'], ['L1', 'L2'], ['L2', 'leaf']],
            hops: [['leaf', 'F']],
            frontierUp: [{ urn: 'leaf', totalCount: 9, nextCursor: null }],
        })
        const g = layout(sg)
        expect(cardFor(g, 'leaf')!.pillUp).toMatchObject({ kind: 'extend', count: 9 })
        expect(g.cards.filter(c => c.pillUp !== null)).toHaveLength(1)
        for (const level of ['L0', 'L1', 'L2']) {
            expect(cardFor(g, level)).toBeUndefined()
        }
        expect(cardFor(g, 'leaf')!.ancestry).toEqual(['estate', 'zone', 'db'])
    })

    it('a COLLAPSED container still speaks for the frontier it hides', () => {
        const sg = subgraph({
            focus: 'F',
            nodes: [wnode('F'), wnode('T', 'dataset', 'src'), wnode('c0'), wnode('c1')],
            contains: [['T', 'c0'], ['T', 'c1']],
            hops: [['c0', 'F'], ['c1', 'F']],
            frontierUp: [{ urn: 'c0', totalCount: 4, nextCursor: null }],
        })
        // T is the branch, so its columns are hidden inside it — and its
        // pill has to carry what they cannot say for themselves.
        const closed = layout(sg)
        expect(cardFor(closed, 'T')!.pillUp).toMatchObject({ kind: 'extend', count: 4 })
        // Opened, the column speaks for itself and T falls silent.
        const base = initialLensViewState(sg)
        const open = layout(sg, { ...base, expandedContainment: new Set([...base.expandedContainment, 'T']) })
        expect(cardFor(open, 'T')!.pillUp).toBeNull()
        expect(cardFor(open, 'c0')!.pillUp).toMatchObject({ kind: 'extend', count: 4 })
    })

    it('the extend round-trip: the key the consumer passes back is the key the spinner lands on', () => {
        // T is a collapsed branch; the frontier really belongs to the two
        // columns hidden inside it. The contract is CARD-anchored: the
        // consumer calls extend(T, 'up', seedLeaves-from-T's-subtree), and
        // useLensWalk keys its in-flight map by that same T.
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
        const idle = layout(sg)
        const pill = cardFor(idle, 'T')!.pillUp!
        expect(pill.kind).toBe('extend')
        expect(pill.key).toBe('in:T')
        expect(pill.status).toBeUndefined()

        // Replay the consumer convention: split the key, hand the urn to
        // the hook, and the hook reports progress under the same urn.
        const [dir, target] = [pill.key.slice(0, pill.key.indexOf(':')), pill.key.slice(pill.key.indexOf(':') + 1)]
        expect(target).toBe('T')
        const inflight = layout(sg, initialLensViewState(sg), {
            extendStatus: new Map([[walkStatusKey(dir as 'in' | 'out', target), 'loading']]),
        })
        expect(cardFor(inflight, 'T')!.pillUp!.status).toBe('loading')
    })

    it('the page round-trip is NODE-anchored — a cursor names its own node', () => {
        // Same shape, but the server handed back a cursor for c0. A cursor
        // only means anything on the node it was issued for, so the key
        // names c0 and the spinner comes back on c0 — while the pill still
        // hangs off the card standing for it.
        const sg = subgraph({
            focus: 'F',
            nodes: [wnode('F'), wnode('T', 'dataset', 'src_table'), wnode('c0'), wnode('c1')],
            contains: [['T', 'c0'], ['T', 'c1']],
            hops: [['c0', 'F'], ['c1', 'F']],
            frontierUp: [{ urn: 'c0', totalCount: 90, nextCursor: 'cur-1' }],
        })
        const pill = cardFor(layout(sg), 'T')!.pillUp!
        expect(pill).toMatchObject({ kind: 'page', key: 'in:c0', cursor: 'cur-1' })
        const inflight = layout(sg, initialLensViewState(sg), {
            extendStatus: new Map([[walkStatusKey('in', 'c0'), 'loading']]),
        })
        expect(cardFor(inflight, 'T')!.pillUp!.status).toBe('loading')
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
        expect(cardFor(filtered, 'F')!.dimmed).toBe(true)
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
        // `T` carries TWO columns on this lineage, so it is the presented
        // grain rather than a level walked through, and it is what the
        // user opens to ask what else is in there.
        const sg = subgraph({
            focus: 'F',
            nodes: [
                wnode('F'), wnode('T', 'dataset', 'src'),
                wnode('c0', 'schemaField', 'amount'), wnode('c1', 'schemaField', 'currency'),
            ],
            contains: [['T', 'c0'], ['T', 'c1']],
            hops: [['c0', 'F'], ['c1', 'F']],
        })
        const base = initialLensViewState(sg)
        const g = layout(sg, {
            ...base,
            expandedContainment: new Set([...base.expandedContainment, 'T']),
            frameShowAll: new Set(['T']),
        }, {
            childrenAll: new Map([['T', {
                children: [
                    wnode('c0', 'schemaField', 'amount'),
                    wnode('c1', 'schemaField', 'currency'),
                    wnode('c9', 'schemaField', 'unused_col'),
                ],
                hasMore: false,
                total: 3,
            }]]),
            childrenAllStatus: new Map([['T', 'done']]),
        })
        expect(cardFor(g, 'c0')!.connected).toBe(true)
        expect(cardFor(g, 'c9')!.connected).toBe(false)
        expect(cardFor(g, 'T')!.frameShowingAll).toBe(true)
        expect(cardFor(g, 'T')!.frameTotal).toBe(3)
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

// ── direction preset (view-side filter) ─────────────────────────────

describe('focus-layout — direction filter (view-side; presentation, not data)', () => {
    const bothSides = () => subgraph({
        focus: 'F',
        nodes: [wnode('F'), wnode('U'), wnode('D')],
        contains: [],
        hops: [['U', 'F'], ['F', 'D']],
    })

    it('both (default): every side\'s cards and edges are present', () => {
        const sg = bothSides()
        const g = layout(sg, initialLensViewState(sg), { directionFilter: 'both' })
        expect(cardFor(g, 'U')).toBeDefined()
        expect(cardFor(g, 'D')).toBeDefined()
        expect(g.edges).toHaveLength(2)
    })

    it('Root cause (upstream-only) suppresses the downstream card, pill and edge', () => {
        const sg = bothSides()
        const g = layout(sg, initialLensViewState(sg), { directionFilter: 'in' })
        expect(cardFor(g, 'U')).toBeDefined()          // unfiltered side intact
        expect(cardFor(g, 'D')).toBeUndefined()        // filtered side: no card
        expect(cardFor(g, 'F')!.pillDown).toBeNull()   // filtered side: no pill
        expect(g.edges).toHaveLength(1)
        expect(g.edges[0].target).toBe(cardFor(g, 'F')!.id)
    })

    it('Impact (downstream-only) suppresses the upstream card, pill and edge', () => {
        const sg = bothSides()
        const g = layout(sg, initialLensViewState(sg), { directionFilter: 'out' })
        expect(cardFor(g, 'D')).toBeDefined()
        expect(cardFor(g, 'U')).toBeUndefined()
        expect(cardFor(g, 'F')!.pillUp).toBeNull()
        expect(g.edges).toHaveLength(1)
        expect(g.edges[0].source).toBe(cardFor(g, 'F')!.id)
    })

    it('never claims a dead end on a side the filter merely hid — that would misdescribe the data source', () => {
        // F has more downstream waiting (a frontier), but nothing from
        // that side is in the model yet — so there is no drawn wire to
        // fall back on, and a naive pill-only check would read as "the
        // walk ends here" the moment the pill is hidden by the filter.
        const sg = subgraph({
            focus: 'F',
            nodes: [wnode('F'), wnode('U')],
            contains: [],
            hops: [['U', 'F']],
            frontierDown: [{ urn: 'F', totalCount: 5, nextCursor: null }],
        })
        const both = layout(sg, initialLensViewState(sg), { directionFilter: 'both' })
        expect(cardFor(both, 'F')!.pillDown).toMatchObject({ kind: 'extend', count: 5 })
        expect(cardFor(both, 'F')!.deadEnd).toBe(false)

        const rootCauseOnly = layout(sg, initialLensViewState(sg), { directionFilter: 'in' })
        expect(cardFor(rootCauseOnly, 'F')!.pillDown).toBeNull()
        expect(cardFor(rootCauseOnly, 'F')!.deadEnd).toBe(false)
    })

    it('population is unchanged — counts stay true regardless of the filter', () => {
        const sg = bothSides()
        const both = layout(sg, initialLensViewState(sg), { directionFilter: 'both' })
        const filtered = layout(sg, initialLensViewState(sg), { directionFilter: 'in' })
        // The focus's own weight (raw hops touching its subtree) counts
        // BOTH sides even while only one renders — the filter is a view
        // over the walk, not a smaller walk.
        expect(cardFor(filtered, 'F')!.count).toBe(cardFor(both, 'F')!.count)
    })

    it('toggling back to both restores the picture identically', () => {
        const sg = bothSides()
        const original = layout(sg, initialLensViewState(sg), { directionFilter: 'both' })
        layout(sg, initialLensViewState(sg), { directionFilter: 'in' })   // toggle away
        const restored = layout(sg, initialLensViewState(sg), { directionFilter: 'both' })   // toggle back
        expect(JSON.stringify(restored.cards)).toEqual(JSON.stringify(original.cards))
        expect(JSON.stringify(restored.edges)).toEqual(JSON.stringify(original.edges))
    })

    it('defaults to both when omitted', () => {
        const sg = bothSides()
        const g = layout(sg)   // no directionFilter passed at all
        expect(cardFor(g, 'U')).toBeDefined()
        expect(cardFor(g, 'D')).toBeDefined()
    })
})

// ── path-to-focus highlight ──────────────────────────────────────────

describe('focus-layout — pathToFocus (client-side hover/selection highlight)', () => {
    const edge = (id: string, source: string, target: string): FocusEdge =>
        ({ id, source, target, count: 1, edgeTypeNorm: '', dimmed: false, cycleBack: false, labelVisible: false })

    it('a diamond: both branches to the focus highlight', () => {
        // H reaches focus F via two EQUAL-length paths: H-A-F and H-B-F.
        const edges = [edge('e1', 'H', 'A'), edge('e2', 'A', 'F'), edge('e3', 'H', 'B'), edge('e4', 'B', 'F')]
        const { cardIds, edgeKeys } = pathToFocus(edges, 'H', 'F')
        expect(cardIds).toEqual(new Set(['H', 'A', 'B', 'F']))
        expect(edgeKeys).toEqual(new Set(['e1', 'e2', 'e3', 'e4']))
    })

    it('a single path (no diamond) highlights exactly its own hops, not a longer detour', () => {
        const edges = [edge('e1', 'A', 'B'), edge('e2', 'B', 'F'), edge('e3', 'A', 'F')]
        const { cardIds, edgeKeys } = pathToFocus(edges, 'A', 'F')
        expect(cardIds).toEqual(new Set(['A', 'F']))
        expect(edgeKeys).toEqual(new Set(['e3']))
    })

    it('no path: nothing dims — the shape a roster extra (no projected edge at all) is in', () => {
        const edges = [edge('e1', 'A', 'F')]
        const { cardIds, edgeKeys } = pathToFocus(edges, 'X', 'F')
        expect(cardIds.size).toBe(0)
        expect(edgeKeys.size).toBe(0)
    })

    it('is undirected: a hop drawn TOWARD the hovered card still counts', () => {
        const edges = [edge('e1', 'F', 'A')]   // F -> A, but we hover A looking for a path to F
        const { cardIds, edgeKeys } = pathToFocus(edges, 'A', 'F')
        expect(cardIds).toEqual(new Set(['A', 'F']))
        expect(edgeKeys).toEqual(new Set(['e1']))
    })

    it('hovering the focus itself finds nothing to highlight', () => {
        const edges = [edge('e1', 'A', 'F')]
        const { cardIds, edgeKeys } = pathToFocus(edges, 'F', 'F')
        expect(cardIds.size).toBe(0)
        expect(edgeKeys.size).toBe(0)
    })

    it('is cycle-safe: a loop among the projected edges terminates and still finds the path', () => {
        // A cycle A-B-C-A, with the only route to the focus running through A.
        const edges = [edge('e1', 'A', 'B'), edge('e2', 'B', 'C'), edge('e3', 'C', 'A'), edge('e4', 'A', 'F')]
        const { cardIds, edgeKeys } = pathToFocus(edges, 'B', 'F')
        expect(cardIds).toEqual(new Set(['B', 'A', 'F']))
        expect(edgeKeys).toEqual(new Set(['e1', 'e4']))
    })
})

// ── walk export (JSON/CSV) ───────────────────────────────────────────

describe('focus-layout — walk export, pure and server-free', () => {
    it('serializes the visible picture to JSON: nodes with parent+depth, edges resolved to urns', () => {
        const sg = collateralEstate()
        const g = layout(sg)
        const payload = buildWalkExport(g, sg.focusUrn, () => '2026-08-13T00:00:00.000Z')
        expect(payload.focus).toBe('F')
        expect(payload.generatedAt).toBe('2026-08-13T00:00:00.000Z')
        // The estate above the answer is breadcrumb, not geometry, so it
        // is not in the picture and not in the export of the picture.
        expect(payload.nodes.some(n => n.urn === 'DOM')).toBe(false)
        const db = payload.nodes.find(n => n.urn === 'DB')!
        expect(db).toMatchObject({ name: 'RISK_DB', type: 'DATABASE', parentUrn: null, depth: 0 })
        // Edges are addressed by URN, not the layout's internal card ids —
        // and the three raw hops into DB bundle into one weighted edge.
        expect(payload.edges).toContainEqual({ sourceUrn: 'DB', targetUrn: 'F', type: 'DERIVES_FROM', weight: 3 })
    })

    it('reflects only what is VISIBLE — a collapsed branch drops out of the export too', () => {
        const sg = collateralEstate()
        const collapsed = layout(sg, { ...initialLensViewState(sg), collapsedContainment: new Set(['CTR1']) })
        const payload = buildWalkExport(collapsed, sg.focusUrn)
        expect(payload.nodes.some(n => n.urn === 'DB')).toBe(false)
        expect(payload.nodes.some(n => n.urn === 'CTR1')).toBe(true)
    })

    it('CSV is one file: a nodes table then an edges table, properly quoted', () => {
        const sg = collateralEstate()
        const payload = buildWalkExport(layout(sg), sg.focusUrn, () => '2026-08-13T00:00:00.000Z')
        const csv = walkExportToCsv(payload)
        const lines = csv.split('\n')
        expect(lines[0]).toBe('urn,name,type,parentUrn,depth')
        const blankAt = lines.indexOf('')
        expect(blankAt).toBeGreaterThan(0)
        expect(lines[blankAt + 1]).toBe('sourceUrn,targetUrn,type,weight')
        // A name that itself contains a comma is quoted, not corrupted.
        const withComma = { ...payload, nodes: [{ urn: 'x', name: 'Revenue, Q1', type: 't', parentUrn: null, depth: 0 }] }
        expect(walkExportToCsv(withComma)).toContain('"Revenue, Q1"')
        // A urn with no parent IN THE PICTURE renders as an EMPTY field,
        // not the literal string "null".
        expect(lines.some(l => l.startsWith('DB,RISK_DB,DATABASE,,0'))).toBe(true)
        expect(csv).not.toContain('null')
    })
})
