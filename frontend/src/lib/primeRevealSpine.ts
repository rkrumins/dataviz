/**
 * Prime a reveal's spine: the nodes the store is missing along it, and the
 * containment edges that attach each one to the level above.
 *
 * With lazy children loading, only top-level entities are in the canvas store
 * after hydration, so every level below (and the target itself) must be
 * materialized before a reveal can open its way down. One getNodes call
 * covers the whole spine regardless of depth — with an explicit limit, as a
 * node query is paged by the server (100 by default) and a batch spine can be
 * longer than that. `viaReveal` marks these out-of-band nodes so
 * `loadChildren` doesn't count them as a loaded page (see useGraphHydration).
 *
 * Taken out of the search reveal (useRevealSearchHit) so another reveal can
 * share it. Never throws: a failed step costs the reveal what it would have
 * attached, and the caller lands as far as it can.
 */
import { useCanvasStore } from '@/store/canvas'
import { toCanvasNode, toCanvasEdge } from '@/lib/canvasNodeMapper'
import type { GraphDataProvider } from '@/providers/GraphDataProvider'

export async function primeRevealSpine(
  provider: GraphDataProvider,
  spineUrns: readonly string[],
  containmentEdgeTypes: readonly string[],
): Promise<void> {
  const loadedUrns = useCanvasStore.getState()._nodeIndex
  const missingUrns = spineUrns.filter((u) => !loadedUrns.has(u))
  if (missingUrns.length > 0) {
    try {
      const fetched = await provider.getNodes({ urns: missingUrns, limit: missingUrns.length })
      if (fetched.length > 0) {
        const { addGraph } = useCanvasStore.getState()
        addGraph(
          fetched.map((n) => {
            const node = toCanvasNode(n)
            return { ...node, data: { ...node.data, viaReveal: true } }
          }),
          [],
        )
      }
    } catch (e) {
      console.warn('[reveal] spine priming failed', e)
      // Continue — the walk will fall back to the deepest level it can open.
    }
  }

  // The containment edges, on EVERY reveal: they are what makes the
  // path-only walk possible at all. Each opened level draws its spine
  // child through one of these, and a hit that is the 300th child of
  // its parent has no other way to arrive. The missing NODES are not
  // the condition — a spine whose nodes all arrived on an earlier
  // reveal that lost its edges would otherwise never get them, and no
  // amount of re-clicking would fix it. `addGraph` dedupes and
  // /edges/between is response-cached, so the repeat is cheap. A
  // failure costs the hit its attachment, not the reveal.
  // A top-level hit has no spine to attach to — asking for the edges
  // within a single URN can only ever answer nothing.
  if (spineUrns.length > 1) {
    try {
      const edges = await provider.getEdgesBetween(
        [...spineUrns],
        containmentEdgeTypes.length > 0 ? [...containmentEdgeTypes] : undefined,
      )
      if (edges.length > 0) {
        useCanvasStore.getState().addGraph([], edges.map((e) => toCanvasEdge(e)))
      }
    } catch (e) {
      console.warn('[reveal] spine edge priming failed', e)
      // The canvas surfaces a degraded edge picture from this
      // flag; a reveal that lost its spine edges is exactly that,
      // and it used to fail in silence (cf. useGraphHydration's
      // cross-page supplement).
      useCanvasStore.getState().noteEdgeFetchFailure(
        e instanceof Error ? e.message : undefined,
      )
    }
  }
}
