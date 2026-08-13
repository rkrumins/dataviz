/**
 * useLensSession — the Lineage Lens's ONE data hook.
 *
 * Owns a LensSessionState per focal and exposes the gestures: lineage
 * expansion (⊕ per direction), containment open (chevron + load more),
 * connected expand (chevron on a rollup partner — drills every incident
 * rollup anchored there and auto-walks pass-through levels), rollup
 * drill (×N chip), and retry. Every expansion is served by the same
 * request policy:
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
import { isContainmentEdgeType } from '@/store/schema'
import {
  createLensSession,
  expansionKeyOf,
  failChildren,
  failDrill,
  failExpansion,
  isAggregatedType,
  mergeAncestors,
  mergeChildren,
  mergeContainedLineage,
  mergeContainmentEdges,
  mergeDegrees,
  mergeDrill,
  mergeExpansion,
  mergeNodes,
  mergeReach,
  recordIdOf,
  startChildren,
  startDrill,
  startExpansion,
  visibleRecords,
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
/** Waves one connected expand may drill (the user's click plus the
 *  auto-walk through pass-through levels). The cap is visible, not
 *  silent: a capped chain ends on a still-drillable card. */
export const LENS_WALK_CAP = 8

export interface LensSessionApi {
  state: LensSessionState
  /** ⊕ — fetch one more hop of lineage for a placed node. */
  expandLineage: (dir: LensDirection, urn: string) => void
  /** Chevron — open a node's children (first page). */
  openChildren: (urn: string) => void
  /** Frame footer — fetch the next children page. */
  loadMoreChildren: (urn: string) => void
  /** Chevron on a rollup partner — drill every shown aggregated record
   *  with this EXACT endpoint, anchored here, auto-walking pass-through
   *  levels. Resolves with how many constituent records landed (0 =
   *  fall back to a plain contents open) and whether the walk hit its
   *  step cap. */
  connectedExpand: (urn: string) => Promise<{ records: number; capped: boolean }>
  /** ×N / rollup card — drill an aggregated record one structural step.
   *  `anchorUrn` names the side being opened. */
  drillRollup: (recordId: string, anchorUrn: string) => void
  /** Re-fire a failed gesture. */
  retryExpansion: (dir: LensDirection, urn: string) => void
  retryChildren: (urn: string) => void
}

interface LandedWave {
  trace: TraceV2Result
  recordId: string
}

/** Distinct constituent record ids a wave landed (echoes of the drilled
 *  pair excluded — a record is never its own constituent). */
function constituentIds(landed: LandedWave[], containmentEdgeTypes: string[]): Set<string> {
  const ids = new Set<string>()
  for (const { trace, recordId } of landed) {
    for (const e of trace.edges) {
      const type = (e.edgeType || '').toUpperCase()
      if (isContainmentEdgeType(type, containmentEdgeTypes)) continue
      if (!e.sourceUrn || !e.targetUrn || e.sourceUrn === e.targetUrn) continue
      const id = recordIdOf(e.sourceUrn, e.targetUrn, type)
      if (id !== recordId) ids.add(id)
    }
  }
  return ids
}

/**
 * One wave's auto-walk continuation: the sole still-aggregated
 * anchor-side child this wave surfaced, with the records to drill next.
 * Deliberately WAVE-LOCAL — the decision reads only the returned traces
 * (their own containment map), never the merged React state, so the
 * loop cannot race update batching. Returns null on branching (2+
 * children), concrete edges (the walk reached raw truth), or nothing.
 */
