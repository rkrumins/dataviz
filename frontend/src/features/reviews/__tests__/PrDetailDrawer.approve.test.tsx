/**
 * A reviewer gives their verdict on the review page: the drawer's Finish your review opens it there,
 * ready to (`?finish=1`). The verdict is of what the reviewer saw: it sends the head the review was
 * loaded at, the changes are read again when a new head arrives, and a "draft moved on" refusal
 * reloads the review and records nothing. Who may give a verdict and merge is the server's word
 * (`viewerCan`): whoever opened a review approves it where the policy lets them, and a Merge they may
 * not make says why. Without that word, the draft's owner and author are not offered it.
 */
import { act, render, renderHook, screen } from '@testing-library/react'
import { MemoryRouter } from 'react-router-dom'
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { HeadMovedError } from '@/services/versioningApiService'

const submitMutate = vi.fn()
const refetchPr = vi.fn()
const notify = vi.fn()
const idle = { mutate: vi.fn(), mutateAsync: vi.fn(), isPending: false }
let head = 'cmt_h1'
let owner = 'u_author'
let actor = 'u_author'
let viewerCan: Record<string, unknown> | undefined
let approvedBy: string[] = []
let reviewers: string[] = ['u_me']
let review: Record<string, unknown> | undefined

const { invalidateQueries } = vi.hoisted(() => ({ invalidateQueries: vi.fn() }))
vi.mock('@tanstack/react-query', async (orig) => ({
  ...(await orig<typeof import('@tanstack/react-query')>()),
  useQueryClient: () => ({ invalidateQueries }),
}))
vi.mock('../decisions/useReviewDecisions', () => ({
  DECISION_KEYS: { all: (...a: unknown[]) => ['reviewDecisions', ...a] },
  useReviewDecisionSummary: () => ({ data: undefined }),
  useDecideChanges: () => ({ mutate: vi.fn(), mutateAsync: vi.fn(), isPending: false }),
}))
vi.mock('../comments/ReviewDiscussion', () => ({ ReviewDiscussion: () => null }))
vi.mock('../comments/useReviewComments', () => ({ useReviewCommentCounts: () => ({ data: undefined }) }))
vi.mock('../../versioning/components/ChangeList', () => ({ ChangeList: () => null }))
vi.mock('../../versioning/components/ChangeTreePanel', () => ({ ChangeTreePanel: () => null }))
vi.mock('../../versioning/hooks/useVersioning', () => ({
  useMergeRequest: () => ({
    data: {
      prId: 'pr_1', graphId: 'g1', targetGraphId: 'g1', sourceBranchId: 'br_1', targetBranch: 'main', status: 'mergeable',
      actor, sourceBranchOwner: owner, title: 'Tidy', reviewers, approvedBy,
      behind: false, headCommitId: head, viewerCan, review,
    },
    isLoading: false,
    refetch: refetchPr,
  }),
  useChangeSummary: () => ({ data: undefined, isFetching: false }),
  usePrDiffSummary: () => ({ data: undefined, isFetching: false }),
  VERSIONING_KEYS: {
    changeList: (...a: unknown[]) => ['changeList', ...a],
    prDiffSummary: (...a: unknown[]) => ['prDiffSummary', ...a],
  },
  usePullLatestDraft: () => idle,
  useCommitLog: () => ({ data: undefined }),
  useApproveMergeRequest: () => idle,
  useCloseMergeRequest: () => idle,
  useMergeMergeRequest: () => idle,
  useUpdateMergeRequest: () => idle,
  useSubmitReview: () => ({ ...idle, mutate: submitMutate }),
  useWithdrawChangesRequest: () => idle,
  useDiscardRejected: () => idle,
  useBranchViewChanges: () => ({ data: undefined }),
  useRevertCommit: () => idle,
}))
vi.mock('@/store/auth', () => ({
  usePermission: () => true,
  useAuthStore: (sel: (s: unknown) => unknown) => sel({ user: { id: 'u_me' } }),
}))
vi.mock('@/store/features', () => ({ useFeature: () => true }))
vi.mock('@/components/ui/notifications', () => ({ useAppNotifications: () => ({ notify }) }))
vi.mock('@/store/branchStore', () => ({
  useBranchStore: (sel: (s: unknown) => unknown) => sel({ switchToMain: vi.fn() }),
}))
vi.mock('@/store/publishReceiptStore', () => ({
  usePublishReceiptStore: (sel: (s: unknown) => unknown) => sel({ setReceipt: vi.fn() }),
}))

import { PrDetailDrawer } from '../components/PrDetailDrawer'
import { useReviewActions } from '../hooks/useReviewActions'

