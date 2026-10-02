/**
 * useGraphHydration — what the user keeps seeing while a load is incomplete.
 *
 * The rule under test: never take data away from the user because a retry
 * is in progress, and never pretend an incomplete load is complete.
 *
 *  - A curated view whose batches PARTLY failed renders the entities that
 *    arrived, records the gap (count of assigned entities in the failed
 *    batches) and stays in a failed status — CanvasRouter shows a pill over
 *    the data rather than the blocking card.
 *  - A retry asks only for the entities whose batch failed, and after the
 *    fast attempts a partial load stops retrying on its own: the pill's Retry
 *    resumes it.
 *  - A retry of the SAME view does not clear the canvas between attempts.
 *  - A genuinely new view still starts from an empty canvas.
 *  - Placements the load asked for and didn't get are recorded as not found, but never those in
 *    a batch that failed (unknown, not absent) and never a temporary URN; in an open view too,
 *    whose placements the type pages didn't bring are asked for by URN.
 */
import { act, renderHook, waitFor } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'

const { mockProvider, viewState } = vi.hoisted(() => ({
  mockProvider: {
    getNodes: vi.fn(async () => [] as unknown[]),
    getNodesPage: vi.fn(async () => ({ nodes: [] as unknown[], hasMore: false, nextOffset: 0 })),
    getEdgesBetween: vi.fn(async () => []),
    getChildren: vi.fn(async () => []),
  },
  viewState: { id: 'v1', assignments: {} as Record<string, { layerId: string }>, scope: 'curated' as 'curated' | 'all' },
}))

vi.mock('@/providers/GraphProviderContext', () => ({
  useGraphProvider: () => mockProvider,
  useGraphProviderContext: () => ({ providerVersion: 1 }),
}))
vi.mock('@/hooks/useViewSchema', () => ({
  useViewContainmentEdgeTypes: () => ['CONTAINS'],
  useViewLineageEdgeTypes: () => ['FLOWS_TO'],
  useViewRootEntityTypes: () => ['layer'],
  useViewEntityTypes: () => [
    { id: 'layer', hierarchy: { canBeContainedBy: [], canContain: ['object'] } },
    { id: 'object', hierarchy: { canBeContainedBy: ['layer'], canContain: [] } },
  ],
  useViewSchemaIsReady: () => true,
}))
vi.mock('@/store/schema', () => ({
  useActiveView: () => ({
    id: viewState.id,
    layout: {
      type: 'reference',
      referenceLayout: { layers: [{ id: 'L1' }], assignments: viewState.assignments },
    },
    content: { visibleEntityTypes: ['layer', 'object'], entityScope: viewState.scope },
  }),
  isContainmentEdgeType: () => false,
  normalizeEdgeType: (t: string) => t,
}))
// Tiny, jitter-free cadence so the retry loop runs in ms (one fast attempt,
// then the slow cadence — still tiny).
vi.mock('@/config/polling', () => ({
  POLLING_INTERVALS: { providerRetry: 10, providerRetrySlow: 20 },
  PROVIDER_RETRY_MAX_ATTEMPTS: 1,
  withJitter: (ms: number) => ms,
}))

import { useGraphHydration } from '../useGraphHydration'
import { useCanvasStore } from '@/store/canvas'

function apiError(status: number, code?: string) {
  return Object.assign(new Error(`API Error ${status}: ${code ?? ''}`), { status, code })
}

function node(i: number) {
  return { urn: `urn:e:${i}`, entityType: 'object', displayName: `e${i}` }
}

/** The URNs each getNodes call asked for, in call order. */
function askedUrns(): string[][] {
  return (mockProvider.getNodes.mock.calls as unknown as Array<[{ urns?: string[] }]>).map(c => c[0].urns ?? [])
}

function assignUrns(count: number) {
  const assignments: Record<string, { layerId: string }> = {}
  for (let i = 0; i < count; i++) assignments[`urn:e:${i}`] = { layerId: 'L1' }
  viewState.assignments = assignments
}

