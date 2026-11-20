import { renderHook, waitFor } from '@testing-library/react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { describe, it, expect, vi, beforeEach } from 'vitest'

vi.mock('@/services/viewApiService', () => ({
  listViews: vi.fn(),
  favouriteView: vi.fn().mockResolvedValue({}),
  unfavouriteView: vi.fn().mockResolvedValue({}),
}))

import { listViews, type View, type ViewListParams } from '@/services/viewApiService'
import { useExplorerViews, type ExplorerFilters } from '../useExplorerViews'

const mockListViews = vi.mocked(listViews)

const ENVELOPE = { items: [], total: 0, hasMore: false, nextOffset: null, popular: [] }

function baseFilters(overrides: Partial<ExplorerFilters> = {}): ExplorerFilters {
  return {
    search: '', visibility: null, workspaceIds: [], dataSourceId: null,
    viewTypes: [], tags: [], contributorIds: [], contributorRole: null,
    sourceKind: null, createdAfter: null, createdBefore: null,
    updatedAfter: null, updatedBefore: null, sort: 'recently-modified',
    favouritedOnly: false, category: null, currentUserId: 'u1',
    limit: 24, offset: 0, ...overrides,
  }
}

function makeWrapper() {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  return function Wrapper({ children }: { children: React.ReactNode }) {
    return <QueryClientProvider client={qc}>{children}</QueryClientProvider>
  }
}

describe('useExplorerViews — filter/sort refetch', () => {
  beforeEach(() => {
    mockListViews.mockReset()
    mockListViews.mockResolvedValue(ENVELOPE as never)
  })

  it('refetches with the new sort when the sort filter changes', async () => {
    const { rerender } = renderHook(({ filters }) => useExplorerViews(filters), {
      wrapper: makeWrapper(),
      initialProps: { filters: baseFilters({ sort: 'recently-modified' }) },
    })

    await waitFor(() => expect(mockListViews).toHaveBeenCalled())
    expect(mockListViews).toHaveBeenLastCalledWith(
      expect.objectContaining({ sort: 'recently-modified' }),
      expect.anything(),
    )

    mockListViews.mockClear()
    rerender({ filters: baseFilters({ sort: 'newest' }) })

    await waitFor(() => expect(mockListViews).toHaveBeenCalled())
    expect(mockListViews).toHaveBeenLastCalledWith(
      expect.objectContaining({ sort: 'newest' }),
      expect.anything(),
    )
  })

  it('surfaces the server response ORDER in views (az → za reorders)', async () => {
    const A = { id: 'a', name: 'Apple', favouriteCount: 0, updatedAt: '2026-01-01', viewType: 'graph' } as unknown as View
    const B = { id: 'b', name: 'Banana', favouriteCount: 0, updatedAt: '2026-01-01', viewType: 'graph' } as unknown as View
    mockListViews.mockImplementation((params?: ViewListParams) => {
      const items = params?.sort === 'za' ? [B, A] : [A, B]
      return Promise.resolve({ items, total: 2, hasMore: false, nextOffset: null, popular: [] })
    })

    const { result, rerender } = renderHook(({ filters }) => useExplorerViews(filters), {
      wrapper: makeWrapper(),
      initialProps: { filters: baseFilters({ sort: 'az' }) },
    })

    await waitFor(() => expect(result.current.views.map(v => v.id)).toEqual(['a', 'b']))

    rerender({ filters: baseFilters({ sort: 'za' }) })
    await waitFor(() => expect(result.current.views.map(v => v.id)).toEqual(['b', 'a']))
  })

  it('refetches with the new visibility when a filter changes', async () => {
    const { rerender } = renderHook(({ filters }) => useExplorerViews(filters), {
      wrapper: makeWrapper(),
      initialProps: { filters: baseFilters() },
    })

    await waitFor(() => expect(mockListViews).toHaveBeenCalled())
    mockListViews.mockClear()

    rerender({ filters: baseFilters({ visibility: 'private' }) })

    await waitFor(() => expect(mockListViews).toHaveBeenCalled())
    expect(mockListViews).toHaveBeenLastCalledWith(
      expect.objectContaining({ visibility: 'private' }),
      expect.anything(),
    )
  })
})

describe('useExplorerViews — shared-with-me is a server category', () => {
  beforeEach(() => {
    mockListViews.mockReset()
    mockListViews.mockResolvedValue(ENVELOPE as never)
  })

  it('sends category=shared-with-me and never the old visibilityIn fake', async () => {
    renderHook(({ filters }) => useExplorerViews(filters), {
      wrapper: makeWrapper(),
      initialProps: { filters: baseFilters({ category: 'shared-with-me' }) },
    })
    await waitFor(() => expect(mockListViews).toHaveBeenCalled())
    const params = mockListViews.mock.calls.at(-1)![0] as ViewListParams
    expect(params.category).toBe('shared-with-me')
    expect(params.visibilityIn).toBeUndefined()
  })
})

