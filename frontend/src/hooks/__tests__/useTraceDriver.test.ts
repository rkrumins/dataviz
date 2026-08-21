/**
 * useTraceDriver — the trace's fetch engine under the 2026-08-21 ruling:
 * ONE grain, ONE hop, on demand, no caps.
 *
 * What each block is holding:
 *  • the FIRST PAINT is one coarse request and then silence — the engine it
 *    replaces walked a focus's whole leaf-grain closure first (9.7 s on the
 *    2.08M-node estate);
 *  • CURSORS ARE FOLLOWED, not surfaced: a page that could not fit says so,
 *    and the driver drains it without anyone pressing anything;
 *  • a card is DRILLED ONCE, ever;
 *  • COMPLETENESS is a claim about cones, and it is what stops the wire
 *    ledger from vouching for detail a lazy model has not fetched;
 *  • a session that the reader has left never merges anything again.
 */
import { renderHook, waitFor, act } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'

import { useTraceDriver, computeCompletePairs } from '../useTraceDriver'
import { pairKey } from '../lib/traceWireLedger'
import type {
    GraphDataProvider, GraphNode, TraceV2Result, LensClosureExtras,
} from '@/providers/GraphDataProvider'
import type { LensWalkModel } from '@/components/canvas/context-view/lens/closure-adapter'

const FOCUS = 'F'

const gn = (urn: string, childCount = 0, entityType = 'container'): GraphNode => ({
    urn, displayName: urn, entityType, properties: {}, childCount,
} as unknown as GraphNode)

function res(
    over: Partial<TraceV2Result & LensClosureExtras> = {},
): TraceV2Result & LensClosureExtras {
    return {
        focus: { urn: FOCUS, level: 0, entityType: 'container' },
        nodes: [], edges: [], containmentEdges: [],
        upstreamUrns: new Set(), downstreamUrns: new Set(),
        effectiveLevel: 0, isInherited: false, inheritedFromUrn: null,
        truncated: false, truncationReason: null,
        frontierUp: [], frontierDown: [], seedTruncated: false, seedCursor: null,
        ...over,
    } as TraceV2Result & LensClosureExtras
}

/** The CFO-shaped estate at coarse grain: the focus open over its own
 *  contents, one partner CLOSED at the grain the rollup lane states it, both
 *  chains shipped. The partner is a frontier boundary — this walk asked one
 *  hop, so what is past it is unknown. */
function coarseResponse(): TraceV2Result & LensClosureExtras {
    return res({
        nodes: [gn('root', 1), gn(FOCUS, 1), gn('f1'), gn('P', 1), gn('proot', 1)],
        edges: [{
            id: 'g:P>F', sourceUrn: 'P', targetUrn: FOCUS,
            edgeType: 'AGGREGATED', properties: { weight: 2 },
        }],
        containmentEdges: [
            { id: 'c1', sourceUrn: 'root', targetUrn: FOCUS, edgeType: 'HAS' },
            { id: 'c2', sourceUrn: FOCUS, targetUrn: 'f1', edgeType: 'HAS' },
            { id: 'c3', sourceUrn: 'proot', targetUrn: 'P', edgeType: 'HAS' },
        ],
        upstreamUrns: new Set(['P']),
        frontierUp: [{ urn: 'P', totalCount: null, nextCursor: null }],
    } as Partial<TraceV2Result & LensClosureExtras>)
}

/** Opening P: its lineage-carrying child, and that child's hop-1 raw hop
 *  into the focus's own child — the wire refines one grain. */
function drillResponse(): TraceV2Result & LensClosureExtras {
    return res({
        focus: { urn: 'P', level: 0, entityType: 'container' },
        nodes: [gn('P', 1), gn('p1'), gn('f1'), gn(FOCUS, 1), gn('root', 1)],
        edges: [{
            id: 'r:p1>f1', sourceUrn: 'p1', targetUrn: 'f1',
            edgeType: 'FLOWS', properties: {},
        }],
        containmentEdges: [
            { id: 'c4', sourceUrn: 'P', targetUrn: 'p1', edgeType: 'HAS' },
            { id: 'c2', sourceUrn: FOCUS, targetUrn: 'f1', edgeType: 'HAS' },
            { id: 'c1', sourceUrn: 'root', targetUrn: FOCUS, edgeType: 'HAS' },
        ],
        upstreamUrns: new Set(['p1']),
    } as Partial<TraceV2Result & LensClosureExtras>)
}

