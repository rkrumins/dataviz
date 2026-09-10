/**
 * useGraphHydration — what the user keeps seeing while a load is incomplete.
 *
 * The rule under test: never take data away from the user because a retry
 * is in progress, and never pretend an incomplete load is complete.
 *
 *  - A curated view whose batches PARTLY failed renders the entities that
 *    arrived, records the gap (count of assigned entities in the failed
 *    batches) and stays in a failed status so the retry loop keeps going —
 *    CanvasRouter shows a pill over the data rather than the blocking card.
 *  - A retry of the SAME view does not clear the canvas between attempts.
 *  - A genuinely new view still starts from an empty canvas.
 */
import { act, renderHook, waitFor } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'

const { mockProvider, viewState } = vi.hoisted(() => ({
  mockProvider: {
    getNodes: vi.fn(async () => [] as unknown[]),
    getEdgesBetween: vi.fn(async () => []),
    getChildren: vi.fn(async () => []),
  },
  viewState: { id: 'v1', assignments: {} as Record<string, { layerId: string }> },
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
    content: { visibleEntityTypes: ['layer', 'object'], entityScope: 'curated' },
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

    // Let the retry loop run at least one failed attempt: the node must
    // still be there — a retry never empties the canvas.
    const callsAtFailure = mockProvider.getNodes.mock.calls.length
    await waitFor(() => expect(mockProvider.getNodes.mock.calls.length).toBeGreaterThan(callsAtFailure))
    expect(useCanvasStore.getState().nodes.length).toBeGreaterThanOrEqual(1)

    secondBatchFails = false
    await waitFor(() => expect(result.current.hydrationStatus).toBe('ready'), { timeout: 5_000 })
    expect(useCanvasStore.getState().nodes.length).toBe(2)
    expect(useCanvasStore.getState().nodeFetchFailures).toBe(0)
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
