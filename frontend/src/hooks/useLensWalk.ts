/**
 * useLensWalk — the accumulated walk-model per focal, completed HANDS-FREE.
 *
 * ONE fetch (`provider.traceClosure`) returns the focal's initial-depth
 * closure; from then on the hook grows the SAME model by fetching further
 * pages and merging them via the closure-adapter (`mergeClosures`) — the
 * client-side union that turns a sequence of server responses into the
 * whole picture the lens renders. The model itself is never refetched
 * wholesale: every focal visited this lens session is cached (keyed by
 * provider scope + focal), so stepping back to a focal already walked is
 * instant.
 *
 * THE DRIVER (2026-08-21). The server walk is degree-exact: every anchor a
 * page ships is complete, and everything it could not afford is OWED —
 * named by a `seedCursor` (the focus's or a card's remaining contents), a
 * CUT frontier entry (re-rooted via `seedUrns`, up to `WALK_BATCH_SIZE` per
 * request), or a paged hub's real `e:<n>` cursor. The driver drains what is
 * owed in BOTH modes, by itself, with no click and no budget:
 *
 *   one hop   — the focus's immediate lineage, complete: seed pages, cuts,
 *               hub pages. DEPTH entries (the next hop) stay ⊕ pills.
 *   full flow — the same, plus DEPTH entries drained in bulk, hop after
 *               hop, until nothing is owed and nothing is offered.
 *
 * No node budget, no "Keep walking". Two valves only: a one-time MEMORY
 * CHECKPOINT (`TRACE_CHECKPOINT_NODES`) that asks once and never again for
 * that focal, and a request failsafe that surfaces as an ERROR — a server
 * bug must not become a request loop, and must not become silence either.
 * A failed step is never auto-retried; `retryWalk` gives it one more go.
 * Closing the lens (or re-anchoring) aborts in-flight requests.
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

/** Full-flow initial fetch depth — the closure contract's max, so the first
 *  response already carries as much of the flow as one call can. */
export const FULL_WALK_INITIAL_DEPTH = 25
/** Requests the driver holds in flight at once. */
export const FULL_WALK_CONCURRENCY = 4
/** Cursor-less frontier anchors re-seeded per request — the wire cap, so a
 *  big page (`WALK_PAGE_NODES`) has enough anchors to fill from. */
export const WALK_BATCH_SIZE = 500
/** The page every CONTINUATION asks for — the server's hard ceiling
 *  (`TRACE_MAX_NODES_HARD`). The first request keeps the default (2,000) so
 *  the focus paints fast; everything the driver fires to complete the
 *  picture takes the biggest page it can: measured on the wide table's one
 *  hop, 10 pages of 2k in 4.6 s against 2 pages of 10k in 2.5 s, and every
 *  page skipped is a merge, a layout and a render of the board skipped too. */
export const WALK_PAGE_NODES = 10_000
/** The one-time memory checkpoint: past this many nodes the walk parks ONCE
 *  and asks; `continuePastCheckpoint` lifts it for the focal for good. */
export const TRACE_CHECKPOINT_NODES = 50_000
/** Failsafe against a frontier that never converges (every request either
 *  drains what it named or advances a cursor, so this should be
 *  unreachable). Reached, it is reported as an ERROR, never as silence. */
export const WALK_REQUEST_FAILSAFE = 2_000
/** Known urns shipped as `excludeUrns` (wire cap). Budget steering, not
 *  correctness — an edge into an un-excluded known node simply re-arrives
 *  and `mergeClosures` dedupes it. */
const EXCLUDE_CAP = 2000

export type WalkPhase = 'loading' | 'seeding' | 'walking' | 'done' | 'checkpoint' | 'error'

/** Where the walk stands for one focal — what the strip and the capsule
 *  narrate. `pending` = frontier entries still to drain in THIS mode (cut
 *  entries and paged hubs always; depth entries in full flow). */
export interface WalkProgress {
    phase: WalkPhase
    nodes: number
    flows: number
    requests: number
    pending: number
    /** The reader lifted the memory checkpoint for this focal. */
    unbounded: boolean
    /** The failure reason the latest page reported, when the phase is error. */
    error: string | null
}

