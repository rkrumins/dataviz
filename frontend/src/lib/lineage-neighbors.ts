/**
 * Shared 1-hop lineage neighbor derivation.
 *
 * Consumed by BOTH the EntityDrawer's LineageNeighbors section and the
 * canvas Lineage Lens so their counts and groupings always agree. Data
 * contract mirrors the canvas: pass `visibleEdges` (the projected /
 * aggregated set the canvas renders) when non-empty, raw `edges`
 * otherwise; containment edges are excluded — this is flow lineage.
 */
import type { LineageNode, LineageEdge } from '@/store/canvas'
import { normalizeEdgeType, isContainmentEdgeType } from '@/store/schema'

export type NeighborDirection = 'incoming' | 'outgoing'

export interface NeighborRecord {
  edge: LineageEdge
  neighborId: string
  neighborNode: LineageNode | undefined
  direction: NeighborDirection
  edgeTypeNorm: string
}

export function deriveNeighborRecords(
  nodeId: string,
  edges: LineageEdge[],
  nodeMap: Map<string, LineageNode>,
  containmentEdgeTypes: string[],
): { incomingRecords: NeighborRecord[]; outgoingRecords: NeighborRecord[] } {
  const incoming: NeighborRecord[] = []
  const outgoing: NeighborRecord[] = []
  for (const e of edges) {
    const isIn = e.target === nodeId && e.source !== nodeId
    const isOut = e.source === nodeId && e.target !== nodeId
    if (!isIn && !isOut) continue
    const edgeTypeNorm = normalizeEdgeType(e)
    if (isContainmentEdgeType(edgeTypeNorm, containmentEdgeTypes)) continue
    const record: NeighborRecord = {
      edge: e,
      neighborId: isIn ? e.source : e.target,
      neighborNode: nodeMap.get(isIn ? e.source : e.target),
      direction: isIn ? 'incoming' : 'outgoing',
      edgeTypeNorm,
    }
    if (isIn) incoming.push(record)
    else outgoing.push(record)
  }
  return { incomingRecords: incoming, outgoingRecords: outgoing }
}
