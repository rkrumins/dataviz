/**
 * Approve all: a reviewer accepts every change still to decide, approves, and merges — one click,
 * asked first — where nothing but their approval holds it; with someone else's approval awaited,
 * it approves all without merging; with anything rejected, it isn't offered (that review merges
 * what is accepted).
 */
import { render, screen, fireEvent, waitFor } from '@testing-library/react'
import { MemoryRouter } from 'react-router-dom'
import { describe, it, expect, vi, beforeEach } from 'vitest'

const calls: string[] = []
const mergeMutateAsync = vi.fn()
const approveMutateAsync = vi.fn()
const decideMutateAsync = vi.fn()
const idle = { mutate: vi.fn(), mutateAsync: vi.fn(), isPending: false }
const state = vi.hoisted(() => ({ summary: undefined as unknown, reviewers: ['u_me'] as string[] }))

vi.mock('@tanstack/react-query', async (orig) => ({
  ...(await orig<typeof import('@tanstack/react-query')>()),
  useQueryClient: () => ({ invalidateQueries: vi.fn() }),
}))
vi.mock('../decisions/useReviewDecisions', () => ({
  DECISION_KEYS: { all: (...a: unknown[]) => ['reviewDecisions', ...a] },
  useReviewDecisionSummary: () => ({ data: state.summary }),
  useDecideChanges: () => ({ mutate: vi.fn(), mutateAsync: decideMutateAsync, isPending: false }),
}))
vi.mock('../comments/ReviewDiscussion', () => ({ ReviewDiscussion: () => null }))
vi.mock('../comments/useReviewComments', () => ({ useReviewCommentCounts: () => ({ data: undefined }) }))
vi.mock('../../versioning/components/ChangeList', () => ({ ChangeList: () => null }))
vi.mock('../../versioning/components/ChangeTreePanel', () => ({ ChangeTreePanel: () => null }))
vi.mock('../../versioning/hooks/useVersioning', () => ({
  useMergeRequest: () => ({
    data: {
      prId: 'pr_1', graphId: 'g1', targetGraphId: 'g1', sourceBranchId: 'br_1', targetBranch: 'main', status: 'mergeable',
      actor: 'u_author', title: 'Tidy', reviewers: state.reviewers, approvedBy: [], behind: false, headCommitId: 'c9',
      viewerCan: { approve: true, merge: true, approveReason: null, mergeReason: null, decide: true },
    },
    isLoading: false,
    refetch: vi.fn(),
  }),
  useChangeSummary: () => ({ data: undefined, isFetching: false }),
  usePrDiffSummary: () => ({ data: undefined, isFetching: false }),
  VERSIONING_KEYS: {
    changeList: (...a: unknown[]) => ['changeList', ...a],
    prDiffSummary: (...a: unknown[]) => ['prDiffSummary', ...a],
  },
  usePullLatestDraft: () => idle,
  useCommitLog: () => ({ data: undefined }),
  useApproveMergeRequest: () => ({ ...idle, mutateAsync: approveMutateAsync }),
  useCloseMergeRequest: () => idle,
  useMergeMergeRequest: () => ({ ...idle, mutateAsync: mergeMutateAsync }),
  useUpdateMergeRequest: () => idle,
  useRequestChanges: () => idle,
  useWithdrawChangesRequest: () => idle,
  useDiscardRejected: () => idle,
  useBranchViewChanges: () => ({ data: undefined }),
}))
vi.mock('@/store/auth', () => ({
  usePermission: () => true,
  useAuthStore: (sel: (s: unknown) => unknown) => sel({ user: { id: 'u_me' } }),
}))
vi.mock('@/store/features', () => ({ useFeature: () => true }))
vi.mock('@/components/ui/notifications', () => ({ useAppNotifications: () => ({ notify: vi.fn() }) }))
vi.mock('@/store/branchStore', () => ({
  useBranchStore: (sel: (s: unknown) => unknown) => sel({ switchToMain: vi.fn() }),
}))
vi.mock('@/store/publishReceiptStore', () => ({
  usePublishReceiptStore: (sel: (s: unknown) => unknown) => sel({ setReceipt: vi.fn() }),
}))

import { PrDetailDrawer } from '../components/PrDetailDrawer'

const summary = (over = {}) => ({
  total: 5, accepted: 2, rejected: 0, stale: 1, undecided: 2, missing: 0, missingIds: [], headCommitId: 'c9', ...over,
})
const open = () => render(<MemoryRouter><PrDetailDrawer wsId="ws1" prId="pr_1" onClose={vi.fn()} /></MemoryRouter>)

beforeEach(() => {
  calls.length = 0
  state.reviewers = ['u_me']
  decideMutateAsync.mockReset().mockImplementation(async () => { calls.push('decide'); return { decided: 3 } })
  approveMutateAsync.mockReset().mockImplementation(async () => { calls.push('approve'); return {} })
  mergeMutateAsync.mockReset().mockImplementation(async () => { calls.push('merge'); return { commitId: 'c10', outcome: 'published' } })
  vi.spyOn(window, 'confirm').mockReturnValue(true)
})

describe('PrDetailDrawer — approve all', () => {
  it('accepts what is still to decide, approves and merges, in one click', async () => {
    state.summary = summary()
    open()
    fireEvent.click(screen.getByRole('button', { name: 'Approve all & merge' }))
    await waitFor(() => expect(calls).toEqual(['decide', 'approve', 'merge']))
    expect(window.confirm).toHaveBeenCalledWith('Accept the 3 of 5 changes still to decide, approve, and merge into main?')
    expect(decideMutateAsync).toHaveBeenCalledWith(
      { verdict: 'accepted', filter: { decision: 'undecided' }, expectedHeadCommitId: 'c9' })
    expect(approveMutateAsync).toHaveBeenCalledWith({ prId: 'pr_1', graphId: 'g1', expectedHeadCommitId: 'c9' })
    expect(mergeMutateAsync).toHaveBeenCalledWith(expect.objectContaining({ prId: 'pr_1', mode: 'all' }))
  })

  it('does nothing unless asked to go ahead, and stops where a step is refused', async () => {
    state.summary = summary()
    vi.mocked(window.confirm).mockReturnValue(false)
    open()
    fireEvent.click(screen.getByRole('button', { name: 'Approve all & merge' }))
    expect(calls).toEqual([])
    vi.mocked(window.confirm).mockReturnValue(true)
    approveMutateAsync.mockRejectedValueOnce(new Error('no'))
    fireEvent.click(screen.getByRole('button', { name: 'Approve all & merge' }))
    await waitFor(() => expect(approveMutateAsync).toHaveBeenCalled())
    expect(calls).toEqual(['decide'])                    // not merged
  })

  it('approves all without merging while someone else’s approval is awaited', async () => {
    state.summary = summary()
    state.reviewers = ['u_me', 'u_bob']
    open()
    fireEvent.click(screen.getByRole('button', { name: 'Approve all' }))
    await waitFor(() => expect(calls).toEqual(['decide', 'approve']))
    expect(screen.getByRole('button', { name: 'Merge 2 accepted' })).toBeInTheDocument()
  })

  it('is not offered where something was rejected', () => {
    state.summary = summary({ rejected: 1, undecided: 1 })
    open()
    expect(screen.queryByRole('button', { name: /Approve all/ })).not.toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Approve' })).toBeInTheDocument()
  })
})
