/**
 * The Review Center (/reviews): the reader chooses where to look — All workspaces,
 * or one — instead of the sidebar opening whichever workspace the browser last
 * held. Each choice shows what waits on the reader there; across workspaces each
 * row names its workspace and opens its review there; the choice is remembered;
 * and the older /workspaces/:wsId/reviews links land here, scoped, query kept.
 */
import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { MemoryRouter, Route, Routes, useLocation, useParams } from 'react-router-dom'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { PullRequest, ReviewInboxCounts, ReviewInboxQueue } from '@/services/versioningApiService'

const api = vi.hoisted(() => ({
  getReviewInbox: vi.fn(), getReviewInboxCounts: vi.fn(), getReviewCenter: vi.fn(), getReviewCenterCounts: vi.fn(),
}))
vi.mock('@/services/versioningApiService', async (orig) => ({
  ...(await orig<typeof import('@/services/versioningApiService')>()),
  ...api,
}))
const state = {
  workspaces: [
    { id: 'ws1', name: 'Finance', dataSources: [] },
    { id: 'ws2', name: 'Risk', dataSources: [] },
    { id: 'ws3', name: 'Not reviewable', dataSources: [] },
  ],
  loadWorkspaces: vi.fn(),
}
vi.mock('@/store/workspaces', () => ({ useWorkspacesStore: (sel: (s: typeof state) => unknown) => sel(state) }))
vi.mock('../components/PrListRow', () => ({
  PrListRow: ({ pr, workspace, onOpen }: { pr: PullRequest; workspace?: { name: string }; onOpen: () => void }) => (
    <div role="button" tabIndex={0} data-pr-row={pr.prId} onClick={onOpen}>
      {pr.title}{workspace ? ` · in ${workspace.name}` : ''}
    </div>
  ),
}))
vi.mock('../components/PrDetailDrawer', () => ({ PrDetailDrawer: () => null }))

import { ReviewCenterPage } from '@/pages/ReviewCenterPage'
import { WorkspaceReviewsPage } from '@/pages/WorkspaceReviewsPage'

const ZERO: Record<ReviewInboxQueue, number> = { needs_review: 0, waiting: 0, sent_back: 0, ready: 0, open: 0, done: 0 }
const tally = (needs: number): ReviewInboxCounts => ({ counts: { ...ZERO, needs_review: needs, open: needs }, unread: ZERO, capped: false })
const pr = (prId: string, title: string, workspaceId: string, workspaceName: string): PullRequest => ({
  prId, title, graphId: 'g', targetGraphId: 'g', sourceBranchId: 'b', targetBranch: 'main', status: 'open',
  createdAt: '2026-11-01T00:00:00Z', updatedAt: '2026-11-01T00:00:00Z', actor: 'u', userNames: {}, workspaceId, workspaceName,
})

beforeEach(() => {
  for (const f of Object.values(api)) f.mockReset()
  window.localStorage.clear()
  api.getReviewCenterCounts.mockResolvedValue({ ...tally(3), byWorkspace: { ws1: tally(1), ws2: tally(2) } })
  api.getReviewCenter.mockResolvedValue({
    ...tally(3), byWorkspace: {}, queue: 'needs_review', total: 2,
    items: [pr('pr_r', 'Rename limits', 'ws2', 'Risk'), pr('pr_f', 'Tidy ledger', 'ws1', 'Finance')],
  })
  api.getReviewInboxCounts.mockResolvedValue(tally(1))
  api.getReviewInbox.mockResolvedValue({ ...tally(1), queue: 'needs_review', total: 1, items: [pr('pr_f', 'Tidy ledger', 'ws1', 'Finance')] })
})

function Where() {
  const { pathname, search } = useLocation()
  return <div data-testid="where">{pathname}{search}</div>
}
function OpenedReview() {
  const { wsId, prId } = useParams()
  return <p>Review {prId} in {wsId}</p>
}
function renderAt(at: string) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  return render(
    <QueryClientProvider client={qc}>
      <MemoryRouter initialEntries={[at]}>
        <Routes>
          <Route path="/reviews" element={<><ReviewCenterPage /><Where /></>} />
          <Route path="/workspaces/:wsId/reviews" element={<WorkspaceReviewsPage />} />
          <Route path="/workspaces/:wsId/reviews/:prId" element={<OpenedReview />} />
        </Routes>
      </MemoryRouter>
    </QueryClientProvider>,
  )
}

describe('the Review Center', () => {
  it('opens on All workspaces: every review, each naming its workspace and opening there', async () => {
    renderAt('/reviews')
    expect(await screen.findByText('Rename limits · in Risk')).toBeInTheDocument()
    expect(api.getReviewCenter).toHaveBeenCalled()
    expect(api.getReviewInbox).not.toHaveBeenCalled()
    fireEvent.click(screen.getByText('Rename limits · in Risk'))
    expect(await screen.findByText('Review pr_r in ws2')).toBeInTheDocument()
  })

  it('offers each workspace the reader can review in, with what waits on them there', async () => {
    renderAt('/reviews')
    const all = await screen.findByRole('radio', { name: /All workspaces/ })
    expect(all).toHaveAttribute('aria-checked', 'true')
    await waitFor(() => expect(screen.getByRole('radio', { name: /Risk/ })).toHaveTextContent('2'))
    expect(screen.getByRole('radio', { name: /Finance/ })).toHaveTextContent('1')
    expect(screen.queryByRole('radio', { name: /Not reviewable/ })).toBeNull()
  })

  it('narrows to one workspace, says so in the address, and remembers it', async () => {
    const { unmount } = renderAt('/reviews')
    fireEvent.click(await screen.findByRole('radio', { name: /Finance/ }))
    await waitFor(() => expect(screen.getByTestId('where')).toHaveTextContent('/reviews?workspace=ws1'))
    await waitFor(() => expect(api.getReviewInbox).toHaveBeenCalledWith('ws1', expect.anything()))
    unmount()
    renderAt('/reviews')
    expect(await screen.findByRole('radio', { name: /Finance/ })).toHaveAttribute('aria-checked', 'true')
  })

  it('lands an older workspace reviews link here, scoped, with its queue', async () => {
    renderAt('/workspaces/ws2/reviews?queue=open')
    await waitFor(() => expect(screen.getByTestId('where')).toHaveTextContent('/reviews?queue=open&workspace=ws2'))
  })
})
