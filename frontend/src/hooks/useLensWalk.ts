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
 *
 * Full walk (trace mode): with `fullWalk` on, the hook drives those same
 * ops itself — deep initial fetch, then every frontier followed to
 * exhaustion under a node budget — see the driver effect below.
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

/** Full-walk (trace) initial fetch depth — the closure contract's max, so
 *  the first response already carries as much of the flow as one call can. */
export const FULL_WALK_INITIAL_DEPTH = 25
/** Full-walk safety budget: the driver stops once the model holds this many
 *  nodes (times the grants "Keep walking" has added). */
export const FULL_WALK_NODE_BUDGET = 1000
/** Frontier ops the driver holds in flight at once. */
export const FULL_WALK_CONCURRENCY = 4
/** Failsafe per budget grant against a frontier that never drains (each op
 *  either clears its entry or advances its cursor, so this should be
 *  unreachable — it exists so a server bug cannot become a request loop). */
const FULL_WALK_REQUEST_CAP = 300
/** Budget grants the ENGINE applies by itself before ever asking the user
 *  (2026-08-19 ruling: "I click trace and this happens behind the scenes
 *  automatically" — no "Keep walking" pedaling on ANY surface). ~25k nodes
 *  hands-free; only past the ceiling does budgetHit surface, as the true
 *  runaway valve, and each manual continue grants one more unit. */
const FULL_WALK_AUTO_GRANTS = 24
/** ESCALATION (2026-08-19, MEASURED on solidatus_perf_large): one
 *  6000-node BFS takes 1.9s while draining the same flow through
 *  per-anchor frontier waves needs ~2,300 round trips — minutes. When a
 *  page comes back max_nodes-truncated with a frontier wider than this,
 *  the driver re-fetches the WHOLE walk with a bigger page budget
 *  (excludes keep known nodes off the wire) instead of chasing entries. */
const ESCALATION_MIN_FRONTIER = 24
/** Page-budget ladder: default → ×3 per escalation, capped by the
 *  server's TRACE_MAX_NODES_HARD. */
const PAGE_BUDGET_START = 2000
const PAGE_BUDGET_MAX = 10_000

/** Where the full walk stands for one focal. At most one of
 *  exhausted/budgetHit/stalled is true; all false only while walking. */
export interface FullWalkStatus {
    /** Ops in flight, or candidates remain and the driver will fire them. */
    walking: boolean
    /** Every frontier drained — the whole flow is in the model. */
    exhausted: boolean
    /** Frontiers remain but the node budget (or request cap) is spent;
     *  `continueFullWalk` grants another round. */
    budgetHit: boolean
    /** Frontiers remain but every candidate op has failed;
     *  `continueFullWalk` clears the failures for another attempt. */
    stalled: boolean
}

