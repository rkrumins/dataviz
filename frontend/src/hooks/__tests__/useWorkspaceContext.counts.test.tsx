/**
 * The header's numbers are the server's: the Explore badge is every view the
 * reader can open (the Explorer's own total) and the favourites count is all
 * of them — not the length of the page of views or favourites the app holds.
 */
import { act, renderHook, waitFor } from '@testing-library/react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { MemoryRouter } from 'react-router-dom'
import type { ReactNode } from 'react'
import { beforeEach, describe, expect, it, vi } from 'vitest'

const { listViews, getViewCounts, unfavouriteView } = vi.hoisted(() => ({
    listViews: vi.fn(), getViewCounts: vi.fn(), unfavouriteView: vi.fn(),
}))
vi.mock('@/services/viewApiService', () => ({
    listViews, getViewCounts, unfavouriteView, favouriteView: vi.fn(),
}))

import { useWorkspaceContext } from '../useWorkspaceContext'

const fav = (id: string) => ({ id, name: id, isFavourited: true })

function wrapper({ children }: { children: ReactNode }) {
    const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } })
    return <QueryClientProvider client={qc}><MemoryRouter>{children}</MemoryRouter></QueryClientProvider>
}

beforeEach(() => {
    getViewCounts.mockReset().mockResolvedValue({ total: 1250, byWorkspace: {}, byDataSource: {} })
    // The first page of 50 favourites, of 64.
    listViews.mockReset().mockResolvedValue({
        items: Array.from({ length: 50 }, (_, i) => fav(`v${i}`)), total: 64, hasMore: true, nextOffset: 50,
    })
    unfavouriteView.mockReset().mockReturnValue(new Promise(() => {}))
})

describe('useWorkspaceContext — counts', () => {
    it('badges Explore with every view the reader can open', async () => {
        const { result } = renderHook(() => useWorkspaceContext(), { wrapper })
        await waitFor(() => expect(result.current.viewCount).toBe(1250))
    })

    it('counts every favourite, and one fewer at once when one is taken off', async () => {
        const { result } = renderHook(() => useWorkspaceContext(), { wrapper })
        await waitFor(() => expect(result.current.bookmarkCount).toBe(64))
        expect(result.current.bookmarks).toHaveLength(50)

        act(() => { void result.current.toggleBookmark('v3', true) })
        await waitFor(() => expect(result.current.bookmarkCount).toBe(63))
        expect(result.current.bookmarks.map(b => b.id)).not.toContain('v3')
    })
})
