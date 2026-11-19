/**
 * Load entities onto the canvas where the view the server places draws them — a search hit
 * shown, a narrowing's members, a trace's cards — wherever they fall in their layer's pages.
 *
 * Each comes as its layer's pages list it (`ancestorPath`, `inLayer`), tagged for that layer
 * (`withFeedLayer`), so it is drawn there, inside the containers its layer draws it in: those
 * are context rows built from its path, so nothing more is loaded for them. Its edges are read
 * as a page's are (lib/feedPageEdges), and each batch lands as ONE store write. Entities the
 * canvas already holds in their layer are not asked about again.
 */
import { toCanvasEdge, toCanvasNode, withFeedLayer } from '@/lib/canvasNodeMapper'
import { edgesForPage } from '@/lib/feedPageEdges'
import type { GraphDataProvider } from '@/providers/GraphDataProvider'
import { useCanvasStore } from '@/store/canvas'

import type { LoadProgress, LoadResult, Priority, ServedPlacementsApi } from './types'

export interface LoadIntoCanvasOptions {
  containmentEdgeTypes: string[]
  lineageEdgeTypes: string[]
  signal?: AbortSignal
  priority?: Priority
  onProgress?: (p: LoadProgress) => void
}

export interface LoadedIntoCanvas {
  /** On the canvas in their layer now: loaded here, or held already. */
  loaded: string[]
  /** Drawn nowhere in this view. */
  outside: string[]
  /** Couldn't be asked about (after retries), or their node didn't come. */
  failed: string[]
}

export async function loadIntoCanvas(
  service: ServedPlacementsApi,
  provider: Pick<GraphDataProvider, 'getEdges' | 'getEdgesBetween'>,
  urns: readonly string[],
  opts: LoadIntoCanvasOptions,
): Promise<LoadedIntoCanvas> {
  const held = new Set<string>()
  for (const n of useCanvasStore.getState().nodes) if (n.data?.feedLayerId) held.add(n.id)
  const unique = [...new Set(urns)]
  const loaded = unique.filter((u) => held.has(u))
  const ask = unique.filter((u) => !held.has(u))
  if (ask.length === 0) return { loaded, outside: [], failed: [] }

  const generation = useCanvasStore.getState().graphGeneration
  // A new graph was set meanwhile, or the caller stopped: a batch belongs to neither.
  const stale = () => !!opts.signal?.aborted || useCanvasStore.getState().graphGeneration !== generation
  const landing: Array<Promise<void>> = []
  const land = async (batch: LoadResult['nodes']): Promise<void> => {
    if (stale()) return
    const pageUrns = batch.map((b) => b.node.urn)
    // Read as a layer's own page reads them: its containment and the lineage touching it.
    const edges = await edgesForPage(provider, pageUrns, {
      entityTypes: [],
      schemaEntityTypes: [],
      containmentEdgeTypes: opts.containmentEdgeTypes,
      lineageEdgeTypes: opts.lineageEdgeTypes,
    }, stale)
    if (edges === null) return
    const nodes = batch.map(({ node, layerId }) => {
      const n = toCanvasNode(withFeedLayer(node, layerId))
      n.data.viaServed = true
      return n
    })
    useCanvasStore.getState().addGraph(nodes, edges.map((e) => toCanvasEdge(e)))
    for (const u of pageUrns) loaded.push(u)
  }

  const result = await service.load(ask, {
    ...(opts.signal ? { signal: opts.signal } : {}),
    ...(opts.priority ? { priority: opts.priority } : {}),
    ...(opts.onProgress ? { onProgress: opts.onProgress } : {}),
    onNodes: (batch) => { landing.push(land(batch)) },
  })
  await Promise.all(landing)
  // Placed in a layer, but on a graph since replaced: not on this canvas.
  const landed = new Set(loaded)
  const notLanded = result.nodes.map((b) => b.node.urn).filter((u) => !landed.has(u))
  return { loaded, outside: result.outside, failed: [...result.failed, ...notLanded] }
}
