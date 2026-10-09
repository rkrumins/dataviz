/**
 * traceViewModel under the One Placement Contract (placementContractEnabled): with `placement.spec`
 * the walk is placed by lib/placement, and a participant anchors at the TOP of its run of same-layer
 * ancestors — so a child placed in another column heads its own lane, and one the view does not
 * place is outside it. The legacy climb ("highest placed ancestor") is pinned, unedited, by the
 * other traceViewModel.* suites.
 */
import { describe, expect, it } from 'vitest'

import type { LensWalkModel, LensWalkNode } from '@/components/canvas/context-view/lens/closure-adapter'
import { compilePlacementSpec } from '@/lib/placement/placement'
import * as estates from '@/test/fixtures/traceEstates'
import type { ViewLayerConfig } from '@/types/schema'

import { placeCanvasNodes } from '../placeCanvasNodes'
import { buildTraceView, type TraceView, type TraceViewInputs } from '../traceViewModel'

const wn = (urn: string, type: string): LensWalkNode => ({
  id: urn, type: 'default', position: { x: 0, y: 0 },
  data: { urn, label: urn, type, childCount: 0 }, urn, displayName: urn, entityType: type,
}) as unknown as LensWalkNode
const raw = (s: string, t: string) => ({ id: `r:${s}>${t}`, sourceUrn: s, targetUrn: t, edgeType: 'TRANSFORMS', kind: 'raw' as const, weight: null })
const has = (p: string, c: string) => ({ sourceUrn: p, targetUrn: c })

function model(focusUrn: string, nodes: LensWalkNode[], containmentEdges: { sourceUrn: string; targetUrn: string }[],
  lineageEdges: ReturnType<typeof raw>[], upstream: string[]): LensWalkModel {
  return {
    focusUrn, nodes, lineageEdges, containmentEdges,
    upstreamUrns: new Set(upstream), downstreamUrns: new Set(), frontierUp: [], frontierDown: [],
    truncated: false, truncationReason: null, seedTruncated: false, seedCursor: null,
  }
}

type Assignments = Record<string, { layerId: string; inheritsChildren?: boolean }>

const specOf = (layers: ViewLayerConfig[], assignments: Assignments, scope?: 'all' | 'curated') =>
  compilePlacementSpec({ content: scope ? { entityScope: scope } : {}, layout: { referenceLayout: { layers, assignments } } })

function view(m: LensWalkModel, layers: ViewLayerConfig[], assignments: Assignments, opts: {
  scope?: 'all' | 'curated'
  expansion?: string[]
  branchCreatedUrns?: Set<string>
} = {}): TraceView {
  const inputs: TraceViewInputs = {
    model: m, focusUrn: m.focusUrn, layers, assignments, viewIsCurated: specOf(layers, assignments, opts.scope).scope === 'curated',
    traceExpansion: new Set(opts.expansion ?? []), showUpstream: true, showDownstream: true, depthUp: 25, depthDown: 25,
    placement: { spec: specOf(layers, assignments, opts.scope), branchCreatedUrns: opts.branchCreatedUrns },
  }
  return buildTraceView(inputs)
}

const roots = (v: TraceView) => Object.fromEntries(v.lanes.map(l => [l.layerId, l.roots.map(r => r.id).sort()]))

