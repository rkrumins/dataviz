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
 * AND THEN THE SECOND RULING (2026-08-21): "When I run the trace, ensure it
 * covers the ENTIRE walk like Lens Full Flow. We must see the entire lineage.
 * We must not apply any constraints." So laziness buys the FIRST PAINT, not
 * the answer: the coarse picture lands instantly and the full fine walk then
 * runs to exhaustion behind it.
 *
 *   idle ──start──▶ coarse ──▶ walking ──▶ complete
 *                     └─fail──▶ error ──retry──▶ coarse
 *
 *  • COARSE is one request (plus its cursor pages): the focus, its
 *    containment chain, the lineage-carrying children inside it, and every
 *    partner one hop away at the grain the lineage lane offers, each with its
 *    own ancestor chain. On the 2.08M estate that is 25 ms warm. The board is
 *    readable here.
 *  • WALKING is the same hands-free engine the Lens's Full Flow runs: every
 *    frontier the server reports is followed — paged where it carries a
 *    cursor, extended where it does not — until none remain. NO node budget,
 *    no ceiling, no "Keep walking": the only stops are exhaustion, the reader
 *    leaving, and a hop that failed.
 *  • DRILL is one request for a card the reader opens, and it JUMPS THE
 *    QUEUE — the background loop will not start a wave while one is in
 *    flight, so an expansion never waits behind the walk. Once the walk has
 *    completed, a card's contents are already in the model and opening it
 *    costs nothing at all.
 *  • CURSORS ARE FOLLOWED, NOT SHOWN, everywhere: `seedCursor` for more
 *    contents, a frontier `nextCursor` for more of one anchor's edges.
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

export type TracePhase = 'idle' | 'coarse' | 'walking' | 'complete' | 'error'
export type TraceDriverStatus = 'loading' | 'done' | 'error'

/** Failsafe against a server that hands back a cursor for ever. NOT a budget:
 *  every page either drains a frontier entry or advances a keyset, so this is
 *  unreachable in a healthy system — it exists so a bug cannot become an
 *  infinite request loop. */
const MAX_PAGES_PER_OP = 200

/** Frontier ops the background walk holds in flight at once — the Lens's
 *  full walk uses the same width, which is part of why the two reach the
 *  same model. */
const WALK_CONCURRENCY = 4
/** Seeds ONE bulk drain may carry. The wire caps `seedUrns` at 500.
 *
 *  A frontier entry that ran out of DEPTH is re-rooted with `seedUrns`, and
 *  the server walks a SET — so a hundred of them is one request, not a
 *  hundred. MEASURED on the 2.08M-node estate before this: 577 requests and
 *  15 s had reached 1,494 nodes with the frontier still GROWING (284 entries),
 *  because each op brought back two or three nodes and filed them as two or
 *  three more entries. One request per boundary is the request storm the
 *  spec's budget exists to forbid. */
const WALK_BULK_SEEDS = 200
/** FAILSAFE, NOT A BUDGET. Every op either clears its frontier entry or
 *  advances its cursor, so a healthy walk terminates on its own; this exists
 *  only so a server bug cannot become an unbounded request loop, and it sits
 *  far past any real flow. */
const WALK_FAILSAFE_REQUESTS = 100_000

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
    /** Requests this session has issued, for the capsule's narration. */
    requests: number
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
    requests: number
    /** A BACKGROUND hop failed. Kept apart from `error` — which is the
     *  reader's own coarse fetch or their own expansion — because a hop the
     *  walk could not take mid-flight must not headline over a board that is
     *  still filling in. It surfaces when the walk stops. */
    walkError: string | null
}

const EMPTY_SET: ReadonlySet<string> = new Set<string>()

const IDLE: DriverState = {
    focusUrn: null, model: null, phase: 'idle', error: null,
    inFlight: EMPTY_SET, drilled: EMPTY_SET, requests: 0, walkError: null,
}

/** One frontier op. A CURSOR op pages one anchor's adjacency onward; a BULK
 *  op re-roots the walk on every depth-exhausted boundary it can carry at
 *  once. `urns` is the whole seed set; `urn` is its first member, which is
 *  what the request is nominally anchored on. */
