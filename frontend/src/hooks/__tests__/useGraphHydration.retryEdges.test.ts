/**
 * The edge banner's Retry fetches the edges, not the whole view.
 *
 * "Some relationships could not be loaded" reports a failed EDGE read, and its
 * Retry re-ran the whole view: every node batch, every anchored column's first
 * page and /edges/between over everything. retryEdges asks /edges/between once,
 * over what is loaded, with the same typed request as the hydration, so a
 * stored :AGGREGATED cell (the phantom stubs on anchored rows) never comes back
 * through it.
 */
import { act, renderHook } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'

const { mockProvider } = vi.hoisted(() => ({
  mockProvider: {
    getNodes: vi.fn(async () => [] as unknown[]),
    getEdgesBetween: vi.fn(async () => [] as unknown[]),
    getChildren: vi.fn(async () => []),
    getChildrenWithEdges: vi.fn(),
  },
}))

vi.mock('@/providers/GraphProviderContext', () => ({
  useGraphProvider: () => mockProvider,
  useGraphProviderContext: () => ({ providerVersion: 1 }),
}))
vi.mock('@/hooks/useViewSchema', () => ({
  useViewContainmentEdgeTypes: () => ['CONTAINS'],
  useViewLineageEdgeTypes: () => ['FLOWS_TO', 'AGGREGATED'],
  useViewRootEntityTypes: () => ['domain'],
  useViewEntityTypes: () => [],
  useViewSchemaIsReady: () => true,
}))
vi.mock('@/store/schema', () => ({
  useActiveView: () => ({
    id: 'v-edges',
    layout: { type: 'reference', referenceLayout: { layers: [], assignments: {} } },
    content: { visibleEntityTypes: [], entityScope: 'curated' },
  }),
  isContainmentEdgeType: () => false,
  normalizeEdgeType: (t: string) => t,
}))

import { useGraphHydration } from '../useGraphHydration'
import { useCanvasStore } from '@/store/canvas'
import { toCanvasNode } from '@/lib/canvasNodeMapper'

const entity = (urn: string) => toCanvasNode({ urn, entityType: 'system', displayName: urn } as never)

describe('useGraphHydration — retryEdges', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    const store = useCanvasStore.getState()
    store.setGraph([entity('a'), entity('b'), entity('logical:g')], [])
    store.clearEdgeFetchFailures()
    store.noteEdgeFetchFailure('timed out')
    store.noteEdgeFetchFailure('timed out')
  })

  it('asks for the edges among what is loaded, once, by type, and keeps no roll-up cell', async () => {
    mockProvider.getEdgesBetween.mockResolvedValueOnce([
      { id: 'flow', sourceUrn: 'a', targetUrn: 'b', edgeType: 'FLOWS_TO' },
      { id: 'cell', sourceUrn: 'a', targetUrn: 'b', edgeType: 'AGGREGATED' },
    ])
    const { result } = renderHook(() => useGraphHydration())
    await act(() => result.current.retryEdges())

    expect(mockProvider.getEdgesBetween).toHaveBeenCalledTimes(1)
    expect(mockProvider.getEdgesBetween).toHaveBeenCalledWith(['a', 'b'], ['CONTAINS', 'FLOWS_TO'], 200_000)
    // Not a re-run of the view.
    expect(mockProvider.getNodes).not.toHaveBeenCalled()
    expect(mockProvider.getChildrenWithEdges).not.toHaveBeenCalled()

    const store = useCanvasStore.getState()
    expect(store.edgeFetchFailures).toBe(0)
    expect(store.edges.map(e => e.id)).toEqual(['flow'])
  })

  it('a refetch that fails again says so again', async () => {
    mockProvider.getEdgesBetween.mockRejectedValueOnce(new Error('API Error 504: REQUEST_TIMEOUT'))
    const { result } = renderHook(() => useGraphHydration())
    await act(() => result.current.retryEdges())

    expect(useCanvasStore.getState().edgeFetchFailures).toBe(1)
  })
})
