/**
 * Flow-ribbon aggregation — the macro view of lineage volume.
 *
 * In Adaptive mode above the edge budget, individual curves can only
 * show the strongest flows; ribbons aggregate EVERY projected edge by
 * (source layer → target layer) pair so total volume between columns
 * stays legible as a handful of Sankey-style bands. Pure function so
 * the canvas memoizes it per edge-set change.
 */

export interface FlowRibbon {
  sourceLayerId: string
  targetLayerId: string
  /** Total underlying edge count (bundles contribute their edgeCount). */
  count: number
}

export const MAX_FLOW_RIBBONS = 12

export function aggregateFlowRibbons(
  edges: Array<{ source: string; target: string; edgeCount?: number }>,
  nodeLayerMap: Map<string, string>,
  layerOrder: string[],
  top: number = MAX_FLOW_RIBBONS,
): FlowRibbon[] {
  const order = new Map(layerOrder.map((id, i) => [id, i]))
  const byPair = new Map<string, FlowRibbon>()
  for (const e of edges) {
    const sLayer = nodeLayerMap.get(e.source)
    const tLayer = nodeLayerMap.get(e.target)
    if (!sLayer || !tLayer || sLayer === tLayer) continue
    if (!order.has(sLayer) || !order.has(tLayer)) continue
    const key = `${sLayer}->${tLayer}`
    const existing = byPair.get(key)
    const weight = e.edgeCount || 1
    if (existing) existing.count += weight
    else byPair.set(key, { sourceLayerId: sLayer, targetLayerId: tLayer, count: weight })
  }
  return [...byPair.values()]
    .sort((a, b) => b.count - a.count)
    .slice(0, top)
    // Stable presentation order: left-to-right by source column, then target.
    .sort((a, b) =>
      (order.get(a.sourceLayerId)! - order.get(b.sourceLayerId)!)
      || (order.get(a.targetLayerId)! - order.get(b.targetLayerId)!))
}

/** Compact count label: 12,431 → "12.4k". */
export function formatRibbonCount(count: number): string {
  if (count >= 1000) {
    const k = count / 1000
    return `${k >= 100 ? Math.round(k) : k.toFixed(1).replace(/\.0$/, '')}k`
  }
  return String(count)
}
