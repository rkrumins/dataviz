/**
 * ExplorerPage — the page's own behaviour, with the data hook stubbed.
 *
 * Selection: views selected under All used to stay selected when the reader
 * switched to Deleted, where the bulk Delete is permanent: the next Delete
 * destroyed live views. Changing the category, a filter or the sort starts a new
 * selection, and a bulk action only ever acts on views that are on screen.
 *
 * Search: the box follows the address when something else changes it (the
 * sidebar's Explorer link, a command-palette search) instead of keeping
 * filtering by the old text while the heading and stats follow the new.
 */
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { MemoryRouter, useNavigate } from 'react-router-dom'
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

const toggleFavourite = vi.fn()
// What the list was asked for.
const listAsked = vi.fn()
vi.mock('@/hooks/useExplorerViews', () => ({
  useExplorerViews: (filters: { category: string | null }) => {
    listAsked(filters)
    // A new array each render, as a refetch or an optimistic patch gives.
    const views = [...(filters.category === 'deleted' ? TRASHED : LIVE)]
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
      toggleFavourite,
      removeView: vi.fn(),
      patchView: vi.fn(),
      refetch: vi.fn(),
      loadMore: vi.fn(),
      hasMore: false,
    }
  },
}))
// What the stats bar was asked to count.
const statsAsked = vi.fn()
vi.mock('@/hooks/useViewStats', () => ({
  useViewStats: (params: Record<string, unknown>) => {
    statsAsked(params)
    return { stats: { total: 9, recentlyAdded: 2, needsAttention: 1, lastActivityAt: null }, isFetching: false }
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

/** Something else on the page moving the address, as the sidebar or palette would. */
function GoTo({ to }: { to: string }) {
  const navigate = useNavigate()
  return <button onClick={() => navigate(to)}>go {to}</button>
}

function renderPage(initial = '/explorer', goTo?: string) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  return render(
    <QueryClientProvider client={qc}>
      <MemoryRouter initialEntries={[initial]}>
        <ExplorerPage />
        {goTo && <GoTo to={goTo} />}
      </MemoryRouter>
    </QueryClientProvider>,
  )
}

const searchBox = () => screen.getByRole('combobox', { name: /Search views/ }) as HTMLInputElement

beforeEach(() => {
  bulkDialog.mockClear()
  useAuthStore.setState({ user: { id: 'usr_me' } as never, permissions: { global: [], ws: {} } } as never)
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

describe('ExplorerPage search', () => {
  it('follows the address when it changes from outside the page', async () => {
    renderPage('/explorer?q=alpha', '/explorer?q=beta')
    expect(searchBox().value).toBe('alpha')

    fireEvent.click(screen.getByRole('button', { name: 'go /explorer?q=beta' }))
    await waitFor(() => expect(searchBox().value).toBe('beta'))
  })

  it('empties when the address drops the search', async () => {
    renderPage('/explorer?q=alpha', '/explorer')
    fireEvent.click(screen.getByRole('button', { name: 'go /explorer' }))
    await waitFor(() => expect(searchBox().value).toBe(''))
  })

  it('keeps what the reader is typing', async () => {
    renderPage('/explorer')
    fireEvent.change(searchBox(), { target: { value: 'lin' } })
    fireEvent.change(searchBox(), { target: { value: 'lineage' } })
    // The debounced write lands in the address; the box keeps the latest text.
    await new Promise(r => setTimeout(r, 450))
    expect(searchBox().value).toBe('lineage')
  })
})

describe('ExplorerPage stats tiles', () => {
  it('count what clicking them shows: the filters without the open category', () => {
    statsAsked.mockClear()
    renderPage('/explorer?category=my-views&type=graph')
    const asked = statsAsked.mock.calls.at(-1)?.[0]
    expect(asked.viewTypes).toEqual(['graph'])
    expect(asked.createdBy).toBeUndefined()
  })

  it('count recent views from the cutoff the Recent list uses', () => {
    statsAsked.mockClear()
    renderPage('/explorer?category=recently-added')
    const since = listAsked.mock.calls.at(-1)?.[0].recentSince
    expect(since).toEqual(expect.any(String))
    expect(statsAsked.mock.calls.at(-1)?.[0].recentSince).toBe(since)
  })

  it('switch to their category and keep every other filter', async () => {
    renderPage('/explorer?category=my-views&type=graph', '/explorer')
    fireEvent.click(screen.getByRole('button', { name: /New This Week/i }))
    await waitFor(() => expect(screen.getByRole('button', { name: /^Recent$/, pressed: true })).toBeInTheDocument())
    const asked = statsAsked.mock.calls.at(-1)?.[0]
    expect(asked.viewTypes).toEqual(['graph'])
  })
})

describe('ExplorerPage trash', () => {
  it('keeps Delete forever for workspace admins, whom the server lets do it', () => {
    renderPage('/explorer?category=deleted')
    fireEvent.click(screen.getByRole('button', { name: 'Select View gone_c' }))
    // The creator, not an admin: no bulk Delete (permanent here), no Delete forever.
    expect(screen.queryByRole('button', { name: /^Delete \(1\)$/ })).toBeNull()
    expect(screen.queryByTitle('Permanently delete')).toBeNull()
  })

  it('offers both to a workspace admin', () => {
    useAuthStore.setState({ permissions: { global: [], ws: { ws_1: ['workspace:admin'] } } } as never)
    renderPage('/explorer?category=deleted')
    expect(screen.getByTitle('Permanently delete')).toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: 'Select View gone_c' }))
    expect(screen.getByRole('button', { name: /^Delete \(1\)$/ })).toBeInTheDocument()
  })
})

describe('ExplorerPage keyboard', () => {
  it('keeps focus on the same view after favouriting it', () => {
    toggleFavourite.mockClear()
    renderPage()
    fireEvent.keyDown(document.body, { key: 'ArrowRight' })
    fireEvent.keyDown(document.body, { key: 'ArrowRight' })
    fireEvent.keyDown(document.body, { key: 'f' })
    fireEvent.keyDown(document.body, { key: 'f' })
    expect(toggleFavourite.mock.calls).toEqual([['live_b'], ['live_b']])
  })
})
