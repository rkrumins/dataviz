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

function makeProvider(
    impl: (req: Record<string, unknown>) => TraceV2Result & LensClosureExtras | Promise<TraceV2Result & LensClosureExtras>,
) {
    const traceClosure = vi.fn(async (req: Record<string, unknown>) => impl(req))
    return { provider: { traceClosure } as unknown as GraphDataProvider, traceClosure }
}

// ── the first paint ─────────────────────────────────────────────────────

describe('useTraceDriver — the coarse first paint', () => {
    it('asks for ONE hop at coarse grain and then stops', async () => {
        const { provider, traceClosure } = makeProvider(() => coarseResponse())
        const { result } = renderHook(() => useTraceDriver(FOCUS, provider))

        await waitFor(() => expect(result.current.phase).toBe('ready'))

        expect(traceClosure).toHaveBeenCalledTimes(1)
        expect(traceClosure.mock.calls[0][0]).toEqual({
            urn: FOCUS, direction: 'both', upstreamDepth: 1, downstreamDepth: 1,
            grain: 'coarse',
        })
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
        await waitFor(() => expect(result.current.phase).toBe('ready'))

        act(() => result.current.drill(FOCUS))
        expect(traceClosure).toHaveBeenCalledTimes(1)
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
            return res({ nodes: [gn(`c${i}`)], seedCursor: cursor } as Partial<TraceV2Result & LensClosureExtras>)
        })
        const { result } = renderHook(() => useTraceDriver(FOCUS, provider))
        await waitFor(() => expect(result.current.phase).toBe('ready'))

        expect(traceClosure).toHaveBeenCalledTimes(3)
        expect(traceClosure.mock.calls[1][0]).toMatchObject({ seedCursor: 's:a' })
        expect(traceClosure.mock.calls[2][0]).toMatchObject({ seedCursor: 's:b' })
    })

    it('pages one anchor`s edges through the frontier cursor, one direction at a time', async () => {
        const { provider, traceClosure } = makeProvider((req) => {
            if (req.afterCursor) return res({ nodes: [gn('hub')] })
            return res({
                nodes: [gn('hub')],
                frontierUp: [{ urn: 'hub', totalCount: null, nextCursor: 'e:0' }],
            } as Partial<TraceV2Result & LensClosureExtras>)
        })
        const { result } = renderHook(() => useTraceDriver(FOCUS, provider))
        await waitFor(() => expect(result.current.phase).toBe('ready'))

        expect(traceClosure).toHaveBeenCalledTimes(2)
        expect(traceClosure.mock.calls[1][0]).toEqual({
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
        await waitFor(() => expect(result.current.phase).toBe('ready'))

        expect(traceClosure).toHaveBeenCalledTimes(1)
        expect(result.current.model?.frontierUp.map(f => f.urn)).toEqual(['P'])
    })
})

// ── drill ───────────────────────────────────────────────────────────────

describe('useTraceDriver — drill on expand', () => {
    it('fetches the card`s contents once, and never again', async () => {
        const { provider, traceClosure } = makeProvider(req =>
            req.drill ? drillResponse() : coarseResponse())
        const { result } = renderHook(() => useTraceDriver(FOCUS, provider))
        await waitFor(() => expect(result.current.phase).toBe('ready'))

        await act(async () => { result.current.drill('P') })
        await waitFor(() => expect(result.current.inFlight.size).toBe(0))

        expect(traceClosure).toHaveBeenCalledTimes(2)
        expect(traceClosure.mock.calls[1][0]).toEqual({
            urn: 'P', direction: 'both', upstreamDepth: 1, downstreamDepth: 1, drill: true,
        })

        await act(async () => { result.current.drill('P') })
        expect(traceClosure).toHaveBeenCalledTimes(2)
    })

    it('merges into the SAME model — the coarse picture is not replaced', async () => {
        const { provider } = makeProvider(req => req.drill ? drillResponse() : coarseResponse())
        const { result } = renderHook(() => useTraceDriver(FOCUS, provider))
        await waitFor(() => expect(result.current.phase).toBe('ready'))

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
        })
        const { result } = renderHook(() => useTraceDriver(FOCUS, provider))
        await waitFor(() => expect(result.current.phase).toBe('ready'))

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
        const { provider } = makeProvider(req => req.drill ? drillResponse() : coarseResponse())
        const { result } = renderHook(() => useTraceDriver(FOCUS, provider))
        await waitFor(() => expect(result.current.phase).toBe('ready'))

        // Nothing is complete yet — there is no raw evidence at all, and P is
        // a closed card that says it holds one thing nobody has asked for.
        expect(result.current.completePairs.size).toBe(0)
    })

    it('flips the pair once BOTH cones are leaf-or-drilled', async () => {
        const { provider } = makeProvider(req => req.drill ? drillResponse() : coarseResponse())
        const { result } = renderHook(() => useTraceDriver(FOCUS, provider))
        await waitFor(() => expect(result.current.phase).toBe('ready'))

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
            _req: Record<string, unknown>, opts?: { signal?: AbortSignal },
        ) => { seen.push(opts?.signal); return coarseResponse() })
        const provider = { traceClosure } as unknown as GraphDataProvider

        const { result, rerender } = renderHook(
            ({ urn }: { urn: string }) => useTraceDriver(urn, provider),
            { initialProps: { urn: FOCUS } },
        )
        await waitFor(() => expect(result.current.phase).toBe('ready'))
        const first = seen[0]

        rerender({ urn: 'OTHER' })
        await waitFor(() => expect(result.current.phase).toBe('ready'))

        expect(first?.aborted).toBe(true)
        expect(seen[1]?.aborted).toBe(false)
    })

    it('keeps the model`s identity across renders nothing happened in', async () => {
        const { provider } = makeProvider(() => coarseResponse())
        const { result, rerender } = renderHook(() => useTraceDriver(FOCUS, provider))
        await waitFor(() => expect(result.current.phase).toBe('ready'))

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
        await waitFor(() => expect(result.current.phase).toBe('ready'))
        expect(result.current.error).toBeNull()
        expect(traceClosure).toHaveBeenCalledTimes(2)
    })

    it('a failed DRILL says so and leaves the card re-openable', async () => {
        let failDrill = true
        const { provider, traceClosure } = makeProvider(req => {
            if (!req.drill) return coarseResponse()
            if (failDrill) throw new Error('drill refused')
            return drillResponse()
        })
        const { result } = renderHook(() => useTraceDriver(FOCUS, provider))
        await waitFor(() => expect(result.current.phase).toBe('ready'))

        await act(async () => { result.current.drill('P') })
        await waitFor(() => expect(result.current.error).toBe('drill refused'))
        expect(result.current.status).toBe('error')
        // The coarse picture is still on screen — a failed expansion is not a
        // failed trace.
        expect(result.current.phase).toBe('ready')
        expect(result.current.drilled.has('P')).toBe(false)

        failDrill = false
        await act(async () => { result.current.drill('P') })
        await waitFor(() => expect(result.current.status).toBe('done'))
        expect(traceClosure).toHaveBeenCalledTimes(3)
    })
})
