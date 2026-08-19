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
    isolationCone,
    buildWalkExport,
    walkExportToCsv,
    REVEAL_PAGE,
    type LensViewState,
    type FocusLayoutInput,
} from '../focus-layout'
import {
    FOCAL_H, FRAME_WINDOW, LABEL_MIN_RUN, frameWindow, labelFitsRun,
    type FocusCard, type FocusEdge,
} from '../focus-cards'

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

/** The same view with one container shut. The layout opens the level a
 *  hop ENDS in by itself — that is where the answer is — so a test about
 *  what a CLOSED container says has to close one. */
const shut = (view: LensViewState, urn: string): LensViewState =>
    ({ ...view, collapsedContainment: new Set([...view.collapsedContainment, urn]) })

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
    it('walks through the pass-through levels to the answer, and draws none of them', () => {
        const g = layout(collateralEstate())
        // Every single-child level between the group root and the answer
        // is chrome the walk saw through — and chrome is not geometry.
        for (const skipped of ['DOM', 'APP', 'CTR1', 'CTR2']) {
            expect(cardFor(g, skipped)).toBeUndefined()
        }
        // The three tables are where the hops END, so they are ROWS, and
        // the level that owns them is the answer: one free-standing frame
        // in its own column, counted, not four boxes deep.
        const db = cardFor(g, 'DB')!
        expect(db.kind).toBe('frame')
        expect(db.frameId).toBeNull()
        expect(db.band).toBe(-1)
        expect(db.contents).toEqual({ onLineage: 3, total: 12 })
        for (const t of ['t0', 't1', 't2']) expect(cardFor(g, t)!.frameId).toBe(db.id)
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

// ── count honesty (R1c) ─────────────────────────────────────────────

/** `collateralEstate()`'s own shape, with DB's declared childCount as
 *  the one thing that varies — the field this rule is about. */
const collateralEstateWithDbChildCount = (childCount?: number): LensSubgraph<LensWalkNode> => subgraph({
    focus: 'F',
    nodes: [
        wnode('DOM', 'DATADOMAIN', 'Finance'),
        wnode('APP', 'APPLICATION', 'RiskApp'),
        wnode('CTR1', 'CONTAINER', 'PROD'),
        wnode('CTR2', 'CONTAINER', 'CURATED'),
        wnode('DB', 'DATABASE', 'RISK_DB', childCount != null ? { childCount } : {}),
        wnode('FT', 'dataset', 'fin_marts'),
        wnode('F', 'dataset', 'collaterals'),
        wnode('t0', 'dataset', 'loan_positions'),
        wnode('t1', 'dataset', 'collateral_valuations'),
        wnode('t2', 'dataset', 'fx_rates'),
    ],
    contains: [
        ['DOM', 'APP'], ['APP', 'CTR1'], ['CTR1', 'CTR2'], ['CTR2', 'DB'],
        ['DB', 't0'], ['DB', 't1'], ['DB', 't2'],
        ['FT', 'F'],
    ],
    hops: [['t0', 'F'], ['t1', 'F'], ['t2', 'F']],
})

describe('focus-layout — count honesty (R1c)', () => {
    it('a declared total LESS than what the walk has found is never rendered — "8 on this lineage · of 0" made honest', () => {
        // DB's own declared childCount is stale/wrong (0) — the walk has
        // already found three of its tables on this lineage. A "total"
        // smaller than that is not a total; the honest statement is
        // "unknown".
        const db = cardFor(layout(collateralEstateWithDbChildCount(0)), 'DB')!
        expect(db.contents).toEqual({ onLineage: 3, total: null })
    })

    it('a MISSING declared count renders "k on this lineage" alone, never a fabricated total', () => {
        const db = cardFor(layout(collateralEstateWithDbChildCount(undefined)), 'DB')!
        expect(db.contents).toEqual({ onLineage: 3, total: null })
    })

    it('a declared total that is honestly ≥ what was found is still trusted (unchanged)', () => {
        const db = cardFor(layout(collateralEstateWithDbChildCount(12)), 'DB')!
        expect(db.contents).toEqual({ onLineage: 3, total: 12 })
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

    it('R7: the focus is ONE node, and what it holds are its own rows', () => {
        const g = layout(sharedPlatform())
        const focus = cardFor(g, 'REPORTING')!
        // The same node language as the partners it is drawn beside: one
        // box, holding its contents. It used to be a compact card with a
        // separate "Inside REPORTING" panel floating underneath — two
        // boxes for one entity, with the wires landing on the panel.
        expect(focus.kind).toBe('focal')
        expect(focus.frameId).toBeNull()
        expect(focus.band).toBe(0)
        expect(focus.childrenOpen).toBe(true)
        expect(focus.expandKey).toBe('REPORTING')
        expect(focus.contents).toEqual({ onLineage: 2, total: 9 })
        // Nothing else stands for the focus's contents any more.
        expect(g.cards.some(c => c.id.startsWith('co:'))).toBe(false)
        // Its rows are INSIDE it, and it is tall enough to hold them.
        for (const table of ['rep_a', 'rep_b']) {
            expect(cardFor(g, table)!.frameId).toBe(focus.id)
        }
        expect(focus.h).toBeGreaterThan(FOCAL_H)
        for (const table of ['rep_a', 'rep_b']) {
            const row = cardFor(g, table)!
            expect(row.y).toBeGreaterThanOrEqual(focus.y + FOCAL_H)
            expect(row.y + row.h).toBeLessThanOrEqual(focus.y + focus.h)
        }
    })

    it('R1: the focus is never chrome — one connected child and no hop of its own', () => {
        // The shape that took the whole board down: `Snowflake ⊃ BRONZE ⊃
        // clean_charges_t2 ⊃ ONE column`. The focus has exactly one
        // populated child and ships no hop itself, so every pass-through
        // test in the walk says "see through me" — and seeing through the
        // FOCUS demoted it out of the picture, taking the focal card, the
        // its rows and (because every hop reprojects onto the focus)
        // every wire with it.
        const sg = subgraph({
            focus: 'F',
            nodes: [
                wnode('SNOW', 'PLATFORM', 'Snowflake'),
                wnode('BRONZE', 'CONTAINER', 'BRONZE'),
                wnode('SILVER', 'CONTAINER', 'SILVER'),
                wnode('F', 'dataset', 'clean_charges_t2', { childCount: 11 }),
                wnode('fc', 'schemaField', 'charge_id'),
                wnode('SRC', 'dataset', 'clean_charges', { childCount: 11 }),
                wnode('sc', 'schemaField', 'charge_id'),
            ],
            contains: [
                ['SNOW', 'BRONZE'], ['SNOW', 'SILVER'],
                ['BRONZE', 'F'], ['F', 'fc'],
                ['SILVER', 'SRC'], ['SRC', 'sc'],
            ],
            hops: [['sc', 'fc']],
        })
        const g = layout(sg)
        const focal = cardFor(g, 'F')!
        expect(focal.kind).toBe('focal')
        expect(focal.frameId).toBeNull()
        expect(focal.band).toBe(0)
        // Its one column is a row INSIDE it, not loose on the board.
        expect(cardFor(g, 'fc')!.frameId).toBe(focal.id)
        // And the wire is drawn column to column: both ends are on
        // screen, so it lands at the finest grain either of them has.
        // (It landed on the FOCAL until column-grain wiring; the focal's
        // ports are the rollup for a hop with nowhere finer to go.)
        expect(g.edges).toHaveLength(1)
        expect(g.edges[0].source).toBe(cardFor(g, 'sc')!.id)
        expect(g.edges[0].target).toBe(cardFor(g, 'fc')!.id)
    })

    it('R7: a focus that holds nothing stays the compact node it always was', () => {
        const g = layout(collateralEstate())
        const focus = cardFor(g, 'F')!
        expect(focus.kind).toBe('focal')
        expect(focus.childrenOpen).toBe(false)
        expect(focus.h).toBe(FOCAL_H)
        expect(g.cards.some(c => c.frameId === focus.id)).toBe(false)
    })

    it('R7: a SHUT focus showing "everything inside" draws no rows either', () => {
        // The one shape where "holds things" and "is showing them" came
        // apart. Shutting the focus takes its children out of the visible
        // set — which is exactly what makes every one of them a ROSTER
        // extra — so the rows the reader had just closed came straight
        // back as loose cards under a chevron saying there was nothing
        // to see, with no list region around them.
        const sg = sharedPlatform()
        const base = initialLensViewState(sg)
        const roster = {
            children: [
                wnode('rep_a', 'dataset', 'rpt_revenue'),
                wnode('rep_b', 'dataset', 'rpt_churn'),
                wnode('rep_c', 'dataset', 'rpt_margin'),
            ],
            hasMore: false,
            total: 9,
        }
        const g = layout(
            sg,
            {
                ...base,
                frameShowAll: new Set(['REPORTING']),
                collapsedContainment: new Set(['REPORTING']),
            },
            { childrenAll: new Map([['REPORTING', roster]]) },
        )
        const focus = cardFor(g, 'REPORTING')!
        // The chevron is honest, and nothing is drawn behind it.
        expect(focus.childrenOpen).toBe(false)
        expect(g.cards.filter(c => c.frameId === focus.id)).toHaveLength(0)
        expect(focus.h).toBe(FOCAL_H)
    })

    it('R7: a compact focus still says the walk ended at it; one holding rows leaves that to the bands', () => {
        // A frame never claims a dead end — its rows carry the lineage,
        // and "ends here" over an open estate full of live connections is
        // false. The focus became one of those in R7, so the claim now
        // depends on whether it HOLDS anything: the band whispers make
        // the data-source claim for the ones that do.
        const drained = (holds: boolean) => subgraph({
            focus: 'F',
            nodes: [
                wnode('U', 'dataset', 'upstream'),
                wnode('F', 'dataset', 'the_focus', holds ? { childCount: 2 } : {}),
                ...(holds ? [wnode('fc1', 'schemaField', 'a'), wnode('fc2', 'schemaField', 'b')] : []),
            ],
            contains: holds ? [['F', 'fc1'], ['F', 'fc2']] : [],
            hops: [['U', 'F']],
        })
        expect(cardFor(layout(drained(false)), 'F')!.deadEnd).toBe(true)
        expect(cardFor(layout(drained(true)), 'F')!.deadEnd).toBe(false)
    })

    it('R7: the focus closes to its header, and its rows go with it', () => {
        const sg = sharedPlatform()
        const base = initialLensViewState(sg)
        const g = layout(sg, { ...base, collapsedContainment: new Set(['REPORTING']) })
        const focus = cardFor(g, 'REPORTING')!
        expect(focus.childrenOpen).toBe(false)
        expect(focus.h).toBe(FOCAL_H)
        expect(g.cards.some(c => c.frameId === focus.id)).toBe(false)
        // Still says what is in there, so it can be opened again.
        expect(focus.contents).toEqual({ onLineage: 2, total: 9 })
    })

    it('R1b: a hop into the focus lands on the ROW that carries it, not on the focal', () => {
        const g = layout(sharedPlatform())
        const focal = cardFor(g, 'REPORTING')!
        // Four raw hops reach two different tables INSIDE the focus, and
        // one leaves it. Both tables are rows of the contains-stack and
        // both are on screen, so each hop lands on the row it is really
        // about — which table dim_customer feeds is the answer here, and
        // a single port on the focal could not state it.
        //
        // (Every one of these used to converge on the focal's two ports.
        // That is now what the ports are for when the finer end is NOT
        // drawn — see the column-grain suite.)
        const rowA = cardFor(g, 'rep_a')!
        const rowB = cardFor(g, 'rep_b')!
        const gold = cardFor(g, 'gold_t')!.id
        expect(g.edges.some(e => e.source === gold && e.target === rowA.id)).toBe(true)
        expect(g.edges.some(e => e.source === gold && e.target === rowB.id)).toBe(true)
        expect(g.edges.some(e => e.source === cardFor(g, 'INT_T2')!.id && e.target === rowA.id)).toBe(true)
        expect(g.edges.some(e => e.source === rowA.id && e.target === cardFor(g, 'dash')!.id)).toBe(true)
        // Nothing is left for the focal's own ports to carry.
        expect(g.edges.filter(e => e.source === focal.id || e.target === focal.id)).toHaveLength(0)
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

    it('R2: a level the walk saw THROUGH is never drawn — and the one it stopped at is', () => {
        const g = layout(sharedPlatform())
        // The platform holds the focus, so nothing about it is geometry.
        expect(urns(g)).not.toContain('SNOW')
        // GOLD is where a hop ENDS one level down, so GOLD is the answer's
        // own grain: a free-standing frame with the table as its row,
        // countable and searchable in place, carrying what it sits under.
        const gold = cardFor(g, 'GOLD')!
        expect(gold.kind).toBe('frame')
        expect(gold.frameId).toBeNull()
        expect(gold.band).toBe(-1)
        expect(gold.ancestry).toEqual(['Snowflake'])
        expect(cardFor(g, 'gold_t')!.frameId).toBe(gold.id)
        // Same downstream, outside the platform.
        expect(cardFor(g, 'dash')!.frameId).toBe(cardFor(g, 'BI')!.id)
        // A hop that ends on a container ABOVE the focus has no owner to
        // be a row of — nothing above the focus is drawn — so it stands
        // in its column as its own card.
        expect(cardFor(g, 'INT_T2')!.frameId).toBeNull()
        expect(cardFor(g, 'INT_T2')!.band).toBe(-1)
        expect(cardFor(g, 'INT_T2')!.ancestry).toEqual(['Snowflake'])
    })

    it('R2: the whole estate spine is breadcrumb, however many levels deep', () => {
        // Five levels of containment over one answer. Only the level the
        // hops END in is drawn; the four above it are text on it.
        const g = layout(collateralEstate())
        for (const skipped of ['DOM', 'APP', 'CTR1', 'CTR2']) {
            expect(urns(g)).not.toContain(skipped)
        }
        expect(g.cards.filter(c => c.kind === 'frame').map(c => c.nodeId)).toEqual(['DB'])
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
        // Four raw hops, four drawn wires — every one of them between the
        // two cards that actually carry it, and not one dropped by the
        // levels the picture skipped. (Three, converging on the focal,
        // before hops landed at column grain.)
        expect(drawn).toEqual(['INT_T2>rep_a', 'gold_t>rep_a', 'gold_t>rep_b', 'rep_a>dash'])
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
        // GOLD is the drawn grain, so it is top-level and its table is a
        // row of it — both true, and both resolvable in the export.
        expect(payload.nodes.find(n => n.urn === 'GOLD')?.parentUrn).toBeNull()
        expect(payload.nodes.find(n => n.urn === 'gold_t')?.parentUrn).toBe('GOLD')
        // ...while the focus's own contents keep the parent they are
        // drawn inside — the contains-stack is the focus's card.
        expect(payload.nodes.find(n => n.urn === 'rep_a')?.parentUrn).toBe('REPORTING')
    })

    it('a walked-through level keeps its own ⊕ — folded onto the card its group is presented as', () => {
        // `LANDING` ships no hop, so the walk sees through it — but the
        // data source says it has four more upstream. Off the board, that
        // ⊕ would simply be gone; it belongs to the card the group IS.
        const sg = subgraph({
            focus: 'F',
            nodes: [
                wnode('F'), wnode('LANDING', 'CONTAINER', 'LANDING'),
                wnode('T', 'dataset', 'raw_charges'), wnode('c0'), wnode('c1'),
            ],
            contains: [['LANDING', 'T'], ['T', 'c0'], ['T', 'c1']],
            hops: [['c0', 'F'], ['c1', 'F']],
            frontierUp: [{ urn: 'LANDING', totalCount: 4, nextCursor: null }],
        })
        const g = layout(sg)
        expect(cardFor(g, 'LANDING')).toBeUndefined()
        expect(cardFor(g, 'T')!.pillUp).toMatchObject({ kind: 'extend', count: 4 })
    })

    it('a hop that lands above the FOCUS is said out loud, not dropped', () => {
        // The platform holds the focus AND has a hop of its own. Nothing
        // above the focus is drawn, so that hop has no card to land on —
        // and the partner at the far end would otherwise sit there with no
        // wire and no reason.
        const sg = subgraph({
            focus: 'F',
            nodes: [
                wnode('SNOW', 'PLATFORM', 'Snowflake'),
                wnode('F', 'dataset', 'clean_charges'),
                wnode('up', 'dataset', 'raw_charges'),
            ],
            contains: [['SNOW', 'F']],
            hops: [['up', 'SNOW'], ['up', 'F']],
        })
        const g = layout(sg)
        expect(cardFor(g, 'SNOW')).toBeUndefined()
        // Counted, and said on the focal — never dropped in silence.
        expect(g.hopsAtCoarserGrain).toBe(1)
        // The partner keeps its card and the wire it CAN show; only the
        // coarser hop is missing from the picture, and the focal says so.
        expect(cardFor(g, 'up')).toBeDefined()
        expect(g.edges.some(e => e.source === cardFor(g, 'up')!.id)).toBe(true)
    })

    it('nothing is claimed to be at a coarser grain when every hop landed', () => {
        expect(layout(sharedPlatform()).hopsAtCoarserGrain).toBe(0)
    })

    it('the grain is sticky: a second child arriving never swallows the card already drawn', () => {
        // `T` is walked through while it holds one connected column. A
        // reveal brings a second column — and without stickiness T would
        // become the presented grain, turn into a frame, and take the
        // column card that was already on the board inside it.
        const sg = subgraph({
            focus: 'F',
            nodes: [
                wnode('F'), wnode('T', 'CONTAINER', 'estate'),
                wnode('tbl1', 'dataset', 'first_table'), wnode('c1'),
                wnode('tbl2', 'dataset', 'second_table'), wnode('c2'),
            ],
            contains: [['T', 'tbl1'], ['tbl1', 'c1'], ['T', 'tbl2'], ['tbl2', 'c2']],
            hops: [['c1', 'F'], ['c2', 'c1']],
        })
        // First render: only the first table is populated, so T is a
        // pass-through the picture walks past, and `first_table` is the
        // card on the board.
        const first = layout(sg)
        expect(cardFor(first, 'T')).toBeUndefined()
        expect(cardFor(first, 'tbl1')!.frameId).toBeNull()
        expect([...first.walkedThrough]).toContain('T')

        // The consumer folds that back in, and the user reveals the
        // second table. T now holds two — but it was already walked
        // through, so it stays walked through.
        const base = initialLensViewState(sg)
        const grown = layout(sg, {
            ...base,
            walkedThrough: first.walkedThrough,
            revealed: new Map([...base.revealed, ['in:c1', 1]]),
        })
        expect(cardFor(grown, 'tbl2')).toBeDefined()
        expect(cardFor(grown, 'T')).toBeUndefined()
        expect(cardFor(grown, 'tbl1')!.frameId).toBeNull()
        // Without the stickiness it would have become the presented grain
        // and swallowed the card already on the board.
        const forgetful = layout(sg, {
            ...base,
            revealed: new Map([...base.revealed, ['in:c1', 1]]),
        })
        expect(cardFor(forgetful, 'T')).toBeDefined()
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
        const closed = layout(sg, shut(initialLensViewState(sg), 'T'))
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

// ── T23 R3: triage-list placement ──────────────────────────────────────

describe('focus-layout — pinned (T23 R3, a triage-list placement)', () => {
    it('places a specific low-ranked entity on the board, bypassing rank order and the reveal budget', () => {
        // 20 weight-1 groups, ranked by label (all weights tied) — labels
        // run z80 (u19) .. z99 (u00), so u00 ranks dead LAST and is one of
        // the eight the default REVEAL_PAGE=12 page never reaches. Pin it.
        const weights = new Array(20).fill(1)
        const labels = weights.map((_, i) => `z${String(99 - i).padStart(2, '0')}`)
        const sg = fanIn(weights, labels)
        const base = initialLensViewState(sg)
        expect(cardFor(layout(sg, base), 'u00')).toBeUndefined()   // confirms it's outside the default page
        const g = layout(sg, { ...base, pinned: new Set(['u00']) })
        expect(cardFor(g, 'u00')).toBeDefined()
        // Nothing else the reveal page would not otherwise have shown —
        // pinning one entity does not admit the other seven still ranked
        // ahead of it that the default page's own budget already excludes.
        expect(urns(g).filter(u => u !== 'F')).toHaveLength(REVEAL_PAGE + 1)
    })

    it('a pinned entity is a full citizen — wired, and counted like any other card', () => {
        const weights = new Array(20).fill(1)
        const labels = weights.map((_, i) => `z${String(99 - i).padStart(2, '0')}`)
        const sg = fanIn(weights, labels)
        const base = initialLensViewState(sg)
        const g = layout(sg, { ...base, pinned: new Set(['u00']) })
        const card = cardFor(g, 'u00')!
        expect(card.wired).toBe(true)
        expect(g.edges.some(e => e.source === card.id || e.target === card.id)).toBe(true)
    })

    it('pinning an already-drawn entity is a no-op — one card, never a duplicate', () => {
        const weights = new Array(20).fill(1)
        const labels = weights.map((_, i) => `z${String(99 - i).padStart(2, '0')}`)
        const sg = fanIn(weights, labels)
        const base = initialLensViewState(sg)
        const already = urns(layout(sg, base)).filter(u => u !== 'F')[0]
        const g = layout(sg, { ...base, pinned: new Set([already]) })
        expect(g.cards.filter(c => c.nodeId === already)).toHaveLength(1)
        expect(urns(g).filter(u => u !== 'F')).toHaveLength(REVEAL_PAGE)
    })

    it('pinning an urn the walk never named is silently ignored, not a crash', () => {
        const sg = fanIn([1, 1])
        const base = initialLensViewState(sg)
        expect(() => layout(sg, { ...base, pinned: new Set(['ghost:not-in-model']) })).not.toThrow()
    })
})

// ── pills ────────────────────────────────────────────────────────────

describe('focus-layout — every ⊕ counts the same thing: connections', () => {
    /** Thirteen sources, three parallel hops each. Twelve fit one page; the
     *  thirteenth is left, and it is worth THREE connections, not one card. */
    const tiedFanIn = () => {
        const nodes = [wnode('F')]
        const hops: Array<[string, string, string]> = []
        for (let i = 0; i < 13; i++) {
            const urn = `s${String(i).padStart(2, '0')}`
            nodes.push(wnode(urn, 'dataset', `source_${String(i).padStart(2, '0')}`))
            // Three relationships between the same pair — one card, three hops.
            for (const t of ['DERIVES_FROM', 'JOINS', 'FEEDS']) hops.push([urn, 'F', t])
        }
        return subgraph({ focus: 'F', nodes, contains: [], hops })
    }

    it('a reveal counts the CONNECTIONS still to draw, not the cards', () => {
        const sg = tiedFanIn()
        const g = layout(sg)
        // Twelve of thirteen groups drawn; one left.
        expect(g.cards.filter(c => c.band === -1)).toHaveLength(12)
        const pill = cardFor(g, 'F')!.pillUp!
        expect(pill.kind).toBe('reveal')
        // The unit is connections — the same one the band headers, a card's
        // ×N and the focal's in/out all count in. Counting GROUPS here put
        // two meanings in one place on one card: an extend's "+246"
        // (connections) became a reveal's "+1" (a card) after a click.
        expect(pill.count).toBe(3)
        // Cards are still known — the wording needs them, the badge must
        // never be them.
        expect(pill.groups).toBe(1)
    })

    it('a group half-drawn by ANOTHER card is worth only what is left of it', () => {
        // `x` and `y` live in one container. `A` reaches both, `B` reaches
        // only `x` — twice. Revealing from B draws `x`, and A's pill must
        // then offer the ONE connection that reaches `y`, not the two its
        // group was ranked by.
        const sg = subgraph({
            focus: 'F',
            nodes: [
                wnode('F'), wnode('A', 'dataset', 'a'), wnode('B', 'dataset', 'b'),
                wnode('R', 'CONTAINER', 'shared'), wnode('x', 'dataset', 'x'), wnode('y', 'dataset', 'y'),
            ],
            contains: [['R', 'x'], ['R', 'y']],
            hops: [
                ['F', 'A'], ['F', 'B'],
                ['A', 'x'], ['A', 'y'],
                ['B', 'x', 'DERIVES_FROM'], ['B', 'x', 'JOINS'],
            ],
        })
        const base = initialLensViewState(sg)
        const before = layout(sg, base)
        expect(cardFor(before, 'A')!.pillDown).toMatchObject({ kind: 'reveal', count: 2, groups: 1 })
        expect(cardFor(before, 'B')!.pillDown).toMatchObject({ kind: 'reveal', count: 2, groups: 1 })

        const after = layout(sg, withReveal(base, revealKey('out', 'B'), 1))
        expect(urns(after)).toContain('x')
        expect(cardFor(after, 'A')!.pillDown).toMatchObject({ kind: 'reveal', count: 1, groups: 1 })
        // B has nothing left to offer at all.
        expect(cardFor(after, 'B')!.pillDown).toBeNull()
    })

    /**
     * THE WIRED-DESCENDANT SHAPE — the way the P1 could come back.
     *
     * An OPEN frame's rows are drawn as cards of their own, so they own
     * themselves. While the ⊕ asked from what a card visually STANDS FOR
     * and the click admitted from its whole SUBTREE, the frame's badge
     * could not see its rows' unrevealed neighbours — and one click spent
     * its page on them: cards the badge never counted, and, with more than
     * a page of them, INSTEAD of a just-fetched cohort.
     */
    const openFrameWithQueuedRows = () => {
        const nodes = [wnode('F'), wnode('T', 'dataset', 'wide_table', { childCount: 30 })]
        const contains: Array<[string, string]> = []
        const hops: Array<[string, string]> = []
        // Fourteen columns on this lineage, each with a source of its own
        // that no page has revealed yet — more than one page holds.
        for (let i = 0; i < 14; i++) {
            const col = `c${String(i).padStart(2, '0')}`
            const src = `s${String(i).padStart(2, '0')}`
            nodes.push(wnode(col, 'schemaField', `column_${String(i).padStart(2, '0')}`))
            nodes.push(wnode(src, 'dataset', `source_${String(i).padStart(2, '0')}`))
            contains.push(['T', col])
            hops.push([col, 'F'], [src, col])
        }
        const sg = subgraph({
            focus: 'F',
            nodes,
            contains,
            hops,
            // ...and the TABLE itself has a frontier the data source reported.
            frontierUp: [{ urn: 'T', totalCount: 300, nextCursor: null }],
        })
        const base = initialLensViewState(sg)
        return { sg, open: { ...base, expandedContainment: new Set([...base.expandedContainment, 'T']) } }
    }

    it('an open frame NEVER offers a fetch while its rows still hold something free', () => {
        const { sg, open } = openFrameWithQueuedRows()
        const g = layout(sg, open)
        // This is the invariant `extendWalk` leans on, stated as a fact
        // about the frame: it cannot be showing an extend here, so the
        // reveal page that click opens can never be spent on the fourteen
        // row-neighbours queued underneath instead of on what it fetched.
        expect(cardFor(g, 'T')!.pillUp).toBeNull()
        // The offer is where it can be acted on — one ⊕ per row, counting
        // that row's own connection, and no second copy in the frame's
        // gutter saying the same thing about all of them at once.
        expect(cardFor(g, 'c00')!.pillUp).toMatchObject({ kind: 'reveal', count: 1, groups: 1 })
        // One per row ON SCREEN. The six scrolled past keep theirs — a
        // window decides what is drawn, never what is offered.
        expect(g.cards.filter(c => c.pillUp?.kind === 'reveal')).toHaveLength(FRAME_WINDOW)
        expect(cardFor(g, 'c13')).toBeUndefined()
    })

    it('a card that DOES offer a reveal counts exactly what its click draws', () => {
        // Nothing is drawn inside a leaf row, so its badge and its click
        // are the same set by construction — and a click delivers it.
        const { sg, open } = openFrameWithQueuedRows()
        const before = layout(sg, open)
        expect(urns(before)).not.toContain('s00')
        const clicked = layout(sg, withReveal(open, revealKey('in', 'c00'), 1))
        expect(urns(clicked)).toContain('s00')
        // Delivered in full, so nothing is left to offer.
        expect(cardFor(clicked, 'c00')!.pillUp).toBeNull()
        // ...and its neighbours' offers are untouched.
        expect(cardFor(clicked, 'c01')!.pillUp).toMatchObject({ kind: 'reveal', count: 1 })
    })

    it('only once the free ones are drawn does the frame offer its own fetch', () => {
        const { sg, open } = openFrameWithQueuedRows()
        // Every row's reveal taken, exactly as fourteen clicks would.
        let view: LensViewState = open
        for (let i = 0; i < 14; i++) {
            view = withReveal(view, revealKey('in', `c${String(i).padStart(2, '0')}`), 1)
        }
        const drained = layout(sg, view)
        expect(urns(drained)).toContain('s13')
        // 300 the data source knows of, at TABLE grain; its columns'
        // fourteen are drawn but they are the columns' own degree, not the
        // table's, so the remainder it reports is its own.
        expect(cardFor(drained, 'T')!.pillUp).toMatchObject({ kind: 'extend', count: 300 })
    })

    it('extend and page count connections too, and claim no card count', () => {
        // The frontier sits on the FOCUS, whose neighbours are already
        // drawn — so there is nothing local left to reveal and the pill is
        // the fetch it honestly is. `totalCount` is the data source's own
        // adjacency count (a degree), so the remainder is what it has not
        // shipped: connections, in both states.
        const sg = subgraph({
            focus: 'F',
            nodes: [wnode('F'), wnode('U', 'dataset', 'u'), wnode('D', 'dataset', 'd')],
            contains: [],
            hops: [['U', 'F'], ['F', 'D']],
            frontierUp: [{ urn: 'F', totalCount: 247, nextCursor: null }],
            frontierDown: [{ urn: 'F', totalCount: 96, nextCursor: 'e:41' }],
        })
        const focal = cardFor(layout(sg), 'F')!
        expect(focal.pillUp).toMatchObject({ kind: 'extend', count: 246 })
        expect(focal.pillUp!.groups).toBeUndefined()
        expect(focal.pillDown).toMatchObject({ kind: 'page', count: 95, cursor: 'e:41' })
        expect(focal.pillDown!.groups).toBeUndefined()
    })
})

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
        // The two levels above the answer are walked through; the one the
        // hop ENDS in is the frame holding it.
        for (const level of ['L0', 'L1']) expect(cardFor(g, level)).toBeUndefined()
        expect(cardFor(g, 'leaf')!.frameId).toBe(cardFor(g, 'L2')!.id)
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
        // Shut, T stands for the columns hidden inside it — and its pill
        // has to carry what they cannot say for themselves.
        const closed = layout(sg, shut(initialLensViewState(sg), 'T'))
        expect(cardFor(closed, 'T')!.pillUp).toMatchObject({ kind: 'extend', count: 4 })
        // Open — which is how it arrives — the column speaks for itself
        // and T falls silent.
        const open = layout(sg)
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
        const idle = layout(sg, shut(initialLensViewState(sg), 'T'))
        const pill = cardFor(idle, 'T')!.pillUp!
        expect(pill.kind).toBe('extend')
        expect(pill.key).toBe('in:T')
        expect(pill.status).toBeUndefined()

        // Replay the consumer convention: split the key, hand the urn to
        // the hook, and the hook reports progress under the same urn.
        const [dir, target] = [pill.key.slice(0, pill.key.indexOf(':')), pill.key.slice(pill.key.indexOf(':') + 1)]
        expect(target).toBe('T')
        const inflight = layout(sg, shut(initialLensViewState(sg), 'T'), {
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
        const pill = cardFor(layout(sg, shut(initialLensViewState(sg), 'T')), 'T')!.pillUp!
        expect(pill).toMatchObject({ kind: 'page', key: 'in:c0', cursor: 'cur-1' })
        const inflight = layout(sg, shut(initialLensViewState(sg), 'T'), {
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
        // Shut, T is one card — and its pill has to speak for both
        // columns beneath it: neither has any upstream in the model yet,
        // so the whole 4 + 3 is left.
        const g = layout(sg, shut(initialLensViewState(sg), 'T'))
        expect(cardFor(g, 'T')!.kind).toBe('entity')
        expect(cardFor(g, 'T')!.pillUp).toMatchObject({ kind: 'extend', count: 7, key: 'in:T' })
    })
})

// ── cycles ───────────────────────────────────────────────────────────

describe('focus-layout — cycle badge', () => {
    /** Every drawn wire, by the pair of CARDS it runs between. */
    const wires = (g: { cards: FocusCard[]; edges: FocusEdge[] }) => {
        const id = (u: string) => cardFor(g, u)!.id
        const byPair = new Map(g.edges.map(e => [`${e.source} ${e.target}`, e]))
        return (s: string, t: string) => byPair.get(`${id(s)} ${id(t)}`)
    }

    it('badges a REAL loop — both wires of a mutual pair are on it', () => {
        const sg = subgraph({
            focus: 'F',
            nodes: [wnode('F'), wnode('A'), wnode('B')],
            contains: [],
            hops: [['F', 'A'], ['A', 'B'], ['B', 'A']],
        })
        // B only exists once the walk steps out of A — one hop at a time.
        const g = layout(sg, withReveal(initialLensViewState(sg), 'out:A', 1))
        const wire = wires(g)
        // `B → A` runs backwards in the picture's own hop numbering, and
        // `A → B` closes the loop over the drawn cards. Both are the
        // lineage looping; a glyph on only one of them read as a
        // duplicate wire beside a lone marked one.
        expect(wire('B', 'A')!.cycleBack).toBe(true)
        expect(wire('A', 'B')!.cycleBack).toBe(true)
        // The way in is not part of the loop.
        expect(wire('F', 'A')!.cycleBack).toBe(false)
    })

    it('badges a LONGER directed loop — A → B → C → A, every hop of it', () => {
        const sg = subgraph({
            focus: 'F',
            nodes: [wnode('F'), wnode('A'), wnode('B'), wnode('C')],
            contains: [],
            hops: [['F', 'A'], ['A', 'B'], ['B', 'C'], ['C', 'A']],
        })
        const g = layout(sg, withReveal(
            withReveal(initialLensViewState(sg), 'out:A', 1), 'out:B', 1))
        const wire = wires(g)
        expect(wire('A', 'B')!.cycleBack).toBe(true)
        expect(wire('B', 'C')!.cycleBack).toBe(true)
        expect(wire('C', 'A')!.cycleBack).toBe(true)
        expect(wire('F', 'A')!.cycleBack).toBe(false)
    })

    it('does NOT badge a sibling flow at the same hop — the reported false glyph', () => {
        // Two consumers of the focus, and one of them also feeds the
        // other. Both sit at hop 1, so the old `≤` rule read the peer
        // flow as running backwards and stamped a loop on lineage that
        // goes strictly one way.
        const sg = subgraph({
            focus: 'F',
            nodes: [wnode('F'), wnode('A'), wnode('B')],
            contains: [],
            hops: [['F', 'A'], ['F', 'B'], ['A', 'B']],
        })
        const g = layout(sg)
        expect(wires(g)('A', 'B')!.cycleBack).toBe(false)
        expect(g.edges.some(e => e.cycleBack)).toBe(false)
    })

    it('nominates ONE badge per loop that density may not take away', () => {
        // Every wire of a loop is marked — which of them "closes" it is
        // an artefact of the walk order — and on a cyclic estate that is
        // a glyph on every wire on the board, which is the confetti the
        // density cap exists to stop. So each loop nominates a single
        // wire whose badge always draws. TWO separate loops here, because
        // "one per board" and "one per loop" are only distinguishable
        // when there is more than one.
        const sg = subgraph({
            focus: 'F',
            nodes: [wnode('F'), wnode('A'), wnode('B'), wnode('X'), wnode('Y')],
            contains: [],
            hops: [['F', 'A'], ['A', 'B'], ['B', 'A'], ['F', 'X'], ['X', 'Y'], ['Y', 'X']],
        })
        const g = layout(sg, withReveal(
            withReveal(initialLensViewState(sg), 'out:A', 1), 'out:X', 1))
        const wire = wires(g)
        // Every wire of both loops is marked...
        for (const [s, t] of [['A', 'B'], ['B', 'A'], ['X', 'Y'], ['Y', 'X']]) {
            expect(wire(s, t)!.cycleBack).toBe(true)
        }
        // ...and exactly one of EACH is the one density cannot silence,
        // picked by the lowest edge id so it is the same wire on every
        // render rather than whichever the walk reached first.
        expect(g.edges.filter(e => e.cycleAnchor)).toHaveLength(2)
        expect(wire('A', 'B')!.cycleAnchor).toBe(true)
        expect(wire('B', 'A')!.cycleAnchor).toBe(false)
        expect(wire('X', 'Y')!.cycleAnchor).toBe(true)
        expect(wire('Y', 'X')!.cycleAnchor).toBe(false)
        // The ways IN are not part of either loop, badge or nomination.
        expect(wire('F', 'A')!.cycleBack).toBe(false)
        expect(wire('F', 'A')!.cycleAnchor).toBe(false)
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

    it('a partner a PAGE delivered is offered, never stamped as the end', () => {
        // The shape after draining one page of a wide hub: four partners
        // arrived on a cursor page, three with lineage of their own and one
        // with none. The server files each of them in the frontier, so the
        // three carry a ⊕ and only the genuinely drained one is stamped.
        //
        // The provider used to file paged partners under no direction at
        // all. They arrived with no frontier entry, and a partner with no
        // entry is exactly what this view calls the end of the walk — so a
        // drained page put "the walk ends here" on four live nodes.
        const sg = subgraph({
            focus: 'F',
            nodes: [wnode('F'), wnode('q0'), wnode('q1'), wnode('q2'), wnode('q3')],
            contains: [],
            hops: [['F', 'q0'], ['F', 'q1'], ['F', 'q2'], ['F', 'q3']],
            frontierDown: [
                { urn: 'F', totalCount: 7, nextCursor: 'e:4' },
                ...['q0', 'q1', 'q2'].map(urn => ({ urn, totalCount: 1, nextCursor: null })),
            ],
        })
        const g = layout(sg)
        for (const urn of ['q0', 'q1', 'q2']) {
            expect(cardFor(g, urn)!.pillDown).toMatchObject({ kind: 'extend', count: 1 })
            expect(cardFor(g, urn)!.deadEnd).toBe(false)
        }
        // q3 got the same probe and has nothing behind it: no pill, and the
        // stamp it deserves. Honest emptiness is the point — not silence.
        expect(cardFor(g, 'q3')!.pillDown).toBeNull()
        expect(cardFor(g, 'q3')!.deadEnd).toBe(true)
        // And the anchor keeps the page's own resume.
        expect(cardFor(g, 'F')!.pillDown).toMatchObject({ kind: 'page', cursor: 'e:4' })
    })
})

describe('focus-layout — frames scroll instead of growing', () => {
    /** A wide table: `n` connected columns inside one frame. */
    const wideTable = (n: number, childCount = 40) => {
        const nodes = [wnode('F'), wnode('T', 'dataset', 'wide_table', { childCount })]
        const contains: Array<[string, string]> = []
        const hops: Array<[string, string]> = []
        for (let i = 0; i < n; i++) {
            const c = `w${String(i).padStart(2, '0')}`
            nodes.push(wnode(c, 'schemaField', `column_${String(i).padStart(2, '0')}`))
            contains.push(['T', c])
            hops.push([c, 'F'])
        }
        const sg = subgraph({ focus: 'F', nodes, contains, hops })
        const base = initialLensViewState(sg)
        return { sg, open: { ...base, expandedContainment: new Set([...base.expandedContainment, 'T']) } }
    }

    it('shows one fixed window of children and reports the rest', () => {
        const { sg, open } = wideTable(20)
        const g = layout(sg, open)
        const frame = cardFor(g, 'T')!
        const rows = g.cards.filter(c => c.frameId === frame.id)
        expect(rows).toHaveLength(FRAME_WINDOW)
        expect(frame.frameLoaded).toBe(20)
        expect(rows.map(r => r.nodeId)).toEqual(['w00', 'w01', 'w02', 'w03', 'w04', 'w05', 'w06', 'w07'])
        // Scrolling is the SAME window moved, not a taller frame — and it
        // moves by ROWS, so a scroll of three starts three rows down.
        const scrolled = layout(sg, { ...open, frameOffsets: new Map([['T', 3]]) })
        const movedRows = scrolled.cards.filter(c => c.frameId === cardFor(scrolled, 'T')!.id)
        expect(movedRows).toHaveLength(FRAME_WINDOW)
        expect(movedRows[0].nodeId).toBe('w03')
        expect(cardFor(scrolled, 'T')!.h).toBe(frame.h)
    })

    it('the window never travels past the rows in hand', () => {
        const { sg, open } = wideTable(20)
        // A restored share link (or a roster that shrank under a new
        // search) can name an offset that no longer exists. It lands on
        // the LAST windowful of rows rather than on empty space.
        const g = layout(sg, { ...open, frameOffsets: new Map([['T', 900]]) })
        const frame = cardFor(g, 'T')!
        const rows = g.cards.filter(c => c.frameId === frame.id)
        expect(frame.frameOffset).toBe(20 - FRAME_WINDOW)
        expect(rows.map(r => r.nodeId)).toEqual(['w12', 'w13', 'w14', 'w15', 'w16', 'w17', 'w18', 'w19'])
        const w = frameWindow(frame)
        expect([w.from, w.to, w.total]).toEqual([13, 20, 20])
        expect(w.atEnd).toBe(true)
    })

    it('a frame that fits needs no scroll, and says nothing about one', () => {
        const { sg, open } = wideTable(3, 3)
        const w = frameWindow(cardFor(layout(sg, open), 'T')!)
        expect(w.scrollable).toBe(false)
        expect([w.from, w.to, w.total, w.maxOffset]).toEqual([1, 3, 3, 0])
    })

    it('carries every row it holds, not only the windowed ones', () => {
        // The keyboard cursor and the type-ahead reach rows the window has
        // scrolled past — neither can ask the board for a card that is not
        // drawn, so the frame states its whole row list.
        const { sg, open } = wideTable(20)
        const frame = cardFor(layout(sg, open), 'T')!
        expect(frame.frameRows).toHaveLength(20)
        expect(frame.frameRows[19]).toEqual({ urn: 'w19', label: 'column_19', canOpen: false })
        // A row is not a frame, and carries no row list of its own.
        expect(cardFor(layout(sg, open), 'w00')!.frameRows).toHaveLength(0)
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
        // Two of its three columns ARE on this lineage.
        expect(cardFor(g, 'T')!.frameEmpty).toBe(false)
    })

    describe('the divider between "on this lineage" and "everything else"', () => {
        /** `n` connected columns then `m` roster-only ones, All mode. */
        const mixedRoster = (n: number, m: number, offset?: number) => {
            const nodes = [wnode('F'), wnode('T', 'dataset', 'src', { childCount: n + m })]
            const contains: Array<[string, string]> = []
            const hops: Array<[string, string]> = []
            const roster: LensWalkNode[] = []
            for (let i = 0; i < n; i++) {
                const c = `c${i}`
                nodes.push(wnode(c, 'schemaField', `on_lineage_${i}`))
                contains.push(['T', c])
                hops.push([c, 'F'])
                roster.push(wnode(c, 'schemaField', `on_lineage_${i}`))
            }
            for (let i = 0; i < m; i++) roster.push(wnode(`x${i}`, 'schemaField', `other_${i}`))
            const sg = subgraph({ focus: 'F', nodes, contains, hops })
            const base = initialLensViewState(sg)
            return layout(sg, {
                ...base,
                expandedContainment: new Set([...base.expandedContainment, 'T']),
                frameShowAll: new Set(['T']),
                ...(offset === undefined ? {} : { frameOffsets: new Map([['T', offset]]) }),
            }, {
                childrenAll: new Map([['T', { children: roster, hasMore: false, total: n + m }]]),
                childrenAllStatus: new Map([['T', 'done']]),
            })
        }

        it('sits between the two kinds of row, and counts what is below it', () => {
            const g = mixedRoster(2, 3)
            const frame = cardFor(g, 'T')!
            const rows = g.cards.filter(c => c.frameId === frame.id)
            expect(rows.map(r => r.nodeId ?? r.kind)).toEqual(['c0', 'c1', 'divider', 'x0', 'x1', 'x2'])
            const divider = rows.find(r => r.kind === 'divider')!
            expect(divider.label).toBe('everything else inside')
            expect(divider.count).toBe(3)
        })

        it('is not drawn once the window has scrolled past it', () => {
            // A divider is a claim about what is ON SCREEN. Left at the top
            // of a window showing only roster rows, it would announce a
            // boundary the reader cannot see.
            const g = mixedRoster(2, 14, 6)
            const rows = g.cards.filter(c => c.frameId === cardFor(g, 'T')!.id)
            expect(rows.some(r => r.kind === 'divider')).toBe(false)
            expect(rows[0].nodeId).toBe('x4')
        })

        it('with nothing connected, there is nothing to divide OR confirm', () => {
            // No connected rows at all — neither the "everything else"
            // boundary nor T24 F6's "already on this lineage"
            // confirmation has anything to say about.
            expect(mixedRoster(0, 3).cards.some(c => c.kind === 'divider')).toBe(false)
        })

        it('T24 F6 — connected rows with NOTHING beyond them get the "already on this lineage" divider instead of none at all', () => {
            // Reported: flipping to "everything inside" and finding
            // nothing new looked identical to the toggle having
            // silently failed. `mixedRoster(2, 0)` is exactly that
            // shape (2 connected, 0 roster-only) — it used to draw NO
            // divider at all, the same as a frame nobody had ever
            // flipped to All.
            const g = mixedRoster(2, 0)
            const frame = cardFor(g, 'T')!
            const rows = g.cards.filter(c => c.frameId === frame.id)
            const divider = rows.find(r => r.kind === 'divider')!
            expect(divider).toBeTruthy()
            expect(divider.label).toBe('everything inside is already on this lineage')
            // A count of 0 here would read as "0 items exist", not "0
            // MORE items beyond what is already shown" — see the
            // renderer's own guard against appending it.
            expect(divider.count).toBe(0)
        })

        it('T24 F6 review round 1 — the "already on this lineage" divider stays silent while a Find is active', () => {
            // The exact shape `rosterExtras.length === 0` mistook for "the
            // whole roster is exhausted": a query active, every CONNECTED
            // row still matching it (so the list is non-empty), and
            // `rosterExtras` forced to [] purely because a search is
            // running (F2) — not because there is genuinely nothing left
            // inside. Claiming "everything inside is already on this
            // lineage" here would be false: the search is HIDING the rest
            // of the roster, not reporting that it does not exist.
            const nodes = [wnode('F'), wnode('T', 'dataset', 'src', { childCount: 2 })]
            const contains: Array<[string, string]> = [['T', 'c0'], ['T', 'c1']]
            const hops: Array<[string, string]> = [['c0', 'F'], ['c1', 'F']]
            nodes.push(wnode('c0', 'schemaField', 'on_lineage_0'), wnode('c1', 'schemaField', 'on_lineage_1'))
            const roster: LensWalkNode[] = [
                wnode('c0', 'schemaField', 'on_lineage_0'),
                wnode('c1', 'schemaField', 'on_lineage_1'),
            ]
            const sg = subgraph({ focus: 'F', nodes, contains, hops })
            const base = initialLensViewState(sg)
            const g = layout(sg, {
                ...base,
                expandedContainment: new Set([...base.expandedContainment, 'T']),
                frameShowAll: new Set(['T']),
                frameQueries: new Map([['T', 'on_lineage']]),
            }, {
                childrenAll: new Map([['T', { children: roster, hasMore: false, total: 2 }]]),
                childrenAllStatus: new Map([['T', 'done']]),
            })
            const frame = cardFor(g, 'T')!
            const rows = g.cards.filter(c => c.frameId === frame.id)
            expect(rows.some(r => r.kind === 'divider')).toBe(false)
        })
    })

    describe('row cues — every one of them a fact the model already holds', () => {
        const cueShape = () => {
            const sg = subgraph({
                focus: 'F',
                nodes: [
                    wnode('F'), wnode('T', 'dataset', 'src'),
                    wnode('c0', 'schemaField', 'amount', { description: 'Gross charge amount' }),
                    wnode('v0', 'view', 'amount_v'),
                ],
                contains: [['T', 'c0'], ['T', 'v0']],
                hops: [['c0', 'F'], ['c0', 'F', 'JOINS'], ['v0', 'F'], ['F', 'c0']],
            })
            const base = initialLensViewState(sg)
            return { sg, base }
        }

        it('states connection weight per side, straight off the walk model', () => {
            const { sg, base } = cueShape()
            const g = layout(sg, { ...base, expandedContainment: new Set([...base.expandedContainment, 'T']) })
            // Two hops out of `c0` into the focus, one back into it — the
            // same hops the wires are drawn from, counted the same way.
            expect(cardFor(g, 'c0')!.flowsOut).toBe(2)
            expect(cardFor(g, 'c0')!.flowsIn).toBe(1)
            expect(cardFor(g, 'v0')!.flowsOut).toBe(1)
            expect(cardFor(g, 'v0')!.flowsIn).toBe(0)
        })

        it('a row states its TYPE only where its frame holds more than one kind', () => {
            const { sg, base } = cueShape()
            const mixed = layout(sg, { ...base, expandedContainment: new Set([...base.expandedContainment, 'T']) })
            expect(cardFor(mixed, 'c0')!.showType).toBe(true)
            expect(cardFor(mixed, 'v0')!.showType).toBe(true)

            // The same frame holding one kind says it once, on the frame.
            const plain = subgraph({
                focus: 'F',
                nodes: [
                    wnode('F'), wnode('T', 'dataset', 'src'),
                    wnode('c0', 'schemaField', 'amount'), wnode('c1', 'schemaField', 'currency'),
                ],
                contains: [['T', 'c0'], ['T', 'c1']],
                hops: [['c0', 'F'], ['c1', 'F']],
            })
            const pb = initialLensViewState(plain)
            const g = layout(plain, { ...pb, expandedContainment: new Set([...pb.expandedContainment, 'T']) })
            expect(cardFor(g, 'c0')!.showType).toBe(false)
        })

        it('an UNRESOLVED type is not a second kind — it is the absence of one', () => {
            // One roster row the walk could not type turned a frame of
            // eight identical columns into eight chips saying "these
            // differ", about rows that do not.
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
                    // No `type` on the payload at all — the walk never
                    // resolved this one.
                    children: [{ id: 'x0', data: { label: 'mystery_col' } } as unknown as LensWalkNode],
                    hasMore: false,
                    total: 3,
                }]]),
                childrenAllStatus: new Map([['T', 'done']]),
            })
            expect(cardFor(g, 'x0')!.type).toBe('not loaded')
            expect(cardFor(g, 'c0')!.showType).toBe(false)
            expect(cardFor(g, 'x0')!.showType).toBe(false)
        })

        it('a row already carded elsewhere is not counted as one of this frame\'s', () => {
            // A row this list counts but never draws is a scroll window
            // that skips, a count that overstates, and an `aria-owns`
            // naming an element that does not exist.
            const sg = subgraph({
                focus: 'F',
                nodes: [
                    wnode('F'), wnode('A', 'dataset', 'a'), wnode('B', 'dataset', 'b'),
                    wnode('x', 'dataset', 'shared_child'),
                ],
                // `x` lives in A, and both A and B reach the focus.
                contains: [['A', 'x']],
                hops: [['x', 'F'], ['A', 'F'], ['B', 'F'], ['B', 'x']],
            })
            const g = layout(sg)
            const frames = g.cards.filter(c => c.kind === 'frame' && c.nodeId !== null)
            // Whichever frame drew it, exactly one card exists for `x`...
            expect(g.cards.filter(c => c.nodeId === 'x')).toHaveLength(1)
            // ...and no frame's row list names a row it did not draw.
            for (const f of frames) {
                const drawn = g.cards.filter(c => c.frameId === f.id && c.kind !== 'divider').map(c => c.nodeId)
                for (const r of f.frameRows) expect(drawn).toContain(r.urn)
                expect(f.frameLoaded).toBe(f.frameRows.length)
            }
        })

        it('a roster-only row carries its description and no lineage at all', () => {
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
                    children: [
                        wnode('c0', 'schemaField', 'amount'),
                        wnode('x0', 'schemaField', 'legacy_col', { description: 'Retired 2024' }),
                    ],
                    hasMore: false,
                    total: 2,
                }]]),
                childrenAllStatus: new Map([['T', 'done']]),
            })
            const extra = cardFor(g, 'x0')!
            expect(extra.connected).toBe(false)
            expect(extra.description).toBe('Retired 2024')
            expect([extra.flowsIn, extra.flowsOut]).toEqual([0, 0])
        })
    })

    it('a frame\'s Find FILTERS to matches, not merely dims what the window already shows (T24 F2)', () => {
        // Reported: the box searched only the UNCONNECTED extras — i.e.
        // everything except the rows a reader opened the frame for — and
        // even there only DIMMED whatever the fixed-size window already
        // had on screen, so a match sitting past row 20 of a 96-row
        // table never appeared: the window never moved to it. Typing a
        // column name did nothing to the columns.
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
            frameQueries: new Map([['T', 'curr']]),
        })
        // Filtered OUT, not merely dimmed — a non-match is not drawn at
        // all, so the window (and the row list a screen reader owns) can
        // never land on an entity the reader is not looking for.
        expect(cardFor(g, 'c0')).toBeUndefined()
        expect(cardFor(g, 'c1')!.dimmed).toBe(false)
        // The frame itself is not its own row: it stays lit.
        expect(cardFor(g, 'T')!.dimmed).toBe(false)
    })

    it('says so when nothing inside is on the lineage, instead of a roster that reads like an answer', () => {
        // The focus connects at TABLE grain: its columns are in the
        // container, and not one of them is on this lineage. Opening
        // "everything inside" then fills it with rows that connect to
        // nothing — which reads as an answer unless the node says plainly
        // that it isn't one.
        const sg = subgraph({
            focus: 'F',
            nodes: [wnode('F', 'dataset', 'orders'), wnode('U', 'dataset', 'raw_orders')],
            contains: [],
            hops: [['U', 'F']],
        })
        const base = initialLensViewState(sg)
        const g = layout(sg, { ...base, frameShowAll: new Set(['F']) }, {
            childrenAll: new Map([['F', {
                children: [wnode('k0', 'schemaField', 'id'), wnode('k1', 'schemaField', 'total')],
                hasMore: false,
                total: 2,
            }]]),
            childrenAllStatus: new Map([['F', 'done']]),
        })
        const focus = cardFor(g, 'F')!
        expect(focus.frameEmpty).toBe(true)
        expect(focus.frameConnectedCount).toBe(0)
        expect(focus.frameLoaded).toBe(2)
        // The claim is about the MODEL, so a partner that DOES hold
        // lineage children never makes it.
        expect(cardFor(g, 'U')!.frameEmpty).toBe(false)
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

// ── isolation cone ───────────────────────────────────────────────────

describe('focus-layout — isolationCone (what one element\'s lineage covers)', () => {
    const edge = (id: string, source: string, target: string): FocusEdge =>
        ({
            id, source, target, count: 1, edgeTypeNorm: '', dimmed: false, cycleBack: false, cycleAnchor: false, labelVisible: false,
            grainCoarse: false, sameAncestorFrame: null, inFrameLane: null, labelT: 0.5, seamSlotted: false,
        })
    const card = (id: string, frameId: string | null = null): FocusCard =>
        ({ ...({} as FocusCard), id, nodeId: id, frameId, kind: 'entity' })
    const board = (cards: FocusCard[], edges: FocusEdge[]) => ({ cards, edges })

    it('walks BOTH ways from the anchor, and keeps going where it flows', () => {
        //  U ─▶ A ─▶ D ─▶ M
        const cards = ['U', 'A', 'D', 'M'].map(id => card(id))
        const edges = [edge('e1', 'U', 'A'), edge('e2', 'A', 'D'), edge('e3', 'D', 'M')]
        const cone = isolationCone(board(cards, edges), 'A')!
        expect(cone.cardIds).toEqual(new Set(['U', 'A', 'D', 'M']))
        expect(cone.edgeIds).toEqual(new Set(['e1', 'e2', 'e3']))
        // Hierarchy: what the anchor touches directly reads heavier than
        // what it reaches through something else.
        expect(cone.hops.get('A')).toBe(0)
        expect(cone.hops.get('U')).toBe(1)
        expect(cone.hops.get('D')).toBe(1)
        expect(cone.hops.get('M')).toBe(2)
    })

    it('a SIBLING feeding the same target is NOT on the cone', () => {
        // THE rule that makes isolation mean anything. A lens board is one
        // entity's lineage and is connected by construction, so an
        // undirected walk would light B — and with it the whole board.
        const cards = ['A', 'B', 'T'].map(id => card(id))
        const edges = [edge('e1', 'A', 'T'), edge('e2', 'B', 'T')]
        const cone = isolationCone(board(cards, edges), 'A')!
        expect(cone.cardIds).toEqual(new Set(['A', 'T']))
        expect(cone.edgeIds).toEqual(new Set(['e1']))
        expect(cone.cardIds.has('B')).toBe(false)
    })

    it('a diamond lights BOTH branches, and every wire of them', () => {
        const cards = ['A', 'L', 'R', 'D'].map(id => card(id))
        const edges = [
            edge('e1', 'A', 'L'), edge('e2', 'A', 'R'),
            edge('e3', 'L', 'D'), edge('e4', 'R', 'D'),
        ]
        const cone = isolationCone(board(cards, edges), 'A')!
        expect(cone.cardIds).toEqual(new Set(['A', 'L', 'R', 'D']))
        expect(cone.edgeIds).toEqual(new Set(['e1', 'e2', 'e3', 'e4']))
    })

    it('a FRAME speaks for its rows: its cone is their cones plus its own', () => {
        // `FR` holds two rows; one feeds X, the other is fed by Y, and the
        // frame itself carries a rolled-up bundle to Z.
        const cards = [
            card('FR'), card('r1', 'FR'), card('r2', 'FR'),
            card('X'), card('Y'), card('Z'),
        ]
        const edges = [
            edge('e1', 'r1', 'X'), edge('e2', 'Y', 'r2'), edge('e3', 'FR', 'Z'),
        ]
        const cone = isolationCone(board(cards, edges), 'FR')!
        expect(cone.cardIds).toEqual(new Set(['FR', 'r1', 'r2', 'X', 'Y', 'Z']))
        expect(cone.edgeIds).toEqual(new Set(['e1', 'e2', 'e3']))
        // Everything the frame holds sits at the anchor's own distance.
        expect(cone.hops.get('r1')).toBe(0)
        expect(cone.hops.get('r2')).toBe(0)
    })

    it('nests: a row of a nested frame is still spoken for by the outer one', () => {
        const cards = [card('OUT'), card('IN', 'OUT'), card('leaf', 'IN'), card('X')]
        const edges = [edge('e1', 'leaf', 'X')]
        const cone = isolationCone(board(cards, edges), 'OUT')!
        expect(cone.cardIds.has('leaf')).toBe(true)
        expect(cone.cardIds.has('X')).toBe(true)
    })

    it('lights the BOX a lit row sits in — never a lit row inside a dimmed frame', () => {
        const cards = [card('A'), card('FR'), card('r1', 'FR')]
        const edges = [edge('e1', 'A', 'r1')]
        const cone = isolationCone(board(cards, edges), 'A')!
        expect(cone.cardIds.has('r1')).toBe(true)
        expect(cone.cardIds.has('FR')).toBe(true)
        // Lit, but not ON the cone: no wire of the frame's own is.
        expect(cone.hops.has('FR')).toBe(false)
    })

    it('traverses a ROLLED-UP bundle exactly like any other drawn wire', () => {
        // Two off-window rows reaching one card are ONE drawn bundle
        // between the frames — the cone follows what is drawn.
        const cards = [card('FR1'), card('FR2'), card('T')]
        const edges = [edge('e1', 'FR1', 'FR2'), edge('e2', 'FR2', 'T')]
        const cone = isolationCone(board(cards, edges), 'FR1')!
        expect(cone.cardIds).toEqual(new Set(['FR1', 'FR2', 'T']))
    })

    it('measures each direction on its OWN route — a card the anchor feeds is not a step towards its producers', () => {
        //   A ─▶ N ─▶ Z ─▶ A        and        W ─▶ N
        //
        // `N` is one hop DOWNSTREAM of A. It is also on the way up to A —
        // three hops up, through Z — and `W` hangs off it there and
        // nowhere else. Reading the downstream walk's "1" for N while
        // walking upstream numbered W as 2: a distance along a route that
        // runs downstream and then turns around, which is the mixed path
        // two directed walks exist to exclude.
        const cards = ['A', 'N', 'Z', 'W'].map(id => card(id))
        const edges = [
            edge('e1', 'A', 'N'), edge('e2', 'N', 'Z'), edge('e3', 'Z', 'A'),
            edge('e4', 'W', 'N'),
        ]
        const cone = isolationCone(board(cards, edges), 'A')!
        // Each of these is on both sides, and keeps the shorter REAL one.
        expect(cone.hops.get('N')).toBe(1)
        expect(cone.hops.get('Z')).toBe(1)
        // W is reached only by walking up: W → N → Z → A.
        expect(cone.hops.get('W')).toBe(3)
    })

    it('is cycle-safe: a loop terminates, and the whole loop is on the cone', () => {
        const cards = ['A', 'B', 'C'].map(id => card(id))
        const edges = [edge('e1', 'A', 'B'), edge('e2', 'B', 'C'), edge('e3', 'C', 'A')]
        const cone = isolationCone(board(cards, edges), 'A')!
        expect(cone.cardIds).toEqual(new Set(['A', 'B', 'C']))
        expect(cone.edgeIds).toEqual(new Set(['e1', 'e2', 'e3']))
    })

    it('an element with no drawn wire isolates NOTHING, rather than dimming everything', () => {
        const cards = [card('A'), card('B'), card('X')]
        const edges = [edge('e1', 'A', 'B')]
        expect(isolationCone(board(cards, edges), 'X')).toBeNull()
        expect(isolationCone(board(cards, edges), 'nope')).toBeNull()
    })

    it('runs THROUGH the focus\'s own rows: column to column, across the board', () => {
        // The shape the finest-grain wiring exists for: a partner's
        // column feeds a column INSIDE the focus, which feeds a consumer.
        // Isolating the partner's column has to follow that chain through
        // the focus's rows — the rows are the endpoints, and the cone is
        // computed over the wires the board draws between them.
        const sg = subgraph({
            focus: 'F',
            nodes: [
                wnode('SRC', 'dataset', 'raw_orders', { childCount: 4 }),
                wnode('sc', 'schemaField', 'order_id'),
                wnode('F', 'dataset', 'stg_orders', { childCount: 3 }),
                wnode('fc', 'schemaField', 'order_id'),
                wnode('OUT', 'dataset', 'fct_orders', { childCount: 5 }),
                wnode('oc', 'schemaField', 'order_id'),
                wnode('OTHER', 'dataset', 'refunds', { childCount: 2 }),
                wnode('rc', 'schemaField', 'refund_id'),
            ],
            contains: [['SRC', 'sc'], ['F', 'fc'], ['OUT', 'oc'], ['OTHER', 'rc']],
            hops: [['sc', 'fc'], ['fc', 'oc'], ['rc', 'oc']],
        })
        // The other producer only lands once the consumer's own page is
        // revealed — which is exactly when it becomes worth NOT lighting.
        const g = layout(sg, withReveal(initialLensViewState(sg), 'in:OUT', 1))
        const id = (u: string) => cardFor(g, u)!.id
        const cone = isolationCone(g, id('sc'))!
        // Through the focus's own row and out the other side.
        expect(cone.cardIds.has(id('fc'))).toBe(true)
        expect(cone.cardIds.has(id('oc'))).toBe(true)
        // ...and the focus itself is lit, because it holds a lit row.
        expect(cone.cardIds.has(id('F'))).toBe(true)
        // The OTHER producer of the same consumer is not on this lineage.
        expect(cone.cardIds.has(id('rc'))).toBe(false)
    })

    it('the WIRE decision, exactly: which drawn edges the treatment is painted from', () => {
        // The cone's paint on a wire — its weight, its drift, and the
        // saturation the rest of the board gives up — is screenshot-only:
        // React Flow draws no edges at all until its nodes have been
        // measured, and jsdom measures nothing. So the DECISION those are
        // painted from is pinned here, on a real built board: a producer,
        // the focus it feeds, the consumer beyond it, and a second
        // producer of the same focus that must stay dark.
        const sg = subgraph({
            focus: 'b',
            nodes: [wnode('a'), wnode('b'), wnode('c'), wnode('d')],
            contains: [],
            hops: [['a', 'b'], ['b', 'c'], ['d', 'b']],
        })
        const g = layout(sg)
        const id = (u: string) => cardFor(g, u)!.id
        const wire = (s: string, t: string) =>
            g.edges.find(e => e.source === id(s) && e.target === id(t))!.id
        const cone = isolationCone(g, id('a'))!
        expect([...cone.edgeIds].sort()).toEqual([wire('a', 'b'), wire('b', 'c')].sort())
        expect(cone.edgeIds.has(wire('d', 'b'))).toBe(false)
    })

    it('runs over a REAL board: the focus\'s cone reaches its partners', () => {
        const g = layout(collateralEstate())
        const focal = cardFor(g, 'F')!
        const cone = isolationCone(g, focal.id)!
        for (const table of ['t0', 't1', 't2']) {
            expect(cone.cardIds.has(cardFor(g, table)!.id)).toBe(true)
        }
        expect(cone.edgeIds.size).toBe(g.edges.length)
    })
})

// ── the grain seam (Task 22, R1/R2/R3) ───────────────────────────────
//
// REPRODUCE-FIRST. Both failure directions the user reported live
// (2026-08-14): a cone presenting TABLE-grain knowledge as column-grain
// FACT (over-claim, 15.41.27), and its mirror — a row's cone going DARK
// through a coarse-landed hop its own entity participates in
// (under-claim, 19.01.05/19.02.33).

describe('focus-layout — the grain seam (R1)', () => {
    /** A container T (declares childCount, so it "holds things") feeds a
     *  leaf column `fc` of the focus directly — table-grain on the
     *  SOURCE side, column-true on the target. A plain leaf column `sc`
     *  feeds the SAME target, for contrast. */
    const overClaimShape = () => subgraph({
        focus: 'F',
        nodes: [
            wnode('T', 'dataset', 'gold_table', { childCount: 12 }),
            wnode('SRC', 'dataset', 'clean_table', { childCount: 3 }),
            wnode('sc', 'schemaField', 'clean_col'),
            wnode('F', 'dataset', 'rpt', { childCount: 2 }),
            wnode('fc', 'schemaField', 'full_name'),
        ],
        contains: [['SRC', 'sc'], ['F', 'fc']],
        // T's own hop names the WHOLE TABLE, never one of its columns —
        // that is what makes it coarse; sc's hop names a leaf, same as
        // the target.
        hops: [['T', 'fc'], ['sc', 'fc']],
    })

    it('R1 — a hop whose own endpoint HOLDS THINGS is coarse, never column-certain', () => {
        const g = layout(overClaimShape())
        const coarse = g.edges.find(e => e.source === cardFor(g, 'T')!.id)!
        const fine = g.edges.find(e => e.source === cardFor(g, 'sc')!.id)!
        expect(coarse.grainCoarse).toBe(true)
        expect(fine.grainCoarse).toBe(false)
    })

    it('R1 — an off-window row rolled up to its OWN frame stays column-certain (T19\'s rule, unbroken)', () => {
        // The exact `wideEstate` shape from "every edge and every label
        // has both its ends on the board": a row scrolled past rolls up
        // to the card that IS drawn, and T19 already ruled that this is
        // the SAME grain, just scrolled past — never coarse.
        const cols = Array.from({ length: 14 }, (_, i) => `c${String(i).padStart(2, '0')}`)
        const nodes = [
            wnode('T1', 'dataset', 'int_clean_orders_t1', { childCount: 40 }),
            wnode('F', 'dataset', 'int_clean_orders_t2', { childCount: 40 }),
        ]
        const contains: Array<[string, string]> = []
        const hops: Array<[string, string, string]> = []
        for (const c of cols) {
            nodes.push(wnode(`t1:${c}`, 'schemaField', c), wnode(`f:${c}`, 'schemaField', c))
            contains.push(['T1', `t1:${c}`], ['F', `f:${c}`])
            hops.push([`t1:${c}`, `f:${c}`, 'TRANSFORMS'])
        }
        const sg = subgraph({ focus: 'F', nodes, hops, contains })
        const base = initialLensViewState(sg)
        const g = layout(sg, { ...base, frameOffsets: new Map([['T1', 9], ['F', 9]]) })
        expect(g.edges.length).toBeGreaterThan(0)
        for (const e of g.edges) expect(e.grainCoarse).toBe(false)
    })

    it('R1b — a ROW\'s cone traverses a coarse hop landed on its OWN containing frame (the under-claim)', () => {
        const cardX = (id: string, frameId: string | null = null): FocusCard =>
            ({ ...({} as FocusCard), id, nodeId: id, frameId, kind: frameId ? 'entity' : 'frame' })
        const edgeX = (id: string, source: string, target: string, grainCoarse = false): FocusEdge =>
            ({
                id, source, target, count: 1, edgeTypeNorm: '', dimmed: false,
                cycleBack: false, cycleAnchor: false, labelVisible: false,
                grainCoarse, sameAncestorFrame: null, inFrameLane: null, labelT: 0.5, seamSlotted: false,
            })
        // MKT → IOT lands on IoT's OWN frame — nothing to do with TXN,
        // one of IoT's rows, specifically.
        const cards = [cardX('MKT'), cardX('IOT'), cardX('TXN', 'IOT')]
        const edges = [edgeX('e1', 'MKT', 'IOT', true)]
        // BEFORE the fix this is null (TXN carries no edge of its own).
        const cone = isolationCone({ cards, edges }, 'TXN')
        expect(cone).not.toBeNull()
        expect(cone!.cardIds.has('MKT')).toBe(true)
        expect(cone!.cardIds.has('IOT')).toBe(true)
        expect(cone!.edgeIds.has('e1')).toBe(true)
    })

    it('R1b — a row with genuinely nothing (no edge of its own, no coarse ancestor edge) still isolates nothing', () => {
        const cardX = (id: string, frameId: string | null = null): FocusCard =>
            ({ ...({} as FocusCard), id, nodeId: id, frameId, kind: frameId ? 'entity' : 'frame' })
        const cards = [cardX('IOT'), cardX('TXN', 'IOT')]
        expect(isolationCone({ cards, edges: [] }, 'TXN')).toBeNull()
    })

    it('R1 — the real built board: isolating the focus\'s own column lights the six coarse producers, seamed, alongside the genuine column producer', () => {
        const sg = walkGrainSeamPure()
        const g = layout(sg, withReveal(initialLensViewState(sg), 'in:IOT', 1))
        const fnId = cardFor(g, 'FN')!.id
        const cone = isolationCone(g, fnId)!
        const coarseCount = ['G01', 'G02', 'G03', 'G04', 'G05', 'G06']
            .map(u => g.edges.find(e => e.source === cardFor(g, u)!.id && e.target === fnId)!)
        for (const e of coarseCount) expect(e.grainCoarse).toBe(true)
        const fine = g.edges.find(e => e.source === cardFor(g, 'BFN')!.id)!
        expect(fine.grainCoarse).toBe(false)
        for (const e of coarseCount) expect(cone.edgeIds.has(e.id)).toBe(true)
        expect(cone.edgeIds.has(fine.id)).toBe(true)
    })

    it('R1 — the real built board: isolating the row goes lit toward Marketing, seamed, not dark', () => {
        const sg = walkGrainSeamPure()
        const g = layout(sg, withReveal(initialLensViewState(sg), 'in:IOT', 1))
        const txnId = cardFor(g, 'TXN')!.id
        const before = isolationCone({ cards: g.cards, edges: g.edges.map(e => ({ ...e, grainCoarse: false })) }, txnId)
        // Without the seam data, TXN's own wire (from FN) still lights —
        // proving the fixture is not simply disconnected — but nothing
        // toward Marketing.
        expect(before).not.toBeNull()
        expect(before!.cardIds.has(cardFor(g, 'MKT')!.id)).toBe(false)
        const cone = isolationCone(g, txnId)!
        expect(cone.cardIds.has(cardFor(g, 'MKT')!.id)).toBe(true)
        expect(cone.cardIds.has(cardFor(g, 'IOT')!.id)).toBe(true)
    })

    // T26 R3 — REPRO FIRST: spotlight ONE column, several containment
    // levels deep, where EVERY ancestor level between it and the root
    // carries its own, unrelated coarse traffic — the user's reported
    // shape (11.36.49/53), "most of the board lights orange". Manual
    // card/edge construction (same pattern as the R1b tests above) so the
    // seam-walk's own cardinality is asserted directly, independent of
    // `buildFocusLayout`'s grain computation.
    it('one-column-spotlight: the cone terminates at the FIRST seam — it does not climb the ancestor chain', () => {
        const cardX = (id: string, frameId: string | null = null): FocusCard =>
            ({ ...({} as FocusCard), id, nodeId: id, frameId, kind: frameId ? 'entity' : 'frame' })
        const edgeX = (id: string, source: string, target: string, grainCoarse = false): FocusEdge =>
            ({
                id, source, target, count: 1, edgeTypeNorm: '', dimmed: false,
                cycleBack: false, cycleAnchor: false, labelVisible: false,
                grainCoarse, sameAncestorFrame: null, inFrameLane: null, labelT: 0.5, seamSlotted: false,
            })
        // COL ⊂ TABLE ⊂ SCHEMA ⊂ DATABASE — four containment levels.
        // TABLE (the anchor's OWN immediate frame — the one true seam)
        // carries its own direct coarse bundle; SCHEMA and DATABASE, one
        // and two levels further up, each carry a SEPARATE, unrelated
        // one. Before the fix, climbing the whole ancestor chain admitted
        // all three; the rule says only the first.
        const cards = [
            cardX('DATABASE'), cardX('SCHEMA', 'DATABASE'), cardX('TABLE', 'SCHEMA'), cardX('COL', 'TABLE'),
            cardX('TABLE_PRODUCER'), cardX('SCHEMA_PRODUCER'), cardX('DB_PRODUCER'),
        ]
        const edges = [
            edgeX('e_table', 'TABLE_PRODUCER', 'TABLE', true),
            edgeX('e_schema', 'SCHEMA_PRODUCER', 'SCHEMA', true),
            edgeX('e_db', 'DB_PRODUCER', 'DATABASE', true),
        ]
        const cone = isolationCone({ cards, edges }, 'COL')!
        expect(cone).not.toBeNull()
        // The one true seam: TABLE's own direct coarse partner lights.
        expect(cone.cardIds.has('TABLE_PRODUCER')).toBe(true)
        expect(cone.edgeIds.has('e_table')).toBe(true)
        // NOT the transitive closure through the rest of the ancestor
        // chain — SCHEMA's and DATABASE's own, unrelated coarse traffic
        // never lights from a column spotlight several levels below them.
        expect(cone.cardIds.has('SCHEMA_PRODUCER')).toBe(false)
        expect(cone.cardIds.has('DB_PRODUCER')).toBe(false)
        expect(cone.edgeIds.has('e_schema')).toBe(false)
        expect(cone.edgeIds.has('e_db')).toBe(false)
        // Cardinality bounded exactly: the anchor's own containment
        // ancestors (TABLE, SCHEMA, DATABASE — every box it sits in) plus
        // the one seam host's direct coarse partner. Not the whole board.
        expect([...cone.cardIds].sort()).toEqual(['COL', 'DATABASE', 'SCHEMA', 'TABLE', 'TABLE_PRODUCER'])
    })

    it('a seam host with NO direct coarse edges of its own lights nothing further — never climbs to find one', () => {
        const cardX = (id: string, frameId: string | null = null): FocusCard =>
            ({ ...({} as FocusCard), id, nodeId: id, frameId, kind: frameId ? 'entity' : 'frame' })
        const edgeX = (id: string, source: string, target: string, grainCoarse = false): FocusEdge =>
            ({
                id, source, target, count: 1, edgeTypeNorm: '', dimmed: false,
                cycleBack: false, cycleAnchor: false, labelVisible: false,
                grainCoarse, sameAncestorFrame: null, inFrameLane: null, labelT: 0.5, seamSlotted: false,
            })
        // TABLE (the anchor's own seam host) has no coarse bundle of its
        // own; only SCHEMA, one level further up, does. Before the fix
        // this still lit (the walk climbed past an empty host); after,
        // nothing does — the detailed walk terminates at the FIRST seam
        // whether or not it has anything to say.
        const cards = [cardX('SCHEMA'), cardX('TABLE', 'SCHEMA'), cardX('COL', 'TABLE'), cardX('SCHEMA_PRODUCER')]
        const edges = [edgeX('e_schema', 'SCHEMA_PRODUCER', 'SCHEMA', true)]
        expect(isolationCone({ cards, edges }, 'COL')).toBeNull()
    })
})

describe('focus-layout — in-frame routing (R2)', () => {
    it('two rows of the SAME frame, wired to each other, share it as their routing ancestor', () => {
        const sg = walkGrainSeamPure()
        const g = layout(sg, withReveal(initialLensViewState(sg), 'in:IOT', 1))
        const g01 = cardFor(g, 'G01')!
        const g02 = cardFor(g, 'G02')!
        const wire = g.edges.find(e => e.source === g01.id && e.target === g02.id)!
        expect(wire.sameAncestorFrame).not.toBeNull()
        const ancestor = g.cards.find(c => c.id === wire.sameAncestorFrame)!
        expect(g01.frameId).toBe(ancestor.id)
        expect(g02.frameId).toBe(ancestor.id)
        // The bounding-box promise R2 rests on: a straight line between
        // two points strictly inside a rect never leaves it. Pinned as a
        // fact about the geometry the layout already computed, not about
        // whatever curve React Flow draws.
        const within = (card: FocusCard) =>
            card.x >= ancestor.x && card.y >= ancestor.y
            && card.x + card.w <= ancestor.x + ancestor.w
            && card.y + card.h <= ancestor.y + ancestor.h
        expect(within(g01)).toBe(true)
        expect(within(g02)).toBe(true)
    })

    it('an edge between cards with no shared ancestor frame carries none', () => {
        const sg = walkGrainSeamPure()
        const g = layout(sg, withReveal(initialLensViewState(sg), 'in:IOT', 1))
        const wire = g.edges.find(e =>
            e.source === cardFor(g, 'MKT')!.id && e.target === cardFor(g, 'IOT')!.id)!
        expect(wire.sameAncestorFrame).toBeNull()
    })
})

describe('focus-layout — badge legibility (R3)', () => {
    it('two badge-worthy bundles that would collide at the midpoint take DIFFERENT slots along their own wire', () => {
        // Two crossing wires, engineered to land on the EXACT same
        // straight-line midpoint: SRC's top row feeds F's bottom row,
        // SRC's bottom row feeds F's top row, with three more row-pairs
        // between them (tied weight, so they stay in alphabetical
        // row order) giving each wire enough run to actually move along.
        // Each frame's own five rows sit the same distance apart, so the
        // source-side offset and the target-side offset are equal and
        // opposite — the two crossing midpoints coincide regardless of
        // either frame's absolute position. This is the reported shape
        // itself: two near-parallel wires crossing between the same pair
        // of tables, badges stacked with no wire legible under either.
        const rows = ['a', 'b', 'c', 'd', 'e']
        const sg = subgraph({
            focus: 'F',
            nodes: [
                wnode('SRC', 'dataset', 'source_table', { childCount: 8 }),
                ...rows.map(r => wnode(`s_${r}`, 'schemaField', `s_${r}`)),
                wnode('F', 'dataset', 'target_table', { childCount: 8 }),
                ...rows.map(r => wnode(`t_${r}`, 'schemaField', `t_${r}`)),
            ],
            contains: [
                ...rows.map((r): [string, string] => ['SRC', `s_${r}`]),
                ...rows.map((r): [string, string] => ['F', `t_${r}`]),
            ],
            hops: [
                ['s_a', 't_e'], ['s_a', 't_e', 'JOINS'],
                ['s_e', 't_a'], ['s_e', 't_a', 'JOINS'],
                // The middle rows tie weight with the two crossing ones,
                // so ranking stays alphabetical and the rows land in
                // a..e order — the run this wire needs to move along.
                ['s_b', 't_b'], ['s_b', 't_b', 'JOINS'],
                ['s_c', 't_c'], ['s_c', 't_c', 'JOINS'],
                ['s_d', 't_d'], ['s_d', 't_d', 'JOINS'],
            ],
        })
        const base = initialLensViewState(sg)
        const g = layout(sg, { ...base, expandedContainment: new Set([...base.expandedContainment, 'SRC']) })
        const wire1 = g.edges.find(e => e.source === cardFor(g, 's_a')!.id && e.target === cardFor(g, 't_e')!.id)!
        const wire2 = g.edges.find(e => e.source === cardFor(g, 's_e')!.id && e.target === cardFor(g, 't_a')!.id)!
        expect(wire1.count).toBe(2)
        expect(wire2.count).toBe(2)
        expect(wire1.labelVisible).toBe(true)
        expect(wire2.labelVisible).toBe(true)
        // Both wires would sit on the exact same spot at the plain
        // midpoint — the old single-slot placement could show only one.
        expect(wire1.labelT).not.toBe(wire2.labelT)
    })

    it('fix round 1 — a convergent fan too dense for every candidate leaves the innermost wires UNSLOTTED, never overlapping', () => {
        // Ten coarse rows of ONE frame (GOLD), all feeding the SAME
        // target — the exact shape `walkGrainSeam` carries, just wider.
        // The outermost rows have room to find a clear candidate; the
        // rows packed nearest the middle do not, however many candidates
        // are tried. The review's own finding: `showSeam` had no
        // fallback for this case, and drew the badge at a stale/default
        // spot regardless — this pins the layout's OWN honest "no slot"
        // signal (`seamSlotted`) the view now reads.
        const nums = Array.from({ length: 10 }, (_, i) => String(i))
        const sg = subgraph({
            focus: 'F',
            nodes: [
                wnode('F', 'dataset', 'focus_entity'),
                wnode('GOLD', 'CONTAINER', 'GOLD', { childCount: 10 }),
                ...nums.map(i => wnode(`S${i}`, 'dataset', `source_${i}`, { childCount: 5 })),
            ],
            contains: nums.map((i): [string, string] => ['GOLD', `S${i}`]),
            hops: nums.map((i): [string, string] => [`S${i}`, 'F']),
        })
        const g = layout(sg)
        const coarse = g.edges.filter(e => e.grainCoarse)
        // Not a vacuous pass: some genuinely fail (the finding this pin
        // exists for) and some genuinely succeed (the mechanism still
        // works where there IS room) — on the SAME board, at once.
        const unslotted = coarse.filter(e => !e.seamSlotted)
        const slotted = coarse.filter(e => e.seamSlotted)
        expect(unslotted.length).toBeGreaterThan(0)
        expect(slotted.length).toBeGreaterThan(0)
        // An unslotted wire still carries `labelT: 0.5` (the harmless
        // default) — it is the VIEW's job to withhold the badge for it,
        // never this flag's job to fake a position.
        for (const e of unslotted) expect(e.labelT).toBe(0.5)
    })

    it('a single bundle with no competitor keeps the plain midpoint (unchanged from before this task)', () => {
        const sg = subgraph({
            focus: 'F',
            nodes: [wnode('F'), wnode('U')],
            hops: [['U', 'F'], ['U', 'F', 'JOINS']],
            contains: [],
        })
        const g = layout(sg)
        const bundle = g.edges.find(e => e.count === 2)!
        expect(bundle.labelVisible).toBe(true)
        expect(bundle.labelT).toBe(0.5)
    })
})

/** The shared T22 estate, built once per test through the real pipeline —
 *  the same shape `walkGrainSeam`/`walkGrainSeamUnderclaim` screenshot,
 *  reconstructed here rather than imported so this file stays free of a
 *  dependency on `src/harness` (which the perf suite already established
 *  as the one place that pattern belongs — see `buildWalk.ts`'s own doc
 *  comment on why a screenshot fixture and a jsdom pin build the props
 *  the same way without importing each other). */
function walkGrainSeamPure(): LensSubgraph<LensWalkNode> {
    const nums = ['01', '02', '03', '04', '05', '06']
    return subgraph({
        focus: 'RPT',
        nodes: [
            wnode('SNOW', 'PLATFORM', 'Snowflake', { childCount: 10 }),
            wnode('REPORTING', 'CONTAINER', 'REPORTING', { childCount: 2 }),
            wnode('RPT', 'dataset', 'rpt_customer_360', { childCount: 5 }),
            wnode('FN', 'schemaField', 'full_name'),
            wnode('SD', 'schemaField', 'signup_date'),
            wnode('GOLD', 'CONTAINER', 'GOLD', { childCount: 8 }),
            ...nums.map(n => wnode(`G${n}`, 'dataset', `crm_snapshot_${n}`, { childCount: 10 })),
            wnode('BILL', 'CONTAINER', 'BILLING', { childCount: 3 }),
            wnode('BSRC', 'dataset', 'billing_source', { childCount: 6 }),
            wnode('BFN', 'schemaField', 'full_name_src'),
            wnode('IOT', 'PLATFORM', 'IoT', { childCount: 4 }),
            wnode('TXN', 'dataset', 'transactions'),
            wnode('MKT', 'PLATFORM', 'Marketing', { childCount: 12 }),
        ],
        contains: [
            ['SNOW', 'REPORTING'], ['REPORTING', 'RPT'], ['RPT', 'FN'], ['RPT', 'SD'],
            ...nums.map((n): [string, string] => ['GOLD', `G${n}`]),
            ['BILL', 'BSRC'], ['BSRC', 'BFN'],
            ['IOT', 'TXN'],
        ],
        hops: [
            ['G01', 'FN'], ['G01', 'FN', 'JOINS'],
            ['G02', 'FN'], ['G02', 'FN', 'JOINS'],
            ['G03', 'FN'], ['G04', 'FN'], ['G05', 'FN'], ['G06', 'FN'],
            ['G01', 'G02', 'FEEDS'],
            ['BFN', 'FN'],
            ['FN', 'TXN'],
            ['MKT', 'IOT'],
        ],
        frontierUp: [{ urn: 'G01', totalCount: 3, nextCursor: null }],
    })
}

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
        // WHERE IT LIVES, WHICH SIDE IT IS ON, AND WHAT IT CONNECTS TO —
        // the three things a reader sorts a lineage export by, and none
        // of which used to be in it. `path` survives a container the
        // picture demoted to a breadcrumb, which is exactly when
        // `parentUrn` goes null.
        expect(db.direction).toBe('upstream')
        expect(db.hops).toBeGreaterThan(0)
        expect(typeof db.path).toBe('string')
        expect(db.knownIn).toBeGreaterThanOrEqual(db.drawnIn)
        expect(db.knownOut).toBeGreaterThanOrEqual(db.drawnOut)
        // Edges are addressed by URN, not the layout's internal card ids —
        // and the three raw hops into DB bundle into one weighted edge.
        expect(payload.edges).toContainEqual({
            sourceUrn: 't0', targetUrn: 'F', type: 'DERIVES_FROM', weight: 1, insideContainer: false,
        })
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
        expect(lines[0]).toBe('urn,name,type,path,direction,hops,parentUrn,depth,drawnIn,drawnOut,knownIn,knownOut')
        const blankAt = lines.indexOf('')
        expect(blankAt).toBeGreaterThan(0)
        expect(lines[blankAt + 1]).toBe('sourceUrn,targetUrn,type,weight,insideContainer')
        // A name that itself contains a comma is quoted, not corrupted.
        const withComma = { ...payload, nodes: [{
            urn: 'x', name: 'Revenue, Q1', type: 't', path: '', direction: 'focus' as const, hops: 0,
            parentUrn: null, depth: 0, drawnIn: 0, drawnOut: 0, knownIn: 0, knownOut: 0,
        }] }
        expect(walkExportToCsv(withComma)).toContain('"Revenue, Q1"')
        // A urn with no parent IN THE PICTURE renders as an EMPTY field,
        // not the literal string "null".
        expect(lines.some(l => l.startsWith('DB,RISK_DB,DATABASE,'))).toBe(true)
        expect(csv).not.toContain('null')
    })

    it('defuses a name a spreadsheet would run as a formula', () => {
        // These are entity names out of someone's catalogue, and Excel and
        // Sheets execute a cell that OPENS with = + - @. An exported
        // lineage picture must not run anything on the desk of whoever
        // opens it.
        const payload = {
            focus: 'x',
            generatedAt: '2026-08-14T00:00:00.000Z',
            nodes: [
                { urn: '=cmd|calc', name: '@SUM(A1)', type: '+t', path: '', direction: 'focus' as const, hops: 0, parentUrn: '-x', depth: -1, drawnIn: 0, drawnOut: 0, knownIn: 0, knownOut: 0 },
                { urn: 'plain', name: 'Revenue', type: 't', path: '', direction: 'focus' as const, hops: 0, parentUrn: null, depth: 0, drawnIn: 0, drawnOut: 0, knownIn: 0, knownOut: 0 },
            ],
            edges: [{ sourceUrn: '=a', targetUrn: 'b', type: 'FLOWS', weight: 2, insideContainer: false }],
        }
        const lines = walkExportToCsv(payload).split('\n')

        expect(lines[1]).toBe("'=cmd|calc,'@SUM(A1),'+t,,focus,0,'-x,-1,0,0,0,0")
        // A NUMBER is never a formula: defusing a negative depth into
        // `'-1` would corrupt the column it was meant to protect.
        expect(lines[1]).toContain(',-1,')
        // And an ordinary name is left exactly as it was.
        expect(lines[2]).toBe('plain,Revenue,t,,focus,0,,0,0,0,0,0')
        expect(lines[lines.length - 1]).toBe("'=a,b,FLOWS,2,no")
    })
})