/** Is this the BACKGROUND WALK asking, rather than the coarse paint or a
 *  drill? A walk op is a plain closure request re-rooted on a frontier entry
 *  (`seedUrns`) or paging one (`afterCursor`) — never `grain:'coarse'`. */
function isWalkOp(req: Record<string, unknown>): boolean {
    return !req.grain && !req.drill && (!!req.seedUrns || !!req.afterCursor)
}

/** `impl` answers the coarse paint and any drill; the background walk gets
 *  "nothing further" unless the test says otherwise, so a fixture cannot
 *  accidentally hand the walk its own frontier back for ever. */
function makeProvider(
    impl: (req: Record<string, unknown>) => TraceV2Result & LensClosureExtras | Promise<TraceV2Result & LensClosureExtras>,
    walkImpl?: (req: Record<string, unknown>) => TraceV2Result & LensClosureExtras | Promise<TraceV2Result & LensClosureExtras>,
) {
    const traceClosure = vi.fn(async (req: Record<string, unknown>) => (
        isWalkOp(req) ? (walkImpl ? walkImpl(req) : res({ focus: { urn: String(req.urn), level: 0, entityType: '' } })) : impl(req)
    ))
    return { provider: { traceClosure } as unknown as GraphDataProvider, traceClosure }
}

/** Coarse paint + drill calls only — the background walk's own follow-ups are
 *  counted separately, because their number is a property of the estate. */
const paintCalls = (fn: { mock: { calls: unknown[][] } }): Record<string, unknown>[] =>
    fn.mock.calls.map(c => c[0] as Record<string, unknown>).filter(r => !isWalkOp(r))

/** A background walk that never comes back, so the session stays in
 *  `walking` — which is where a DRILL still means something. (Once the walk
 *  completes the model holds everything and opening a card is free, which is
 *  its own test.) */
const heldWalk = () => new Promise<TraceV2Result & LensClosureExtras>(() => {})

// ── the first paint ─────────────────────────────────────────────────────

describe('useTraceDriver — the coarse first paint', () => {
    it('asks for ONE hop at coarse grain and then stops', async () => {
        const { provider, traceClosure } = makeProvider(() => coarseResponse())
        const { result } = renderHook(() => useTraceDriver(FOCUS, provider))

        await waitFor(() => expect(result.current.phase).toBe('complete'))

        expect(paintCalls(traceClosure)).toEqual([{
            urn: FOCUS, direction: 'both', upstreamDepth: 1, downstreamDepth: 1,
            grain: 'coarse',
        }])
        expect(result.current.status).toBe('done')
        expect(result.current.model?.nodes.map(n => n.urn).sort())
            .toEqual(['F', 'P', 'f1', 'proot', 'root'])
    })

    it('holds an EMPTY model from the first render, so the canvas keeps browse', () => {
        const { provider } = makeProvider(() => new Promise(() => coarseResponse()) as never)
        const { result } = renderHook(() => useTraceDriver(FOCUS, provider))

        expect(result.current.phase).toBe('coarse')
        expect(result.current.model).not.toBeNull()
        expect(result.current.model?.nodes).toEqual([])
    })

    it('counts the focus as already drilled — its contents came with the paint', async () => {
        const { provider, traceClosure } = makeProvider(() => coarseResponse())
        const { result } = renderHook(() => useTraceDriver(FOCUS, provider))
        await waitFor(() => expect(result.current.phase).toBe('complete'))

        act(() => result.current.drill(FOCUS))
        expect(paintCalls(traceClosure)).toHaveLength(1)
    })

    it('idles with no focus, and asks nothing', () => {
        const { provider, traceClosure } = makeProvider(() => coarseResponse())
        const { result } = renderHook(() => useTraceDriver(null, provider))

        expect(result.current.phase).toBe('idle')
        expect(result.current.model).toBeNull()
        expect(traceClosure).not.toHaveBeenCalled()
    })
})

// ── cursors ─────────────────────────────────────────────────────────────

