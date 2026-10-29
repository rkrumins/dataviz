/**
 * PrDetailDrawer — the requested reviewers, who has approved, and whose approval went stale. A
 * requested reviewer who did not raise the review is offered Approve; nobody else is.
 */
import { render, screen, fireEvent } from '@testing-library/react'
import { MemoryRouter } from 'react-router-dom'
import { describe, it, expect, vi, beforeEach } from 'vitest'

const approveMutate = vi.fn()
const idle = { mutate: vi.fn(), mutateAsync: vi.fn(), isPending: false }
let me = 'u_me'
let pr: Record<string, unknown>

vi.mock('../../versioning/hooks/useVersioning', () => ({
  useMergeRequest: () => ({ data: pr, isLoading: false }),
  usePullRequestDiff: () => ({ data: undefined }),
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
  useAuthStore: (sel: (s: unknown) => unknown) => sel({ user: { id: me } }),
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

const renderDrawer = () =>
  render(<MemoryRouter><PrDetailDrawer wsId="ws1" prId="pr_1" onClose={vi.fn()} /></MemoryRouter>)

beforeEach(() => {
  approveMutate.mockClear()
  me = 'u_me'
  pr = {
    prId: 'pr_1', graphId: 'g1', sourceBranchId: 'br_1', targetBranch: 'main', status: 'mergeable',
    actor: 'u_author', title: 'Tidy', behind: false,
    reviewers: ['u_me', 'u_carol', 'u_dan'], approvedBy: ['u_carol'], staleApprovedBy: ['u_dan'],
    approvalStatus: 'pending',
    userNames: { u_me: 'Me Myself', u_carol: 'Carol Chen', u_dan: 'Dan Dorn', u_author: 'Ann Author' },
  }
})

describe('PrDetailDrawer — reviewers', () => {
  it('shows each requested reviewer: approved, stale, or still to approve', () => {
    renderDrawer()
    expect(screen.getByTitle('Carol Chen approved')).toHaveTextContent(/Carol Chen/)
    expect(screen.getByTitle(/^Dan Dorn approved an earlier version/)).toHaveTextContent(/stale/i)
    expect(screen.getByTitle('Me Myself has not approved yet')).toBeInTheDocument()
  })

  // Regression guard: a requested reviewer was already offered Approve (as was every manager).
  it('offers Approve to a requested reviewer who did not raise it', () => {
    renderDrawer()
    fireEvent.click(screen.getByRole('button', { name: /Approve/ }))
    expect(approveMutate).toHaveBeenCalledWith({ prId: 'pr_1', graphId: 'g1' }, expect.anything())
  })

  it('does not offer Approve to someone who was not asked, or to the author', () => {
    me = 'u_other'
    const { unmount } = renderDrawer()
    expect(screen.queryByRole('button', { name: /Approve/ })).toBeNull()
    unmount()
    me = 'u_author'
    pr = { ...pr, reviewers: ['u_author', 'u_carol'] }
    renderDrawer()
    expect(screen.queryByRole('button', { name: /Approve/ })).toBeNull()
  })
})
