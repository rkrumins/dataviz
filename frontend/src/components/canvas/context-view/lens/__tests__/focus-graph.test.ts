/**
 * focus-graph — pure graph-builder semantics for the Lens's Graph mode.
 *
 * Everything the interactive graph promises is asserted here against
 * the framework-free builder: parent rollup grouping, coarser-grain
 * demotion, group expansion (lineage-participating children only),
 * aggregate drilling with honest remainders, cycle-safe frontier hop
 * expansion, band caps with overflow cards, dim-don't-drop filtering,
 * and deterministic band layout.
 */
import { describe, it, expect } from 'vitest'
import type { LineageNode, LineageEdge } from '@/store/canvas'
import { deriveNeighborRecords } from '@/lib/lineage-neighbors'
import {
  buildFocusGraph,
  labelOf,
  GRAPH_BAND_CAP,
  CONTAINS_CAP,
  CARD_W,
  BAND_GAP,
  FOCAL_H,
  GROUP_HEADER_H,
  CONSTITUENT_H,
  type FocusGraphInput,
} from '../focus-graph'

const node = (id: string, type = 'dataset'): LineageNode => ({
  id,
  type: 'custom',
  position: { x: 0, y: 0 },
  data: { label: `label-${id}`, type, urn: id },
} as unknown as LineageNode)

const edge = (id: string, source: string, target: string, data: Record<string, unknown> = {}): LineageEdge => ({
  id, source, target, data: { edgeType: 'FLOWS_TO', ...data },
} as unknown as LineageEdge)

const contains = (id: string, parent: string, child: string): LineageEdge =>
  edge(id, parent, child, { edgeType: 'CONTAINS' })

const CONTAINMENT = ['CONTAINS']

/** Builds a FocusGraphInput the same way the Lens wires the builder:
 *  records derived from the focal's incident edges, parents resolved
 *  from containment edges, containment children from the endpoint set. */
function build(opts: {
  focal?: string
  nodes: LineageNode[]
  edges: LineageEdge[]
  isCoarser?: (t: string | undefined, base: string) => boolean
  over?: Partial<FocusGraphInput>
}) {
  const focalId = opts.focal ?? 'F'
  const nodeMap = new Map(opts.nodes.map(n => [n.id, n]))
  const edgesByEndpoint = new Map<string, LineageEdge[]>()
  for (const e of opts.edges) {
    for (const k of e.source === e.target ? [e.source] : [e.source, e.target]) {
      const list = edgesByEndpoint.get(k)
      if (list) list.push(e)
      else edgesByEndpoint.set(k, [e])
    }
  }
  const { incomingRecords, outgoingRecords } = deriveNeighborRecords(
    focalId, edgesByEndpoint.get(focalId) ?? [], nodeMap, CONTAINMENT,
  )
  const resolveParent = (id: string): string | null => {
    for (const e of edgesByEndpoint.get(id) ?? []) {
      if (e.target === id && e.source !== id && (e.data?.edgeType as string)?.toUpperCase() === 'CONTAINS') return e.source
    }
    return (nodeMap.get(id)?.data?.parentId as string | undefined) ?? null
  }
  const containsChildren: string[] = []
  for (const e of edgesByEndpoint.get(focalId) ?? []) {
    if (e.source === focalId && (e.data?.edgeType as string)?.toUpperCase() === 'CONTAINS') containsChildren.push(e.target)
  }
  const input: FocusGraphInput = {
    focalId,
    incomingRecords,
    outgoingRecords,
    edgesByEndpoint,
    nodeMap,
    containmentEdgeTypes: CONTAINMENT,
    containsChildren,
    resolveParent,
    isCoarser: opts.isCoarser ?? (() => false),
    expandedGroups: new Set(),
    expandedFrontier: new Set(),
    drilledRows: new Set(),
    rawEdgeById: new Map(opts.edges.map(e => [e.id, e])),
    bandPages: new Map(),
    query: '',
    hiddenTypes: new Set(),
    ...opts.over,
  }
  return buildFocusGraph(input)
}