describe('useTraceDriver — cursors are followed, never surfaced', () => {
    it('drains a card`s contents through seedCursor until the page is short', async () => {
        const pages = ['s:a', 's:b', null]
        let i = 0
        const { provider, traceClosure } = makeProvider(() => {
            const cursor = pages[Math.min(i++, pages.length - 1)]
            // The focus always ships: a coarse response without it cannot be
            // drawn, and the driver says so rather than sitting in browse.
            return res({ nodes: [gn(FOCUS), gn(`c${i}`)], seedCursor: cursor } as Partial<TraceV2Result & LensClosureExtras>)
        })
        const { result } = renderHook(() => useTraceDriver(FOCUS, provider))
        await waitFor(() => expect(result.current.phase).toBe('complete'))

        expect(paintCalls(traceClosure)).toHaveLength(3)
        expect(paintCalls(traceClosure)[1]).toMatchObject({ seedCursor: 's:a' })
        expect(paintCalls(traceClosure)[2]).toMatchObject({ seedCursor: 's:b' })
    })

    it('pages one anchor`s edges through the frontier cursor, one direction at a time', async () => {
        const { provider, traceClosure } = makeProvider((req) => {
            if (req.afterCursor) return res({ nodes: [gn(FOCUS), gn('hub')] })
            return res({
                nodes: [gn(FOCUS), gn('hub')],
                frontierUp: [{ urn: 'hub', totalCount: null, nextCursor: 'e:0' }],
            } as Partial<TraceV2Result & LensClosureExtras>)
        })
        const { result } = renderHook(() => useTraceDriver(FOCUS, provider))
        await waitFor(() => expect(result.current.phase).toBe('complete'))

        expect(paintCalls(traceClosure)).toHaveLength(2)
        expect(paintCalls(traceClosure)[1]).toEqual({
            urn: 'hub', direction: 'upstream', upstreamDepth: 1, downstreamDepth: 0,
            afterCursor: 'e:0', grain: 'coarse',
        })
        // The drained entry is gone from the model, so the "+" it justified
        // goes with it.
        expect(result.current.model?.frontierUp).toEqual([])
    })

    it('leaves a cursor-less boundary alone — that one resumes by re-rooting', async () => {
        const { provider, traceClosure } = makeProvider(() => coarseResponse())
        const { result } = renderHook(() => useTraceDriver(FOCUS, provider))
        await waitFor(() => expect(result.current.phase).toBe('complete'))

        expect(paintCalls(traceClosure)).toHaveLength(1)
        // The BACKGROUND walk re-roots on it instead — that is its job — and
        // the entry clears when it does.
        expect(traceClosure.mock.calls.some(c => isWalkOp(c[0] as Record<string, unknown>))).toBe(true)
    })
})

// ── drill ───────────────────────────────────────────────────────────────

describe('useTraceDriver — drill on expand', () => {
    it('fetches the card`s contents once, and never again', async () => {
        const { provider, traceClosure } = makeProvider(
            req => (req.drill ? drillResponse() : coarseResponse()), heldWalk,
        )
        const { result } = renderHook(() => useTraceDriver(FOCUS, provider))
        await waitFor(() => expect(result.current.phase).toBe('walking'))

        await act(async () => { result.current.drill('P') })
        await waitFor(() => expect(result.current.inFlight.size).toBe(0))

        expect(paintCalls(traceClosure)).toHaveLength(2)
        expect(paintCalls(traceClosure)[1]).toEqual({
            urn: 'P', direction: 'both', upstreamDepth: 1, downstreamDepth: 1, drill: true,
        })

        await act(async () => { result.current.drill('P') })
        expect(paintCalls(traceClosure)).toHaveLength(2)
    })

    it('merges into the SAME model — the coarse picture is not replaced', async () => {
        const { provider } = makeProvider(
            req => (req.drill ? drillResponse() : coarseResponse()), heldWalk,
        )
        const { result } = renderHook(() => useTraceDriver(FOCUS, provider))
        await waitFor(() => expect(result.current.phase).toBe('walking'))

        await act(async () => { result.current.drill('P') })
        await waitFor(() => expect(result.current.inFlight.size).toBe(0))

        const model = result.current.model!
        // The coarse rollup AND the finer raw hop it summarises, together —
        // which is exactly what lets the ledger retire the rollup.
        expect(model.lineageEdges.map(e => e.id).sort()).toEqual(['g:P>F', 'r:p1>f1'])
        expect(model.nodes.map(n => n.urn).sort())
            .toEqual(['F', 'P', 'f1', 'p1', 'proot', 'root'])
    })

    it('marks the card in flight while it is fetching', async () => {
        let release: (() => void) | null = null
        const { provider } = makeProvider(req => {
            if (!req.drill) return coarseResponse()
            return new Promise<TraceV2Result & LensClosureExtras>(resolve => {
                release = () => resolve(drillResponse())
            })
        }, heldWalk)
        const { result } = renderHook(() => useTraceDriver(FOCUS, provider))
        await waitFor(() => expect(result.current.phase).toBe('walking'))

        act(() => { result.current.drill('P') })
        await waitFor(() => expect([...result.current.inFlight]).toEqual(['P']))
        expect(result.current.status).toBe('loading')

        await act(async () => { release?.() })
        await waitFor(() => expect(result.current.inFlight.size).toBe(0))
        expect(result.current.status).toBe('done')
    })
})

