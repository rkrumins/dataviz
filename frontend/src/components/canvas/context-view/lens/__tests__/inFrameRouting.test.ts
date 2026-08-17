/**
 * IN-FRAME ROUTING, end to end through the real layout — the reported
 * GOLD shape: a warehouse container whose own tables feed each other,
 * whose wires used to be straight diagonals drawn across every card
 * between their two rows (a straight line was T22 R2's own fix for a
 * bezier bowing OUTSIDE the frame; it traded leaving the box for cutting
 * through it), at lengths the rows' own order — first-drawn, then
 * busiest — made as long as the frame.
 *
 * The claims here are GEOMETRIC and asserted in the pure layer, where
 * the coordinates actually exist: jsdom has no layout, so a DOM test
 * could only ever check that an element rendered, never where its line
 * went.
 */
import { describe, it, expect } from 'vitest'
import { buildLensSubgraph, type LensSubgraph } from '../lens-subgraph'
import type { LensWalkNode } from '../closure-adapter'
import { buildFocusLayout, initialLensViewState, type LensViewState } from '../focus-layout'
import { gutterWidth, INFRAME_WIRE_CAP, MAX_LANES } from '../frame-flow'
import { FRAME_PAD, type FocusCard, type FocusGraph } from '../focus-cards'

const wnode = (urn: string, type = 'dataset', label = urn): LensWalkNode => ({
    id: urn, type: 'generic', position: { x: 0, y: 0 }, data: { urn, label, type },
    urn, displayName: label, entityType: type,
}) as unknown as LensWalkNode

function build(
    focus: string,
    nodes: LensWalkNode[],
    hops: Array<[string, string]>,
    contains: Array<[string, string]>,
    reveal: string[] = [],
    open: string[] = [],
): FocusGraph {
    const sg: LensSubgraph<LensWalkNode> = buildLensSubgraph<LensWalkNode>({
        focusUrn: focus,
        nodes,
        lineageEdges: hops.map(([s, t], i) => ({ id: `h${i}`, sourceUrn: s, targetUrn: t, edgeType: 'DERIVES_FROM' })),
        containmentEdges: contains.map(([s, t]) => ({ sourceUrn: s, targetUrn: t })),
    })
    const base = initialLensViewState(sg)
    const view: LensViewState = {
        ...base,
        revealed: new Map([...base.revealed, ...reveal.map(k => [k, 1] as [string, number])]),
        expandedContainment: new Set([...base.expandedContainment, ...open]),
    }
    return buildFocusLayout({
        sg,
        view,
        query: '',
        hiddenTypes: new Set(),
        extendStatus: new Map(),
        childrenAll: new Map(),
        childrenAllStatus: new Map(),
        walkStatus: 'done',
    })
}

/**
 * THE REPORTED ESTATE. A GOLD warehouse feeding one reporting table,
 * whose own five tables talk among themselves: `dim` feeds `orders` and
 * `support`, `support` and `pipeline` feed `orders`, and `ledger` keeps
 * to itself. Four flows stay inside the box; two leave it.
 *
 * `dim` is declared after its own consumers, which is exactly how the
 * reported picture ended up drawing its wires back UP the stack.
 */
function goldEstate(): FocusGraph {
    return build(
        'RPT',
        [
            wnode('RPT', 'dataset', 'reporting_table'),
            wnode('GOLD', 'container', 'GOLD'),
            wnode('orders', 'dataset', 'fact_orders'),
            wnode('dim', 'dataset', 'dim_customer'),
            wnode('pipeline', 'dataset', 'fact_pipeline'),
            wnode('support', 'dataset', 'fact_support'),
            wnode('ledger', 'dataset', 'fact_ledger'),
        ],
        [
            ['dim', 'orders'], ['pipeline', 'orders'], ['dim', 'support'], ['support', 'orders'],
            ['orders', 'RPT'], ['ledger', 'RPT'],
        ],
        [
            ['GOLD', 'orders'], ['GOLD', 'dim'], ['GOLD', 'pipeline'],
            ['GOLD', 'support'], ['GOLD', 'ledger'],
        ],
        ['in:RPT', 'in:orders', 'in:support'],
        ['GOLD'],
    )
}

const frameOf = (g: FocusGraph, urn: string): FocusCard => g.cards.find(c => c.nodeId === urn)!
const rowsOf = (g: FocusGraph, frameId: string): FocusCard[] => g.cards.filter(c => c.frameId === frameId)
const rowIndex = (g: FocusGraph, frameId: string, urn: string): number =>
    rowsOf(g, frameId).findIndex(c => c.nodeId === urn)

