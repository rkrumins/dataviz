/**
 * useCanvasTraceWalk — the NATIVE canvas trace SESSION, and nothing else.
 *
 * Trace = the ContextViewCanvas itself shows what is relevant to the traced
 * entity. This controller owns only WHICH entity that is; the fetching is
 * `useTraceDriver`'s job.
 *
 *  - `start(urn)` opens a session. The driver paints the COARSE picture — the
 *    focus, its chain, its lineage-carrying contents and its hop-1 partners
 *    at the grain the lineage lane offers — and then stops. Nothing else is
 *    fetched until the reader opens something, at which point `drill(urn)`
 *    fetches exactly that card's contents. (It used to mount `useLensWalk`
 *    with `fullWalk` on: a whole leaf-grain closure before the first card,
 *    9.7 s on the 2.08M-node estate. See useTraceDriver's header.)
 *  - `exit()` clears the focus and aborts whatever is in flight. Nothing to
 *    undo: a trace is an OVERLAY (`useTraceOverlay` + `buildTraceView`), so
 *    leaving one restores the canvas for free.
 *
 * IT NEVER WRITES THE CANVAS STORE. It used to delta-merge every walk wave
 * into it, which is what produced a junk lane of unplaceable nodes, lost
 * chevrons, and a canvas re-laid-out behind the reader — a merged node lands
 * wherever the graph says instead of where THE VIEW places it. The store now
 * holds browse, and only browse.
 *
 * THE `FullWalkStatus` SHAPE SURVIVES, because the dock and the capsule read
 * it — but two of its four fields are now permanently false. `budgetHit` is
 * the ceiling the ruling removed ("no limits"): there is no budget to grant,
 * so "Keep walking" has nothing to do and `continueWalk` is a no-op. And
 * `stalled` was "every frontier op failed"; a lazy session has no standing
 * frontier ops to fail. What remains is `walking` (the coarse fetch, or any
 * drill in flight) and `exhausted` (the coarse picture has landed).
 */
import { useCallback, useMemo, useState } from 'react'
import type { GraphDataProvider } from '@/providers/GraphDataProvider'
import { emptyWalkModel } from '@/components/canvas/context-view/lens/closure-adapter'
import { FULL_WALK_INITIAL_DEPTH, type WalkEntry, type FullWalkStatus } from './useLensWalk'
import { useTraceDriver, type TracePhase } from './useTraceDriver'

const EMPTY_EXTEND_STATUS: ReadonlyMap<string, 'loading' | 'error'> = new Map()

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
    /** Kept for the dock's "Keep walking": a NO-OP now — there is no budget
     *  to grant. More detail comes from opening a card, not from a grant. */
    continueWalk: () => void
    /** Re-kick a failed coarse fetch. */
    retryWalk: () => void
    /** Fetch one card's contents on the fly (the reader opened it). */
    drill: (urn: string) => void
    /** Cards with a drill in flight — rows that show a spinner. */
    inFlight: ReadonlySet<string>
    /** Pairs whose raw detail is fully loaded, for the wire ledger. */
    completePairs: ReadonlySet<string>
    /** The dock's up/down counts are FLOORS while anything is unfetched. */
    countsAreFloors: boolean
    phase: TracePhase
}

export function useCanvasTraceWalk(provider: GraphDataProvider | null): CanvasTraceWalk {
    const [tracedUrn, setTracedUrn] = useState<string | null>(null)
    const driver = useTraceDriver(tracedUrn, provider)

    const { model, phase, status, error, inFlight, completePairs, drill, retry, abort } = driver

    // The walk hook's contract: a session always has an entry, and its model
    // is non-null from the first render (empty until the coarse response
    // lands) so the overlay can key on "does it hold the focus".
    const walkEntry = useMemo<WalkEntry | null>(() => (
        tracedUrn
            ? {
                model: model ?? emptyWalkModel(tracedUrn),
                status: status === 'done' ? 'done' : status,
                error,
                extendStatus: EMPTY_EXTEND_STATUS,
                depth: FULL_WALK_INITIAL_DEPTH,
            }
            : null
    ), [tracedUrn, model, status, error])

    const fullWalkStatus = useMemo<FullWalkStatus | null>(() => (
        tracedUrn
            ? {
                walking: phase === 'coarse' || inFlight.size > 0,
                exhausted: phase === 'ready' && inFlight.size === 0,
                // See the file header: the ruling removed the budget, and a
                // lazy session has no standing frontier ops to stall on.
                budgetHit: false,
                stalled: false,
            }
            : null
    ), [tracedUrn, phase, inFlight])

    // Every partner arrives as a frontier boundary — this walk asked ONE hop,
    // so what lies past it is unknown — and drilling one clears its entry. So
    // an empty frontier is exactly "nothing left unasked", and a non-empty one
    // is exactly when the counts are floors.
    const countsAreFloors = (model?.frontierUp.length ?? 0) + (model?.frontierDown.length ?? 0) > 0

    const exit = useCallback(() => {
        setTracedUrn(null)
        abort()
    }, [abort])

    const start = useCallback((urn: string) => {
        if (!urn) return
        setTracedUrn(urn)
    }, [])

    const continueWalk = useCallback(() => {}, [])

    return {
        isTracing: tracedUrn !== null,
        tracedUrn,
        start,
        exit,
        walkEntry,
        fullWalkStatus,
        continueWalk,
        retryWalk: retry,
        drill,
        inFlight,
        completePairs,
        countsAreFloors,
        phase,
    }
}
