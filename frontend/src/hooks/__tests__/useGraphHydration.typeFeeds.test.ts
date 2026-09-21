/**
 * Open ('all') views: each visible type is a lossless feed, and explicit
 * placements always load.
 *
 * An open view used to load the first 200 entities of each type and stop —
 * no continuation, no signal. And it only PLACED assigned entities, never
 * fetched them: an anchor or hand-placed entity that sorted past that first
 * page was simply absent, and its column came up empty.
 *
 * Pinned here:
 *  - hydration records a feed per type from its first page, positioned where
 *    the SERVER said the next page starts;
 *  - an explicit placement beyond the first page is fetched by URN;
 *  - loadMoreFeeds reads each page at the server's position and walks the type
 *    to exhaustion with every entity exactly once — even when the server
 *    returns fewer rows than it consumed (a draft that deleted some), which a
 *    client count would turn into repeats and an early stop;
 *  - a failed page is reported and retried from the same position;
 *  - the page's lineage is read with two ANCHORED queries (out of / into the
 *    page) — the one-query form scans every lineage edge in the graph.
 */
import { act, renderHook, waitFor } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'

const TOTAL = 450
const urn = (i: number) => `urn:t:${String(i).padStart(4, '0')}`
const ANCHOR = urn(440)          // sorts far past the first page of 200

const { mockProvider, calls } = vi.hoisted(() => ({
  mockProvider: {
    getNodes: vi.fn(),
    getNodesPage: vi.fn(),
    getEdges: vi.fn(async () => []),
    getEdgesBetween: vi.fn(async () => []),
    getChildren: vi.fn(async () => []),
    getChildrenWithEdges: vi.fn(async () => ({
      children: [], containmentEdges: [], lineageEdges: [], totalChildren: 0, hasMore: false, nextOffset: 0,
    })),
  },
  calls: [] as Array<Record<string, unknown>>,
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
  useActiveView: () => ({
    id: 'v-open',
    layout: {
      type: 'reference',
      referenceLayout: {
        layers: [{ id: 'L1', name: 'Domains', entityTypes: ['domain'] }],
        assignments: { [ANCHOR]: { layerId: 'L1' } },
      },
    },
    content: { visibleEntityTypes: ['domain'], entityScope: 'all' },
  }),
  isContainmentEdgeType: (edgeType: string, types: string[]) =>
    types.some((t) => t.toUpperCase() === edgeType.toUpperCase()),
  normalizeEdgeType: (e: { data?: { edgeType?: string } }) => (e.data?.edgeType || '').toUpperCase(),
}))
vi.mock('@/config/polling', () => ({
  POLLING_INTERVALS: { providerRetry: 10, providerRetrySlow: 20 },
  PROVIDER_RETRY_MAX_ATTEMPTS: 1,
  withJitter: (ms: number) => ms,
}))

import { useGraphHydration, feedAfter } from '../useGraphHydration'
import { useCanvasStore } from '@/store/canvas'

const all = Array.from({ length: TOTAL }, (_, i) => ({ urn: urn(i), entityType: 'domain', displayName: `d${String(i).padStart(4, '0')}` }))

/** The server: `domain` rows in its own order, read by offset, reporting where
 *  the next page starts. `hide` drops rows from what it returns WITHOUT moving
 *  the position (a draft that deleted them); `failAt` fails that page once. */
function serve({ hide = new Set<number>(), failAt }: { hide?: Set<number>; failAt?: number } = {}) {
  let failed = false
  mockProvider.getNodes.mockImplementation(async (q: { urns?: string[] }) =>
    all.filter(n => q.urns?.includes(n.urn)))
  mockProvider.getNodesPage.mockImplementation(async (q: { limit?: number; offset?: number }) => {
    calls.push({ ...q })
    const start = q.offset ?? 0
    if (failAt === start && !failed) { failed = true; throw new Error('503') }
    const read = all.slice(start, start + (q.limit ?? 100))
    return {
      nodes: read.filter((_, k) => !hide.has(start + k)),
      hasMore: start + read.length < TOTAL,
      nextOffset: start + read.length,
    }
  })
}

const domains = () => useCanvasStore.getState().nodes.map(n => n.id)

async function hydrate() {
  const hydrating = renderHook(() => useGraphHydration({ hydrate: true }))
  await waitFor(() => expect(hydrating.result.current.hydrationStatus).toBe('ready'))
  return renderHook(() => useGraphHydration())   // the canvas's own instance, as in the app
}

