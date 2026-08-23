/**
 * useCanvasTraceWalk — the native canvas trace session controller.
 *
 * Real `useCanvasStore`, real `useLensWalk` full-walk driver; only the
 * provider (the network) is stubbed. The contract this pins is a NEGATIVE
 * one and it is the whole point of the Stage 1 rebuild: start(urn) walks
 * the closure to the ends, every wave lands in the MODEL, and the canvas
 * store is never touched — not on start, not on a wave, not on exit. What
 * the reader sees is drawn from the model by the overlay
 * (`useTraceOverlay` / `buildTraceView`), so leaving a trace restores the
 * canvas for free.
 */
import { renderHook, waitFor, act } from '@testing-library/react'
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { useCanvasTraceWalk } from '../useCanvasTraceWalk'
import { recordEvent } from '@/services/telemetryService'
import { useCanvasStore } from '@/store/canvas'
import type { LensWalkModel } from '@/components/canvas/context-view/lens/closure-adapter'
import type { GraphDataProvider, TraceV2Result, LensClosureExtras, GraphNode } from '@/providers/GraphDataProvider'

vi.mock('@/services/telemetryService', () => ({ recordEvent: vi.fn() }))

const gn = (urn: string, entityType = 'column'): GraphNode =>
  ({ urn, displayName: `label-${urn}`, entityType, properties: {} }) as GraphNode

const hop = (source: string, target: string, id: string) =>
  ({ id, sourceUrn: source, targetUrn: target, edgeType: 'TRANSFORMS' })

const holds = (parent: string, child: string) =>
  ({ id: `c:${parent}>${child}`, sourceUrn: parent, targetUrn: child, edgeType: 'CONTAINS' })

function closureResult(
  overrides: Partial<TraceV2Result & LensClosureExtras> & { focus: TraceV2Result['focus'] },
): TraceV2Result & LensClosureExtras {
  return {
    nodes: [], edges: [], containmentEdges: [],
    upstreamUrns: new Set(), downstreamUrns: new Set(),
    effectiveLevel: 0, isInherited: false, inheritedFromUrn: null,
    truncated: false, truncationReason: null,
    frontierUp: [], frontierDown: [], seedTruncated: false,
    ...overrides,
  }
}

const f = (urn: string) => ({ urn, level: 0, entityType: 'dataset' })

function providerByUrn(responses: Record<string, () => TraceV2Result & LensClosureExtras>) {
  const traceClosure = vi.fn(async (req: Record<string, unknown>) => {
    const impl = responses[req.urn as string]
    if (!impl) throw new Error(`unexpected call: ${JSON.stringify(req)}`)
    return impl()
  })
  return { provider: { scopeKey: 'ws1', traceClosure } as unknown as GraphDataProvider, traceClosure }
}

/** The walk's estate: focus F (already on canvas) gains column colA in
 *  new table T1 under the known platform PLAT. */
const estate = () => closureResult({
  focus: f('F'),
  nodes: [gn('F', 'dataset'), gn('colA'), gn('T1', 'dataset'), gn('PLAT', 'container')],
  edges: [hop('colA', 'F', 'e1')],
  containmentEdges: [holds('T1', 'colA'), holds('PLAT', 'T1')],
  upstreamUrns: new Set(['colA']),
})

const seedNode = (id: string) =>
  ({ id, type: 'default' as const, position: { x: 0, y: 0 }, data: { label: id, urn: id, type: 'dataset' } })

beforeEach(() => {
  vi.mocked(recordEvent).mockClear()
  // setGraph, not setState: the store maintains internal _nodeIndex/_edgeIndex
  // dedup sets, and replacing the arrays alone leaves stale indexes that
  // silently swallow later addNodes/addEdges calls.
  useCanvasStore.getState().setGraph([seedNode('F'), seedNode('PLAT')] as never[], [])
})

const storeNodeIds = () => useCanvasStore.getState().nodes.map(n => n.id).sort()
const storeEdgeIds = () => useCanvasStore.getState().edges.map(e => e.id).sort()
const modelNodeUrns = (model: LensWalkModel | null | undefined) =>
  (model?.nodes ?? []).map(n => n.urn).sort()

/** Counts every change to the store's `nodes`/`edges` identity. */
function watchStore() {
  const writes = { count: 0 }
  const release = useCanvasStore.subscribe((s, prev) => {
    if (s.nodes !== prev.nodes || s.edges !== prev.edges) writes.count += 1
  })
  return { writes, release }
}