describe('in-frame routing — the rows obey the flow', () => {
    it('a producer is drawn ABOVE the consumers it feeds, whatever order it arrived in', () => {
        const g = goldEstate()
        const frame = frameOf(g, 'GOLD')
        expect(rowIndex(g, frame.id, 'dim')).toBeLessThan(rowIndex(g, frame.id, 'support'))
        expect(rowIndex(g, frame.id, 'dim')).toBeLessThan(rowIndex(g, frame.id, 'orders'))
        expect(rowIndex(g, frame.id, 'support')).toBeLessThan(rowIndex(g, frame.id, 'orders'))
        expect(rowIndex(g, frame.id, 'pipeline')).toBeLessThan(rowIndex(g, frame.id, 'orders'))
    })

    it('every internal wire therefore runs ONE way down the stack', () => {
        const g = goldEstate()
        const frame = frameOf(g, 'GOLD')
        const order = rowsOf(g, frame.id).map(c => c.id)
        for (const edge of g.edges.filter(e => e.sameAncestorFrame === frame.id)) {
            expect(order.indexOf(edge.source)).toBeLessThan(order.indexOf(edge.target))
        }
    })

    it('a row that carries no internal flow keeps its own place, unmoved', () => {
        const g = goldEstate()
        expect(rowsOf(g, frameOf(g, 'GOLD').id).map(c => c.nodeId)).toContain('ledger')
    })
})

describe('in-frame routing — the wires never cross a card', () => {
    it('every internal wire gets a lane, and the lane sits LEFT of every row of its frame', () => {
        const g = goldEstate()
        const frame = frameOf(g, 'GOLD')
        const internal = g.edges.filter(e => e.sameAncestorFrame === frame.id)
        expect(internal).toHaveLength(4)
        expect(internal.every(e => e.inFrameLane != null)).toBe(true)

        const leftmostRow = Math.min(...rowsOf(g, frame.id).map(c => c.x))
        for (const edge of internal) {
            // The vertical run is the whole of a laned wire's travel
            // between its two rows, so a lane left of every card is a
            // wire that CANNOT be drawn over one — which is the claim.
            expect(edge.inFrameLane!.x).toBeLessThan(leftmostRow)
            // ...and inside its own frame, not floating off to its left.
            expect(edge.inFrameLane!.x).toBeGreaterThan(frame.x)
        }
    })

    it('wires whose runs overlap are given different lanes; ones that do not, share', () => {
        const g = goldEstate()
        const frame = frameOf(g, 'GOLD')
        const laneFor = (source: string, target: string) => g.edges
            .find(e => e.source === `n:${source}` && e.target === `n:${target}`)!.inFrameLane!.index
        // dim→support and support→orders meet only AT support, so one
        // lane holds both; the two runs that straddle them cannot.
        expect(laneFor('dim', 'support')).toBe(laneFor('support', 'orders'))
        expect(laneFor('pipeline', 'orders')).not.toBe(laneFor('dim', 'support'))
        expect(laneFor('dim', 'orders')).not.toBe(laneFor('pipeline', 'orders'))
        expect(frame.gutterLanes).toBe(3)
    })

    it('the SHORTEST run takes the innermost lane, hugging the rows it joins', () => {
        const g = goldEstate()
        const shortest = g.edges.find(e => e.source === 'n:support' && e.target === 'n:orders')!
        expect(shortest.inFrameLane!.index).toBe(0)
        const longest = g.edges.find(e => e.source === 'n:dim' && e.target === 'n:orders')!
        expect(longest.inFrameLane!.index).toBeGreaterThan(shortest.inFrameLane!.index)
        // Innermost means nearest the rows, so its x is the larger one.
        expect(shortest.inFrameLane!.x).toBeGreaterThan(longest.inFrameLane!.x)
    })

    it('the frame WIDENS by exactly the gutter it reserved, and its rows move over by it', () => {
        const g = goldEstate()
        const frame = frameOf(g, 'GOLD')
        const gutter = gutterWidth(frame.gutterLanes)
        expect(gutter).toBeGreaterThan(0)
        for (const row of rowsOf(g, frame.id)) expect(row.x).toBe(frame.x + FRAME_PAD + gutter)
    })

    it('a frame whose contents do not feed each other reserves NO gutter at all', () => {
        const g = build(
            'RPT',
            [
                wnode('RPT', 'dataset', 'reporting_table'), wnode('GOLD', 'container', 'GOLD'),
                wnode('a'), wnode('b'),
            ],
            [['a', 'RPT'], ['b', 'RPT']],
            [['GOLD', 'a'], ['GOLD', 'b']],
            ['in:RPT'], ['GOLD'],
        )
        expect(frameOf(g, 'GOLD').gutterLanes).toBe(0)
        expect(g.edges.every(e => e.inFrameLane === null)).toBe(true)
    })
})

