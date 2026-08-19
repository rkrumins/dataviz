/**
 * useCanvasTraceWalk — the NATIVE canvas trace session.
 *
 * Trace = the ContextViewCanvas itself shows, upfront, everything relevant
 * to the traced entity. This controller owns that session:
 *
 *  - `start(urn)` mounts the existing closure full-walk engine
 *    (`useLensWalk` with `fullWalk` on — deep initial fetch, frontiers
 *    followed to exhaustion under the node budget);
 *  - every walk-model growth wave delta-merges into the canvas store
 *    through `computeTraceWalkDelta` (the legacy spine/re-parent rules),
 *    ONE `addNodes` + ONE `addEdges` per wave;
 *  - `exit()` removes exactly the recorded ids — edges first, then nodes —
 *    so the store returns to its pre-trace content. Expansion is DERIVED
 *    (`expansionUrns`), never written, so its restore is free.
 *
 * `addedEdgeIds` is deliberately ONE stable Set instance whose contents
 * grow as waves merge: every wave also writes the store, which re-renders
 * the canvas, so readers always see fresh contents; the stable identity
 * keeps memo dependency arrays quiet.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { GraphDataProvider } from '@/providers/GraphDataProvider'
import { useCanvasStore, type LineageNode, type LineageEdge } from '@/store/canvas'
import {
    useLensWalk,
    FULL_WALK_INITIAL_DEPTH,
    type WalkEntry,
    type FullWalkStatus,
} from './useLensWalk'
import {
    computeTraceWalkDelta,
    emptyTraceWalkMergeSession,
    traceExpansionUrns,
} from './lib/traceWalkMerge'

const EMPTY_URNS: ReadonlySet<string> = new Set()

export interface CanvasTraceWalk {
    isTracing: boolean
    tracedUrn: string | null
    /** Trace this urn. A different urn exits the current session first. */
    start: (urn: string) => void
    /** Purge everything the trace merged; back to browse. */
    exit: () => void
    /** Status/error/model for the trace bar and counts. */
    walkEntry: WalkEntry | null
    fullWalkStatus: FullWalkStatus | null
    /** Budget grant / stalled re-arm ("Keep walking"). */
    continueWalk: () => void
    /** Re-kick a failed INITIAL fetch. */
    retryWalk: () => void
    /** Model urns ∪ upstream ∪ downstream — the trace filter's feed. */
    traceNodeUrns: ReadonlySet<string>
    /** Containment ancestors of every participant — what to expand. */
    expansionUrns: ReadonlySet<string>
    /** Every edge id the trace merged — the projection's allowlist. */
    addedEdgeIds: ReadonlySet<string>
}

export function useCanvasTraceWalk(provider: GraphDataProvider | null): CanvasTraceWalk {
    const [tracedUrn, setTracedUrn] = useState<string | null>(null)
    const walk = useLensWalk(tracedUrn, provider, FULL_WALK_INITIAL_DEPTH, true)

    const walkEntry = tracedUrn ? walk.walkFor(tracedUrn) : null
    // Hands-free continuation lives in the ENGINE (useLensWalk auto-grants
    // through budget parks on every surface); budgetHit here already means
    // the true runaway ceiling was reached.
    const fullWalkStatus = tracedUrn ? walk.fullWalkFor(tracedUrn) : null
    const model = walkEntry?.model ?? null

    const sessionRef = useRef(emptyTraceWalkMergeSession())
    // ONE stable Set instance for the whole hook life (state initializer,
    // never re-set) — see the header's stability contract.
    const [addedEdgeIds] = useState(() => new Set<string>())

    // Delta-merge each model growth into the store. Store writes are
    // external-store writes (zustand), legal in an effect; the session ref
    // makes re-runs idempotent, so a re-render without growth is a no-op.
    useEffect(() => {
        if (!tracedUrn || !model) return
        const store = useCanvasStore.getState()
        const knownUrns = new Set<string>(store.nodes.map(n => n.id))
        const { delta, session } = computeTraceWalkDelta({
            model, session: sessionRef.current, knownUrns,
        })
        if (delta.nodes.length === 0 && delta.edges.length === 0) return
        sessionRef.current = session
        for (const e of delta.edges) addedEdgeIds.add(e.id)
        if (delta.nodes.length > 0) store.addNodes(delta.nodes as unknown as LineageNode[])
        if (delta.edges.length > 0) store.addEdges(delta.edges as unknown as LineageEdge[])
    }, [tracedUrn, model, addedEdgeIds])

    const exit = useCallback(() => {
        const session = sessionRef.current
        const store = useCanvasStore.getState()
        if (session.mergedEdgeIds.size > 0) store.removeEdges([...session.mergedEdgeIds])
        if (session.mergedNodeIds.size > 0) store.removeNodes([...session.mergedNodeIds])
        sessionRef.current = emptyTraceWalkMergeSession()
        addedEdgeIds.clear()
        setTracedUrn(null)
    }, [addedEdgeIds])

    const start = useCallback((urn: string) => {
        if (!urn || tracedUrn === urn) return
        if (tracedUrn) exit()
        setTracedUrn(urn)
    }, [tracedUrn, exit])

    const continueWalk = useCallback(() => {
        if (tracedUrn) walk.continueFullWalk(tracedUrn)
    }, [walk, tracedUrn])
    const retryWalk = useCallback(() => {
        if (tracedUrn) walk.retry(tracedUrn)
    }, [walk, tracedUrn])

    const traceNodeUrns = useMemo<ReadonlySet<string>>(() => {
        if (!model) return EMPTY_URNS
        const out = new Set<string>()
        for (const n of model.nodes) out.add(n.urn)
        for (const u of model.upstreamUrns) out.add(u)
        for (const u of model.downstreamUrns) out.add(u)
        return out
    }, [model])

    const expansionUrns = useMemo<ReadonlySet<string>>(
        () => (model && tracedUrn ? traceExpansionUrns(model, tracedUrn) : EMPTY_URNS),
        [model, tracedUrn],
    )

    return {
        isTracing: tracedUrn !== null,
        tracedUrn,
        start,
        exit,
        walkEntry,
        fullWalkStatus,
        continueWalk,
        retryWalk,
        traceNodeUrns,
        expansionUrns,
        addedEdgeIds,
    }
}