describe('open-scope type feeds', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    calls.length = 0
    useCanvasStore.getState().setGraph([], [])
  })

  it('records a feed per type and fetches a far-sorting placement by URN', async () => {
    serve()
    await hydrate()
    expect(useCanvasStore.getState().typeFeeds.domain).toMatchObject({ offset: 200, hasMore: true })
    expect(domains()).toContain(ANCHOR)
    expect(mockProvider.getNodes.mock.calls.some(c => (c[0] as { urns?: string[] }).urns?.includes(ANCHOR))).toBe(true)
  })

  it('walks the type to exhaustion at the server position, each entity once', async () => {
    serve()
    const canvas = await hydrate()
    await act(async () => { await canvas.result.current.loadMoreFeeds(['domain']) })
    expect(calls.at(-1)).toMatchObject({ offset: 200 })
    await act(async () => { await canvas.result.current.loadMoreFeeds(['domain']) })
    await act(async () => { await canvas.result.current.loadMoreFeeds(['domain']) })   // exhausted: no call
    const got = domains()
    expect(got).toHaveLength(TOTAL)
    expect(new Set(got).size).toBe(TOTAL)
    expect(calls).toHaveLength(3)
    expect(useCanvasStore.getState().typeFeeds.domain.hasMore).toBe(false)
  })

  it('neither repeats nor stops early when a page returns fewer rows than it read', async () => {
    // A draft deleted one row on each page: 199 come back, 200 were read.
    serve({ hide: new Set([10, 210, 410]) })
    const canvas = await hydrate()
    await act(async () => { await canvas.result.current.loadMoreFeeds(['domain']) })
    await act(async () => { await canvas.result.current.loadMoreFeeds(['domain']) })
    expect(calls.map(c => c.offset ?? 0)).toEqual([0, 200, 400])
    expect(domains()).toHaveLength(TOTAL - 3)       // every row the draft kept, once
    expect(useCanvasStore.getState().typeFeeds.domain.hasMore).toBe(false)
  })

  it('reports a failed page and retries it from the same position', async () => {
    serve({ failAt: 200 })
    const canvas = await hydrate()
    await act(async () => { await canvas.result.current.loadMoreFeeds(['domain']) })
    expect(canvas.result.current.failedNodes.has('TYPE:domain')).toBe(true)
    expect(useCanvasStore.getState().typeFeeds.domain.offset).toBe(200)

    await act(async () => { await canvas.result.current.loadMoreFeeds(['domain']) })
    expect(calls.at(-1)).toMatchObject({ offset: 200 })
    expect(canvas.result.current.failedNodes.has('TYPE:domain')).toBe(false)
    expect(domains().length).toBeGreaterThan(200)
  })

  it('reads on past a page whose rows are all held already — a click is never a no-op', async () => {
    serve()
    const canvas = await hydrate()
    // The next page's rows arrived another way (placements, a reveal).
    const held = all.slice(200, 400).map(n => ({ id: n.urn, position: { x: 0, y: 0 }, data: { label: n.urn, urn: n.urn, type: 'domain' } }))
    act(() => { useCanvasStore.getState().addGraph(held as never, []) })
    await act(async () => { await canvas.result.current.loadMoreFeeds(['domain']) })   // ONE ask
    expect(calls.map(c => c.offset ?? 0)).toEqual([0, 200, 400])
    expect(domains()).toContain(urn(449))
  })

  it('keeps ONE copy of a lineage edge that both page reads return', async () => {
    // An edge inside the page comes back from the read out of the page AND the
    // read into it; the store must still hold each edge id once.
    serve()
    const canvas = await hydrate()
    const inPage = { id: 'e-ab', sourceUrn: urn(210), targetUrn: urn(220), edgeType: 'FLOWS_TO' }
    mockProvider.getEdges.mockImplementation((async (q: { edgeTypes?: string[] }) =>
      (q.edgeTypes?.includes('FLOWS_TO') ? [inPage] : [])) as never)
    await act(async () => { await canvas.result.current.loadMoreFeeds(['domain']) })
    expect(useCanvasStore.getState().edges.filter(e => e.id === 'e-ab')).toHaveLength(1)
  })

  it("reads the page's lineage with anchored queries, never the scan-shaped one", async () => {
    serve()
    const canvas = await hydrate()
    await act(async () => { await canvas.result.current.loadMoreFeeds(['domain']) })
    const lineageQueries = (mockProvider.getEdges.mock.calls as unknown as unknown[][])
      .map(c => c[0] as { anyUrns?: string[]; sourceUrns?: string[]; targetUrns?: string[]; edgeTypes?: string[] })
      .filter(q => q.edgeTypes?.includes('FLOWS_TO'))
    expect(lineageQueries.some(q => q.anyUrns)).toBe(false)
    expect(lineageQueries.some(q => q.sourceUrns?.length)).toBe(true)
    expect(lineageQueries.some(q => q.targetUrns?.length)).toBe(true)
  })
})

describe('feedAfter', () => {
  it('ends a feed whose page says "more" but does not move', () => {
    expect(feedAfter(['t'], { nodes: [], hasMore: true, nextOffset: 200 }, 200).hasMore).toBe(false)
    expect(feedAfter(['t'], { nodes: [], hasMore: true, nextOffset: 400 }, 200)).toEqual(
      { entityTypes: ['t'], offset: 400, hasMore: true })
  })
})