describe('in-frame routing — the counts survive the wires', () => {
    it('each row carries how many of its flows stay inside the container', () => {
        const g = goldEstate()
        expect(frameOf(g, 'dim').internalOut).toBe(2)
        expect(frameOf(g, 'dim').internalIn).toBe(0)
        expect(frameOf(g, 'support').internalIn).toBe(1)
        expect(frameOf(g, 'support').internalOut).toBe(1)
        expect(frameOf(g, 'orders').internalIn).toBe(3)
        // orders' hop to the FOCUS leaves the container, so it is not
        // counted here — that one is drawn horizontally, as always.
        expect(frameOf(g, 'orders').internalOut).toBe(0)
        expect(frameOf(g, 'ledger').internalIn + frameOf(g, 'ledger').internalOut).toBe(0)
    })

    it('the frame states its own total', () => {
        expect(frameOf(goldEstate(), 'GOLD').internalFlows).toBe(4)
    })
})

describe('in-frame routing — density', () => {
    /** A warehouse of `n` tables in one chain — every table feeds the
     *  next, so there are n-1 internal flows and every run is adjacent.
     *  `skips` adds the shortcut hops a real warehouse has (t0 also
     *  feeding t2 and t3, and so on), which is how a container gets
     *  denser without getting taller — the shape the cap is FOR, and the
     *  only way past it: a frame draws one window of rows however many
     *  it holds. */
    function chainEstate(n: number, skips = 0): FocusGraph {
        const nodes = [wnode('RPT', 'dataset', 'reporting_table'), wnode('WH', 'container', 'WAREHOUSE')]
        const hops: Array<[string, string]> = []
        const contains: Array<[string, string]> = []
        const reveal = ['in:RPT']
        for (let i = 0; i < n; i++) {
            nodes.push(wnode(`t${i}`))
            contains.push(['WH', `t${i}`])
            if (i > 0) hops.push([`t${i - 1}`, `t${i}`])
            for (let k = 2; k <= skips + 1 && i + k < n; k++) hops.push([`t${i}`, `t${i + k}`])
            reveal.push(`in:t${i}`)
        }
        hops.push([`t${n - 1}`, 'RPT'])
        return build('RPT', nodes, hops, contains, reveal, ['WH'])
    }

    it('past the cap the wires go quiet, and the frame is left to say why', () => {
        const g = chainEstate(8, 2)
        const frame = frameOf(g, 'WH')
        expect(frame.internalFlows).toBeGreaterThan(INFRAME_WIRE_CAP)
        const internal = g.edges.filter(e => e.sameAncestorFrame === frame.id)
        expect(internal.length).toBeGreaterThan(0)
        expect(internal.every(e => e.internalQuiet)).toBe(true)
    })

    it('under the cap they stay loud', () => {
        const g = chainEstate(4)
        const internal = g.edges.filter(e => e.sameAncestorFrame === frameOf(g, 'WH').id)
        expect(internal.length).toBeGreaterThan(0)
        expect(internal.every(e => e.internalQuiet)).toBe(false)
    })

    it('MORE OVERLAPPING RUNS THAN LANES — the frame goes quiet rather than drawing one across its cards', () => {
        // Six nested/overlapping runs over eight rows: five fit the
        // gutter, the sixth cannot. An unlaned wire has nowhere to go but
        // straight between its two ports, across every card between —
        // the exact drawing this work removes — so a frame that cannot
        // route them all draws none of them at rest, however few there
        // are. (Six is comfortably under INFRAME_WIRE_CAP, so this is the
        // LANE budget talking, not the flow budget.)
        const nodes = [wnode('RPT', 'dataset', 'exec'), wnode('WH', 'container', 'WAREHOUSE')]
        const contains: Array<[string, string]> = []
        const reveal = ['in:RPT']
        for (let i = 0; i < 8; i++) {
            nodes.push(wnode(`t${i}`))
            contains.push(['WH', `t${i}`])
            reveal.push(`in:t${i}`)
        }
        // A fan: t0 feeds t1..t6, each of which feeds t7. Every run
        // straddles the middle of the list, so almost none of them can
        // share a lane.
        const hops: Array<[string, string]> = [['t7', 'RPT']]
        for (let i = 1; i <= 6; i++) { hops.push(['t0', `t${i}`], [`t${i}`, 't7']) }
        const g = build('RPT', nodes, hops, contains, reveal, ['WH'])
        const frame = frameOf(g, 'WH')
        expect(frame.internalFlows).toBeLessThanOrEqual(INFRAME_WIRE_CAP)
        expect(frame.gutterLanes).toBe(MAX_LANES)
        const internal = g.edges.filter(e => e.sameAncestorFrame === frame.id)
        expect(internal.some(e => e.inFrameLane === null)).toBe(true)
        expect(internal.every(e => e.internalQuiet)).toBe(true)
        expect(frame.internalQuiet).toBe(true)
    })

    it('a chain reuses ONE lane the whole way down — adjacent runs never overlap', () => {
        const g = chainEstate(8)
        const frame = frameOf(g, 'WH')
        expect(frame.gutterLanes).toBe(1)
        expect(frame.gutterLanes).toBeLessThanOrEqual(MAX_LANES)
    })
})
