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
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { GraphDataProvider } from '@/providers/GraphDataProvider'
import { recordEvent } from '@/services/telemetryService'
import {
    useLensWalk,
    FULL_WALK_INITIAL_DEPTH,
    type WalkEntry,
    type WalkProgress,
    type WalkPhase,
    type LensWalkStatus,
} from './useLensWalk'
import { unionWalkModels } from '@/components/canvas/context-view/lens/closure-adapter'

/** Stable empty seed list, so "not tracing" keeps one identity. */
const EMPTY_SEEDS: readonly string[] = []

export interface CanvasTraceWalk {
    isTracing: boolean
    /** The FIRST seed. Kept for every consumer that reasons about one focal
     *  (history, re-centre, the "already tracing this" check). */
    tracedUrn: string | null
    /** Every seed being traced. One entry for a normal trace; several for a
     *  bulk trace of a multi-selection. */
    tracedUrns: readonly string[]
    /** Trace one urn, or a selection of them. */
    start: (urn: string | readonly string[]) => void
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
    const [tracedUrns, setTracedUrns] = useState<readonly string[]>(EMPTY_SEEDS)
    const tracedUrn = tracedUrns[0] ?? null
    // Counts presses of Trace, not focals. Re-tracing the focal already on
    // screen leaves `tracedUrn` untouched, so without this the telemetry
    // effect below would never re-run and the second ask would go unrecorded —
    // while the other trace path records every press. Two surfaces counting
    // the same action differently is worse than either convention alone.
    const [attempt, setAttempt] = useState(0)
    const walk = useLensWalk(tracedUrns, provider, FULL_WALK_INITIAL_DEPTH, true)

    // ONE picture from however many seeds. With a single seed these collapse
    // to exactly what they always were: `unionWalkModels` of one model
    // returns that model by identity, and the aggregates below are that
    // seed's own values.
    const entries = useMemo(
        () => tracedUrns.map(u => walk.walkFor(u)).filter((e): e is WalkEntry => e !== null),
        [tracedUrns, walk],
    )
    const walkEntry = useMemo<WalkEntry | null>(() => {
        if (entries.length === 0) return null
        if (entries.length === 1) return entries[0]!
        const model = unionWalkModels(entries.map(e => e.model))
        if (!model) return null
        // Loading wins (something is still coming), then error (the picture
        // is short and there is a retry to offer), then done.
        const status: LensWalkStatus = entries.some(e => e.status === 'loading')
            ? 'loading'
            : entries.some(e => e.status === 'error')
                ? 'error'
                : entries.every(e => e.status === 'unsupported') ? 'unsupported' : 'done'
        const extendStatus = new Map<string, 'loading' | 'error'>()
        for (const e of entries) for (const [k, v] of e.extendStatus) extendStatus.set(k, v)
        return {
            model,
            status,
            error: entries.find(e => e.error)?.error ?? null,
            extendStatus,
            depth: Math.max(...entries.map(e => e.depth)),
        }
    }, [entries])

    const progress = useMemo<WalkProgress | null>(() => {
        if (tracedUrns.length === 0) return null
        const all = tracedUrns.map(u => walk.walkProgressFor(u)).filter((p): p is WalkProgress => p !== null)
        if (all.length === 0) return null
        if (all.length === 1) return all[0]!
        // The phase the READER is waiting on: any seed still working keeps
        // the whole trace "working", and a checkpoint or an error on any seed
        // is something they have to be told about.
        const phase: WalkPhase =
            all.find(p => p.phase === 'error')?.phase
            ?? all.find(p => p.phase === 'checkpoint')?.phase
            ?? all.find(p => p.phase === 'loading' || p.phase === 'seeding' || p.phase === 'walking')?.phase
            ?? 'done'
        return {
            phase,
            nodes: all.reduce((n, p) => n + p.nodes, 0),
            flows: all.reduce((n, p) => n + p.flows, 0),
            requests: all.reduce((n, p) => n + p.requests, 0),
            pending: all.reduce((n, p) => n + p.pending, 0),
            unbounded: all.every(p => p.unbounded),
            error: all.find(p => p.error)?.error ?? null,
        }
    }, [tracedUrns, walk])

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

    const exit = useCallback(() => setTracedUrns(EMPTY_SEEDS), [])

    const start = useCallback((urn: string | readonly string[]) => {
        const seeds = (typeof urn === 'string' ? [urn] : [...urn]).filter(Boolean)
        if (seeds.length === 0) return
        // Asking again is asking again, even for the focal already on screen:
        // the reader wanted lineage twice, and the walk cache making the second
        // one instant does not mean it did not happen.
        setAttempt((n) => n + 1)
        setTracedUrns(prev =>
            prev.length === seeds.length && prev.every((u, i) => u === seeds[i]) ? prev : seeds)
    }, [])

    // Both act on EVERY seed: a checkpoint or a failure belongs to one seed's
    // walk, and the reader is looking at one picture.
    const continuePastCheckpoint = useCallback(() => {
        for (const u of tracedUrns) walk.continuePastCheckpoint(u)
    }, [walk, tracedUrns])
    const retryWalk = useCallback(() => {
        for (const u of tracedUrns) {
            if (walk.walkFor(u)?.status === 'error') walk.retry(u)
            else walk.retryWalk(u)
        }
    }, [walk, tracedUrns])

    // Memoized: see `useUnifiedTrace`'s return. A fresh literal here re-triggered
    // every consumer memo that depends on the walk.
    return useMemo(() => ({
        isTracing: tracedUrns.length > 0,
        tracedUrn,
        tracedUrns,
        start,
        exit,
        walkEntry,
        progress,
        continuePastCheckpoint,
        retryWalk,
    }), [tracedUrn, tracedUrns, start, exit, walkEntry, progress, continuePastCheckpoint, retryWalk])
}
