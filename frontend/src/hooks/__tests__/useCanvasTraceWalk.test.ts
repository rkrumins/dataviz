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
import { useCanvasStore } from '@/store/canvas'
import type { LensWalkModel } from '@/components/canvas/context-view/lens/closure-adapter'
import type { GraphDataProvider, TraceV2Result, LensClosureExtras, GraphNode } from '@/providers/GraphDataProvider'

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

    await waitFor(() => expect(result.current.fullWalkStatus?.exhausted).toBe(true))
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

    await waitFor(() => expect(result.current.fullWalkStatus?.exhausted).toBe(true))
    expect(traceClosure).toHaveBeenCalledTimes(2)
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
    await waitFor(() => expect(result.current.traceNodeUrns.has('colA')).toBe(true))

    act(() => result.current.exit())
    expect(result.current.isTracing).toBe(false)
    expect(result.current.tracedUrn).toBeNull()
    expect(result.current.traceNodeUrns.size).toBe(0)
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
    await waitFor(() => expect(result.current.traceNodeUrns.has('colA')).toBe(true))

    act(() => result.current.start('G'))
    await waitFor(() => expect(result.current.traceNodeUrns.has('colG')).toBe(true))
    expect(result.current.tracedUrn).toBe('G')
    // F's flow is gone from the session — nothing of it lingers anywhere.
    expect(result.current.traceNodeUrns.has('colA')).toBe(false)
    expect(storeNodeIds()).toEqual(['F', 'PLAT'])
    expect(writes.count).toBe(0)
    release()
  })

  it('traceNodeUrns and expansionUrns derive from the model', async () => {
    const { provider } = providerByUrn({ F: estate })
    const { result } = renderHook(() => useCanvasTraceWalk(provider))
    expect(result.current.traceNodeUrns.size).toBe(0)

    act(() => result.current.start('F'))
    await waitFor(() => expect(result.current.traceNodeUrns.has('colA')).toBe(true))
    expect(result.current.traceNodeUrns.has('F')).toBe(true)
    expect([...result.current.expansionUrns].sort()).toEqual(['PLAT', 'T1'])
  })

  it('budget journey: cap → Keep walking → exhausted, the model complete and the store still empty of it', async () => {
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
        frontierUp: [{ urn: 'n0', totalCount: 1, nextCursor: null }],
      }),
      n0: () => closureResult({
        focus: f('n0'), nodes: [gn('deeper')], edges: [hop('deeper', 'n0', 'e-deep')],
        upstreamUrns: new Set(['deeper']),
      }),
    })
    const { writes, release } = watchStore()
    const { result } = renderHook(() => useCanvasTraceWalk(provider))
    act(() => result.current.start('F'))

    await waitFor(() => expect(result.current.fullWalkStatus?.budgetHit).toBe(true))
    expect(traceClosure).toHaveBeenCalledTimes(1)

    act(() => result.current.continueWalk())
    await waitFor(() => expect(result.current.fullWalkStatus?.exhausted).toBe(true))
    expect(result.current.traceNodeUrns.has('deeper')).toBe(true)

    expect(storeNodeIds()).toEqual(['F', 'PLAT'])
    expect(writes.count).toBe(0)
    release()
  })
})
