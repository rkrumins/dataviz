/**
 * WorkspaceReviewsInbox — the Review Center's queues, as the server sorts them: it opens on the
 * first queue with something for the reader, each queue shows its count and a dot while something
 * in it is unread, the queue open is in the address (`?queue=`), search and filters are asked of the
 * server, "Load more" reads the next page, a row (or j / k then Enter) opens the review's page, and
 * an older `?pr=` link still opens the quick peek.
 */
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { MemoryRouter, Route, Routes, useLocation, useParams } from 'react-router-dom'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { PullRequest, ReviewInboxCounts, ReviewInboxPage, ReviewInboxParams, ReviewInboxQueue } from '@/services/versioningApiService'

const api = vi.hoisted(() => ({ getReviewInbox: vi.fn(), getReviewInboxCounts: vi.fn() }))
vi.mock('@/services/versioningApiService', async (orig) => ({
  ...(await orig<typeof import('@/services/versioningApiService')>()),
  ...api,
}))
const state = {
  workspaces: [{ id: 'ws1', dataSources: [{ id: 'ds1', label: 'Sales' }, { id: 'ds2', label: 'Ops' }] }],
  loadWorkspaces: vi.fn(),
}
vi.mock('@/store/workspaces', () => ({
  useWorkspacesStore: (sel: (s: typeof state) => unknown) => sel(state),
}))
vi.mock('../components/PrListRow', () => ({
  PrListRow: ({ pr, sourceLabel, onOpen }: { pr: PullRequest; sourceLabel?: string; onOpen: () => void }) => (
    <div role="button" tabIndex={0} data-pr-row={pr.prId} onClick={onOpen}
      onKeyDown={(e) => { if (e.key === 'Enter') onOpen() }}>
      {pr.title}{sourceLabel ? ` · ${sourceLabel}` : ''}
    </div>
  ),
}))
vi.mock('../components/PrDetailDrawer', () => ({
  PrDetailDrawer: ({ prId, onClose }: { prId: string; onClose: () => void }) => (
    <div role="dialog" aria-label="Peek">Peek {prId}<button onClick={onClose}>Close peek</button></div>
  ),
}))

import { WorkspaceReviewsInbox } from '../components/WorkspaceReviewsInbox'

const ZERO: Record<ReviewInboxQueue, number> = { needs_review: 0, waiting: 0, sent_back: 0, ready: 0, open: 0, done: 0 }
const tally = (counts: Partial<Record<ReviewInboxQueue, number>>, unread: Partial<Record<ReviewInboxQueue, number>> = {},
  capped = false): ReviewInboxCounts => ({ counts: { ...ZERO, ...counts }, unread: { ...ZERO, ...unread }, capped })
const pr = (prId: string, title: string, over: Partial<PullRequest> = {}): PullRequest => ({
  prId, title, graphId: 'g1', targetGraphId: 'g1', sourceBranchId: 'b1', targetBranch: 'main', status: 'open',
  createdAt: '2026-11-01T00:00:00Z', updatedAt: '2026-11-01T00:00:00Z', actor: 'u_ana', userNames: { u_ana: 'Ana' },
  targetDataSourceId: 'ds1', ...over,
})

/** The server: each queue's reviews, paged, and the counts. */
let counts: ReviewInboxCounts
let queues: Partial<Record<ReviewInboxQueue, PullRequest[]>>
beforeEach(() => {
  api.getReviewInbox.mockReset()
  api.getReviewInboxCounts.mockReset()
  counts = tally({ needs_review: 2, waiting: 1, open: 3, done: 4 }, { needs_review: 1 })
  queues = {
    needs_review: [pr('pr_1', 'Tidy owners'), pr('pr_2', 'Rename regions', { targetDataSourceId: 'ds2' })],
    waiting: [pr('pr_3', 'My draft')],
    open: [pr('pr_1', 'Tidy owners'), pr('pr_2', 'Rename regions'), pr('pr_3', 'My draft')],
    done: [pr('pr_4', 'Old one', { status: 'merged' })],
  }
  api.getReviewInboxCounts.mockImplementation(() => Promise.resolve(counts))
  api.getReviewInbox.mockImplementation((_ws: string, p: ReviewInboxParams): Promise<ReviewInboxPage> => {
    const all = queues[p.queue!] ?? []
    const offset = p.offset ?? 0
    return Promise.resolve({ ...counts, queue: p.queue!, items: all.slice(offset, offset + (p.limit ?? 25)), total: all.length })
  })
})

function Where() {
  const { search } = useLocation()
  return <div data-testid="where">{search}</div>
}
function ReviewPage() {
  return <p>Review page {useParams().prId}</p>
}
function renderInbox(search = '') {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  return render(
    <QueryClientProvider client={qc}>
      <MemoryRouter initialEntries={[`/workspaces/ws1/reviews${search}`]}>
        <Routes>
          <Route path="/workspaces/:wsId/reviews" element={<><WorkspaceReviewsInbox wsId="ws1" /><Where /></>} />
          <Route path="/workspaces/:wsId/reviews/:prId" element={<ReviewPage />} />
        </Routes>
      </MemoryRouter>
    </QueryClientProvider>,
  )
}
const queues_ = () => screen.getByRole('navigation', { name: 'Review queues' })
const queueButton = (name: RegExp) => within(queues_()).getByRole('button', { name })
const lastAsked = () => api.getReviewInbox.mock.calls.at(-1)![1] as ReviewInboxParams