export interface WalkEntry {
    model: LensWalkModel
    status: LensWalkStatus
    error: string | null
    /** Key `${dir}:${urn}` (or `seed:<urn>` / `bulk:<dir>:<urn>`) — per-op
     *  spinners; absent = idle. */
    extendStatus: ReadonlyMap<string, 'loading' | 'error'>
    /** The upstream/downstream depth THIS entry's own model was fetched at
     *  (the hook's own `initialDepth` param, escalated to
     *  `FULL_WALK_INITIAL_DEPTH` when full flow is on). Stepping Back to an
     *  already-walked focal reads its OWN depth here. */
    depth: number
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
     *  `runFrontierOp`). A response that still owes contents (a seed
     *  cursor) is followed by the hook until it drains. */
    extend: (cardUrn: string, dir: LensWalkDir, seedLeaves: string[]) => void
    /** Page a specific node's already-partial adjacency further, given its
     *  frontier entry's `nextCursor`. The hook never interprets cursors —
     *  it forwards them verbatim. Same 'done'-entry precondition as
     *  `extend`. */
    page: (cardUrn: string, dir: LensWalkDir, cursor: string) => void
    /** Re-kick a failed extend (same request shape and precondition as
     *  `extend`). */
    retryExtend: (cardUrn: string, dir: LensWalkDir, seedLeaves: string[]) => void
    /** Page the FOCUS's own contents further (the model's `seedCursor`).
     *  The driver does this by itself; exposed for callers that want to
     *  nudge it. */
    pageSeeds: (focusUrn: string) => void
    /** Where the walk stands for `urn`'s entry, or null when never touched. */
    walkProgressFor: (urn: string) => WalkProgress | null
    /** Lift the one-time memory checkpoint for `urn`'s walk. */
    continuePastCheckpoint: (urn: string) => void
    /** Give every failed step of `urn`'s walk one more attempt. */
    retryWalk: (urn: string) => void
}

const EMPTY_EXTEND_STATUS: ReadonlyMap<string, 'loading' | 'error'> = new Map()

interface WalkMeta {
    requests: number
    unbounded: boolean
}
const EMPTY_META: WalkMeta = { requests: 0, unbounded: false }

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

/** The model's currently-known participant urns, for `excludeUrns`. */
function knownUrns(model: LensWalkModel): string[] {
    return model.nodes.map(n => n.urn).slice(0, EXCLUDE_CAP)
}

/** `extend`/`page` both walk ONE direction one hop; the other direction's
 *  depth is explicitly 0 (not omitted) per the closure request contract. */
function depthFields(dir: LensWalkDir, value: number): Pick<TraceClosureRequest, 'upstreamDepth' | 'downstreamDepth'> {
    return dir === 'up' ? { upstreamDepth: value, downstreamDepth: 0 } : { upstreamDepth: 0, downstreamDepth: value }
}

/** The frontier entries this mode still has to drain, per direction. */
function owedEntries(model: LensWalkModel, dir: LensWalkDir, fullWalk: boolean) {
    const list = dir === 'up' ? model.frontierUp : model.frontierDown
    return list.filter(f => f.kind === 'cut' || f.nextCursor !== null || fullWalk)
}