describe('useGraphHydration — partial loads and retries keep data on screen', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    viewState.id = 'v1'
    useCanvasStore.getState().setGraph([], [])
    useCanvasStore.getState().clearNodeFetchFailures()
  })

  it('renders what arrived, records the gap, and stays in a retrying state', async () => {
    assignUrns(150) // batches: 100 + 50
    mockProvider.getNodes.mockImplementation(async (q: { urns?: string[] }) => {
      // The second (50-entity) batch keeps timing out; the first loads.
      if (q.urns && q.urns.length === 50) throw apiError(504, 'PROVIDER_TIMEOUT')
      return [node(0), node(1)]
    })

    const { result } = renderHook(() => useGraphHydration({ hydrate: true }))
    await waitFor(() => expect(result.current.hydrationStatus).toBe('slow'))

    const store = useCanvasStore.getState()
    expect(store.nodes.length).toBe(2)          // the entities that loaded are on screen
    expect(store.nodeFetchFailures).toBe(1)
    expect(store.missingEntityCount).toBe(50)   // the failed batch's assigned entities
    expect(result.current.hydrationPhase).toBe('complete')
  })

  it('keeps the partial canvas through a retry and flips to ready once the retry completes', async () => {
    assignUrns(150)
    let secondBatchFails = true
    mockProvider.getNodes.mockImplementation(async (q: { urns?: string[] }) => {
      if (q.urns && q.urns.length === 50) {
        if (secondBatchFails) throw apiError(429, 'PROVIDER_BUSY')
        return [node(100)]
      }
      return [node(0)]
    })

    const { result } = renderHook(() => useGraphHydration({ hydrate: true }))
    await waitFor(() => expect(result.current.hydrationStatus).toBe('slow'))
    expect(useCanvasStore.getState().nodes.length).toBe(1)

    // Let the retry loop run at least one failed attempt (the first load made
    // two calls): the node must still be there — a retry never empties the
    // canvas.
    await waitFor(() => expect(mockProvider.getNodes.mock.calls.length).toBeGreaterThan(2))
    expect(useCanvasStore.getState().nodes.length).toBeGreaterThanOrEqual(1)

    secondBatchFails = false
    // The fast attempts are spent by now (one, in this file), so the reader's
    // Retry is what asks again.
    act(() => result.current.retryHydration())
    await waitFor(() => expect(result.current.hydrationStatus).toBe('ready'), { timeout: 5_000 })
    expect(useCanvasStore.getState().nodes.length).toBe(2)
    expect(useCanvasStore.getState().nodeFetchFailures).toBe(0)
  })

  it('a retry asks only for the batch that failed', async () => {
    assignUrns(150) // batches: 100 + 50
    mockProvider.getNodes.mockImplementation(async (...args: unknown[]) => {
      const q = args[0] as { urns?: string[] }
      if (q.urns && q.urns.length === 50) throw apiError(504, 'PROVIDER_TIMEOUT')
      return [node(0)]
    })

    const { result } = renderHook(() => useGraphHydration({ hydrate: true }))
    await waitFor(() => expect(result.current.hydrationStatus).toBe('slow'))
    // The first attempt asked for both batches; wait for the retry.
    await waitFor(() => expect(mockProvider.getNodes.mock.calls.length).toBeGreaterThan(2))
    for (const urns of askedUrns().slice(2)) {
      expect(urns).toHaveLength(50)
      expect(urns.every(u => Number(u.split(':')[2]) >= 100)).toBe(true)
    }
    // What the first attempt brought stays on screen, and is not reported
    // as a placement that points at nothing.
    expect(useCanvasStore.getState().nodes.map(n => n.id)).toContain('urn:e:0')
    expect(useCanvasStore.getState().placementsNotFound?.urns ?? []).not.toContain('urn:e:0')
    // The edges are still asked for over everything on screen.
    const lastEdges = mockProvider.getEdgesBetween.mock.calls.at(-1) as unknown as [string[]]
    expect(lastEdges[0]).toContain('urn:e:0')
  })

  it('a partial load stops retrying on its own after the fast attempts, and Retry resumes it', async () => {
    assignUrns(150) // batches: 100 + 50
    mockProvider.getNodes.mockImplementation(async (...args: unknown[]) => {
      const q = args[0] as { urns?: string[] }
      if (q.urns && q.urns.length === 50) throw apiError(504, 'PROVIDER_TIMEOUT')
      return [node(0)]
    })
    // Every attempt asks for the failing batch, so it counts attempts.
    const attempts = () => askedUrns().filter(urns => urns.length === 50).length

    const { result } = renderHook(() => useGraphHydration({ hydrate: true }))
    // The first load, then the one fast attempt this file allows.
    await waitFor(() => expect(attempts()).toBe(2))
    await waitFor(() => expect(result.current.autoRetryStopped).toBe(true))
    // The slow cadence here is 20ms: nothing more is asked.
    await new Promise(r => setTimeout(r, 200))
    expect(attempts()).toBe(2)
    expect(result.current.hydrationStatus).toBe('slow')
    expect(useCanvasStore.getState().nodes.length).toBe(1)

    act(() => result.current.retryHydration())
    expect(result.current.autoRetryStopped).toBe(false)
    await waitFor(() => expect(attempts()).toBeGreaterThan(2))
    await waitFor(() => expect(result.current.autoRetryStopped).toBe(true))
  })

  it('a genuinely new view starts from an empty canvas', async () => {
    assignUrns(3)
    mockProvider.getNodes.mockResolvedValue([node(0)])
    const { result, rerender } = renderHook(() => useGraphHydration({ hydrate: true }))
    await waitFor(() => expect(result.current.hydrationStatus).toBe('ready'))
    expect(useCanvasStore.getState().nodes.length).toBe(1)

    // Switch views: the previous view's nodes must not linger while the new
    // one loads — a different view is a different graph.
    let release: () => void = () => {}
    mockProvider.getNodes.mockImplementation(
      () => new Promise(resolve => { release = () => resolve([node(7)]) }),
    )
    act(() => { viewState.id = 'v2' })
    rerender()
    await waitFor(() => expect(result.current.hydrationStatus).toBe('loading'))
    expect(useCanvasStore.getState().nodes.length).toBe(0)
    act(() => release())
    await waitFor(() => expect(result.current.hydrationStatus).toBe('ready'))
    expect(useCanvasStore.getState().nodes.map(n => n.id)).toEqual(['urn:e:7'])
  })
})

