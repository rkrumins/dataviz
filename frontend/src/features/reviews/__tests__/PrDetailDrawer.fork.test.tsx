/**
 * PrDetailDrawer on a fork's review (from a fork's main into its parent's):
 *   • a review a job is merging (`merging`) shows that it is merging, with nothing to press — the
 *     server refuses another merge, closing it or approving it meanwhile;
 *   • merged — at once or by its job, the merge followed to its end — the drawer stays and reads as
 *     merged (a fork's review has no view to go back to), and the receipt is the parent's, where the
 *     merge landed;
 *   • a fork behind its parent says to update it first, and offers Update from parent, not a
 *     draft's "pull latest";
 *   • with forks off it offers neither Approve nor Merge, and says why; it can still be dismissed.
 * A draft's review still closes after merging, and lands on the view it came from.
 */
import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { MemoryRouter } from 'react-router-dom'
import { beforeEach, describe, expect, it, vi } from 'vitest'

const mergeMutateAsync = vi.fn()
const refetch = vi.fn()
const setReceipt = vi.fn()
const switchToMain = vi.fn()
const notify = vi.fn()
const onClose = vi.fn()
const idle = { mutate: vi.fn(), mutateAsync: vi.fn(), isPending: false }
let forksOn = true
let pr: Record<string, unknown>

vi.mock('../../versioning/hooks/useVersioning', () => ({
  useMergeRequest: () => ({ data: pr, isLoading: false, refetch }),
  usePullRequestDiff: () => ({ data: undefined }),
  usePullLatestDraft: () => idle,
  useCommitLog: () => ({ data: undefined }),
  useApproveMergeRequest: () => idle,
  useCloseMergeRequest: () => idle,
  useMergeMergeRequest: () => ({ ...idle, mutateAsync: mergeMutateAsync }),
  useUpdateMergeRequest: () => idle,
  useBranchViewChanges: () => ({ data: undefined }),
  useRevertCommit: () => idle,
}))
vi.mock('../../versioning/components/UpdateFromParentButton', () => ({
  UpdateFromParentButton: ({ forkGraphId, onUpdated }: { forkGraphId: string; onUpdated?: (r: unknown) => void }) =>
    <button data-fork={forkGraphId} onClick={() => onUpdated?.({ upToDate: false })}>Update from parent</button>,
}))
vi.mock('../../versioning/components/RollbackDialogs', () => ({
  RevertDialog: ({ open, graphId }: { open: boolean; graphId: string }) =>
    open ? <div data-testid="revert" data-graph={graphId} /> : null,
}))
vi.mock('@/store/auth', () => ({
  usePermission: () => true,
  useAuthStore: (sel: (s: unknown) => unknown) => sel({ user: { id: 'u_me' } }),
}))
vi.mock('@/store/features', () => ({ useFeature: (key: string) => (key === 'forksEnabled' ? forksOn : true) }))
vi.mock('@/components/ui/notifications', () => ({ useAppNotifications: () => ({ notify }) }))
vi.mock('@/store/branchStore', () => ({
  useBranchStore: (sel: (s: unknown) => unknown) => sel({ switchToMain }),
}))
vi.mock('@/store/publishReceiptStore', () => ({
  usePublishReceiptStore: (sel: (s: unknown) => unknown) => sel({ setReceipt }),
}))

import { PrDetailDrawer } from '../components/PrDetailDrawer'
import { ForkNotUpToDateError } from '@/services/versioningApiService'

const forkPr = (over: Record<string, unknown> = {}) => ({
  prId: 'pr_9', graphId: 'g_f', targetGraphId: 'g1', sourceBranchId: 'b_fork_main', targetBranch: 'main',
  status: 'mergeable', actor: 'u_author', title: 'Q3 restructure', reviewers: [], approvedBy: [],
  createdAt: '2026-10-01T00:00:00Z', updatedAt: '2026-10-01T00:00:00Z', ...over,
})

const renderDrawer = () =>
  render(<MemoryRouter><PrDetailDrawer wsId="ws1" prId="pr_9" onClose={onClose} /></MemoryRouter>)

