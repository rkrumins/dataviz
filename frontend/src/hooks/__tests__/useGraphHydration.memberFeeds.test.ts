/**
 * Views made from a query: each layer lists its members, paged by the server
 * from the view's member table.
 *
 * A view of a quarter of a million members cannot load every URN: it opens on
 * a page a layer, and each column pages on as it scrolls. Pinned here:
 *  - hydration asks the member feed once per layer and never pages a type;
 *  - what people placed by hand (Always include) still loads by URN;
 *  - a layer pages on by the server's cursor, each row keeping its layer;
 *  - with the preview off a view keeps the members it last had.
 */
import { act, renderHook, waitFor } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'

import type { FeedNode, ViewFeedPage } from '@/types/searchView'

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
    viewMembersPage: vi.fn(),
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
    id: 'v-members',
    membership: { v: 1, mode: 'live', sources: [], layout: { kind: 'stages' }, exclude: [], overrides: {}, provenance: { origin: 'trace' } },
    layout: {
      type: 'reference',
      referenceLayout: {
        layers: [
          { id: 'up', name: 'Sources' },
          { id: 'down', name: 'Consumers' },
        ],
        // Placed by hand: Always include.
        assignments: { 'urn:kept': { layerId: 'down' } },
      },
    },
    content: { visibleEntityTypes: ['table', 'column'], entityScope: 'curated' },
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
    layerId, nodes: [], cursor: null, totalCount: 0, countStatus: 'exact', status: 'complete',
    sessionId: null, stale: false, asOf: null, capped: false, delivered: 0, dataVersion: null, ...over,
  }
}

const urns = () => useCanvasStore.getState().nodes.map((n) => n.id).sort()
const feed = (layerId: string) => useCanvasStore.getState().typeFeeds[`layer:${layerId}`]

async function hydrate() {
  const hydrating = renderHook(() => useGraphHydration({ hydrate: true }))
  await waitFor(() => expect(hydrating.result.current.hydrationStatus).toBe('ready'))
  return renderHook(() => useGraphHydration())
}

describe('member feeds', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    useFeaturesStore.setState((s) => ({ values: { ...s.values, viewMembershipEnabled: true } }))
    useCanvasStore.getState().setGraph([], [])
    mockProvider.getNodes.mockImplementation((async (q: { urns?: string[] }) => (q.urns ?? []).map(u => node(u))) as never)
    mockProvider.viewMembersPage.mockImplementation(async (_v: string, req: { layerId: string; cursor?: string }) => {
      if (req.layerId === 'up') {
        return req.cursor === 'c-1'
          ? page('up', { nodes: [node('urn:u3')], delivered: 3, totalCount: 3 })
          : page('up', { nodes: [node('urn:u1'), node('urn:u2')], cursor: 'c-1', delivered: 2, totalCount: 3 })
      }
      return page('down', { nodes: [node('urn:d1')], delivered: 1, totalCount: 1 })
    })
  })

  it('opens on a page a layer, plus what people placed by hand — never every member', async () => {
    await hydrate()
    expect(mockProvider.viewMembersPage).toHaveBeenCalledTimes(2)
    expect(mockProvider.viewMembersPage).toHaveBeenCalledWith('v-members', { layerId: 'up' })
    expect(mockProvider.getNodesPage).not.toHaveBeenCalled()
    expect(mockProvider.getNodes).toHaveBeenCalledWith({ urns: ['urn:kept'], limit: 1 })
    expect(urns()).toEqual(['urn:d1', 'urn:kept', 'urn:u1', 'urn:u2'])
    expect(feed('up')).toMatchObject({ hasMore: true, total: 3, search: { source: 'members', cursor: 'c-1', delivered: 2 } })
  })

  it('a column pages on by the server’s cursor, each row keeping its layer', async () => {
    const canvas = await hydrate()
    await act(async () => { await canvas.result.current.loadMoreFeeds(['layer:up']) })
    expect(mockProvider.viewMembersPage).toHaveBeenLastCalledWith('v-members', { layerId: 'up', cursor: 'c-1' })
    expect(mockProvider.viewFeedPage).not.toHaveBeenCalled()
    const layerOf = Object.fromEntries(useCanvasStore.getState().nodes.map((n) => [n.id, n.data.feedLayerId]))
    expect(layerOf).toMatchObject({ 'urn:u1': 'up', 'urn:u3': 'up', 'urn:d1': 'down' })
    expect(feed('up')).toMatchObject({ hasMore: false, search: { delivered: 3 } })
  })

  it('an update that lands swaps its pages in place: never a blank canvas, and what left goes', async () => {
    const hydrating = renderHook(() => useGraphHydration({ hydrate: true }))
    await waitFor(() => expect(hydrating.result.current.hydrationStatus).toBe('ready'))
    expect(urns()).toEqual(['urn:d1', 'urn:kept', 'urn:u1', 'urn:u2'])
    // u2 left the view; u4 arrived.
    mockProvider.viewMembersPage.mockImplementation(async (_v: string, req: { layerId: string }) => (req.layerId === 'up'
      ? page('up', { nodes: [node('urn:u1'), node('urn:u4')], delivered: 2, totalCount: 2 })
      : page('down', { nodes: [node('urn:d1')], delivered: 1, totalCount: 1 })))
    const sizes: number[] = []
    const unsubscribe = useCanvasStore.subscribe((st) => sizes.push(st.nodes.length))
    await act(async () => { useCanvasStore.getState().refreshSubsetFeeds() })
    await waitFor(() => expect(urns()).toEqual(['urn:d1', 'urn:kept', 'urn:u1', 'urn:u4']))
    unsubscribe()
    expect(sizes.every((n) => n > 0)).toBe(true)
  })

  it('with the preview off it still shows the members it last had', async () => {
    useFeaturesStore.setState((s) => ({ values: { ...s.values, viewMembershipEnabled: false } }))
    await hydrate()
    expect(mockProvider.viewMembersPage).toHaveBeenCalledTimes(2)
    expect(urns()).toEqual(['urn:d1', 'urn:kept', 'urn:u1', 'urn:u2'])
  })
})
