/**
 * traceViewModel — cards, lanes, view-anchored placement, visibility, counts.
 *
 * The CFO estate is the screenshot's truth: the view anchors the warehouse
 * side at the CONTAINERS (INTERMEDIATE_T2, REPORTING) and the report side at
 * the platform (tableau). `snowflake` is chrome — no assignment, no rule that
 * places it in a curated view — so it must never become a lane root, and the
 * chains under it anchor at the highest ancestor the VIEW actually places.
 */
import { describe, it, expect } from 'vitest'
import { buildTraceView, lanesToHierarchy, lanesToRenderTrees } from '../traceViewModel'
import { cfoEstate, rootsNodeEstate } from '@/test/fixtures/traceEstates'
import type { TraceViewInputs } from '../traceViewModel'
import type { LensWalkModel, LensWalkNode } from '@/components/canvas/context-view/lens/closure-adapter'

const view = (expansion: string[], over: Partial<TraceViewInputs> = {}) => {
  const e = cfoEstate()
  return buildTraceView({
    model: e.model, focusUrn: 'cfo', layers: e.layers, assignments: e.assignments, viewIsCurated: true,
    traceExpansion: new Set(expansion), showUpstream: true, showDownstream: true, depthUp: 25, depthDown: 25,
    ...over,
  })
}

