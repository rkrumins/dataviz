/**
 * useTraceDriver — the trace's fetch engine: ONE grain, ONE hop, on demand.
 *
 * WHAT IT REPLACES. The canvas trace used to mount `useLensWalk` with
 * `fullWalk` on: a deep closure of the focus followed by every frontier
 * drained to exhaustion. Measured on the 2.08M-node estate, that is 9.7 s and
 * 3,040 nodes for ONE attribute — with 123 frontier entries still unfollowed
 * — before a single card is drawn. The user's ruling ended it: "we cannot be
 * applying limits for this and make it lazy loaded so we fetch the
 * upstream/downstream entity and their containments. Can be expanded lazily
 * or do it on the fly."
 *
 * So this driver fetches what is on screen, and fetches again when the reader
 * opens something:
 *
 *   idle ──start──▶ coarse ──▶ ready
 *                     └─fail──▶ error ──retry──▶ coarse
 *
 *  • COARSE is one request (plus its cursor pages): the focus, its
 *    containment chain, the lineage-carrying children inside it, and every
 *    partner one hop away at the grain the lineage lane offers, each with its
 *    own ancestor chain. On the same 2.08M estate that is 25 ms warm.
 *  • DRILL is one request per card the reader opens, ever — `drilled` is the
 *    ledger of what has been asked for, and a card is never asked twice.
 *  • CURSORS ARE FOLLOWED, NOT SHOWN. A response that could not fit its page
 *    carries `seedCursor` (more contents) or a frontier `nextCursor` (more of
 *    one anchor's edges); the driver drains both. There is no budget, no
 *    "Keep walking", and no `max_nodes` — the only stop is exhaustion.
 *
 * ONE MODEL. Every response merges into the same `LensWalkModel` through
 * `mergeClosures`, so the view model, the ledger and the wires all read one
 * accumulating picture. The model's identity changes ONLY when a merge lands
 * — an unrelated re-render hands back the same object, which is what keeps
 * `buildTraceView` from recomputing under the reader.
 *
 * COMPLETENESS IS A CLAIM ABOUT CONES. `completePairs` names the pairs whose
 * raw detail is genuinely all here: both endpoints' whole containment cones
 * are leaf-or-drilled. The wire ledger uses it to decide whether a rollup has
 * anything left to say over the raw hops beneath it — and under a lazy
 * engine, "the model IS the fine closure" (Stage 1's standing assumption) is
 * exactly what stops being true.
 *
 * ABORT ON EXIT. Leaving a trace, or re-anchoring on a new focus, aborts the
 * session's `AbortController` and bumps a generation token; a response that
 * lands after either is dropped rather than merged into a picture nobody is
 * looking at.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { GraphDataProvider, TraceClosureRequest } from '@/providers/GraphDataProvider'
import {
    mergeClosures,
    emptyWalkModel,
    type LensWalkModel,
} from '@/components/canvas/context-view/lens/closure-adapter'
import { pairKey } from './lib/traceWireLedger'

export type TracePhase = 'idle' | 'coarse' | 'ready' | 'error'
export type TraceDriverStatus = 'loading' | 'done' | 'error'

/** Failsafe against a server that hands back a cursor for ever. NOT a budget:
 *  every page either drains a frontier entry or advances a keyset, so this is
 *  unreachable in a healthy system — it exists so a bug cannot become an
 *  infinite request loop. */
const MAX_PAGES_PER_OP = 200

export interface TraceDriver {
    /** The accumulated picture. Non-null from the first render of a session
     *  (empty until the coarse response lands) so the overlay can key on
     *  "does it hold the focus" rather than on null. */
    model: LensWalkModel | null
    phase: TracePhase
    status: TraceDriverStatus
    error: string | null
    /** Cards with a drill in flight — the rows that show a spinner. */
    inFlight: ReadonlySet<string>
    /** Cards whose contents have been asked for. Never asked twice. */
    drilled: ReadonlySet<string>
    /** Pairs whose raw detail is fully loaded (see the file header). */
    completePairs: ReadonlySet<string>
    /** Fetch one card's contents and their hop-1 lineage. Idempotent. */
    drill: (urn: string) => void
    /** Re-run the coarse fetch for the current focus. */
    retry: () => void
    /** Drop everything in flight (exit). */
    abort: () => void
}