describe('useCanvasTraceWalk', () => {
  it('start → walk lands → the flow is in the MODEL and the store is untouched', async () => {
    const { provider } = providerByUrn({ F: estate })
    const { writes, release } = watchStore()
    const { result } = renderHook(() => useCanvasTraceWalk(provider))
    act(() => result.current.start('F'))
    expect(result.current.isTracing).toBe(true)

    await waitFor(() => expect(result.current.progress?.phase).toBe('done'))
    expect(modelNodeUrns(result.current.walkEntry?.model)).toEqual(['F', 'PLAT', 'T1', 'colA'])
    expect(result.current.walkEntry?.model?.lineageEdges.map(e => e.id)).toEqual(['e1'])

    expect(storeNodeIds()).toEqual(['F', 'PLAT'])
    expect(storeEdgeIds()).toEqual([])
    expect(writes.count).toBe(0)
    release()
  })

  it('a second wave grows the model — still no store write', async () => {
    // F's closure leaves a frontier on colA; the driver extends it and the
    // second wave brings colB one hop further upstream.
    const { provider, traceClosure } = providerByUrn({
      F: () => ({ ...estate(), frontierUp: [{ urn: 'colA', totalCount: 1, nextCursor: null }] }),
      colA: () => closureResult({
        focus: f('colA'),
        nodes: [gn('colB')],
        edges: [hop('colB', 'colA', 'e2')],
        upstreamUrns: new Set(['colB']),
      }),
    })
    const { writes, release } = watchStore()
    const { result } = renderHook(() => useCanvasTraceWalk(provider))
    act(() => result.current.start('F'))

    await waitFor(() => expect(result.current.progress?.phase).toBe('done'))
    // The first paint's two legs (fine + coarse), then the extend.
    expect(traceClosure).toHaveBeenCalledTimes(3)
    expect(modelNodeUrns(result.current.walkEntry?.model)).toEqual(['F', 'PLAT', 'T1', 'colA', 'colB'])

    expect(storeNodeIds()).toEqual(['F', 'PLAT'])
    expect(storeEdgeIds()).toEqual([])
    expect(writes.count).toBe(0)
    release()
  })

  it('exit clears the focus and leaves the store exactly as it was', async () => {
    const { provider } = providerByUrn({ F: estate })
    const { writes, release } = watchStore()
    const { result } = renderHook(() => useCanvasTraceWalk(provider))
    act(() => result.current.start('F'))
    await waitFor(() => expect(modelNodeUrns(result.current.walkEntry?.model)).toContain('colA'))

    act(() => result.current.exit())
    expect(result.current.isTracing).toBe(false)
    expect(result.current.tracedUrn).toBeNull()
    expect(result.current.walkEntry).toBeNull()
    expect(storeNodeIds()).toEqual(['F', 'PLAT'])
    expect(storeEdgeIds()).toEqual([])
    expect(writes.count).toBe(0)
    release()
  })

  it('re-trace of a different urn re-focuses; the store still never moves', async () => {
    const { provider } = providerByUrn({
      F: estate,
      G: () => closureResult({
        focus: f('G'),
        nodes: [gn('G', 'dataset'), gn('colG')],
        edges: [hop('colG', 'G', 'eg')],
        upstreamUrns: new Set(['colG']),
      }),
    })
    const { writes, release } = watchStore()
    const { result } = renderHook(() => useCanvasTraceWalk(provider))
    act(() => result.current.start('F'))
    await waitFor(() => expect(modelNodeUrns(result.current.walkEntry?.model)).toContain('colA'))

    act(() => result.current.start('G'))
    await waitFor(() => expect(modelNodeUrns(result.current.walkEntry?.model)).toContain('colG'))
    expect(result.current.tracedUrn).toBe('G')
    // F's flow is gone from the session — nothing of it lingers anywhere.
    expect(modelNodeUrns(result.current.walkEntry?.model)).not.toContain('colA')
    expect(storeNodeIds()).toEqual(['F', 'PLAT'])
    expect(writes.count).toBe(0)
    release()
  })

  it('idle before a focus is set: no walk entry, no status', () => {
    const { provider } = providerByUrn({ F: estate })
    const { result } = renderHook(() => useCanvasTraceWalk(provider))
    expect(result.current.isTracing).toBe(false)
    expect(result.current.walkEntry).toBeNull()
    expect(result.current.progress).toBeNull()
  })

  it('a wide flow walks to completion hands-free — no budget, no "Keep walking" — and the store still never moves', async () => {
    const nodes: GraphNode[] = [gn('F', 'dataset')]
    const containment: Array<ReturnType<typeof holds>> = []
    for (let i = 0; i < 1100; i++) {
      nodes.push(gn(`n${i}`))
      containment.push(holds('PLAT', `n${i}`))
    }
    const { provider, traceClosure } = providerByUrn({
      F: () => closureResult({
        focus: f('F'), nodes, containmentEdges: containment,
        upstreamUrns: new Set(nodes.map(n => n.urn)),
        frontierUp: [{ urn: 'n0', totalCount: 1, nextCursor: null, reason: 'depth' }],
      }),
      n0: () => closureResult({
        focus: f('n0'), nodes: [gn('deeper')], edges: [hop('deeper', 'n0', 'e-deep')],
        upstreamUrns: new Set(['deeper']),
      }),
    })
    const { writes, release } = watchStore()
    const { result } = renderHook(() => useCanvasTraceWalk(provider))
    act(() => result.current.start('F'))

    // 1,101 nodes used to park the walk at a 1,000-node budget and wait for
    // a click. Now the depth entry is drained by itself.
    await waitFor(() => expect(result.current.progress?.phase).toBe('done'))
    // The first paint's two legs (fine + coarse), then the bulk re-seed.
    expect(traceClosure).toHaveBeenCalledTimes(3)
    expect(modelNodeUrns(result.current.walkEntry?.model)).toContain('deeper')
    expect(result.current.progress).toMatchObject({ phase: 'done', pending: 0, requests: 3 })

    expect(storeNodeIds()).toEqual(['F', 'PLAT'])
    expect(writes.count).toBe(0)
    release()
  })

  // ── Telemetry ─────────────────────────────────────────────────────
  // Tracing lineage is the product's value moment, and this is the path every
  // Context View trace takes — including the one a shared trace link opens
  // into. It went uninstrumented while the other trace path was counted, so
  // the activation funnel's "traced lineage" stage was measuring one surface
  // and reporting on both.

  it('records the trace once the walk settles, not when it starts', async () => {
    const { provider } = providerByUrn({ F: estate })
    const { result } = renderHook(() => useCanvasTraceWalk(provider))

    act(() => result.current.start('F'))
    // At `start` there is no answer yet — recording here could not tell a
    // trace that found lineage from one that came back empty.
    expect(recordEvent).not.toHaveBeenCalled()

    await waitFor(() => expect(result.current.progress?.phase).toBe('done'))
    await waitFor(() => expect(recordEvent).toHaveBeenCalledTimes(1))

    const [type, payload] = vi.mocked(recordEvent).mock.calls[0]
    expect(type).toBe('lineage.trace')
    expect(payload).toMatchObject({ upstream: 1, downstream: 0, surface: 'context-view' })
  })

  it('a trace that finds no lineage is its own event type', async () => {
    // Not a flag on the payload: "how often does someone ask for lineage and
    // get nothing?" stays a GROUP BY on event_type rather than a payload scan.
    const barren = () => closureResult({ focus: f('F'), nodes: [gn('F', 'dataset')] })
    const { provider } = providerByUrn({ F: barren })
    const { result } = renderHook(() => useCanvasTraceWalk(provider))

    act(() => result.current.start('F'))
    await waitFor(() => expect(result.current.progress?.phase).toBe('done'))
    await waitFor(() => expect(recordEvent).toHaveBeenCalledTimes(1))

    expect(vi.mocked(recordEvent).mock.calls[0][0]).toBe('lineage.trace_empty')
  })

  it('one trace is one event, however many waves it lands in', async () => {
    const { provider } = providerByUrn({
      F: () => ({ ...estate(), frontierUp: [{ urn: 'colA', totalCount: 1, nextCursor: null }] }),
      colA: () => closureResult({
        focus: f('colA'),
        nodes: [gn('colB')],
        edges: [hop('colB', 'colA', 'e2')],
        upstreamUrns: new Set(['colB']),
      }),
    })
    const { result } = renderHook(() => useCanvasTraceWalk(provider))

    act(() => result.current.start('F'))
    await waitFor(() => expect(result.current.progress?.phase).toBe('done'))
    await waitFor(() => expect(recordEvent).toHaveBeenCalledTimes(1))

    // The model kept growing after the first wave; the event did not.
    expect(recordEvent).toHaveBeenCalledTimes(1)
  })

  it('re-tracing the focal already on screen counts as asking again', async () => {
    // The walk is cached, so `tracedUrn` never changes and nothing refetches.
    // The reader still asked for lineage twice, and the OTHER trace path
    // records every press — two surfaces counting the same action differently
    // would make the metric mean whichever canvas someone happened to be on.
    const { provider } = providerByUrn({ F: estate })
    const { result } = renderHook(() => useCanvasTraceWalk(provider))

    act(() => result.current.start('F'))
    await waitFor(() => expect(recordEvent).toHaveBeenCalledTimes(1))

    act(() => result.current.start('F'))
    await waitFor(() => expect(recordEvent).toHaveBeenCalledTimes(2))
  })
})
