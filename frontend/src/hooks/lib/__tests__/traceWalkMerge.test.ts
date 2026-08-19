/**
 * traceWalkMerge — pure delta-merge of a closure walk model into canvas
 * store shapes, under the legacy trace-merge rules (each one a shipped-bug
 * rule from ContextViewCanvas's onTraceComplete path):
 *
 *  - spine-filtered ancestors (computeTraceMergeSpine)
 *  - only hydrated nodes become cards
 *  - lineage edges only between resolvable endpoints
 *  - containment edges NEVER re-parent an existing node
 *  - pure, idempotent, delta-only
 *
 * Plus `traceExpansionUrns`: the containment ancestors of every
 * participant — what the canvas must expand to show the flow upfront.
 */
import { describe, it, expect } from 'vitest'
import {
  computeTraceWalkDelta,
  emptyTraceWalkMergeSession,
  traceExpansionUrns,
} from '../traceWalkMerge'
import type { LensWalkModel, LensWalkNode } from '@/components/canvas/context-view/lens/closure-adapter'

const wnode = (urn: string, type = 'column', label: string = urn): LensWalkNode => ({
  id: urn,
  type: 'generic',
  position: { x: 0, y: 0 },
  data: { urn, label, type },
  urn,
  displayName: label,   // '' = unhydrated
  entityType: type,
}) as unknown as LensWalkNode

const hop = (source: string, target: string, id?: string) =>
  ({ id, sourceUrn: source, targetUrn: target, edgeType: 'TRANSFORMS' })

/** parent → child containment. */
const holds = (parent: string, child: string) => ({ sourceUrn: parent, targetUrn: child })

function model(parts: Partial<Omit<LensWalkModel, 'focusUrn'>>): LensWalkModel {
  return {
    focusUrn: 'F',
    nodes: [],
    lineageEdges: [],
    containmentEdges: [],
    upstreamUrns: new Set(),
    downstreamUrns: new Set(),
    frontierUp: [],
    frontierDown: [],
    truncated: false,
    truncationReason: null,
    seedTruncated: false,
    seedCursor: null,
    ...parts,
  }
}

// The recurring estate: focus F and platform PLAT are already on the
// canvas; the walk brings column colA inside new table T1 inside new
// platform-child P_new whose parent is the known PLAT.
const KNOWN = new Set(['F', 'PLAT'])
const estate = () => model({
  nodes: [wnode('F', 'dataset'), wnode('colA'), wnode('T1', 'dataset'), wnode('P_new', 'container')],
  lineageEdges: [hop('colA', 'F', 'e1')],
  containmentEdges: [holds('T1', 'colA'), holds('P_new', 'T1'), holds('PLAT', 'P_new')],
  upstreamUrns: new Set(['colA']),
})

