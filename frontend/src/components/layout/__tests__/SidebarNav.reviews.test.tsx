/**
 * The sidebar's Reviews row: the Review Center across every workspace the reader can review in —
 * not whichever workspace the browser last held — badged with what waits on the reader anywhere:
 * reviews asked of them, and theirs sent back. Only while version control is on. Its pages (the
 * Review Center and each review's) light it, not Workspaces.
 */
import { act, fireEvent, render, screen, within } from '@testing-library/react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { MemoryRouter, Route, Routes, useLocation } from 'react-router-dom'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { ReviewInboxCounts } from '@/services/versioningApiService'

const api = vi.hoisted(() => ({ getReviewCenterCounts: vi.fn() }))
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
  api.getReviewCenterCounts.mockReset()
})

describe('the sidebar’s Reviews row', () => {
  it('counts the reviews asked of you and yours sent back, everywhere, and opens the Review Center', async () => {
    api.getReviewCenterCounts.mockResolvedValue({ ...counts(2, 1), byWorkspace: {} })
    renderSidebar()
    const row = await reviewsRow()
    expect(await within(row).findByText('3')).toBeInTheDocument()
    fireEvent.click(row)
    expect(screen.getByTestId('where')).toHaveTextContent(/^\/reviews$/)
  })

  it('has no badge when nothing waits on you', async () => {
    api.getReviewCenterCounts.mockResolvedValue({ ...counts(0, 0), byWorkspace: {} })
    renderSidebar()
    const row = await reviewsRow()
    await vi.waitFor(() => expect(api.getReviewCenterCounts).toHaveBeenCalled())
    await act(() => new Promise((r) => setTimeout(r, 20)))   // the counts are in
    expect(within(row).queryByText(/^\d+$/)).not.toBeInTheDocument()
  })

  it('is not there while version control is off', async () => {
    flags.versioningEnabled = false
    renderSidebar()
    await screen.findByRole('button', { name: /^Dashboard/ })
    expect(screen.queryByRole('button', { name: /^Reviews/ })).not.toBeInTheDocument()
    expect(api.getReviewCenterCounts).not.toHaveBeenCalled()
  })

  it('is the section of the Review Center and each review’s page', () => {
    expect(tabForPath('/reviews')).toBe('reviews')
    expect(tabForPath('/workspaces/ws1/reviews')).toBe('reviews')
    expect(tabForPath('/workspaces/ws1/reviews/pr_1')).toBe('reviews')
    expect(tabForPath('/workspaces/ws1')).toBe('workspaces')
    expect(tabForPath('/workspaces/ws1/reviewsish')).toBe('workspaces')
  })
})
