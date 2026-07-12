import { renderHook, waitFor } from '@testing-library/react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { describe, it, expect, vi, beforeEach } from 'vitest'

vi.mock('@/services/viewApiService', () => ({
  listViews: vi.fn(),
  favouriteView: vi.fn().mockResolvedValue({}),
  unfavouriteView: vi.fn().mockResolvedValue({}),
}))

import { listViews } from '@/services/viewApiService'
import { useExplorerViews, type ExplorerFilters } from '../useExplorerViews'

const mockListViews = vi.mocked(listViews)

const ENVELOPE = { items: [], total: 0, hasMore: false, nextOffset: null, popular: [] }

function baseFilters(overrides: Partial<ExplorerFilters> = {}): ExplorerFilters {
  return {
    search: '', visibility: null, workspaceIds: [], dataSourceId: null,
    viewTypes: [], tags: [], creatorIds: [], sort: 'recently-modified',
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
