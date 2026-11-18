/**
 * The sidebar's Reviews row: the open workspace's reviews, badged with what waits on the reader —
 * reviews asked of them, and theirs sent back — and only while version control is on. Its pages
 * (the inbox and each review's) light it, not Workspaces.
 */
import { act, fireEvent, render, screen, within } from '@testing-library/react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { MemoryRouter, Route, Routes, useLocation } from 'react-router-dom'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { ReviewInboxCounts } from '@/services/versioningApiService'

const api = vi.hoisted(() => ({ getReviewInboxCounts: vi.fn() }))
vi.mock('@/services/versioningApiService', async (orig) => ({
  ...(await orig<typeof import('@/services/versioningApiService')>()),
  ...api,
}))
const flags = vi.hoisted(() => ({ versioningEnabled: true }))
vi.mock('@/store/features', () => ({ useFeature: (key: string) => (key === 'versioningEnabled' ? flags.versioningEnabled : false) }))
vi.mock('@/store/auth', () => ({ useNavPermission: () => true, usePermissionsReady: () => true }))
vi.mock('@/hooks/useAnalyticsAccess', () => ({ useAnalyticsAccess: () => ({ allowed: false }) }))
vi.mock('@/hooks/useLayoutTemplates', () => ({ useLayoutTemplatesEnabled: () => false }))
vi.mock('@/hooks/useOnboardingProgress', () => ({ useOnboardingProgress: () => ({ isLoading: true }) }))
vi.mock('@/hooks/useWorkspaceContext', () => ({ useWorkspaceContext: () => ({ viewCount: 0, workspace: { id: 'ws1' } }) }))

import { SidebarNav } from '../SidebarNav'
import { tabForPath } from '@/store/navigation'

const counts = (needs: number, sentBack: number): ReviewInboxCounts => ({
  counts: { needs_review: needs, waiting: 4, sent_back: sentBack, ready: 1, open: 9, done: 7 },
  unread: { needs_review: 0, waiting: 0, sent_back: 0, ready: 0, open: 0, done: 0 },
  capped: false,
})

function Where() {
  return <p data-testid="where">{useLocation().pathname}</p>
}
function renderSidebar() {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  return render(
    <QueryClientProvider client={qc}>
      <MemoryRouter initialEntries={['/dashboard']}>
        <Routes><Route path="*" element={<><SidebarNav /><Where /></>} /></Routes>
      </MemoryRouter>
    </QueryClientProvider>,
  )
}
const reviewsRow = () => screen.findByRole('button', { name: /^Reviews/ })

beforeEach(() => {
  flags.versioningEnabled = true
  api.getReviewInboxCounts.mockReset()
})

describe('the sidebar’s Reviews row', () => {
  it('counts the reviews asked of you and yours sent back, and opens the workspace’s reviews', async () => {
    api.getReviewInboxCounts.mockResolvedValue(counts(2, 1))
    renderSidebar()
    const row = await reviewsRow()
    expect(await within(row).findByText('3')).toBeInTheDocument()
    expect(api.getReviewInboxCounts).toHaveBeenCalledWith('ws1')
    fireEvent.click(row)
    expect(screen.getByTestId('where')).toHaveTextContent('/workspaces/ws1/reviews')
  })

  it('has no badge when nothing waits on you', async () => {
    api.getReviewInboxCounts.mockResolvedValue(counts(0, 0))
    renderSidebar()
    const row = await reviewsRow()
    await vi.waitFor(() => expect(api.getReviewInboxCounts).toHaveBeenCalled())
    await act(() => new Promise((r) => setTimeout(r, 20)))   // the counts are in
    expect(within(row).queryByText(/^\d+$/)).not.toBeInTheDocument()
  })

  it('is not there while version control is off', async () => {
    flags.versioningEnabled = false
    renderSidebar()
    await screen.findByRole('button', { name: /^Dashboard/ })
    expect(screen.queryByRole('button', { name: /^Reviews/ })).not.toBeInTheDocument()
    expect(api.getReviewInboxCounts).not.toHaveBeenCalled()
  })

  it('is the section of a workspace’s inbox and each review’s page', () => {
    expect(tabForPath('/workspaces/ws1/reviews')).toBe('reviews')
    expect(tabForPath('/workspaces/ws1/reviews/pr_1')).toBe('reviews')
    expect(tabForPath('/workspaces/ws1')).toBe('workspaces')
    expect(tabForPath('/workspaces/ws1/reviewsish')).toBe('workspaces')
  })
})
