/**
 * The NATIVE canvas trace SEAM — the wiring ContextViewCanvas owns,
 * mirrored around the REAL controller (useCanvasTraceWalk), the REAL
 * canvas store, and the REAL trace filter (useTraceFilteredHierarchy).
 * Only the provider (the network) is stubbed.
 *
 * The journeys these pin are the spec's acceptance criteria: the whole
 * flow lands upfront with zero interactions, the budget pauses honestly
 * and resumes, exit restores the pre-trace store, and a participant the
 * layer-assignment rule cannot place is merged-but-hidden — and counted.
 */
import { useMemo } from 'react'
import { renderHook, waitFor, act } from '@testing-library/react'
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { useCanvasTraceWalk } from '@/hooks/useCanvasTraceWalk'
import { computeTraceVisibleUrns } from '@/hooks/lib/traceViewFilter'
import { useTraceFilteredHierarchy } from '@/hooks/useTraceFilteredHierarchy'
import { useCanvasStore } from '@/store/canvas'
import type { HierarchyNode } from '@/types/hierarchy'
import type { GraphDataProvider, TraceV2Result, LensClosureExtras, GraphNode } from '@/providers/GraphDataProvider'

// ── closure fixtures (the wire) ──────────────────────────────────────

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

/** The walk: colA (in table T1 under the known PLAT) feeds F. */
const estate = () => closureResult({
  focus: f('F'),
  nodes: [gn('F', 'dataset'), gn('colA'), gn('T1', 'dataset')],
  edges: [hop('colA', 'F', 'e1')],
  containmentEdges: [holds('T1', 'colA'), holds('PLAT', 'T1')],
  upstreamUrns: new Set(['colA']),
})

// ── canvas fixtures (what the layered canvas derives) ────────────────

const hnode = (id: string, children: HierarchyNode[] = []): HierarchyNode =>
  ({ id, urn: id, name: `label-${id}`, typeId: 'x', children }) as unknown as HierarchyNode

/** Post-merge hierarchy approximation: PLAT ⊃ {T1 ⊃ colA, TX ⊃ colX}
 *  in layer L1; F alone in L2. TX/colX are the browse siblings the
 *  trace filter must prune. */
function hierarchyFixture() {
  const colA = hnode('colA')
  const colX = hnode('colX')
  const t1 = hnode('T1', [colA])
  const tx = hnode('TX', [colX])
  const plat = hnode('PLAT', [t1, tx])
  const fNode = hnode('F')
  const displayFlat = [plat, t1, colA, tx, colX, fNode]
  const displayMap = new Map(displayFlat.map(n => [n.id, n]))
  const parentMap = new Map<string, string>([['T1', 'PLAT'], ['TX', 'PLAT'], ['colA', 'T1'], ['colX', 'TX']])
  const childMap = new Map<string, string[]>([['PLAT', ['T1', 'TX']], ['T1', ['colA']], ['TX', ['colX']]])
  const nodesByLayer = new Map<string, HierarchyNode[]>([['L1', [plat]], ['L2', [fNode]]])
  return { nodesByLayer, displayFlat, displayMap, parentMap, childMap }
}

const EMPTY_DRILLDOWNS: Map<string, TraceV2Result> = new Map()

/** ContextViewCanvas's native-trace block, and nothing else. */
function useSeam(
  provider: GraphDataProvider,
  fixture: ReturnType<typeof hierarchyFixture>,
  view: { showUp?: boolean; showDown?: boolean; depthUp?: number; depthDown?: number } = {},
) {
  const { showUp = true, showDown = true, depthUp = Infinity, depthDown = Infinity } = view
  const canvasTrace = useCanvasTraceWalk(provider)
  const traceActive = canvasTrace.isTracing
  const traceModel = canvasTrace.walkEntry?.model ?? null
  // Verbatim from ContextViewCanvas: direction+depth narrow what renders.
  const traceVisibleUrns = useMemo<ReadonlySet<string>>(() => {
    if (!traceActive || !traceModel || !canvasTrace.tracedUrn) return canvasTrace.traceNodeUrns
    return computeTraceVisibleUrns({
      model: traceModel, focusUrn: canvasTrace.tracedUrn,
      showUpstream: showUp, showDownstream: showDown,
      upstreamDepth: depthUp, downstreamDepth: depthDown,
    })
  }, [traceActive, traceModel, canvasTrace, showUp, showDown, depthUp, depthDown])
  const expandedForRender = useMemo(() => {
    if (!traceActive || canvasTrace.expansionUrns.size === 0) return new Set<string>()
    const out = new Set<string>()
    for (const u of canvasTrace.expansionUrns) {
      if (traceVisibleUrns.has(u)) out.add(u)
    }
    return out
  }, [traceActive, canvasTrace.expansionUrns, traceVisibleUrns])
  const filtered = useTraceFilteredHierarchy({
    ...fixture,
    isTracing: traceActive,
    traceNodes: traceVisibleUrns,
    drilldowns: EMPTY_DRILLDOWNS,
    expandedNodes: expandedForRender,
  })
  const hiddenTraceCount = useMemo(() => {
    if (!traceActive) return 0
    let hidden = 0
    for (const urn of canvasTrace.traceNodeUrns) {
      if (!filtered.filteredMap.has(urn)) hidden++
    }
    return hidden
  }, [traceActive, canvasTrace.traceNodeUrns, filtered.filteredMap])
  return { canvasTrace, filtered, hiddenTraceCount, expandedForRender }
}