// ── the board is never empty while the model has the focus ───────────
//
// REPORTED LIVE (2026-08-14 09.13–09.21): focusing the SCHEMAFIELD
// `channel` drew nothing at all — no focal card, no bands, no wires —
// while the header and the path bar stayed perfectly fine. Another
// column focus in the same estate drew correctly, so the blank needs a
// SHAPE, and these are the two that produce it.
//
// The estate is the live dev graph's own, at the grain it was reported
// at: a column with lineage running to and from its own containment ROOT
// — `Snowflake → channel` and `channel → Snowflake`. That came from
// `:AGGREGATED` rollups, which the closure no longer walks; the SHAPE
// outlives them, because any source declaring lineage at container grain
// (and plenty do) puts a hop on a level below the focus's own root.

/** `A0 ⊃ A1 ⊃ … ⊃ A{levels-1} ⊃ F`, F a leaf column.
 *
 *  `hopFrom` is the chain index the rollup pair runs to and from — the
 *  live estate has one per ancestor level, and WHICH of them the picture
 *  sees decides whether the chain gets repaired by accident: a hop to an
 *  ancestor the population never admitted re-admits it as a partner,
 *  while a hop to one it did admit leaves the estate exactly as broken as
 *  it was. `partner` adds an ordinary column upstream, outside the chain. */
