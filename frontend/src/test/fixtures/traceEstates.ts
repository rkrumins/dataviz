import type { LensWalkModel, LensWalkNode } from '@/components/canvas/context-view/lens/closure-adapter'
import type { ViewLayerConfig } from '@/types/schema'

const wn = (urn: string, type: string, childCount = 0): LensWalkNode => ({
  id: urn, type: 'default', position: { x: 0, y: 0 },
  data: { urn, label: urn, type, childCount }, urn, displayName: urn, entityType: type,
}) as unknown as LensWalkNode
const raw = (s: string, t: string) => ({ id: `r:${s}>${t}`, sourceUrn: s, targetUrn: t, edgeType: 'TRANSFORMS', kind: 'raw' as const, weight: null })
const roll = (s: string, t: string, w: number) => ({ id: `g:${s}>${t}`, sourceUrn: s, targetUrn: t, edgeType: 'AGGREGATED', kind: 'rollup' as const, weight: w })
const has = (p: string, c: string) => ({ sourceUrn: p, targetUrn: c })

export function cfoEstate() {
  // Report lane: Tableau ⊃ CFO Revenue Dashboard ⊃ {AOV by Channel ⊃ {channel, avg_order_value}}
  // Warehouse lane: INTERMEDIATE_T2 ⊃ int_clean_orders_t2 ⊃ {channel, net_revenue}; REPORTING ⊃ rpt_monthly_revenue ⊃ {channel, gross_profit}
  const nodes = [
    wn('tableau', 'dataPlatform', 1), wn('cfo', 'dashboard', 1), wn('aov', 'chart', 2), wn('aov.channel', 'schemaField'), wn('aov.avg', 'schemaField'),
    wn('INTERMEDIATE_T2', 'container', 1), wn('orders', 'dataset', 2), wn('orders.channel', 'schemaField'), wn('orders.net', 'schemaField'),
    wn('REPORTING', 'container', 1), wn('rpt', 'dataset', 2), wn('rpt.channel', 'schemaField'), wn('rpt.gross', 'schemaField'),
    wn('snowflake', 'dataPlatform', 2),
  ]
  const containmentEdges = [
    has('tableau', 'cfo'), has('cfo', 'aov'), has('aov', 'aov.channel'), has('aov', 'aov.avg'),
    has('snowflake', 'INTERMEDIATE_T2'), has('snowflake', 'REPORTING'),
    has('INTERMEDIATE_T2', 'orders'), has('orders', 'orders.channel'), has('orders', 'orders.net'),
    has('REPORTING', 'rpt'), has('rpt', 'rpt.channel'), has('rpt', 'rpt.gross'),
  ]
  const lineageEdges = [
    raw('orders.channel', 'aov.channel'), raw('orders.net', 'aov.avg'), raw('rpt.gross', 'aov.avg'),
    roll('orders', 'aov', 2), roll('rpt', 'aov', 1), roll('INTERMEDIATE_T2', 'cfo', 2), roll('REPORTING', 'cfo', 1),
  ]
  const model: LensWalkModel = {
    focusUrn: 'cfo', nodes, lineageEdges, containmentEdges,
    upstreamUrns: new Set(['orders.channel', 'orders.net', 'rpt.gross', 'orders', 'rpt', 'INTERMEDIATE_T2', 'REPORTING']),
    downstreamUrns: new Set(), frontierUp: [], frontierDown: [], truncated: false, truncationReason: null,
    seedTruncated: false, seedCursor: null,
  }
  const layers: ViewLayerConfig[] = [
    { id: 'warehouse', name: 'Warehouse', order: 0, entityTypes: ['container'] },
    { id: 'report', name: 'Report', order: 1, entityTypes: ['dataPlatform'] },
  ]
  // The VIEW anchors at the container (not the platform) for the warehouse side — the screenshot's truth.
  const assignments = { INTERMEDIATE_T2: { layerId: 'warehouse' }, REPORTING: { layerId: 'warehouse' }, tableau: { layerId: 'report' } }
  return { model, layers, assignments }
}

export function rootsNodeEstate(depth: 3 | 10) {
  // Roots ⊃ Node ⊃ … ⊃ Node (depth levels) with lineage at the deepest level between two sibling chains.
  const nodes: LensWalkNode[] = [wn('ROOT', 'Roots', 2)]
  const containmentEdges: Array<{ sourceUrn: string; targetUrn: string }> = []
  for (const chain of ['a', 'b']) {
    let parent = 'ROOT'
    for (let d = 1; d <= depth; d++) {
      const urn = `${chain}${d}`
      nodes.push(wn(urn, 'Node', d < depth ? 1 : 0))
      containmentEdges.push(has(parent, urn)); parent = urn
    }
  }
  const lineageEdges = [raw(`a${depth}`, `b${depth}`)]
  const model: LensWalkModel = {
    focusUrn: `a${Math.max(1, depth - 1)}`, nodes, lineageEdges, containmentEdges,
    upstreamUrns: new Set(), downstreamUrns: new Set([`b${depth}`]), frontierUp: [], frontierDown: [],
    truncated: false, truncationReason: null, seedTruncated: false, seedCursor: null,
  }
  const layers: ViewLayerConfig[] = [{ id: 'roots', name: 'Roots', order: 0, entityTypes: ['Roots'] }]
  return { model, layers, assignments: { ROOT: { layerId: 'roots' } } }
}
