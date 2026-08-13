/**
 * useLensWalk — the accumulated walk-model per focal, server-lazy one hop
 * at a time.
 *
 * ONE fetch (`provider.traceClosure`) returns the focal's initial-depth
 * closure; from then on `extend`/`page` grow the SAME model by fetching a
 * further hop from a specific card and merging the response in via the
 * closure-adapter (`mergeClosures`) — the client-side union that turns a
 * sequence of one-hop server responses into the whole picture the lens
 * renders. The model itself is never refetched wholesale: every focal
 * visited this lens session is cached (keyed by provider scope + focal),
 * so stepping back to a focal already walked is instant.
 */
import { useCallback, useEffect, useRef, useState } from 'react'
import type { GraphDataProvider, TraceClosureRequest } from '@/providers/GraphDataProvider'
import {
    toLensClosure,
    mergeClosures,
    emptyWalkModel,
    type LensWalkModel,
} from '@/components/canvas/context-view/lens/closure-adapter'

export type LensWalkStatus = 'loading' | 'done' | 'error' | 'unsupported'
export type LensWalkDir = 'up' | 'down'

export interface WalkEntry {
    model: LensWalkModel
    status: LensWalkStatus
    error: string | null
    /** Key `${dir}:${urn}` — per-pill spinners; absent = idle. */
    extendStatus: ReadonlyMap<string, 'loading' | 'error'>
}

export interface LensWalkData {
    /** This session's entry for `urn`'s walk, or null if never touched. */
    walkFor: (urn: string) => WalkEntry | null
    /** Re-kick a failed (or unsupported, harmlessly) initial fetch. */
    retry: (focusUrn: string) => void
    /** Fetch one further hop from `cardUrn` (up or down), seeded from the
     *  lineage-participating leaves the view found under it. PRECONDITION:
     *  the focal's own entry must already be status 'done' — the pill this
     *  fires from only exists once the model has rendered. A call before
     *  that is a caller bug and is silently ignored, by design (see
     *  `runFrontierOp`). */
    extend: (cardUrn: string, dir: LensWalkDir, seedLeaves: string[]) => void
    /** Page a specific node's already-partial adjacency further, given its
     *  frontier entry's `nextCursor`. The hook never interprets cursors —
     *  it forwards them verbatim. Same 'done'-entry precondition as
     *  `extend`. */
    page: (cardUrn: string, dir: LensWalkDir, cursor: string) => void
    /** Re-kick a failed extend (same request shape and precondition as
     *  `extend`). */
    retryExtend: (cardUrn: string, dir: LensWalkDir, seedLeaves: string[]) => void
}

const EMPTY_EXTEND_STATUS: ReadonlyMap<string, 'loading' | 'error'> = new Map()

/** Client-side caches keyed by urn must fold in provider identity, or the
 *  same urn across two graphs/data sources collides (GraphDataProvider's
 *  `scopeKey` contract). */
function cacheKeyFor(provider: GraphDataProvider | null, focusUrn: string): string {
    return `${provider?.scopeKey ?? ''} ${focusUrn}`
}

function setEntry(
    prev: Map<string, WalkEntry>,
    key: string,
    entry: WalkEntry,
): Map<string, WalkEntry> {
    const next = new Map(prev)
    next.set(key, entry)
    return next
}

function withExtendStatus(
    entry: WalkEntry,
    statusKey: string,
    value: 'loading' | 'error' | null,
): WalkEntry {
    const next = new Map(entry.extendStatus)
    if (value === null) next.delete(statusKey)
    else next.set(statusKey, value)
    return { ...entry, extendStatus: next }
}

/** The model's currently-known participant urns. Order is whatever the
 *  merge history produced — deterministic, not nearest-first — because it
 *  only steers the excludeUrns budget, never correctness: since the
 *  live-gate fix, an edge into an un-excluded known node simply re-arrives
 *  and `mergeClosures` dedupes it. */
function knownUrns(model: LensWalkModel): string[] {
    return model.nodes.map(n => n.urn)
}

