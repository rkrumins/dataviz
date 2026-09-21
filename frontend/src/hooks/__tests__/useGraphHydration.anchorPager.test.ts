/**
 * An anchored column's first page seeds the pager the canvas continues from.
 *
 * Hydration prefetches one page of each anchor's children, so the column is not
 * empty on arrival. That page used to come from the list-only /children call —
 * no cursor — and the column's first scroll then paged from scratch: page 1
 * again, nothing new, and the load-more latch never re-armed.
 *
 * The pager now lives in the canvas store, so the hydrating instance of this
 * hook and the canvas's own instance share it: the first scroll asks for page 2.
 */
import { act, renderHook, waitFor } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'

const ANCHOR = 'urn:e:anchor'
const kid = (i: number) => `urn:e:k${String(i).padStart(3, '0')}`

const { mockProvider } = vi.hoisted(() => ({
  mockProvider: {
    getNodes: vi.fn(async () => [] as unknown[]),
    getEdgesBetween: vi.fn(async () => []),
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
  useViewLineageEdgeTypes: () => ['FLOWS_TO'],
  useViewRootEntityTypes: () => ['domain'],
  useViewEntityTypes: () => [
    { id: 'domain', hierarchy: { canBeContainedBy: [], canContain: ['system'] } },
    { id: 'system', hierarchy: { canBeContainedBy: ['domain'], canContain: [] } },
  ],
  useViewSchemaIsReady: () => true,
}))
vi.mock('@/store/schema', () => ({
  useActiveView: () => ({
    id: 'v-anchor',
    layout: {
      type: 'reference',
      referenceLayout: {
        layers: [{ id: 'L1', name: 'Anchor', anchorUrn: ANCHOR }],
        assignments: { [ANCHOR]: { layerId: 'L1' } },
      },
    },
    content: { visibleEntityTypes: ['domain', 'system'], entityScope: 'curated' },
  }),
  isContainmentEdgeType: (edgeType: string, types: string[]) =>
    types.some((t) => t.toUpperCase() === edgeType.toUpperCase()),
  normalizeEdgeType: (e: { data?: { edgeType?: string } }) => (e.data?.edgeType || '').toUpperCase(),
}))

import { useGraphHydration } from '../useGraphHydration'
import { useCanvasStore } from '@/store/canvas'

function page(from: number, count: number, total: number) {
  const idx = Array.from({ length: count }, (_, k) => from + k)
  const last = idx[idx.length - 1]
  const hasMore = last < total - 1
  return {
    children: idx.map(i => ({ urn: kid(i), entityType: 'system', displayName: `k${i}` })),
    containmentEdges: idx.map(i => ({ id: `c${i}`, sourceUrn: ANCHOR, targetUrn: kid(i), edgeType: 'CONTAINS' })),
    lineageEdges: [],
    totalChildren: total,
    hasMore,
    nextCursor: hasMore ? `after:${last}` : null,
  }
}

describe('anchored column — the prefetch seeds the shared pager', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    useCanvasStore.getState().setGraph([], [])
    mockProvider.getNodes.mockImplementation(async () => [
      { urn: ANCHOR, entityType: 'domain', displayName: 'Anchor', childCount: 250 },
    ])
    mockProvider.getChildrenWithEdges.mockImplementation(async (_u: string, o: { cursor?: string | null; offset?: number }) => {
      const from = o.cursor ? Number(o.cursor.split(':')[1]) + 1 : (o.offset ?? 0)
      return page(from, Math.min(100, 250 - from), 250)
    })
  })

  it('continues from page 2 on the first scroll, from another hook instance', async () => {
    const hydrating = renderHook(() => useGraphHydration({ hydrate: true }))
    await waitFor(() => expect(hydrating.result.current.hydrationStatus).toBe('ready'))

    const pager = useCanvasStore.getState().childPaging[ANCHOR]
    expect(pager).toMatchObject({ cursor: 'after:99', delivered: 100, hasMore: true })
    expect(mockProvider.getChildren).not.toHaveBeenCalled()

    // The canvas has its OWN instance of the hook — as in the app.
    const canvas = renderHook(() => useGraphHydration())
    mockProvider.getChildrenWithEdges.mockClear()
    await act(async () => { await canvas.result.current.loadChildren(ANCHOR) })

    const call = mockProvider.getChildrenWithEdges.mock.calls[0] as unknown as [string, { cursor?: string; offset?: number }]
    expect(call[1].cursor).toBe('after:99')
    expect(call[1].offset).toBe(100)
    expect(mockProvider.getChildrenWithEdges).toHaveBeenCalledTimes(1)   // no page-1 refetch
  })
})
