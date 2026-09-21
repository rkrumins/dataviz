/**
 * Hierarchy / Graph views: roots are a feed, and the first children page is
 * bounded, paged and honest.
 *
 * They used to load the first 200 roots and stop — nothing reachable past
 * them — and fetch every root's first 100 children in ONE unbounded burst
 * (a request per root, all at once: the backend sheds the tail with 429s),
 * swallowing each failure as "no children".
 *
 * Pinned here:
 *  - at most HYDRATION_CONCURRENCY child requests are ever in flight;
 *  - each root's pager is seeded, so expanding continues at page 2;
 *  - a failed first page is COUNTED (noteNodeFetchFailure), not hidden;
 *  - the roots feed is recorded and loadMoreFeeds(['__roots__']) continues it.
 */
import { act, renderHook, waitFor } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'

const ROOTS = 250
const root = (i: number) => `urn:h:r${String(i).padStart(3, '0')}`

const { mockProvider, inFlight } = vi.hoisted(() => ({
  mockProvider: {
    getNodes: vi.fn(),
    getEdges: vi.fn(async () => []),
    getEdgesBetween: vi.fn(async () => []),
    getChildren: vi.fn(async () => []),
    getChildrenWithEdges: vi.fn(),
  },
  inFlight: { now: 0, max: 0 },
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
    { id: 'domain', hierarchy: { canBeContainedBy: [], canContain: [] } },
  ],
  useViewSchemaIsReady: () => true,
}))
vi.mock('@/store/schema', () => ({
  useActiveView: () => ({ id: 'v-graph', layout: { type: 'graph' }, content: {} }),
  isContainmentEdgeType: (edgeType: string, types: string[]) =>
    types.some((t) => t.toUpperCase() === edgeType.toUpperCase()),
  normalizeEdgeType: (e: { data?: { edgeType?: string } }) => (e.data?.edgeType || '').toUpperCase(),
}))
vi.mock('@/config/polling', () => ({
  POLLING_INTERVALS: { providerRetry: 10, providerRetrySlow: 20 },
  PROVIDER_RETRY_MAX_ATTEMPTS: 1,
  withJitter: (ms: number) => ms,
}))

import { useGraphHydration } from '../useGraphHydration'
import { useCanvasStore } from '@/store/canvas'

function serveRoots() {
  return async (q: { limit?: number; offset?: number; afterUrn?: string }) => {
    const all = Array.from({ length: ROOTS }, (_, i) => ({
      urn: root(i), entityType: 'domain', displayName: `r${String(i).padStart(3, '0')}`, childCount: 150,
    }))
    const start = q.afterUrn ? all.findIndex(n => n.urn === q.afterUrn) + 1 : (q.offset ?? 0)
    return all.slice(start, start + (q.limit ?? 100))
  }
}

function serveChildren(failFor?: string) {
  return async (urn: string) => {
    inFlight.now += 1
    inFlight.max = Math.max(inFlight.max, inFlight.now)
    await new Promise(r => setTimeout(r, 1))
    inFlight.now -= 1
    if (urn === failFor) throw new Error('429')
    const kids = Array.from({ length: 100 }, (_, k) => ({ urn: `${urn}:c${k}`, entityType: 'system', displayName: `c${k}` }))
    return {
      children: kids, containmentEdges: [], lineageEdges: [],
      totalChildren: 150, hasMore: true, nextCursor: `after:${urn}:c99`,
    }
  }
}

describe('hierarchy/graph hydration', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    inFlight.now = 0
    inFlight.max = 0
    useCanvasStore.getState().setGraph([], [])
    useCanvasStore.getState().clearNodeFetchFailures()
    mockProvider.getNodes.mockImplementation(serveRoots() as never)
  })

  it('never has more than a handful of child requests in flight', async () => {
    mockProvider.getChildrenWithEdges.mockImplementation(serveChildren() as never)
    const { result } = renderHook(() => useGraphHydration({ hydrate: true }))
    await waitFor(() => expect(result.current.hydrationStatus).toBe('ready'))
    expect(mockProvider.getChildrenWithEdges).toHaveBeenCalledTimes(200)   // first page of roots
    expect(inFlight.max).toBeLessThanOrEqual(4)
    expect(mockProvider.getChildren).not.toHaveBeenCalled()
  })

  it("seeds each root's pager so expanding continues at page 2", async () => {
    mockProvider.getChildrenWithEdges.mockImplementation(serveChildren() as never)
    const { result } = renderHook(() => useGraphHydration({ hydrate: true }))
    await waitFor(() => expect(result.current.hydrationStatus).toBe('ready'))
    expect(useCanvasStore.getState().childPaging[root(0)]).toMatchObject({
      cursor: `after:${root(0)}:c99`, delivered: 100, hasMore: true,
    })
  })

  it('counts a failed first page instead of reading it as "no children"', async () => {
    mockProvider.getChildrenWithEdges.mockImplementation(serveChildren(root(7)) as never)
    const { result } = renderHook(() => useGraphHydration({ hydrate: true }))
    await waitFor(() => expect(result.current.hydrationStatus).toBe('ready'))
    expect(useCanvasStore.getState().nodeFetchFailures).toBe(1)
    expect(useCanvasStore.getState().childPaging[root(7)]).toBeUndefined()   // expanding retries
  })

  it('keeps the roots as a feed and continues it past the first page', async () => {
    mockProvider.getChildrenWithEdges.mockImplementation(serveChildren() as never)
    const hydrating = renderHook(() => useGraphHydration({ hydrate: true }))
    await waitFor(() => expect(hydrating.result.current.hydrationStatus).toBe('ready'))
    expect(useCanvasStore.getState().typeFeeds.__roots__).toMatchObject({ hasMore: true, offset: 200 })

    const canvas = renderHook(() => useGraphHydration())
    await act(async () => { await canvas.result.current.loadMoreFeeds(['__roots__']) })
    const ids = new Set(useCanvasStore.getState().nodes.map(n => n.id))
    for (let i = 0; i < ROOTS; i++) expect(ids.has(root(i))).toBe(true)
    expect(useCanvasStore.getState().typeFeeds.__roots__.hasMore).toBe(false)
  })
})