describe('useGraphHydration — placements that point at nothing', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    viewState.id = 'v1'
    useCanvasStore.getState().setGraph([], [])
    useCanvasStore.getState().clearNodeFetchFailures()
  })

  it('records assigned entities the graph was asked for and didn’t return', async () => {
    assignUrns(5)
    viewState.assignments['urn:staged:object:tmp1'] = { layerId: 'L1' }
    mockProvider.getNodes.mockResolvedValue([node(0), node(1), node(2)])
    const { result } = renderHook(() => useGraphHydration({ hydrate: true }))
    await waitFor(() => expect(result.current.hydrationStatus).toBe('ready'))
    expect(useCanvasStore.getState().placementsNotFound).toEqual({ viewId: 'v1', urns: ['urn:e:3', 'urn:e:4'] })
  })

  it('records them in an open view too, from the placements it asked for by URN', async () => {
    viewState.scope = 'all'
    try {
      assignUrns(3)
      // The type pages bring nothing, so every placement is asked for by URN; one isn't here.
      mockProvider.getNodes.mockResolvedValue([node(0), node(1)])
      const { result } = renderHook(() => useGraphHydration({ hydrate: true }))
      await waitFor(() => expect(result.current.hydrationStatus).toBe('ready'))
      expect(mockProvider.getNodesPage).toHaveBeenCalled()
      expect(useCanvasStore.getState().placementsNotFound).toEqual({ viewId: 'v1', urns: ['urn:e:2'] })
    } finally {
      viewState.scope = 'curated'
    }
  })

  it('leaves out the entities of a batch that failed: those are unknown, not absent', async () => {
    assignUrns(150) // batches: 100 + 50
    mockProvider.getNodes.mockImplementation(async (...args: unknown[]) => {
      const q = args[0] as { urns?: string[] }
      if (q.urns && q.urns.length === 50) throw apiError(504, 'PROVIDER_TIMEOUT')
      return [node(0)]
    })
    const { result } = renderHook(() => useGraphHydration({ hydrate: true }))
    await waitFor(() => expect(result.current.hydrationStatus).toBe('slow'))
    const urns = useCanvasStore.getState().placementsNotFound?.urns ?? []
    expect(urns).toHaveLength(99)
    expect(urns.some((u) => Number(u.split(':')[2]) >= 100)).toBe(false)
  })
})