describe('computeTraceWalkDelta — merge rules', () => {
  it('merges hydrated participants and their spine, skipping known urns', () => {
    const { delta, session } = computeTraceWalkDelta({
      model: estate(), session: emptyTraceWalkMergeSession(), knownUrns: KNOWN,
    })
    expect(delta.nodes.map(n => n.id).sort()).toEqual(['P_new', 'T1', 'colA'])
    // The known anchor PLAT and the known focus F are never re-added.
    expect(delta.nodes.some(n => n.id === 'F' || n.id === 'PLAT')).toBe(false)
    // Lineage edge colA→F resolves (new → known); containment chains down
    // to every newly-merged node, including from the known anchor.
    expect(delta.edges.map(e => e.id).sort()).toEqual(['e1', 'twc:PLAT>P_new', 'twc:P_new>T1', 'twc:T1>colA'])
    expect(session.mergedNodeIds.has('colA')).toBe(true)
    expect(session.mergedEdgeIds.has('e1')).toBe(true)
  })

  it('drops unhydrated nodes and never emits containment edges to them', () => {
    const m = model({
      nodes: [wnode('ghost', 'column', ''), wnode('T1', 'dataset')],
      containmentEdges: [holds('T1', 'ghost')],
      upstreamUrns: new Set(['ghost']),
    })
    const { delta } = computeTraceWalkDelta({ model: m, session: emptyTraceWalkMergeSession(), knownUrns: KNOWN })
    expect(delta.nodes.some(n => n.id === 'ghost')).toBe(false)
    expect(delta.edges.some(e => e.target === 'ghost')).toBe(false)
  })

  it('never re-parents: a containment edge to an already-known target is dropped', () => {
    const m = model({
      nodes: [wnode('ALIEN', 'container')],
      containmentEdges: [holds('ALIEN', 'F')],
      upstreamUrns: new Set(['ALIEN']),
    })
    const { delta } = computeTraceWalkDelta({ model: m, session: emptyTraceWalkMergeSession(), knownUrns: KNOWN })
    expect(delta.edges.some(e => e.target === 'F')).toBe(false)
  })

  it('drops a lineage edge whose endpoint is neither known nor merged', () => {
    const m = model({
      nodes: [wnode('colA')],
      lineageEdges: [hop('nowhere', 'colA', 'e2')],
      upstreamUrns: new Set(['colA']),
    })
    const { delta } = computeTraceWalkDelta({ model: m, session: emptyTraceWalkMergeSession(), knownUrns: KNOWN })
    expect(delta.edges.some(e => e.id === 'e2')).toBe(false)
  })

  it('is idempotent: the same model twice yields an empty delta', () => {
    const first = computeTraceWalkDelta({ model: estate(), session: emptyTraceWalkMergeSession(), knownUrns: KNOWN })
    const second = computeTraceWalkDelta({ model: estate(), session: first.session, knownUrns: KNOWN })
    expect(second.delta.nodes).toHaveLength(0)
    expect(second.delta.edges).toHaveLength(0)
    expect(second.session.mergedNodeIds.size).toBe(first.session.mergedNodeIds.size)
  })

  it('delta-merges a grown model; previously-merged endpoints resolve', () => {
    const first = computeTraceWalkDelta({ model: estate(), session: emptyTraceWalkMergeSession(), knownUrns: KNOWN })
    const grown = model({
      ...estate(),
      nodes: [...estate().nodes, wnode('colB')],
      lineageEdges: [...estate().lineageEdges, hop('colB', 'colA', 'e3')],
      upstreamUrns: new Set(['colA', 'colB']),
    })
    const { delta } = computeTraceWalkDelta({ model: grown, session: first.session, knownUrns: KNOWN })
    expect(delta.nodes.map(n => n.id)).toEqual(['colB'])
    // colA is not in knownUrns (the store may not have re-rendered into the
    // caller's snapshot yet) but IS in the session — the edge must resolve.
    expect(delta.edges.map(e => e.id)).toEqual(['e3'])
  })

  it('a participant whose chain reaches no known anchor still merges (layer assignment decides rendering)', () => {
    const m = model({
      nodes: [wnode('lost'), wnode('LOST_ROOT', 'container')],
      containmentEdges: [holds('LOST_ROOT', 'lost')],
      upstreamUrns: new Set(['lost']),
    })
    const { delta } = computeTraceWalkDelta({ model: m, session: emptyTraceWalkMergeSession(), knownUrns: KNOWN })
    expect(delta.nodes.map(n => n.id).sort()).toEqual(['LOST_ROOT', 'lost'])
  })
})

