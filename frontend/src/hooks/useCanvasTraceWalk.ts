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
import { useCallback, useState } from 'react'
import type { GraphDataProvider } from '@/providers/GraphDataProvider'
import {
    useLensWalk,
    FULL_WALK_INITIAL_DEPTH,
    type WalkEntry,
    type WalkProgress,
} from './useLensWalk'

export interface CanvasTraceWalk {
    isTracing: boolean
    tracedUrn: string | null
    /** Trace this urn. */
    start: (urn: string) => void
    /** Back to browse. */
    exit: () => void
    /** Status/error/model for the trace bar and counts. */
    walkEntry: WalkEntry | null
    /** Where the hands-free walk stands (phase, counts, pending). */
    progress: WalkProgress | null
    /** Lift the one-time memory checkpoint (`progress.phase === 'checkpoint'`). */
    continuePastCheckpoint: () => void
    /** Give failed steps one more attempt, or re-kick a failed INITIAL fetch. */
    retryWalk: () => void
}

export function useCanvasTraceWalk(provider: GraphDataProvider | null): CanvasTraceWalk {
    const [tracedUrn, setTracedUrn] = useState<string | null>(null)
    const walk = useLensWalk(tracedUrn, provider, FULL_WALK_INITIAL_DEPTH, true)

    const walkEntry = tracedUrn ? walk.walkFor(tracedUrn) : null
    const progress = tracedUrn ? walk.walkProgressFor(tracedUrn) : null

    const exit = useCallback(() => setTracedUrn(null), [])

    const start = useCallback((urn: string) => {
        if (!urn) return
        setTracedUrn(urn)
    }, [])

    const continuePastCheckpoint = useCallback(() => {
        if (tracedUrn) walk.continuePastCheckpoint(tracedUrn)
    }, [walk, tracedUrn])
    const retryWalk = useCallback(() => {
        if (!tracedUrn) return
        if (walkEntry?.status === 'error') walk.retry(tracedUrn)
        else walk.retryWalk(tracedUrn)
    }, [walk, tracedUrn, walkEntry?.status])

    return {
        isTracing: tracedUrn !== null,
        tracedUrn,
        start,
        exit,
        walkEntry,
        progress,
        continuePastCheckpoint,
        retryWalk,
    }
}