function walkContinuation(
  landed: LandedWave[],
  anchorUrn: string,
  containmentEdgeTypes: string[],
): { child: string; records: Array<{ id: string; pair: { sourceUrn: string; targetUrn: string } }> } | null {
  const parents = new Map<string, string>()
  for (const { trace } of landed) {
    for (const e of trace.containmentEdges) {
      const type = (e.edgeType || '').toUpperCase()
      if (!isContainmentEdgeType(type, containmentEdgeTypes)) continue
      if (e.sourceUrn && e.targetUrn && !parents.has(e.targetUrn)) {
        parents.set(e.targetUrn, e.sourceUrn)
      }
    }
  }
  const underAnchor = (urn: string): boolean => {
    let cursor: string | undefined = urn
    const guard = new Set<string>()
    while (cursor && !guard.has(cursor)) {
      if (cursor === anchorUrn) return true
      guard.add(cursor)
      cursor = parents.get(cursor)
    }
    return false
  }
  const byChild = new Map<string, Map<string, { id: string; pair: { sourceUrn: string; targetUrn: string } }>>()
  for (const { trace, recordId } of landed) {
    for (const e of trace.edges) {
      const type = (e.edgeType || '').toUpperCase()
      if (isContainmentEdgeType(type, containmentEdgeTypes)) continue
      if (!e.sourceUrn || !e.targetUrn || e.sourceUrn === e.targetUrn) continue
      if (recordIdOf(e.sourceUrn, e.targetUrn, type) === recordId) continue
      const child =
        e.sourceUrn !== anchorUrn && underAnchor(e.sourceUrn)
          ? e.sourceUrn
          : e.targetUrn !== anchorUrn && underAnchor(e.targetUrn)
            ? e.targetUrn
            : null
      if (!child) continue
      if (type !== 'AGGREGATED') return null
      const bucket = byChild.get(child) ?? new Map()
      bucket.set(recordIdOf(e.sourceUrn, e.targetUrn, type), {
        id: recordIdOf(e.sourceUrn, e.targetUrn, type),
        pair: { sourceUrn: e.sourceUrn, targetUrn: e.targetUrn },
      })
      byChild.set(child, bucket)
    }
  }
  if (byChild.size !== 1) return null
  const [child, bucket] = [...byChild][0]
  return { child, records: [...bucket.values()] }
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
  // the canvas's own containment hierarchy uses unconditionally, and
  // the one the backend enforces end to end (ancestor chains, children
  // queries and the aggregation cube all read parent→child). No
  // invertedContainmentTypes is passed because no schema field exists
  // to derive one from — direction is a data-model invariant, not a
  // per-ontology variable.
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

  /**
   * The container fallback: when a focal lands with ZERO lineage of its
   * own — no raw edges at its grain and no rollup cells (unmaterialized
   * cube, or lineage that only exists between children, the
   * dataset-of-columns case) — the honest picture is one level down.
   * Fetch the first children page, then the children's own raw edges
   * (both directions; the children query itself returns only intra-page
   * lineage), and land them as contained lineage: children under the
   * focal's frame, external partners one hop out.
   */
  const fetchContainedLineage = useCallback(
    async (session: number, urn: string) => {
      if (!provider) return
      // A superseded session must never CLAIM the dedupe key: under
      // StrictMode's double-invoked mount effect, the stale chain can
      // reach this point first, and its claim would starve the live
      // session whose merges actually land.
      if (session !== sessionRef.current) return
      // Shares the chevron's namespace: this IS the first contents page,
      // so a later chevron folds/loads-more instead of refetching.
      const key = `kids:${urn}:`
      if (startedRef.current.has(key)) return
      startedRef.current.add(key)
      apply(session, prev => startChildren(prev, urn))
      try {
        const res = await provider.getChildrenWithEdges(urn, {
          limit: LENS_CHILD_PAGE,
          includeLineageEdges: true,
          lineageEdgeTypes: rawLineageTypes.length > 0 ? rawLineageTypes : undefined,
        })
        apply(session, prev => mergeChildren(prev, urn, res, containmentOpts))
        const childUrns = res.children.map(c => c.urn).filter(Boolean)
        if (childUrns.length === 0) return
        const types = rawLineageTypes.length > 0 ? rawLineageTypes : undefined
        const [asSource, asTarget, childDegrees] = await Promise.all([
          provider.getEdges({ sourceUrns: childUrns, edgeTypes: types, limit: LENS_EDGE_LIMIT }),
          provider.getEdges({ targetUrns: childUrns, edgeTypes: types, limit: LENS_EDGE_LIMIT }),
          provider.getNodeDegrees
            ? provider.getNodeDegrees(childUrns, types).catch(() => ({}))
            : Promise.resolve({}),
        ])
        apply(session, prev => mergeDegrees(prev, childDegrees))
        const edges = [...asSource, ...asTarget]
        apply(session, prev => mergeContainedLineage(prev, urn, edges, containmentOpts))
        await hydratePartners(session, urn, edges)
      } catch {
        startedRef.current.delete(key)
        apply(session, prev => failChildren(prev, urn))
      }
    },
    [provider, rawLineageTypes, containmentOpts, apply, hydratePartners],
  )

  const fetchDrill = useCallback(
    async (
      session: number,
      recordId: string,
      pair: { sourceUrn: string; targetUrn: string },
      anchorUrn: string,
    ): Promise<TraceV2Result | null> => {
      if (!provider?.expandAggregated) return null
      apply(session, prev => startDrill(prev, recordId, anchorUrn))
      try {
        const trace = await provider.expandAggregated({
          sourceUrn: pair.sourceUrn,
          targetUrn: pair.targetUrn,
          nextLevel: null,
          drillAnchor: anchorUrn,
          lineageEdgeTypes: rawLineageTypes.length > 0 ? rawLineageTypes : null,
        })
        apply(session, prev => mergeDrill(prev, recordId, trace, containmentOpts, anchorUrn))
        // Constituents deserve the same hydration as expansion partners:
        // labels, childCount for their chevrons, parent context, degrees
        // (the drill response's own node payload carries none of that).
        await hydratePartners(session, anchorUrn, trace.edges)
        return trace
      } catch {
        startedRef.current.delete(`drill:${recordId}`)
        apply(session, prev => failDrill(prev, recordId))
        return null
      }
    },
    [provider, rawLineageTypes, containmentOpts, apply, hydratePartners],
  )

  const connectedExpand = useCallback(
    async (urn: string): Promise<{ records: number; capped: boolean }> => {
      const session = sessionRef.current
      // Exact-endpoint candidates only: the backend NULLS a drillAnchor
      // that is not one of the pair's endpoints and silently switches
      // to lockstep both-sides descent — different, wrong semantics.
      const candidates = state
        ? visibleRecords(state).filter(r => {
            if (!r.rollupEdge) return false
            if (r.source !== urn && r.target !== urn) return false
            const drill = state.drills.get(r.id)
            return !drill || drill.state === 'error'
          })
        : []
      let revealed = 0
      let capped = false
      let steps = LENS_WALK_CAP
      let wave = candidates.map(r => ({ id: r.id, pair: r.rollupEdge! }))
      let anchor = urn
      while (wave.length > 0) {
        if (steps <= 0) {
          capped = true
          break
        }
        steps -= 1
        const fired = wave.filter(w => {
          const key = `drill:${w.id}`
          if (startedRef.current.has(key)) return false
          startedRef.current.add(key)
          return true
        })
        if (fired.length === 0) break
        const results = await Promise.all(
          fired.map(w =>
            fetchDrill(session, w.id, w.pair, anchor).then(trace =>
              trace ? { trace, recordId: w.id } : null,
            ),
          ),
        )
        const landed = results.filter((r): r is LandedWave => r !== null)
        if (landed.length === 0) break
        revealed += constituentIds(landed, containmentOpts.containmentEdgeTypes).size
        // Auto-walk: a pass-through level (exactly one still-aggregated
        // child) drills straight on until branching or concrete edges.
        const next = walkContinuation(landed, anchor, containmentOpts.containmentEdgeTypes)
        if (!next) break
        wave = next.records
        anchor = next.child
      }
      return { records: revealed, capped }
    },
    [state, fetchDrill, containmentOpts],
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
        // Nothing at the focal's own grain? The lineage may live one
        // level down (columns of a dataset; unmaterialized rollups) —
        // fall back to children-grain truth instead of an empty board.
        const contributed =
          rawUp.length +
          rawDown.length +
          (trace && !trace.isInherited
            ? trace.edges.filter(
                e => !isContainmentEdgeType((e.edgeType || '').toUpperCase(), containmentOpts.containmentEdgeTypes),
              ).length
            : 0)
        if (contributed === 0) {
          await fetchContainedLineage(session, focal)
        }
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
      connectedExpand,
      drillRollup,
      retryExpansion,
      retryChildren,
    }
  }, [state, expandLineage, openChildren, loadMoreChildren, connectedExpand, drillRollup, retryExpansion, retryChildren])
}
