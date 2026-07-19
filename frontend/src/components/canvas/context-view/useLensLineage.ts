/**
 * On-demand lineage fetching for the Lineage Lens.
 *
 * THE core fix for "the Lens only shows what the canvas already loaded":
 * the Lens used to derive its columns purely from canvas store edges,
 * which exist only for regions the user has expanded or paginated in.
 * Walking into a node whose lineage was never hydrated showed an empty
 * frontier — a silent-loss violation dressed up as "no connections".
 *
 * This hook fetches each VISITED focal node's true 1-hop lineage (both
 * directions) plus partner entity names straight from the provider the
 * first time that node appears in the lens stack, and fetches an
 * aggregated row's underlying connections when the user drills it
 * (same provider query the canvas's expandEdge uses). Results are held
 * lens-locally and merged into the Lens's derivation — nothing is
 * written to the canvas store, so exploring in the lens never mutates a
 * curated view's scope (same invariant as the external preview).
 *
 * Bounded by construction: two edge queries (EDGE_FETCH_LIMIT each) +
 * chunked name lookups per visited node, one pair query per drilled
 * aggregate, each fetched once per lens session (the cache clears when
 * the lens closes). Failures degrade to store-only data with a visible
 * 'error' status the Lens surfaces with a Retry — never a silent gap.
 * Truncation at the fetch limit is reported, never hidden.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { GraphDataProvider } from '@/providers/GraphDataProvider'
import { useCanvasStore, type LineageNode, type LineageEdge } from '@/store/canvas'
import { useContainmentEdgeTypes } from '@/store/schema'
import { toCanvasNode, toCanvasEdge } from '@/lib/canvasNodeMapper'

/** Per-direction edge cap per focal node — two queries per node.
 *  Exported so the Lens's truncation copy states the real number. */
export const EDGE_FETCH_LIMIT = 500
/** Underlying-edge cap per drilled aggregate (one pair query). */
const DRILL_FETCH_LIMIT = 200
/** Partner-name lookups are chunked and capped; overflow falls back to
 *  URN-derived labels in the Lens (labelOf), never blank rows. */
const NAME_CHUNK = 200
const NAME_CAP = 400

export type LensFetchStatus = 'loading' | 'done' | 'error'

export interface LensLineageData {
  /** Fetched 1-hop edges across all visited focal nodes, deduped by id. */
  supplementalEdges: LineageEdge[]
  /** Fetched entities (urn → node) for label/type resolution. */
  supplementalNodes: Map<string, LineageNode>
  /** Per-focal fetch status; absent id = fetch not attempted. */
  status: Map<string, LensFetchStatus>
  /** Focal nodes whose edge fetch hit EDGE_FETCH_LIMIT in a direction. */
  truncatedIds: Set<string>
  /** Re-kick a failed focal fetch. */
  retry: (nodeId: string) => void
  /** Underlying edges fetched per drilled aggregate (aggregate edge id). */
  drillEdges: Map<string, LineageEdge[]>
  /** Per-drill fetch status (aggregate edge id). */
  drillStatus: Map<string, LensFetchStatus>
  /** Fetch an aggregated edge's underlying connections (idempotent per
   *  edge id; a failed fetch may be re-kicked by calling again). */
  fetchDrill: (edge: LineageEdge) => void
}

interface FetchState {
  edgesByNode: Map<string, { edges: LineageEdge[]; truncated: boolean }>
  nodesByUrn: Map<string, LineageNode>
  status: Map<string, LensFetchStatus>
  drillEdges: Map<string, LineageEdge[]>
  drillStatus: Map<string, LensFetchStatus>
}

const emptyState = (): FetchState => ({
  edgesByNode: new Map(),
  nodesByUrn: new Map(),
  status: new Map(),
  drillEdges: new Map(),
  drillStatus: new Map(),
})

