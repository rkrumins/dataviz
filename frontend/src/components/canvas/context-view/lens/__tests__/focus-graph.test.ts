/**
 * focus-graph — pure graph-builder semantics for the Lens's Graph mode.
 *
 * Everything the interactive graph promises is asserted here against
 * the framework-free builder: parent rollup grouping, coarser-grain
 * demotion, group expansion (lineage-participating children only),
 * opening a coarse container into only its focal-relevant children,
 * cycle-safe frontier hop expansion, band caps with overflow cards,
 * dim-don't-drop filtering, and deterministic band layout.
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
  FRAME_CHILD_CAP,
  FRAME_ALL_CAP,
  CARD_H,
  CHILD_ROW_H,
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
    openContainers: new Set(),
    entityLevels: new Map([['CONTAINER', 2], ['DATAPLATFORM', 1], ['dataset', 3], ['schemaField', 4]]),
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

  it('a coarse partner offers OPEN — without needing any isAggregated flag', () => {
    // The old predicate keyed off edge.data.isAggregated, which projected
    // canvas edges do not carry; coarse cards silently became hop cards
    // and fetched their whole neighbourhood. Grain alone must decide.
    const g = build({
      nodes: [node('F'), node('Snowflake', 'DATAPLATFORM')],
      edges: [edge('e1', 'Snowflake', 'F')],
      isCoarser: (t) => t === 'DATAPLATFORM',
    })
    const rollup = card(g, 'n:Snowflake')
    expect(rollup.rollup).toBe(true)
    expect(rollup.expandKind).toBe('open')
    expect(rollup.expandKey).toBe('in:Snowflake')
    expect(rollup.frontier).toBe(true)
    // Nothing inside is shown until it is opened.
    expect(g.cards.some(c => c.kind === 'frame')).toBe(false)
  })

  it('declines to offer OPEN when the ontology has not leveled the type', () => {
    // Without a level we cannot ask the server for the next grain down,
    // and guessing would query the wrong thing.
    const g = build({
      nodes: [node('F'), node('Mystery', 'UNLEVELED')],
      edges: [edge('e1', 'Mystery', 'F')],
      isCoarser: (t) => t === 'UNLEVELED',
      over: { entityLevels: new Map() },
    })
    expect(card(g, 'n:Mystery').expandKind).not.toBe('open')
  })

  it('opening a container renders a FRAME holding only the focal-relevant children', () => {
    const g = build({
      nodes: [node('F'), node('Snowflake', 'DATAPLATFORM')],
      edges: [edge('e1', 'Snowflake', 'F')],
      isCoarser: (t) => t === 'DATAPLATFORM',
      over: {
        openContainers: new Set(['in:Snowflake']),
        containerResults: new Map([['in:Snowflake', {
          nodes: [node('kid1'), node('kid2')],
          edges: [edge('r1', 'kid1', 'F'), edge('r2', 'kid2', 'F')],
          passedThrough: [node('mid', 'CONTAINER')],
          truncated: false,
          empty: false,
        }]]),
        containerStatus: new Map([['in:Snowflake', 'done' as const]]),
      },
    })
    const frame = card(g, 'fr:in:Snowflake')
    expect(frame.kind).toBe('frame')
    expect(frame.count).toBe(2)
    // A skipped pass-through level is shown, never hidden.
    expect(frame.frameBreadcrumb).toEqual(['label-mid'])

    // Children are FIRST-CLASS: real ids, own expand affordance, own
    // edges to what the container connected to.
    const kid = card(g, 'n:kid1')
    expect(kid.frameId).toBe('fr:in:Snowflake')
    expect(kid.expandKind).toBe('hop')
    expect(kid.frontier).toBe(true)
    expect(g.edges.find(e => e.id === 'fe:n:kid1->f')).toBeTruthy()
    // The collapsed rollup card is replaced by the frame.
    expect(g.cards.find(c => c.id === 'n:Snowflake')).toBeUndefined()
    // The frame encloses its children.
    for (const k of [card(g, 'n:kid1'), card(g, 'n:kid2')]) {
      expect(k.x).toBeGreaterThanOrEqual(frame.x)
      expect(k.y).toBeGreaterThanOrEqual(frame.y)
      expect(k.y + k.h).toBeLessThanOrEqual(frame.y + frame.h)
    }
  })

  it('an empty open says so instead of rendering unrelated children', () => {
    const g = build({
      nodes: [node('F'), node('Snowflake', 'DATAPLATFORM')],
      edges: [edge('e1', 'Snowflake', 'F')],
      isCoarser: (t) => t === 'DATAPLATFORM',
      over: {
        openContainers: new Set(['in:Snowflake']),
        containerResults: new Map([['in:Snowflake', {
          nodes: [], edges: [], passedThrough: [], truncated: false, empty: true,
        }]]),
        containerStatus: new Map([['in:Snowflake', 'done' as const]]),
      },
    })
    const frame = card(g, 'fr:in:Snowflake')
    expect(frame.frameEmpty).toBe(true)
    expect(frame.count).toBe(0)
    // Empty frame keeps its own edge so it stays connected to the picture.
    expect(g.edges.find(e => e.target === 'f' && e.source === 'fr:in:Snowflake')).toBeTruthy()
  })

  it('caps children inside a frame with an overflow card, and paging raises it', () => {
    const kids = Array.from({ length: FRAME_CHILD_CAP + 3 }, (_, i) => node(`k${String(i).padStart(2, '0')}`))
    const over = {
      openContainers: new Set(['in:Snowflake']),
      containerResults: new Map([['in:Snowflake', {
        nodes: kids,
        edges: kids.map((k, i) => edge(`r${i}`, k.id, 'F')),
        passedThrough: [], truncated: false, empty: false,
      }]]),
      containerStatus: new Map([['in:Snowflake', 'done' as const]]),
    }
    const base = {
      nodes: [node('F'), node('Snowflake', 'DATAPLATFORM')],
      edges: [edge('e1', 'Snowflake', 'F')],
      isCoarser: (t?: string) => t === 'DATAPLATFORM',
    }
    const g = build({ ...base, over })
    expect(g.cards.filter(c => c.frameId === 'fr:in:Snowflake' && c.kind === 'entity')).toHaveLength(FRAME_CHILD_CAP)
    expect(card(g, 'more:fr:in:Snowflake').overflowCount).toBe(3)

    const paged = build({ ...base, over: { ...over, framePages: new Map([['in:Snowflake', 1]]) } })
    expect(paged.cards.find(c => c.id === 'more:fr:in:Snowflake')).toBeUndefined()
  })

  it('the in-frame filter dims children without removing them', () => {
    const g = build({
      nodes: [node('F'), node('Snowflake', 'DATAPLATFORM')],
      edges: [edge('e1', 'Snowflake', 'F')],
      isCoarser: (t) => t === 'DATAPLATFORM',
      over: {
        openContainers: new Set(['in:Snowflake']),
        containerResults: new Map([['in:Snowflake', {
          nodes: [node('alpha'), node('beta')],
          edges: [edge('r1', 'alpha', 'F'), edge('r2', 'beta', 'F')],
          passedThrough: [], truncated: false, empty: false,
        }]]),
        containerStatus: new Map([['in:Snowflake', 'done' as const]]),
        frameQueries: new Map([['in:Snowflake', 'alpha']]),
      },
    })
    expect(card(g, 'n:alpha').dimmed).toBe(false)
    expect(card(g, 'n:beta').dimmed).toBe(true)   // present, just dimmed
  })
})

describe('buildFocusGraph — one card per entity', () => {
  // REGRESSION: group header cards used to be pushed without registering
  // in `placed` — the only card kind that skipped the guard. So a parent
  // that was BOTH a neighbour in its own right (via the synthetic
  // AGGREGATED rollup edge to the container) and the resolved parent of
  // ≥2 other neighbours (via their raw edges) produced two cards with
  // the same label: `n:PD` and `g:in:PD`.
  it('does not draw a parent twice when it is also a neighbour', () => {
    const g = build({
      nodes: [node('F'), node('PD'), node('f1', 'schemaField'), node('f2', 'schemaField')],
      edges: [
        // The rollup edge makes the parent a neighbour of the focal...
        { ...edge('agg1', 'PD', 'F'), data: { edgeType: 'AGGREGATED', isAggregated: true, edgeCount: 2 } } as LineageEdge,
        // ...while its children carry the raw flows.
        edge('e1', 'f1', 'F'), edge('e2', 'f2', 'F'),
        contains('c1', 'PD', 'f1'), contains('c2', 'PD', 'f2'),
      ],
    })
    const forPD = g.cards.filter(c => c.nodeId === 'PD')
    expect(forPD).toHaveLength(1)
    // Its children hang off that one card rather than a second one.
    expect(g.cards.some(c => c.id === 'g:in:PD')).toBe(false)
    expect(card(g, 'n:PD')).toBeTruthy()
  })

  it('still groups children under a parent that is NOT itself a neighbour', () => {
    const g = build({
      nodes: [node('F'), node('PD'), node('f1', 'schemaField'), node('f2', 'schemaField')],
      edges: [
        edge('e1', 'f1', 'F'), edge('e2', 'f2', 'F'),
        contains('c1', 'PD', 'f1'), contains('c2', 'PD', 'f2'),
      ],
    })
    expect(card(g, 'g:in:PD').kind).toBe('group')
    expect(g.cards.some(c => c.id === 'n:PD')).toBe(false)
  })
})

describe('buildFocusGraph — a frame showing every child', () => {
  const base = {
    nodes: [node('F'), node('Snowflake', 'DATAPLATFORM')],
    edges: [edge('e1', 'Snowflake', 'F')],
    isCoarser: (t?: string) => t === 'DATAPLATFORM',
  }
  /** Two of the four children carry lineage to F. */
  const opened = {
    openContainers: new Set(['in:Snowflake']),
    containerResults: new Map([['in:Snowflake', {
      nodes: [node('b_conn'), node('d_conn')],
      edges: [edge('r1', 'b_conn', 'F'), edge('r2', 'd_conn', 'F')],
      passedThrough: [], truncated: false, empty: false,
    }]]),
    containerStatus: new Map([['in:Snowflake', 'done' as const]]),
  }

  it('holds every child in server order, marking the connected ones in place', () => {
    const g = build({
      ...base,
      over: {
        ...opened,
        frameShowAll: new Set(['in:Snowflake']),
        frameAllResults: new Map([['in:Snowflake', {
          children: [node('a_plain'), node('b_conn'), node('c_plain'), node('d_conn')],
          hasMore: false,
          total: 4,
        }]]),
        frameAllStatus: new Map([['in:Snowflake', 'done' as const]]),
      },
    })

    // Server order is preserved — connected entries are NOT hoisted.
    const kids = g.cards.filter(c => c.frameId === 'fr:in:Snowflake' && c.kind === 'entity')
    expect(kids.map(c => c.nodeId)).toEqual(['a_plain', 'b_conn', 'c_plain', 'd_conn'])

    // A child that carries lineage keeps its full card and its edge.
    const conn = card(g, 'n:b_conn')
    expect(conn.connected).toBe(true)
    expect(conn.h).toBe(CARD_H)
    expect(conn.count).toBe(1)
    expect(g.edges.find(e => e.id === 'fe:n:b_conn->f')).toBeTruthy()

    // One that doesn't is present and scannable, but claims nothing:
    // no count, no edge, no expand affordance that would come up empty.
    const plain = card(g, 'n:a_plain')
    expect(plain.connected).toBe(false)
    expect(plain.h).toBe(CHILD_ROW_H)
    expect(plain.count).toBe(0)
    expect(plain.expandKind).toBeNull()
    expect(plain.frontier).toBe(false)
    expect(g.edges.some(e => e.source === 'n:a_plain' || e.target === 'n:a_plain')).toBe(false)

    const frame = card(g, 'fr:in:Snowflake')
    expect(frame.frameShowingAll).toBe(true)
    expect(frame.frameConnectedCount).toBe(2)
    expect(frame.frameLoaded).toBe(4)
    expect(frame.frameTotal).toBe(4)
    expect(frame.frameHasMore).toBe(false)
  })

  it('shows only the connected children until the toggle is flipped', () => {
    const g = build({ ...base, over: opened })
    const kids = g.cards.filter(c => c.frameId === 'fr:in:Snowflake' && c.kind === 'entity')
    expect(kids.map(c => c.nodeId)).toEqual(['b_conn', 'd_conn'])
    expect(card(g, 'fr:in:Snowflake').frameShowingAll).toBe(false)
    expect(kids.every(c => c.connected)).toBe(true)
  })

  it('never drops a connected child missing from the children page', () => {
    // The pair-filtered open can resolve a grain deeper than direct
    // children, so the two sets are not always subset-related.
    const g = build({
      ...base,
      over: {
        ...opened,
        frameShowAll: new Set(['in:Snowflake']),
        frameAllResults: new Map([['in:Snowflake', {
          children: [node('a_plain'), node('b_conn')],
          hasMore: false,
          total: 2,
        }]]),
        frameAllStatus: new Map([['in:Snowflake', 'done' as const]]),
      },
    })
    const kids = g.cards.filter(c => c.frameId === 'fr:in:Snowflake' && c.kind === 'entity')
    // d_conn is not in the page, but it demonstrably connects — append
    // it rather than silently losing a real connection.
    expect(kids.map(c => c.nodeId)).toEqual(['a_plain', 'b_conn', 'd_conn'])
    expect(card(g, 'n:d_conn').connected).toBe(true)
  })

  it('reports an unknown total as a floor, and offers to load more', () => {
    const g = build({
      ...base,
      over: {
        ...opened,
        frameShowAll: new Set(['in:Snowflake']),
        frameAllResults: new Map([['in:Snowflake', {
          children: [node('a_plain'), node('b_conn')],
          hasMore: true,
          total: null,
        }]]),
        frameAllStatus: new Map([['in:Snowflake', 'done' as const]]),
      },
    })
    const frame = card(g, 'fr:in:Snowflake')
    expect(frame.frameTotal).toBe(-1)      // unknown, never a fabricated number
    expect(frame.frameHasMore).toBe(true)
    expect(card(g, 'more:fr:in:Snowflake').label).toBe('Load more')
  })

  it('caps a long child list and pages it', () => {
    const kids = Array.from({ length: FRAME_ALL_CAP + 5 }, (_, i) => node(`k${String(i).padStart(2, '0')}`))
    const over = {
      ...opened,
      frameShowAll: new Set(['in:Snowflake']),
      frameAllResults: new Map([['in:Snowflake', {
        children: kids, hasMore: false, total: kids.length,
      }]]),
      frameAllStatus: new Map([['in:Snowflake', 'done' as const]]),
    }
    const g = build({ ...base, over })
    // FRAME_ALL_CAP children, plus the two connected ones appended
    // because they are absent from this page.
    expect(g.cards.filter(c => c.frameId === 'fr:in:Snowflake' && c.kind === 'entity')).toHaveLength(FRAME_ALL_CAP)
    expect(card(g, 'more:fr:in:Snowflake').overflowCount).toBe(7)

    const paged = build({ ...base, over: { ...over, framePages: new Map([['in:Snowflake', 1]]) } })
    expect(paged.cards.find(c => c.id === 'more:fr:in:Snowflake')).toBeUndefined()
  })

  it('dims a filter miss across both kinds of child, never removing one', () => {
    const g = build({
      ...base,
      over: {
        ...opened,
        frameShowAll: new Set(['in:Snowflake']),
        frameAllResults: new Map([['in:Snowflake', {
          children: [node('a_plain'), node('b_conn')], hasMore: false, total: 2,
        }]]),
        frameAllStatus: new Map([['in:Snowflake', 'done' as const]]),
        frameQueries: new Map([['in:Snowflake', 'b_conn']]),
      },
    })
    expect(card(g, 'n:b_conn').dimmed).toBe(false)
    expect(card(g, 'n:a_plain').dimmed).toBe(true)
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
    expect(g.bandTotals.get('band:in:1')).toEqual({ shown: GRAPH_BAND_CAP, total: GRAPH_BAND_CAP + 5 })

    const paged = build({ nodes, edges: es, over: { bandPages: new Map([['band:in:1', 1]]) } })
    expect(paged.cards.find(c => c.id === 'more:in:1')).toBeUndefined()
    expect(paged.bandTotals.get('band:in:1')).toEqual({ shown: GRAPH_BAND_CAP + 5, total: GRAPH_BAND_CAP + 5 })
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
    // Collapsed by default: one summary card, no field cards cluttering
    // the middle of the graph.
    const g = build({ nodes, edges: edges_, over: { containsTotal: CONTAINS_CAP + 4 } })
    expect(g.cards.filter(c => c.kind === 'contains')).toHaveLength(0)
    expect(card(g, 'more:contains').label).toBe(`contains ${CONTAINS_CAP + 4}`)

    // Opening it reveals them, still capped and still honest.
    const opened = build({
      nodes, edges: edges_,
      over: { containsTotal: CONTAINS_CAP + 4, bandPages: new Map([['contains', 1]]) },
    })
    expect(opened.cards.filter(c => c.kind === 'contains')).toHaveLength(CONTAINS_CAP)
    expect(card(opened, 'more:contains').overflowCount).toBe(4)  // childCount wins
  })

  it('a group card previews a few of its members before you open it', () => {
    const g = build({
      nodes: [node('F'), node('f1', 'schemaField'), node('f2', 'schemaField'), node('PD')],
      edges: [
        edge('e1', 'f1', 'F'), edge('e2', 'f2', 'F'),
        contains('c1', 'PD', 'f1'), contains('c2', 'PD', 'f2'),
      ],
    })
    expect(card(g, 'g:in:PD').previewLabels).toEqual(['label-f1', 'label-f2'])
  })

  it('a closed container previews from a previous open, never a fresh fetch', () => {
    const base = {
      nodes: [node('F'), node('Snowflake', 'DATAPLATFORM')],
      edges: [edge('e1', 'Snowflake', 'F')],
      isCoarser: (t?: string) => t === 'DATAPLATFORM',
    }
    // Never opened → nothing to preview, and we do not invent one.
    expect(card(build(base), 'n:Snowflake').previewLabels).toEqual([])

    // Opened once, then closed → the cached answer previews.
    const withCache = build({
      ...base,
      over: {
        containerResults: new Map([['in:Snowflake', {
          nodes: [node('kid1'), node('kid2')],
          edges: [edge('r1', 'kid1', 'F')],
          passedThrough: [], truncated: false, empty: false,
        }]]),
      },
    })
    expect(card(withCache, 'n:Snowflake').previewLabels).toEqual(['label-kid1', 'label-kid2'])
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