interface WalkOp { urn: string; urns: string[]; dir: 'up' | 'down'; cursor: string | null }

/** URNs the client already holds. Budget steering for `excludeUrns`, never
 *  correctness — the merge dedupes regardless. Mirrors the Lens's own helper
 *  so the two engines send the same requests. */
function knownUrns(model: LensWalkModel): string[] {
    return model.nodes.map(n => n.urn)
}

/** The fine-grain request behind one frontier op. NO `grain` — this is the
 *  eager closure walk, the same one the Lens drives. */
function walkRequest(op: WalkOp, model: LensWalkModel): TraceClosureRequest {
    const depth = op.dir === 'up'
        ? { upstreamDepth: 1, downstreamDepth: 0 }
        : { upstreamDepth: 0, downstreamDepth: 1 }
    return op.cursor !== null
        ? { urn: op.urn, direction: op.dir === 'up' ? 'upstream' : 'downstream', ...depth, afterCursor: op.cursor }
        : {
            urn: op.urn, direction: op.dir === 'up' ? 'upstream' : 'downstream', ...depth,
            // Cursor-less entries ran out of DEPTH, not of graph: re-root the
            // walk on them, seeded with the nodes themselves — the server
            // resolves each seed down to whatever grain carries lineage
            // beneath it, and it walks the whole SET in one hop.
            seedUrns: op.urns,
            // Budget steering, not correctness — but it is also what stops the
            // server naming rings the client has already drained.
            excludeUrns: knownUrns(model).slice(0, 2000),
        }
}

/** Identity of one op. The cursor is part of it: paging an anchor onward is a
 *  different question from paging it the first time. */
function opKey(op: WalkOp): string {
    return `${op.dir}:${op.urn}:${op.cursor ?? 'root'}`
}

/** The frontier entries worth firing at: never one that failed, and never one
 *  that has already been asked against a model this size or bigger. */
