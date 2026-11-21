/**
 * The Explorer's cards and rows carry each view's open questions: counted once for everything on
 * screen, opening the questions drawer on that view (not its preview) — and nothing, not even the
 * request, while conversations are off.
 */
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { MemoryRouter } from 'react-router-dom'
import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { View } from '@/services/viewApiService'
import { DEFAULT_FEATURES, useFeaturesStore } from '@/store/features'

function view(id: string): View {
  return {
    id, name: `View ${id}`, workspaceId: 'ws_1', viewType: 'graph', config: {}, visibility: 'workspace',
    isPinned: false, favouriteCount: 0, isFavourited: false,
    createdAt: '2026-01-01T00:00:00Z', updatedAt: '2026-01-01T00:00:00Z', createdBy: 'usr_me',
  }
}

vi.mock('@/hooks/useExplorerViews', () => ({
  useExplorerViews: () => {
    const views = [view('live_a'), view('live_b')]
    return {
      views, totalCount: views.length, popularViews: [], isLoading: false, isLoadingMore: false, isFetching: false,
      isPlaceholderData: false, error: null, errorStatus: null, toggleFavourite: vi.fn(), removeView: vi.fn(),
      patchView: vi.fn(), refetch: vi.fn(), loadMore: vi.fn(), hasMore: false,
    }
  },
}))
vi.mock('@/hooks/useViewStats', () => ({
  useViewStats: () => ({ stats: { total: 2, recentlyAdded: 0, needsAttention: 0, lastActivityAt: null }, isFetching: false }),
}))
vi.mock('@/components/layout/AppLayout', () => ({ useViewEditorModal: () => ({ openViewEditor: vi.fn() }) }))
vi.mock('@/components/explorer/ExplorerPreviewDrawer', () => ({
  ExplorerPreviewDrawer: ({ view: v, isOpen }: { view: View | null; isOpen: boolean }) =>
    isOpen && v ? <div role="dialog" aria-label={`Preview of ${v.name}`} /> : null,
}))
const api = vi.hoisted(() => ({ getSubjectSummaries: vi.fn() }))
vi.mock('@/services/discussionsService', async (orig) => ({
  ...(await orig<typeof import('@/services/discussionsService')>()),
  ...api,
}))

import { ExplorerPage } from '../ExplorerPage'
import { useAuthStore } from '@/store/auth'
import { useDiscussionsDrawer } from '@/features/discussions/drawerStore'

function renderPage(initial = '/explorer') {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  return render(
    <QueryClientProvider client={qc}>
      <MemoryRouter initialEntries={[initial]}><ExplorerPage /></MemoryRouter>
    </QueryClientProvider>,
  )
}

beforeEach(() => {
  api.getSubjectSummaries.mockReset()
  api.getSubjectSummaries.mockResolvedValue({ summaries: { live_b: { open: 3, answered: 1, total: 4, unread: 1 } } })
  useAuthStore.setState({ user: { id: 'usr_me' } as never, permissions: { global: [], ws: {} } } as never)
  useFeaturesStore.setState({ values: { ...DEFAULT_FEATURES, conversationsEnabled: true } })
  useDiscussionsDrawer.setState({ target: null })
})

describe('questions on the Explorer', () => {
  it.each(['/explorer', '/explorer?layout=list'])('counts every view on screen at once and opens its questions (%s)', async (at) => {
    renderPage(at)
    const chip = await screen.findByRole('button', { name: '3 open questions, 1 unread' })
    expect(api.getSubjectSummaries).toHaveBeenCalledTimes(1)
    expect(api.getSubjectSummaries).toHaveBeenCalledWith('view', ['live_a', 'live_b'])
    expect(screen.getAllByRole('button', { name: /open question/ })).toHaveLength(1)   // live_a has none

    fireEvent.click(chip)
    expect(useDiscussionsDrawer.getState().target?.subject).toEqual({ type: 'view', id: 'live_b', name: 'View live_b' })
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument()
  })

  it('shows nothing and asks nothing while conversations are off', async () => {
    useFeaturesStore.setState({ values: { ...DEFAULT_FEATURES, conversationsEnabled: false } })
    renderPage()
    await screen.findByText('View live_b')
    await new Promise((r) => setTimeout(r, 20))
    expect(api.getSubjectSummaries).not.toHaveBeenCalled()
    expect(screen.queryByRole('button', { name: /open question/ })).not.toBeInTheDocument()
  })

  it('still previews the view from the rest of the card', async () => {
    renderPage()
    await screen.findByRole('button', { name: '3 open questions, 1 unread' })
    fireEvent.click(screen.getByText('View live_b'))
    await waitFor(() => expect(screen.getByRole('dialog', { name: 'Preview of View live_b' })).toBeInTheDocument())
    expect(useDiscussionsDrawer.getState().target).toBeNull()
  })
})
