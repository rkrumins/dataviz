/**
 * useLensContainer — "open this container and show me only what's inside
 * it that connects to the entity I'm focused on."
 *
 * THE fix for coarse partners being dead ends. A DATAPLATFORM or
 * CONTAINER neighbour summarises many finer entities; the lens used to
 * try resolving them with `getEdges({sourceUrns:[C], targetUrns:[F]})`,
 * but that query matches URNs EXACTLY (backend: `a.urn IN $sourceUrns
 * AND b.urn IN $targetUrns`, no containment descent), so it returned
 * nothing whenever the real lineage lived on entities *inside* C.
 *
 * `provider.expandAggregated` is the primitive that actually does the
 * job: it collects the descendants of BOTH anchors and returns only the
 * edges strictly between those two sets — literally "the children of C
 * that carry lineage to F".
 *
 * Same contract as useLensLineage: one fetch per (container, focal,
 * direction) per lens session, explicit retry only (never a loop), a
 * session token so a closed lens can't resurrect stale results, and
 * NOTHING is written to the canvas store — exploring in the lens never
 * mutates a curated view's scope.
 */
import { useCallback, useEffect, useRef, useState } from 'react'
import type { GraphDataProvider } from '@/providers/GraphDataProvider'
import type { LineageNode, LineageEdge } from '@/store/canvas'
import { toCanvasNode, toCanvasEdge } from '@/lib/canvasNodeMapper'

/** Bound on how many pass-through levels an open may skip in one go. */
export const FRAME_AUTO_STEPS = 4

export type ContainerDirection = 'in' | 'out'

export type LensContainerStatus = 'loading' | 'done' | 'error' | 'unsupported'

export interface ContainerOpenResult {
  /** Entities inside the container that connect to the focal. Empty when
   *  the container genuinely has no lineage with it (see `empty`). */
  nodes: LineageNode[]
  /** The lineage edges between those entities and the focal side. */
  edges: LineageEdge[]
  /** Containment edges the backend hydrated for the returned nodes —
   *  lets the caller show which sub-container each child lives in. */
  containmentEdges: LineageEdge[]
  /** Levels auto-skipped because each held exactly one relevant child;
   *  rendered as a breadcrumb so a skipped level is never hidden. */
  passedThrough: LineageNode[]
  /** The server stopped early — counts are floors, not totals. */
  truncated: boolean
  /** Fetch completed and NOTHING inside connects to the focal. This is a
   *  data-source claim, distinct from "not fetched yet". */
  empty: boolean
}

export interface LensContainerData {
  results: Map<string, ContainerOpenResult>
  status: Map<string, LensContainerStatus>
  /** Open a container against the current focal (idempotent per key). */
  openContainer: (
    containerUrn: string,
    focalUrn: string,
    direction: ContainerDirection,
    /** Hierarchy level of the CONTAINER's entity type. The fetch asks for
     *  level+1 — one grain finer. Callers must not invent this. */
    containerLevel: number,
  ) => void
  /** Re-kick a failed open. */
  retry: (
    containerUrn: string,
    focalUrn: string,
    direction: ContainerDirection,
    containerLevel: number,
  ) => void
}

/** Stable identity for one (container, focal, direction) opening. */
export const containerKey = (
  containerUrn: string,
  focalUrn: string,
  direction: ContainerDirection,
): string => `${direction}:${containerUrn}->${focalUrn}`

interface ContainerState {
  results: Map<string, ContainerOpenResult>
  status: Map<string, LensContainerStatus>
}

const emptyState = (): ContainerState => ({ results: new Map(), status: new Map() })