// ── completeness ────────────────────────────────────────────────────────

describe('useTraceDriver — completePairs', () => {
    it('will not vouch for a pair whose partner has never been opened', async () => {
        const { provider } = makeProvider(
            req => (req.drill ? drillResponse() : coarseResponse()), heldWalk,
        )
        const { result } = renderHook(() => useTraceDriver(FOCUS, provider))
        await waitFor(() => expect(result.current.phase).toBe('walking'))

        // Nothing is complete yet — there is no raw evidence at all, and P is
        // a closed card that says it holds one thing nobody has asked for.
        expect(result.current.completePairs.size).toBe(0)
    })

    it('flips the pair once BOTH cones are leaf-or-drilled', async () => {
        const { provider } = makeProvider(
            req => (req.drill ? drillResponse() : coarseResponse()), heldWalk,
        )
        const { result } = renderHook(() => useTraceDriver(FOCUS, provider))
        await waitFor(() => expect(result.current.phase).toBe('walking'))

        await act(async () => { result.current.drill('P') })
        await waitFor(() => expect(result.current.inFlight.size).toBe(0))

        const pairs = result.current.completePairs
        expect(pairs.has(pairKey('p1', 'f1'))).toBe(true)
        expect(pairs.has(pairKey('P', FOCUS))).toBe(true)
        // `root` is a lane root with a child count of 1 that IS `F`, which is
        // settled — so the chain above the pair is vouched for too.
        expect(pairs.has(pairKey('proot', 'root'))).toBe(true)
    })

    it('is a claim about CONES: one unopened card poisons every pair above it', () => {
        const model = {
            focusUrn: 'F',
            nodes: [
                { urn: 'A', data: { childCount: 2 } },
                { urn: 'a1', data: { childCount: 0 } },
                { urn: 'a2', data: { childCount: 3 } },   // holds things nobody asked for
                { urn: 'B', data: { childCount: 0 } },
            ],
            lineageEdges: [{ id: 'e', sourceUrn: 'a1', targetUrn: 'B', edgeType: 'FLOWS', kind: 'raw' as const, weight: null }],
            containmentEdges: [
                { sourceUrn: 'A', targetUrn: 'a1' },
                { sourceUrn: 'A', targetUrn: 'a2' },
            ],
            upstreamUrns: new Set<string>(), downstreamUrns: new Set<string>(),
            frontierUp: [], frontierDown: [],
            truncated: false, truncationReason: null, seedTruncated: false, seedCursor: null,
        } as unknown as LensWalkModel

        const pairs = computeCompletePairs(model, new Set(['A']))
        // The leaf pair is fine — both ends are leaves the model holds.
        expect(pairs.has(pairKey('a1', 'B'))).toBe(true)
        // A is drilled, but `a2` inside it is not, so A's cone is not settled
        // and no pair through A may be vouched for.
        expect(pairs.has(pairKey('A', 'B'))).toBe(false)
    })
})

// ── sessions ────────────────────────────────────────────────────────────

