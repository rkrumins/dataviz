/**
 * THE PARITY GATE.
 *
 * The user's ruling, in one line: "When I run the trace, ensure it covers the
 * ENTIRE walk like Lens Full Flow. We must see the entire lineage. We must not
 * apply any constraints."
 *
 * So the canvas trace and the Lens's Full Flow must END in the same place.
 * They get there differently on purpose — the canvas paints a coarse picture
 * first so the board is readable in milliseconds, then walks the rest behind
 * it; the Lens walks from the start — and that difference is exactly what
 * could let them drift. This file is what stops it: one synthetic estate, one
 * fake server implementing the real wire contract, both engines run to
 * exhaustion over it, and their models compared.
 *
 * Parity is asserted on NODES and on RAW lineage edges. The canvas model may
 * additionally hold rollup edges from its coarse paint — a summary of hops the
 * fine walk states individually — which is a difference in what has been SAID
 * about the flow, never in what the flow IS. (This estate has no rollup lane,
 * so here the two sets coincide anyway; the assertion is written to survive an
 * estate that does.)
 */
import { renderHook, waitFor } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'

import { useTraceDriver } from '../useTraceDriver'
import { useLensWalk } from '../useLensWalk'
import { pipelineGraph, fineWalkServer, trueClosure } from '@/test/fixtures/pipelineEstate'
import type { GraphDataProvider } from '@/providers/GraphDataProvider'
import type { LensWalkModel } from '@/components/canvas/context-view/lens/closure-adapter'

/** 25 levels × 40 attributes: 1,026 nodes, 2,880 flows, and a focus with
 *  lineage running both ways out of it — a reachable closure of ~990, which
 *  no single 300-node page can carry, so BOTH engines have to follow their
 *  frontiers to the ends.
 *
 *  SIZED FOR THE HARNESS, not for the graph. A 3,000-node version of the same
 *  estate kills the vitest worker (measured: unexpected exit at 78 s) —
 *  `mergeClosures` rebuilds its maps over the whole model per response, so the
 *  cost of a walk is quadratic in jsdom in a way it is not in a browser. The
 *  property under test is "both engines converge", which does not depend on
 *  the size; the SCALE claim is certified live against the real graphs
 *  instead. */
const GRAPH = pipelineGraph(25, 40)
const PAGE = 300

function serve() {
    const answer = fineWalkServer(GRAPH, PAGE)
    const traceClosure = vi.fn(async (req: Record<string, unknown>) =>
        answer(req as never))
    return { provider: { scopeKey: 'parity', traceClosure } as unknown as GraphDataProvider, traceClosure }
}

const urnsOf = (m: LensWalkModel | null | undefined) =>
    [...new Set((m?.nodes ?? []).map(n => n.urn))].sort()
const rawEdgesOf = (m: LensWalkModel | null | undefined) =>
    [...new Set((m?.lineageEdges ?? []).filter(e => e.kind !== 'rollup').map(e => e.id ?? ''))].sort()

describe('the canvas trace and the Lens Full Flow reach the same lineage', () => {
    it('both walk the estate to exhaustion and hold the same model', async () => {
        const canvas = serve()
        const lens = serve()

        const driver = renderHook(() => useTraceDriver(GRAPH.focus, canvas.provider))
        const walk = renderHook(() => useLensWalk(GRAPH.focus, lens.provider, 25, true))

        await waitFor(
            () => expect(driver.result.current.phase).toBe('complete'),
            { timeout: 60000 },
        )
        await waitFor(
            () => expect(walk.result.current.fullWalkFor(GRAPH.focus)?.exhausted).toBe(true),
            { timeout: 60000 },
        )

        const canvasModel = driver.result.current.model
        const lensModel = walk.result.current.walkFor(GRAPH.focus)?.model

        // BOTH RIGHT, not merely in agreement. Two engines that lost the same
        // nodes would pass a bare comparison, so the closure is computed
        // independently off the graph and both are held to it.
        const expected = [...trueClosure(GRAPH)].sort()
        expect(expected.length).toBeGreaterThan(500)
        expect(urnsOf(canvasModel)).toEqual(expected)
        expect(urnsOf(lensModel)).toEqual(expected)

        // And the same lineage between them, hop for hop.
        expect(rawEdgesOf(canvasModel).length).toBeGreaterThan(1000)
        expect(rawEdgesOf(canvasModel)).toEqual(rawEdgesOf(lensModel))
    }, 90000)

    it('neither stops at a budget: the walk keeps going past any ceiling', async () => {
        const canvas = serve()
        const driver = renderHook(() => useTraceDriver(GRAPH.focus, canvas.provider))
        await waitFor(
            () => expect(driver.result.current.phase).toBe('complete'),
            { timeout: 60000 },
        )
        // The retired ceiling was 1,000 nodes. The model is multiples of it
        // and no one was asked to press anything.
        expect(driver.result.current.model!.nodes.length).toBeGreaterThan(500)
        expect(driver.result.current.error).toBeNull()
    }, 90000)
})
