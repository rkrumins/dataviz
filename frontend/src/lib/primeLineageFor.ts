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
 * Two indexed lookups per batch of rows, both capped. Best-effort by design:
 * an edge whose partner is not on the canvas does not resolve (the projection
 * rolls it up to a visible ancestor where it can, and counts it where it
 * cannot), and a failure costs those rows their flows, not the reveal or the
 * page.
 *
 * The cap is per BATCH (PRIME_BATCH rows), asked one batch after another: over
 * a whole page of 100 rows, one hub used the 500 up and the rows after it got
 * nothing, silently. A direction that still comes back AT its cap was cut
 * short, and which rows lost flows cannot be told, so that batch's rows are
 * reported `partial` that way: their ports must not claim their lineage only
 * leaves the view. A failed batch costs its own rows; the call fails only
 * when every batch did.
 *
 * Flows only. The stored :AGGREGATED roll-up cells are never asked for (the
 * rows on screen get theirs from /edges/aggregated), and when the view
 * declares no lineage types the read is untyped, so its containment and
 * roll-up cells are dropped here.
 */
import type { GraphDataProvider, GraphEdge } from '@/providers/GraphDataProvider'
import type { LineageEdge } from '@/store/canvas'
import { toCanvasEdge } from '@/lib/canvasNodeMapper'

/** Per-direction cap, so one hub cannot stall a reveal or a page. */
export const PRIME_LINEAGE_LIMIT = 500

/** Rows per pair of lookups: the cap above is per batch. */
export const PRIME_BATCH = 25

export interface PrimedLineage {
  edges: LineageEdge[]
  /** Rows whose flows that way came back at the cap: there may be more. */
  partial: { in: string[]; out: string[] }
}

export async function primeLineageFor(
  provider: GraphDataProvider | null | undefined,
  urns: readonly string[],
  lineageEdgeTypes: readonly string[],
  containmentEdgeTypes: readonly string[] = [],
  limit: number = PRIME_LINEAGE_LIMIT,
): Promise<PrimedLineage> {
  const primed: PrimedLineage = { edges: [], partial: { in: [], out: [] } }
  if (!provider || typeof provider.getEdges !== 'function' || urns.length === 0) return primed
  const lineage = lineageEdgeTypes.filter((t) => t.toUpperCase() !== 'AGGREGATED')
  const types = lineage.length > 0 ? lineage : undefined
  const notFlows = new Set(['AGGREGATED', ...containmentEdgeTypes.map((t) => t.toUpperCase())])
  const seen = new Set<string>()
  let failure: unknown
  let answered = false
  for (let i = 0; i < urns.length; i += PRIME_BATCH) {
    const batch = urns.slice(i, i + PRIME_BATCH)
    let answer: [GraphEdge[], GraphEdge[]]
    try {
      answer = await Promise.all([
        provider.getEdges({ sourceUrns: batch, edgeTypes: types, limit }),
        provider.getEdges({ targetUrns: batch, edgeTypes: types, limit }),
      ])
    } catch (e) {
      failure ??= e
      continue
    }
    answered = true
    const [out, incoming] = answer
    if (out.length >= limit) primed.partial.out.push(...batch)
    if (incoming.length >= limit) primed.partial.in.push(...batch)
    for (const e of [...out, ...incoming]) {
      if (seen.has(e.id)) continue
      seen.add(e.id)
      if (notFlows.has(String(e.edgeType ?? '').toUpperCase())) continue
      primed.edges.push(toCanvasEdge(e))
    }
  }
  if (!answered) throw failure
  return primed
}