export function useLensWalk(
    /** Current focal, or null when the lens is closed (clears the session). */
    focusUrn: string | null,
    /** Null = no provider reachable; every focal degrades to 'unsupported'. */
    provider: GraphDataProvider | null,
    /** Persisted upstream/downstream depth for the initial fetch. */
    initialDepth = 1,
    /** Full flow: fetch the initial closure DEEP and drain every frontier
     *  entry, depth ones included, until the flow is complete. */
    fullWalk = false,
): LensWalkData {
    const [state, setState] = useState<Map<string, WalkEntry>>(() => new Map())
    // Per-cacheKey walk bookkeeping: requests issued (for the failsafe and
    // the narration) and whether the checkpoint was lifted. Render state,
    // not a ref — the phase must be derivable at render time.
    const [walkMeta, setWalkMeta] = useState<Map<string, WalkMeta>>(() => new Map())
    // Permanent per-cacheKey guard: added before the fetch, removed only on
    // error (so an explicit retry can re-enter). A 'done' or 'unsupported'
    // entry stays marked forever — cache hit, never refetched.
    const startedRef = useRef<Set<string>>(new Set())
    // Transient per-(cacheKey, statusKey) guard: single-flight only, removed
    // once the request settles either way.
    const inFlightRef = useRef<Set<string>>(new Set())
    const sessionRef = useRef(0)
    // Every request of the session hangs off this controller: closing the
    // lens aborts them all (and the server stops working on them).
    const abortRef = useRef<AbortController>(new AbortController())
    // extend/page need the LATEST model synchronously (to compute
    // excludeUrns, and to merge into) without retriggering on every
    // keystroke-adjacent render; committed mirror, current by the time a
    // callback reads it.
    const stateRef = useRef(state)
    useEffect(() => { stateRef.current = state }, [state])

    const bumpRequests = useCallback((cacheKey: string, n: number) => {
        setWalkMeta(prev => {
            const meta = prev.get(cacheKey) ?? EMPTY_META
            const next = new Map(prev)
            next.set(cacheKey, { ...meta, requests: meta.requests + n })
            return next
        })
    }, [])

    const runFetch = useCallback(async (urn: string) => {
        // Full flow wants the whole flow, so the opening fetch goes out at
        // the contract's max depth no matter what the one-hop pref says.
        const effectiveDepth = fullWalk ? Math.max(initialDepth, FULL_WALK_INITIAL_DEPTH) : initialDepth
        const cacheKey = cacheKeyFor(provider, urn)
        if (startedRef.current.has(cacheKey)) return

        if (typeof provider?.traceClosure !== 'function') {
            startedRef.current.add(cacheKey)
            setState(prev => setEntry(prev, cacheKey, {
                model: emptyWalkModel(urn), status: 'unsupported', error: null, extendStatus: EMPTY_EXTEND_STATUS,
                depth: effectiveDepth,
            }))
            return
        }

        startedRef.current.add(cacheKey)
        const session = sessionRef.current
        const signal = abortRef.current.signal
        setState(prev => setEntry(prev, cacheKey, {
            model: emptyWalkModel(urn), status: 'loading', error: null, extendStatus: EMPTY_EXTEND_STATUS,
            depth: initialDepth,
        }))
        bumpRequests(cacheKey, 1)
        try {
            const res = await provider.traceClosure({
                urn, direction: 'both', upstreamDepth: effectiveDepth, downstreamDepth: effectiveDepth,
            }, { signal })
            if (session !== sessionRef.current) return   // lens closed mid-flight
            setState(prev => setEntry(prev, cacheKey, {
                model: toLensClosure(res, urn), status: 'done', error: null, extendStatus: EMPTY_EXTEND_STATUS,
                depth: effectiveDepth,
            }))
        } catch (e) {
            if (session !== sessionRef.current) return
            startedRef.current.delete(cacheKey)   // allow retry
            setState(prev => setEntry(prev, cacheKey, {
                model: emptyWalkModel(urn), status: 'error',
                error: e instanceof Error ? e.message : String(e), extendStatus: EMPTY_EXTEND_STATUS,
                depth: effectiveDepth,
            }))
        }
    }, [provider, initialDepth, fullWalk, bumpRequests])

    /** Shared by every continuation op: fetch one further page and merge it
     *  into the CURRENT focal's model — `focusUrn` is captured here at call
     *  time, so a response landing after a re-center still lands on the
     *  focal it was actually requested for.
     *
     *  PRECONDITION, enforced below: the focal's entry must already be
     *  status 'done'. A call before that is a caller bug, not a state to
     *  recover from — silently ignored, by design (fabricating a base model
     *  from `emptyWalkModel` let a merge land while the initial fetch was
     *  still in flight, and that fetch's success handler REPLACES the whole
     *  entry wholesale).
     *
     *  A response that still OWES contents (a `seedCursor` on a request that
     *  named seeds) is followed: the same request goes out again with the
     *  cursor, until it drains. */
    const runFrontierOp = useCallback(async (
        cardUrn: string,
        dir: LensWalkDir | 'both',
        buildRequest: (baseModel: LensWalkModel) => TraceClosureRequest,
        statusKey: string,
        mergeCtx: { rootUrn: string; direction: 'up' | 'down' | 'both'; clearFrontierRoots?: string[] },
    ) => {
        if (!focusUrn) return
        if (typeof provider?.traceClosure !== 'function') return   // unsupported: nothing to extend/page
        const cacheKey = cacheKeyFor(provider, focusUrn)
        const startEntry = stateRef.current.get(cacheKey)
        if (startEntry?.status !== 'done') return
        const flightKey = `${cacheKey}|${statusKey}`
        if (inFlightRef.current.has(flightKey)) return
        inFlightRef.current.add(flightKey)
        const session = sessionRef.current
        const signal = abortRef.current.signal
        const baseModel = startEntry.model
        const request = buildRequest(baseModel)

        // Seeded from `prev`, NEVER from the entry read out of the ref
        // above: that mirror is a render behind, so a second op fired in
        // the same tick would write the pre-op entry back.
        setState(prev => setEntry(
            prev, cacheKey, withExtendStatus(prev.get(cacheKey) ?? startEntry, statusKey, 'loading'),
        ))
        bumpRequests(cacheKey, 1)

        let followUp: string | null = null
        // The model the follow-up builds its excludes from. React applies
        // the functional update below lazily, so the committed state is not
        // readable here yet; the merge is pure and idempotent, so merging
        // the response onto the latest mirror gives the same nodes (an
        // op that landed between is at worst missing from the EXCLUDES,
        // which only steers the budget — its re-arrival dedupes).
        let mergedModel: LensWalkModel | null = null
        try {
            const res = await provider.traceClosure(request, { signal })
            if (session !== sessionRef.current) return   // lens closed mid-flight
            // A seeded request that still owes contents is followed, with
            // the same shape plus the cursor. The focus's own cursor rides
            // in the model instead (the driver pages it).
            if (res.seedCursor && request.seedUrns && mergeCtx.rootUrn !== focusUrn) {
                followUp = res.seedCursor
                const latest = stateRef.current.get(cacheKey)?.model ?? baseModel
                mergedModel = mergeClosures(latest, res, mergeCtx)
            }
            setState(prev => {
                const entry = prev.get(cacheKey)
                if (!entry) return prev   // session cleared/re-created before this landed
                const merged = mergeClosures(entry.model, res, mergeCtx)
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
        if (followUp !== null) {
            const cursor = followUp
            const base = mergedModel
            void runFrontierOp(cardUrn, dir, (m) => ({ ...buildRequest(base ?? m), seedCursor: cursor, maxNodes: WALK_PAGE_NODES }), statusKey, mergeCtx)
        }
    }, [provider, focusUrn, bumpRequests])

    const extend = useCallback((cardUrn: string, dir: LensWalkDir, seedLeaves: string[]) => {
        void runFrontierOp(cardUrn, dir, (baseModel) => ({
            urn: cardUrn,
            direction: dir === 'up' ? 'upstream' : 'downstream',
            ...depthFields(dir, 1),
            seedUrns: seedLeaves,
            excludeUrns: knownUrns(baseModel),
        }), `${dir}:${cardUrn}`, { rootUrn: cardUrn, direction: dir })
    }, [runFrontierOp])

    const page = useCallback((cardUrn: string, dir: LensWalkDir, cursor: string) => {
        void runFrontierOp(cardUrn, dir, () => ({
            urn: cardUrn,
            direction: dir === 'up' ? 'upstream' : 'downstream',
            ...depthFields(dir, 1),
            afterCursor: cursor,
            maxNodes: WALK_PAGE_NODES,
        }), `${dir}:${cardUrn}`, { rootUrn: cardUrn, direction: dir })
    }, [runFrontierOp])

    // The focus's own contents page: focus-anchored, both directions at the
    // entry's fetched depth, resuming the model's seedCursor. Own status key
    // ('seed:<focus>') so it never collides with a real `up:` op on the
    // focus (either would block the other).
    const pageSeeds = useCallback((walkFocusUrn: string) => {
        const cacheKey = cacheKeyFor(provider, walkFocusUrn)
        const entry = stateRef.current.get(cacheKey)
        const cursor = entry?.model.seedCursor
        if (!cursor || !entry) return
        void runFrontierOp(walkFocusUrn, 'both', (baseModel) => ({
            urn: walkFocusUrn,
            direction: 'both',
            upstreamDepth: entry.depth,
            downstreamDepth: entry.depth,
            seedCursor: cursor,
            excludeUrns: knownUrns(baseModel),
            maxNodes: WALK_PAGE_NODES,
        }), `seed:${walkFocusUrn}`, { rootUrn: walkFocusUrn, direction: 'both' })
    }, [provider, runFrontierOp])

    // A bulk re-seed: one request for up to WALK_BATCH_SIZE cursor-less
    // anchors in one direction. The response is authoritative for every
    // anchor it named (clearFrontierRoots), and rootUrn is the first anchor
    // — NOT the focus — so the focus's seed cursor is never touched.
    const bulk = useCallback((anchors: string[], dir: LensWalkDir, walkFocusUrn: string) => {
        void runFrontierOp(anchors[0]!, dir, (baseModel) => ({
            urn: anchors[0]!,
            direction: dir === 'up' ? 'upstream' : 'downstream',
            ...depthFields(dir, 1),
            seedUrns: anchors,
            excludeUrns: knownUrns(baseModel),
            maxNodes: WALK_PAGE_NODES,
        }), `bulk:${dir}:${walkFocusUrn}`, { rootUrn: anchors[0]!, direction: dir, clearFrontierRoots: anchors })
    }, [runFrontierOp])

    // ── The driver ───────────────────────────────────────────────────────
    // Reactive loop: each merged response updates `state`, which re-runs
    // this effect, which fires the next wave. Terminates because every
    // request either drains what it named or advances a cursor; the
    // checkpoint and the failsafe bound it besides. A step that FAILED keeps
    // its 'error' marker and is never auto-retried — the walk stops
    // honestly instead of looping on a broken hop.
    useEffect(() => {
        if (!focusUrn) return
        const cacheKey = cacheKeyFor(provider, focusUrn)
        const entry = state.get(cacheKey)
        if (entry?.status !== 'done') return
        const meta = walkMeta.get(cacheKey) ?? EMPTY_META
        if (meta.requests >= WALK_REQUEST_FAILSAFE) return
        if (!meta.unbounded && entry.model.nodes.length >= TRACE_CHECKPOINT_NODES) return
        let slots = FULL_WALK_CONCURRENCY
        for (const v of entry.extendStatus.values()) if (v === 'loading') slots--
        if (slots <= 0) return

        // 1. The focus's own owed contents FIRST — nothing else can complete
        //    the picture of the thing the user asked about.
        if (entry.model.seedCursor && !entry.extendStatus.has(`seed:${focusUrn}`)) {
            pageSeeds(focusUrn)
            return
        }
        // 2. Paged hubs, per anchor (a cursor is per adjacency by contract).
        for (const dir of ['up', 'down'] as const) {
            for (const fr of owedEntries(entry.model, dir, fullWalk)) {
                if (slots <= 0) return
                if (fr.nextCursor === null || entry.extendStatus.has(`${dir}:${fr.urn}`)) continue
                page(fr.urn, dir, fr.nextCursor)
                slots--
            }
        }
        // 3. Cursor-less entries, in BULK per direction: cut entries in every
        //    mode, depth entries only in full flow.
        for (const dir of ['up', 'down'] as const) {
            if (slots <= 0) return
            if (entry.extendStatus.has(`bulk:${dir}:${focusUrn}`)) continue
            const anchors = owedEntries(entry.model, dir, fullWalk)
                .filter(fr => fr.nextCursor === null && !entry.extendStatus.has(`${dir}:${fr.urn}`))
                .map(fr => fr.urn)
                .slice(0, WALK_BATCH_SIZE)
            if (anchors.length === 0) continue
            bulk(anchors, dir, focusUrn)
            slots--
        }
    }, [fullWalk, focusUrn, provider, state, walkMeta, page, pageSeeds, bulk])

    const walkProgressFor = useCallback((urn: string): WalkProgress | null => {
        const cacheKey = cacheKeyFor(provider, urn)
        const entry = state.get(cacheKey)
        if (!entry) return null
        const meta = walkMeta.get(cacheKey) ?? EMPTY_META
        const base = {
            nodes: entry.model.nodes.length,
            flows: entry.model.lineageEdges.length,
            requests: meta.requests,
            unbounded: meta.unbounded,
            error: null as string | null,
        }
        if (entry.status === 'loading') return { ...base, phase: 'loading', pending: 0 }
        if (entry.status === 'error') return { ...base, phase: 'error', pending: 0, error: entry.error }
        if (entry.status === 'unsupported') return { ...base, phase: 'done', pending: 0 }
        const owed = owedEntries(entry.model, 'up', fullWalk).length + owedEntries(entry.model, 'down', fullWalk).length
            + (entry.model.seedCursor ? 1 : 0)
        let anyLoading = false
        let anyError = false
        for (const v of entry.extendStatus.values()) {
            if (v === 'loading') anyLoading = true
            if (v === 'error') anyError = true
        }
        if (anyLoading) return { ...base, phase: fullWalk ? 'walking' : 'seeding', pending: owed }
        if (owed === 0) return { ...base, phase: 'done', pending: 0 }
        if (meta.requests >= WALK_REQUEST_FAILSAFE) {
            return { ...base, phase: 'error', pending: owed, error: 'the walk did not converge' }
        }
        if (!meta.unbounded && entry.model.nodes.length >= TRACE_CHECKPOINT_NODES) {
            return { ...base, phase: 'checkpoint', pending: owed }
        }
        if (anyError) return { ...base, phase: 'error', pending: owed, error: entry.model.truncationReason ?? 'a step failed' }
        // Candidates remain and nothing is in flight: the driver is about to
        // fire (it runs after this render).
        return { ...base, phase: fullWalk ? 'walking' : 'seeding', pending: owed }
    }, [provider, state, walkMeta, fullWalk])

    const retryWalk = useCallback((urn: string) => {
        const cacheKey = cacheKeyFor(provider, urn)
        // Failed steps get one more attempt: clearing the 'error' markers
        // makes them candidates for the driver again.
        setState(prev => {
            const entry = prev.get(cacheKey)
            if (!entry) return prev
            const nextStatus = new Map(entry.extendStatus)
            let cleared = false
            for (const [k, v] of entry.extendStatus) {
                if (v === 'error') { nextStatus.delete(k); cleared = true }
            }
            if (!cleared) return prev
            return setEntry(prev, cacheKey, { ...entry, extendStatus: nextStatus })
        })
    }, [provider])

    const continuePastCheckpoint = useCallback((urn: string) => {
        const cacheKey = cacheKeyFor(provider, urn)
        setWalkMeta(prev => {
            const meta = prev.get(cacheKey) ?? EMPTY_META
            const next = new Map(prev)
            next.set(cacheKey, { ...meta, unbounded: true })
            return next
        })
    }, [provider])

    // Initial fetch on focal change.
    useEffect(() => {
        if (!focusUrn) return
        void runFetch(focusUrn)
    }, [focusUrn, runFetch])

    // Session lifecycle: clear everything when the lens closes so a new
    // session starts from the data source, not from a stale picture — and
    // abort whatever is still in flight.
    useEffect(() => {
        if (focusUrn) return
        if (startedRef.current.size === 0 && inFlightRef.current.size === 0) return
        abortRef.current.abort()
        abortRef.current = new AbortController()
        sessionRef.current += 1
        startedRef.current.clear()
        inFlightRef.current.clear()
        setState(new Map())
        setWalkMeta(new Map())
    }, [focusUrn])

    const walkFor = useCallback(
        (urn: string): WalkEntry | null => state.get(cacheKeyFor(provider, urn)) ?? null,
        [state, provider],
    )

    const retry = useCallback((urn: string) => { void runFetch(urn) }, [runFetch])

    return {
        walkFor, retry, extend, page, retryExtend: extend, pageSeeds,
        walkProgressFor, continuePastCheckpoint, retryWalk,
    }
}
