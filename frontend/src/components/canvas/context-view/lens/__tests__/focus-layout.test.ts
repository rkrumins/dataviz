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
import { FOCAL_H, FRAME_WINDOW, frameWindow, type FocusCard, type FocusEdge } from '../focus-cards'

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

    it('R1: the focus is never chrome — one connected child and no hop of its own', () => {
        // The shape that took the whole board down: `Snowflake ⊃ BRONZE ⊃
        // clean_charges_t2 ⊃ ONE column`. The focus has exactly one
        // populated child and ships no hop itself, so every pass-through
        // test in the walk says "see through me" — and seeing through the
        // FOCUS demoted it out of the picture, taking the focal card, the
        // contains-stack and (because every hop reprojects onto the focus)
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
        // Its one column is in the stack, not loose on the board.
        const stack = g.cards.find(c => c.id === 'co:F')!
        expect(stack).toBeDefined()
        expect(cardFor(g, 'fc')!.frameId).toBe(stack.id)
        // And the wire is drawn — at the focal, from the partner's row.
        expect(g.edges).toHaveLength(1)
        expect(g.edges[0].source).toBe(cardFor(g, 'sc')!.id)
        expect(g.edges[0].target).toBe(focal.id)
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

        it('needs both kinds of row to divide — never a lone header', () => {
            expect(mixedRoster(2, 0).cards.some(c => c.kind === 'divider')).toBe(false)
            expect(mixedRoster(0, 3).cards.some(c => c.kind === 'divider')).toBe(false)
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

    it('a frame\'s Find reaches the rows the frame was opened to show', () => {
        // The box searched only the UNCONNECTED extras — i.e. everything
        // except the rows a reader opened the frame for. Typing a column
        // name did nothing to the columns.
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
        // Dimmed, never removed — a row a search hid is a row you cannot
        // see is there, which is the same lie as a filter that deletes.
        expect(cardFor(g, 'c0')!.dimmed).toBe(true)
        expect(cardFor(g, 'c1')!.dimmed).toBe(false)
        // The frame itself is not its own row: it stays lit.
        expect(cardFor(g, 'T')!.dimmed).toBe(false)
    })

    it('says so when nothing inside is on the lineage, instead of a roster that reads like an answer', () => {
        // The focus connects at TABLE grain: its columns are in the
        // container, and not one of them is on this lineage. Opening
        // "everything inside" then fills the stack with rows that connect
        // to nothing — which reads as an answer unless the frame says
        // plainly that it isn't one.
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
        const stack = g.cards.find(c => c.id === 'co:F')!
        expect(stack.frameEmpty).toBe(true)
        expect(stack.frameConnectedCount).toBe(0)
        expect(stack.frameLoaded).toBe(2)
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
        expect(payload.edges).toContainEqual({ sourceUrn: 't0', targetUrn: 'F', type: 'DERIVES_FROM', weight: 1 })
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

    it('defuses a name a spreadsheet would run as a formula', () => {
        // These are entity names out of someone's catalogue, and Excel and
        // Sheets execute a cell that OPENS with = + - @. An exported
        // lineage picture must not run anything on the desk of whoever
        // opens it.
        const payload = {
            focus: 'x',
            generatedAt: '2026-08-14T00:00:00.000Z',
            nodes: [
                { urn: '=cmd|calc', name: '@SUM(A1)', type: '+t', parentUrn: '-x', depth: -1 },
                { urn: 'plain', name: 'Revenue', type: 't', parentUrn: null, depth: 0 },
            ],
            edges: [{ sourceUrn: '=a', targetUrn: 'b', type: 'FLOWS', weight: 2 }],
        }
        const lines = walkExportToCsv(payload).split('\n')

        expect(lines[1]).toBe("'=cmd|calc,'@SUM(A1),'+t,'-x,-1")
        // A NUMBER is never a formula: defusing a negative depth into
        // `'-1` would corrupt the column it was meant to protect.
        expect(lines[1].endsWith(',-1')).toBe(true)
        // And an ordinary name is left exactly as it was.
        expect(lines[2]).toBe('plain,Revenue,t,,0')
        expect(lines[lines.length - 1]).toBe("'=a,b,FLOWS,2")
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
// The estate is the live dev graph's own: that source's ontology lists
// AGGREGATED as a LINEAGE edge type, and the aggregation worker
// materialises a rollup hop from a column to every coarser grain above
// it — including the column's own platform. So a column's lineage
// genuinely includes `Snowflake → channel` and `channel → Snowflake`,
// where Snowflake is the column's own containment root.

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
    const hops: Array<[string, string, string]> = [[roll, 'F', 'AGGREGATED'], ['F', roll, 'AGGREGATED']]
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
        ['BRONZE', 'SILVER', 'AGGREGATED'],
        ['s_tbl', 't_tbl', 'TRANSFORMS'],
        ['SILVER', 't_tbl', 'AGGREGATED'],
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
