/**
 * useLensSession — the Lineage Lens's ONE data hook.
 *
 * Owns a LensSessionState per focal and exposes the four gestures:
 * lineage expansion (⊕ per direction), containment open (chevron +
 * load more), rollup drill, and retry. Every gesture is served by the
 * same request policy:
 *
 *   A (concrete truth)  getEdges on the node itself, raw lineage types
 *                       only — its real direct edges, at any grain;
 *   B (rolled-up truth) trace/v2 at level "auto", depth 1 — the peer
 *                       rollup that is the only lineage coarse
 *                       containers have, plus ancestor chains and the
 *                       isInherited signal for free.
 *
 * Concrete records take precedence at read time (see lensGraph's
 * covered-rollup rule); everything lands through the pure merges.
 *
 * Discipline carried from the old lens's hooks, minus their sprawl:
 * a session token invalidates in-flight results the moment the focal
 * changes or the lens closes; per-key in-flight dedupe means a gesture
 * fires exactly one request; failures land as per-key 'error' states
 * the UI retries explicitly — never a fetch loop, and never an effect
 * driven off built output.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { GraphDataProvider, GraphEdge, GraphNode, TraceV2Result } from '@/providers/GraphDataProvider'
import { useViewContainmentEdgeTypes, useViewLineageEdgeTypes } from '@/hooks/useViewSchema'
import {
  createLensSession,
  expansionKeyOf,
  failChildren,
  failDrill,
  failExpansion,
  isAggregatedType,
  mergeAncestors,
  mergeChildren,
  mergeContainmentEdges,
  mergeDegrees,
  mergeDrill,
  mergeExpansion,
  mergeNodes,
  mergeReach,
  startChildren,
  startDrill,
  startExpansion,
  type ContainmentOptions,
  type LensDirection,
  type LensSessionState,
} from './lensGraph'

/** Depth of the focal's transitive-reach measurement (bounded). */
export const LENS_REACH_DEPTH = 10

/** Per-direction raw-edge cap per gesture. Exported so truncation copy
 *  states the real number. */
export const LENS_EDGE_LIMIT = 500
/** Children fetched per chevron page ("load more" pages through). */
export const LENS_CHILD_PAGE = 25

export interface LensSessionApi {
  state: LensSessionState
  /** ⊕ — fetch one more hop of lineage for a placed node. */
  expandLineage: (dir: LensDirection, urn: string) => void
  /** Chevron — open a node's children (first page). */
  openChildren: (urn: string) => void
  /** Frame footer — fetch the next children page. */
  loadMoreChildren: (urn: string) => void
  /** ×N / rollup card — drill an aggregated record one structural step.
   *  `anchorUrn` names the side being opened. */
  drillRollup: (recordId: string, anchorUrn: string) => void
  /** Re-fire a failed gesture. */
  retryExpansion: (dir: LensDirection, urn: string) => void
  retryChildren: (urn: string) => void
}