describe('buildTraceView — CFO estate', () => {
  it('anchors chains at the VIEW-placed ancestor, never the graph root; nothing outside the view', () => {
    const v = view(['tableau', 'cfo'])
    const lanes = Object.fromEntries(v.lanes.map(l => [l.layerId, l.roots.map(r => r.id).sort()]))
    expect(lanes.warehouse).toEqual(['INTERMEDIATE_T2', 'REPORTING'])   // snowflake (platform) is chrome
    expect(lanes.report).toEqual(['tableau'])
    expect(v.outsideView).toBe(0)
  })

  it('R1: focus chain open, direct partners CLOSED with honest counts', () => {
    const v = view(['tableau', 'cfo'])
    expect(v.visible.has('aov')).toBe(true)           // inside the open dashboard
    expect(v.visible.has('orders')).toBe(false)       // INTERMEDIATE_T2 is closed
    const t2 = v.lanes.find(l => l.layerId === 'warehouse')!.cards.get('INTERMEDIATE_T2')!
    expect(t2.expanded).toBe(false); expect(t2.childCount).toBe(1); expect(t2.onLineage).toBe(3)  // orders + 2 fields
  })

  it('the HIGHEST placed ancestor wins when the view places both', () => {
    const e = cfoEstate()
    const v = view(['tableau', 'cfo'], { assignments: { ...e.assignments, snowflake: { layerId: 'warehouse' } } })
    const warehouse = v.lanes.find(l => l.layerId === 'warehouse')!
    expect(warehouse.roots.map(r => r.id)).toEqual(['snowflake'])   // not the containers below it
    expect(warehouse.cards.get('INTERMEDIATE_T2')!.parentId).toBe('snowflake')
    expect(warehouse.cards.get('INTERMEDIATE_T2')!.depth).toBe(1)
    expect(v.outsideView).toBe(0)
  })

  it("childCount is the GRAPH's count, never the walked subset", () => {
    const warehouse = view(['tableau', 'cfo']).lanes.find(l => l.layerId === 'warehouse')!
    // `rpt` has 2 columns in the graph; only rpt.gross carries lineage to the
    // CFO dashboard, so the walk holds ONE child. The chevron must still say 2
    // — counting the walked subset is what silently deleted chevrons before.
    const rpt = warehouse.cards.get('rpt')!
    expect(rpt.childCount).toBe(2)
    expect(warehouse.childrenOf.get('rpt')).toEqual(['rpt.gross'])
    expect(rpt.onLineage).toBe(1)
    expect(warehouse.cards.has('rpt.channel')).toBe(false)        // no lineage, no card
    expect(warehouse.cards.get('REPORTING')!.onLineage).toBe(2)   // rpt + rpt.gross
  })

  it('expanding a partner reveals one level, closed', () => {
    const v = view(['tableau', 'cfo', 'INTERMEDIATE_T2'])
    expect(v.visible.has('orders')).toBe(true)
    expect(v.visible.has('orders.channel')).toBe(false)
  })

  it('direction scope hides a whole branch incl. hosts; depth scopes hops', () => {
    const v = view(['tableau', 'cfo'], { showUpstream: false })
    expect(v.lanes.find(l => l.layerId === 'warehouse')?.roots ?? []).toHaveLength(0)
  })

  it('is deterministic', () => { expect(JSON.stringify(view(['tableau']).lanes.map(l => l.roots.map(r => r.id)))).toBe(JSON.stringify(view(['tableau']).lanes.map(l => l.roots.map(r => r.id)))) })

  it('counts PARTNERS only — the focus side is never a partner', () => {
    const v = view(['tableau', 'cfo'])
    // The focus's whole containment subtree is the focus SIDE (hop 0 in both
    // directions). It is what the user is looking at, never something the
    // lineage led to, so it is never counted and never scoped away.
    const report = v.lanes.find(l => l.layerId === 'report')!
    for (const urn of ['cfo', 'aov', 'aov.channel', 'aov.avg']) expect(report.cards.get(urn)!.role).toBe('focus')
    expect(report.cards.get('tableau')!.role).toBe('host')
    // 7 upstream partners: the 2 containers, their 2 datasets, 3 columns.
    expect(v.counts).toEqual({ up: 7, down: 0 })
    // Turn upstream off and every partner leaves; the focus side stays.
    const off = view(['tableau', 'cfo'], { showUpstream: false })
    expect(off.counts).toEqual({ up: 0, down: 0 })
    expect(off.visible.has('cfo')).toBe(true)
  })

  it('lanes follow the layer ORDER, not discovery order', () => {
    expect(view(['tableau', 'cfo']).lanes.map(l => l.layerId)).toEqual(['warehouse', 'report'])
    const flipped = cfoEstate().layers.map(l => ({ ...l, order: l.id === 'warehouse' ? 1 : 0 }))
    expect(view(['tableau', 'cfo'], { layers: flipped }).lanes.map(l => l.layerId)).toEqual(['report', 'warehouse'])
  })

  it('unplaceable chains are COUNTED, never invented into a lane', () => {
    // Drop the warehouse assignments: nothing on that side is placeable, and a
    // curated view does not let a rule place `snowflake` either.
    const v = view(['tableau', 'cfo'], { assignments: { tableau: { layerId: 'report' } } })
    expect(v.lanes.map(l => l.layerId)).toEqual(['report'])
    // 7 unplaced participants, but ONE anchorless chain — they all top out at
    // the same unplaceable root (`snowflake`). Chains, not participants.
    expect(v.outsideView).toBe(1)
    expect(v.visible.has('INTERMEDIATE_T2')).toBe(false)
  })
})

describe('lanesToHierarchy — the VISIBLE tree', () => {
  it('a closed partner emits no children but keeps its chevron count', () => {
    const lanes = lanesToHierarchy(view(['tableau', 'cfo']).lanes)
    const warehouse = lanes.find(l => l.layerId === 'warehouse')!
    const t2 = warehouse.nodes.find(n => n.id === 'INTERMEDIATE_T2')!
    expect(t2.children).toEqual([])            // closed — the reader has not opened it
    expect(t2.data.childCount).toBe(1)         // the chevron still knows there is one inside
    expect(t2.data.onLineage).toBe(3)
    expect(t2.data.traceRole).toBe('up')

    // The focus chain IS open, so it nests the whole way down to the closed chart.
    const report = lanes.find(l => l.layerId === 'report')!
    const tableau = report.nodes[0]
    expect(tableau.children.map(c => c.id)).toEqual(['cfo'])
    expect(tableau.children[0].children.map(c => c.id)).toEqual(['aov'])
    expect(tableau.children[0].children[0].children).toEqual([])   // aov closed
    expect(tableau.children[0].children[0].data.childCount).toBe(2)
  })
})