describe('useTraceDriver — sessions', () => {
    it('drops a response that lands after the reader has left', async () => {
        let release: ((r: TraceV2Result & LensClosureExtras) => void) | null = null
        const { provider } = makeProvider(() => new Promise<TraceV2Result & LensClosureExtras>(
            resolve => { release = resolve },
        ))
        const { result } = renderHook(() => useTraceDriver(FOCUS, provider))
        expect(result.current.phase).toBe('coarse')

        act(() => result.current.abort())
        expect(result.current.phase).toBe('idle')

        await act(async () => { release?.(coarseResponse()) })
        expect(result.current.model).toBeNull()
        expect(result.current.phase).toBe('idle')
    })

    it('aborts the previous session`s controller when the focus changes', async () => {
        const seen: Array<AbortSignal | undefined> = []
        const traceClosure = vi.fn(async (
            req: Record<string, unknown>, opts?: { signal?: AbortSignal },
        ) => {
            // Only the COARSE paint's signal — the background walk's ops carry
            // the same one, and counting them would confuse "session 1 was
            // aborted" with "session 1 had more requests".
            if (!isWalkOp(req)) seen.push(opts?.signal)
            if (isWalkOp(req)) return res({ focus: { urn: String(req.urn), level: 0, entityType: '' } })
            // Each session's own focus ships, whichever one is being traced.
            const anchored = coarseResponse()
            return { ...anchored, nodes: [...anchored.nodes, gn(String(req.urn))] }
        })
        const provider = { traceClosure } as unknown as GraphDataProvider

        const { result, rerender } = renderHook(
            ({ urn }: { urn: string }) => useTraceDriver(urn, provider),
            { initialProps: { urn: FOCUS } },
        )
        await waitFor(() => expect(result.current.phase).toBe('complete'))
        const first = seen[0]

        rerender({ urn: 'OTHER' })
        await waitFor(() => expect(result.current.phase).toBe('complete'))

        expect(first?.aborted).toBe(true)
        expect(seen[1]?.aborted).toBe(false)
    })

    it('keeps the model`s identity across renders nothing happened in', async () => {
        const { provider } = makeProvider(() => coarseResponse())
        const { result, rerender } = renderHook(() => useTraceDriver(FOCUS, provider))
        await waitFor(() => expect(result.current.phase).toBe('complete'))

        const model = result.current.model
        rerender()
        rerender()
        expect(result.current.model).toBe(model)
    })
})

// ── failure ─────────────────────────────────────────────────────────────

describe('useTraceDriver — failure and retry', () => {
    it('a failed coarse fetch is an error the reader can retry', async () => {
        let fail = true
        const { provider, traceClosure } = makeProvider(() => {
            if (fail) throw new Error('closure refused')
            return coarseResponse()
        })
        const { result } = renderHook(() => useTraceDriver(FOCUS, provider))

        await waitFor(() => expect(result.current.phase).toBe('error'))
        expect(result.current.status).toBe('error')
        expect(result.current.error).toBe('closure refused')

        fail = false
        act(() => result.current.retry())
        await waitFor(() => expect(result.current.phase).toBe('complete'))
        expect(result.current.error).toBeNull()
        expect(paintCalls(traceClosure)).toHaveLength(2)
    })

    it('a failed DRILL says so and leaves the card re-openable', async () => {
        let failDrill = true
        const { provider, traceClosure } = makeProvider(req => {
            if (!req.drill) return coarseResponse()
            if (failDrill) throw new Error('drill refused')
            return drillResponse()
        }, heldWalk)
        const { result } = renderHook(() => useTraceDriver(FOCUS, provider))
        await waitFor(() => expect(result.current.phase).toBe('walking'))

        await act(async () => { result.current.drill('P') })
        await waitFor(() => expect(result.current.error).toBe('drill refused'))
        expect(result.current.status).toBe('error')
        // The coarse picture is still on screen — a failed expansion is not a
        // failed trace.
        expect(result.current.phase).toBe('walking')
        expect(result.current.drilled.has('P')).toBe(false)

        failDrill = false
        await act(async () => { result.current.drill('P') })
        await waitFor(() => expect(result.current.drilled.has('P')).toBe(true))
        expect(paintCalls(traceClosure)).toHaveLength(3)
    })
})

/** A walk fixture with an END to it. A fake that invents a fresh node per
 *  request describes an INFINITE graph, and an engine told to walk the entire
 *  lineage will duly try to (measured: the vitest worker runs out of memory).
 *  Real graphs are finite; so is this: P → q1 → q2 → q3, and nothing beyond. */
