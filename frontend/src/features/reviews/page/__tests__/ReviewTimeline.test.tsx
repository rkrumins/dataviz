/**
 * What happened on a review, oldest first, with the draft's revisions between: who was asked, asked
 * again and no longer asked, one line each, by name; each review given as a card with its verdict,
 * summary and tally; merged, naming the commit only when the merge landed on main.
 */
import { describe, it, expect, vi } from 'vitest'
import { render, screen, within } from '@testing-library/react'
import type { PullRequest, ReviewEvents } from '@/services/versioningApiService'

const state = vi.hoisted(() => ({ events: undefined as unknown, error: false }))
vi.mock('@/features/versioning/hooks/useVersioning', () => ({
  useReviewEvents: () => ({ data: state.events, isError: state.error, refetch: vi.fn() }),
  useCommitLog: (_ws: string, graphId: string | null) => ({
    data: graphId ? { commits: [{ commit_id: 'c1', message: 'Owners moved', created_at: '2026-11-02T10:00:00Z' }] } : undefined,
  }),
}))
vi.mock('@/features/versioning/components/CommitRow', () => ({
  CommitRow: ({ commit }: { commit: { message: string } }) => <li>Revision: {commit.message}</li>,
}))

import { ReviewTimeline } from '../ReviewTimeline'

const EVENTS: ReviewEvents = {
  events: [
    { kind: 'opened', actor: 'u_ana', at: '2026-11-01T09:00:00Z', subjects: [], groups: [] },
    { kind: 'requested', actor: 'u_ana', at: '2026-11-01T09:00:01Z', subjects: [{ type: 'user', id: 'u_bob' }, { type: 'group', id: 'g_fin' }], groups: [] },
    { kind: 'reviewed', actor: 'u_bob', at: '2026-11-02T09:00:00Z', verdict: 'request_changes', body: 'Use ISO codes',
      subjects: [], groups: [], tally: { accepted: 3, rejected: 1, threads: 2 } },
    { kind: 're_requested', actor: 'u_ana', at: '2026-11-02T11:00:00Z', subjects: [{ type: 'user', id: 'u_bob' }], groups: [] },
    { kind: 'unrequested', actor: 'u_ana', at: '2026-11-02T12:00:00Z', subjects: [{ type: 'user', id: 'u_cy' }], groups: [] },
    { kind: 'reviewed', actor: 'u_dee', at: '2026-11-03T09:00:00Z', verdict: 'approve', subjects: [], groups: ['g_fin'],
      tally: { accepted: 0, rejected: 0, threads: 0 } },
    { kind: 'merged', actor: 'u_ana', at: '2026-11-03T10:00:00Z', subjects: [], groups: [] },
  ],
  userNames: { u_ana: 'Ana', u_bob: 'Bob', u_cy: 'Cy', u_dee: 'Dee' },
  groupNames: { g_fin: 'Finance stewards' },
}
const pr = (over: Partial<PullRequest> = {}): PullRequest => ({
  prId: 'pr_1', graphId: 'g1', targetGraphId: 'g1', sourceBranchId: 'br_1', targetBranch: 'main', status: 'merged',
  createdAt: '2026-11-01T09:00:00Z', updatedAt: '2026-11-03T10:00:00Z', actor: 'u_ana', ...over,
})

describe('ReviewTimeline', () => {
  it('tells what happened, oldest first, with the draft’s revisions between', () => {
    state.events = EVENTS
    render(<ReviewTimeline wsId="ws1" pr={pr()} />)
    const items = within(screen.getByRole('list', { name: 'What happened' })).getAllByRole('listitem')
    const expected = [
      /Opened by Ana/, /Ana asked Bob and Finance stewards to review/, /Bob.*Asked for changes/, /Revision: Owners moved/,
      /Ana asked Bob again/, /Ana no longer asks Cy/, /Dee.*Approved/, /Merged by Ana/,
    ]
    expect(items).toHaveLength(expected.length)
    items.forEach((li, i) => expect(li).toHaveTextContent(expected[i]))
  })

  it('shows each review given as a card: verdict, summary and tally', () => {
    state.events = EVENTS
    render(<ReviewTimeline wsId="ws1" pr={pr()} />)
    const bob = screen.getByRole('article', { name: 'Bob: Asked for changes' })
    expect(within(bob).getByText('Use ISO codes')).toBeInTheDocument()
    expect(within(bob).getByText('accepted 3 · rejected 1 · 2 threads')).toBeInTheDocument()
    const dee = screen.getByRole('article', { name: 'Dee: Approved' })
    expect(within(dee).getByText('for Finance stewards')).toBeInTheDocument()
    expect(within(dee).queryByText(/accepted/)).toBeNull()
  })

  it('names the commit a merge landed on main as, and nothing for one that changed nothing', () => {
    state.events = EVENTS
    // Merged on an older server, changing nothing: it recorded its draft's own head, not on main.
    const { unmount } = render(<ReviewTimeline wsId="ws1" pr={pr({ resultingCommitId: 'cmt_drafthead', resultingCommitSeq: null })} />)
    expect(screen.getByText('Merged by Ana')).toBeInTheDocument()
    unmount()
    render(<ReviewTimeline wsId="ws1" pr={pr({ resultingCommitId: 'cmt_squash1', resultingCommitSeq: 12 })} />)
    expect(screen.getByText('Merged by Ana · cmt_squa')).toBeInTheDocument()
  })

  it('a fork’s review has no draft revisions to show', () => {
    state.events = EVENTS
    render(<ReviewTimeline wsId="ws1" pr={pr({ graphId: 'g_fork' })} />)
    expect(screen.queryByText(/Revision:/)).toBeNull()
  })

  it('says when what happened could not be read', () => {
    state.events = undefined
    state.error = true
    render(<ReviewTimeline wsId="ws1" pr={pr()} />)
    expect(screen.getByText(/Couldn’t read what happened/)).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Try again' })).toBeInTheDocument()
    state.error = false
  })
})