export function useLensContainer(
  /** Current focal, or null when the lens is closed (clears the session). */
  focalId: string | null,
  /** Null = no provider reachable; every open degrades to 'unsupported'. */
  provider: GraphDataProvider | null,
  lineageEdgeTypes: string[],
): LensContainerData {
  const [state, setState] = useState<ContainerState>(emptyState)
  const startedRef = useRef<Set<string>>(new Set())
  const sessionRef = useRef(0)

  const runOpen = useCallback(async (
    containerUrn: string,
    focalUrn: string,
    direction: ContainerDirection,
    containerLevel: number,
  ) => {
    const key = containerKey(containerUrn, focalUrn, direction)
    // Optional provider capability — absent means we cannot answer, and
    // saying so beats rendering a wrong or empty picture.
    if (!provider?.expandAggregated) {
      setState(prev => {
        const status = new Map(prev.status)
        status.set(key, 'unsupported')
        return { ...prev, status }
      })
      return
    }
    const session = sessionRef.current
    startedRef.current.add(key)
    setState(prev => {
      const status = new Map(prev.status)
      status.set(key, 'loading')
      return { ...prev, status }
    })

    try {
      const types = lineageEdgeTypes.length > 0 ? lineageEdgeTypes : null
      const passedThrough: LineageNode[] = []
      let anchor = containerUrn
      let level = containerLevel
      let nodes: LineageNode[] = []
      let edges: LineageEdge[] = []
      let containmentEdges: LineageEdge[] = []
      let truncated = false
      let empty = false

      // Open one level, then keep going while a level holds exactly one
      // relevant child — a container that only passes lineage through
      // costs the user a click for no information. Every skipped level
      // is recorded for the breadcrumb, so nothing is hidden.
      for (let step = 0; step < FRAME_AUTO_STEPS; step++) {
        const res = await provider.expandAggregated({
          // Direction decides which anchor is the source: upstream means
          // the container feeds the focal.
          sourceUrn: direction === 'in' ? anchor : focalUrn,
          targetUrn: direction === 'in' ? focalUrn : anchor,
          nextLevel: level + 1,
          lineageEdgeTypes: types,
          includeContainmentEdges: true,
        })
        if (session !== sessionRef.current) return

        // CRITICAL: with zero edges the backend returns every collected
        // child of BOTH anchors — "no lineage" and "all children" arrive
        // in the same shape. Treat it as the honest empty answer and
        // discard the nodes rather than showing unrelated content.
        if (res.edges.length === 0) {
          nodes = []
          edges = []
          containmentEdges = []
          truncated = truncated || res.truncated
          empty = true
          break
        }

        // Keep only entities that are actually inside the container we
        // opened — the response also carries the focal side's endpoints.
        const focalSide = new Set<string>([focalUrn])
        const inside = res.nodes.filter(n => n.urn !== anchor && !focalSide.has(n.urn))

        // Explicit arrows: toCanvasNode takes an options 2nd arg, so a
        // bare `.map(toCanvasNode)` would hand it the array index.
        nodes = inside.map(n => toCanvasNode(n))
        edges = res.edges.map(e => toCanvasEdge(e))
        containmentEdges = (res.containmentEdges ?? []).map(e => toCanvasEdge(e))
        truncated = truncated || res.truncated
        empty = false

        if (nodes.length !== 1) break
        // Exactly one child: descend through it, recording the step.
        passedThrough.push(nodes[0])
        anchor = nodes[0].id
        level += 1
      }

      if (session !== sessionRef.current) return
      setState(prev => {
        const results = new Map(prev.results)
        results.set(key, { nodes, edges, containmentEdges, passedThrough, truncated, empty })
        const status = new Map(prev.status)
        status.set(key, 'done')
        return { results, status }
      })
    } catch {
      if (session !== sessionRef.current) return
      // Allow an explicit retry to re-kick a failed open.
      startedRef.current.delete(key)
      setState(prev => {
        const status = new Map(prev.status)
        status.set(key, 'error')
        return { ...prev, status }
      })
    }
  }, [provider, lineageEdgeTypes])

  const openContainer = useCallback((
    containerUrn: string,
    focalUrn: string,
    direction: ContainerDirection,
    containerLevel: number,
  ) => {
    const key = containerKey(containerUrn, focalUrn, direction)
    if (startedRef.current.has(key)) return
    void runOpen(containerUrn, focalUrn, direction, containerLevel)
  }, [runOpen])

  const retry = useCallback((
    containerUrn: string,
    focalUrn: string,
    direction: ContainerDirection,
    containerLevel: number,
  ) => void runOpen(containerUrn, focalUrn, direction, containerLevel), [runOpen])

  // Session lifecycle: clear everything when the lens closes so a new
  // session starts from the data source, not from a stale picture.
  useEffect(() => {
    if (focalId) return
    if (startedRef.current.size === 0) return
    sessionRef.current += 1
    startedRef.current.clear()
    setState(emptyState())
  }, [focalId])

  return { results: state.results, status: state.status, openContainer, retry }
}
