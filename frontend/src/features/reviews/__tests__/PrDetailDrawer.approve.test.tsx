/**
 * Approve is of what the reviewer saw: it sends the head the review was loaded at, the diff is read
 * again when a new head arrives, and a "draft moved on" refusal reloads the review and says so. The
 * draft's owner is not offered Approve, as its author is not.
 */
import { render, screen, fireEvent } from '@testing-library/react'
import { MemoryRouter } from 'react-router-dom'
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { HeadMovedError } from '@/services/versioningApiService'

const approveMutate = vi.fn()
const refetchPr = vi.fn()
const refetchDiff = vi.fn()
const notify = vi.fn()
const idle = { mutate: vi.fn(), mutateAsync: vi.fn(), isPending: false }
let head = 'cmt_h1'
let owner = 'u_author'

vi.mock('../../versioning/hooks/useVersioning', () => ({
  useMergeRequest: () => ({
    data: {
      prId: 'pr_1', graphId: 'g1', sourceBranchId: 'br_1', targetBranch: 'main', status: 'mergeable',
      actor: 'u_author', sourceBranchOwner: owner, title: 'Tidy', reviewers: ['u_me'], approvedBy: [],
      behind: false, headCommitId: head,
    },
    isLoading: false,
    refetch: refetchPr,
  }),
  usePullRequestDiff: () => ({ data: undefined, refetch: refetchDiff }),
  usePullLatestDraft: () => idle,
  useCommitLog: () => ({ data: undefined }),
  useApproveMergeRequest: () => ({ ...idle, mutate: approveMutate }),
  useCloseMergeRequest: () => idle,
  useMergeMergeRequest: () => idle,
  useUpdateMergeRequest: () => idle,
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

const drawer = () => <MemoryRouter><PrDetailDrawer wsId="ws1" prId="pr_1" onClose={vi.fn()} /></MemoryRouter>

beforeEach(() => {
  for (const f of [approveMutate, refetchPr, refetchDiff, notify]) f.mockReset()
  head = 'cmt_h1'
  owner = 'u_author'
})

describe('PrDetailDrawer — Approve', () => {
  it('sends the head the review was loaded at', () => {
    render(drawer())
    fireEvent.click(screen.getByRole('button', { name: /Approve/ }))
    expect(approveMutate).toHaveBeenCalledTimes(1)
    expect(approveMutate.mock.calls[0][0]).toEqual({ prId: 'pr_1', graphId: 'g1', expectedHeadCommitId: 'cmt_h1' })
  })

  it('reads the diff again when the draft has a new head', () => {
    const { rerender } = render(drawer())
    expect(refetchDiff).not.toHaveBeenCalled()
    head = 'cmt_h2'
    rerender(drawer())
    expect(refetchDiff).toHaveBeenCalledTimes(1)
  })

  it('reloads the review and says the draft changed when it moved on', () => {
    render(drawer())
    fireEvent.click(screen.getByRole('button', { name: /Approve/ }))
    const { onError } = approveMutate.mock.calls[0][1]
    onError(new HeadMovedError({ headCommitId: 'cmt_h2' }))
    expect(refetchPr).toHaveBeenCalled()
    expect(refetchDiff).toHaveBeenCalled()
    expect(notify).toHaveBeenCalledWith('error', expect.stringMatching(/changed since you loaded it/))
  })

  it('is not offered to the draft’s owner', () => {
    owner = 'u_me'
    render(drawer())
    expect(screen.queryByRole('button', { name: /Approve/ })).toBeNull()
  })
})
