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
import { useCallback, useEffect, useRef, useState } from 'react'
import type { GraphDataProvider } from '@/providers/GraphDataProvider'
import { recordEvent } from '@/services/telemetryService'
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
    // Counts presses of Trace, not focals. Re-tracing the focal already on
    // screen leaves `tracedUrn` untouched, so without this the telemetry
    // effect below would never re-run and the second ask would go unrecorded —
    // while the other trace path records every press. Two surfaces counting
    // the same action differently is worse than either convention alone.
    const [attempt, setAttempt] = useState(0)
    const walk = useLensWalk(tracedUrn, provider, FULL_WALK_INITIAL_DEPTH, true)

    const walkEntry = tracedUrn ? walk.walkFor(tracedUrn) : null
    const progress = tracedUrn ? walk.walkProgressFor(tracedUrn) : null

    // ── Telemetry ────────────────────────────────────────────────────
    // Tracing lineage is the product's value moment, and this is the SECOND
    // path to it: `useUnifiedTrace` carries GraphCanvas and HierarchyCanvas,
    // while every trace on a Context View — the flagship view type, and the
    // only surface a shared trace link opens into — runs through here.
    // Instrumenting one and not the other did not lose a rounding error; it
    // undercounted the metric the activation funnel is built on.
    //
    // Recorded when the walk SETTLES rather than when it starts. `start` only
    // names a focal; the walk fetches in waves, so at that moment there is no
    // answer yet — and "did asking for lineage produce any?" is exactly the
    // half worth measuring. `checkpoint` counts as settled: the reader has a
    // complete-enough picture in front of them and may never lift it. An
    // errored walk counts as neither — a failure is not a value moment, and it
    // is not an empty lineage either.
    const reportedFor = useRef<number | null>(null)
    const phase = progress?.phase
    useEffect(() => {
        if (!tracedUrn || walkEntry === null) return
        if (phase !== 'done' && phase !== 'checkpoint') return
        // Once per press. The walk lands in waves, so this effect runs many
        // times for one trace as the model fills in.
        if (reportedFor.current === attempt) return
        reportedFor.current = attempt

        const model = walkEntry.model
        // The focus itself is never in these sets, so "empty" really does mean
        // the trace came back with no lineage in either direction.
        const reach = model.upstreamUrns.size + model.downstreamUrns.size
        recordEvent(reach > 0 ? 'lineage.trace' : 'lineage.trace_empty', {
            nodes: model.nodes.length,
            edges: model.lineageEdges.length,
            upstream: model.upstreamUrns.size,
            downstream: model.downstreamUrns.size,
            truncated: model.truncated,
            surface: 'context-view',
        })
    }, [tracedUrn, phase, walkEntry, attempt])

    const exit = useCallback(() => setTracedUrn(null), [])

    const start = useCallback((urn: string) => {
        if (!urn) return
        // Asking again is asking again, even for the focal already on screen:
        // the reader wanted lineage twice, and the walk cache making the second
        // one instant does not mean it did not happen.
        setAttempt((n) => n + 1)
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
