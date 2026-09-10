/**
 * WHAT A TRACE WIRE IS MADE OF — the types it carries.
 *
 * The Connections panel is one control for browse and trace, so mid-trace it
 * has to list the trace's own connection types. The ledger said nothing
 * about type until now: the panel counted the wires and listed no rows.
 *
 * The rule, in three parts:
 *  - a RAW wire carries every distinct type of the hops it bundles, in
 *    first-seen order (`edgeTypeNorm` stays the lossy single-type field the
 *    layout draws by, and still blanks on a mixed bundle);
 *  - a ROLLUP/RESIDUAL wire carries the types of the cells authored at its
 *    pair — the accounting collapses several cells into one statement, and
 *    the types collapse with them;
 *  - a hop that names no type contributes nothing. An empty list is the
 *    honest answer; a fabricated name would put a row in the panel that the
 *    graph never said.
 */
import { describe, it, expect } from 'vitest'
import { buildLedger, buildTraceWires, type TraceWire } from '../traceWireLedger'
import {
  buildLensSubgraph,
  projectLensEdges,
  type LensEdgeLike,
} from '@/components/canvas/context-view/lens/lens-subgraph'
import type { LensWalkModel, LensWalkNode } from '@/components/canvas/context-view/lens/closure-adapter'

const wn = (urn: string): LensWalkNode => ({
  id: urn, type: 'default', position: { x: 0, y: 0 },
  data: { urn, label: urn, type: 'Node' }, urn, displayName: urn, entityType: 'Node',
}) as unknown as LensWalkNode

const hop = (i: number, s: string, t: string, edgeType?: string): LensEdgeLike => ({
  id: `r${i}:${s}>${t}`, sourceUrn: s, targetUrn: t, kind: 'raw', weight: null,
  ...(edgeType === undefined ? {} : { edgeType }),
})
const cell = (s: string, t: string, weight: number, edgeType = 'AGGREGATED'): LensEdgeLike => ({
  id: `agg:${s}>${t}:${edgeType}`, sourceUrn: s, targetUrn: t, edgeType, kind: 'rollup', weight,
})
const has = (parent: string, child: string) => ({ sourceUrn: parent, targetUrn: child })

function estate(
  urns: string[],
  lineageEdges: LensEdgeLike[],
  containmentEdges: Array<{ sourceUrn: string; targetUrn: string }> = [],
): LensWalkModel {
  return {
    focusUrn: urns[0],
    nodes: urns.map(wn),
    lineageEdges,
    containmentEdges,
    upstreamUrns: new Set(), downstreamUrns: new Set(),
    coarseUpstreamUrns: new Set(), coarseDownstreamUrns: new Set(),
    frontierUp: [], frontierDown: [], truncated: false, truncationReason: null,
    seedTruncated: false, seedCursor: null,
  }
}

/** The subgraph exactly as `buildTraceView` builds it: RAW edges only, so
 *  the ledger and the projection count the same hops. */
const subgraphOf = (m: LensWalkModel) =>
  buildLensSubgraph<LensWalkNode>({
    focusUrn: m.focusUrn,
    nodes: m.nodes,
    lineageEdges: m.lineageEdges.filter(e => e.kind !== 'rollup'),
    containmentEdges: m.containmentEdges,
  })

function wiresOf(m: LensWalkModel, visible: string[]): TraceWire[] {
  const sg = subgraphOf(m)
  return buildTraceWires({
    sg, model: m, visible: new Set(visible),
    ledger: buildLedger(m, undefined, sg.lineageEdges),
  })
}

const wireAt = (wires: TraceWire[], source: string, target: string): TraceWire => {
  const hit = wires.find(w => w.source === source && w.target === target)
  expect(hit).toBeDefined()
  return hit!
}

describe('a trace wire carries the types it is made of', () => {
  it('a raw wire carries the distinct types of the hops it bundles', () => {
    // Two columns feeding two columns, their tables collapsed: ONE wire.
    const m = estate(
      ['A', 'a1', 'a2', 'B', 'b1', 'b2'],
      [hop(1, 'a1', 'b1', 'FLOWS_TO'), hop(2, 'a2', 'b2', 'FLOWS_TO')],
      [has('A', 'a1'), has('A', 'a2'), has('B', 'b1'), has('B', 'b2')],
    )
    const w = wireAt(wiresOf(m, ['A', 'B']), 'A', 'B')
    expect(w.kind).toBe('raw')
    expect(w.edgeCount).toBe(2)
    // Distinct, not one entry per hop.
    expect(w.types).toEqual(['FLOWS_TO'])
  })

  it('a wire bundling two types carries both, while edgeTypeNorm still blanks', () => {
    const m = estate('XY'.split('').map(String), [
      hop(1, 'X', 'Y', 'FLOWS_TO'),
      hop(2, 'X', 'Y', 'COPIES'),
    ])
    const sg = subgraphOf(m)
    const all = new Set(['X', 'Y'])
    const [bundle] = projectLensEdges(sg, all, all)
    // The layout's single-type field is unchanged: it still cannot name a
    // mixed bundle, which is exactly why the panel needs its own list.
    expect(bundle.edgeTypeNorm).toBe('')
    expect(bundle.edgeTypes).toEqual(['FLOWS_TO', 'COPIES'])

    const w = wireAt(wiresOf(m, ['X', 'Y']), 'X', 'Y')
    expect(w.edgeCount).toBe(2)
    expect([...w.types].sort()).toEqual(['COPIES', 'FLOWS_TO'])
  })

  it('a rollup wire carries the types of the cells at its pair', () => {
    // No raw evidence under the pair, so the cells draw whole — and two
    // cells at one pair are one statement, carrying both their types.
    const m = estate(
      ['P', 'Q'],
      [cell('P', 'Q', 30, 'AGGREGATED'), cell('P', 'Q', 5, 'SUMMARISES')],
    )
    const w = wireAt(wiresOf(m, ['P', 'Q']), 'P', 'Q')
    expect(w.kind).toBe('rollup')
    expect(w.edgeCount).toBe(35)
    expect([...w.types].sort()).toEqual(['AGGREGATED', 'SUMMARISES'])
  })

  it('a wire whose hops name no type carries an empty list, never a fabricated one', () => {
    const m = estate(['S', 'T'], [hop(1, 'S', 'T')])
    const w = wireAt(wiresOf(m, ['S', 'T']), 'S', 'T')
    expect(w.kind).toBe('raw')
    expect(w.types).toEqual([])
  })
})
