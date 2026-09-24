/**
 * Where an entity from OUTSIDE the source view lands in the subset.
 *
 * The view's own layer rules decide first — the same compiled rules the
 * canvas places by (buildLayerRules), so an entity the rules would put in
 * "Marts" lands in Marts. Where no rule speaks, it lands one layer beyond the
 * entity it was grown from: before it when growing upstream, after it when
 * growing downstream, held to the view's first and last layers. Either way
 * the reader sees where it went and can move it.
 */
import {
  resolveLayerAssignmentIn,
  type GraphNode,
  type LayerAssignmentRule,
} from '@/providers/GraphDataProvider'

import type { GrowDirection } from './grow'

export interface Placement {
  layerId: string
  /** A layer rule placed it (rather than its neighbour's position). */
  byRule: boolean
}

export function placeOutside(
  node: GraphNode,
  sortedRules: readonly LayerAssignmentRule[],
  layerOrder: readonly string[],
  fromLayerId: string,
  direction: GrowDirection,
): Placement {
  const byRule = resolveLayerAssignmentIn(node, sortedRules)
  if (byRule && layerOrder.includes(byRule)) return { layerId: byRule, byRule: true }
  const at = Math.max(0, layerOrder.indexOf(fromLayerId))
  const step = direction === 'upstream' ? -1 : 1
  const index = Math.max(0, Math.min(layerOrder.length - 1, at + step))
  return { layerId: layerOrder[index] ?? fromLayerId, byRule: false }
}