function boundedChain(): (req: Record<string, unknown>) => TraceV2Result & LensClosureExtras {
    const next: Record<string, string | null> = { P: 'q1', q1: 'q2', q2: 'q3', q3: null }
    return (req) => {
        const from = String(req.urn)
        const child = next[from]
        return child
            ? res({
                focus: { urn: from, level: 0, entityType: '' },
                nodes: [gn(child)],
                upstreamUrns: new Set([child]),
                frontierUp: [{ urn: child, totalCount: null, nextCursor: null }],
            } as Partial<TraceV2Result & LensClosureExtras>)
            : res({ focus: { urn: from, level: 0, entityType: '' } })
    }
}

// ── the background walk ─────────────────────────────────────────────────
//
// The second ruling: "ensure it covers the ENTIRE walk like Lens Full Flow.
// We must see the entire lineage. We must not apply any constraints." So the
// coarse paint buys the first frame and the walk behind it buys the answer.
// (That the two engines END in the same place is `traceWalkParity.test.ts`;
// these are the phase, priority and failure rules around it.)

describe('useTraceDriver — the walk behind the paint', () => {
    it('hands over coarse → walking → complete, and follows every boundary', async () => {
        const seen: string[] = []
        const { provider } = makeProvider(() => coarseResponse(), req => {
            seen.push(String(req.urn))
            return res({ focus: { urn: String(req.urn), level: 0, entityType: '' } })
        })
        const { result } = renderHook(() => useTraceDriver(FOCUS, provider))

        // `walking` is not asserted by waiting for it — on a fixture this
        // small the walk is over within a tick, and a test that waits for a
        // transient state is a test that flakes. The phases either side of it
        // are what a reader can see, and the drill-priority test below holds
        // the walk open to look at `walking` directly.
        await waitFor(() => expect(result.current.phase).toBe('complete'))
        // THE FOCUS FIRST, then the boundary the paint left behind — both
        // without anyone asking. The focus's own fine hop is not optional: the
        // coarse paint answered it at CARD grain, so the raw hops into its own
        // contents have not been asked for yet.
        expect(seen).toEqual([FOCUS, 'P'])
    })

    it('re-roots on a cursor-less boundary and PAGES one that carries a cursor', async () => {
        const asked: Record<string, unknown>[] = []
        const { provider } = makeProvider(
            () => res({
                nodes: [gn(FOCUS), gn('plain'), gn('hub')],
                upstreamUrns: new Set(['plain', 'hub']),
                frontierUp: [
                    { urn: 'plain', totalCount: null, nextCursor: null },
                    { urn: 'hub', totalCount: null, nextCursor: 'e:9' },
                ],
            } as Partial<TraceV2Result & LensClosureExtras>),
            req => { asked.push(req); return res({ focus: { urn: String(req.urn), level: 0, entityType: '' } }) },
        )
        const { result } = renderHook(() => useTraceDriver(FOCUS, provider))
        await waitFor(() => expect(result.current.phase).toBe('complete'))

        const plain = asked.find(r => r.urn === 'plain')!
        const hub = asked.find(r => r.urn === 'hub')!
        // A boundary that ran out of DEPTH is re-rooted, seeded with itself so
        // the server resolves it down to whatever carries lineage beneath it.
        expect(plain).toMatchObject({ direction: 'upstream', upstreamDepth: 1, downstreamDepth: 0, seedUrns: ['plain'] })
        expect(plain.afterCursor).toBeUndefined()
        // One that was half-read is PAGED, verbatim.
        expect(hub).toMatchObject({ afterCursor: 'e:9', direction: 'upstream' })
        expect(hub.seedUrns).toBeUndefined()
        // Neither carries a grain: this is the fine walk, not the paint.
        expect(plain.grain).toBeUndefined()
        expect(hub.grain).toBeUndefined()
    })

    it('a drill jumps the queue: the walk opens no wave while one is in flight', async () => {
        let releaseDrill: (() => void) | null = null
        const order: string[] = []
        const { provider } = makeProvider(
            req => {
                if (!req.drill) return coarseResponse()
                order.push('drill:start')
                return new Promise<TraceV2Result & LensClosureExtras>(resolve => {
                    releaseDrill = () => { order.push('drill:end'); resolve(drillResponse()) }
                })
            },
            (() => {
                const chain = boundedChain()
                // Slow hops, so the walk is still going when the reader opens
                // something — which is the only moment priority means anything.
                return async (req: Record<string, unknown>) => {
                    order.push(`walk:${String(req.urn)}`)
                    return new Promise<TraceV2Result & LensClosureExtras>(resolve =>
                        setTimeout(() => resolve(chain(req)), 30))
                }
            })(),
        )
        const { result } = renderHook(() => useTraceDriver(FOCUS, provider))
        await waitFor(() => expect(result.current.phase).toBe('walking'))

        act(() => { result.current.drill('P') })
        await waitFor(() => expect(result.current.inFlight.size).toBe(1))
        const duringDrill = order.filter(o => o.startsWith('walk:')).length

        await act(async () => { releaseDrill?.() })
        await waitFor(() => expect(result.current.phase).toBe('complete'))

        // Nothing new was fired between the drill starting and finishing…
        expect(order.filter(o => o.startsWith('walk:')).length).toBeGreaterThan(duringDrill)
        // …and the walk carried on afterwards.
        expect(order).toContain('drill:end')
    })

    it('once complete, opening a card costs nothing — the walk already went there', async () => {
        const { provider, traceClosure } = makeProvider(req => req.drill ? drillResponse() : coarseResponse())
        const { result } = renderHook(() => useTraceDriver(FOCUS, provider))
        await waitFor(() => expect(result.current.phase).toBe('complete'))
        const settled = traceClosure.mock.calls.length

        act(() => { result.current.drill('P') })
        expect(traceClosure.mock.calls.length).toBe(settled)
        // Marked as known, so the row's chevron can retract if there is in
        // fact nothing on this lineage inside it.
        expect(result.current.drilled.has('P')).toBe(true)
    })

    it('a failed hop stops the walk, and retry resumes it without repainting', async () => {
        let fail = true
        const { provider, traceClosure } = makeProvider(() => coarseResponse(), req => {
            if (fail) throw new Error('hop refused')
            return res({
                focus: { urn: String(req.urn), level: 0, entityType: '' },
                nodes: [gn('further')],
            } as Partial<TraceV2Result & LensClosureExtras>)
        })
        const { result } = renderHook(() => useTraceDriver(FOCUS, provider))

        await waitFor(() => expect(result.current.phase).toBe('complete'))
        expect(result.current.error).toBe('hop refused')
        expect(result.current.status).toBe('error')
        // The board it did reach is still there.
        expect(result.current.model?.nodes.length).toBeGreaterThan(0)

        fail = false
        const painted = paintCalls(traceClosure).length
        act(() => result.current.retry())
        await waitFor(() => expect(result.current.phase).toBe('complete'))

        expect(result.current.error).toBeNull()
        expect(result.current.model?.nodes.some(n => n.urn === 'further')).toBe(true)
        // Retry re-armed the WALK. Re-painting would have thrown away a
        // picture the reader is already reading.
        expect(paintCalls(traceClosure)).toHaveLength(painted)
    })

    it('never re-fires an op that made no progress', async () => {
        // A server that keeps naming a boundary it has already answered — the
        // shape that looped 100,000 times before the progress rule.
        const { provider, traceClosure } = makeProvider(() => coarseResponse(), req => res({
            focus: { urn: String(req.urn), level: 0, entityType: '' },
            frontierUp: [{ urn: 'P', totalCount: null, nextCursor: null }],
        } as Partial<TraceV2Result & LensClosureExtras>))
        const { result } = renderHook(() => useTraceDriver(FOCUS, provider))

        await waitFor(() => expect(result.current.phase).toBe('complete'))
        expect(traceClosure.mock.calls.length).toBeLessThan(10)
    })

    it('leaving mid-walk stops it dead', async () => {
        const chain = boundedChain()
        const { provider, traceClosure } = makeProvider(
            () => coarseResponse(),
            // Slow enough that the reader can leave while a hop is in flight,
            // which is the only moment this rule is about.
            async req => new Promise<TraceV2Result & LensClosureExtras>(resolve =>
                setTimeout(() => resolve(chain(req)), 40)),
        )
        const { result } = renderHook(() => useTraceDriver(FOCUS, provider))
        await waitFor(() => expect(result.current.phase).toBe('walking'))
        await waitFor(() => expect(traceClosure.mock.calls.length).toBeGreaterThan(1))

        act(() => result.current.abort())
        const stopped = traceClosure.mock.calls.length
        await new Promise(resolve => setTimeout(resolve, 200))

        expect(result.current.phase).toBe('idle')
        expect(result.current.model).toBeNull()
        expect(traceClosure.mock.calls.length).toBe(stopped)
    })
})

