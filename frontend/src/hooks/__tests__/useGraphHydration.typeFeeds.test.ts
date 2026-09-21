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
 *  - hydration records a feed per type from its first page (hasMore when full);
 *  - an explicit placement beyond the first page is fetched by URN;
 *  - loadMoreFeeds continues from the page's MAXIMUM (displayName, urn) —
 *    carried with the server offset — and walks the type to exhaustion with
 *    every entity exactly once;
 *  - a failed page is reported and retried from the same position;
 *  - the maximum is taken in CODE-POINT order (the server's), so an astral
 *    character can't make it overshoot and skip rows.
 */
import { act, renderHook, waitFor } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'

const TOTAL = 450
const urn = (i: number) => `urn:t:${String(i).padStart(4, '0')}`
const ANCHOR = urn(440)          // sorts far past the first page of 200

const { mockProvider, calls } = vi.hoisted(() => ({
  mockProvider: {
    getNodes: vi.fn(),
    getEdges: vi.fn(async () => []),
    getEdgesBetween: vi.fn(async () => []),
    getChildren: vi.fn(async () => []),
    getChildrenWithEdges: vi.fn(async () => ({
      children: [], containmentEdges: [], lineageEdges: [], totalChildren: 0, hasMore: false, nextCursor: null,
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

import { useGraphHydration, nextTypeFeed } from '../useGraphHydration'
import { useCanvasStore } from '@/store/canvas'

/** The server: `domain` rows in (name, urn) order; seeks by keyset when given,
 *  else by offset; URN lookups answer by URN. Rows come back SHUFFLED within a
 *  page, as they may after an aggregating RETURN. */
function serveNodes(failAfterUrn?: string) {
  let failed = false
  return async (q: { urns?: string[]; entityTypes?: string[]; limit?: number; offset?: number; afterUrn?: string }) => {
    calls.push({ ...q })
    const all = Array.from({ length: TOTAL }, (_, i) => ({ urn: urn(i), entityType: 'domain', displayName: `d${String(i).padStart(4, '0')}` }))
    if (q.urns) return all.filter(n => q.urns!.includes(n.urn))
    if (failAfterUrn && q.afterUrn === failAfterUrn && !failed) { failed = true; throw new Error('503') }
    const start = q.afterUrn ? all.findIndex(n => n.urn === q.afterUrn) + 1 : (q.offset ?? 0)
    const page = all.slice(start, start + (q.limit ?? 100))
    return [...page].reverse()
  }
}

const domains = () => useCanvasStore.getState().nodes.map(n => n.id)

describe('open-scope type feeds', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    calls.length = 0
    useCanvasStore.getState().setGraph([], [])
  })

  it('records a feed per type and fetches a far-sorting placement by URN', async () => {
    mockProvider.getNodes.mockImplementation(serveNodes() as never)
    const { result } = renderHook(() => useGraphHydration({ hydrate: true }))
    await waitFor(() => expect(result.current.hydrationStatus).toBe('ready'))

    const feed = useCanvasStore.getState().typeFeeds.domain
    expect(feed).toMatchObject({ afterUrn: urn(199), offset: 200, hasMore: true })
    expect(domains()).toContain(ANCHOR)
    expect(calls.some(c => Array.isArray(c.urns) && (c.urns as string[]).includes(ANCHOR))).toBe(true)
  })

  it('walks the type to exhaustion, each entity once, carrying the page max and the offset', async () => {
    mockProvider.getNodes.mockImplementation(serveNodes() as never)
    const hydrating = renderHook(() => useGraphHydration({ hydrate: true }))
    await waitFor(() => expect(hydrating.result.current.hydrationStatus).toBe('ready'))

    const canvas = renderHook(() => useGraphHydration())
    await act(async () => { await canvas.result.current.loadMoreFeeds(['domain']) })
    const second = calls.at(-1)!
    expect(second).toMatchObject({ afterUrn: urn(199), afterDisplayName: 'd0199', offset: 200 })

    await act(async () => { await canvas.result.current.loadMoreFeeds(['domain']) })
    await act(async () => { await canvas.result.current.loadMoreFeeds(['domain']) })   // exhausted: no call
    const got = domains()
    expect(got).toHaveLength(TOTAL)
    expect(new Set(got).size).toBe(TOTAL)
    expect(useCanvasStore.getState().typeFeeds.domain.hasMore).toBe(false)
  })

  it('reports a failed page and retries it from the same position', async () => {
    mockProvider.getNodes.mockImplementation(serveNodes(urn(199)) as never)
    const hydrating = renderHook(() => useGraphHydration({ hydrate: true }))
    await waitFor(() => expect(hydrating.result.current.hydrationStatus).toBe('ready'))

    const canvas = renderHook(() => useGraphHydration())
    await act(async () => { await canvas.result.current.loadMoreFeeds(['domain']) })
    expect(canvas.result.current.failedNodes.has('TYPE:domain')).toBe(true)
    expect(useCanvasStore.getState().typeFeeds.domain.afterUrn).toBe(urn(199))

    await act(async () => { await canvas.result.current.loadMoreFeeds(['domain']) })
    expect(calls.at(-1)).toMatchObject({ afterUrn: urn(199), offset: 200 })
    expect(canvas.result.current.failedNodes.has('TYPE:domain')).toBe(false)
    expect(domains().length).toBeGreaterThan(200)
  })
})

describe('nextTypeFeed', () => {
  it('takes the maximum in code-point order, not UTF-16 order', () => {
    // U+FF5E (BMP, high) vs U+1F600 (astral). UTF-16 compares the astral
    // character's lead surrogate (0xD83D) and calls it SMALLER; by code point
    // (how the server compares) it is LARGER. Taking the UTF-16 max would put
    // the position at the BMP row and re-deliver — the reverse would skip.
    const page = [
      { urn: 'u1', entityType: 't', displayName: '～' },
      { urn: 'u2', entityType: 't', displayName: '\u{1F600}' },
    ]
    const feed = nextTypeFeed(null, page as never, 2, ['t'])
    expect(feed.afterUrn).toBe('u2')
    expect(feed.hasMore).toBe(true)
  })
})