export function useLensSession(
  focal: string | null,
  provider: GraphDataProvider | null,
): LensSessionApi | null {
  const containmentEdgeTypes = useViewContainmentEdgeTypes()
  const lineageEdgeTypes = useViewLineageEdgeTypes()

  /** Lineage types minus the rollup mechanism — what query A and the
   *  degree measurement mean by "real" lineage. */
  const rawLineageTypes = useMemo(
    () => lineageEdgeTypes.filter(t => !isAggregatedType(t.toUpperCase())),
    [lineageEdgeTypes],
  )

  // Containment edges are parent→child on the wire — the same reading
  // the canvas's own containment hierarchy uses unconditionally.
  const containmentOpts = useMemo<ContainmentOptions>(
    () => ({ containmentEdgeTypes }),
    [containmentEdgeTypes],
  )

  // Session state resets the moment the focal changes — adjusted during
  // render (the sanctioned reset-on-prop-change pattern) so the first
  // paint of a new focal never flashes the previous one, and no effect
  // ever calls setState synchronously.
  const [tracked, setTracked] = useState<{ focal: string | null; state: LensSessionState | null }>({
    focal: null,
    state: null,
  })
  const activeFocal = provider ? focal : null
  if (tracked.focal !== activeFocal) {
    let next: LensSessionState | null = null
    if (activeFocal) {
      next = startExpansion(
        startExpansion(createLensSession(activeFocal), expansionKeyOf('up', activeFocal)),
        expansionKeyOf('down', activeFocal),
      )
    }
    setTracked({ focal: activeFocal, state: next })
  }
  const state = tracked.focal === activeFocal ? tracked.state : null

  // Bumped when the focal changes or the lens closes; async completions
  // from a previous session compare and drop themselves.
  const sessionRef = useRef(0)
  // Gesture keys already fired this session (`up:urn`, `kids:urn`, …).
  const startedRef = useRef<Set<string>>(new Set())

  const apply = useCallback(
    (session: number, fn: (prev: LensSessionState) => LensSessionState) => {
      if (session !== sessionRef.current) return
      setTracked(prev => (prev.state ? { ...prev, state: fn(prev.state) } : prev))
    },
    [],
  )

  /** Hydrate labels + parent context + degrees for a batch of edges the
   *  session just landed. One bounded call per concern, never per node. */
  const hydratePartners = useCallback(
    async (session: number, aroundUrn: string, edges: GraphEdge[]) => {
      if (!provider) return
      const partners = new Set<string>()
      for (const e of edges) {
        for (const u of [e.sourceUrn, e.targetUrn]) {
          if (u && u !== aroundUrn) partners.add(u)
        }
      }
      const partnerList = [...partners]
      // Parent context: one bounded query for the containment edges
      // pointing AT the partners (parent → partner). A field name
      // without its parent dataset isn't identifying information.
      const containmentFetches: Promise<GraphEdge[]>[] = []
      if (partnerList.length > 0 && containmentOpts.containmentEdgeTypes.length > 0) {
        containmentFetches.push(
          provider.getEdges({
            targetUrns: partnerList,
            edgeTypes: containmentOpts.containmentEdgeTypes,
            limit: LENS_EDGE_LIMIT,
          }),
        )
      }
      const degreeUrns = [aroundUrn, ...partnerList]
      const degreesPromise = provider.getNodeDegrees
        ? provider
            .getNodeDegrees(degreeUrns, rawLineageTypes.length > 0 ? rawLineageTypes : undefined)
            .catch(() => ({}))
        : Promise.resolve({})
      const [containmentBatches, degrees] = await Promise.all([
        Promise.all(containmentFetches).catch(() => [] as GraphEdge[][]),
        degreesPromise,
      ])
      const containmentEdges = containmentBatches.flat()
      if (containmentEdges.length > 0) {
        apply(session, prev => mergeContainmentEdges(prev, containmentEdges, containmentOpts))
      }
      apply(session, prev => mergeDegrees(prev, degrees))
      // Names for anything still unlabelled: the node ITSELF (walking to
      // an entity the canvas never loaded must not leave the focal card
      // wearing a urn-tail label), its partners, and the parents the
      // containment context just surfaced.
      const nameUrns = new Set([aroundUrn, ...partnerList])
      for (const e of containmentEdges) {
        nameUrns.add(e.sourceUrn)
        nameUrns.add(e.targetUrn)
      }
      const need = [...nameUrns]
      if (need.length > 0) {
        const nodes = await provider.getNodes({ urns: need, limit: need.length }).catch(() => [])
        if (nodes.length > 0) apply(session, prev => mergeNodes(prev, nodes))
      }
    },
    [provider, containmentOpts, rawLineageTypes, apply],
  )

  const fetchExpansion = useCallback(
    async (session: number, dir: LensDirection, urn: string, includeTrace: boolean) => {
      if (!provider) return
      const key = expansionKeyOf(dir, urn)
      apply(session, prev => startExpansion(prev, key))
      try {
        const types = rawLineageTypes.length > 0 ? rawLineageTypes : undefined
        const rawQuery =
          dir === 'down'
            ? { sourceUrns: [urn], edgeTypes: types, limit: LENS_EDGE_LIMIT }
            : { targetUrns: [urn], edgeTypes: types, limit: LENS_EDGE_LIMIT }
        const [rawEdges, trace] = await Promise.all([
          provider.getEdges(rawQuery),
          includeTrace && provider.traceAtLevel
            ? provider
                .traceAtLevel({
                  urn,
                  direction: dir === 'down' ? 'downstream' : 'upstream',
                  upstreamDepth: dir === 'up' ? 1 : 0,
                  downstreamDepth: dir === 'down' ? 1 : 0,
                  level: 'auto',
                  includeInheritedLineage: true,
                  lineageEdgeTypes: types ?? null,
                })
                // Raw edges alone are still a real answer: land them and
                // let the expansion carry on without the rollup layer.
                .catch(() => null)
            : Promise.resolve<TraceV2Result | null>(null),
        ])
        apply(session, prev =>
          mergeExpansion(
            prev,
            key,
            urn,
            { rawEdges, rawTruncated: rawEdges.length >= LENS_EDGE_LIMIT, trace },
            containmentOpts,
          ),
        )
        await hydratePartners(session, urn, [...rawEdges, ...(trace && !trace.isInherited ? trace.edges : [])])
      } catch {
        startedRef.current.delete(key)
        apply(session, prev => failExpansion(prev, key))
      }
    },
    [provider, rawLineageTypes, containmentOpts, apply, hydratePartners],
  )

  const fetchChildren = useCallback(
    async (session: number, urn: string, cursor: string | null) => {
      if (!provider) return
      apply(session, prev => startChildren(prev, urn))
      try {
        const res = await provider.getChildrenWithEdges(urn, {
          limit: LENS_CHILD_PAGE,
          includeLineageEdges: true,
          lineageEdgeTypes: rawLineageTypes.length > 0 ? rawLineageTypes : undefined,
          ...(cursor ? { cursor } : {}),
        })
        apply(session, prev => mergeChildren(prev, urn, res, containmentOpts))
        const childUrns = res.children.map(c => c.urn).filter(Boolean)
        if (childUrns.length > 0 && provider.getNodeDegrees) {
          const degrees = await provider
            .getNodeDegrees(childUrns, rawLineageTypes.length > 0 ? rawLineageTypes : undefined)
            .catch(() => ({}))
          apply(session, prev => mergeDegrees(prev, degrees))
        }
      } catch {
        startedRef.current.delete(`kids:${urn}:${cursor ?? ''}`)
        apply(session, prev => failChildren(prev, urn))
      }
    },
    [provider, rawLineageTypes, containmentOpts, apply],
  )

  const fetchDrill = useCallback(
    async (
      session: number,
      recordId: string,
      pair: { sourceUrn: string; targetUrn: string },
      anchorUrn: string,
    ) => {
      if (!provider?.expandAggregated) return
      apply(session, prev => startDrill(prev, recordId))
      try {
        const trace = await provider.expandAggregated({
          sourceUrn: pair.sourceUrn,
          targetUrn: pair.targetUrn,
          nextLevel: null,
          drillAnchor: anchorUrn,
          lineageEdgeTypes: rawLineageTypes.length > 0 ? rawLineageTypes : null,
        })
        apply(session, prev => mergeDrill(prev, recordId, trace, containmentOpts))
        const urns = trace.nodes.map(n => n.urn).filter(Boolean)
        if (urns.length > 0 && provider.getNodeDegrees) {
          const degrees = await provider
            .getNodeDegrees(urns, rawLineageTypes.length > 0 ? rawLineageTypes : undefined)
            .catch(() => ({}))
          apply(session, prev => mergeDegrees(prev, degrees))
        }
      } catch {
        startedRef.current.delete(`drill:${recordId}`)
        apply(session, prev => failDrill(prev, recordId))
      }
    },
    [provider, rawLineageTypes, containmentOpts, apply],
  )

  // Session lifecycle: a new focal fetches its first paint — both raw
  // directions plus one both-ways trace, and the breadcrumb chain. The
  // state itself was already reset during render.
  useEffect(() => {
    sessionRef.current += 1
    startedRef.current.clear()
    if (!focal || !provider) return
    const session = sessionRef.current
    startedRef.current.add(`up:${focal}`)
    startedRef.current.add(`down:${focal}`)
    void (async () => {
      const types = rawLineageTypes.length > 0 ? rawLineageTypes : undefined
      const upKey = expansionKeyOf('up', focal)
      const downKey = expansionKeyOf('down', focal)
      try {
        const [rawUp, rawDown, trace, ancestors] = await Promise.all([
          provider.getEdges({ targetUrns: [focal], edgeTypes: types, limit: LENS_EDGE_LIMIT }),
          provider.getEdges({ sourceUrns: [focal], edgeTypes: types, limit: LENS_EDGE_LIMIT }),
          provider.traceAtLevel
            ? provider
                .traceAtLevel({
                  urn: focal,
                  direction: 'both',
                  upstreamDepth: 1,
                  downstreamDepth: 1,
                  level: 'auto',
                  includeInheritedLineage: true,
                  lineageEdgeTypes: types ?? null,
                })
                .catch(() => null)
            : Promise.resolve<TraceV2Result | null>(null),
          provider.getAncestors(focal).catch(() => [] as GraphNode[]),
        ])
        apply(session, prev =>
          mergeExpansion(
            prev,
            upKey,
            focal,
            { rawEdges: rawUp, rawTruncated: rawUp.length >= LENS_EDGE_LIMIT, trace },
            containmentOpts,
          ),
        )
        apply(session, prev =>
          mergeExpansion(
            prev,
            downKey,
            focal,
            { rawEdges: rawDown, rawTruncated: rawDown.length >= LENS_EDGE_LIMIT, trace },
            containmentOpts,
          ),
        )
        apply(session, prev => mergeAncestors(prev, focal, ancestors))
        await hydratePartners(session, focal, [
          ...rawUp,
          ...rawDown,
          ...(trace && !trace.isInherited ? trace.edges : []),
        ])
        // Transitive reach — the change-impact number the lens gets
        // opened for. One bounded deep trace, measured not guessed;
        // truncation renders the numbers as floors.
        if (provider.traceAtLevel) {
          const deep = await provider
            .traceAtLevel({
              urn: focal,
              direction: 'both',
              upstreamDepth: LENS_REACH_DEPTH,
              downstreamDepth: LENS_REACH_DEPTH,
              level: 'auto',
              includeInheritedLineage: true,
              lineageEdgeTypes: types ?? null,
            })
            .catch(() => null)
          // A zero-everything measurement adds nothing the depth-1
          // picture doesn't already say — and when rollups don't exist
          // at this grain it would CONTRADICT a board of raw edges.
          // Unknown stays unknown; only a real measurement renders.
          if (
            deep &&
            !deep.isInherited &&
            deep.upstreamUrns.size + deep.downstreamUrns.size > 0
          ) {
            apply(session, prev =>
              mergeReach(prev, {
                up: deep.upstreamUrns.size,
                down: deep.downstreamUrns.size,
                truncated: deep.truncated,
              }),
            )
          }
        }
      } catch {
        startedRef.current.delete(`up:${focal}`)
        startedRef.current.delete(`down:${focal}`)
        apply(session, prev => failExpansion(failExpansion(prev, upKey), downKey))
      }
    })()
    // rawLineageTypes/containmentOpts are ontology-stable per view; the
    // session deliberately re-keys only on focal/provider so an ontology
    // refetch cannot wipe an exploration in progress.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [focal, provider])

  const expandLineage = useCallback(
    (dir: LensDirection, urn: string) => {
      const key = `${dir}:${urn}`
      if (startedRef.current.has(key)) return
      startedRef.current.add(key)
      void fetchExpansion(sessionRef.current, dir, urn, true)
    },
    [fetchExpansion],
  )

  const retryExpansion = useCallback(
    (dir: LensDirection, urn: string) => {
      startedRef.current.add(`${dir}:${urn}`)
      void fetchExpansion(sessionRef.current, dir, urn, true)
    },
    [fetchExpansion],
  )

  const openChildren = useCallback(
    (urn: string) => {
      const key = `kids:${urn}:`
      if (startedRef.current.has(key)) return
      startedRef.current.add(key)
      void fetchChildren(sessionRef.current, urn, null)
    },
    [fetchChildren],
  )

  const loadMoreChildren = useCallback(
    (urn: string) => {
      const cursor = state?.children.get(urn)?.nextCursor
      if (!cursor) return
      const key = `kids:${urn}:${cursor}`
      if (startedRef.current.has(key)) return
      startedRef.current.add(key)
      void fetchChildren(sessionRef.current, urn, cursor)
    },
    [state, fetchChildren],
  )

  const retryChildren = useCallback(
    (urn: string) => {
      startedRef.current.add(`kids:${urn}:`)
      void fetchChildren(sessionRef.current, urn, null)
    },
    [fetchChildren],
  )

  const drillRollup = useCallback(
    (recordId: string, anchorUrn: string) => {
      const record = state?.records.get(recordId)
      const pair = record?.rollupEdge
      if (!pair) return
      const key = `drill:${recordId}`
      if (startedRef.current.has(key)) return
      startedRef.current.add(key)
      void fetchDrill(sessionRef.current, recordId, pair, anchorUrn)
    },
    [state, fetchDrill],
  )

  return useMemo(() => {
    if (!state) return null
    return {
      state,
      expandLineage,
      openChildren,
      loadMoreChildren,
      drillRollup,
      retryExpansion,
      retryChildren,
    }
  }, [state, expandLineage, openChildren, loadMoreChildren, drillRollup, retryExpansion, retryChildren])
}