const card = (g: ReturnType<typeof build>, id: string) => {
  const c = g.cards.find(c => c.id === id)
  if (!c) throw new Error(`card ${id} not found in [${g.cards.map(c => c.id).join(', ')}]`)
  return c
}

describe('buildFocusGraph — grouping and rollups', () => {
  it('collapses ≥2 same-parent neighbors into one group card with a bundled edge', () => {
    const g = build({
      nodes: [node('F'), node('f1', 'schemaField'), node('f2', 'schemaField'), node('PD'), node('s1', 'schemaField'), node('PS')],
      edges: [
        edge('e1', 'f1', 'F'), edge('e2', 'f2', 'F'), edge('e3', 's1', 'F'),
        contains('c1', 'PD', 'f1'), contains('c2', 'PD', 'f2'), contains('c3', 'PS', 's1'),
      ],
    })
    const group = card(g, 'g:in:PD')
    expect(group.kind).toBe('group')
    expect(group.count).toBe(2)        // members
    expect(group.sumCount).toBe(2)     // Σ connections
    expect(group.expanded).toBe(false)
    // Members hidden while collapsed; the singleton stays standalone
    // with its parent as context (grouping one child adds a click for
    // nothing).
    expect(g.cards.find(c => c.id === 'n:f1')).toBeUndefined()
    const single = card(g, 'n:s1')
    expect(single.parentId).toBe('PS')
    expect(single.parentLabel).toBe('label-PS')
    // One bundled edge group → focal; one edge singleton → focal.
    expect(g.edges.find(e => e.id === 'fe:g:in:PD->f')?.count).toBe(2)
    expect(g.edges.find(e => e.id === 'fe:n:s1->f')).toBeTruthy()
  })

  it('demotes a coarser-grain partner to a standalone rollup card — never grouped', () => {
    const g = build({
      nodes: [node('F'), node('C', 'CONTAINER'), node('C2', 'CONTAINER'), node('P')],
      edges: [
        edge('e1', 'C', 'F'), edge('e2', 'C2', 'F'),
        // Both coarser partners share a parent — they must STILL not group.
        contains('c1', 'P', 'C'), contains('c2', 'P', 'C2'),
      ],
      isCoarser: (t) => t === 'CONTAINER',
    })
    expect(g.cards.find(c => c.id === 'g:in:P')).toBeUndefined()
    expect(card(g, 'n:C').rollup).toBe(true)
    expect(card(g, 'n:C2').rollup).toBe(true)
    // A rollup is demoted, but NOT a dead end — it stays expandable.
    expect(card(g, 'n:C').frontier).toBe(true)
  })

  it('a rolled-up connection expands via DRILL into the children carrying lineage to the focal', () => {
    // A platform-grain partner reached by an aggregated edge: the card
    // must offer drill (its constituents), not a next-hop fetch.
    const agg = edge('agg1', 'Snowflake', 'F', {
      isAggregated: true, sourceEdgeCount: 2, sourceEdges: ['r1', 'r2'],
    })
    // The constituent connects a DESCENDANT of the focal, as real
    // aggregated edges do — so it is not itself a direct neighbour.
    const collapsed = build({
      nodes: [node('F'), node('Snowflake', 'DATAPLATFORM'), node('kid1', 'dataset')],
      edges: [agg, edge('r1', 'kid1', 'F_field')],
      isCoarser: (t) => t === 'DATAPLATFORM',
    })
    const rollup = card(collapsed, 'n:Snowflake')
    expect(rollup.rollup).toBe(true)
    expect(rollup.expandKind).toBe('drill')
    expect(rollup.frontier).toBe(true)          // offers the expand pill
    expect(rollup.frontierExpanded).toBe(false) // not yet opened
    // Children stay hidden until it's expanded.
    expect(collapsed.cards.find(c => c.nodeId === 'kid1')).toBeUndefined()

    const opened = build({
      nodes: [node('F'), node('Snowflake', 'DATAPLATFORM'), node('kid1', 'dataset'), node('kid2', 'dataset')],
      edges: [agg, edge('r1', 'kid1', 'F_field')],
      isCoarser: (t) => t === 'DATAPLATFORM',
      over: {
        drilledRows: new Set(['g:in:agg1']),
        drillEdges: new Map([['agg1', [edge('r2', 'kid2', 'F_field')]]]),
      },
    })
    const openedRollup = card(opened, 'n:Snowflake')
    expect(openedRollup.frontierExpanded).toBe(true)
    // Exactly the constituents that carry lineage to the focal — the
    // locally-known one plus the fetched one, no other platform content.
    expect(card(opened, 'x:agg1:kid1').nodeId).toBe('kid1')
    expect(card(opened, 'x:agg1:kid2').nodeId).toBe('kid2')
  })

  it('a plain entity expands via HOP; a known-zero degree offers nothing', () => {
    const g = build({
      nodes: [node('F'), node('U'), node('Z')],
      edges: [edge('e1', 'U', 'F'), edge('e2', 'Z', 'F')],
      over: { degreeHints: new Map([['Z', { in: 0, out: 4 }]]) },
    })
    expect(card(g, 'n:U').expandKind).toBe('hop')
    // Z's KNOWN upstream degree is zero — nothing to fetch, no pill.
    expect(card(g, 'n:Z').expandKind).toBeNull()
    expect(card(g, 'n:Z').frontier).toBe(false)
  })

  it('expands a group into a slim header plus exactly the lineage-participating members', () => {
    const g = build({
      nodes: [node('F'), node('f1', 'schemaField'), node('f2', 'schemaField'), node('PD')],
      edges: [
        edge('e1', 'f1', 'F'), edge('e2', 'f2', 'F'),
        contains('c1', 'PD', 'f1'), contains('c2', 'PD', 'f2'),
        // PD also contains f3 — but f3 has NO lineage to F, so it must
        // not appear when the group expands.
        contains('c3', 'PD', 'f3'),
      ],
      over: { expandedGroups: new Set(['in:PD']) },
    })
    const header = card(g, 'g:in:PD')
    expect(header.expanded).toBe(true)
    expect(header.h).toBe(GROUP_HEADER_H)
    expect(card(g, 'n:f1')).toBeTruthy()
    expect(card(g, 'n:f2')).toBeTruthy()
    expect(g.cards.find(c => c.id === 'n:f3')).toBeUndefined()
    // Members carry their own edges; the bundled group edge is gone.
    expect(g.edges.find(e => e.id === 'fe:n:f1->f')).toBeTruthy()
    expect(g.edges.find(e => e.id === 'fe:g:in:PD->f')).toBeUndefined()
  })
})