describe('WorkspaceReviewsInbox', () => {
  it('opens on what needs your review, with each queue’s count and a dot where something is unread', async () => {
    renderInbox()
    expect(await screen.findByText('Tidy owners · Sales')).toBeInTheDocument()
    expect(screen.getByText('Rename regions · Ops')).toBeInTheDocument()
    expect(lastAsked()).toMatchObject({ queue: 'needs_review', sort: 'activity', offset: 0 })
    const needs = queueButton(/Needs your review/)
    expect(needs).toHaveAttribute('aria-current', 'true')
    expect(needs).toHaveTextContent('2')
    expect(within(needs).getByRole('img', { name: 'Unread' })).toBeInTheDocument()
    const waiting = queueButton(/Waiting on reviewers/)
    expect(waiting).toHaveTextContent('1')
    expect(within(waiting).queryByRole('img', { name: 'Unread' })).not.toBeInTheDocument()
    expect(queueButton(/Merged & closed/)).toHaveTextContent('4')
  })

  it('with nothing to review, opens on your own requests that have something, else everything open', async () => {
    counts = tally({ waiting: 1, open: 3 })
    const { unmount } = renderInbox()
    expect(await screen.findByText('My draft · Sales')).toBeInTheDocument()
    expect(queueButton(/Waiting on reviewers/)).toHaveAttribute('aria-current', 'true')
    unmount()

    counts = tally({ open: 3 })
    renderInbox()
    expect(await screen.findByText('Rename regions · Sales')).toBeInTheDocument()
    expect(queueButton(/Everything open/)).toHaveAttribute('aria-current', 'true')
  })

  it('opens the queue the address names, and a queue picked goes in the address', async () => {
    renderInbox('?queue=done')
    expect(await screen.findByText('Old one · Sales')).toBeInTheDocument()
    expect(lastAsked().queue).toBe('done')
    fireEvent.click(queueButton(/Everything open/))
    expect(await screen.findByText('My draft · Sales')).toBeInTheDocument()
    expect(lastAsked().queue).toBe('open')
    expect(screen.getByTestId('where')).toHaveTextContent('?queue=open')
  })

  it('asks the server for what is searched and filtered', async () => {
    renderInbox()
    await screen.findByText('Tidy owners · Sales')
    fireEvent.change(screen.getByRole('textbox', { name: 'Search reviews' }), { target: { value: ' owners ' } })
    await waitFor(() => expect(lastAsked()).toMatchObject({ queue: 'needs_review', q: 'owners' }))
    fireEvent.click(screen.getByRole('button', { name: /Data source:/ }))
    fireEvent.click(screen.getByRole('button', { name: 'Ops' }))
    await waitFor(() => expect(lastAsked()).toMatchObject({ q: 'owners', dataSourceId: 'ds2' }))
    fireEvent.click(screen.getByRole('radio', { name: 'Opened' }))
    await waitFor(() => expect(lastAsked()).toMatchObject({ sort: 'created' }))
  })

  it('reads the next page on Load more', async () => {
    queues.open = Array.from({ length: 30 }, (_, i) => pr(`pr_${i}`, `Review ${i}`))
    renderInbox('?queue=open')
    expect(await screen.findByText('Review 24 · Sales')).toBeInTheDocument()
    expect(screen.queryByText('Review 25 · Sales')).not.toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: /Load more/ }))
    expect(await screen.findByText('Review 29 · Sales')).toBeInTheDocument()
    expect(lastAsked()).toMatchObject({ queue: 'open', offset: 25 })
    expect(screen.queryByRole('button', { name: /Load more/ })).not.toBeInTheDocument()
  })

  it('opens a review’s page from its row, or with j / k and Enter', async () => {
    const { unmount } = renderInbox()
    fireEvent.click(await screen.findByText('Rename regions · Ops'))
    expect(await screen.findByText('Review page pr_2')).toBeInTheDocument()
    unmount()

    renderInbox()
    await screen.findByText('Tidy owners · Sales')
    fireEvent.keyDown(document.body, { key: 'j' })
    expect(screen.getByText('Tidy owners · Sales')).toHaveFocus()
    fireEvent.keyDown(document.activeElement!, { key: 'j' })
    expect(screen.getByText('Rename regions · Ops')).toHaveFocus()
    fireEvent.keyDown(document.activeElement!, { key: 'k' })
    expect(screen.getByText('Tidy owners · Sales')).toHaveFocus()
    fireEvent.keyDown(document.activeElement!, { key: 'Enter' })
    expect(await screen.findByText('Review page pr_1')).toBeInTheDocument()
  })

  it('still opens the quick peek an older ?pr= link names, and closing it leaves the address', async () => {
    renderInbox('?queue=open&pr=pr_9')
    expect(screen.getByRole('dialog', { name: 'Peek' })).toHaveTextContent('Peek pr_9')
    fireEvent.click(screen.getByRole('button', { name: 'Close peek' }))
    expect(screen.queryByRole('dialog', { name: 'Peek' })).not.toBeInTheDocument()
    expect(screen.getByTestId('where')).toHaveTextContent('?queue=open')
    expect(screen.getByTestId('where')).not.toHaveTextContent('pr=')
  })

  it('says what an empty queue is for, and when the oldest reviews are left out', async () => {
    counts = tally({ needs_review: 0, open: 3 }, {}, true)
    queues.needs_review = []
    renderInbox('?queue=needs_review')
    expect(await screen.findByText('Nothing needs your review')).toBeInTheDocument()
    expect(screen.getByRole('note')).toHaveTextContent(/More than 1,000 reviews/)
  })
})
