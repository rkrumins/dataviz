/**
 * ExplorerPage — a selection belongs to the list it was made in.
 *
 * Views selected under All used to stay selected when the reader switched to
 * Deleted, where the bulk Delete is permanent: the next Delete destroyed live
 * views. Changing the category, a filter or the sort starts a new selection, and
 * a bulk action only ever acts on views that are on screen.
 */
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { MemoryRouter } from 'react-router-dom'
import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { View } from '@/services/viewApiService'

function view(id: string, overrides: Partial<View> = {}): View {
  return {
    id,
    name: `View ${id}`,
    workspaceId: 'ws_1',
    viewType: 'graph',
    config: {},
    visibility: 'workspace',
    isPinned: false,
    favouriteCount: 0,
    isFavourited: false,
    createdAt: '2026-01-01T00:00:00Z',
    updatedAt: '2026-01-01T00:00:00Z',
    createdBy: 'usr_me',
    ...overrides,
  }
}

const LIVE = [view('live_a'), view('live_b')]
const TRASHED = [view('gone_c', { deletedAt: '2026-02-01T00:00:00Z' })]

vi.mock('@/hooks/useExplorerViews', () => ({
  useExplorerViews: (filters: { category: string | null }) => {
    const views = filters.category === 'deleted' ? TRASHED : LIVE
    return {
      views,
      totalCount: views.length,
      popularViews: [],
      isLoading: false,
      isLoadingMore: false,
      isFetching: false,
      isPlaceholderData: false,
      error: null,
      errorStatus: null,
      toggleFavourite: vi.fn(),
      removeView: vi.fn(),
      patchView: vi.fn(),
      refetch: vi.fn(),
      loadMore: vi.fn(),
      hasMore: false,
    }
  },
}))
vi.mock('@/components/layout/AppLayout', () => ({
  useViewEditorModal: () => ({ openViewEditor: vi.fn() }),
}))
// What the bulk dialog was asked to delete, and how.
const bulkDialog = vi.fn()
vi.mock('@/components/explorer/BulkDeleteDialog', () => ({
  BulkDeleteDialog: (props: { viewIds: string[]; isOpen: boolean; permanent?: boolean }) => {
    bulkDialog(props)
    return null
  },
}))

import { ExplorerPage } from '../ExplorerPage'
import { useAuthStore } from '@/store/auth'

function renderPage(initial = '/explorer') {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  return render(
    <QueryClientProvider client={qc}>
      <MemoryRouter initialEntries={[initial]}>
        <ExplorerPage />
      </MemoryRouter>
    </QueryClientProvider>,
  )
}

beforeEach(() => {
  bulkDialog.mockClear()
  useAuthStore.setState({ user: { id: 'usr_me' } as never })
})

describe('ExplorerPage selection', () => {
  it('drops the selection when the category changes, so Deleted never inherits live views', async () => {
    renderPage()
    fireEvent.click(screen.getByRole('button', { name: 'Select View live_a' }))
    fireEvent.click(screen.getByRole('button', { name: 'Select View live_b' }))
    expect(screen.getByText('2 views selected')).toBeInTheDocument()

    fireEvent.click(screen.getByRole('button', { name: /^Deleted$/ }))

    // The bar animates out; it must go, not just fade.
    await waitFor(() => expect(screen.queryByText(/views? selected/)).not.toBeInTheDocument())
    // The permanent dialog, if it ever opens, has nothing of the live list to destroy.
    const last = bulkDialog.mock.calls.at(-1)?.[0]
    expect(last.permanent).toBe(true)
    expect(last.viewIds).toEqual([])
  })

  it('keeps the selection when only the layout changes', () => {
    renderPage()
    fireEvent.click(screen.getByRole('button', { name: 'Select View live_a' }))
    expect(screen.getByText('1 view selected')).toBeInTheDocument()

    fireEvent.click(screen.getByRole('button', { name: 'List view' }))

    expect(screen.getByText('1 view selected')).toBeInTheDocument()
  })

  it('offers a trashed view for permanent deletion only from the Deleted list', () => {
    renderPage('/explorer?category=deleted')
    expect(screen.queryByRole('button', { name: 'Select View live_a' })).toBeNull()
    fireEvent.click(screen.getByRole('button', { name: 'Select View gone_c' }))
    const last = bulkDialog.mock.calls.at(-1)?.[0]
    expect(last.permanent).toBe(true)
    expect(last.viewIds).toEqual(['gone_c'])
  })
})