describe('useExplorerViews — source kind, dates and people reach the server', () => {
  beforeEach(() => {
    mockListViews.mockReset()
    mockListViews.mockResolvedValue(ENVELOPE as never)
  })

  it('sends the versioned filter, the date bounds and the people with their role', async () => {
    renderHook(({ filters }) => useExplorerViews(filters), {
      wrapper: makeWrapper(),
      initialProps: {
        filters: baseFilters({
          sourceKind: 'versioned',
          updatedAfter: '2026-10-05T22:00:00.000Z',
          updatedBefore: '2026-10-12T22:00:00.000Z',
          contributorIds: ['u2', 'u3'],
          contributorRole: 'edited',
        }),
      },
    })
    await waitFor(() => expect(mockListViews).toHaveBeenCalled())
    const params = mockListViews.mock.calls.at(-1)![0] as ViewListParams
    expect(params).toMatchObject({
      sourceKind: 'versioned',
      updatedAfter: '2026-10-05T22:00:00.000Z',
      updatedBefore: '2026-10-12T22:00:00.000Z',
      contributorIn: ['u2', 'u3'],
      contributorRole: 'edited',
    })
    // The People filter is its own param; the old creator list stays unused.
    expect(params.createdByIn).toBeUndefined()
  })

  it('keeps the LATER created bound when Recent and a created date are both on', async () => {
    // Recent alone means "the past 7 days"; a created rule from 2 days ago is
    // narrower and must win. Before, Recent's cutoff silently replaced it.
    const twoDaysAgo = new Date(Date.now() - 2 * 86_400_000).toISOString()
    renderHook(({ filters }) => useExplorerViews(filters), {
      wrapper: makeWrapper(),
      initialProps: { filters: baseFilters({ category: 'recently-added', createdAfter: twoDaysAgo }) },
    })
    await waitFor(() => expect(mockListViews).toHaveBeenCalled())
    const params = mockListViews.mock.calls.at(-1)![0] as ViewListParams
    expect(params.createdAfter).toBe(twoDaysAgo)
  })

  it('sends no role when nobody is picked', async () => {
    renderHook(({ filters }) => useExplorerViews(filters), {
      wrapper: makeWrapper(),
      initialProps: { filters: baseFilters({ contributorRole: 'published' }) },
    })
    await waitFor(() => expect(mockListViews).toHaveBeenCalled())
    const params = mockListViews.mock.calls.at(-1)![0] as ViewListParams
    expect(params.contributorIn).toBeUndefined()
    expect(params.contributorRole).toBeUndefined()
  })
})

describe('useExplorerViews — removing a view', () => {
  beforeEach(() => mockListViews.mockReset())

  it('lowers the list total whichever page held the view', async () => {
    const v = (id: string) => ({ id, name: id, favouriteCount: 0, updatedAt: '2026-01-01', viewType: 'graph' }) as unknown as View
    mockListViews.mockImplementation((params?: ViewListParams) => Promise.resolve(
      (params?.offset ?? 0) === 0
        ? { items: [v('p1a'), v('p1b')], total: 4, hasMore: true, nextOffset: 2, popular: [] }
        : { items: [v('p2a'), v('p2b')], total: 4, hasMore: false, nextOffset: null, popular: [] },
    ))
    const { result } = renderHook(() => useExplorerViews(baseFilters({ limit: 2 })), { wrapper: makeWrapper() })
    await waitFor(() => expect(result.current.views).toHaveLength(2))
    result.current.loadMore()
    await waitFor(() => expect(result.current.views).toHaveLength(4))

    result.current.removeView('p2a')

    await waitFor(() => expect(result.current.views).toHaveLength(3))
    expect(result.current.totalCount).toBe(3)
  })
})

describe('useExplorerViews — a favourite', () => {
  it('marks the other lists stale, so Favorites is fresh when opened next', async () => {
    mockListViews.mockReset()
    const v = { id: 'v1', name: 'v1', favouriteCount: 0, isFavourited: false, updatedAt: '2026-01-01', viewType: 'graph' } as unknown as View
    mockListViews.mockResolvedValue({ items: [v], total: 1, hasMore: false, nextOffset: null, popular: [] } as never)
    const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } })
    qc.setQueryData(['explorer-views', { category: 'my-favourites' }], { pages: [], pageParams: [] })
    const wrapper = ({ children }: { children: React.ReactNode }) => <QueryClientProvider client={qc}>{children}</QueryClientProvider>
    const { result } = renderHook(() => useExplorerViews(baseFilters()), { wrapper })
    await waitFor(() => expect(result.current.views).toHaveLength(1))

    result.current.toggleFavourite('v1')

    await waitFor(() => expect(qc.getQueryState(['explorer-views', { category: 'my-favourites' }])?.isInvalidated).toBe(true))
  })
})

describe('useExplorerViews — a page that fails', () => {
  it('waits for Retry instead of asking again on its own', async () => {
    mockListViews.mockReset()
    const v = (id: string) => ({ id, name: id, favouriteCount: 0, updatedAt: '2026-01-01', viewType: 'graph' }) as unknown as View
    mockListViews.mockImplementation((params?: ViewListParams) => (params?.offset ?? 0) === 0
      ? Promise.resolve({ items: [v('a')], total: 2, hasMore: true, nextOffset: 1, popular: [] })
      : Promise.reject(new Error('boom')))
    const { result } = renderHook(() => useExplorerViews(baseFilters({ limit: 1 })), { wrapper: makeWrapper() })
    await waitFor(() => expect(result.current.views).toHaveLength(1))

    result.current.loadMore()
    await waitFor(() => expect(result.current.loadMoreFailed).toBe(true))
    const asked = mockListViews.mock.calls.length
    result.current.loadMore()
    expect(mockListViews.mock.calls.length).toBe(asked)

    mockListViews.mockImplementation(() => Promise.resolve({ items: [v('b')], total: 2, hasMore: false, nextOffset: null, popular: [] }))
    result.current.retryLoadMore()
    await waitFor(() => expect(result.current.views.map(x => x.id)).toEqual(['a', 'b']))
    expect(result.current.loadMoreFailed).toBe(false)
  })
})