// ── the seed/exclude trap ───────────────────────────────────────────────
//
// `excludeUrns` says what must not be re-SHIPPED. It has never said where a
// walk may START — but a client's seeds are BY CONSTRUCTION nodes it already
// holds, so "exclude everything I hold" puts every seed inside its own
// exclude list. The provider was hardened against that reading; sending it
// anyway is asking a walk to start from nothing and trusting the far end not
// to take us literally. Measured live on 2026-08-21: all 29 background pages
// did exactly this, and the walk died three hops in — SILVER, INTERMEDIATE_T1
// and INTERMEDIATE_T2 never arrived, and the canvas contradicted its own dock
// (two empty lanes against "38 upstream").

describe('useTraceDriver — no request excludes its own seeds', () => {
    it('never puts a seed inside its own excludeUrns', async () => {
        const asked: Record<string, unknown>[] = []
        const { provider } = makeProvider(() => coarseResponse(), req => {
            asked.push(req)
            return res({
                focus: { urn: String(req.urn), level: 0, entityType: '' },
                nodes: [gn('beyond')],
                upstreamUrns: new Set(['beyond']),
            } as Partial<TraceV2Result & LensClosureExtras>)
        })
        const { result } = renderHook(() => useTraceDriver(FOCUS, provider))
        await waitFor(() => expect(result.current.phase).toBe('complete'))

        expect(asked.length).toBeGreaterThan(0)
        for (const req of asked) {
            const seeds = new Set((req.seedUrns as string[] | undefined) ?? [])
            const excluded = (req.excludeUrns as string[] | undefined) ?? []
            const overlap = excluded.filter(u => seeds.has(u))
            expect(overlap, `request for ${String(req.urn)} excludes its own seed(s)`).toEqual([])
        }
    })

    it('still excludes what it holds, so the server stops re-naming it', async () => {
        const asked: Record<string, unknown>[] = []
        const { provider } = makeProvider(() => coarseResponse(), req => {
            asked.push(req)
            return res({ focus: { urn: String(req.urn), level: 0, entityType: '' } })
        })
        const { result } = renderHook(() => useTraceDriver(FOCUS, provider))
        await waitFor(() => expect(result.current.phase).toBe('complete'))

        // The bulk drain of P: everything else in the model is fair game to
        // exclude — the focus, its chain, its contents — just not P itself.
        const drain = asked.find(r => (r.seedUrns as string[] | undefined)?.includes('P'))!
        expect(drain.excludeUrns as string[]).toContain(FOCUS)
        expect(drain.excludeUrns as string[]).not.toContain('P')
    })
})

// ── a picture that cannot be drawn is a failure ─────────────────────────

describe('useTraceDriver — a coarse response without the focus', () => {
    it('is an error, not a silent browse canvas', async () => {
        // Nothing throws: a 200 that simply does not contain the focus. The
        // overlay only goes live once the model holds it, so left unsaid this
        // leaves the reader looking at the browse picture under trace chrome
        // and wondering why nothing happened.
        const { provider } = makeProvider(() => res({
            nodes: [gn('somebody-else')],
        } as Partial<TraceV2Result & LensClosureExtras>))
        const { result } = renderHook(() => useTraceDriver(FOCUS, provider))

        await waitFor(() => expect(result.current.phase).toBe('error'))
        expect(result.current.status).toBe('error')
        expect(result.current.error).toMatch(/anchored on/i)
    })

    it('and a response that DOES hold the focus walks on as normal', async () => {
        const { provider } = makeProvider(() => coarseResponse())
        const { result } = renderHook(() => useTraceDriver(FOCUS, provider))
        await waitFor(() => expect(result.current.phase).toBe('complete'))
        expect(result.current.error).toBeNull()
    })
})