/** The CFO estate plus a SECOND upstream hop: SRC ⊃ src ⊃ src.f → orders.channel. */
const node = (urn: string, type: string, childCount = 0): LensWalkNode => ({
  id: urn, type: 'default', position: { x: 0, y: 0 },
  data: { urn, label: urn, type, childCount }, urn, displayName: urn, entityType: type,
}) as unknown as LensWalkNode

const twoHopEstate = () => {
  const e = cfoEstate()
  const model: LensWalkModel = {
    ...e.model,
    nodes: [...e.model.nodes, node('SRC', 'container', 1), node('src', 'dataset', 1), node('src.f', 'schemaField')],
    containmentEdges: [...e.model.containmentEdges,
      { sourceUrn: 'SRC', targetUrn: 'src' }, { sourceUrn: 'src', targetUrn: 'src.f' }],
    lineageEdges: [...e.model.lineageEdges,
      { id: 'r:src.f>orders.channel', sourceUrn: 'src.f', targetUrn: 'orders.channel', edgeType: 'TRANSFORMS', kind: 'raw' as const, weight: null }],
  }
  return { ...e, model, assignments: { ...e.assignments, SRC: { layerId: 'warehouse' } } }
}

describe('buildTraceView — finite depth', () => {
  const at = (depthUp: number) => {
    const e = twoHopEstate()
    return buildTraceView({
      model: e.model, focusUrn: 'cfo', layers: e.layers, assignments: e.assignments, viewIsCurated: true,
      traceExpansion: new Set(['tableau', 'cfo']), showUpstream: true, showDownstream: true, depthUp, depthDown: 25,
    })
  }
  const warehouse = (depthUp: number) => at(depthUp).lanes.find(l => l.layerId === 'warehouse')!

  it('depth 1 keeps the first hop and drops the second chain, hosts included', () => {
    expect(warehouse(1).roots.map(r => r.id)).toEqual(['INTERMEDIATE_T2', 'REPORTING'])
    expect(warehouse(1).cards.has('src.f')).toBe(false)   // hop 2, out of scope
    expect(warehouse(1).cards.has('SRC')).toBe(false)     // its host goes with it
  })

  it('depth 2 admits the second chain at its own anchor', () => {
    expect(warehouse(2).roots.map(r => r.id)).toEqual(['INTERMEDIATE_T2', 'REPORTING', 'SRC'])
    expect(warehouse(2).cards.get('src.f')!.hop).toBe(2)
    expect(warehouse(2).cards.get('src.f')!.role).toBe('up')
  })
})