const seedNode = (id: string) =>
  ({ id, type: 'default' as const, position: { x: 0, y: 0 }, data: { label: id, urn: id, type: 'dataset' } })

const SEED_IDS = ['F', 'PLAT', 'TX', 'colX']
beforeEach(() => {
  useCanvasStore.getState().setGraph(SEED_IDS.map(seedNode) as never[], [])
})
const storeNodeIds = () => useCanvasStore.getState().nodes.map(n => n.id).sort()
const storeEdgeIds = () => useCanvasStore.getState().edges.map(e => e.id).sort()

describe('canvas trace seam', () => {
  it('a trace draws the whole flow upfront with zero interactions: store holds every hop, the filter keeps only the flow and its hosts, partners start TOP-MOST', async () => {
    const { provider } = providerByUrn({ F: estate })
    const { result } = renderHook(() => useSeam(provider, hierarchyFixture()))
    act(() => result.current.canvasTrace.start('F'))

    await waitFor(() => expect(result.current.canvasTrace.fullWalkStatus?.exhausted).toBe(true))
    // The store gained the deep hops (T1, colA) and their wires.
    expect(storeNodeIds()).toEqual(['F', 'PLAT', 'T1', 'TX', 'colA', 'colX'])
    expect(storeEdgeIds()).toEqual(['c:PLAT>T1', 'c:T1>colA', 'e1'])
    // The filter keeps the flow + host containers, prunes the siblings.
    const rendered = [...result.current.filtered.filteredMap.keys()].sort()
    expect(rendered).toEqual(['F', 'PLAT', 'T1', 'colA'])
    // 2026-08-19 fourth-and-final ruling ("BFS to top most entities, then
    // expand"): partners start at their TOP-MOST roots, closed — PLAT
    // stays shut with colA→F rolled up onto it; only the FOCUS's own
    // chain would auto-open, and F is already a root.
    expect([...result.current.expandedForRender].sort()).toEqual([])
    expect(result.current.hiddenTraceCount).toBe(0)
  })

  it('budget journey: cap → AUTO-grant → exhausted with zero clicks, store complete', async () => {
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
    const { result } = renderHook(() => useSeam(provider, hierarchyFixture()))
    act(() => result.current.canvasTrace.start('F'))

    // 2026-08-19 ruling: no "Keep walking" pedaling — the canvas trace
    // AUTO-GRANTS through budget parks (up to a hard ceiling) while the
    // capsule narrates. The walk reaches exhaustion with ZERO clicks,
    // and budgetHit is never surfaced while auto-grants remain.
    await waitFor(() => expect(result.current.canvasTrace.fullWalkStatus?.exhausted).toBe(true))
    expect(traceClosure).toHaveBeenCalledTimes(2)
    expect(useCanvasStore.getState().nodes.some(n => n.id === 'deeper')).toBe(true)
  })

  it('exit restores: the store equals its pre-trace content and the filter is pass-through again', async () => {
    const fixture = hierarchyFixture()
    const { provider } = providerByUrn({ F: estate })
    const { result } = renderHook(() => useSeam(provider, fixture))
    act(() => result.current.canvasTrace.start('F'))
    await waitFor(() => expect(storeNodeIds()).toContain('colA'))

    act(() => result.current.canvasTrace.exit())
    expect(storeNodeIds()).toEqual([...SEED_IDS].sort())
    expect(storeEdgeIds()).toEqual([])
    // Pass-through: outside trace mode the filter returns the inputs
    // by reference — the browse picture, untouched.
    expect(result.current.filtered.filteredFlat).toBe(fixture.displayFlat)
    expect(result.current.hiddenTraceCount).toBe(0)
  })

  it('upstream-only view: the downstream branch AND its host containers leave the canvas, and the fallback cannot resurrect them', async () => {
    // The walk brings one upstream (colA in T1) and one downstream
    // (colD in TD) participant; hiding downstream must remove colD, TD,
    // and never relax them back in via TD's expansion.
    const { provider } = providerByUrn({
      F: () => closureResult({
        ...estate(),
        nodes: [...estate().nodes, gn('colD'), gn('TD', 'dataset')],
        edges: [...estate().edges, hop('F', 'colD', 'e-down')],
        containmentEdges: [...estate().containmentEdges, holds('TD', 'colD'), holds('PLAT', 'TD')],
        downstreamUrns: new Set(['colD', 'TD']),
      }),
    })
    const fixture = (() => {
      const base = hierarchyFixture()
      const colD = hnode('colD')
      const td = hnode('TD', [colD])
      const plat = base.displayMap.get('PLAT')!
      plat.children.push(td)
      base.displayFlat.push(td, colD)
      base.displayMap.set('TD', td)
      base.displayMap.set('colD', colD)
      base.parentMap.set('TD', 'PLAT')
      base.parentMap.set('colD', 'TD')
      base.childMap.set('TD', ['colD'])
      base.childMap.get('PLAT')!.push('TD')
      return base
    })()
    const { result } = renderHook(() => useSeam(provider, fixture, { showDown: false }))
    act(() => result.current.canvasTrace.start('F'))
    await waitFor(() => expect(result.current.canvasTrace.fullWalkStatus?.exhausted).toBe(true))

    const rendered = [...result.current.filtered.filteredMap.keys()].sort()
    expect(rendered).toEqual(['F', 'PLAT', 'T1', 'colA'])
    expect(result.current.expandedForRender.has('TD')).toBe(false)
  })

  it('hop-depth view limit: depth 1 upstream hides the second hop, instantly and without a refetch', async () => {
    // colB feeds colA feeds F: two upstream hops.
    const { provider, traceClosure } = providerByUrn({
      F: () => closureResult({
        ...estate(),
        nodes: [...estate().nodes, gn('colB'), gn('T2', 'dataset')],
        edges: [...estate().edges, hop('colB', 'colA', 'e2')],
        containmentEdges: [...estate().containmentEdges, holds('T2', 'colB'), holds('PLAT', 'T2')],
        upstreamUrns: new Set(['colA', 'colB']),
      }),
    })
    const fixture = (() => {
      const base = hierarchyFixture()
      const colB = hnode('colB')
      const t2 = hnode('T2', [colB])
      base.displayMap.get('PLAT')!.children.push(t2)
      base.displayFlat.push(t2, colB)
      base.displayMap.set('T2', t2)
      base.displayMap.set('colB', colB)
      base.parentMap.set('T2', 'PLAT')
      base.parentMap.set('colB', 'T2')
      base.childMap.set('T2', ['colB'])
      base.childMap.get('PLAT')!.push('T2')
      return base
    })()
    const { result, rerender } = renderHook(
      ({ depthUp }: { depthUp: number }) => useSeam(provider, fixture, { depthUp }),
      { initialProps: { depthUp: Infinity } },
    )
    act(() => result.current.canvasTrace.start('F'))
    await waitFor(() => expect(result.current.canvasTrace.fullWalkStatus?.exhausted).toBe(true))
    const calls = traceClosure.mock.calls.length
    expect(result.current.filtered.filteredMap.has('colB')).toBe(true)

    rerender({ depthUp: 1 })
    expect(result.current.filtered.filteredMap.has('colA')).toBe(true)
    expect(result.current.filtered.filteredMap.has('colB')).toBe(false)
    expect(result.current.filtered.filteredMap.has('T2')).toBe(false)
    expect(traceClosure).toHaveBeenCalledTimes(calls)   // view-only — zero refetches
  })

  it('a participant whose chain reaches no known anchor merges but does not render — and is counted', async () => {
    const { provider } = providerByUrn({
      F: () => closureResult({
        ...estate(),
        nodes: [...estate().nodes, gn('lost'), gn('LOST_ROOT', 'container')],
        containmentEdges: [...estate().containmentEdges, holds('LOST_ROOT', 'lost')],
        upstreamUrns: new Set(['colA', 'lost']),
      }),
    })
    const { result } = renderHook(() => useSeam(provider, hierarchyFixture()))
    act(() => result.current.canvasTrace.start('F'))
    await waitFor(() => expect(result.current.canvasTrace.fullWalkStatus?.exhausted).toBe(true))

    // Merged into the store — the data is real and layer assignment may
    // yet claim it…
    expect(storeNodeIds()).toContain('lost')
    // …but the hierarchy never places it, so the filter cannot render it,
    // and the honesty count says so (the participant and its orphan root).
    expect(result.current.filtered.filteredMap.has('lost')).toBe(false)
    expect(result.current.hiddenTraceCount).toBe(2)
  })
})
