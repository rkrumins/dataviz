/**
 * WorkspaceViewsSection — the publication-request queue.
 *
 * Approve used to be a bare button: the admin published a view, and
 * read-only access to the data behind it, to every signed-in account
 * without ever being told that was what the click did. It now goes
 * through a confirm step that states the consequence and names the data
 * source. These pin that the queue row says what is being decided, and
 * that nothing publishes before the second click.
 */
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { MemoryRouter } from 'react-router-dom'
import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('@/services/viewApiService', async () => {
  const actual = await vi.importActual<typeof import('@/services/viewApiService')>(
    '@/services/viewApiService',
  )
  return {
    ...actual,
    approveViewPublication: vi.fn(),
    denyViewPublication: vi.fn(),
    updateViewVisibility: vi.fn(),
    restoreView: vi.fn(),
  }
})
vi.mock('@/hooks/useExplorerViews', () => ({
  useExplorerViews: () => ({
    views: [],
    totalCount: 0,
    popularViews: [],
    isLoading: false,
    isLoadingMore: false,
    error: null,
    toggleFavourite: vi.fn(),
    removeView: vi.fn(),
    refetch: vi.fn(),
    loadMore: vi.fn(),
    hasMore: false,
  }),
}))
// Owns the app-shell modal plumbing — irrelevant here, and importing it
// would drag the whole layout in.
vi.mock('@/components/layout/AppLayout', () => ({
  useViewEditorModal: () => ({ openViewEditor: vi.fn() }),
}))
vi.mock('@/store/auth', async () => {
  const actual = await vi.importActual<typeof import('@/store/auth')>('@/store/auth')
  // The queue only renders for someone who can answer.
  return { ...actual, usePermission: () => true }
})
vi.mock('@/store/branding', () => ({
  useBrand: () => ({ appName: 'TestBrand' }),
}))

import WorkspaceViewsSection from '../WorkspaceViewsSection'
import {
  approveViewPublication,
  type View,
  type ViewPublishRequest,
} from '@/services/viewApiService'

const mockApprove = vi.mocked(approveViewPublication)

const PENDING: ViewPublishRequest = {
  requestedBy: 'usr_ada',
  requestedByName: 'Ada Lovelace',
  requestedAt: new Date(Date.now() - 3 * 24 * 60 * 60 * 1000).toISOString(),
  note: 'The whole company needs this map.',
}

function viewResponse(overrides: Partial<View> = {}): View {
  return {
    id: 'view_1',
    name: 'Test View',
    workspaceId: 'ws_1',
    viewType: 'graph',
    config: {},
    visibility: 'workspace',
    isPinned: false,
    favouriteCount: 0,
    isFavourited: false,
    createdAt: '2026-01-01T00:00:00Z',
    updatedAt: '2026-01-01T00:00:00Z',
    ...overrides,
  }
}

function renderSection(allViews: View[]) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  return render(
    <QueryClientProvider client={qc}>
      <MemoryRouter>
        <WorkspaceViewsSection wsId="ws_1" dataSources={[]} allViews={allViews} />
      </MemoryRouter>
    </QueryClientProvider>,
  )
}

beforeEach(() => {
  vi.clearAllMocks()
})

describe('publication request queue', () => {
  it('says what is being decided before the admin decides it', async () => {
    renderSection([viewResponse({
      publishRequest: PENDING,
      dataSourceName: 'Finance Warehouse',
    })])

    // The row itself: where the view stands today, and where its data lives.
    expect(await screen.findByText(/Finance Warehouse · currently visible to this workspace/))
      .toBeTruthy()
    expect(screen.getByText(/asked by Ada Lovelace 3d ago/)).toBeTruthy()
    expect(screen.getByText(PENDING.note!)).toBeTruthy()

    // The consequence appears at the decision point, and nothing has
    // published yet.
    fireEvent.click(screen.getByText('Approve'))
    expect(await screen.findByText(
      'Publishing makes this view, and read-only access to Finance Warehouse, '
      + 'visible to everyone signed in to TestBrand.',
    )).toBeTruthy()
    expect(mockApprove).not.toHaveBeenCalled()

    fireEvent.click(screen.getByText('Publish to everyone'))
    await waitFor(() => expect(mockApprove).toHaveBeenCalledWith('view_1'))
  })

  it('drops the data-source clause when the view has no source assigned', async () => {
    renderSection([viewResponse({ publishRequest: PENDING })])
    fireEvent.click(await screen.findByText('Approve'))
    expect(screen.getByText(
      'Publishing makes this view visible to everyone signed in to TestBrand.',
    )).toBeTruthy()
  })

  it('backs out without publishing', async () => {
    renderSection([viewResponse({ publishRequest: PENDING })])
    fireEvent.click(await screen.findByText('Approve'))
    fireEvent.click(screen.getByText('Cancel'))
    expect(screen.getByText('Approve')).toBeTruthy()
    expect(mockApprove).not.toHaveBeenCalled()
  })
})