/** `extend`/`page` both walk ONE direction one hop; the other direction's
 *  depth is explicitly 0 (not omitted) per the closure request contract. */
function depthFields(dir: LensWalkDir, value: number): Pick<TraceClosureRequest, 'upstreamDepth' | 'downstreamDepth'> {
    return dir === 'up' ? { upstreamDepth: value, downstreamDepth: 0 } : { upstreamDepth: 0, downstreamDepth: value }
}

export function useLensWalk(
    /** Current focal, or null when the lens is closed (clears the session). */
    focusUrn: string | null,
    /** Null = no provider reachable; every focal degrades to 'unsupported'. */
    provider: GraphDataProvider | null,
    /** Persisted upstream/downstream depth for the initial fetch. */
    initialDepth = 1,
): LensWalkData {
    const [state, setState] = useState<Map<string, WalkEntry>>(() => new Map())
    // Permanent per-cacheKey guard: added before the fetch, removed only on
    // error (so an explicit retry can re-enter). A 'done' or 'unsupported'
    // entry stays marked forever — cache hit, never refetched.
    const startedRef = useRef<Set<string>>(new Set())
    // Transient per-(cacheKey, dir:cardUrn) guard for extend/page: single-
    // flight only, removed once the request settles either way (unlike
    // startedRef, since a completed extend never blocks a LATER extend of
    // the same pill — e.g. paging the same hub again).
    const inFlightRef = useRef<Set<string>>(new Set())
    const sessionRef = useRef(0)
    // extend/page need the LATEST model synchronously (to compute
    // excludeUrns, and to merge into) without retriggering on every
    // keystroke-adjacent render; committed mirror, current by the time a
    // callback reads it (same pattern as useLensContainer's stateRef).
    const stateRef = useRef(state)
    useEffect(() => { stateRef.current = state }, [state])

    const runFetch = useCallback(async (urn: string) => {
        const cacheKey = cacheKeyFor(provider, urn)
        if (startedRef.current.has(cacheKey)) return

        if (typeof provider?.traceClosure !== 'function') {
            startedRef.current.add(cacheKey)
            setState(prev => setEntry(prev, cacheKey, {
                model: emptyWalkModel(urn), status: 'unsupported', error: null, extendStatus: EMPTY_EXTEND_STATUS,
            }))
            return
        }

        startedRef.current.add(cacheKey)
        const session = sessionRef.current
        setState(prev => setEntry(prev, cacheKey, {
            model: emptyWalkModel(urn), status: 'loading', error: null, extendStatus: EMPTY_EXTEND_STATUS,
        }))
        try {
            const res = await provider.traceClosure({
                urn, direction: 'both', upstreamDepth: initialDepth, downstreamDepth: initialDepth,
            })
            if (session !== sessionRef.current) return   // lens closed mid-flight
            setState(prev => setEntry(prev, cacheKey, {
                model: toLensClosure(res, urn), status: 'done', error: null, extendStatus: EMPTY_EXTEND_STATUS,
            }))
        } catch (e) {
            if (session !== sessionRef.current) return
            startedRef.current.delete(cacheKey)   // allow retry
            setState(prev => setEntry(prev, cacheKey, {
                model: emptyWalkModel(urn), status: 'error',
                error: e instanceof Error ? e.message : String(e), extendStatus: EMPTY_EXTEND_STATUS,
            }))
        }
    }, [provider, initialDepth])

    /** Shared by `extend` and `page`: both fetch one further hop from a
     *  specific card+direction and merge the response into the CURRENT
     *  focal's model — `focusUrn` is captured here at call time, so a
     *  response landing after a re-center still lands on the focal it was
     *  actually requested for, never on whatever is current when it
     *  resolves (see the module docstring's supersede note).
     *
     *  PRECONDITION, enforced below: the focal's entry must already be
     *  status 'done'. The pill either of these fire from only renders once
     *  the focal's own model is in hand, so a call before that (initial
     *  fetch still loading/errored/unsupported, or the cacheKey never
     *  touched) is a caller bug, not a state to recover from — silently
     *  ignored, by design. This also closes a real corruption: fabricating
     *  a base model from `emptyWalkModel` for a not-yet-'done' entry let a
     *  merge land while the initial fetch was still in flight, and that
     *  fetch's success handler REPLACES the whole entry wholesale — the
     *  merge (and its extendStatus marker) would vanish with no signal the
     *  moment the initial response arrived. */
    const runFrontierOp = useCallback(async (
        cardUrn: string,
        dir: LensWalkDir,
        buildRequest: (baseModel: LensWalkModel) => TraceClosureRequest,
    ) => {
        if (!focusUrn) return
        if (typeof provider?.traceClosure !== 'function') return   // unsupported: nothing to extend/page
        const cacheKey = cacheKeyFor(provider, focusUrn)
        const startEntry = stateRef.current.get(cacheKey)
        if (startEntry?.status !== 'done') return
        const statusKey = `${dir}:${cardUrn}`
        const flightKey = `${cacheKey}|${statusKey}`
        if (inFlightRef.current.has(flightKey)) return
        inFlightRef.current.add(flightKey)
        const session = sessionRef.current
        const baseModel = startEntry.model

        setState(prev => setEntry(prev, cacheKey, withExtendStatus(startEntry, statusKey, 'loading')))

        try {
            const res = await provider.traceClosure(buildRequest(baseModel))
            if (session !== sessionRef.current) return   // lens closed mid-flight
            setState(prev => {
                const entry = prev.get(cacheKey)
                if (!entry) return prev   // session cleared/re-created before this landed
                // SIZING NOTE: every continuation re-ships the anchor's
                // seeds + every participant's containment spine — correct
                // by design (nesting needs chains); merge dedupes, so
                // accumulation is bounded by distinct participants, not by
                // request count.
                const merged = mergeClosures(entry.model, res, { rootUrn: cardUrn, direction: dir })
                return setEntry(prev, cacheKey, withExtendStatus({ ...entry, model: merged }, statusKey, null))
            })
        } catch {
            if (session !== sessionRef.current) return
            setState(prev => {
                const entry = prev.get(cacheKey)
                if (!entry) return prev
                return setEntry(prev, cacheKey, withExtendStatus(entry, statusKey, 'error'))
            })
        } finally {
            inFlightRef.current.delete(flightKey)
        }
    }, [provider, focusUrn])

    const extend = useCallback((cardUrn: string, dir: LensWalkDir, seedLeaves: string[]) => {
        void runFrontierOp(cardUrn, dir, (baseModel) => ({
            urn: cardUrn,
            direction: dir === 'up' ? 'upstream' : 'downstream',
            ...depthFields(dir, 1),
            seedUrns: seedLeaves,
            // Budget steering, not correctness — see knownUrns() doc.
            excludeUrns: knownUrns(baseModel).slice(0, 2000),
        }))
    }, [runFrontierOp])

    const page = useCallback((cardUrn: string, dir: LensWalkDir, cursor: string) => {
        void runFrontierOp(cardUrn, dir, () => ({
            urn: cardUrn,
            direction: dir === 'up' ? 'upstream' : 'downstream',
            ...depthFields(dir, 1),
            afterCursor: cursor,
        }))
    }, [runFrontierOp])

    // Initial fetch on focal change.
    useEffect(() => {
        if (!focusUrn) return
        void runFetch(focusUrn)
    }, [focusUrn, runFetch])

    // Session lifecycle: clear everything when the lens closes so a new
    // session starts from the data source, not from a stale picture.
    useEffect(() => {
        if (focusUrn) return
        if (startedRef.current.size === 0 && inFlightRef.current.size === 0) return
        sessionRef.current += 1
        startedRef.current.clear()
        inFlightRef.current.clear()
        setState(new Map())
    }, [focusUrn])

    const walkFor = useCallback(
        (urn: string): WalkEntry | null => state.get(cacheKeyFor(provider, urn)) ?? null,
        [state, provider],
    )

    const retry = useCallback((urn: string) => { void runFetch(urn) }, [runFetch])

    return { walkFor, retry, extend, page, retryExtend: extend }
}
