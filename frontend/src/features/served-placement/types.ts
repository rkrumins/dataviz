/**
 * Where a view the server places draws each entity — the contract every part of the canvas
 * reads it through (search results, Show on canvas, Narrow, lineage cues, the trace).
 *
 * One `ServedPlacements` per canvas while it shows a view made from a query or a subset view.
 * Backed by `POST /view-placements` (with `nodes` when the entity is to be loaded): asks are
 * merged within a tick, sent in batches two at a time, answers kept in one map changed in
 * place (`version` counts the answers), and a server that was slow or busy asked again.
 */
import type { GraphNode } from '@/providers/GraphDataProvider'
import type { PlacementSource } from '@/types/membership'

export interface Placed {
  /** The layer the view draws it in; null: nowhere in this view. */
  layerId: string | null
  source: PlacementSource
  /** How many of its nearest containers are drawn in the same layer. */
  inLayer?: number | null
}

export type UrnState = 'unknown' | 'asking' | 'placed' | 'failed'
export type Priority = 'now' | 'background'

export interface LoadProgress {
  done: number
  total: number
  placed: number
  outside: number
  failed: number
}

export interface LoadResult {
  /** Each entity the view draws, with the layer it is drawn in (its node tagged for it). */
  nodes: Array<{ node: GraphNode; layerId: string }>
  /** Asked about, and drawn nowhere in this view. */
  outside: string[]
  /** Couldn't be asked about (after retries) — `retryFailed()` asks again. */
  failed: string[]
}

export interface ServedPlacementsApi {
  get(urn: string): Placed | undefined
  stateOf(urn: string): UrnState
  /** Where each is drawn — asked once, kept; null for one that couldn't be asked. */
  placeOf(urns: readonly string[], opts?: { signal?: AbortSignal; priority?: Priority }): Promise<ReadonlyMap<string, Placed | null>>
  /** As `placeOf`, with the nodes of those it draws, ready to load. `onNodes`: each batch's
   *  nodes as it is answered, so a caller can draw them before the last batch is in. */
  load(urns: readonly string[], opts?: {
    signal?: AbortSignal
    priority?: Priority
    onProgress?: (p: LoadProgress) => void
    onNodes?: (nodes: LoadResult['nodes']) => void
  }): Promise<LoadResult>
  counts(urns?: Iterable<string>): { placed: number; asking: number; failed: number; outside: number }
  retryFailed(): void
  reset(): void
  subscribe(fn: () => void): () => void
  readonly version: number
  /** The server can't place for this view (422/403/404/409): callers place as they always have. */
  readonly unavailable: null | { status: number; reason?: string }
}