const drawer = () => <MemoryRouter><PrDetailDrawer wsId="ws1" prId="pr_1" onClose={vi.fn()} /></MemoryRouter>

beforeEach(() => {
  for (const f of [submitMutate, refetchPr, invalidateQueries, notify]) f.mockReset()
  head = 'cmt_h1'
  owner = 'u_author'
  actor = 'u_author'
  viewerCan = undefined
  approvedBy = []
  reviewers = ['u_me']
  review = undefined
})

const finish = () => screen.queryByRole('link', { name: /Finish your review/ })

describe('PrDetailDrawer — Finish your review', () => {
  it('opens the review page, ready to give a verdict', () => {
    render(drawer())
    expect(finish()).toHaveAttribute('href', '/workspaces/ws1/reviews/pr_1?finish=1')
    expect(screen.queryByRole('button', { name: /^Approve$|Send back/ })).toBeNull()
  })

  it('reads the changes again when the draft has a new head', () => {
    const { rerender } = render(drawer())
    expect(invalidateQueries).not.toHaveBeenCalled()
    head = 'cmt_h2'
    rerender(drawer())
    expect(invalidateQueries).toHaveBeenCalledWith({ queryKey: ['changeList', 'ws1', 'g1', { branchId: 'br_1' }] })
  })

  it('is not offered to the draft’s owner', () => {
    owner = 'u_me'
    render(drawer())
    expect(finish()).toBeNull()
  })

  it('is offered to whoever opened the review where the policy lets them approve it', () => {
    actor = 'u_me'
    viewerCan = { approve: true, merge: true, approveReason: null, mergeReason: null }
    render(drawer())
    expect(finish()).toBeInTheDocument()
  })

  it('is offered to someone asked through a group of theirs, as the server says', () => {
    reviewers = []
    render(drawer())
    expect(finish()).toBeNull()
    review = { requiredApprovals: 0, approvals: { required: 1, have: 0, satisfied: false },
               reviewers: [{ type: 'group', id: 'grp_fin', name: 'Finance', state: 'waiting', requestedAt: 't' }],
               changeRequests: [], threads: { open: 0, holdMerge: false },
               you: { requested: true, needsReview: true, updatedSinceReviewed: false } }
    render(drawer())
    expect(finish()).toBeInTheDocument()
  })

  it('is not offered where the server says the reader may not approve', () => {
    viewerCan = { approve: false, merge: true, approveReason: 'self_review', mergeReason: null }
    render(drawer())
    expect(finish()).toBeNull()
  })
})

describe('a review given (useReviewActions.submitReview)', () => {
  const hook = () => renderHook(() => useReviewActions('ws1', 'pr_1', vi.fn()), { wrapper: MemoryRouter }).result

  it('sends the verdict and its summary at the head the review was loaded at', () => {
    const onDone = vi.fn()
    const actions = hook()
    act(() => actions.current.submitReview('request_changes', ' Use ISO codes ', { onDone }))
    expect(submitMutate.mock.calls[0][0]).toEqual({
      prId: 'pr_1', graphId: 'g1', verdict: 'request_changes', body: 'Use ISO codes', expectedHeadCommitId: 'cmt_h1',
    })
    act(() => submitMutate.mock.calls[0][1].onSuccess())
    expect(onDone).toHaveBeenCalled()
    expect(notify).toHaveBeenCalledWith('success', expect.stringMatching(/^Sent back to/))
  })

  it('reloads the review when the draft moved on, and records nothing', () => {
    const onMoved = vi.fn()
    const actions = hook()
    act(() => actions.current.submitReview('approve', '', { onMoved }))
    act(() => submitMutate.mock.calls[0][1].onError(new HeadMovedError({ headCommitId: 'cmt_h2' })))
    expect(refetchPr).toHaveBeenCalled()
    expect(invalidateQueries).toHaveBeenCalledWith({ queryKey: ['changeList', 'ws1', 'g1', { branchId: 'br_1' }] })
    expect(onMoved).toHaveBeenCalled()
    expect(notify).not.toHaveBeenCalled()
  })
})

describe('PrDetailDrawer — Merge', () => {
  it('is off, saying why, where someone other than whoever opened it merges', () => {
    actor = 'u_me'
    approvedBy = ['u_me']
    viewerCan = { approve: true, merge: false, approveReason: null, mergeReason: 'self_merge' }
    render(drawer())
    expect(screen.getByRole('button', { name: /^Merge$/ })).toBeDisabled()
    expect(screen.getByText(/someone other than whoever opened/)).toBeInTheDocument()
  })
})
