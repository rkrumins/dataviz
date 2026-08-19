/**
 * useCanvasTraceWalk — the native canvas trace session controller.
 *
 * Real `useCanvasStore`, real `useLensWalk` full-walk driver, real
 * delta-merge; only the provider (the network) is stubbed. Contract:
 * start(urn) walks the closure to the ends and batch-merges every wave
 * into the store; exit removes exactly what the trace added; derived
 * sets (traceNodeUrns / expansionUrns / addedEdgeIds) feed the canvas.
 */
import { renderHook, waitFor, act } from '@testing-library/react'
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { useCanvasTraceWalk } from '../useCanvasTraceWalk'
import { useCanvasStore } from '@/store/canvas'
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

describe('useCanvasTraceWalk', () => {
  it('start → walk lands → the store gains the flow nodes and edges', async () => {
    const { provider } = providerByUrn({ F: estate })
    const { result } = renderHook(() => useCanvasTraceWalk(provider))
    act(() => result.current.start('F'))
    expect(result.current.isTracing).toBe(true)

    await waitFor(() => expect(storeNodeIds()).toEqual(['F', 'PLAT', 'T1', 'colA']))
    expect(storeEdgeIds()).toEqual(['c:PLAT>T1', 'c:T1>colA', 'e1'])
    expect(result.current.fullWalkStatus?.exhausted).toBe(true)
  })

  it('a second wave merges only the delta', async () => {
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
    const { result } = renderHook(() => useCanvasTraceWalk(provider))
    act(() => result.current.start('F'))

    await waitFor(() => expect(result.current.fullWalkStatus?.exhausted).toBe(true))
    expect(traceClosure).toHaveBeenCalledTimes(2)
    expect(storeNodeIds()).toEqual(['F', 'PLAT', 'T1', 'colA', 'colB'])
    expect(storeEdgeIds()).toEqual(['c:PLAT>T1', 'c:T1>colA', 'e1', 'e2'])
  })

  it('exit removes exactly what the trace added — the store equals its pre-trace state', async () => {
    const { provider } = providerByUrn({ F: estate })
    const { result } = renderHook(() => useCanvasTraceWalk(provider))
    act(() => result.current.start('F'))
    await waitFor(() => expect(storeNodeIds()).toContain('colA'))

    act(() => result.current.exit())
    expect(result.current.isTracing).toBe(false)
    expect(storeNodeIds()).toEqual(['F', 'PLAT'])
    expect(storeEdgeIds()).toEqual([])
    expect(result.current.addedEdgeIds.size).toBe(0)
    expect(result.current.traceNodeUrns.size).toBe(0)
  })

  it('re-trace of a different urn exits the old session first', async () => {
    const { provider } = providerByUrn({
      F: estate,
      G: () => closureResult({
        focus: f('G'),
        nodes: [gn('G', 'dataset'), gn('colG')],
        edges: [hop('colG', 'G', 'eg')],
        upstreamUrns: new Set(['colG']),
      }),
    })
    const { result } = renderHook(() => useCanvasTraceWalk(provider))
    act(() => result.current.start('F'))
    await waitFor(() => expect(storeNodeIds()).toContain('colA'))

    act(() => result.current.start('G'))
    await waitFor(() => expect(storeNodeIds()).toContain('colG'))
    // F's merge is gone; G's is present.
    expect(storeNodeIds()).toEqual(['F', 'G', 'PLAT', 'colG'])
    expect(result.current.tracedUrn).toBe('G')
  })

  it('traceNodeUrns and expansionUrns derive from the model; addedEdgeIds is a stable instance', async () => {
    const { provider } = providerByUrn({ F: estate })
    const { result } = renderHook(() => useCanvasTraceWalk(provider))
    const idleSet = result.current.addedEdgeIds
    expect(result.current.traceNodeUrns.size).toBe(0)

    act(() => result.current.start('F'))
    await waitFor(() => expect(result.current.traceNodeUrns.has('colA')).toBe(true))
    expect(result.current.traceNodeUrns.has('F')).toBe(true)
    expect([...result.current.expansionUrns].sort()).toEqual(['PLAT', 'T1'])
    expect(result.current.addedEdgeIds).toBe(idleSet)   // stable identity
    await waitFor(() => expect(result.current.addedEdgeIds.has('e1')).toBe(true))
  })

  it('PERF GATE: exit of a 1,000-node trace completes in ≤ 100ms', async () => {
    const nodes: GraphNode[] = [gn('F', 'dataset')]
    const edges: Array<ReturnType<typeof hop>> = []
    const containment: Array<ReturnType<typeof holds>> = []
    for (let t = 0; t < 100; t++) {
      nodes.push(gn(`T${t}`, 'dataset'))
      containment.push(holds('PLAT', `T${t}`))
      for (let c = 0; c < 10; c++) {
        const urn = `T${t}:c${c}`
        nodes.push(gn(urn))
        containment.push(holds(`T${t}`, urn))
        if (t > 0) edges.push(hop(`T${t - 1}:c${c}`, urn, `e:${t}:${c}`))
      }
    }
    const { provider } = providerByUrn({
      F: () => closureResult({
        focus: f('F'), nodes, edges, containmentEdges: containment,
        upstreamUrns: new Set(nodes.map(n => n.urn)),
      }),
    })
    const { result } = renderHook(() => useCanvasTraceWalk(provider))
    act(() => result.current.start('F'))
    await waitFor(() => expect(useCanvasStore.getState().nodes.length).toBeGreaterThan(1000))

    const t0 = performance.now()
    act(() => result.current.exit())
    const elapsed = performance.now() - t0
    expect(storeNodeIds()).toEqual(['F', 'PLAT'])
    expect(elapsed).toBeLessThanOrEqual(100)
  })
})