function collectWalkOps(
    model: LensWalkModel,
    failed: ReadonlySet<string>,
    settled: ReadonlySet<string>,
    firedAt: ReadonlyMap<string, number>,
    limit: number,
): WalkOp[] {
    const ops: WalkOp[] = []
    const cursors: WalkOp[] = []
    const take = (list: LensWalkModel['frontierUp'], dir: 'up' | 'down') => {
        const bulk: string[] = []
        for (const fr of list) {
            if (failed.has(`${dir}:${fr.urn}`) || settled.has(`${dir}:${fr.urn}`)) continue
            if (fr.nextCursor) {
                // A half-read anchor is its own question: its cursor names
                // where to resume, and no other node shares it. Held back —
                // see below.
                const op: WalkOp = { urn: fr.urn, urns: [fr.urn], dir, cursor: fr.nextCursor }
                if ((firedAt.get(opKey(op)) ?? -1) >= model.nodes.length) continue
                cursors.push(op)
                continue
            }
            const key = `${dir}:${fr.urn}:root`
            if ((firedAt.get(key) ?? -1) >= model.nodes.length) continue
            if (bulk.length < WALK_BULK_SEEDS) bulk.push(fr.urn)
        }
        // ONE request for the whole ring. The server walks a set, so asking it
        // a hundred times about a hundred boundaries is a hundred round trips
        // spent on one hop.
        if (bulk.length > 0) ops.push({ urn: bulk[0], urns: bulk, dir, cursor: null })
    }
    take(model.frontierUp, 'up')
    take(model.frontierDown, 'down')

    // BULK FIRST, CURSORS AFTER, and that ordering is the whole difference
    // between a walk and a crawl. A hop that trips the server's node budget
    // files its ENTIRE ring as resumable (the server cannot tell which anchor
    // lost rows), so one truncated response can leave a thousand `e:0`
    // cursors behind — each worth one node or two. Letting those go first
    // starves the bulk drains that are actually covering the flow: MEASURED
    // on the 2.08M-node estate, 24 requests bought 35 nodes that way.
    return [...ops, ...cursors].slice(0, Math.max(limit, ops.length))
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
    /** Frontier ops that FAILED. Never auto-retried — the walk stops honestly
     *  instead of looping on a broken hop; `retry()` clears them. */
    const failedOps = useRef<Set<string>>(new Set())
    /** Boundaries this walk is FINISHED with: the response that answered them
     *  was not truncated, so there is nothing left behind them and a later
     *  response naming them again is telling us what we know.
     *
     *  This is what makes a big walk converge. `excludeUrns` is capped at
     *  2,000 by the wire, so once the model is bigger than that the server
     *  cannot know what the client holds and re-files nodes it has already
     *  shipped. MEASURED on the 2.08M-node estate, a 709-child container:
     *  without this the frontier GREW from 2,444 to 3,883 entries over 800
     *  requests while the model crawled 1.5 nodes per request. With it the
     *  same walk finishes. */
    const settledOps = useRef<Set<string>>(new Set())
    /** Op key → how big the model was when it was last fired.
     *
     *  A frontier entry the walk has drained can be RE-REPORTED by a later
     *  response about a different anchor: the server names the ring it
     *  discovered and cannot know which of those the client already asked
     *  about. Refusing to re-fire outright loses nodes — an op the server cut
     *  short at its page boundary MUST be asked again, and its answer will
     *  differ because `excludeUrns` has grown. So the rule is PROGRESS: an op
     *  may be re-fired only if the model has grown since it last ran. That
     *  terminates (the model grows finitely) and cannot starve.
     *
     *  Without any guard at all this loops: MEASURED at 100,000 requests for
     *  302 nodes before the failsafe caught it. */
    const firedAt = useRef<Map<string, number>>(new Map())
    const requestsRef = useRef(0)
    /** The phase, readable from callbacks that must not depend on state. */
    const phaseRef = useRef<TracePhase>('idle')
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
        failedOps.current = new Set()
        firedAt.current = new Map()
        settledOps.current = new Set()
        requestsRef.current = 0
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
        setState(prev => (prev.focusUrn === null
            ? prev
            : { ...prev, model: next, requests: requestsRef.current }))
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
        requestsRef.current += 1
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
                requestsRef.current += 1
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
                requestsRef.current += 1
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

    /** Take the drained boundaries off the frontier. `mergeClosures` clears
     *  the one anchor its ctx names; a BULK drain answered for all of its
     *  seeds at once, and an entry left standing for a boundary already walked
     *  is a request the loop would spend again every round. */
    const dropDrained = useCallback((gen: number, urns: string[], dir: 'up' | 'down'): void => {
        const model = modelRef.current
        if (gen !== generation.current || !model) return
        const drop = new Set(urns)
        // A CURSORED entry survives: it says the anchor is half-read, which a
        // re-rooting drain did not answer.
        const keep = (f: { urn: string; nextCursor: string | null }) => !drop.has(f.urn) || !!f.nextCursor
        const next: LensWalkModel = {
            ...model,
            frontierUp: dir === 'up' ? model.frontierUp.filter(keep) : model.frontierUp,
            frontierDown: dir === 'down' ? model.frontierDown.filter(keep) : model.frontierDown,
        }
        modelRef.current = next
        setState(prev => (prev.focusUrn === null ? prev : { ...prev, model: next }))
    }, [])

    /**
     * THE BACKGROUND WALK — the whole lineage, hands-free.
     *
     * The same engine `useLensWalk`'s Full Flow runs, driven off the SAME
     * model the coarse paint filled: every frontier entry the server reports
     * is followed — paged where it carries a cursor, re-rooted where it does
     * not — in waves of `WALK_CONCURRENCY`, until no candidate remains.
     *
     * NO BUDGET (user ruling): no node ceiling, no grants, no "Keep walking".
     * It stops on exhaustion, on the reader leaving, or on a hop that failed —
     * and a failed hop is remembered rather than retried, so the walk cannot
     * loop on a broken step.
     *
     * DRILLS JUMP THE QUEUE. The loop will not open a new wave while the
     * reader's own expansion is in flight, so an expand never queues behind
     * the walk; it yields a macrotask and looks again.
     */
    const runBackgroundWalk = useCallback(async (gen: number, focus: string): Promise<void> => {
        const fetchClosure = provider?.traceClosure
        if (!fetchClosure || !provider) return
        const signal = controller.current?.signal

        // THE FOCUS'S OWN FINE HOP FIRST, and it is not optional. The coarse
        // paint answered the focus at CARD grain — the rollup partners the
        // view can place — and filed only those partners as boundaries. The
        // raw hops into the focus's own contents were never asked for, so a
        // walk that only followed the frontier would finish having never seen
        // them: on the CFO estate the three column-to-column flows that ARE
        // the lineage. This is also the Lens's very first request, which is
        // what makes the two engines converge rather than merely agree.
        const seedOp: WalkOp = { urn: focus, urns: [focus], dir: 'up', cursor: null }
        if (!firedAt.current.has(opKey(seedOp))) {
            firedAt.current.set(opKey(seedOp), modelRef.current?.nodes.length ?? 0)
            requestsRef.current += 1
            try {
                const res = await fetchClosure.call(provider, {
                    urn: focus, direction: 'both', upstreamDepth: 1, downstreamDepth: 1,
                    // Seeded with the focus itself, so the server resolves it
                    // down to whatever carries lineage beneath it — the same
                    // resolution a container focus gets on the eager path, and
                    // the same shape every other op of this walk has.
                    seedUrns: [focus],
                }, { signal })
                if (!absorb(gen, res, { rootUrn: focus, direction: 'both' })) return
            } catch (err) {
                if (gen !== generation.current) return
                failedOps.current.add(`up:${focus}`)
                setState(prev => (prev.focusUrn === null ? prev : {
                    ...prev,
                    walkError: err instanceof Error ? err.message : String(err),
                }))
            }
        }

        for (;;) {
            if (gen !== generation.current) return
            if (inFlightRef.current.size > 0) {
                await new Promise(resolve => setTimeout(resolve, 0))
                continue
            }
            const model = modelRef.current
            if (!model) return
            if (requestsRef.current >= WALK_FAILSAFE_REQUESTS) return
            const ops = collectWalkOps(
                model, failedOps.current, settledOps.current, firedAt.current, WALK_CONCURRENCY,
            )
            if (ops.length === 0) return
            for (const op of ops) {
                for (const u of op.urns) {
                    firedAt.current.set(`${op.dir}:${u}:${op.cursor ?? 'root'}`, model.nodes.length)
                }
            }

            requestsRef.current += ops.length
            await Promise.all(ops.map(async op => {
                try {
                    const res = await fetchClosure.call(provider, walkRequest(op, model), { signal })
                    if (!absorb(gen, res, { rootUrn: op.urn, direction: op.dir })) return
                    // A response that was NOT cut short answered its seeds in
                    // full: those boundaries are finished with, whatever a
                    // later response says about them. A truncated one is left
                    // to the progress rule, because it genuinely has more.
                    if (!res.truncated) {
                        for (const u of op.urns) settledOps.current.add(`${op.dir}:${u}`)
                    }
                    // `mergeClosures` clears the ONE anchor it was told about;
                    // a bulk drain answered for all of its seeds, and an entry
                    // left standing for a boundary already walked is a request
                    // the loop would spend again on every round.
                    if (op.urns.length > 1) dropDrained(gen, op.urns, op.dir)
                } catch (err) {
                    if (gen !== generation.current) return
                    for (const u of op.urns) failedOps.current.add(`${op.dir}:${u}`)
                    setState(prev => (prev.focusUrn === null ? prev : {
                        ...prev,
                        walkError: err instanceof Error ? err.message : String(err),
                    }))
                }
            }))
        }
    }, [provider, absorb, dropDrained])

    // ---- the session: coarse, then the walk behind it -------------------
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
            requests: 0,
            walkError: null,
        })

        void (async () => {
            try {
                await runOp(gen, focusUrn, lazyRequest(focusUrn, { grain: 'coarse' }))
            } catch (err) {
                if (gen !== generation.current) return
                setState(prev => (prev.focusUrn === focusUrn
                    ? { ...prev, phase: 'error', error: err instanceof Error ? err.message : String(err) }
                    : prev))
                return
            }
            if (gen !== generation.current) return
            // The board is readable NOW; the rest of the flow arrives behind
            // it. `walking` is what the dock's counts read as floors.
            setState(prev => (prev.focusUrn === focusUrn
                ? { ...prev, phase: 'walking', requests: requestsRef.current } : prev))
            await runBackgroundWalk(gen, focusUrn)
            if (gen !== generation.current) return
            setState(prev => (prev.focusUrn === focusUrn
                ? { ...prev, phase: 'complete', requests: requestsRef.current } : prev))
        })()

        return () => { controller.current?.abort() }
    }, [focusUrn, provider, retryToken, newSession, runOp, runBackgroundWalk])

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
        // THE WALK GOT THERE FIRST. Once the background walk has run to
        // exhaustion the model holds every lineage-carrying descendant it
        // could reach, so opening a card is a re-projection and asking again
        // could only be told what we know.
        if (phaseRef.current === 'complete') {
            drilledRef.current = new Set([...drilledRef.current, urn])
            setState(prev => (prev.focusUrn === null ? prev : { ...prev, drilled: drilledRef.current }))
            return
        }
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

    /** Re-kick what failed. A coarse fetch that never landed restarts the
     *  session; a walk that stopped on broken hops clears them and resumes,
     *  because throwing away a picture the reader is already reading to
     *  re-fetch it from scratch is the opposite of what they asked for. */
    const retry = useCallback(() => {
        if (modelRef.current && modelRef.current.nodes.length > 0 && failedOps.current.size > 0) {
            const gen = generation.current
            failedOps.current = new Set()
            // The PROGRESS ledger goes with them: a retried op has to be
            // allowed to run again even though the model has not grown since
            // it failed — which is precisely the state a failure leaves.
            firedAt.current = new Map()
            setState(prev => (prev.focusUrn === null ? prev
                : { ...prev, error: null, walkError: null, phase: 'walking' }))
            const focus = sessionFocus.current
            if (!focus) return
            void (async () => {
                await runBackgroundWalk(gen, focus)
                if (gen !== generation.current) return
                setState(prev => (prev.focusUrn === null
                    ? prev : { ...prev, phase: 'complete', requests: requestsRef.current }))
            })()
            return
        }
        setRetryToken(t => t + 1)
    }, [runBackgroundWalk])
    const abort = useCallback(() => {
        newSession(null)
        setState(IDLE)
    }, [newSession])

    // Synced after commit: `drill` keeps ONE identity, so it cannot read the
    // phase out of state without being re-minted on every transition.
    useEffect(() => { phaseRef.current = state.phase }, [state.phase])

    // ONCE THE WALK IS COMPLETE, EVERY CONE IS SETTLED. The background walk
    // reaches every lineage-carrying descendant of everything on the board, so
    // there is nothing left for a rollup to be hiding — and a residual drawn
    // over raw evidence that IS all here would be the coarse statement
    // outliving its usefulness.
    const completePairs = useMemo(() => computeCompletePairs(
        state.model,
        state.phase === 'complete' && state.model
            ? new Set(state.model.nodes.map(n => n.urn))
            : state.drilled,
    ), [state.model, state.drilled, state.phase])

    // The board is READABLE from the moment the coarse picture lands, so the
    // background walk is not a loading state — `fullWalkStatus.walking` is
    // what narrates it. An error only becomes the headline once nothing is
    // left in flight to fix it.
    const status: TraceDriverStatus =
        state.phase === 'error' ? 'error'
            : state.phase === 'coarse' ? 'loading'
                : state.inFlight.size > 0 ? 'loading'
                    // The reader's OWN request failed — they clicked, so they
                    // are told, whatever the walk behind it is doing.
                    : state.error ? 'error'
                        // A background hop failed and the walk has stopped:
                        // now it is the whole story, so now it is said.
                        : state.phase === 'complete' && state.walkError ? 'error'
                            : 'done'

    return {
        model: state.model,
        phase: state.phase,
        status,
        error: state.error ?? (state.phase === 'complete' ? state.walkError : null),
        inFlight: state.inFlight,
        drilled: state.drilled,
        completePairs,
        requests: state.requests,
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
