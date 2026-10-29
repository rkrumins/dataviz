/**
 * Merging a review advances main, which needs the publish permission on the workspace. A reviewer
 * who can manage but not publish sees Merge disabled, with the reason, and is not offered
 * "Revert this merge" either.
 */
import { render, screen, fireEvent } from '@testing-library/react'
import { MemoryRouter } from 'react-router-dom'
import { describe, it, expect, vi, beforeEach } from 'vitest'

const mergeMutateAsync = vi.fn()
const idle = { mutate: vi.fn(), mutateAsync: vi.fn(), isPending: false }
let canPublish = false
let status = 'open'

vi.mock('../../versioning/hooks/useVersioning', () => ({
  useMergeRequest: () => ({
    data: {
      prId: 'pr_1', graphId: 'g1', sourceBranchId: 'br_1', targetBranchId: 'main', status,
      actor: 'u_author', title: 'Tidy', reviewers: [], approvedBy: [], behind: false,
      resultingCommitId: status === 'merged' ? 'cmt_9' : null,
    },
    isLoading: false,
  }),
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
vi.mock('@/store/auth', () => ({
  usePermission: (perm: string) => perm !== 'workspace:datasource:publish' || canPublish,
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

function renderDrawer() {
  render(<MemoryRouter><PrDetailDrawer wsId="ws1" prId="pr_1" onClose={vi.fn()} /></MemoryRouter>)
}

beforeEach(() => {
  mergeMutateAsync.mockReset()
  mergeMutateAsync.mockResolvedValue({ commitId: 'c1' })
  status = 'open'
})

describe('PrDetailDrawer — publish permission', () => {
  it('disables Merge without publish and says why', () => {
    canPublish = false
    renderDrawer()
    const merge = screen.getByRole('button', { name: /Merge/ })
    expect(merge).toBeDisabled()
    expect(merge.getAttribute('title')).toMatch(/needs the publish permission/i)
    fireEvent.click(merge)
    expect(mergeMutateAsync).not.toHaveBeenCalled()
  })

  it('lets a publisher merge', () => {
    canPublish = true
    renderDrawer()
    fireEvent.click(screen.getByRole('button', { name: /Merge/ }))
    expect(mergeMutateAsync).toHaveBeenCalledTimes(1)
  })

  it('offers "Revert this merge" only to a publisher', () => {
    status = 'merged'
    canPublish = false
    const { unmount } = render(<MemoryRouter><PrDetailDrawer wsId="ws1" prId="pr_1" onClose={vi.fn()} /></MemoryRouter>)
    expect(screen.queryByRole('button', { name: /Revert this merge/ })).toBeNull()
    unmount()
    canPublish = true
    renderDrawer()
    expect(screen.getByRole('button', { name: /Revert this merge/ })).toBeInTheDocument()
  })
})