export interface WalkEntry {
    model: LensWalkModel
    status: LensWalkStatus
    error: string | null
    /** Key `${dir}:${urn}` — per-pill spinners; absent = idle. */
    extendStatus: ReadonlyMap<string, 'loading' | 'error'>
    /** The upstream/downstream depth THIS entry's own model was fetched
     *  at (T28 R1 — the hook's own `initialDepth` param, escalated to
     *  `FULL_WALK_INITIAL_DEPTH` when full walk is on; the depth control
     *  that used to re-fetch a focal deeper is gone). Stepping Back to an
     *  already-walked focal reads its OWN depth here, never whatever the
     *  depth preference currently says. */
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
    /** Page the FOCUS's own capped contents further (the model's
     *  `seedCursor`). Focus-anchored, both directions, excludes what is
     *  held. Same 'done'-entry precondition as `extend`. */
    pageSeeds: (focusUrn: string) => void
    /** Full-walk status for `urn`'s entry, or null when the mode is off or
     *  the entry was never touched. */
    fullWalkFor: (urn: string) => FullWalkStatus | null
    /** Grant the full walk another budget round for `urn`'s entry, and give
     *  its failed frontier ops one more attempt. */
    continueFullWalk: (urn: string) => void
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
    /** Trace mode: fetch the initial closure DEEP and auto-follow every
     *  frontier until the flow is exhausted or the node budget is hit. */
    fullWalk = false,
): LensWalkData {
    const [state, setState] = useState<Map<string, WalkEntry>>(() => new Map())
    // Full-walk bookkeeping per cacheKey: budget grants ("Keep walking"
    // adds one) and requests issued (for the request-cap failsafe). Render
    // state, not a ref — budgetHit must be derivable at render time.
    const [fullWalkMeta, setFullWalkMeta] = useState<Map<string, { grants: number; requests: number; pageBudget?: number }>>(() => new Map())
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
    // callback reads it.
    const stateRef = useRef(state)
    useEffect(() => { stateRef.current = state }, [state])

    const runFetch = useCallback(async (urn: string) => {
        // Full walk wants the whole flow, so the opening fetch goes out at
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
        setState(prev => setEntry(prev, cacheKey, {
            model: emptyWalkModel(urn), status: 'loading', error: null, extendStatus: EMPTY_EXTEND_STATUS,
            depth: initialDepth,
        }))
        try {
            const res = await provider.traceClosure({
                urn, direction: 'both', upstreamDepth: effectiveDepth, downstreamDepth: effectiveDepth,
            })
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
    }, [provider, initialDepth, fullWalk])

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
        /** Own status key for ops that are NOT a directional extend/page of
         *  the card — the seed page must never collide with the focus's
         *  real `up:` pill (either would block the other). */
        statusKeyOverride?: string,
        /** Escalation merges replace the frontier/truncation wholesale —
         *  see mergeClosures' ctx doc. */
        replaceFrontier?: boolean,
    ) => {
        if (!focusUrn) return
        if (typeof provider?.traceClosure !== 'function') return   // unsupported: nothing to extend/page
        const cacheKey = cacheKeyFor(provider, focusUrn)
        const startEntry = stateRef.current.get(cacheKey)
        if (startEntry?.status !== 'done') return
        const statusKey = statusKeyOverride ?? `${dir}:${cardUrn}`
        const flightKey = `${cacheKey}|${statusKey}`
        if (inFlightRef.current.has(flightKey)) return
        inFlightRef.current.add(flightKey)
        const session = sessionRef.current
        const baseModel = startEntry.model

        // Seeded from `prev`, NEVER from the entry read out of the ref
        // above: that mirror is a render behind, so a second pill clicked
        // in the same tick wrote the pre-click entry back — wiping the
        // first pill's spinner (and any hop that had landed between the
        // two) and leaving a click that visibly did nothing. `startEntry`
        // is the fallback only for the impossible case of the entry
        // vanishing between the guard and here.
        setState(prev => setEntry(
            prev, cacheKey, withExtendStatus(prev.get(cacheKey) ?? startEntry, statusKey, 'loading'),
        ))

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
                const merged = mergeClosures(entry.model, res, { rootUrn: cardUrn, direction: dir, replaceFrontier })
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

    // The focus's own contents page: focus-anchored, both directions at
    // the entry's fetched depth, resuming the model's seedCursor. Uses
    // the SAME single-flight/status machinery as extend/page (statusKey
    // 'seed:<focus>'), so the click is acknowledged and never doubled.
    const pageSeeds = useCallback((walkFocusUrn: string) => {
        const cacheKey = cacheKeyFor(provider, walkFocusUrn)
        const entry = stateRef.current.get(cacheKey)
        const cursor = entry?.model.seedCursor
        if (!cursor) return
        void runFrontierOp(walkFocusUrn, 'up', (baseModel) => ({
            urn: walkFocusUrn,
            direction: 'both',
            upstreamDepth: entry.depth,
            downstreamDepth: entry.depth,
            seedCursor: cursor,
            excludeUrns: knownUrns(baseModel).slice(0, 2000),
        }), `seed:${walkFocusUrn}`)
    }, [provider, runFrontierOp])

    // The escalation re-fetch: the WHOLE walk again at a bigger page
    // budget, focus-anchored both ways; excludes keep known nodes off the
    // wire and the merge replaces frontier/truncation wholesale.
    const escalate = useCallback((walkFocusUrn: string, budget: number) => {
        const entry = stateRef.current.get(cacheKeyFor(provider, walkFocusUrn))
        const depth = entry?.depth ?? FULL_WALK_INITIAL_DEPTH
        void runFrontierOp(walkFocusUrn, 'up', (baseModel) => ({
            urn: walkFocusUrn,
            direction: 'both',
            upstreamDepth: depth,
            downstreamDepth: depth,
            maxNodes: budget,
            excludeUrns: knownUrns(baseModel).slice(0, 2000),
        }), `escalate:${walkFocusUrn}`, true)
    }, [provider, runFrontierOp])

    // ── Full walk (trace mode) ─────────────────────────────────────────
    // The hook itself follows every frontier the server reports — the same
    // extend/page ops an ⊕ click fires, driven to exhaustion. Reactive
    // loop: each merged response updates `state`, which re-runs this
    // effect, which fires the next wave. Terminates because every op
    // either clears its frontier entry or advances its cursor, and the
    // node budget / request cap bound it besides. A frontier op that
    // FAILED keeps its 'error' marker and is never auto-retried — the
    // walk stalls honestly instead of looping on a broken hop.
    useEffect(() => {
        if (!fullWalk || !focusUrn) return
        const cacheKey = cacheKeyFor(provider, focusUrn)
        const entry = state.get(cacheKey)
        if (entry?.status !== 'done') return
        const meta = fullWalkMeta.get(cacheKey) ?? { grants: 1, requests: 0 }
        // Hands-free continuation: a budget park inside the auto-grant
        // ceiling grants itself onward (a state write in an effect is fine
        // here — it strictly advances `grants`, so it cannot cascade).
        const parked = entry.model.nodes.length >= FULL_WALK_NODE_BUDGET * meta.grants
            || meta.requests >= FULL_WALK_REQUEST_CAP * meta.grants
        if (parked) {
            if (meta.grants >= FULL_WALK_AUTO_GRANTS) return
            setFullWalkMeta(prev => {
                const cur = prev.get(cacheKey) ?? { grants: 1, requests: 0 }
                const next = new Map(prev)
                next.set(cacheKey, { grants: cur.grants + 1, requests: cur.requests })
                return next
            })
            return
        }
        let slots = FULL_WALK_CONCURRENCY
        for (const v of entry.extendStatus.values()) if (v === 'loading') slots--
        if (slots <= 0) return
        // The focus's own capped contents page FIRST — nothing else can
        // complete the picture of the thing the user asked about.
        if (entry.model.seedCursor && !entry.extendStatus.has(`seed:${focusUrn}`)) {
            setFullWalkMeta(prev => {
                const next = new Map(prev)
                next.set(cacheKey, { grants: meta.grants, requests: meta.requests + 1 })
                return next
            })
            pageSeeds(focusUrn)
            return
        }
        // ESCALATION before frontier chasing: a max_nodes-truncated page
        // with a wide frontier means the flow is far bigger than the page
        // — ONE bigger re-walk beats hundreds of per-anchor round trips.
        const frontierWidth = entry.model.frontierUp.length + entry.model.frontierDown.length
        const pageBudget = meta.pageBudget ?? PAGE_BUDGET_START
        if (
            entry.model.truncationReason === 'max_nodes'
            && frontierWidth >= ESCALATION_MIN_FRONTIER
            && pageBudget < PAGE_BUDGET_MAX
            && !entry.extendStatus.has(`escalate:${focusUrn}`)
        ) {
            const nextBudget = Math.min(pageBudget * 3, PAGE_BUDGET_MAX)
            setFullWalkMeta(prev => {
                const cur = prev.get(cacheKey) ?? { grants: 1, requests: 0 }
                const next = new Map(prev)
                next.set(cacheKey, { ...cur, requests: cur.requests + 1, pageBudget: nextBudget })
                return next
            })
            escalate(focusUrn, nextBudget)
            return
        }
        const ops: Array<{ urn: string; dir: LensWalkDir; cursor: string | null }> = []
        const collect = (frontierList: LensWalkModel['frontierUp'], dir: LensWalkDir) => {
            for (const fr of frontierList) {
                if (ops.length >= slots) return
                if (entry.extendStatus.has(`${dir}:${fr.urn}`)) continue
                ops.push({ urn: fr.urn, dir, cursor: fr.nextCursor })
            }
        }
        collect(entry.model.frontierUp, 'up')
        collect(entry.model.frontierDown, 'down')
        if (ops.length === 0) return
        setFullWalkMeta(prev => {
            const next = new Map(prev)
            next.set(cacheKey, { grants: meta.grants, requests: meta.requests + ops.length })
            return next
        })
        for (const op of ops) {
            // A cursor entry's adjacency is partially shipped — page it
            // onward; a cursor-less entry is depth-exhausted — extend from
            // it, seeded with the node itself (the server resolves the
            // seed to whatever grain carries lineage beneath it).
            if (op.cursor !== null) page(op.urn, op.dir, op.cursor)
            else extend(op.urn, op.dir, [op.urn])
        }
    }, [fullWalk, focusUrn, provider, state, fullWalkMeta, extend, page, pageSeeds, escalate])

    const fullWalkFor = useCallback((urn: string): FullWalkStatus | null => {
        if (!fullWalk) return null
        const cacheKey = cacheKeyFor(provider, urn)
        const entry = state.get(cacheKey)
        if (!entry) return null
        if (entry.status === 'loading') return { walking: true, exhausted: false, budgetHit: false, stalled: false }
        if (entry.status !== 'done') return { walking: false, exhausted: false, budgetHit: false, stalled: false }
        const meta = fullWalkMeta.get(cacheKey) ?? { grants: 1, requests: 0 }
        let anyLoading = false
        for (const v of entry.extendStatus.values()) if (v === 'loading') anyLoading = true
        const frontierCount = entry.model.frontierUp.length + entry.model.frontierDown.length
            + (entry.model.seedCursor ? 1 : 0)
        if (frontierCount === 0) return { walking: anyLoading, exhausted: !anyLoading, budgetHit: false, stalled: false }
        const overBudget = entry.model.nodes.length >= FULL_WALK_NODE_BUDGET * meta.grants
            || meta.requests >= FULL_WALK_REQUEST_CAP * meta.grants
        if (overBudget) {
            // Inside the auto-grant ceiling a park is invisible — the
            // driver is about to grant itself onward, so the surfaces
            // keep narrating "walking" instead of asking.
            if (meta.grants < FULL_WALK_AUTO_GRANTS) {
                return { walking: true, exhausted: false, budgetHit: false, stalled: false }
            }
            return { walking: anyLoading, exhausted: false, budgetHit: !anyLoading, stalled: false }
        }
        const hasCandidate =
            entry.model.frontierUp.some(fr => !entry.extendStatus.has(`up:${fr.urn}`))
            || entry.model.frontierDown.some(fr => !entry.extendStatus.has(`down:${fr.urn}`))
            || (entry.model.seedCursor != null && !entry.extendStatus.has(`seed:${urn}`))
        if (anyLoading || hasCandidate) return { walking: true, exhausted: false, budgetHit: false, stalled: false }
        return { walking: false, exhausted: false, budgetHit: false, stalled: true }
    }, [fullWalk, provider, state, fullWalkMeta])

    const continueFullWalk = useCallback((urn: string) => {
        const cacheKey = cacheKeyFor(provider, urn)
        setFullWalkMeta(prev => {
            const meta = prev.get(cacheKey) ?? { grants: 1, requests: 0 }
            const next = new Map(prev)
            next.set(cacheKey, { grants: meta.grants + 1, requests: meta.requests })
            return next
        })
        // Failed frontier ops get one more attempt: clearing the 'error'
        // markers makes them candidates for the driver again.
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
        setFullWalkMeta(new Map())
    }, [focusUrn])

    const walkFor = useCallback(
        (urn: string): WalkEntry | null => state.get(cacheKeyFor(provider, urn)) ?? null,
        [state, provider],
    )

    const retry = useCallback((urn: string) => { void runFetch(urn) }, [runFetch])

    return { walkFor, retry, extend, page, retryExtend: extend, pageSeeds, fullWalkFor, continueFullWalk }
}
