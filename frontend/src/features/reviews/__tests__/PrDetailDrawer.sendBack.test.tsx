/**
 * Sending a draft's review back: Send back asks why and tells the author; while it holds, Merge
 * waits and says so; its reviewer can withdraw it; its author can discard what was rejected in one
 * step; and merging what is accepted can discard what was rejected too.
 */
import { render, screen, fireEvent, waitFor } from '@testing-library/react'
import { MemoryRouter } from 'react-router-dom'
import { describe, it, expect, vi, beforeEach } from 'vitest'

const mergeMutateAsync = vi.fn()
const sendBack = vi.hoisted(() => ({ request: vi.fn(), withdraw: vi.fn(), discard: vi.fn() }))
const prState = vi.hoisted(() => ({ over: {} as Record<string, unknown>, me: 'u_me' }))
const idle = { mutate: vi.fn(), mutateAsync: vi.fn(), isPending: false }
const api = vi.hoisted(() => ({ getChangeEntry: vi.fn(), getMergeRequestDiff: vi.fn() }))

const { invalidateQueries } = vi.hoisted(() => ({ invalidateQueries: vi.fn() }))
vi.mock('@tanstack/react-query', async (orig) => ({
  ...(await orig<typeof import('@tanstack/react-query')>()),
  useQueryClient: () => ({ invalidateQueries }),
}))
vi.mock('@/services/versioningApiService', async (orig) => ({
  ...(await orig<typeof import('@/services/versioningApiService')>()),
  ...api,
}))
const decisions = vi.hoisted(() => ({ summary: undefined as unknown, mutate: vi.fn() }))
vi.mock('../decisions/useReviewDecisions', () => ({
  DECISION_KEYS: { all: (...a: unknown[]) => ['reviewDecisions', ...a] },
  useReviewDecisionSummary: () => ({ data: decisions.summary }),
  useDecideChanges: () => ({ mutate: decisions.mutate, mutateAsync: vi.fn(), isPending: false }),
}))
vi.mock('../comments/ReviewDiscussion', () => ({ ReviewDiscussion: () => null }))
vi.mock('../comments/useReviewComments', () => ({ useReviewCommentCounts: () => ({ data: undefined }) }))
vi.mock('../../versioning/components/ChangeList', () => ({ ChangeList: () => null }))
vi.mock('../../versioning/components/ChangeTreePanel', () => ({ ChangeTreePanel: () => null }))
vi.mock('../../versioning/hooks/useVersioning', () => ({
  useMergeRequest: () => ({
    data: {
      prId: 'pr_1', graphId: 'g1', targetGraphId: 'g1', sourceBranchId: 'br_1', targetBranch: 'main', status: 'mergeable',
      actor: 'u_author', title: 'Tidy', reviewers: [], approvedBy: [], behind: false, headCommitId: 'c9',
      viewerCan: { approve: true, merge: true, approveReason: null, mergeReason: null, decide: true },
      userNames: { u_author: 'Ana', u_me: 'Bo' },
      ...prState.over,
    },
    isLoading: false,
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
  useMergeMergeRequest: () => ({ ...idle, mutateAsync: mergeMutateAsync }),
  useUpdateMergeRequest: () => idle,
  useRequestChanges: () => ({ ...idle, mutate: sendBack.request }),
  useWithdrawChangesRequest: () => ({ ...idle, mutate: sendBack.withdraw }),
  useDiscardRejected: () => ({ ...idle, mutate: sendBack.discard }),
  useBranchViewChanges: () => ({ data: undefined }),
}))
vi.mock('@/store/auth', () => ({
  usePermission: () => true,
  useAuthStore: (sel: (s: unknown) => unknown) => sel({ user: { id: prState.me } }),
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
  total: 5, accepted: 2, rejected: 1, stale: 0, undecided: 2, missing: 0, missingIds: [], headCommitId: 'c9', ...over,
})
const SENT_BACK = { by: 'u_me', at: new Date().toISOString(), reason: 'Use ISO codes', headCommitId: 'c9' }
const drawer = () => render(<MemoryRouter><PrDetailDrawer wsId="ws1" prId="pr_1" onClose={vi.fn()} /></MemoryRouter>)

beforeEach(() => {
  mergeMutateAsync.mockReset()
  Object.values(sendBack).forEach((f) => f.mockReset())
  prState.over = {}
  prState.me = 'u_me'
  decisions.summary = summary()
})

describe('PrDetailDrawer — sending a review back', () => {
  it('asks why, and sends it back at the head reviewed', () => {
    drawer()
    fireEvent.click(screen.getByRole('button', { name: 'Send back' }))
    expect(screen.getByText('Send this back for changes?')).toBeInTheDocument()
    fireEvent.change(screen.getByPlaceholderText('What should change, and why?'), { target: { value: ' Use ISO codes ' } })
    fireEvent.click(screen.getAllByRole('button', { name: 'Send back' }).at(-1)!)
    expect(sendBack.request).toHaveBeenCalledWith(
      { prId: 'pr_1', graphId: 'g1', reason: 'Use ISO codes', expectedHeadCommitId: 'c9' }, expect.anything())
  })

  it('while sent back, says by whom and why, holds Merge, and lets its reviewer withdraw', () => {
    prState.over = { changesRequested: SENT_BACK }
    drawer()
    expect(screen.getByRole('status')).toHaveTextContent(/Sent back for changes by Bo/)
    expect(screen.getByText('“Use ISO codes”')).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Merge 2 accepted' })).toBeDisabled()
    expect(screen.queryByRole('button', { name: 'Send back' })).not.toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: 'Withdraw' }))
    expect(sendBack.withdraw).toHaveBeenCalledWith({ prId: 'pr_1', graphId: 'g1' }, expect.anything())
  })

  it('its author discards what was rejected in one step', () => {
    prState.over = { changesRequested: SENT_BACK }
    prState.me = 'u_author'
    const confirmSpy = vi.spyOn(window, 'confirm').mockReturnValue(true)
    drawer()
    expect(screen.queryByRole('button', { name: 'Withdraw' })).not.toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: 'Discard the rejected' }))
    expect(confirmSpy).toHaveBeenCalled()
    expect(sendBack.discard).toHaveBeenCalledWith({ prId: 'pr_1', graphId: 'g1', branchId: 'br_1' }, expect.anything())
    confirmSpy.mockRestore()
  })

  it('merging what is accepted can discard what was rejected too', async () => {
    mergeMutateAsync.mockResolvedValue({ commitId: 'c10', outcome: 'published' })
    drawer()
    fireEvent.click(screen.getByRole('checkbox', { name: /Also discard the 1 rejected change from the draft/ }))
    fireEvent.click(screen.getByRole('button', { name: 'Merge 2 accepted' }))
    await waitFor(() => expect(mergeMutateAsync).toHaveBeenCalledWith(
      expect.objectContaining({ mode: 'accepted', discardRejected: true })))
  })
})