function deepColumnEstate(
    levels: number,
    opts: { hopFrom?: number; partner?: boolean } = {},
): LensSubgraph<LensWalkNode> {
    const chain = Array.from({ length: levels }, (_, i) => `A${i}`)
    const nodes = [
        ...chain.map((u, i) => wnode(u, i === 0 ? 'dataPlatform' : 'container', u)),
        wnode('F', 'schemaField', 'channel'),
    ]
    const contains: Array<[string, string]> = chain.slice(1).map((u, i) => [chain[i], u])
    contains.push([chain[chain.length - 1], 'F'])
    const roll = chain[opts.hopFrom ?? 0]
    const hops: Array<[string, string, string]> = [[roll, 'F', 'DERIVED_FROM'], ['F', roll, 'DERIVED_FROM']]
    if (opts.partner) {
        nodes.push(wnode('PT', 'dataset', 'clean_orders'), wnode('P', 'schemaField', 'channel'))
        contains.push(['PT', 'P'])
        hops.push(['P', 'F', 'TRANSFORMS'])
    }
    return subgraph({ focus: 'F', nodes, hops, contains })
}

describe('the focus is never missing from its own board', () => {
    it('draws the focal card however deep the containment estate goes', () => {
        // Six ancestors is the provenance ribbon's display cap. The
        // POPULATION was seeded from that same capped walk, so at seven
        // the model's true root was never admitted, the root was filtered
        // out of the visible order, and the pass that collects top-level
        // units — which starts at the model roots — never entered the
        // focus's own branch at all.
        for (const levels of [3, 6, 7, 9]) {
            const g = layout(deepColumnEstate(levels, { partner: true }))
            expect({ levels, focal: !!cardFor(g, 'F') }).toEqual({ levels, focal: true })
            expect({ levels, partner: !!cardFor(g, 'P') }).toEqual({ levels, partner: true })
        }
    })

    it('never renders an empty board — the reported blank', () => {
        // The full reported shape: a deep estate where the column's only
        // lineage is the rollup pair to an ancestor the population had
        // already admitted. Nothing is reachable outside the chain, so
        // nothing repairs the chain, and every card on the board — the
        // focal included — hangs off a root that was never admitted.
        const g = layout(deepColumnEstate(9, { hopFrom: 3 }))
        expect(g.cards.length).toBeGreaterThan(0)
        expect(cardFor(g, 'F')).toBeTruthy()
    })

    it('recovers the focal card when the picture drops it for any other reason', () => {
        // The last resort, and deliberately not a fix for one cause: the
        // focus shut inside a collapsed root is a second, independent way
        // to lose it (a restored share link can arrive holding exactly
        // this). Whatever the reason, a board that has a focus in its
        // model always draws it.
        const sg = deepColumnEstate(3, { partner: true })
        const g = layout(sg, shut(initialLensViewState(sg), 'A0'))
        expect(cardFor(g, 'F')).toBeTruthy()
        expect(g.focusRecovered).toBe(true)
    })

    it('says nothing about a recovery when the picture placed the focus itself', () => {
        expect(layout(deepColumnEstate(3, { partner: true })).focusRecovered).toBe(false)
    })
})