describe('buildFocusGraph — aggregate drill', () => {
  it('drills an aggregate into constituent cards and reports the unloaded remainder', () => {
    const agg = edge('agg1', 'P', 'F', { isAggregated: true, sourceEdgeCount: 3, sourceEdges: ['r1', 'r2', 'r3'] })
    const r1 = edge('r1', 'p1', 'F')
    const g = build({
      nodes: [node('F'), node('P'), node('p1', 'schemaField'), node('p2', 'schemaField')],
      edges: [agg, r1],
      over: {
        drilledRows: new Set(['g:in:agg1']),
        drillEdges: new Map([['agg1', [edge('r2', 'p2', 'F')]]]),
      },
    })
    const drilled = card(g, 'n:P')
    expect(drilled.count).toBe(3)              // ×N from sourceEdgeCount
    expect(drilled.drillKey).toBe('g:in:agg1')
    expect(drilled.missingConstituents).toBe(1) // r3 not loaded — reported
    const c1 = card(g, 'x:agg1:p1')
    expect(c1.h).toBe(CONSTITUENT_H)
    expect(c1.parentLabel).toBe('label-P')
    expect(card(g, 'x:agg1:p2')).toBeTruthy()
    // Constituents tether to the drilled card, flowing toward it.
    expect(g.edges.find(e => e.source === 'x:agg1:p1' && e.target === 'n:P')).toBeTruthy()
  })
})