describe('buildTraceView — One Placement Contract', () => {
  it('anchors the CFO estate where the canvas places it, the platform outside the view', () => {
    const e = estates.cfoEstate()
    const v = view(e.model, e.layers, e.assignments, { expansion: ['tableau', 'cfo'] })
    expect(roots(v)).toEqual({ warehouse: ['INTERMEDIATE_T2', 'REPORTING'], report: ['tableau'] })
    expect(v.outsideView).toBe(0)
  })

  it('anchors at the top of the SAME-layer run, not the highest placed ancestor', () => {
    const e = estates.cfoEstate()
    const v = view(e.model, e.layers, { ...e.assignments, snowflake: { layerId: 'report' } }, { expansion: ['tableau', 'cfo'] })
    expect(roots(v).warehouse).toEqual(['INTERMEDIATE_T2', 'REPORTING'])
    expect(roots(v).report).toEqual(['tableau'])        // snowflake hosts nothing in its own column
  })

  it('a child placed by its own rule heads its own lane in that column', () => {
    const layers: ViewLayerConfig[] = [
      { id: 'left', name: 'Left', order: 0, entityTypes: ['container'] },
      { id: 'right', name: 'Right', order: 1, entityTypes: ['dataset'] },
      { id: 'rep', name: 'Reports', order: 2, entityTypes: ['dashboard'] },
    ]
    const m = model('F', [wn('P', 'container'), wn('P.C', 'dataset'), wn('F', 'dashboard')],
      [has('P', 'P.C')], [raw('P.C', 'F')], ['P.C'])
    const v = view(m, layers, {})
    expect(roots(v)).toEqual({ right: ['P.C'], rep: ['F'] })
  })

  it('a hand placement cascades over the child\'s own rule: it stays nested under its parent', () => {
    const layers: ViewLayerConfig[] = [
      { id: 'left', name: 'Left', order: 0, entityTypes: [] },
      { id: 'right', name: 'Right', order: 1, entityTypes: ['dataset'] },
      { id: 'rep', name: 'Reports', order: 2, entityTypes: ['dashboard'] },
    ]
    const m = model('F', [wn('P', 'container'), wn('P.C', 'dataset'), wn('F', 'dashboard')],
      [has('P', 'P.C')], [raw('P.C', 'F')], ['P.C'])
    const v = view(m, layers, { P: { layerId: 'left' } }, { scope: 'all' })
    expect(roots(v)).toEqual({ left: ['P'], rep: ['F'] })
    expect(v.lanes.find(l => l.layerId === 'left')!.cards.get('P.C')!.parentId).toBe('P')
  })

  it('an intermediate inheritsChildren:false entry leaves its child outside a curated view', () => {
    const layers: ViewLayerConfig[] = [{ id: 'left', name: 'Left', order: 0, entityTypes: [] }]
    const m = model('F', [wn('G', 'c'), wn('M', 'c'), wn('H', 'd'), wn('F', 'd')],
      [has('G', 'M'), has('M', 'H')], [raw('H', 'F')], ['H'])
    const v = view(m, layers, { G: { layerId: 'left' }, M: { layerId: 'left', inheritsChildren: false }, F: { layerId: 'left' } })
    expect(roots(v)).toEqual({ left: ['F'] })
    expect(v.outsideView).toBe(1)
  })

  it('places a partner the curated view does not list only when it was created in this draft', () => {
    const layers: ViewLayerConfig[] = [{ id: 'left', name: 'Left', order: 0, entityTypes: [] }]
    const stamped = { ...wn('N', 'd'), data: { urn: 'N', label: 'N', type: 'd', layerAssignment: 'left' } } as unknown as LensWalkNode
    const m = model('F', [stamped, wn('F', 'd')], [], [raw('N', 'F')], ['N'])
    expect(roots(view(m, layers, { F: { layerId: 'left' } }))).toEqual({ left: ['F'] })
    expect(roots(view(m, layers, { F: { layerId: 'left' } }, { branchCreatedUrns: new Set(['N']) }))).toEqual({ left: ['F', 'N'] })
  })

  // The placement parity the trace overlay design promises: a card lands in the column the canvas
  // behind it would place the same node in.
  const fixtures: Array<[string, () => { model: LensWalkModel; layers: ViewLayerConfig[]; assignments: Assignments }]> = [
    ['cfoEstate', estates.cfoEstate],
    ['rootsNodeEstate(3)', () => estates.rootsNodeEstate(3)],
    ['tableEstate', estates.tableEstate],
    ['twoSeedEstate', estates.twoSeedEstate],
    ['splitChildEstate', estates.splitChildEstate],
    ['perTypeEstate', estates.perTypeEstate],
    ['snowflakeColumnEstate', estates.snowflakeColumnEstate],
  ]
  it.each(fixtures)('%s: every participant\'s lane is the column the canvas places it in', (_name, make) => {
    const e = make()
    const spec = specOf(e.layers, e.assignments)
    const v = view(e.model, e.layers, e.assignments)
    const nodeMap = new Map(e.model.nodes.map(n => [n.urn, n as { data?: Record<string, unknown> }]))
    const parentMap = new Map<string, string>()
    const childMap = new Map<string, string[]>()
    for (const c of e.model.containmentEdges) {
      if (!parentMap.has(c.targetUrn)) parentMap.set(c.targetUrn, c.sourceUrn)
      childMap.set(c.sourceUrn, [...(childMap.get(c.sourceUrn) ?? []), c.targetUrn])
    }
    const canvas = placeCanvasNodes({
      spec, nodes: e.model.nodes.map(n => ({ id: n.urn })), nodeMap, parentMap, childMap,
      chains: new Map(), createdInBranch: new Set(),
    })
    let checked = 0
    for (const lane of v.lanes) {
      for (const card of lane.cards.values()) {
        if (card.role === 'host') continue
        expect(canvas.get(card.urn)?.layerId, card.urn).toBe(lane.layerId)
        checked += 1
      }
    }
    expect(checked).toBeGreaterThan(0)
  })
})