// ── a container focus is bounded by its own subtree ──────────────────
//
// REPORTED LIVE (2026-08-14 09.13): focusing the platform Snowflake
// offered "+211" upstream; clicking it fetched, drew NOTHING new, and
// the badge GREW to +384. The rows re-ordered under the click
// (SILVER and INTERMEDIATE_T2 swapped) and Reach read "0+ upstream"
// over a platform full of lineage.
//
// The live closure for that focus says it exactly: 567 nodes, 2,426
// hops, `upstreamUrns` EMPTY — every one of those hops is interior, and
// the backend's own direction sets already say so — and 51 frontier
// entries, every one of them on a node INSIDE the platform. Those
// entries are what "+211" was summing: full-graph degrees of interior
// nodes, most of which is more interior. Fetching it can only ever bring
// back more of the inside, which the picture already had.

/** `PLAT ⊃ {UP ⊃ upstream table, DOWN ⊃ downstream table}` with the
 *  lineage running INSIDE the platform, plus a real consumer outside it.
 *  Frontier entries sit on the interior nodes, exactly as the server
 *  ships them. */
function platformEstate(over: { extraInterior?: boolean } = {}): LensSubgraph<LensWalkNode> {
    const nodes = [
        wnode('PLAT', 'dataPlatform', 'Snowflake', { childCount: 14 }),
        wnode('BRONZE', 'container', 'BRONZE', { childCount: 5 }),
        wnode('SILVER', 'container', 'SILVER', { childCount: 9 }),
        wnode('INT_T2', 'container', 'INTERMEDIATE_T2', { childCount: 7 }),
        wnode('r_tbl', 'dataset', 'raw_orders'),
        wnode('s_tbl', 'dataset', 'clean_orders'),
        wnode('t_tbl', 'dataset', 'int_clean_orders_t2'),
        wnode('BI', 'dataPlatform', 'BI'),
        wnode('dash', 'dataset', 'exec_dashboard'),
    ]
    const contains: Array<[string, string]> = [
        ['PLAT', 'BRONZE'], ['PLAT', 'SILVER'], ['PLAT', 'INT_T2'],
        ['BRONZE', 'r_tbl'], ['SILVER', 's_tbl'], ['INT_T2', 't_tbl'], ['BI', 'dash'],
    ]
    // Every hop upstream of an interior node comes from ANOTHER interior
    // node — the live estate exactly (2,426 hops, `upstreamUrns` empty).
    const hops: Array<[string, string, string]> = [
        ['r_tbl', 's_tbl', 'TRANSFORMS'],
        ['BRONZE', 'SILVER', 'DERIVED_FROM'],
        ['s_tbl', 't_tbl', 'TRANSFORMS'],
        ['SILVER', 't_tbl', 'DERIVED_FROM'],
        ['t_tbl', 'dash', 'TRANSFORMS'],
    ]
    if (over.extraInterior) {
        // What one click's merge brought back: more hops out of SILVER,
        // enough to out-weigh INTERMEDIATE_T2 and swap the two rows.
        nodes.push(wnode('s_tbl2', 'dataset', 'clean_charges'))
        contains.push(['SILVER', 's_tbl2'])
        hops.push(
            ['s_tbl2', 't_tbl', 'TRANSFORMS'], ['s_tbl2', 't_tbl', 'JOINS'],
            ['s_tbl', 'dash', 'TRANSFORMS'], ['s_tbl2', 'dash', 'TRANSFORMS'],
            ['s_tbl2', 'dash', 'JOINS'],
        )
    }
    return subgraph({
        focus: 'PLAT', nodes, hops, contains,
        // Every entry on a node INSIDE the platform — the live shape.
        frontierUp: [
            { urn: 's_tbl', totalCount: 96, nextCursor: null },
            { urn: 't_tbl', totalCount: 115, nextCursor: null },
            { urn: 'SILVER', totalCount: 57, nextCursor: null },
        ],
        frontierDown: [{ urn: 'dash', totalCount: 4, nextCursor: null }],
    })
}