describe('buildFocusGraph — frontier hop expansion', () => {
  it('places an expanded frontier node\'s neighbors at the next band out', () => {
    const g = build({
      nodes: [node('F'), node('B'), node('C')],
      edges: [edge('e1', 'F', 'B'), edge('e2', 'B', 'C')],
      over: { expandedFrontier: new Set(['out:B']) },
    })
    const b = card(g, 'n:B')
    expect(b.band).toBe(1)
    expect(b.frontierExpanded).toBe(true)
    const c = card(g, 'n:C')
    expect(c.band).toBe(2)
    expect(c.x).toBe(2 * (CARD_W + BAND_GAP))
    expect(g.edges.find(e => e.id === 'fe:n:B->n:C')).toBeTruthy()
  })

  it('never places a node twice — a cycle adds an edge to the existing card', () => {
    const g = build({
      nodes: [node('F'), node('B')],
      edges: [edge('e1', 'F', 'B'), edge('e2', 'B', 'F')],
      over: { expandedFrontier: new Set(['out:B']) },
    })
    // B's downstream is F itself — already placed as the focal card.
    expect(g.cards.filter(c => c.nodeId === 'F')).toHaveLength(1)
    expect(g.cards.filter(c => c.nodeId === 'B')).toHaveLength(1)
    expect(g.edges.find(e => e.id === 'fe:n:B->f')).toBeTruthy()
  })

  it('marks a completed-empty expansion as a dead end — never a silent no-op', () => {
    const build2 = (fetchState: 'done' | 'loading') => build({
      nodes: [node('F'), node('B')],
      edges: [edge('e1', 'F', 'B')],
      over: {
        expandedFrontier: new Set(['out:B']),
        fetchStatus: new Map([['B', fetchState]]),
      },
    })
    const done = build2('done')
    const b = done.cards.find(c => c.id === 'n:B')!
    expect(b.deadEnd).toBe(true)      // fetch completed, nothing further
    expect(b.frontier).toBe(false)
    // An in-flight fetch is NOT a dead end (it's a claim about the
    // data source, so it needs a completed fetch behind it).
    expect(build2('loading').cards.find(c => c.id === 'n:B')!.deadEnd).toBe(false)
  })

  it('a cycle-only contribution is not a dead end', () => {
    const g = build({
      nodes: [node('F'), node('B')],
      edges: [edge('e1', 'F', 'B'), edge('e2', 'B', 'F')],
      over: {
        expandedFrontier: new Set(['out:B']),
        fetchStatus: new Map([['B', 'done' as const]]),
      },
    })
    // B's downstream exists (it's F) — the walk loops, it doesn't end.
    expect(g.cards.find(c => c.id === 'n:B')!.deadEnd).toBe(false)
  })
})