export function useLensLineage(
  lensStack: string[],
  provider: GraphDataProvider,
  lineageEdgeTypes: string[],
): LensLineageData {
  const containmentEdgeTypes = useContainmentEdgeTypes()
  const [state, setState] = useState<FetchState>(emptyState)
  // Fetches already started this session (prevents effect re-kicks);
  // errors stay in here — retry is explicit, never a loop.
  const startedRef = useRef<Set<string>>(new Set())
  const drillStartedRef = useRef<Set<string>>(new Set())
  // URNs whose names were already looked up (across fetches).
  const namedRef = useRef<Set<string>>(new Set())
  // Session token — bumped when the lens closes so in-flight results
  // from the previous session can't resurrect into a fresh one.
  const sessionRef = useRef(0)

  /** Resolve display names for URNs the canvas doesn't know and we
   *  haven't already looked up. Overflow beyond NAME_CAP keeps its
   *  URN-derived label — honest, never blank. Marks looked-up URNs. */
  const resolveNames = useCallback(async (urns: Iterable<string>): Promise<LineageNode[]> => {
    // The store maintains this Set — O(1) membership, no O(N) rebuild
    // per fetch (the canvas can hold very large hydrated sets).
    const loaded = useCanvasStore.getState()._nodeIndex
    const need: string[] = []
    const seen = new Set<string>()
    for (const u of urns) {
      if (seen.has(u) || loaded.has(u) || namedRef.current.has(u)) continue
      seen.add(u)
      need.push(u)
    }
    const capped = need.slice(0, NAME_CAP)
    const named: LineageNode[] = []
    for (let i = 0; i < capped.length; i += NAME_CHUNK) {
      const chunk = capped.slice(i, i + NAME_CHUNK)
      const res = await provider.getNodes({ urns: chunk, limit: chunk.length })
      for (const n of res) named.push(toCanvasNode(n))
    }
    capped.forEach(u => namedRef.current.add(u))
    return named
  }, [provider])

  const fetchNode = useCallback(async (urn: string) => {
    const session = sessionRef.current
    startedRef.current.add(urn)
    setState(prev => {
      const status = new Map(prev.status)
      status.set(urn, 'loading')
      return { ...prev, status }
    })
    try {
      const types = lineageEdgeTypes.length > 0 ? lineageEdgeTypes : undefined
      // Flow lineage both directions PLUS containment both directions
      // (children when the node is a parent, its own parent otherwise).
      // Containers often carry their relationships at CHILD level — a
      // walk into one must surface what it contains, or it dead-ends.
      // An untyped lineage fetch already returns containment edges;
      // typed fetches need the explicit extra queries.
      const wantContainment = !!types && containmentEdgeTypes.length > 0
      const [outEdges, inEdges, ...containment] = await Promise.all([
        provider.getEdges({ sourceUrns: [urn], edgeTypes: types, limit: EDGE_FETCH_LIMIT }),
        provider.getEdges({ targetUrns: [urn], edgeTypes: types, limit: EDGE_FETCH_LIMIT }),
        ...(wantContainment
          ? [
              provider.getEdges({ sourceUrns: [urn], edgeTypes: containmentEdgeTypes, limit: EDGE_FETCH_LIMIT }),
              provider.getEdges({ targetUrns: [urn], edgeTypes: containmentEdgeTypes, limit: EDGE_FETCH_LIMIT }),
            ]
          : []),
      ])
      const truncated = outEdges.length >= EDGE_FETCH_LIMIT || inEdges.length >= EDGE_FETCH_LIMIT
      const seenEdge = new Set<string>()
      const edges: LineageEdge[] = []
      for (const list of [outEdges, inEdges, ...containment]) {
        for (const ge of list) {
          if (seenEdge.has(ge.id)) continue
          seenEdge.add(ge.id)
          edges.push(toCanvasEdge(ge))
        }
      }
      // Parent context for flow partners — one bounded query for the
      // containment edges POINTING AT the partners (parent → partner).
      // A field name without its parent dataset isn't identifying
      // information; the Lens groups partner rows under these parents.
      if (containmentEdgeTypes.length > 0) {
        const partnerUrns: string[] = []
        const seenPartner = new Set<string>()
        for (const ge of [...outEdges, ...inEdges]) {
          for (const p of [ge.sourceUrn, ge.targetUrn]) {
            if (!p || p === urn || seenPartner.has(p)) continue
            seenPartner.add(p)
            partnerUrns.push(p)
          }
        }
        if (partnerUrns.length > 0) {
          const parentEdges = await provider.getEdges({
            targetUrns: partnerUrns.slice(0, NAME_CAP),
            edgeTypes: containmentEdgeTypes,
            limit: EDGE_FETCH_LIMIT,
          })
          for (const ge of parentEdges) {
            if (seenEdge.has(ge.id)) continue
            seenEdge.add(ge.id)
            edges.push(toCanvasEdge(ge))
          }
        }
      }
      const named = await resolveNames(edges.flatMap(e => [e.source, e.target]).filter(p => p !== urn))
      if (session !== sessionRef.current) return
      setState(prev => {
        const edgesByNode = new Map(prev.edgesByNode)
        edgesByNode.set(urn, { edges, truncated })
        const nodesByUrn = named.length > 0 ? new Map(prev.nodesByUrn) : prev.nodesByUrn
        for (const n of named) nodesByUrn.set(n.id, n)
        const status = new Map(prev.status)
        status.set(urn, 'done')
        return { ...prev, edgesByNode, nodesByUrn, status }
      })
    } catch {
      if (session !== sessionRef.current) return
      setState(prev => {
        const status = new Map(prev.status)
        status.set(urn, 'error')
        return { ...prev, status }
      })
    }
  }, [provider, lineageEdgeTypes, containmentEdgeTypes, resolveNames])

  /** Fetch the raw edges an aggregated row rolls up — the same
   *  source×target pair query the canvas's expandEdge uses, so the
   *  backend resolves descendants of both endpoints. */
  const fetchDrill = useCallback((edge: LineageEdge) => {
    if (drillStartedRef.current.has(edge.id)) return
    drillStartedRef.current.add(edge.id)
    const session = sessionRef.current
    setState(prev => {
      const drillStatus = new Map(prev.drillStatus)
      drillStatus.set(edge.id, 'loading')
      return { ...prev, drillStatus }
    })
    void (async () => {
      try {
        const types = lineageEdgeTypes.length > 0 ? lineageEdgeTypes : undefined
        const res = await provider.getEdges({
          sourceUrns: [edge.source],
          targetUrns: [edge.target],
          edgeTypes: types,
          limit: DRILL_FETCH_LIMIT,
        })
        const fetched = res.map(toCanvasEdge)
        const named = await resolveNames(fetched.flatMap(e => [e.source, e.target]))
        if (session !== sessionRef.current) return
        setState(prev => {
          const drillEdges = new Map(prev.drillEdges)
          drillEdges.set(edge.id, fetched)
          const nodesByUrn = named.length > 0 ? new Map(prev.nodesByUrn) : prev.nodesByUrn
          for (const n of named) nodesByUrn.set(n.id, n)
          const drillStatus = new Map(prev.drillStatus)
          drillStatus.set(edge.id, 'done')
          return { ...prev, drillEdges, nodesByUrn, drillStatus }
        })
      } catch {
        if (session !== sessionRef.current) return
        // Allow a re-click to retry a failed drill fetch.
        drillStartedRef.current.delete(edge.id)
        setState(prev => {
          const drillStatus = new Map(prev.drillStatus)
          drillStatus.set(edge.id, 'error')
          return { ...prev, drillStatus }
        })
      }
    })()
  }, [provider, lineageEdgeTypes, resolveNames])

  // Session lifecycle: fetch every stack entry once; clear on close.
  useEffect(() => {
    if (lensStack.length === 0) {
      if (startedRef.current.size > 0 || drillStartedRef.current.size > 0) {
        sessionRef.current += 1
        startedRef.current.clear()
        drillStartedRef.current.clear()
        namedRef.current.clear()
        setState(emptyState())
      }
      return
    }
    for (const id of lensStack) {
      if (!startedRef.current.has(id)) void fetchNode(id)
    }
  }, [lensStack, fetchNode])

  const retry = useCallback((nodeId: string) => void fetchNode(nodeId), [fetchNode])

  const supplementalEdges = useMemo(() => {
    const all: LineageEdge[] = []
    const seen = new Set<string>()
    state.edgesByNode.forEach(({ edges }) => {
      for (const e of edges) {
        if (seen.has(e.id)) continue
        seen.add(e.id)
        all.push(e)
      }
    })
    return all
  }, [state.edgesByNode])

  const truncatedIds = useMemo(() => {
    const ids = new Set<string>()
    state.edgesByNode.forEach(({ truncated }, id) => { if (truncated) ids.add(id) })
    return ids
  }, [state.edgesByNode])

  return {
    supplementalEdges,
    supplementalNodes: state.nodesByUrn,
    status: state.status,
    truncatedIds,
    retry,
    drillEdges: state.drillEdges,
    drillStatus: state.drillStatus,
    fetchDrill,
  }
}