describe('traceExpansionUrns', () => {
  // 2026-08-19 FINAL RULING (third same-day iteration — the trace is a
  // FILTER, not an explosion): every lineage-relevant CARD becomes
  // visible and stays CLOSED; the user drills. A participant's card is
  // itself when it holds children, or its immediate parent when it is a
  // LEAF (a column reads as its table's rolled-up wire, not as an open
  // row). Expansion therefore covers the ancestors STRICTLY ABOVE each
  // card — enough to reveal it, never its interior. The edge projection
  // rolls leaf hops up to the closed cards (useEdgeProjection), so the
  // flow still reads end to end.
  it('reveals every participant CARD closed: only ancestors above the cards expand', () => {
    // c1 (leaf in T under P) is traced; c2 (leaf in T2) feeds it; far
    // (leaf in TFAR) is two hops away. Cards: T, T2, TFAR — all closed;
    // only P (above T) must expand to reveal them.
    const m = model({
      nodes: [wnode('c1'), wnode('c2'), wnode('far'), wnode('T', 'dataset'), wnode('P', 'container'), wnode('T2', 'dataset'), wnode('TFAR', 'dataset')],
      lineageEdges: [hop('c2', 'c1', 'e1'), hop('far', 'c2', 'e2')],
      containmentEdges: [holds('P', 'T'), holds('T', 'c1'), holds('T2', 'c2'), holds('TFAR', 'far')],
    })
    expect([...traceExpansionUrns(m, 'c1')].sort()).toEqual(['P'])
  })

  it('a TABLE focus whose COLUMNS carry the hops: tables are closed cards, wires roll up', () => {
    const m = model({
      nodes: [wnode('TBL', 'dataset'), wnode('c1'), wnode('c2'), wnode('T2', 'dataset'), wnode('P', 'container')],
      lineageEdges: [hop('c2', 'c1', 'e1')],
      containmentEdges: [holds('P', 'TBL'), holds('TBL', 'c1'), holds('T2', 'c2')],
    })
    // TBL's card = itself (has children) → P above it expands; T2's card
    // = itself (holds c2) → nothing above. Neither TBL nor T2 opens.
    expect([...traceExpansionUrns(m, 'TBL')].sort()).toEqual(['P'])
  })

  it('a container-grain participant (manual estates) is revealed the same way', () => {
    // Authored flow at layer grain: L1 → L2, both under platform PM.
    const m = model({
      nodes: [wnode('L1', 'layer'), wnode('L2', 'layer'), wnode('PM', 'container'), wnode('x1'), wnode('x2')],
      lineageEdges: [hop('L1', 'L2', 'e1')],
      containmentEdges: [holds('PM', 'L1'), holds('PM', 'L2'), holds('L1', 'x1'), holds('L2', 'x2')],
    })
    expect([...traceExpansionUrns(m, 'L1')].sort()).toEqual(['PM'])
  })

  it('is cycle-safe', () => {
    const cyclic = model({
      nodes: [wnode('a'), wnode('b')],
      lineageEdges: [hop('b', 'a', 'e1')],
      containmentEdges: [holds('a', 'b'), holds('b', 'a')],
    })
    // Terminates; the chain walk simply contributes what it saw.
    expect([...traceExpansionUrns(cyclic, 'a')].sort()).toEqual(['a', 'b'])
  })
})

describe('performance gates', () => {
  it('a 1,000-node model delta computes in ≤ 50ms', () => {
    // 100 tables × 10 columns, columns chained table-to-table.
    const nodes: LensWalkNode[] = []
    const containment: Array<{ sourceUrn: string; targetUrn: string }> = []
    const lineage: Array<{ id: string; sourceUrn: string; targetUrn: string; edgeType: string }> = []
    for (let t = 0; t < 100; t++) {
      nodes.push(wnode(`T${t}`, 'dataset'))
      containment.push(holds('PLAT', `T${t}`))
      for (let c = 0; c < 10; c++) {
        const urn = `T${t}:c${c}`
        nodes.push(wnode(urn))
        containment.push(holds(`T${t}`, urn))
        if (t > 0) lineage.push(hop(`T${t - 1}:c${c}`, urn, `e:${t}:${c}`) as ReturnType<typeof hop> & { id: string })
      }
    }
    const m = model({
      nodes,
      lineageEdges: lineage,
      containmentEdges: containment,
      upstreamUrns: new Set(nodes.map(n => n.urn)),
    })
    const t0 = performance.now()
    const { delta } = computeTraceWalkDelta({ model: m, session: emptyTraceWalkMergeSession(), knownUrns: KNOWN })
    const elapsed = performance.now() - t0
    expect(delta.nodes.length).toBe(1100)
    expect(elapsed).toBeLessThanOrEqual(50)
  })
})