describe('buildFocusGraph — caps, chips, filter', () => {
  const manyPartners = (n: number) => {
    const nodes = [node('F')]
    const edges_: LineageEdge[] = []
    for (let i = 0; i < n; i++) {
      const id = `u${String(i).padStart(3, '0')}`
      nodes.push(node(id))
      edges_.push(edge(`e${i}`, id, 'F'))
    }
    return { nodes, edges: edges_ }
  }

  it('caps a band with an explicit overflow card and honest totals; paging raises the cap', () => {
    const { nodes, edges: es } = manyPartners(GRAPH_BAND_CAP + 5)
    const g = build({ nodes, edges: es })
    const overflow = card(g, 'more:in:1')
    expect(overflow.overflowCount).toBe(5)
    expect(g.bandTotals.get('in:1')).toEqual({ shown: GRAPH_BAND_CAP, total: GRAPH_BAND_CAP + 5 })

    const paged = build({ nodes, edges: es, over: { bandPages: new Map([['in:1', 1]]) } })
    expect(paged.cards.find(c => c.id === 'more:in:1')).toBeUndefined()
    expect(paged.bandTotals.get('in:1')).toEqual({ shown: GRAPH_BAND_CAP + 5, total: GRAPH_BAND_CAP + 5 })
  })

  it('type chips REMOVE cards but report the hidden count', () => {
    const g = build({
      nodes: [node('F'), node('A', 'tableau'), node('B', 'dataset')],
      edges: [edge('e1', 'A', 'F'), edge('e2', 'B', 'F')],
      over: { hiddenTypes: new Set(['tableau']) },
    })
    expect(g.cards.find(c => c.id === 'n:A')).toBeUndefined()
    expect(card(g, 'n:B')).toBeTruthy()
    expect(g.hiddenByChips).toBe(1)
  })

  it('the text filter DIMS misses and counts matches inside collapsed groups — never removes', () => {
    const g = build({
      nodes: [node('F'), node('alpha'), node('beta'), node('m-alpha', 'schemaField'), node('m-beta', 'schemaField'), node('PD')],
      edges: [
        edge('e1', 'alpha', 'F'), edge('e2', 'beta', 'F'),
        edge('e3', 'm-alpha', 'F'), edge('e4', 'm-beta', 'F'),
        contains('c1', 'PD', 'm-alpha'), contains('c2', 'PD', 'm-beta'),
      ],
      over: { query: 'alpha' },
    })
    expect(card(g, 'n:alpha').dimmed).toBe(false)
    expect(card(g, 'n:beta').dimmed).toBe(true)          // dimmed, present
    const group = card(g, 'g:in:PD')
    expect(group.dimmed).toBe(false)                      // holds a match
    expect(group.matchesInside).toBe(1)                   // m-alpha
  })

  it('caps the contains stack with an overflow card honoring childCount', () => {
    const nodes = [node('F')]
    const edges_: LineageEdge[] = []
    for (let i = 0; i < CONTAINS_CAP + 2; i++) {
      const id = `k${i}`
      nodes.push(node(id))
      edges_.push(contains(`c${i}`, 'F', id))
    }
    const g = build({ nodes, edges: edges_, over: { containsTotal: CONTAINS_CAP + 4 } })
    expect(g.cards.filter(c => c.kind === 'contains')).toHaveLength(CONTAINS_CAP)
    expect(card(g, 'more:contains').overflowCount).toBe(4)  // childCount wins
  })
})

describe('buildFocusGraph — layout and determinism', () => {
  it('bakes deterministic band positions centered on the focal midline', () => {
    const g = build({
      nodes: [node('F'), node('U'), node('D')],
      edges: [edge('e1', 'U', 'F'), edge('e2', 'F', 'D')],
    })
    const f = card(g, 'f')
    expect(f.x).toBe(0)
    expect(f.y).toBe(-FOCAL_H / 2)              // focal center = y 0
    expect(card(g, 'n:U').x).toBe(-(CARD_W + BAND_GAP))
    expect(card(g, 'n:D').x).toBe(CARD_W + BAND_GAP)
    expect(labelOf('U', undefined)).toBe('U')   // URN fallback chain
  })

  it('identical input produces identical output', () => {
    const opts = {
      nodes: [node('F'), node('a'), node('b'), node('c', 'schemaField'), node('d', 'schemaField'), node('P')],
      edges: [
        edge('e1', 'a', 'F'), edge('e2', 'F', 'b'),
        edge('e3', 'c', 'F'), edge('e4', 'd', 'F'),
        contains('c1', 'P', 'c'), contains('c2', 'P', 'd'),
      ],
    }
    expect(build(opts)).toEqual(build(opts))
  })
})