describe('a container focus counts only what crosses its own boundary', () => {
    it('offers no upstream walk pill built from its own interior', () => {
        const g = layout(platformEstate())
        const focal = cardFor(g, 'PLAT')!
        // "+211" was `Σ(totalCount − degree)` over three interior nodes.
        // Nothing about them is a statement about what reaches the
        // PLATFORM from outside, so there is nothing honest to offer.
        expect(focal.pillUp).toBeNull()
    })

    it('still offers what genuinely crosses the boundary', () => {
        // The consumer outside the platform is real lineage of the
        // platform, and its frontier is the platform's to walk.
        const g = layout(platformEstate())
        expect(cardFor(g, 'dash')).toBeTruthy()
        expect(cardFor(g, 'BI')?.pillDown ?? cardFor(g, 'dash')?.pillDown).toBeTruthy()
    })

    it('never re-orders a card that is already drawn when the walk grows', () => {
        // The user's own click swapped SILVER and INTERMEDIATE_T2 under
        // the pointer. A merge may change what a badge says; it may never
        // change where a card is.
        const before = layout(platformEstate())
        const order = (g: { cards: FocusCard[] }) =>
            g.cards.filter(c => c.kind !== 'divider' && c.nodeId).map(c => c.nodeId!)
        const first = order(before)

        // The same view state, one merge later: two more interior hops,
        // which is exactly what re-weighted the rows.
        const grown = platformEstate({ extraInterior: true })
        const after = order(layout(grown, { ...initialLensViewState(grown), drawnRank: before.drawnRank }))

        // Everything already drawn keeps its relative order; arrivals append.
        expect(after.filter(u => first.includes(u))).toEqual(first.filter(u => after.includes(u)))
    })
})

