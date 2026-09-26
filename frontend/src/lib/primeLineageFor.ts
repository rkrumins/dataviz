/**
 * Fetch the lineage of nodes that have just arrived on the canvas.
 *
 * Neither path that ADDS nodes brings their flows with them:
 *
 *   • A search reveal primes the spine with CONTAINMENT only — that is what
 *     attaches the hit to its parents.
 *   • A child page asks the server for lineage, but the server answers with
 *     "cross-child lineage edges (scoped to current page only)" — edges
 *     BETWEEN the children it returned, deliberately, to keep that query
 *     O(pageSize²). A child's flow to anything already on the canvas is not
 *     in that answer.
 *
 * So a hit opened from Advanced Search, or a row from "Load 13 more", landed
 * with no lineage at all: the drawer listed its connections while the canvas
 * drew nothing, and Trace or the Focus Lens were the only ways to see them.
 *
 * Two indexed lookups per call, both capped. Best-effort by design: an edge
 * whose partner is not on the canvas does not resolve (the projection rolls
 * it up to a visible ancestor where it can, and counts it where it cannot),
 * and a failure costs those rows their flows, not the reveal or the page.
 */
import type { GraphDataProvider } from '@/providers/GraphDataProvider'
import type { LineageEdge } from '@/store/canvas'
import { toCanvasEdge } from '@/lib/canvasNodeMapper'

/** Per-direction cap, so one hub cannot stall a reveal or a page. */
export const PRIME_LINEAGE_LIMIT = 500

export async function primeLineageFor(
  provider: GraphDataProvider | null | undefined,
  urns: readonly string[],
  lineageEdgeTypes: readonly string[],
  limit: number = PRIME_LINEAGE_LIMIT,
): Promise<LineageEdge[]> {
  if (!provider || typeof provider.getEdges !== 'function' || urns.length === 0) return []
  const types = lineageEdgeTypes.length > 0 ? [...lineageEdgeTypes] : undefined
  const [out, incoming] = await Promise.all([
    provider.getEdges({ sourceUrns: [...urns], edgeTypes: types, limit }),
    provider.getEdges({ targetUrns: [...urns], edgeTypes: types, limit }),
  ])
  const seen = new Set<string>()
  const edges: LineageEdge[] = []
  for (const e of [...out, ...incoming]) {
    if (seen.has(e.id)) continue
    seen.add(e.id)
    edges.push(toCanvasEdge(e))
  }
  return edges
}
