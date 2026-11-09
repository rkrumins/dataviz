/**
 * ViewHistoryTimeline — a history of revisions, newest first, a page at a time, grouped by month and
 * day. A commit row expands to its hierarchical diff, fetched only then. With the revision viewer on,
 * a revision of Published opens on the canvas — asked first whether it can, so one too far back to
 * draw opens its comparison with now instead — and the timeline pages on as it nears its end. While a
 * revision is open, a row's "since then" counts up to the head it was opened at.
 */
import { act, render, screen, fireEvent, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import type { ReactNode } from 'react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { DiffSummaryResponse } from '@/services/versioningApiService'
import { useBranchStore } from '@/store/branchStore'
import { useStagedChangesStore } from '@/store/stagedChangesStore'

// jsdom has no layout: lay every item out, so the timeline's rows and its paging run.
vi.mock('@tanstack/react-virtual', () => ({
  useVirtualizer: (opts: { count: number; getItemKey?: (i: number) => string | number }) => ({
    getVirtualItems: () => Array.from({ length: opts.count }, (_, index) => ({
      index, key: opts.getItemKey ? opts.getItemKey(index) : index, start: index * 40, size: 40,
    })),
    getTotalSize: () => opts.count * 40,
    measureElement: () => undefined,
    scrollToIndex: vi.fn(),
  }),
}))

const SUMMARY: DiffSummaryResponse = {
  groups: [{
    key: 'DOM', kind: 'container', label: 'Sales', entityType: 'Dataset', status: 'unchanged',
    counts: { added: 1, modified: 0, removed: 0 }, childTotal: 1, deleted: false,
  }],
  groupTotal: 1,
  counts: { added: 1, modified: 0, removed: 0 },
  impact: { Dataset: 1, Table: 1 },
}

const COMMITS = [
  { commit_id: 'cmt_9', commit_seq: 9, message: 'Quarter close', actor: 'usr_abc123', created_at: '2026-10-31T17:42:00Z', stats: { update: 2 } },
  { commit_id: 'cmt_2', commit_seq: 2, message: 'Add Sales dataset', actor: 'usr_abc123', created_at: '2026-09-02T09:00:00Z', stats: { create: 1 } },
]

const state = vi.hoisted(() => ({
  revisionOn: false,
  hasNextPage: false,
  fetchNextPage: vi.fn(),
  plan: { openable: true, reason: null as string | null },
  since: [] as unknown[],
}))

const useCommitDiffSummary = vi.fn((_ws?: string, _gid?: string | null, cid?: string | null) => ({
  data: cid ? SUMMARY : undefined,
  isLoading: false,
}))

vi.mock('../../hooks/useVersioning', () => ({
  VERSIONING_KEYS: { revision: (ws?: string, gid?: string | null, seq?: number | null) => ['versioning', 'revision', ws, gid, seq] },
  useHistoryPages: () => ({
    data: { pages: [{ commits: COMMITS, userNames: { usr_abc123: 'Ana Lee' }, hasMore: state.hasNextPage }] },
    isLoading: false,
    hasNextPage: state.hasNextPage,
    isFetchingNextPage: false,
    fetchNextPage: state.fetchNextPage,
  }),
  useHistoryMonths: () => ({
    data: { headSeq: 9, tz: 'UTC', months: [
      { month: '2026-09', count: 4, firstSeq: 2, lastSeq: 5, days: [] },
      { month: '2026-10', count: 12, firstSeq: 6, lastSeq: 9, days: [] },
    ] },
    isLoading: false,
  }),
  useCommitDiffSummary: (ws?: string, gid?: string | null, cid?: string | null) => useCommitDiffSummary(ws, gid, cid),
  useSquashedCommits: () => ({ data: undefined, isLoading: false }),
  useRevision: () => ({ data: { openable: state.plan.openable, reason: state.plan.reason, changedSince: 40, limit: 100_000 }, isLoading: false }),
  useChangeSummary: (_ws?: string, _gid?: string | null, origin?: unknown) => {
    state.since.push(origin)
    return { data: undefined, isLoading: false }
  },
  // The timeline hosts the rollback dialogs (revert / restore-to-here).
  useRevertCommit: () => ({ mutate: vi.fn(), isPending: false }),
  useRestoreCommit: () => ({ mutate: vi.fn(), isPending: false }),
  useRestorePreview: () => ({ data: undefined, isLoading: false }),
}))
vi.mock('../../hooks/useRevisionViewer', () => ({ useRevisionViewer: () => state.revisionOn }))
vi.mock('../RevisionCompare', () => ({
  RevisionCompare: (p: { from: number; to: number | null; notice?: string | null }) => (
    <p>Comparing #{p.from} with {p.to ?? 'now'}{p.notice ? ` (${p.notice})` : ''}</p>
  ),
}))

const getRevision = vi.hoisted(() => vi.fn())
vi.mock('@/services/versioningApiService', () => ({
  getCommitDiffChildren: vi.fn(),
  getRevision,
  MergeConflictError: class MergeConflictError extends Error {},
}))

import { ViewHistoryTimeline } from '../ViewHistoryTimeline'

function wrap(ui: ReactNode) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  return render(<QueryClientProvider client={qc}>{ui}</QueryClientProvider>)
}

beforeEach(() => {
  state.revisionOn = false
  state.hasNextPage = false
  state.plan = { openable: true, reason: null }
  state.since = []
  state.fetchNextPage.mockReset()
  getRevision.mockReset()
  useBranchStore.getState().reset()
  useStagedChangesStore.setState({ changes: [] } as never)
})

