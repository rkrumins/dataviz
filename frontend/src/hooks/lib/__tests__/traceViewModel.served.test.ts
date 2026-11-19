/**
 * traceViewModel in a view the server places (made from a query, or a search's matches): the
 * server says where each entity the trace reached is drawn (`placement.served`), and that alone
 * places the walk — a member where its row is, the rest where the view's layout puts them. An
 * entity the server hasn't answered for yet is pending: not drawn, and not outside the view.
 */
import { describe, expect, it } from 'vitest'

import type { LensWalkModel, LensWalkNode } from '@/components/canvas/context-view/lens/closure-adapter'
import type { ViewLayerConfig } from '@/types/schema'

import { buildTraceView, type TraceView } from '../traceViewModel'

const wn = (urn: string, type: string): LensWalkNode => ({
  id: urn, type: 'default', position: { x: 0, y: 0 },
  data: { urn, label: urn, type, childCount: 0 }, urn, displayName: urn, entityType: type,
}) as unknown as LensWalkNode
const raw = (s: string, t: string) => ({ id: `r:${s}>${t}`, sourceUrn: s, targetUrn: t, edgeType: 'TRANSFORMS', kind: 'raw' as const, weight: null })

// A list view: curated, nothing in its layout — its members are rows of its own table.
const layers: ViewLayerConfig[] = [
  { id: 'tables', name: 'Tables', entityTypes: ['dataset'], order: 0 } as ViewLayerConfig,
  { id: 'bi', name: 'BI', entityTypes: ['chart'], order: 1 } as ViewLayerConfig,
]
const m: LensWalkModel = {
  focusUrn: 'orders',
  nodes: [wn('orders', 'dataset'), wn('orders.amt', 'schemaField'), wn('ledger', 'dataset'), wn('ledger.amt', 'schemaField'),
    wn('kpi', 'chart'), wn('kpi.amt', 'schemaField')],
  containmentEdges: [
    { sourceUrn: 'orders', targetUrn: 'orders.amt' }, { sourceUrn: 'ledger', targetUrn: 'ledger.amt' },
    { sourceUrn: 'kpi', targetUrn: 'kpi.amt' },
  ],
  lineageEdges: [raw('ledger.amt', 'orders.amt'), raw('orders.amt', 'kpi.amt')],
  upstreamUrns: new Set(['ledger.amt']), downstreamUrns: new Set(['kpi.amt']),
  frontierUp: [], frontierDown: [], truncated: false, truncationReason: null, seedTruncated: false, seedCursor: null,
} as unknown as LensWalkModel

const view = (served?: ReadonlyMap<string, string | null>): TraceView => buildTraceView({
  model: m, focusUrn: 'orders', layers, assignments: {}, viewIsCurated: true,
  traceExpansion: new Set(['orders', 'ledger', 'kpi']), showUpstream: true, showDownstream: true, depthUp: 25, depthDown: 25,
  ...(served ? { placement: { served } } : {}),
})
const roots = (v: TraceView) => Object.fromEntries(v.lanes.filter(l => l.roots.length).map(l => [l.layerId, l.roots.map(r => r.id).sort()]))

describe('a trace in a view the server places', () => {
  it('without the server’s word, a list view places nothing: every chain is outside it', () => {
    const v = view()
    expect(roots(v)).toEqual({})
    expect(v.outsideView).toBeGreaterThan(0)
  })

  it('draws everything where the server says — members where they sit, the rest where the view puts them', () => {
    const v = view(new Map([
      ['orders', 'tables'], ['orders.amt', 'tables'], ['ledger', 'tables'], ['ledger.amt', 'tables'],
      ['kpi', 'bi'], ['kpi.amt', 'bi'],
    ]))
    expect(roots(v)).toEqual({ tables: ['ledger', 'orders'], bi: ['kpi'] })
    expect(v.outsideView).toBe(0)
    expect(v.pending).toBe(0)
  })

  it('what the server says is not in the view is outside it; what it hasn’t said yet is pending', () => {
    const v = view(new Map([['orders', 'tables'], ['orders.amt', 'tables'], ['kpi', null], ['kpi.amt', null]]))
    expect(roots(v)).toEqual({ tables: ['orders'] })
    expect(v.outsideView).toBe(1)
    expect(v.pending).toBeGreaterThan(0)
  })
})