describe('buildTraceView — Roots ⊃ Node ×10 (self-nesting, level-less)', () => {
  const deep = () => {
    const e = rootsNodeEstate(10)
    return buildTraceView({
      model: e.model, focusUrn: e.model.focusUrn, layers: e.layers, assignments: e.assignments, viewIsCurated: true,
      traceExpansion: new Set(e.model.nodes.map(n => n.urn)),
      showUpstream: true, showDownstream: true, depthUp: 25, depthDown: 25,
    })
  }

  it('full chain expanded → every level visible, childCount preserved at every level', () => {
    const v = deep()
    const lane = v.lanes.find(l => l.layerId === 'roots')!
    expect(lane.roots.map(r => r.id)).toEqual(['ROOT'])     // the only VIEW-placed ancestor
    expect(lane.cards.size).toBe(21)                        // ROOT + a1..a10 + b1..b10
    expect(v.outsideView).toBe(0)

    for (const urn of ['ROOT', 'a1', 'a5', 'a9', 'a10', 'b1', 'b5', 'b9', 'b10']) {
      expect(v.visible.has(urn)).toBe(true)
    }
    expect(lane.cards.get('ROOT')!.childCount).toBe(2)
    for (const chain of ['a', 'b']) {
      for (let d = 1; d <= 9; d++) {
        const card = lane.cards.get(`${chain}${d}`)!
        expect(card.childCount).toBe(1)                     // graph-counted, NEVER children.length
        expect(card.depth).toBe(d)                          // depth relative to the lane root
      }
      expect(lane.cards.get(`${chain}10`)!.childCount).toBe(0)
      expect(lane.cards.get(`${chain}10`)!.depth).toBe(10)
    }
  })

  it('lanesToHierarchy nests to the full depth and carries the trace counts', () => {
    const lane = deep().lanes.find(l => l.layerId === 'roots')!
    const [{ layerId, nodes }] = lanesToHierarchy([lane])
    expect(layerId).toBe('roots')
    expect(nodes).toHaveLength(1)
    const root = nodes[0]
    expect(root.id).toBe('ROOT')
    expect(root.urn).toBe('ROOT')
    expect(root.data.childCount).toBe(2)
    expect(root.children.map(c => c.id)).toEqual(['a1', 'b1'])

    let cursor = root.children[0]
    for (let d = 1; d <= 10; d++) {
      expect(cursor.id).toBe(`a${d}`)
      expect(cursor.depth).toBe(d)
      expect(cursor.parentId).toBe(d === 1 ? 'ROOT' : `a${d - 1}`)
      expect(cursor.data.childCount).toBe(d < 10 ? 1 : 0)
      expect(cursor.data.traceRole).toBeDefined()
      if (d < 10) cursor = cursor.children[0]
    }
    expect(cursor.children).toEqual([])
  })
})

describe('lanesToRenderTrees — the canvas\'s render source', () => {
  // The canvas draws from three shapes: what each column renders, and the
  // flat list + id map its own hooks index by. They must agree with each
  // other and with the VISIBLE tree — a map holding a card no column draws
  // is how an edge gets projected onto a row that is not there.
  it('keys columns by layer and indexes exactly the cards those columns draw', () => {
    const v = view(['tableau', 'cfo'])
    const { byLayer, flat, map } = lanesToRenderTrees(v.lanes)

    expect([...byLayer.keys()]).toEqual(v.lanes.map(l => l.layerId))
    expect(byLayer.get('warehouse')!.map(n => n.id)).toEqual(['INTERMEDIATE_T2', 'REPORTING'])
    expect(byLayer.get('report')!.map(n => n.id)).toEqual(['tableau'])

    // flat and map are the SAME set, and it is the visible set.
    expect(flat.map(n => n.id).sort()).toEqual([...v.visible].sort())
    expect([...map.keys()].sort()).toEqual([...v.visible].sort())
    for (const node of flat) expect(map.get(node.id)).toBe(node)
  })

  it('descends into open cards and stops at closed ones', () => {
    const closed = lanesToRenderTrees(view(['tableau', 'cfo']).lanes)
    expect(closed.map.has('orders')).toBe(false)

    const open = lanesToRenderTrees(view(['tableau', 'cfo', 'INTERMEDIATE_T2']).lanes)
    expect(open.map.has('orders')).toBe(true)
    expect(open.byLayer.get('warehouse')![0].children.map(n => n.id)).toEqual(['orders'])
    // One level only — `orders` stays closed, so its columns are not indexed.
    expect(open.map.has('orders.channel')).toBe(false)
  })

  it('a layer with no lane simply has no entry — the column renders empty', () => {
    const { byLayer } = lanesToRenderTrees(view(['tableau', 'cfo'], { showUpstream: false }).lanes)
    expect(byLayer.has('warehouse')).toBe(false)
  })

  it('carries the trace counts the renderer reads for chevrons and pills', () => {
    const { map } = lanesToRenderTrees(view(['tableau', 'cfo']).lanes)
    const t2 = map.get('INTERMEDIATE_T2')!
    expect(t2.data.childCount).toBe(1)      // the GRAPH's count — the chevron
    expect(t2.data.onLineage).toBe(3)       // orders + its two columns
    expect(t2.data.traceRole).toBe('up')
  })
})