// ── a hop lands at the finest VISIBLE grain on BOTH ends ─────────────
//
// REPORTED (user, Issue A): partner tables opened to their columns wired
// into the FOCAL CARD's single port while the focus's OWN columns sat
// un-wired in the contains-stack below it. Which column feeds which was
// invisible — the one thing a column-grain picture exists to show, and
// what every catalogue that draws this (DataHub, OpenMetadata) shows.
//
// The rule is symmetric: the focus's contains-stack rows are endpoints
// like any other row the moment they are on screen. The focal's single
// ports stay exactly what they were for — the rollup target for a hop
// whose finer end is NOT drawn.

/** The reported estate: `int_clean_orders_t1` feeding the focus
 *  `int_clean_orders_t2`, both at column grain, with a table-grain hop
 *  alongside them and one hop from a column that is not on the board. */
function columnGrainEstate(): LensSubgraph<LensWalkNode> {
    const cols = ['channel', 'order_id', 'net_revenue']
    const nodes = [
        wnode('T1', 'dataset', 'int_clean_orders_t1', { childCount: 14 }),
        wnode('F', 'dataset', 'int_clean_orders_t2', { childCount: 14 }),
        wnode('D', 'dataset', 'fact_orders', { childCount: 9 }),
        // Upstream of the focus at TABLE grain — its finer end is a
        // column nobody has drawn, so it has nowhere finer to land.
        wnode('AGG', 'container', 'SILVER'),
    ]
    const contains: Array<[string, string]> = []
    const hops: Array<[string, string, string]> = [['AGG', 'F', 'DERIVED_FROM']]
    for (const c of cols) {
        nodes.push(wnode(`t1:${c}`, 'schemaField', c), wnode(`f:${c}`, 'schemaField', c), wnode(`d:${c}`, 'schemaField', c))
        contains.push(['T1', `t1:${c}`], ['F', `f:${c}`], ['D', `d:${c}`])
        hops.push([`t1:${c}`, `f:${c}`, 'TRANSFORMS'], [`f:${c}`, `d:${c}`, 'TRANSFORMS'])
    }
    return subgraph({ focus: 'F', nodes, hops, contains })
}