describe('ViewHistoryTimeline', () => {
  it('expands a commit to show its hierarchical diff', async () => {
    wrap(<ViewHistoryTimeline wsId="ws1" graphId="g1" viewId={null} />)

    expect(screen.getByText('Add Sales dataset')).toBeInTheDocument()
    expect(useCommitDiffSummary).not.toHaveBeenCalledWith('ws1', 'g1', 'cmt_2')

    fireEvent.click(screen.getByText('Add Sales dataset'))

    expect(useCommitDiffSummary).toHaveBeenCalledWith('ws1', 'g1', 'cmt_2')
    expect(await screen.findByText(/1 change/i)).toBeInTheDocument()
    expect(screen.getByText('Sales')).toBeInTheDocument()
  })

  it('resolves the commit actor to its userNames display name, never the raw id', () => {
    wrap(<ViewHistoryTimeline wsId="ws1" graphId="g1" viewId={null} />)

    expect(screen.getAllByText('Ana Lee').length).toBeGreaterThan(0)
    expect(screen.queryByText('usr_abc123')).not.toBeInTheDocument()
  })

  it('groups revisions by month, with how many each month saw', () => {
    wrap(<ViewHistoryTimeline wsId="ws1" graphId="g1" viewId={null} />)

    expect(screen.getAllByText('October 2026').length).toBeGreaterThan(0)
    expect(screen.getByText('September 2026')).toBeInTheDocument()
    expect(screen.getAllByText('12 revisions').length).toBeGreaterThan(0)
  })

  it('pages on as it nears the end of what it has', () => {
    state.hasNextPage = true
    wrap(<ViewHistoryTimeline wsId="ws1" graphId="g1" viewId={null} />)
    expect(state.fetchNextPage).toHaveBeenCalled()
  })

  it('offers no time travel with the preview off', async () => {
    wrap(<ViewHistoryTimeline wsId="ws1" graphId="g1" viewId={null} />)
    expect(screen.queryByLabelText('Go to a month')).not.toBeInTheDocument()
    expect(screen.queryByLabelText('Revision actions')).not.toBeInTheDocument()
  })

  it('opens a past revision on the canvas, and gets out of the way', async () => {
    state.revisionOn = true
    getRevision.mockResolvedValue({ openable: true, reason: null, commit: COMMITS[1], headSeq: 9, changedSince: 40, limit: 100_000 })
    const onNavigate = vi.fn()
    const user = userEvent.setup()
    wrap(<ViewHistoryTimeline wsId="ws1" graphId="g1" viewId={null} onNavigate={onNavigate} />)

    expect(screen.getByLabelText('Go to a month')).toBeInTheDocument()
    await user.click(screen.getAllByLabelText('Revision actions')[1])
    await user.click(await screen.findByText('Open on canvas'))

    await waitFor(() => expect(useBranchStore.getState().revision).toMatchObject({ seq: 2, message: 'Add Sales dataset' }))
    expect(getRevision).toHaveBeenCalledWith('ws1', 'g1', 2)
    expect(onNavigate).toHaveBeenCalled()
  })

  it('compares a revision too far back to draw with now, instead of opening it', async () => {
    state.revisionOn = true
    getRevision.mockResolvedValue({ openable: false, reason: 'too_far', commit: COMMITS[1], headSeq: 9, changedSince: 200_002, limit: 100_000 })
    const user = userEvent.setup()
    wrap(<ViewHistoryTimeline wsId="ws1" graphId="g1" viewId={null} />)

    await user.click(screen.getAllByLabelText('Revision actions')[1])
    await user.click(await screen.findByText('Open on canvas'))

    expect(await screen.findByText('Comparing #2 with now (too_far)')).toBeInTheDocument()
    expect(useBranchStore.getState().revision).toBeNull()
  })

  it('holds opening back while edits are unsaved, saying so', async () => {
    state.revisionOn = true
    useStagedChangesStore.setState({ changes: [{ id: 'chg_1' }] } as never)
    const user = userEvent.setup()
    wrap(<ViewHistoryTimeline wsId="ws1" graphId="g1" viewId={null} />)

    await user.click(screen.getAllByLabelText('Revision actions')[1])
    expect(await screen.findByText('Save or discard your unsaved edits first.')).toBeInTheDocument()
    expect(screen.getByText('Open on canvas').closest('[role="menuitem"]')).toHaveAttribute('data-disabled')
    expect(getRevision).not.toHaveBeenCalled()
  })

  it("counts a row's since then up to the head an open revision was opened at, until it is updated", () => {
    state.revisionOn = true
    wrap(<ViewHistoryTimeline wsId="ws1" graphId="g1" viewId={null} />)
    fireEvent.click(screen.getByText('Add Sales dataset'))
    expect(state.since.at(-1)).toEqual({ fromSeq: 2, toSeq: 9 })            // Published's head
    expect(screen.queryByText(/Published has moved on/)).not.toBeInTheDocument()

    act(() => useBranchStore.getState().openRevision({ seq: 2, headAtOpen: 7 }))
    expect(state.since.at(-1)).toEqual({ fromSeq: 2, toSeq: 7 })
    expect(screen.getByText('Published has moved on: 2 newer revisions')).toBeInTheDocument()

    fireEvent.click(screen.getByRole('button', { name: 'Update' }))
    expect(useBranchStore.getState().revision?.headAtOpen).toBe(9)
    expect(state.since.at(-1)).toEqual({ fromSeq: 2, toSeq: 9 })
    expect(screen.queryByText(/Published has moved on/)).not.toBeInTheDocument()
  })

  it('opens on a comparison it is asked for', () => {
    state.revisionOn = true
    wrap(<ViewHistoryTimeline wsId="ws1" graphId="g1" viewId={null} compare={{ fromSeq: 3, toSeq: null }} />)
    expect(screen.getByText('Comparing #3 with now')).toBeInTheDocument()
  })
})
