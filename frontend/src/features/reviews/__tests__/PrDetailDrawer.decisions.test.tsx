/**
 * A draft's review decided change by change merges what is accepted: Merge N accepted, the draft
 * keeping the rest; it waits while what is accepted needs a change that is not, and offers to
 * accept those too.
 */
import { render, screen, fireEvent, waitFor } from '@testing-library/react'
import { MemoryRouter } from 'react-router-dom'
import { describe, it, expect, vi, beforeEach } from 'vitest'

const mergeMutateAsync = vi.fn()
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
  total: 5, accepted: 2, rejected: 1, stale: 0, undecided: 2, missing: 0, missingIds: [], headCommitId: 'c9', ...over,
})

beforeEach(() => {
  mergeMutateAsync.mockReset()
  decisions.mutate.mockReset()
})

describe('PrDetailDrawer — merging what is accepted', () => {
  it('merges the accepted changes, and the draft keeps the rest', async () => {
    decisions.summary = summary()
    mergeMutateAsync.mockResolvedValue({ commitId: 'c10', outcome: 'published' })
    render(<MemoryRouter><PrDetailDrawer wsId="ws1" prId="pr_1" onClose={vi.fn()} /></MemoryRouter>)
    expect(screen.getByText('Only what is accepted merges; the rest stays on the draft.')).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: /^Merge$/ })).not.toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: 'Merge 2 accepted' }))
    await waitFor(() => expect(mergeMutateAsync).toHaveBeenCalledWith(expect.objectContaining({ prId: 'pr_1', mode: 'accepted' })))
  })

  it('waits while what is accepted needs a change that is not, and offers to accept it', () => {
    decisions.summary = summary({ missing: 1, missingIds: ['T3'] })
    render(<MemoryRouter><PrDetailDrawer wsId="ws1" prId="pr_1" onClose={vi.fn()} /></MemoryRouter>)
    expect(screen.getByRole('button', { name: 'Merge 2 accepted' })).toBeDisabled()
    fireEvent.click(screen.getByRole('button', { name: 'Accept them too' }))
    expect(decisions.mutate).toHaveBeenCalledWith(
      expect.objectContaining({ verdict: 'accepted', entityIds: ['T3'], expectedHeadCommitId: 'c9' }), expect.anything())
  })

  it('merges whole, as ever, with nothing decided', () => {
    decisions.summary = summary({ accepted: 0, rejected: 0, undecided: 5 })
    render(<MemoryRouter><PrDetailDrawer wsId="ws1" prId="pr_1" onClose={vi.fn()} /></MemoryRouter>)
    expect(screen.getByRole('button', { name: /^Merge$/ })).toBeEnabled()
    expect(screen.queryByText(/accepted$/)).not.toBeInTheDocument()
  })
})
