/**
 * A list or subset view's layer pages for as long as the server has rows — no 5,000 stop.
 *
 * Pinned here:
 *  - a layer pages past 5,000 rows, its first page the server's default and every page after
 *    it 500 rows, never capped;
 *  - an older server that refuses `limit` (a subset feed's `extra_forbidden`, a member feed's
 *    most) is asked again without it, once, and remembered — the layer never fails for it;
 *  - a layer whose page failed is said in the store (`feedFailures`), whichever instance
 *    asked, and its next page clears it; one whose FIRST page failed is listed with no rows,
 *    and its Retry asks that page again;
 *  - pages that land within 250 ms of the last write are written in one.
 */
import { act, renderHook, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import type { FeedNode, ViewFeedPage } from '@/types/searchView'

const { mockProvider, viewState } = vi.hoisted(() => ({
  mockProvider: {
    getNodes: vi.fn(async () => []),
    getNodesPage: vi.fn(async () => ({ nodes: [], hasMore: false, nextOffset: 0, totalCount: 0 })),
    getEdges: vi.fn(async () => []),
    getEdgesBetween: vi.fn(async () => []),
    getChildren: vi.fn(async () => []),
    getChildrenWithEdges: vi.fn(async () => ({
      children: [], containmentEdges: [], lineageEdges: [], totalChildren: 0, hasMore: false, nextOffset: 0,
    })),
    viewFeedPage: vi.fn(),
    viewMembersPage: vi.fn(),
  },
  viewState: { kind: 'members' as 'members' | 'subset' },
}))

vi.mock('@/providers/GraphProviderContext', () => ({
  useGraphProvider: () => mockProvider,
  useGraphProviderContext: () => ({ providerVersion: 1 }),
}))
vi.mock('@/hooks/useViewSchema', () => ({
  useViewContainmentEdgeTypes: () => ['CONTAINS'],
  useViewLineageEdgeTypes: () => ['FLOWS_TO'],
  useViewRootEntityTypes: () => ['table'],
  useViewEntityTypes: () => [{ id: 'table', hierarchy: { canBeContainedBy: [], canContain: [] } }],
  useViewSchemaIsReady: () => true,
}))
vi.mock('@/store/schema', () => ({
  useActiveView: () => ({
    id: viewState.kind === 'members' ? 'v-members' : 'v-subset',
    ...(viewState.kind === 'members'
      ? { membership: { v: 1, mode: 'live', sources: [], layout: { kind: 'stages' }, exclude: [], overrides: {}, provenance: { origin: 'trace' } } }
      : { search: { predicate: { kind: 'group', op: 'and', children: [] } } }),
    layout: {
      type: 'reference',
      referenceLayout: { layers: [{ id: 'up', name: 'Sources' }, { id: 'down', name: 'Consumers' }], assignments: {} },
    },
    content: { visibleEntityTypes: ['table'], entityScope: 'curated' },
  }),
  isContainmentEdgeType: (edgeType: string, types: string[]) => types.some((t) => t.toUpperCase() === edgeType.toUpperCase()),
  normalizeEdgeType: (e: { data?: { edgeType?: string } }) => (e.data?.edgeType || '').toUpperCase(),
}))
vi.mock('@/config/polling', () => ({
  POLLING_INTERVALS: { providerRetry: 10, providerRetrySlow: 20 },
  PROVIDER_RETRY_MAX_ATTEMPTS: 1,
  withJitter: (ms: number) => ms,
}))

import { forgetRefusedPageLimits, useGraphHydration } from '../useGraphHydration'
import { FEED_LANDING_MS, useCanvasStore } from '@/store/canvas'
import { useFeaturesStore } from '@/store/features'

const node = (urn: string) => ({ urn, entityType: 'table', displayName: urn }) as unknown as FeedNode
const rows = (from: number, n: number) => Array.from({ length: n }, (_, i) => node(`urn:r${from + i}`))

function page(layerId: string, over: Partial<ViewFeedPage>): ViewFeedPage {
  return {
    layerId, nodes: [], cursor: null, totalCount: 0, countStatus: 'exact', status: 'complete',
    sessionId: null, stale: false, asOf: null, capped: false, delivered: 0, dataVersion: null, ...over,
  }
}

const feed = (layerId: string) => useCanvasStore.getState().typeFeeds[`layer:${layerId}`]
const refusal = (body: string) => Object.assign(new Error(`API Error 422: ${body}`), { status: 422 })

/** The hydrating instance, settled; then the canvas's own, which pages its columns. */
async function hydrate(settled: () => void = () => expect(hydrating().result.current.hydrationStatus).toBe('ready')) {
  current = renderHook(() => useGraphHydration({ hydrate: true }))
  await waitFor(settled)
  return renderHook(() => useGraphHydration())
}
let current: ReturnType<typeof renderHook<ReturnType<typeof useGraphHydration>, unknown>> | null = null
const hydrating = () => current!

/** Past the landing window, so each page is written as it lands (they are timed apart). */
const later = () => { vi.setSystemTime(Date.now() + FEED_LANDING_MS + 1) }

describe('list and subset layers page to their end', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    vi.useFakeTimers({ toFake: ['Date'] })
    forgetRefusedPageLimits()
    viewState.kind = 'members'
    useFeaturesStore.setState((s) => ({ values: { ...s.values, viewMembershipEnabled: true, searchViewsEnabled: true } }))
    useCanvasStore.getState().setGraph([], [])
  })
  afterEach(() => { vi.useRealTimers() })

  it('a list view’s layer pages past 5,000 rows, 500 a page after its first, never capped', async () => {
    const TOTAL = 6_200
    mockProvider.viewMembersPage.mockImplementation(async (_v: string, req: { layerId: string; cursor?: string; limit?: number }) => {
      if (req.layerId === 'down') return page('down', {})
      const at = req.cursor ? Number(req.cursor) : 0
      const n = Math.min(req.limit ?? 200, TOTAL - at)
      const next = at + n
      return page('up', { nodes: rows(at, n), delivered: next, totalCount: TOTAL, cursor: next < TOTAL ? String(next) : null })
    })
    const canvas = await hydrate()
    expect(mockProvider.viewMembersPage).toHaveBeenCalledWith('v-members', { layerId: 'up' })
    expect(feed('up')).toMatchObject({ hasMore: true, search: { delivered: 200 } })
    for (let i = 0; i < 20 && feed('up')?.hasMore; i++) {
      later()
      await act(async () => { await canvas.result.current.loadMoreFeeds(['layer:up']) })
    }
    expect(feed('up')).toMatchObject({ hasMore: false, total: TOTAL, search: { delivered: TOTAL, capped: false } })
    expect(useCanvasStore.getState().nodes).toHaveLength(TOTAL)
    const continued = mockProvider.viewMembersPage.mock.calls.filter(([, req]) => req.layerId === 'up' && req.cursor)
    expect(continued).toHaveLength(12)
    expect(continued.every(([, req]) => req.limit === 500)).toBe(true)
    expect(useCanvasStore.getState().nodes.every((n) => n.data.feedLayerId === 'up')).toBe(true)
  })

  it('an older subset feed that refuses `limit` is asked again without it — and never again with it', async () => {
    viewState.kind = 'subset'
    let pages = 0
    mockProvider.viewFeedPage.mockImplementation(async (_v: string, req: { layerId: string; cursor?: string; limit?: number }) => {
      if (req.layerId === 'down') return page('down', {})
      if (req.limit !== undefined) throw refusal('{"detail":[{"type":"extra_forbidden","loc":["body","limit"],"msg":"Extra inputs are not permitted"}]}')
      pages += 1
      return page('up', { nodes: rows(pages * 10, 10), delivered: pages * 10, totalCount: 100, cursor: `c${pages}` })
    })
    const canvas = await hydrate()
    later()
    await act(async () => { await canvas.result.current.loadMoreFeeds(['layer:up']) })
    expect(feed('up').search?.delivered).toBe(20)
    const cont = mockProvider.viewFeedPage.mock.calls.filter(([, req]) => req.layerId === 'up' && req.cursor)
    expect(cont.map(([, req]) => req.limit)).toEqual([500, undefined])
    later()
    await act(async () => { await canvas.result.current.loadMoreFeeds(['layer:up']) })
    const after = mockProvider.viewFeedPage.mock.calls.filter(([, req]) => req.layerId === 'up' && req.cursor)
    expect(after.map(([, req]) => req.limit)).toEqual([500, undefined, undefined])
    expect(useCanvasStore.getState().feedFailures['layer:up']).toBeUndefined()
  })

  it('an older member feed that refuses the number is asked again without it', async () => {
    mockProvider.viewMembersPage.mockImplementation(async (_v: string, req: { layerId: string; cursor?: string; limit?: number }) => {
      if (req.layerId === 'down') return page('down', {})
      if (req.limit !== undefined && req.limit > 200) throw refusal('{"detail":[{"type":"less_than_equal","loc":["body","limit"]}]}')
      return page('up', { nodes: rows(req.cursor ? 1 : 0, 1), delivered: req.cursor ? 2 : 1, totalCount: 2, cursor: req.cursor ? null : 'c1' })
    })
    const canvas = await hydrate()
    later()
    await act(async () => { await canvas.result.current.loadMoreFeeds(['layer:up']) })
    expect(feed('up')).toMatchObject({ hasMore: false, search: { delivered: 2 } })
    expect(mockProvider.viewMembersPage).toHaveBeenLastCalledWith('v-members', { layerId: 'up', cursor: 'c1' })
  })

  it('a layer whose page failed says so in the store; its next page clears it', async () => {
    let busy = true
    mockProvider.viewMembersPage.mockImplementation(async (_v: string, req: { layerId: string; cursor?: string }) => {
      if (req.layerId === 'down') return page('down', {})
      if (req.cursor && busy) throw Object.assign(new Error('API Error 503: busy'), { status: 503 })
      return page('up', { nodes: rows(req.cursor ? 1 : 0, 1), delivered: req.cursor ? 2 : 1, totalCount: 2, cursor: req.cursor ? null : 'c1' })
    })
    const canvas = await hydrate()
    later()
    await act(async () => { await canvas.result.current.loadMoreFeeds(['layer:up']) })
    expect(useCanvasStore.getState().feedFailures['layer:up']).toEqual({ message: 'The server is busy right now.', status: 503 })
    busy = false
    later()
    await act(async () => { await canvas.result.current.loadMoreFeeds(['layer:up']) })
    expect(useCanvasStore.getState().feedFailures['layer:up']).toBeUndefined()
    expect(feed('up').search?.delivered).toBe(2)
  })

  it('a layer whose first page failed is listed with no rows, and its Retry asks that page again', async () => {
    let failing = true
    mockProvider.viewMembersPage.mockImplementation(async (_v: string, req: { layerId: string }) => {
      if (req.layerId === 'down') {
        if (failing) throw Object.assign(new Error('API Error 500: boom'), { status: 500 })
        return page('down', { nodes: rows(900, 1), delivered: 1, totalCount: 1 })
      }
      return page('up', { nodes: rows(0, 1), delivered: 1, totalCount: 1 })
    })
    // A partial load: once it stops retrying on its own, the layer waits for its Retry.
    const canvas = await hydrate(() => expect(hydrating().result.current.autoRetryStopped).toBe(true))
    expect(useCanvasStore.getState().feedFailures['layer:down']).toEqual({ message: 'The server couldn’t list this layer.', status: 500 })
    expect(feed('down')).toMatchObject({ hasMore: true, search: { delivered: 0, cursor: null, source: 'members' } })
    expect(useCanvasStore.getState().nodes.map((n) => n.id)).toEqual(['urn:r0'])
    failing = false
    later()
    await act(async () => { await canvas.result.current.loadMoreFeeds(['layer:down']) })
    await waitFor(() => expect(useCanvasStore.getState().feedFailures['layer:down']).toBeUndefined())
    expect(mockProvider.viewMembersPage).toHaveBeenCalledWith('v-members', { layerId: 'down', limit: 500 })
    expect(useCanvasStore.getState().nodes.map((n) => n.id).sort()).toEqual(['urn:r0', 'urn:r900'])
  })

  it('pages that land within 250 ms of the last write are written in one', async () => {
    mockProvider.viewMembersPage.mockImplementation(async (_v: string, req: { layerId: string; cursor?: string }) => {
      const at = req.cursor?.length ?? 0
      return page(req.layerId, {
        nodes: rows((req.layerId === 'up' ? 0 : 500) + at, 1), delivered: at + 1, totalCount: 9, cursor: `${req.cursor ?? ''}c`,
      })
    })
    const canvas = await hydrate()
    const writes: number[] = []
    const stop = useCanvasStore.subscribe((s, prev) => { if (s.nodes !== prev.nodes) writes.push(s.nodes.length) })
    later()
    // Written at once: nothing landed for a while.
    await act(async () => { await canvas.result.current.loadMoreFeeds(['layer:up']) })
    expect(writes).toEqual([3])
    // Two layers' pages, within the window: one write — once it has passed.
    vi.useRealTimers()
    await act(async () => { await canvas.result.current.loadMoreFeeds(['layer:up', 'layer:down']) })
    stop()
    expect(writes).toEqual([3, 5])
    expect(feed('up').search?.delivered).toBe(3)
    expect(feed('down').search?.delivered).toBe(2)
  })
})
