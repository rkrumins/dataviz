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
import { buildTraceView, lanesToHierarchy } from '../traceViewModel'
import { cfoEstate, rootsNodeEstate } from '@/test/fixtures/traceEstates'
import type { TraceViewInputs } from '../traceViewModel'

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