interface DriverState {
    focusUrn: string | null
    model: LensWalkModel | null
    phase: TracePhase
    error: string | null
    inFlight: ReadonlySet<string>
    drilled: ReadonlySet<string>
}

const EMPTY_SET: ReadonlySet<string> = new Set<string>()

const IDLE: DriverState = {
    focusUrn: null, model: null, phase: 'idle', error: null,
    inFlight: EMPTY_SET, drilled: EMPTY_SET,
}

/** One hop, one grain, both directions — the shape every lazy request has. */
function lazyRequest(urn: string, extra: Partial<TraceClosureRequest>): TraceClosureRequest {
    return {
        urn,
        direction: 'both',
        // Depth is not a dial on this path: the walk is one hop by
        // construction. 1/1 is what the endpoint's cursor guard requires of a
        // paging request, so every request carries the same pair.
        upstreamDepth: 1,
        downstreamDepth: 1,
        ...extra,
    }
}

/** Ancestors of `urn`, nearest first, `urn` included; cycle-guarded. */
function ancestorWalker(parentOf: Map<string, string>): (urn: string) => string[] {
    const cache = new Map<string, string[]>()
    return (urn: string): string[] => {
        const hit = cache.get(urn)
        if (hit) return hit
        const out: string[] = []
        const guard = new Set<string>()
        let cursor: string | undefined = urn
        while (cursor && !guard.has(cursor)) {
            guard.add(cursor)
            out.push(cursor)
            cursor = parentOf.get(cursor)
        }
        cache.set(urn, out)
        return out
    }
}

/**
 * The pairs whose raw detail is all here.
 *
 * A card is SETTLED when it can hold nothing the model has not got: it is a
 * graph-counted leaf (`childCount === 0`), or its contents have been drilled
 * — and everything inside it is settled too. A PAIR is complete when both
 * endpoints' whole cones are settled, because a rollup between two cards is a
 * statement about exactly those two cones.
 *
 * Computed over the raw hops' ancestor pairs — the same index the ledger
 * builds — so only pairs a wire could actually be drawn between are named.
 */
export function computeCompletePairs(
    model: LensWalkModel | null,
    drilled: ReadonlySet<string>,
): ReadonlySet<string> {
    if (!model) return EMPTY_SET

    const parentOf = new Map<string, string>()
    const childrenOf = new Map<string, string[]>()
    for (const c of model.containmentEdges) {
        if (parentOf.has(c.targetUrn)) continue        // first parent wins, as everywhere
        parentOf.set(c.targetUrn, c.sourceUrn)
        childrenOf.set(c.sourceUrn, [...(childrenOf.get(c.sourceUrn) ?? []), c.targetUrn])
    }
    const childCountOf = new Map<string, number>()
    for (const n of model.nodes) {
        const count = (n.data as { childCount?: unknown } | undefined)?.childCount
        childCountOf.set(n.urn, typeof count === 'number' ? count : 0)
    }

    const settledCache = new Map<string, boolean>()
    const settled = (urn: string): boolean => {
        const hit = settledCache.get(urn)
        if (hit !== undefined) return hit
        // Provisional false breaks a containment cycle without recursing for
        // ever; a cycle is malformed containment, and the honest answer for a
        // card whose own shape is unreadable is "not settled".
        settledCache.set(urn, false)
        const kids = childrenOf.get(urn) ?? []
        // Three ways a card's contents can be known: it is a graph-counted
        // leaf, the reader opened it, or the model already holds as many
        // children as the graph says it has — which is the ordinary case for
        // the ancestor chains a coarse response ships, and without it the
        // rollup at the lane root would keep a residual for ever over detail
        // that is entirely loaded.
        const ownContentsKnown = (childCountOf.get(urn) ?? 0) === 0
            || drilled.has(urn)
            || kids.length >= (childCountOf.get(urn) ?? 0)
        const answer = ownContentsKnown && kids.every(settled)
        settledCache.set(urn, answer)
        return answer
    }

    const ancestorsOrSelf = ancestorWalker(parentOf)
    const complete = new Set<string>()
    for (const e of model.lineageEdges) {
        if (e.kind === 'rollup') continue               // a rollup is not evidence of itself
        for (const a of ancestorsOrSelf(e.sourceUrn)) {
            if (!settled(a)) continue
            for (const b of ancestorsOrSelf(e.targetUrn)) {
                if (settled(b)) complete.add(pairKey(a, b))
            }
        }
    }
    return complete
}

