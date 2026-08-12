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
  FRAME_CHILD_CAP,
  FRAME_ALL_CAP,
  ANCESTRY_CAP,
  framePager,
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
  canContain?: (t: string | undefined) => boolean
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
    canContain: opts.canContain ?? (() => false),
    collapsedFrames: new Set(),
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
  it('draws ≥2 same-parent neighbors as ROWS inside one frame, each with its own edge', () => {
    const g = build({
      nodes: [node('F'), node('f1', 'schemaField'), node('f2', 'schemaField'), node('PD'), node('s1', 'schemaField'), node('PS')],
      edges: [
        edge('e1', 'f1', 'F'), edge('e2', 'f2', 'F'), edge('e3', 's1', 'F'),
        contains('c1', 'PD', 'f1'), contains('c2', 'PD', 'f2'), contains('c3', 'PS', 's1'),
      ],
    })
    const frame = card(g, 'fr:in:PD')
    expect(frame.kind).toBe('frame')
    expect(frame.frameLocal).toBe(true)
    expect(frame.count).toBe(2)        // members
    expect(frame.sumCount).toBe(2)     // Σ connections
    // OPEN by default: a column's provenance is the question, so the
    // rows are on screen without a click.
    expect(frame.childrenOpen).toBe(true)
    expect(card(g, 'n:f1').frameId).toBe('fr:in:PD')
    expect(card(g, 'n:f2').frameId).toBe('fr:in:PD')
    // The singleton stays standalone with its parent as context —
    // framing one child adds a box for nothing.
    const single = card(g, 'n:s1')
    expect(single.frameId).toBeNull()
    expect(single.parentId).toBe('PS')
    expect(single.parentLabel).toBe('label-PS')
    // Rows carry their OWN edges; no bundled frame edge while they show.
    expect(g.edges.find(e => e.id === 'fe:n:f1->f')).toBeTruthy()
    expect(g.edges.find(e => e.id === 'fe:n:f2->f')).toBeTruthy()
    expect(g.edges.find(e => e.id === 'fe:fr:in:PD->f')).toBeUndefined()
    expect(g.edges.find(e => e.id === 'fe:n:s1->f')).toBeTruthy()
  })

  it('collapsing a frame bundles its rows back into one edge and hides them', () => {
    const g = build({
      nodes: [node('F'), node('f1', 'schemaField'), node('f2', 'schemaField'), node('PD')],
      edges: [
        edge('e1', 'f1', 'F'), edge('e2', 'f2', 'F'),
        contains('c1', 'PD', 'f1'), contains('c2', 'PD', 'f2'),
      ],
      over: { collapsedFrames: new Set(['in:PD']) },
    })
    const frame = card(g, 'fr:in:PD')
    expect(frame.childrenOpen).toBe(false)
    expect(g.cards.find(c => c.id === 'n:f1')).toBeUndefined()
    // Still says what it holds, from data already in hand.
    expect(frame.previewLabels).toEqual(['label-f1', 'label-f2'])
    expect(g.edges.find(e => e.id === 'fe:fr:in:PD->f')?.count).toBe(2)
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

  it('a coarse partner can open its contents — without needing any isAggregated flag', () => {
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
    expect(rollup.canOpenChildren).toBe(true)
    expect(rollup.childrenOpen).toBe(false)
    expect(rollup.expandKey).toBe('in:Snowflake')
    // Nothing inside is shown until it is opened.
    expect(g.cards.some(c => c.kind === 'frame')).toBe(false)
  })

  it('declines to offer contents when the ontology has not leveled the type', () => {
    // Without a level we cannot ask the server for the next grain down,
    // and guessing would query the wrong thing.
    const g = build({
      nodes: [node('F'), node('Mystery', 'UNLEVELED')],
      edges: [edge('e1', 'Mystery', 'F')],
      isCoarser: (t) => t === 'UNLEVELED',
      canContain: (t) => t === 'UNLEVELED',
      over: { entityLevels: new Map() },
    })
    expect(card(g, 'n:Mystery').canOpenChildren).toBe(false)
  })

  it('offers contents to a SAME-GRAIN neighbour — the reported failure', () => {
    // A dataset upstream of your dataset is not coarser, so the old
    // `entry.rollup` gate gave it a lineage hop and nothing else: its
    // columns were unreachable without re-centering the whole lens.
    const g = build({
      nodes: [node('F'), node('U', 'dataset')],
      edges: [edge('e1', 'U', 'F')],
      canContain: (t) => t === 'dataset',
    })
    const u = card(g, 'n:U')
    expect(u.rollup).toBe(false)
    expect(u.canOpenChildren).toBe(true)
    // The two gestures are independent — it still offers its lineage hop.
    expect(u.expandKind).toBe('hop')
    expect(u.frontier).toBe(true)
  })

  it('offers no contents when the type can contain nothing', () => {
    const g = build({
      nodes: [node('F'), node('c1', 'schemaField')],
      edges: [edge('e1', 'c1', 'F')],
      canContain: () => false,
    })
    expect(card(g, 'n:c1').canOpenChildren).toBe(false)
    expect(card(g, 'n:c1').expandKind).toBe('hop')
  })

  // REGRESSION: an opened frame carried `frontier/frontierExpanded: true`
  // unconditionally, rendered no hop control, and never fed the next
  // band — so looking inside anything ended the walk there.
  it('an opened frame keeps its own lineage hop, and expanding it reaches the next band', () => {
    const base = {
      nodes: [node('F'), node('Snowflake', 'DATAPLATFORM'), node('Up')],
      edges: [edge('e1', 'Snowflake', 'F'), edge('e2', 'Up', 'Snowflake')],
      isCoarser: (t?: string) => t === 'DATAPLATFORM',
      openRes: {
        openContainers: new Set(['in:Snowflake']),
        containerResults: new Map([['in:Snowflake', {
          nodes: [node('kid1')], edges: [edge('r1', 'kid1', 'F')],
          passedThrough: [], truncated: false, empty: false,
        }]]),
        containerStatus: new Map([['in:Snowflake', 'done' as const]]),
      },
    }
    const closed = build({ ...base, over: base.openRes })
    const frame = card(closed, 'fr:in:Snowflake')
    // Offered, not yet taken — and the hop is a separate question.
    expect(frame.frontier).toBe(true)
    expect(frame.frontierExpanded).toBe(false)
    expect(closed.cards.some(c => c.nodeId === 'Up')).toBe(false)

    const walked = build({
      ...base,
      over: { ...base.openRes, expandedFrontier: new Set(['in:Snowflake']) },
    })
    expect(card(walked, 'fr:in:Snowflake').frontierExpanded).toBe(true)
    // The frame's own upstream now sits a band further out, and the
    // frame's children are still there — both answers at once.
    expect(card(walked, 'n:Up').band).toBe(-2)
    expect(card(walked, 'n:kid1').frameId).toBe('fr:in:Snowflake')
  })

  // REGRESSION: `frameTotal` is the CONTAINER's child count — every
  // column of the table. Applying it to the pager in Connected mode said
  // "showing 1-12 of 428 / page 1 of 36" over three rows, with 35 pages
  // holding nothing and a Next that could not move. Default mode,
  // commonest shape, and no test covered it because they all set
  // frameShowAll.
  it('a Connected frame states its OWN extent, never the container\'s', () => {
    const connected = [node('c1'), node('c2'), node('c3')]
    const g = build({
      nodes: [node('F'), node('Snowflake', 'DATAPLATFORM'), ...connected],
      edges: [edge('e1', 'Snowflake', 'F')],
      isCoarser: (t) => t === 'DATAPLATFORM',
      over: {
        openContainers: new Set(['in:Snowflake']),
        containerResults: new Map([['in:Snowflake', {
          nodes: connected,
          edges: connected.map((c, i) => edge(`r${i}`, c.id, 'F')),
          passedThrough: [
            // The anchor claims 428 children — true, and irrelevant to
            // the three that connect.
            { ...node('anchor', 'CONTAINER'), data: { ...node('anchor').data, childCount: 428 } } as never,
          ],
          truncated: false, empty: false,
        }]]),
        containerStatus: new Map([['in:Snowflake', 'done' as const]]),
      },
    })
    const frame = card(g, 'fr:in:Snowflake')
    expect(frame.frameShowingAll).toBe(false)
    expect(frame.frameTotal).toBe(428)          // the container's own claim, kept
    const pager = framePager(frame)
    expect(pager.rows).toBe(3)                  // but the FRAME holds three
    expect(pager.pageCount).toBe(1)
    expect(pager.paged).toBe(false)             // no footer at all
    expect(pager.canNext).toBe(false)           // and nothing to move to
  })

  // REGRESSION: every child's edge was stamped with the CONTAINER's
  // bundled count, so a table reading x57 drew twelve x57 wires while
  // each column's own badge said x1 — one edge, two grains of truth.
  it('a frame child edge carries the CHILD\'s count, not the container\'s', () => {
    const g = build({
      nodes: [node('F'), node('Snowflake', 'DATAPLATFORM'), node('kid1'), node('kid2')],
      // The container's bundled connection to the focal is 3 edges.
      edges: [
        edge('e1', 'Snowflake', 'F'), edge('e2', 'Snowflake', 'F'), edge('e3', 'Snowflake', 'F'),
      ],
      isCoarser: (t) => t === 'DATAPLATFORM',
      over: {
        openContainers: new Set(['in:Snowflake']),
        containerResults: new Map([['in:Snowflake', {
          nodes: [node('kid1'), node('kid2')],
          // kid1 carries two of them, kid2 one.
          edges: [edge('r1', 'kid1', 'F'), edge('r2', 'kid1', 'F'), edge('r3', 'kid2', 'F')],
          passedThrough: [], truncated: false, empty: false,
        }]]),
        containerStatus: new Map([['in:Snowflake', 'done' as const]]),
      },
    })
    expect(card(g, 'n:kid1').count).toBe(2)
    expect(card(g, 'n:kid2').count).toBe(1)
    // The wire agrees with the badge sitting next to it.
    expect(g.edges.find(e => e.id === 'fe:n:kid1->f')?.count).toBe(2)
    expect(g.edges.find(e => e.id === 'fe:n:kid2->f')?.count).toBe(1)
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

  it('shows ONE fixed page of children, and paging MOVES the window', () => {
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
    const inFrame = (gr: ReturnType<typeof build>) =>
      gr.cards.filter(c => c.frameId === 'fr:in:Snowflake' && c.kind === 'entity')
    expect(inFrame(g)).toHaveLength(FRAME_CHILD_CAP)
    expect(inFrame(g)[0].nodeId).toBe('k00')
    const frame = card(g, 'fr:in:Snowflake')
    expect(frame.framePage).toBe(0)
    expect(framePager(frame)).toMatchObject({ from: 1, to: FRAME_CHILD_CAP, pageCount: 2, canPrev: false, canNext: true })

    // Page 2 REPLACES page 1 — the window moves, the frame does not grow.
    const paged = build({ ...base, over: { ...over, framePages: new Map([['in:Snowflake', 1]]) } })
    const tail = kids.slice(FRAME_CHILD_CAP).map(k => k.id)
    expect(inFrame(paged).map(c => c.nodeId)).toEqual(tail)
    expect(inFrame(paged).some(c => c.nodeId === 'k00')).toBe(false)
    expect(framePager(card(paged, 'fr:in:Snowflake'))).toMatchObject({
      from: FRAME_CHILD_CAP + 1, to: kids.length, canPrev: true, canNext: false,
    })
    // And there is no "+N more" card raising a cap any more.
    expect(paged.cards.find(c => c.id === 'more:fr:in:Snowflake')).toBeUndefined()
  })

  it('holds the last loaded page when asked for one past it, rather than blanking', () => {
    const kids = Array.from({ length: FRAME_CHILD_CAP + 1 }, (_, i) => node(`k${String(i).padStart(2, '0')}`))
    const g = build({
      nodes: [node('F'), node('Snowflake', 'DATAPLATFORM')],
      edges: [edge('e1', 'Snowflake', 'F')],
      isCoarser: (t?: string) => t === 'DATAPLATFORM',
      over: {
        openContainers: new Set(['in:Snowflake']),
        containerResults: new Map([['in:Snowflake', {
          nodes: kids,
          edges: kids.map((k, i) => edge(`r${i}`, k.id, 'F')),
          passedThrough: [], truncated: false, empty: false,
        }]]),
        containerStatus: new Map([['in:Snowflake', 'done' as const]]),
        framePages: new Map([['in:Snowflake', 7]]),   // way past the data
      },
    })
    expect(card(g, 'fr:in:Snowflake').framePage).toBe(1)
    expect(g.cards.filter(c => c.frameId === 'fr:in:Snowflake' && c.kind === 'entity')).toHaveLength(1)
  })

  // The drill has to go table → column → field without re-centering.
  // Sizing must run deepest-first: an outer frame sums its children's
  // heights, so an inner frame sized after its host would leave the host
  // short and the two would overlap.
  it('nests a frame inside a frame, with the outer rect actually enclosing the inner', () => {
    const g = build({
      nodes: [node('F'), node('Snowflake', 'DATAPLATFORM'), node('tbl', 'CONTAINER'), node('col', 'dataset')],
      edges: [edge('e1', 'Snowflake', 'F')],
      isCoarser: (t) => t === 'DATAPLATFORM',
      canContain: (t) => t === 'CONTAINER' || t === 'DATAPLATFORM',
      over: {
        openContainers: new Set(['in:Snowflake', 'in:tbl']),
        containerResults: new Map([
          ['in:Snowflake', {
            nodes: [node('tbl', 'CONTAINER')], edges: [edge('r1', 'tbl', 'F')],
            passedThrough: [], truncated: false, empty: false,
          }],
          ['in:tbl', {
            nodes: [node('col', 'dataset')], edges: [edge('r2', 'col', 'F')],
            passedThrough: [], truncated: false, empty: false,
          }],
        ]),
        containerStatus: new Map([
          ['in:Snowflake', 'done' as const], ['in:tbl', 'done' as const],
        ]),
      },
    })
    const outer = card(g, 'fr:in:Snowflake')
    const inner = card(g, 'fr:in:tbl')
    const leaf = card(g, 'n:col')
    // The inner frame is a CHILD of the outer one, not a sibling in the band.
    expect(inner.frameId).toBe('fr:in:Snowflake')
    expect(inner.kind).toBe('frame')
    expect(leaf.frameId).toBe('fr:in:tbl')
    // The table is not ALSO drawn as a plain card next to its own frame.
    expect(g.cards.filter(c => c.nodeId === 'tbl')).toHaveLength(1)

    const encloses = (a: typeof outer, b: typeof inner) =>
      b.x >= a.x && b.y >= a.y && b.x + b.w <= a.x + a.w && b.y + b.h <= a.y + a.h
    expect(encloses(outer, inner)).toBe(true)
    expect(encloses(inner, leaf)).toBe(true)
    expect(encloses(outer, leaf)).toBe(true)
  })

  // "No matter how many levels deep": the focal's own stack was one
  // flat level of terminal rows, so a column's fields were reachable
  // only by re-centering the whole lens on the column.
  it("nests the focal's contains stack, opening a row into what IT holds", () => {
    const base = {
      nodes: [node('F'), node('col', 'dataset'), node('sub', 'schemaField')],
      edges: [contains('c1', 'F', 'col')],
      canContain: (t?: string) => t === 'dataset',
    }
    const shown = { bandPages: new Map([['contains', 1]]) }

    // Closed: the row is there, offering to open, with nothing under it.
    const closed = build({ ...base, over: shown })
    const row = card(closed, 'c:col')
    expect(row.kind).toBe('contains')
    expect(row.canOpenChildren).toBe(true)
    expect(row.childrenOpen).toBe(false)
    expect(row.depth).toBe(0)
    expect(closed.cards.find(c => c.id === 'c:sub')).toBeUndefined()

    // Open: its children hang off IT, not off the focal, and indent.
    const open = build({
      ...base,
      over: {
        ...shown,
        openContains: new Set(['col']),
        containsChildrenOf: new Map([['col', ['sub']]]),
      },
    })
    const kid = card(open, 'c:sub')
    expect(kid.depth).toBe(1)
    expect(kid.x).toBeGreaterThan(card(open, 'c:col').x)
    expect(open.edges.find(e => e.id === 'ce:c:col->c:sub')?.containment).toBe(true)
    // A schemaField holds nothing, so it offers nothing — no dead control.
    expect(kid.canOpenChildren).toBe(false)
  })

  // REGRESSION: the chevron was offered at every depth while the walk
  // stopped recursing at CONTAINS_MAX_DEPTH, so the deepest row fetched
  // over the network, flipped to "open", and rendered nothing.
  it('offers a DOOR at the deepest level, never a chevron that does nothing', () => {
    const chain = ['l0', 'l1', 'l2', 'l3']
    const g = build({
      nodes: [node('F'), ...chain.map(c => node(c, 'dataset'))],
      edges: [contains('c1', 'F', 'l0')],
      canContain: (t?: string) => t === 'dataset',
      over: {
        bandPages: new Map([['contains', 1]]),
        openContains: new Set(chain),
        containsChildrenOf: new Map([['l0', ['l1']], ['l1', ['l2']], ['l2', ['l3']], ['l3', ['deeper']]]),
      },
    })
    // Depths 0-2 open in place.
    for (const [i, id] of ['l0', 'l1', 'l2'].entries()) {
      expect(card(g, `c:${id}`).depth).toBe(i)
      expect(card(g, `c:${id}`).canOpenChildren).toBe(true)
      expect(card(g, `c:${id}`).expandKind).toBeNull()
    }
    // The deepest offers to re-center instead — and does NOT claim to open.
    const deepest = card(g, 'c:l3')
    expect(deepest.depth).toBe(3)
    expect(deepest.canOpenChildren).toBe(false)
    expect(deepest.expandKind).toBe('focus')
    // Its children are genuinely not drawn, and nothing pretends they are.
    expect(g.cards.find(c => c.id === 'c:deeper')).toBeUndefined()
  })

  it('says so when an opened row is empty or failed, instead of going silent', () => {
    const base = {
      nodes: [node('F'), node('col', 'dataset')],
      edges: [contains('c1', 'F', 'col')],
      canContain: (t?: string) => t === 'dataset',
    }
    const shown = { bandPages: new Map([['contains', 1]]), openContains: new Set(['col']) }

    const empty = build({ ...base, over: {
      ...shown,
      containsChildrenOf: new Map([['col', []]]),
      containsStatusOf: new Map([['col', 'done' as const]]),
    } })
    const note = card(empty, 'note:c:col')
    expect(note.label).toBe('Nothing inside label-col')
    expect(note.expandKind).toBeNull()         // a statement, not a button
    expect(note.expandKey).toBeNull()
    expect(note.parentId).toBe('col')

    const failed = build({ ...base, over: {
      ...shown,
      containsStatusOf: new Map([['col', 'error' as const]]),
    } })
    expect(card(failed, 'c:col').fetch).toBe('error')
    expect(card(failed, 'note:c:col').label).toBe("Couldn't look inside label-col — retry")
    // A real retry, not a 'more' whose key routes to the band pager —
    // which reads nothing of the sort, so that retry was itself dead.
    expect(card(failed, 'note:c:col').expandKind).toBe('retry')
    expect(card(failed, 'note:c:col').parentId).toBe('col')

    // Still loading is the chevron's own spinner — no premature verdict.
    const loading = build({ ...base, over: {
      ...shown,
      containsStatusOf: new Map([['col', 'loading' as const]]),
    } })
    expect(card(loading, 'c:col').fetch).toBe('loading')
    expect(loading.cards.find(c => c.id === 'note:c:col')).toBeUndefined()
  })

  it('caps each contains level and says what it capped', () => {
    const kids = Array.from({ length: CONTAINS_CAP + 4 }, (_, i) => `k${String(i).padStart(2, '0')}`)
    const g = build({
      nodes: [node('F'), node('col', 'dataset'), ...kids.map(k => node(k, 'schemaField'))],
      edges: [contains('c1', 'F', 'col')],
      canContain: (t?: string) => t === 'dataset',
      over: {
        bandPages: new Map([['contains', 1]]),
        openContains: new Set(['col']),
        containsChildrenOf: new Map([['col', kids]]),
      },
    })
    expect(g.cards.filter(c => c.kind === 'contains' && c.depth === 1)).toHaveLength(CONTAINS_CAP)
    const more = card(g, 'more:c:col')
    expect(more.overflowCount).toBe(4)
    // NOT a "+N more" that pages this column — that card had no
    // expandKey and no handler could raise a nested level's cap, so it
    // was inert. It re-centers, where the rest get real paging.
    expect(more.expandKind).toBe('focus')
    expect(more.parentId).toBe('col')
    expect(more.label).toContain('focus it')
  })

  // REGRESSION: `shown` is ordered [groups, standalone, rollups] and an
  // opened container is always a rollup, so a child that ALSO has direct
  // lineage to the focal was drawn as a band card first and then filtered
  // out of the frame by the one-entity-one-card rule. The user opened the
  // container and got an empty box captioned "0 connected" — right after
  // the closed card had previewed those very children.
  it('an opened frame OWNS a child that is also a direct neighbour', () => {
    const g = build({
      nodes: [node('F'), node('Snowflake', 'DATAPLATFORM'), node('shared')],
      // `shared` reaches the focal directly AND lives inside Snowflake.
      edges: [edge('e1', 'Snowflake', 'F'), edge('e2', 'shared', 'F')],
      isCoarser: (t) => t === 'DATAPLATFORM',
      over: {
        openContainers: new Set(['in:Snowflake']),
        containerResults: new Map([['in:Snowflake', {
          nodes: [node('shared')],
          edges: [edge('r1', 'shared', 'F')],
          passedThrough: [], truncated: false, empty: false,
        }]]),
        containerStatus: new Map([['in:Snowflake', 'done' as const]]),
      },
    })
    const frame = card(g, 'fr:in:Snowflake')
    // The frame is not empty, and it counts what the SERVER said.
    expect(frame.count).toBe(1)
    expect(frame.frameConnectedCount).toBe(1)
    // The child lives inside the frame, exactly once.
    expect(g.cards.filter(c => c.nodeId === 'shared')).toHaveLength(1)
    expect(card(g, 'n:shared').frameId).toBe('fr:in:Snowflake')
  })

  // REGRESSION: when pushCard refused the frame (its entity was already
  // drawn in an earlier band) the children kept a frameId pointing at a
  // card that did not exist — skipped by both layout passes, so they kept
  // x:0,y:0 and rendered stacked on top of the focal.
  it('never leaves a child pointing at a frame that was not placed', () => {
    const g = build({
      nodes: [node('F'), node('U'), node('C', 'CONTAINER'), node('kid')],
      edges: [edge('e1', 'U', 'F'), edge('e2', 'C', 'F')],
      isCoarser: (t) => t === 'CONTAINER',
      over: {
        expandedFrontier: new Set(['in:U']),
        openContainers: new Set(['in:C']),
        containerResults: new Map([['in:C', {
          nodes: [node('kid')], edges: [edge('r1', 'kid', 'F')],
          passedThrough: [], truncated: false, empty: false,
        }]]),
        containerStatus: new Map([['in:C', 'done' as const]]),
      },
    })
    const frameIds = new Set(g.cards.filter(c => c.kind === 'frame').map(c => c.id))
    for (const c of g.cards) {
      if (c.frameId) expect(frameIds.has(c.frameId)).toBe(true)
    }
    // And nothing but the focal sits on the focal's own spot.
    const onOrigin = g.cards.filter(c => c.x === 0 && c.y === 0 && c.kind !== 'focal')
    expect(onOrigin).toEqual([])
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
    expect(g.cards.some(c => c.id === 'n:PD')).toBe(false)
    const frame = card(g, 'fr:in:PD')
    expect(frame.kind).toBe('frame')
    expect(frame.nodeId).toBe('PD')
  })

  it('still groups children under a parent that is NOT itself a neighbour', () => {
    const g = build({
      nodes: [node('F'), node('PD'), node('f1', 'schemaField'), node('f2', 'schemaField')],
      edges: [
        edge('e1', 'f1', 'F'), edge('e2', 'f2', 'F'),
        contains('c1', 'PD', 'f1'), contains('c2', 'PD', 'f2'),
      ],
    })
    expect(card(g, 'fr:in:PD').kind).toBe('frame')
    expect(g.cards.some(c => c.id === 'n:PD')).toBe(false)
  })

  // REGRESSION: the containment tether from the focal to a contained
  // child used the same id space as lineage edges (`fe:f->c:id`). A
  // child that ALSO carried downstream lineage produced two edges with
  // one id, and React Flow — which keys on id — silently dropped one.
  it('never emits two edges with the same id', () => {
    const g = build({
      nodes: [node('F'), node('kid', 'schemaField')],
      edges: [
        contains('c1', 'F', 'kid'),
        // ...and the same child is a downstream consumer of the focal.
        edge('e1', 'F', 'kid'),
      ],
      over: { bandPages: new Map([['contains', 1]]) },
    })
    const ids = g.edges.map(e => e.id)
    expect(new Set(ids).size).toBe(ids.length)
    // Both facts survive: the structural tether and the flow.
    expect(g.edges.some(e => e.containment)).toBe(true)
    expect(g.edges.some(e => !e.containment)).toBe(true)
  })

  // REGRESSION: "one entity, one card" was a convention each call site
  // had to remember. The group header skipped it and drew a duplicate.
  it('never emits two cards for one entity', () => {
    const many = Array.from({ length: 6 }, (_, i) => node(`f${i}`, 'schemaField'))
    const g = build({
      nodes: [node('F'), node('PD'), ...many],
      edges: [
        { ...edge('agg1', 'PD', 'F'), data: { edgeType: 'AGGREGATED', isAggregated: true, edgeCount: 6 } } as LineageEdge,
        ...many.map((n, i) => edge(`e${i}`, n.id, 'F')),
        ...many.map((n, i) => contains(`c${i}`, 'PD', n.id)),
      ],
    })
    const byNode = g.cards.filter(c => c.nodeId !== null).map(c => c.nodeId)
    expect(new Set(byNode).size).toBe(byNode.length)
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
    // An unknown total makes the page COUNT a floor too, and the pager
    // still offers Next because the server says there is more.
    expect(framePager(frame)).toMatchObject({ exact: false, pageCount: 1, paged: true, canNext: true })
  })

  it('windows a long child list at a constant size', () => {
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
    const inFrame = (gr: ReturnType<typeof build>) =>
      gr.cards.filter(c => c.frameId === 'fr:in:Snowflake' && c.kind === 'entity')
    // A full window, drawn from the server's child order.
    expect(inFrame(g)).toHaveLength(FRAME_ALL_CAP)
    // Roster is the 25 children plus the two connected ones appended.
    expect(framePager(card(g, 'fr:in:Snowflake'))).toMatchObject({
      from: 1, to: FRAME_ALL_CAP, pageCount: 2, exact: true,
    })

    const paged = build({ ...base, over: { ...over, framePages: new Map([['in:Snowflake', 1]]) } })
    expect(inFrame(paged)).toHaveLength(7)
    expect(inFrame(paged).some(c => c.nodeId === 'k00')).toBe(false)
    // Frame height is the page's, not the cumulative list's — page 2 is
    // no taller than page 1 was.
    expect(card(paged, 'fr:in:Snowflake').h).toBeLessThan(card(g, 'fr:in:Snowflake').h)
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

  it('a frame holds exactly the lineage-participating children, never the rest of the table', () => {
    const g = build({
      nodes: [node('F'), node('f1', 'schemaField'), node('f2', 'schemaField'), node('PD')],
      edges: [
        edge('e1', 'f1', 'F'), edge('e2', 'f2', 'F'),
        contains('c1', 'PD', 'f1'), contains('c2', 'PD', 'f2'),
        // PD also contains f3 — but f3 has NO lineage to F, so it must
        // not appear when the group expands.
        contains('c3', 'PD', 'f3'),
      ],
    })
    expect(card(g, 'fr:in:PD').childrenOpen).toBe(true)
    expect(card(g, 'n:f1').frameId).toBe('fr:in:PD')
    expect(card(g, 'n:f2').frameId).toBe('fr:in:PD')
    expect(g.cards.find(c => c.id === 'n:f3')).toBeUndefined()
    // Rows carry their own edges; no bundled frame edge.
    expect(g.edges.find(e => e.id === 'fe:n:f1->f')).toBeTruthy()
    expect(g.edges.find(e => e.id === 'fe:fr:in:PD->f')).toBeUndefined()
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

  // REGRESSION: opening a container always asked "what inside it
  // connects to the FOCAL". At band 2+ the card has no lineage with the
  // focal at all, so the server answered "nothing" — correctly — and
  // every deeper open read "Nothing inside X connects to this entity".
  // The card must carry the partner it is ACTUALLY connected to.
  it('names the partner an open should ask about — the previous band, not the focal', () => {
    const g = build({
      nodes: [node('F'), node('B'), node('C', 'CONTAINER')],
      edges: [edge('e1', 'F', 'B'), edge('e2', 'B', 'C')],
      isCoarser: (t) => t === 'CONTAINER',
      over: { expandedFrontier: new Set(['out:B']) },
    })
    const c = card(g, 'n:C')
    expect(c.band).toBe(2)
    expect(c.canOpenChildren).toBe(true)
    // The question is about B, and the frame says so.
    expect(c.partnerIds).toEqual(['B'])
    expect(c.partnerLabel).toBe('label-B')

    // A band-1 card's partner IS the focal, so the wording stays plain.
    const b = card(g, 'n:B')
    expect(b.partnerIds).toEqual(['F'])
    expect(b.partnerLabel).toBeNull()
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

  it('the text filter DIMS misses and counts matches inside a collapsed frame — never removes', () => {
    const g = build({
      nodes: [node('F'), node('alpha'), node('beta'), node('m-alpha', 'schemaField'), node('m-beta', 'schemaField'), node('PD')],
      edges: [
        edge('e1', 'alpha', 'F'), edge('e2', 'beta', 'F'),
        edge('e3', 'm-alpha', 'F'), edge('e4', 'm-beta', 'F'),
        contains('c1', 'PD', 'm-alpha'), contains('c2', 'PD', 'm-beta'),
      ],
      over: { query: 'alpha', collapsedFrames: new Set(['in:PD']) },
    })
    expect(card(g, 'n:alpha').dimmed).toBe(false)
    expect(card(g, 'n:beta').dimmed).toBe(true)          // dimmed, present
    const frame = card(g, 'fr:in:PD')
    expect(frame.dimmed).toBe(false)                      // holds a match
    expect(frame.matchesInside).toBe(1)                   // m-alpha
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

  it('a collapsed frame previews a few of its rows before you open it', () => {
    const g = build({
      nodes: [node('F'), node('f1', 'schemaField'), node('f2', 'schemaField'), node('PD')],
      edges: [
        edge('e1', 'f1', 'F'), edge('e2', 'f2', 'F'),
        contains('c1', 'PD', 'f1'), contains('c2', 'PD', 'f2'),
      ],
      over: { collapsedFrames: new Set(['in:PD']) },
    })
    expect(card(g, 'fr:in:PD').previewLabels).toEqual(['label-f1', 'label-f2'])
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

describe('buildFocusGraph — grain', () => {
  /** The reported shape: ONE column→column connection, reported again at
   *  the column's table, its container and its platform. Four cards, one
   *  answer — "4 connections · 3 rolled-up". */
  const restated = {
    nodes: [
      node('F', 'schemaField'), node('up', 'schemaField'),
      node('tbl', 'dataset'), node('CTR', 'CONTAINER'), node('Plat', 'DATAPLATFORM'),
    ],
    edges: [
      edge('e1', 'up', 'F'),
      edge('e2', 'tbl', 'F'), edge('e3', 'CTR', 'F'), edge('e4', 'Plat', 'F'),
      contains('k1', 'Plat', 'CTR'), contains('k2', 'CTR', 'tbl'), contains('k3', 'tbl', 'up'),
    ],
    isCoarser: (t?: string) => t === 'CONTAINER' || t === 'DATAPLATFORM' || t === 'dataset',
  }

  it('folds coarser restatements into the finest connection', () => {
    const g = build({ ...restated, over: { foldCoarserRestatements: true } })
    // One card, not four.
    expect(g.cards.filter(c => c.band === -1)).toHaveLength(1)
    const kept = card(g, 'n:up')
    // And it SAYS what it now stands for — three cards vanishing while
    // the header still counts them would be silent loss.
    expect(kept.alsoAtGrains).toEqual(['dataset', 'CONTAINER', 'DATAPLATFORM'])
  })

  // REGRESSION: the fold rewrote the board without telling the HEADER,
  // so a focal reading "9 connections · 6 rolled-up" sat above three
  // cards and nothing on screen reconciled the two — six connections
  // appeared to have gone missing.
  it('reports how much it folded, and at which grains, so the header can reconcile', () => {
    const g = build({ ...restated, over: { foldCoarserRestatements: true } })
    expect(g.foldedAway).toBe(3)
    expect(g.foldedGrains).toEqual(['CONTAINER', 'DATAPLATFORM', 'dataset'])
  })

  it('leaves them alone when folding is off, and reports no fold', () => {
    const g = build({ ...restated, over: { foldCoarserRestatements: false } })
    expect(g.cards.filter(c => c.band === -1)).toHaveLength(4)
    expect(card(g, 'n:up').alsoAtGrains).toEqual([])
    expect(g.foldedAway).toBe(0)
    expect(g.foldedGrains).toEqual([])
  })

  it('never folds a coarser partner that is NOT an ancestor of a finer one', () => {
    // An unrelated platform is a real, separate connection.
    const g = build({
      nodes: [node('F', 'schemaField'), node('up', 'schemaField'), node('Other', 'DATAPLATFORM')],
      edges: [edge('e1', 'up', 'F'), edge('e2', 'Other', 'F')],
      isCoarser: (t?: string) => t === 'DATAPLATFORM',
      over: { foldCoarserRestatements: true },
    })
    expect(g.cards.filter(c => c.band === -1)).toHaveLength(2)
    expect(card(g, 'n:up').alsoAtGrains).toEqual([])
  })

  it('choosing one grain hides the others and reports how many', () => {
    // What the Grain control does: everything but the chosen level goes
    // through the chips' own hide-and-report path, never silent loss.
    const g = build({
      ...restated,
      over: { hiddenTypes: new Set(['schemaField', 'CONTAINER', 'DATAPLATFORM']) },
    })
    expect(g.cards.filter(c => c.band === -1).map(c => c.nodeId)).toEqual(['tbl'])
    expect(g.hiddenByChipsIn).toBe(3)
  })
})

describe('buildFocusGraph — provenance', () => {
  // REGRESSION: the card carried ONE parent, rendered end-truncated at
  // 80px, so `int_clean_orders_t1` and `int_clean_orders_t2` were both
  // "int_clean_order…" — a column's owner was genuinely unreadable, and
  // that is the reported complaint.
  it('carries the whole containment chain, root-first', () => {
    const g = build({
      nodes: [
        node('F'), node('col', 'schemaField'),
        node('Snowflake', 'DATAPLATFORM'), node('GOLD', 'CONTAINER'), node('fact_orders'),
      ],
      edges: [
        edge('e1', 'col', 'F'),
        contains('c1', 'Snowflake', 'GOLD'),
        contains('c2', 'GOLD', 'fact_orders'),
        contains('c3', 'fact_orders', 'col'),
      ],
    })
    expect(card(g, 'n:col').ancestry).toEqual(['label-Snowflake', 'label-GOLD', 'label-fact_orders'])
    // Root-first, and the urns line up index for index — the focal's
    // breadcrumb makes every crumb a place you can go, and a chain
    // whose ids were ordered differently from its labels would send
    // you somewhere other than the level you clicked.
    expect(card(g, 'n:col').ancestryIds).toEqual(['Snowflake', 'GOLD', 'fact_orders'])
    // The immediate parent still resolves as before.
    expect(card(g, 'n:col').parentId).toBe('fact_orders')
  })

  it('survives a containment cycle and a chain longer than the cap', () => {
    const deep = Array.from({ length: 12 }, (_, i) => node(`lvl${i}`))
    const g = build({
      nodes: [node('F'), node('leaf'), ...deep],
      edges: [
        edge('e1', 'leaf', 'F'),
        ...deep.slice(1).map((n, i) => contains(`c${i}`, deep[i].id, n.id)),
        contains('cl', 'lvl11', 'leaf'),
        // A cycle back to the root — malformed data must not hang the build.
        contains('cyc', 'lvl11', 'lvl0'),
      ],
    })
    const chain = card(g, 'n:leaf').ancestry
    expect(chain.length).toBeLessThanOrEqual(ANCESTRY_CAP)
    expect(new Set(chain).size).toBe(chain.length)   // no repeats
  })

  it('gives the focal and its contained rows a chain too', () => {
    const g = build({
      nodes: [node('F'), node('db', 'CONTAINER'), node('kid', 'schemaField')],
      edges: [contains('c1', 'db', 'F'), contains('c2', 'F', 'kid')],
      over: { bandPages: new Map([['contains', 1]]) },
    })
    expect(card(g, 'f').ancestry).toEqual(['label-db'])
    expect(card(g, 'c:kid').ancestry).toEqual(['label-db', 'label-F'])
  })
})

describe('buildFocusGraph — expansion feedback', () => {
  // REGRESSION: expanding a card whose neighbours are ALL already drawn
  // adds edges and no cards. The pill still flipped to an accent Minus,
  // so the click changed a glyph and the picture appeared frozen — one
  // of the two reasons "I am unable to expand any of the entities".
  it('marks an expansion that reached only what was already on the board', () => {
    // A and B are both upstream of the focal, and A is also upstream of
    // B — so expanding B upstream reaches A, which already has a card.
    const g = build({
      nodes: [node('F'), node('A'), node('B')],
      edges: [edge('e1', 'A', 'F'), edge('e2', 'B', 'F'), edge('e3', 'A', 'B')],
      over: {
        expandedFrontier: new Set(['in:B']),
        fetchStatus: new Map([['B', 'done' as const]]),
      },
    })
    const b = card(g, 'n:B')
    expect(b.alreadyShown).toBe(true)
    // Not a dead end — it genuinely connects, the connection was just
    // already on screen.
    expect(b.deadEnd).toBe(false)
    // Exactly one card per entity, as ever — and the edge WAS drawn.
    expect(g.cards.filter(c => c.nodeId === 'A')).toHaveLength(1)
    expect(g.edges.some(e => e.source === 'n:A' && e.target === 'n:B')).toBe(true)
  })

  it('does not mark an expansion that actually brought something new', () => {
    const g = build({
      nodes: [node('F'), node('U'), node('UU')],
      edges: [edge('e1', 'U', 'F'), edge('e2', 'UU', 'U')],
      over: {
        expandedFrontier: new Set(['in:U']),
        fetchStatus: new Map([['U', 'done' as const]]),
      },
    })
    expect(card(g, 'n:U').alreadyShown).toBe(false)
    expect(card(g, 'n:UU').band).toBe(-2)
  })

  it('does not mark a dead end as already-shown', () => {
    const g = build({
      nodes: [node('F'), node('U')],
      edges: [edge('e1', 'U', 'F')],
      over: {
        expandedFrontier: new Set(['in:U']),
        fetchStatus: new Map([['U', 'done' as const]]),
      },
    })
    expect(card(g, 'n:U').deadEnd).toBe(true)
    expect(card(g, 'n:U').alreadyShown).toBe(false)
  })
})

describe('buildFocusGraph — honesty', () => {
  // REGRESSION: an empty band whispered "No upstream sources in the data
  // source" even when the user's own type chips had emptied it, reporting
  // the filter as a fact about the warehouse.
  it('splits chip-hidden counts per direction so an empty band is not misread', () => {
    const g = build({
      nodes: [node('F'), node('u', 'schemaField'), node('d', 'dataset')],
      edges: [edge('e1', 'u', 'F'), edge('e2', 'F', 'd')],
      over: { hiddenTypes: new Set(['schemaField']) },
    })
    expect(g.hiddenByChipsIn).toBe(1)
    expect(g.hiddenByChipsOut).toBe(0)
    expect(g.hiddenByChips).toBe(1)
    // Upstream is empty ONLY because of the chip; downstream genuinely has one.
    expect(g.cards.some(c => c.band === -1)).toBe(false)
    expect(g.cards.some(c => c.band === 1)).toBe(true)
  })

  // REGRESSION: the band cap counts a group as ONE item, so its members
  // were emitted outside the budget — one click on a wide table's group
  // header put hundreds of cards in a single band.
  it('moves a fixed WINDOW through a wide frame instead of growing it', () => {
    const members = Array.from({ length: FRAME_CHILD_CAP + 6 }, (_, i) => node(`m${String(i).padStart(2, '0')}`, 'schemaField'))
    const fixture = {
      nodes: [node('F'), node('P'), ...members],
      edges: [
        ...members.map((m, i) => edge(`e${i}`, m.id, 'F')),
        ...members.map((m, i) => contains(`c${i}`, 'P', m.id)),
      ],
    }
    const g = build(fixture)
    // One page on screen, and the frame reports the whole roster —
    // the old "+N more inside" raised the cap instead, so five clicks
    // on a wide table left a 2,000px box.
    expect(g.cards.filter(c => c.frameId === 'fr:in:P')).toHaveLength(FRAME_CHILD_CAP)
    expect(card(g, 'fr:in:P').frameTotal).toBe(members.length)
    expect(g.cards.find(c => c.id === 'more:g:in:P')).toBeUndefined()

    // Page 2 holds the SAME window size, on the remaining rows.
    const paged = build({ ...fixture, over: { framePages: new Map([['in:P', 1]]) } })
    expect(paged.cards.filter(c => c.frameId === 'fr:in:P')).toHaveLength(6)
    expect(card(paged, 'fr:in:P').framePage).toBe(1)
    // And page 1's rows are gone, not stacked underneath.
    expect(paged.cards.find(c => c.id === 'n:m00')).toBeUndefined()
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