beforeEach(() => {
  mergeMutateAsync.mockReset().mockResolvedValue({ commitId: 'c9' })
  refetch.mockReset()
  setReceipt.mockReset()
  switchToMain.mockReset()
  notify.mockReset()
  onClose.mockReset()
  forksOn = true
  pr = forkPr()
})

describe('PrDetailDrawer — a fork’s review', () => {
  it('shows a review its job is merging as in progress, with nothing to press', () => {
    pr = forkPr({ status: 'merging' })
    renderDrawer()
    expect(screen.getByRole('status')).toHaveTextContent(/merging in the background/i)
    expect(screen.queryByRole('button', { name: /^Merge$/ })).toBeNull()
    expect(screen.queryByRole('button', { name: /Approve/ })).toBeNull()
    expect(screen.queryByRole('button', { name: /Dismiss/ })).toBeNull()
  })

  it('stays open once merged, and the receipt is the parent’s', async () => {
    renderDrawer()
    fireEvent.click(screen.getByRole('button', { name: /^Merge$/ }))
    await waitFor(() => expect(setReceipt).toHaveBeenCalled())
    expect(mergeMutateAsync).toHaveBeenCalledWith(expect.objectContaining({ prId: 'pr_9', graphId: 'g1' }))
    expect(setReceipt).toHaveBeenCalledWith(expect.objectContaining({ commitId: 'c9', graphId: 'g1', via: 'review' }))
    expect(onClose).not.toHaveBeenCalled()
    expect(switchToMain).not.toHaveBeenCalled()
  })

  it('says a fork behind its parent updates first, and offers Update from parent', async () => {
    mergeMutateAsync.mockRejectedValue(new ForkNotUpToDateError({ behind: 4, graphId: 'g_f' }))
    renderDrawer()
    fireEvent.click(screen.getByRole('button', { name: /^Merge$/ }))
    expect(await screen.findByText(/behind its parent by 4 changes/)).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Update from parent' })).toHaveAttribute('data-fork', 'g_f')
    expect(screen.queryByRole('button', { name: /Pull latest/ })).toBeNull()
    expect(notify).not.toHaveBeenCalledWith('error', expect.stringMatching(/pull the latest/))
    expect(refetch).toHaveBeenCalled()
    // Updated: nothing left to say, and Merge is the next step.
    fireEvent.click(screen.getByRole('button', { name: 'Update from parent' }))
    expect(screen.queryByText(/behind its parent/)).toBeNull()
    expect(screen.getByRole('button', { name: /^Merge$/ })).toBeEnabled()
  })

  it('reverts a merged fork review on the parent, where the merge landed', () => {
    pr = forkPr({ status: 'merged', resultingCommitId: 'c9', mergedBy: 'u_me' })
    renderDrawer()
    fireEvent.click(screen.getByRole('button', { name: /Revert this merge/ }))
    expect(screen.getByTestId('revert')).toHaveAttribute('data-graph', 'g1')
  })

  it('with forks off, offers neither Approve nor Merge, says why, and can still be dismissed', () => {
    forksOn = false
    pr = forkPr({ reviewers: ['u_me'] })
    renderDrawer()
    expect(screen.getByText(/Forks are turned off for this deployment/)).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: /^Merge$/ })).toBeNull()
    expect(screen.queryByRole('button', { name: /Approve/ })).toBeNull()
    expect(screen.getByRole('button', { name: /Dismiss/ })).toBeInTheDocument()
  })
})

describe('PrDetailDrawer — a draft’s review, for contrast', () => {
  it('still closes after merging, with its graph’s receipt', async () => {
    pr = { ...forkPr(), graphId: 'g1', targetGraphId: 'g1', sourceBranchId: 'br_1' }
    renderDrawer()
    fireEvent.click(screen.getByRole('button', { name: /^Merge$/ }))
    await waitFor(() => expect(onClose).toHaveBeenCalled())
    expect(setReceipt).toHaveBeenCalledWith(expect.objectContaining({ graphId: 'g1' }))
    expect(switchToMain).toHaveBeenCalled()
  })
})