describe('column-grain wiring', () => {
    it('wires row to row when both ends are on screen, and not through the focal', () => {
        const sg = columnGrainEstate()
        const g = layout(sg)
        const idOf = (urn: string) => cardFor(g, urn)!.id
        const focal = cardFor(g, 'F')!

        // The focus's own columns are rows of the contains-stack, and the
        // partner tables' columns are rows of their frames. Every one of
        // the six column-grain hops is drawn between the two columns that
        // actually carry it.
        for (const c of ['channel', 'order_id', 'net_revenue']) {
            expect(g.edges.some(e => e.source === idOf(`t1:${c}`) && e.target === idOf(`f:${c}`))).toBe(true)
            expect(g.edges.some(e => e.source === idOf(`f:${c}`) && e.target === idOf(`d:${c}`))).toBe(true)
        }
        // A row-to-row hop at the finest grain is one hop, not a bundle —
        // no ×N badge on a wire that carries exactly one connection.
        expect(g.edges.find(e => e.source === idOf('t1:channel'))!.count).toBe(1)

        // And nothing lands on the focal that had somewhere finer to go.
        // What still does: the table-grain hop, whose finer end is not on
        // the board at all.
        const onFocal = g.edges.filter(e => e.source === focal.id || e.target === focal.id)
        expect(onFocal).toHaveLength(1)
        expect(onFocal[0]!.source).toBe(idOf('AGG'))
    })

    it('rolls up to the focal exactly when the finer end is not drawn', () => {
        // The same estate with both tables' contents shut: no column is on
        // screen to land on, so the three column hops between them become
        // ONE bundle saying three, arriving at the focal's single port.
        const sg = columnGrainEstate()
        const base = initialLensViewState(sg)
        const g = layout(sg, shut(shut(base, 'F'), 'T1'))
        const focal = cardFor(g, 'F')!
        const into = g.edges.filter(e => e.target === focal.id)
        expect(into.find(e => e.source === cardFor(g, 'T1')!.id)?.count).toBe(3)
        // And with only ONE end shut the wires stay at column grain on the
        // side that is still open — the roll-up is per hop, per endpoint.
        const half = layout(sg, shut(base, 'F'))
        const fromColumns = half.edges.filter(e =>
            e.target === focal.id && (cardFor(half, 't1:channel')!.id === e.source
                || cardFor(half, 't1:order_id')!.id === e.source
                || cardFor(half, 't1:net_revenue')!.id === e.source))
        expect(fromColumns).toHaveLength(3)
    })

    it('gives a wired stack row a port, and leaves an un-wired one bare', () => {
        const sg = columnGrainEstate()
        const g = layout(sg)
        expect(cardFor(g, 'f:channel')!.wired).toBe(true)
        // One offer per element: the rows carry wires, never a ⊕ — the
        // focal speaks for everything inside it.
        expect(cardFor(g, 'f:channel')!.pillUp).toBeNull()
        expect(cardFor(g, 'f:channel')!.deadEnd).toBe(false)
    })
})