export function useTraceDriver(
    focusUrn: string | null,
    provider: GraphDataProvider | null,
): TraceDriver {
    const [state, setState] = useState<DriverState>(IDLE)

    // The session: one controller to abort, one token to date responses by.
    // A response from a session the reader has left is DROPPED, not merged —
    // abort alone is not enough, because a request that already resolved is
    // past caring about its signal.
    const generation = useRef(0)
    const controller = useRef<AbortController | null>(null)
    // The live model, read by the merge path. State alone would hand a merge
    // whatever React last committed, and two responses landing in one tick
    // would then lose one of them.
    const modelRef = useRef<LensWalkModel | null>(null)
    // THE DRILL LEDGERS LIVE IN REFS, and state only mirrors them. A
    // functional `setState` updater is not called at the call site, so
    // deciding "have I already drilled this?" inside one and acting on the
    // answer outside it decides on a stale frame — which read as a card that
    // spins for ever, because the fetch that would clear it never fired.
    const drilledRef = useRef<Set<string>>(new Set())
    const inFlightRef = useRef<Set<string>>(new Set())
    const sessionFocus = useRef<string | null>(null)
    const [retryToken, setRetryToken] = useState(0)

    const newSession = useCallback((urn: string | null): number => {
        controller.current?.abort()
        controller.current = urn ? new AbortController() : null
        generation.current += 1
        modelRef.current = urn ? emptyWalkModel(urn) : null
        sessionFocus.current = urn
        // The coarse response ships the focus's own contents, so the focus is
        // drilled by the time it lands — opening it must not go back to the
        // network for what is already in hand.
        drilledRef.current = new Set(urn ? [urn] : [])
        inFlightRef.current = new Set()
        return generation.current
    }, [])

    /** Merge one response and publish it, unless the session has moved on. */
    const absorb = useCallback((
        gen: number,
        res: Awaited<ReturnType<NonNullable<GraphDataProvider['traceClosure']>>>,
        ctx: { rootUrn: string; direction: 'up' | 'down' | 'both' },
    ): boolean => {
        if (gen !== generation.current || !modelRef.current) return false
        const next = mergeClosures(modelRef.current, res, ctx)
        modelRef.current = next
        setState(prev => (prev.focusUrn === null ? prev : { ...prev, model: next }))
        return true
    }, [])

    /**
     * Run one request and every cursor page behind it.
     *
     * TWO CURSOR SPACES, drained in order. `seedCursor` pages the ANCHOR's own
     * contents (keyset over child urns — the resume for a page that stopped at
     * its edge ceiling), and a frontier entry's `nextCursor` pages ONE node's
     * edges in ONE direction. Both are re-issued verbatim: the driver never
     * interprets a cursor, it only carries it back.
     */
    const runOp = useCallback(async (
        gen: number,
        anchorUrn: string,
        base: TraceClosureRequest,
    ): Promise<void> => {
        const fetchClosure = provider?.traceClosure
        if (!fetchClosure || !provider) return
        const signal = controller.current?.signal
        let pages = 0

        // THE FIRST RESPONSE IS THE OPERATION. If it fails there is nothing to
        // draw and the caller turns it into an error the reader can retry.
        const first = await fetchClosure.call(provider, base, { signal })
        if (!absorb(gen, first, { rootUrn: anchorUrn, direction: 'both' })) return
        pages = 1

        // EVERYTHING AFTER IT IS A PAGE, and a page that fails is not a failed
        // trace: the picture on screen is real, its counts already read as
        // floors, and the frontier entry that could not be drained keeps
        // saying so. Recorded for the dock, never allowed to blank the board.
        try {
            let request: TraceClosureRequest = base
            let res = first
            while (res.seedCursor && pages < MAX_PAGES_PER_OP) {
                request = { ...base, seedCursor: res.seedCursor }
                res = await fetchClosure.call(provider, request, { signal })
                if (!absorb(gen, res, { rootUrn: anchorUrn, direction: 'both' })) return
                pages += 1
            }

            // Then every anchor the responses reported as half-read. Re-read
            // from the MODEL each round: draining one entry can reveal
            // another, and an entry that came back without a cursor has
            // already been dropped from the model by `mergeClosures`.
            const drained = new Set<string>()
            for (;;) {
                const model = modelRef.current
                if (!model || pages >= MAX_PAGES_PER_OP) return
                const next = [
                    ...model.frontierUp.map(f => ({ ...f, dir: 'up' as const })),
                    ...model.frontierDown.map(f => ({ ...f, dir: 'down' as const })),
                ].find(f => f.nextCursor && !drained.has(`${f.dir}:${f.urn}:${f.nextCursor}`))
                if (!next) return
                drained.add(`${next.dir}:${next.urn}:${next.nextCursor}`)
                const paged = await fetchClosure.call(provider, lazyRequest(next.urn, {
                    direction: next.dir === 'up' ? 'upstream' : 'downstream',
                    downstreamDepth: next.dir === 'up' ? 0 : 1,
                    upstreamDepth: next.dir === 'up' ? 1 : 0,
                    afterCursor: next.nextCursor ?? undefined,
                    grain: 'coarse',
                }), { signal })
                pages += 1
                if (!absorb(gen, paged, { rootUrn: next.urn, direction: next.dir })) return
            }
        } catch (err) {
            if (gen !== generation.current) return
            setState(prev => (prev.focusUrn === null ? prev : {
                ...prev,
                error: err instanceof Error ? err.message : String(err),
            }))
        }
    }, [provider, absorb])

    // ---- the coarse phase, one per (focus, provider, retry) -------------
    useEffect(() => {
        if (!focusUrn || !provider?.traceClosure) {
            newSession(null)
            setState(IDLE)
            return
        }
        const gen = newSession(focusUrn)
        setState({
            focusUrn,
            model: modelRef.current,
            phase: 'coarse',
            error: null,
            inFlight: inFlightRef.current,
            drilled: drilledRef.current,
        })

        void (async () => {
            try {
                await runOp(gen, focusUrn, lazyRequest(focusUrn, { grain: 'coarse' }))
                if (gen !== generation.current) return
                setState(prev => (prev.focusUrn === focusUrn ? { ...prev, phase: 'ready' } : prev))
            } catch (err) {
                if (gen !== generation.current) return
                setState(prev => (prev.focusUrn === focusUrn
                    ? { ...prev, phase: 'error', error: err instanceof Error ? err.message : String(err) }
                    : prev))
            }
        })()

        return () => { controller.current?.abort() }
    }, [focusUrn, provider, retryToken, newSession, runOp])

    /**
     * WHAT IS INSIDE AN UPSTREAM CARD IS UPSTREAM.
     *
     * A response says which side of the FOCUS each node it discovered is on,
     * and a drill is anchored on a card, not on the focus — so the children it
     * reveals arrive with no side at all. The view model reads that as "host":
     * a container the flow merely passes through, which survives only by
     * hosting something that survived. Under the eager walk that was harmless
     * (the leaf hops underneath were the participants, and the container
     * hosted them); under a lazy one it means the card the reader just opened
     * shows NOTHING — its own children vanish for want of a side.
     *
     * So a drill's descendants inherit the drilled card's side, which is the
     * same rule the view model already applies to the focus and everything
     * inside it.
     */
    const inheritSide = useCallback((gen: number, cardUrn: string): void => {
        const model = modelRef.current
        if (gen !== generation.current || !model) return
        const side = model.upstreamUrns.has(cardUrn) ? 'up'
            : model.downstreamUrns.has(cardUrn) ? 'down' : null
        if (!side) return

        const childrenOf = new Map<string, string[]>()
        for (const c of model.containmentEdges) {
            childrenOf.set(c.sourceUrn, [...(childrenOf.get(c.sourceUrn) ?? []), c.targetUrn])
        }
        const inside = new Set<string>()
        const stack = [...(childrenOf.get(cardUrn) ?? [])]
        while (stack.length > 0) {
            const u = stack.pop()!
            if (inside.has(u)) continue
            inside.add(u)
            stack.push(...(childrenOf.get(u) ?? []))
        }
        if (inside.size === 0) return

        const next: LensWalkModel = {
            ...model,
            upstreamUrns: side === 'up' ? new Set([...model.upstreamUrns, ...inside]) : model.upstreamUrns,
            downstreamUrns: side === 'down' ? new Set([...model.downstreamUrns, ...inside]) : model.downstreamUrns,
        }
        modelRef.current = next
        setState(prev => (prev.focusUrn === null ? prev : { ...prev, model: next }))
    }, [])

    const drill = useCallback((urn: string) => {
        if (!urn || !provider?.traceClosure || !sessionFocus.current) return
        if (drilledRef.current.has(urn) || inFlightRef.current.has(urn)) return
        // ALREADY IN HAND. A partner's whole ancestor CHAIN ships with the
        // paint that discovered it — it has to, or the client could not place
        // it — so opening a link in that chain reveals a card the model
        // already holds and a drill would spend a round trip to be told what
        // it knows. Measured against the graph's own child count, so this is
        // "I have all of them", never "I have some".
        if (holdsEveryChild(modelRef.current, urn)) {
            drilledRef.current = new Set([...drilledRef.current, urn])
            setState(prev => (prev.focusUrn === null ? prev : { ...prev, drilled: drilledRef.current }))
            return
        }
        const gen = generation.current
        drilledRef.current = new Set([...drilledRef.current, urn])
        inFlightRef.current = new Set([...inFlightRef.current, urn])
        setState(prev => (prev.focusUrn === null ? prev : {
            ...prev,
            error: null,
            drilled: drilledRef.current,
            inFlight: inFlightRef.current,
        }))

        const settle = (err: unknown): void => {
            if (gen !== generation.current) return
            inFlightRef.current = without(inFlightRef.current, urn)
            // The reader ASKED for this one, so a failure says so — and the
            // card leaves `drilled`, so opening it again tries again.
            if (err !== null) drilledRef.current = without(drilledRef.current, urn)
            setState(prev => ({
                ...prev,
                inFlight: inFlightRef.current,
                drilled: drilledRef.current,
                error: err === null
                    ? prev.error
                    : err instanceof Error ? err.message : String(err),
            }))
        }

        void (async () => {
            try {
                // `urn` alone, deliberately: the endpoint refuses `seedCursor`
                // alongside `seedUrns`, and a drill of a wide card pages its
                // contents with exactly that cursor.
                await runOp(gen, urn, lazyRequest(urn, { drill: true }))
                inheritSide(gen, urn)
                settle(null)
            } catch (err) {
                settle(err ?? new Error('drill failed'))
            }
        })()
    }, [provider, runOp, inheritSide])

    const retry = useCallback(() => setRetryToken(t => t + 1), [])
    const abort = useCallback(() => {
        newSession(null)
        setState(IDLE)
    }, [newSession])

    const completePairs = useMemo(
        () => computeCompletePairs(state.model, state.drilled),
        [state.model, state.drilled],
    )

    const status: TraceDriverStatus =
        state.phase === 'error' ? 'error'
            : state.phase === 'coarse' || state.inFlight.size > 0 ? 'loading'
                : state.error ? 'error'
                    : 'done'

    return {
        model: state.model,
        phase: state.phase,
        status,
        error: state.error,
        inFlight: state.inFlight,
        drilled: state.drilled,
        completePairs,
        drill,
        retry,
        abort,
    }
}

/** Does the model already hold every child the GRAPH says `urn` has? */
function holdsEveryChild(model: LensWalkModel | null, urn: string): boolean {
    if (!model) return false
    const node = model.nodes.find(n => n.urn === urn)
    const count = (node?.data as { childCount?: unknown } | undefined)?.childCount
    if (typeof count !== 'number' || count <= 0) return false
    let held = 0
    for (const c of model.containmentEdges) if (c.sourceUrn === urn) held += 1
    return held >= count
}

function without(set: ReadonlySet<string>, urn: string): Set<string> {
    const next = new Set(set)
    next.delete(urn)
    return next
}
