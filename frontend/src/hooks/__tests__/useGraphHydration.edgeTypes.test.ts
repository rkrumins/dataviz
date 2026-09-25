/**
 * Hydration reads lineage BY TYPE, and never keeps a stored roll-up cell.
 *
 * The reference view's /edges/between asked for every relationship type, so
 * the stored :AGGREGATED cells came with it — pairs between an anchor and its
 * own rows among them. The canvas cannot draw an anchor (it IS the column),
 * so those cells turned into stubs on the rows as soon as a view opened, and
 * the heaviest read on open got heavier. Roll-ups for the rows on screen come
 * from /edges/aggregated; hydration asks for containment and lineage only.
 *
 * And the flows primed for a child page land after the page: if its rows were
 * removed meanwhile (a sort flip refetches them, a collapse prunes them), the
 * flows must not land on rows that are gone.
 */
import { act, renderHook, waitFor } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'

const ANCHOR = 'urn:e:anchor'
const kid = (i: number) => `urn:e:k${String(i).padStart(3, '0')}`

const { mockProvider, schema } = vi.hoisted(() => ({
  mockProvider: {
    getNodes: vi.fn(async () => [] as unknown[]),
    getEdgesBetween: vi.fn(async () => [] as unknown[]),
    getChildren: vi.fn(async () => []),
    getChildrenWithEdges: vi.fn(),
    getEdges: vi.fn<(q: { sourceUrns?: string[]; targetUrns?: string[] }) => Promise<unknown[]>>(async () => []),
  },
  schema: { lineage: ['FLOWS_TO', 'AGGREGATED'] as string[] },
}))

vi.mock('@/providers/GraphProviderContext', () => ({
  useGraphProvider: () => mockProvider,
  useGraphProviderContext: () => ({ providerVersion: 1 }),
}))
vi.mock('@/hooks/useViewSchema', () => ({
  useViewContainmentEdgeTypes: () => ['CONTAINS'],
  useViewLineageEdgeTypes: () => schema.lineage,
  useViewRootEntityTypes: () => ['domain'],
  useViewEntityTypes: () => [
    { id: 'domain', hierarchy: { canBeContainedBy: [], canContain: ['system'] } },
    { id: 'system', hierarchy: { canBeContainedBy: ['domain'], canContain: [] } },
  ],
  useViewSchemaIsReady: () => true,
}))
vi.mock('@/store/schema', () => ({
  useActiveView: () => ({
    id: 'v-types',
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

async function hydrate() {
  const hook = renderHook(() => useGraphHydration({ hydrate: true }))
  await waitFor(() => expect(hook.result.current.hydrationStatus).toBe('ready'))
  return hook
}

describe('hydration reads lineage by type', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    schema.lineage = ['FLOWS_TO', 'AGGREGATED']
    useCanvasStore.getState().setGraph([], [])
    mockProvider.getNodes.mockImplementation(async () => [
      { urn: ANCHOR, entityType: 'domain', displayName: 'Anchor', childCount: 150 },
    ])
    mockProvider.getChildrenWithEdges.mockImplementation(async (_u: string, o: { offset?: number }) => {
      const from = o.offset ?? 0
      return page(from, Math.min(100, 150 - from), 150)
    })
  })

  it('asks /edges/between for containment and lineage, never AGGREGATED', async () => {
    await hydrate()
    const call = mockProvider.getEdgesBetween.mock.calls[0] as unknown as [string[], string[] | undefined]
    expect(call[1]).toEqual(['CONTAINS', 'FLOWS_TO'])
  })

  it('keeps a roll-up cell the server sends anyway out of the store', async () => {
    mockProvider.getEdgesBetween.mockImplementation(async () => [
      { id: 'agg', sourceUrn: ANCHOR, targetUrn: kid(0), edgeType: 'AGGREGATED' },
      { id: 'f1', sourceUrn: kid(0), targetUrn: kid(1), edgeType: 'FLOWS_TO' },
    ])
    await hydrate()
    const ids = useCanvasStore.getState().edges.map(e => e.id)
    expect(ids).toContain('f1')
    expect(ids).not.toContain('agg')
  })

  it('asks untyped only when the view declares no lineage types — and still drops the cells', async () => {
    schema.lineage = []
    mockProvider.getEdgesBetween.mockImplementation(async () => [
      { id: 'agg', sourceUrn: ANCHOR, targetUrn: kid(0), edgeType: 'AGGREGATED' },
    ])
    await hydrate()
    const call = mockProvider.getEdgesBetween.mock.calls[0] as unknown as [string[], string[] | undefined]
    expect(call[1]).toBeUndefined()
    expect(useCanvasStore.getState().edges.map(e => e.id)).not.toContain('agg')
  })

  it('drops the flows primed for a page whose rows were removed before they landed', async () => {
    await hydrate()
    let release!: () => void
    const gate = new Promise<void>(r => { release = r })
    const pageTwo = Array.from({ length: 50 }, (_, k) => kid(100 + k))
    mockProvider.getEdges.mockImplementation(async (q: { sourceUrns?: string[] }) => {
      await gate
      return q.sourceUrns
        ? [{ id: 'late-1', sourceUrn: pageTwo[0], targetUrn: kid(0), edgeType: 'FLOWS_TO' }]
        : [{ id: 'late-2', sourceUrn: kid(1), targetUrn: pageTwo[1], edgeType: 'FLOWS_TO' }]
    })

    const canvas = renderHook(() => useGraphHydration())
    await act(async () => { await canvas.result.current.loadChildren(ANCHOR) })
    expect(useCanvasStore.getState()._nodeIndex.has(pageTwo[0])).toBe(true)
    await waitFor(() => expect(mockProvider.getEdges).toHaveBeenCalled())

    // Removed while the prime was out — as a sort flip's refetch does.
    act(() => { useCanvasStore.getState().removeNodes(pageTwo) })
    await act(async () => {
      release()
      await new Promise(r => setTimeout(r, 0))
    })

    const dangling = useCanvasStore.getState().edges.filter(e => pageTwo.includes(e.source) || pageTwo.includes(e.target))
    expect(dangling).toEqual([])
  })
})