// ── no orphan wires, no orphan labels ────────────────────────────────
//
// REPORTED (user): bundle-label chips (×15 ×14 ×13 ×12 ×11) hanging in
// space to the left of a frame with no visible source card and no arrow
// under them. A label is a thing SAID ABOUT a wire; with no wire it is a
// number floating over the board with nothing to attach it to.

describe('every edge and every label has both its ends on the board', () => {
    /** A wide column estate with the partner's rows SCROLLED, which is
     *  where rows exist in the model but not on the board. */
    const wideEstate = () => {
        const cols = Array.from({ length: 14 }, (_, i) => `c${String(i).padStart(2, '0')}`)
        const nodes = [
            wnode('T1', 'dataset', 'int_clean_orders_t1', { childCount: 40 }),
            wnode('F', 'dataset', 'int_clean_orders_t2', { childCount: 40 }),
        ]
        const contains: Array<[string, string]> = []
        const hops: Array<[string, string, string]> = []
        for (const c of cols) {
            nodes.push(wnode(`t1:${c}`, 'schemaField', c), wnode(`f:${c}`, 'schemaField', c))
            contains.push(['T1', `t1:${c}`], ['F', `f:${c}`])
            hops.push([`t1:${c}`, `f:${c}`, 'TRANSFORMS'])
        }
        return subgraph({ focus: 'F', nodes, hops, contains })
    }

    const check = (g: ReturnType<typeof layout>) => {
        const drawn = new Set(g.cards.map(c => c.id))
        for (const e of g.edges) {
            expect({ id: e.id, source: drawn.has(e.source) }).toEqual({ id: e.id, source: true })
            expect({ id: e.id, target: drawn.has(e.target) }).toEqual({ id: e.id, target: true })
        }
        // A label belongs to a wire, so there is no such thing as one
        // without an edge to hang it on.
        for (const e of g.edges) {
            if (!e.labelVisible) continue
            expect(drawn.has(e.source) && drawn.has(e.target)).toBe(true)
        }
    }

    it('holds with both estates wide open', () => check(layout(wideEstate())))

    it('holds when a frame is scrolled past the rows a wire lands on', () => {
        const sg = wideEstate()
        const base = initialLensViewState(sg)
        for (const offset of [0, 3, 6, 9]) {
            check(layout(sg, { ...base, frameOffsets: new Map([['T1', offset], ['F', offset]]) }))
        }
    })

    it('lands an off-window row\'s hop on the frame, never drops it', () => {
        // A frame draws only its scroll window, so with 14 columns and an
        // 8-row window six hops reach rows that have no card. They used to
        // be counted as connecting "at a coarser grain" and dropped — a
        // claim that is both specific and FALSE (an off-window column is
        // the same grain, just scrolled past), and six wires simply
        // vanished. They roll up to the card that IS drawn instead.
        const sg = wideEstate()
        const base = initialLensViewState(sg)
        for (const offset of [0, 3, 6, 9]) {
            const g = layout(sg, { ...base, frameOffsets: new Map([['T1', offset], ['F', offset]]) })
            const carried = g.edges.reduce((n, e) => n + e.count, 0)
            // All 14 raw hops are on the board, every time.
            expect({ offset, carried, coarser: g.hopsAtCoarserGrain })
                .toEqual({ offset, carried: 14, coarser: 0 })
            // ...and rolled-up hops MERGE rather than colliding on one id.
            expect(new Set(g.edges.map(e => e.id)).size).toBe(g.edges.length)
        }
    })

    it('a card a rolled-up wire lands on offers the ports to ANCHOR it', () => {
        // The other half of "both ends on the board". A wire attaches to
        // a card's HANDLES, and a card only draws handles when it is
        // `wired` — which was read off the model's own hops by urn. True
        // for the row a hop names; FALSE for the frame that hop rolls up
        // to when the row is scrolled past, because no hop in the model
        // names the frame. The renderer then refused the wire outright
        // ("Couldn't create edge for source handle id: null"), and the
        // board showed two boxes, six connections between them by the
        // frame's own count, and no line at all.
        //
        // Found by the R5.2 mid-window screenshot, which is the first
        // picture in this suite where EVERY connected row is off-window.
        const sg = wideEstate()
        const base = initialLensViewState(sg)
        const g = layout(sg, { ...base, frameOffsets: new Map([['T1', 9], ['F', 9]]) })
        const byId = new Map(g.cards.map(c => [c.id, c]))
        for (const e of g.edges) {
            expect({ id: e.id, source: byId.get(e.source)!.wired })
                .toEqual({ id: e.id, source: true })
            expect({ id: e.id, target: byId.get(e.target)!.wired })
                .toEqual({ id: e.id, target: true })
        }
        // The frame itself is one of them — nine of its fourteen hops
        // rolled up onto it.
        expect(cardFor(g, 'T1')!.wired).toBe(true)
    })

    it('still says "coarser grain" when there is genuinely no card to land on', () => {
        // The whisper's real case: a hop onto a containment ancestor of
        // the focus, which this picture never boxes. Nothing above it has
        // a card either, so there is nowhere for it to roll up to.
        const g = layout(deepColumnEstate(3, { partner: true }))
        expect(g.hopsAtCoarserGrain).toBe(2)
    })

    it('holds for every fixture shape this suite builds', () => {
        for (const sg of [sharedPlatform(), collateralEstate(), platformEstate(), columnGrainEstate()]) {
            check(layout(sg))
            check(layout(sg, shut(initialLensViewState(sg), sg.focusUrn)))
        }
    })
})

// ── one rule for "is there room for a badge" ─────────────────────────
//
// REPORTED (user): ×15 ×14 ×13 ×12 ×11 stacked in mid-air beside a frame
// with no arrow under any of them. The LAYOUT decided those badges from
// the geometry it had just computed; the VIEW drew the wires between
// React Flow's own coordinates, and the two disagree for a render
// whenever a node has not been measured — every reveal, every drag. Both
// sides call this now, so the answer cannot differ by caller.

describe('labelFitsRun — the badge and the wire agree', () => {
    it('refuses a run shorter than a badge, in any direction', () => {
        expect(labelFitsRun(0, 0, LABEL_MIN_RUN - 1, 0)).toBe(false)
        expect(labelFitsRun(0, 0, 0, LABEL_MIN_RUN - 1)).toBe(false)
        // The degenerate case the report is about: an unmeasured node puts
        // both ends in the same place.
        expect(labelFitsRun(120, 40, 120, 40)).toBe(false)
    })

    it('allows a run exactly long enough, and measures diagonally', () => {
        expect(labelFitsRun(0, 0, LABEL_MIN_RUN, 0)).toBe(true)
        // 3-4-5: a diagonal run counts its true length, not its dx.
        expect(labelFitsRun(0, 0, LABEL_MIN_RUN * 0.6, LABEL_MIN_RUN * 0.8)).toBe(true)
        expect(labelFitsRun(0, 0, LABEL_MIN_RUN * 0.6, LABEL_MIN_RUN * 0.6)).toBe(false)
    })

    it('is what the LAYOUT gates its own badges on', () => {
        // Two cards a whole band apart carry a badge; the same pair, with
        // the wire collapsed, cannot — and the layout reaches that verdict
        // through this same call.
        const sg = subgraph({
            focus: 'F',
            nodes: [wnode('F'), wnode('U')],
            hops: [['U', 'F'], ['U', 'F', 'JOINS']],
            contains: [],
        })
        const g = layout(sg)
        const bundle = g.edges.find(e => e.count === 2)!
        const s = g.cards.find(c => c.id === bundle.source)!
        const t = g.cards.find(c => c.id === bundle.target)!
        expect(bundle.labelVisible).toBe(labelFitsRun(s.x + s.w, s.y + s.h / 2, t.x, t.y + t.h / 2))
        expect(bundle.labelVisible).toBe(true)
    })
})

describe('focal container-of-containers in All mode (2026-08-19: "only the 1st node\'s children show")', () => {
    /** F ⊃ m1..m10, each mid ⊃ leaves; lineage runs through m1's leaf
     *  only. The walk model carries F, m1 and its leaf (the flow); the
     *  roster knows all ten mids. Focusing F with Contents=All must show
     *  ALL TEN mids — the flow one populated, the other nine as quiet
     *  rows — never just the first. */
    function nestedEstate() {
        const mids = Array.from({ length: 10 }, (_, i) => `m${i + 1}`)
        const sg = subgraph({
            focus: 'F',
            nodes: [wnode('F', 'NODE'), wnode('m1', 'NODE'), wnode('leaf1', 'ITEM'), wnode('src', 'ITEM')],
            hops: [['src', 'leaf1']],
            contains: [['F', 'm1'], ['m1', 'leaf1']],
        })
        const roster = {
            children: mids.map(m => wnode(m, 'NODE')),
            hasMore: false,
            total: 10,
        }
        const view = {
            ...initialLensViewState(sg),
            frameShowAll: new Set(['F']),
        }
        return { sg, roster, view, mids }
    }

    it('draws every mid-level child of the focal: the flow one populated, the other nine as rows', () => {
        const { sg, roster, view, mids } = nestedEstate()
        const g = layout(sg, view, {
            childrenAll: new Map([['F', roster]]),
            childrenAllStatus: new Map([['F', 'done']]),
        })
        for (const m of mids) {
            expect(cardFor(g, m), `${m} must be on the board`).toBeTruthy()
        }
        // (m1's own leaf population needs the component's settle pass —
        // the sticky-grain double render — so a single-pass layout call
        // deliberately doesn't assert it; lensSeam covers that side.)
    })

    it('counts the window over ALL rows, not just the connected one', () => {
        const { sg, roster, view } = nestedEstate()
        const g = layout(sg, view, {
            childrenAll: new Map([['F', roster]]),
            childrenAllStatus: new Map([['F', 'done']]),
        })
        const focal = cardFor(g, 'F')!
        expect(focal.frameRows.length).toBe(10)
    })
})

describe('deep focus subtree — FOCUS +1 (2026-08-19, re-refined: children are visible CLOSED rows; opening is the reader\'s click)', () => {
    /** F ⊃ m1 ⊃ T1 ⊃ colA (colA fed by src): the focus opens showing its
     *  DIRECT children as closed rows with honest counts — and that is
     *  the whole default. m1's contents appear when the reader opens m1,
     *  one level per click; wide sets paginate (frame windows client-side,
     *  seedCursor server-side). The earlier same-day ruling auto-opened
     *  m1, which pre-splayed the grandchildren ("far too much" — the
     *  DATAPLATFORM/Snowflake board). Partner-side grain is untouched
     *  (the journey suite's contract). */
    function deepEstate() {
        return subgraph({
            focus: 'F',
            nodes: [
                wnode('F', 'NODE'), wnode('m1', 'NODE'), wnode('T1', 'NODE'),
                wnode('colA', 'ITEM'), wnode('src', 'ITEM'), wnode('SRCP', 'NODE'),
            ],
            hops: [['src', 'colA']],
            contains: [['F', 'm1'], ['m1', 'T1'], ['T1', 'colA'], ['SRCP', 'src']],
        })
    }

    it('shows the focus\'s direct child as a visible, CLOSED row; nothing deeper is drawn', () => {
        const g = layout(deepEstate())
        const m1 = cardFor(g, 'm1')
        expect(m1, 'm1 must be on the board').toBeTruthy()
        expect(m1!.childrenOpen, 'the direct child stays a closed door').toBe(false)
        expect(cardFor(g, 'T1'), 'the grandchild is not drawn until m1 is opened').toBeFalsy()
        expect(cardFor(g, 'colA'), 'the carrier behind the closed doors is not drawn').toBeFalsy()
    })

    it('opening the child by hand reveals ONE more level, itself closed', () => {
        const sg = deepEstate()
        const base = initialLensViewState(sg)
        const g = layout(sg, { ...base, expandedContainment: new Set([...base.expandedContainment, 'm1']) })
        const t1 = cardFor(g, 'T1')
        expect(t1, 'T1 becomes visible inside the opened m1').toBeTruthy()
        expect(t1!.childrenOpen, 'and is itself a closed door').toBe(false)
        expect(cardFor(g, 'colA'), 'colA still waits behind T1').toBeFalsy()
    })
})
