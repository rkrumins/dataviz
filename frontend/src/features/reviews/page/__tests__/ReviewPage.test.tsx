/**
 * The review page: its three regions; a change or a thread opened by link (`?change=`, `?thread=` —
 * one on the review as a whole opens the Discussion); the keys that move through the changes (j / k,
 * n / p to what still needs you, round to the start, ⇧N / ⇧P to open threads); a fork's review,
 * which is not decided change by change; a review that isn't there; and looking at one marks it
 * seen, again as it changes.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { MemoryRouter, Route, Routes, useLocation } from 'react-router-dom'
import type { ChangeListRow, ChangeListSummary, PullRequest, ReviewThread } from '@/services/versioningApiService'

vi.mock('@tanstack/react-virtual', () => ({
  useVirtualizer: (opts: { count: number; getItemKey?: (i: number) => string | number }) => ({
    getVirtualItems: () => Array.from({ length: opts.count }, (_, index) => ({
      index, key: opts.getItemKey ? opts.getItemKey(index) : index, start: index * 54, size: 54,
    })),
    getTotalSize: () => opts.count * 54,
    measureElement: () => undefined,
    scrollToIndex: () => undefined,
  }),
}))
const api = vi.hoisted(() => ({
  getMergeRequest: vi.fn(), getChangeSummary: vi.fn(), getChangeEntries: vi.fn(), getChangeEntry: vi.fn(),
  listReviewChanges: vi.fn(), getReviewDecisionSummary: vi.fn(), getReviewCommentCounts: vi.fn(),
  listReviewThreads: vi.fn(), getMergeRequestDiffSummary: vi.fn(), markReviewSeen: vi.fn(),
}))
vi.mock('@/services/versioningApiService', async (orig) => ({
  ...(await orig<typeof import('@/services/versioningApiService')>()),
  ...api,
}))
vi.mock('@/store/auth', () => ({
  usePermission: () => true,
  useAuthStore: (sel: (s: unknown) => unknown) => sel({ user: { id: 'u_me' } }),
}))
vi.mock('@/store/features', () => ({ useFeature: () => true }))
vi.mock('@/components/ui/notifications', () => ({ useAppNotifications: () => ({ notify: vi.fn() }) }))

import { WorkspaceReviewPage } from '@/pages/WorkspaceReviewPage'
import { usePreferencesStore } from '@/store/preferences'

const NONE = { added: 0, modified: 0, removed: 0 }
const summary: ChangeListSummary = {
  origin: { branchId: 'br_1' }, counts: { ...NONE, modified: 3 }, entityCounts: { ...NONE, modified: 3 },
  edgeCounts: NONE, structureCounts: NONE, impact: { Table: 3 },
  byType: [{ kind: 'node', type: 'Table', added: 0, modified: 3, removed: 0 }],
  total: 3, listed: 3, approximate: false, tooLarge: null, window: null,
}
const NAMES: Record<string, string> = { T1: 'Orders', T2: 'Sales', T3: 'Customers' }
const row = (entityId: string): ChangeListRow => ({
  entityId, kind: 'node', status: 'modified', type: 'Table', structural: false, displayName: NAMES[entityId],
  fields: { changed: 1, added: 0, removed: 0, total: 1, top: [{ label: 'owner', kind: 'changed', before: 'ana', after: 'bo' }] },
})
const accepted = { verdict: 'accepted', actor: 'u_bob', at: '2026-11-02T00:00:00Z', stale: false, impliedBy: null, reason: null }
const thread = (id: string, entityId: string | null, body: string): ReviewThread => ({
  id, threadId: id, entityId, path: null, body, mentions: [], author: 'u_bob', createdAt: '2026-11-02T00:00:00Z',
  editedAt: null, deleted: false, resolvedAt: null, resolvedBy: null, replies: [], outdated: false,
})
const THREADS = [thread('th_c', 'T3', 'Who owns this now?'), thread('th_r', null, 'Ship it after the freeze')]
const draftPr = (over: Partial<PullRequest> = {}): PullRequest => ({
  prId: 'pr_1', graphId: 'g1', targetGraphId: 'g1', sourceBranchId: 'br_1', targetBranch: 'main', status: 'open',
  actor: 'u_ana', title: 'Tidy owners', description: 'Owners moved to the new teams.', reviewers: ['u_me'], approvedBy: [],
  headCommitId: 'c9', behind: false, createdAt: '2026-11-01T00:00:00Z', updatedAt: '2026-11-01T00:00:00Z',
  userNames: { u_ana: 'Ana', u_bob: 'Bob', u_me: 'Me' },
  viewerCan: { approve: true, merge: true, approveReason: null, mergeReason: null, decide: true, comment: true },
  ...over,
})

beforeEach(() => {
  window.localStorage.clear()
  Object.values(api).forEach((f) => f.mockReset())
  usePreferencesStore.setState({ changeListLayout: 'list' })
  api.getMergeRequest.mockResolvedValue(draftPr())
  api.markReviewSeen.mockResolvedValue(undefined)
  api.getChangeSummary.mockResolvedValue(summary)
  const page = (entries: unknown[]) => ({ entries, total: entries.length, offset: 0, limit: 100, hasMore: false })
  api.listReviewChanges.mockResolvedValue(page([{ ...row('T1'), decision: accepted }, { ...row('T2'), decision: null }, { ...row('T3'), decision: null }]))
  api.getChangeEntries.mockResolvedValue(page([row('T1'), row('T2')]))
  api.getReviewDecisionSummary.mockResolvedValue({ total: 3, accepted: 1, rejected: 0, stale: 0, undecided: 2, missing: 0, missingIds: [], headCommitId: 'c9' })
  api.getReviewCommentCounts.mockResolvedValue({ entities: { T3: { open: 1, total: 1 } }, general: { open: 1, total: 1 }, open: 2 })
  api.listReviewThreads.mockImplementation((_ws, _pr, filter: { threadId?: string; entityId?: string }) => {
    const threads = THREADS.filter((t) => (filter.threadId ? t.id === filter.threadId : filter.entityId ? t.entityId === filter.entityId : true))
    return Promise.resolve({ threads, total: threads.length, offset: 0, limit: 20, hasMore: false, userNames: { u_bob: 'Bob' } })
  })
  api.getChangeEntry.mockImplementation((_ws, _g, _o, id: string) => Promise.resolve({
    entityId: id, kind: 'node', status: 'modified',
    before: { displayName: NAMES[id], owner: 'ana' }, after: { displayName: NAMES[id], owner: 'bo' },
  }))
})

function Where() {
  const { search } = useLocation()
  return <div data-testid="where">{search}</div>
}
function renderPage(search = '', qc = new QueryClient({ defaultOptions: { queries: { retry: false } } })) {
  return render(
    <QueryClientProvider client={qc}>
      <MemoryRouter initialEntries={[`/workspaces/ws1/reviews/pr_1${search}`]}>
        <Routes>
          <Route path="/workspaces/:wsId/reviews/:prId" element={<><WorkspaceReviewPage /><Where /></>} />
          <Route path="/workspaces/:wsId/reviews" element={<p>The reviews</p>} />
        </Routes>
      </MemoryRouter>
    </QueryClientProvider>,
  )
}
const pane = () => screen.getByRole('main', { name: 'The change open' })
const side = () => screen.getByRole('complementary', { name: 'Where it stands' })
const press = (key: string, opts: Partial<KeyboardEventInit> = {}) => fireEvent.keyDown(document.body, { key, ...opts })
const openIs = async (name: string) => {
  const main = await screen.findByRole('main', { name: 'The change open' })
  expect(await within(main).findByRole('heading', { name })).toBeInTheDocument()
}

describe('ReviewPage', () => {
  it('lays out the changes, the change open and where the review stands', async () => {
    renderPage()
    expect(await screen.findByRole('heading', { name: 'Tidy owners' })).toBeInTheDocument()
    expect(screen.getByRole('link', { name: /Reviews/ })).toHaveAttribute('href', '/workspaces/ws1/reviews')
    const changes = screen.getByRole('complementary', { name: 'Changes' })
    expect(await within(changes).findByText('Orders')).toBeInTheDocument()
    expect(within(changes).getByText(/of 3 viewed/)).toBeInTheDocument()
    expect(within(pane()).getByText('Pick a change to review it')).toBeInTheDocument()
    expect(within(pane()).getByText('Owners moved to the new teams.')).toBeInTheDocument()
    expect(within(side()).getByText('Give your verdict')).toBeInTheDocument()
    expect(within(side()).getByRole('tab', { name: 'Discussion' })).toHaveAttribute('aria-selected', 'true')
    // A requested reviewer who hasn't approved, nothing rejected, only their approval awaited:
    // Approve all & merge, with Send back beside it.
    const header = screen.getByRole('banner', { name: 'This review' })
    expect(within(header).getByRole('button', { name: 'Approve all & merge' })).toBeInTheDocument()
    expect(within(header).getByRole('button', { name: 'Send back' })).toBeInTheDocument()
  })

  it('picking a change in the list opens it beside the list, and the address says which', async () => {
    renderPage()
    fireEvent.click(await screen.findByText('Sales'))
    await openIs('Sales')
    expect(screen.getByTestId('where')).toHaveTextContent('?change=T2')
  })

  it('opens the change a link names', async () => {
    renderPage('?change=T2')
    await openIs('Sales')
    expect(await within(pane()).findByRole('button', { name: 'Mark Sales viewed' })).toBeInTheDocument()
    expect(within(pane()).getByRole('button', { name: 'Accept Sales' })).toBeInTheDocument()
  })

  it('opens the change a linked thread is on, with the thread', async () => {
    renderPage('?thread=th_c')
    await openIs('Customers')
    expect(await within(pane()).findByText('Who owns this now?')).toBeInTheDocument()
  })

  it('a linked thread on the review as a whole opens the Discussion, and goes to it', async () => {
    const scrolled = vi.spyOn(Element.prototype, 'scrollIntoView')
    renderPage('?thread=th_r')
    await screen.findByRole('complementary', { name: 'Where it stands' })
    expect((await within(side()).findAllByText('Ship it after the freeze')).length).toBeGreaterThan(0)
    expect(within(side()).getByRole('tab', { name: 'Discussion' })).toHaveAttribute('aria-selected', 'true')
    await waitFor(() => expect(scrolled).toHaveBeenCalled())
    expect(within(pane()).getByText('Pick a change to review it')).toBeInTheDocument()
    scrolled.mockRestore()
  })

  it('j / k step through the changes', async () => {
    renderPage()
    await screen.findByText('Customers')
    press('j'); await openIs('Orders')
    press('j'); await openIs('Sales')
    press('k'); await openIs('Orders')
  })

  it('n / p go to what still needs deciding, round to the start', async () => {
    renderPage()
    await screen.findByText('Customers')
    press('n'); await openIs('Sales')       // Orders is accepted already
    press('n'); await openIs('Customers')
    press('n'); await openIs('Sales')       // round to the start
    press('p'); await openIs('Customers')
  })

  it('⇧N / ⇧P go to the changes with open threads', async () => {
    renderPage()
    await screen.findByText('Customers')
    press('N', { shiftKey: true }); await openIs('Customers')
    press('k'); await openIs('Sales')
    press('P', { shiftKey: true }); await openIs('Customers')   // back, round the end
  })

  it('ignores the keys while typing', async () => {
    renderPage()
    await screen.findByText('Customers')
    const search = screen.getByPlaceholderText(/Search by name/)
    fireEvent.keyDown(search, { key: 'j' })
    expect(within(pane()).getByText('Pick a change to review it')).toBeInTheDocument()
  })

  it('a fork’s review is not decided change by change', async () => {
    api.getMergeRequest.mockResolvedValue(draftPr({
      graphId: 'g_fork', reviewers: [],
      viewerCan: { approve: true, merge: true, approveReason: null, mergeReason: null, decide: false, decideReason: 'fork_review' },
    }))
    api.getMergeRequestDiffSummary.mockResolvedValue({
      groups: [], groupTotal: 0, counts: { ...NONE, modified: 2 }, impact: {}, list: { graphId: 'g_fork', fromSeq: 1, toSeq: 4 },
    })
    renderPage()
    const changes = await screen.findByRole('complementary', { name: 'Changes' })
    expect(await within(changes).findByText('Orders')).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: /^Accept / })).toBeNull()
    expect(screen.queryByText('Decide each change')).toBeNull()
    expect(api.listReviewChanges).not.toHaveBeenCalled()
    expect(screen.getByRole('button', { name: 'Merge' })).toBeInTheDocument()
  })

  it('a review that isn’t there says so, with the way back', async () => {
    api.getMergeRequest.mockRejectedValue(Object.assign(new Error('Not found'), { status: 404 }))
    renderPage()
    expect(await screen.findByText('This review isn’t here')).toBeInTheDocument()
    fireEvent.click(screen.getByRole('link', { name: /Back to reviews/ }))
    expect(await screen.findByText('The reviews')).toBeInTheDocument()
    expect(api.markReviewSeen).not.toHaveBeenCalled()
  })

  it('marks the review seen when it opens, and again when it changes while open', async () => {
    const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } })
    renderPage('', qc)
    expect(await screen.findByRole('heading', { name: 'Tidy owners' })).toBeInTheDocument()
    await waitFor(() => expect(api.markReviewSeen).toHaveBeenCalledTimes(1))
    expect(api.markReviewSeen).toHaveBeenCalledWith('ws1', 'pr_1')

    // Read again unchanged: nothing new to mark.
    await act(() => qc.refetchQueries({ queryKey: ['versioning', 'mr', 'ws1', 'pr_1'] }))
    expect(api.markReviewSeen).toHaveBeenCalledTimes(1)

    api.getMergeRequest.mockResolvedValue(draftPr({ updatedAt: '2026-11-02T00:00:00Z' }))
    await act(() => qc.refetchQueries({ queryKey: ['versioning', 'mr', 'ws1', 'pr_1'] }))
    await waitFor(() => expect(api.markReviewSeen).toHaveBeenCalledTimes(2))
  })
})
