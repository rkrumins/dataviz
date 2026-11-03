/**
 * Subset views: each layer lists its search's matches, paged by the server.
 *
 * A subset view's layers claim types like any open view's, so the type feeds
 * would list EVERY entity of those types — the whole base, not the matches.
 * Pinned here:
 *  - hydration asks the view feed once per layer, and never pages a type nor
 *    loads by URN;
 *  - a layer whose scan is still running is followed through its session until
 *    it completes, its rows landing once;
 *  - a complete layer pages on by the server's cursor;
 *  - with the preview off nothing is listed, and the canvas is told why; a
 *    deleted base says so too.
 */
import { act, renderHook, waitFor } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'

import type { FeedNode, ViewFeedPage, ViewFeedRequest } from '@/types/searchView'

const { mockProvider } = vi.hoisted(() => ({
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
  },
}))

vi.mock('@/providers/GraphProviderContext', () => ({
  useGraphProvider: () => mockProvider,
  useGraphProviderContext: () => ({ providerVersion: 1 }),
}))
vi.mock('@/hooks/useViewSchema', () => ({
  useViewContainmentEdgeTypes: () => ['CONTAINS'],
  useViewLineageEdgeTypes: () => ['FLOWS_TO'],
  useViewRootEntityTypes: () => ['table'],
  useViewEntityTypes: () => [
    { id: 'table', hierarchy: { canBeContainedBy: [], canContain: [] } },
    { id: 'column', hierarchy: { canBeContainedBy: [], canContain: [] } },
  ],
  useViewSchemaIsReady: () => true,
}))
vi.mock('@/store/schema', () => ({
  useActiveView: () => ({
    id: 'v-subset',
    search: {
      v: 1, predicate: { kind: 'tag', values: ['pii'] }, within: 'view', readIn: 'v-base', layout: 'inherit',
    },
    layout: {
      type: 'reference',
      referenceLayout: {
        layers: [
          { id: 'L1', name: 'Tables', entityTypes: ['table'] },
          { id: 'other-matches', name: 'Other matches', showUnassigned: true },
        ],
        assignments: {},
      },
    },
    content: { visibleEntityTypes: ['table', 'column'], entityScope: 'all' },
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

import { useGraphHydration } from '../useGraphHydration'
import { useCanvasStore } from '@/store/canvas'
import { useFeaturesStore } from '@/store/features'

const node = (urn: string, entityType = 'table') => ({ urn, entityType, displayName: urn }) as unknown as FeedNode

function page(layerId: string, over: Partial<ViewFeedPage>): ViewFeedPage {
  return {
    layerId, nodes: [], cursor: null, totalCount: null, countStatus: 'exact', status: 'complete',
    sessionId: null, stale: false, asOf: null, capped: false, delivered: 0, dataVersion: null, ...over,
  }
}

type Answer = (req: ViewFeedRequest) => ViewFeedPage
function serve(answers: Record<string, Answer>) {
  mockProvider.viewFeedPage.mockImplementation(async (_viewId: string, req: ViewFeedRequest) => answers[req.layerId](req))
}

const urns = () => useCanvasStore.getState().nodes.map((n) => n.id).sort()
const feed = (layerId: string) => useCanvasStore.getState().typeFeeds[`layer:${layerId}`]

async function hydrate() {
  const hydrating = renderHook(() => useGraphHydration({ hydrate: true }))
  await waitFor(() => expect(hydrating.result.current.hydrationStatus).toBe('ready'))
  return renderHook(() => useGraphHydration())   // the canvas's own instance, as in the app
}

describe('subset view feeds', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    useFeaturesStore.setState((s) => ({ values: { ...s.values, searchViewsEnabled: true } }))
    useCanvasStore.getState().setGraph([], [])
    useCanvasStore.getState().setSubsetIssue(null)
  })

  it('asks each layer its matches from the view search, never a type page or URNs', async () => {
    serve({
      L1: () => page('L1', { nodes: [node('urn:t1'), node('urn:t2')], delivered: 2, totalCount: 2 }),
      'other-matches': () => page('other-matches', { nodes: [node('urn:c1', 'column')], delivered: 1, totalCount: 1 }),
    })
    await hydrate()
    expect(mockProvider.viewFeedPage).toHaveBeenCalledTimes(2)
    expect(mockProvider.viewFeedPage).toHaveBeenCalledWith('v-subset', { layerId: 'L1', waitMs: 2500 })
    expect(mockProvider.viewFeedPage).toHaveBeenCalledWith('v-subset', { layerId: 'other-matches', waitMs: 2500 })
    expect(mockProvider.getNodesPage).not.toHaveBeenCalled()
    expect(mockProvider.getNodes).not.toHaveBeenCalled()
    expect(urns()).toEqual(['urn:c1', 'urn:t1', 'urn:t2'])
    expect(feed('L1')).toMatchObject({ hasMore: false, total: 2, search: { status: 'complete', delivered: 2 } })
  })

  it('follows a running scan through its session until it completes', async () => {
    serve({
      L1: (req) => req.sessionId
        ? page('L1', { nodes: [node('urn:t1'), node('urn:t2'), node('urn:t3')], delivered: 3, totalCount: 3 })
        : page('L1', { nodes: [node('urn:t1')], status: 'running', sessionId: 's-1', countStatus: 'lowerBound', delivered: 1 }),
      'other-matches': () => page('other-matches', {}),
    })
    await hydrate()
    await waitFor(() => expect(feed('L1')?.search?.status).toBe('complete'))
    expect(mockProvider.viewFeedPage).toHaveBeenCalledWith('v-subset', { layerId: 'L1', sessionId: 's-1', waitMs: 2500 })
    expect(urns()).toEqual(['urn:t1', 'urn:t2', 'urn:t3'])
    expect(feed('L1')).toMatchObject({ hasMore: false, total: 3, search: { delivered: 3, sessionId: null } })
  })

  it('pages a complete layer on by the server cursor', async () => {
    serve({
      L1: (req) => req.cursor === 'c-1'
        ? page('L1', { nodes: [node('urn:t3'), node('urn:t4')], delivered: 4, totalCount: 4 })
        : page('L1', { nodes: [node('urn:t1'), node('urn:t2')], cursor: 'c-1', delivered: 2, totalCount: 4 }),
      'other-matches': () => page('other-matches', {}),
    })
    const canvas = await hydrate()
    expect(feed('L1')).toMatchObject({ hasMore: true, search: { cursor: 'c-1' } })
    await act(async () => { await canvas.result.current.loadMoreFeeds(['layer:L1']) })
    expect(mockProvider.viewFeedPage).toHaveBeenLastCalledWith('v-subset', { layerId: 'L1', cursor: 'c-1', waitMs: 2500 })
    expect(urns()).toEqual(['urn:t1', 'urn:t2', 'urn:t3', 'urn:t4'])
    expect(feed('L1')).toMatchObject({ hasMore: false, search: { delivered: 4, cursor: null } })
  })

  it('with the preview off lists nothing and says why', async () => {
    useFeaturesStore.setState((s) => ({ values: { ...s.values, searchViewsEnabled: false } }))
    await hydrate()
    expect(mockProvider.viewFeedPage).not.toHaveBeenCalled()
    expect(mockProvider.getNodesPage).not.toHaveBeenCalled()
    expect(urns()).toEqual([])
    expect(useCanvasStore.getState().subsetIssue).toBe('off')
  })

  it('says so when its base view was deleted', async () => {
    const gone = Object.assign(new Error('409'), { status: 409, detail: { reason: 'base_missing' } })
    mockProvider.viewFeedPage.mockRejectedValue(gone)
    await hydrate()
    expect(useCanvasStore.getState().subsetIssue).toBe('base_missing')
    expect(mockProvider.getNodesPage).not.toHaveBeenCalled()
  })
})
