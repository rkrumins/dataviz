/**
 * useCanvasTraceWalk — the NATIVE canvas trace SESSION, and nothing else.
 *
 * Trace = the ContextViewCanvas itself shows, upfront, everything relevant
 * to the traced entity. This controller owns only WHICH entity that is and
 * the walk that fetches its flow:
 *
 *  - `start(urn)` mounts the existing closure full-walk engine
 *    (`useLensWalk` with `fullWalk` on — deep initial fetch, frontiers
 *    followed to exhaustion under the node budget);
 *  - `exit()` clears the focus. Nothing to undo: a trace is an OVERLAY
 *    (`useTraceOverlay` + `buildTraceView`), so leaving one restores the
 *    canvas for free.
 *
 * IT NEVER WRITES THE CANVAS STORE. It used to delta-merge every walk wave
 * into it, which is what produced a junk lane of unplaceable nodes, lost
 * chevrons, and a canvas re-laid-out behind the reader — a merged node
 * lands wherever the graph says instead of where THE VIEW places it. The
 * store now holds browse, and only browse.
 */
import { useCallback, useMemo, useState } from 'react'
import type { GraphDataProvider } from '@/providers/GraphDataProvider'
import {
    useLensWalk,
    FULL_WALK_INITIAL_DEPTH,
    type WalkEntry,
    type FullWalkStatus,
} from './useLensWalk'
import { traceExpansionUrns } from './lib/traceWalkMerge'

const EMPTY_URNS: ReadonlySet<string> = new Set()

export interface CanvasTraceWalk {
    isTracing: boolean
    tracedUrn: string | null
    /** Trace this urn. */
    start: (urn: string) => void
    /** Back to browse. */
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
}

export function useCanvasTraceWalk(provider: GraphDataProvider | null): CanvasTraceWalk {
    const [tracedUrn, setTracedUrn] = useState<string | null>(null)
    const walk = useLensWalk(tracedUrn, provider, FULL_WALK_INITIAL_DEPTH, true)

    const walkEntry = tracedUrn ? walk.walkFor(tracedUrn) : null
    const fullWalkStatus = tracedUrn ? walk.fullWalkFor(tracedUrn) : null
    const model = walkEntry?.model ?? null

    const exit = useCallback(() => setTracedUrn(null), [])

    const start = useCallback((urn: string) => {
        if (!urn) return
        setTracedUrn(urn)
    }, [])

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
    }
}
