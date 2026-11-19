/**
 * Who reviews it: each person or group asked, where they stand — a group with who answered for it —
 * and, for whoever may change who reviews it, Ask again, remove, and asking more people or groups.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { fireEvent, render, screen, within } from '@testing-library/react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import type { PullRequest, ReviewState } from '@/services/versioningApiService'
import type { ReviewActions } from '../../hooks/useReviewActions'

const setReviewers = vi.fn()
const reRequest = vi.fn()
const api = vi.hoisted(() => ({ listReviewerCandidates: vi.fn(), listReviewerGroups: vi.fn() }))
vi.mock('@/services/versioningApiService', async (orig) => ({
  ...(await orig<typeof import('@/services/versioningApiService')>()),
  ...api,
}))
vi.mock('@/features/versioning/hooks/useVersioning', () => ({
  useSetReviewers: () => ({ mutate: setReviewers, isPending: false }),
  useReRequestReviewers: () => ({ mutate: reRequest, isPending: false }),
}))
vi.mock('@/components/ui/notifications', () => ({ useAppNotifications: () => ({ notify: vi.fn() }) }))

import { ReviewersEditor } from '../ReviewersEditor'

const review: ReviewState = {
  requiredApprovals: 0, approvals: { required: 3, have: 1, satisfied: false },
  reviewers: [
    { type: 'user', id: 'u_bob', state: 'changes_requested', by: 'u_bob', requestedAt: '2026-11-01T00:00:00Z' },
    { type: 'user', id: 'u_cy', state: 'approved', by: 'u_cy', requestedAt: '2026-11-01T00:00:00Z' },
    { type: 'group', id: 'g_fin', name: 'Finance stewards', state: 'approved_earlier', by: 'u_dee', requestedAt: '2026-11-01T00:00:00Z' },
  ],
  changeRequests: [], threads: { open: 0, holdMerge: false },
}
const pr = (editReviewers = true): PullRequest => ({
  prId: 'pr_1', graphId: 'g1', targetGraphId: 'g1', sourceBranchId: 'br_1', targetBranch: 'main', status: 'open',
  createdAt: '2026-11-01T00:00:00Z', updatedAt: '2026-11-01T00:00:00Z', actor: 'u_ana', reviewers: ['u_bob', 'u_cy'], review,
  userNames: { u_ana: 'Ana', u_bob: 'Bob', u_cy: 'Cy', u_dee: 'Dee' },
  viewerCan: { approve: true, merge: true, approveReason: null, mergeReason: null, editReviewers },
})

function renderEditor(p = pr()) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  render(
    <QueryClientProvider client={qc}>
      <ReviewersEditor wsId="ws1" actions={{ pr: p } as unknown as ReviewActions} />
    </QueryClientProvider>,
  )
}

beforeEach(() => {
  setReviewers.mockReset()
  reRequest.mockReset()
  api.listReviewerCandidates.mockResolvedValue([{ userId: 'u_bob', displayName: 'Bob' }, { userId: 'u_cy', displayName: 'Cy' }])
  api.listReviewerGroups.mockResolvedValue([
    { groupId: 'g_fin', name: 'Finance stewards', memberCount: 4 },
    { groupId: 'g_ops', name: 'Ops', description: 'Run the pipelines', memberCount: 1 },
  ])
})

describe('ReviewersEditor', () => {
  it('shows each reviewer and group where they stand, and who answered for a group', () => {
    renderEditor()
    const rows = screen.getAllByRole('listitem')
    expect(rows[0]).toHaveTextContent(/Bob.*Asked for changes/)
    expect(rows[1]).toHaveTextContent(/Cy.*Approved/)
    expect(rows[2]).toHaveTextContent(/Finance stewards.*by.*Dee.*Approved an earlier version/)
  })

  it('asks a person or a group again — not one whose approval stands', () => {
    renderEditor()
    fireEvent.click(screen.getByRole('button', { name: 'Ask Bob again' }))
    expect(reRequest).toHaveBeenCalledWith({ prId: 'pr_1', graphId: 'g1', users: ['u_bob'] }, expect.anything())
    fireEvent.click(screen.getByRole('button', { name: 'Ask Finance stewards again' }))
    expect(reRequest).toHaveBeenLastCalledWith({ prId: 'pr_1', graphId: 'g1', groups: ['g_fin'] }, expect.anything())
    expect(screen.queryByRole('button', { name: 'Ask Cy again' })).toBeNull()
  })

  it('stops asking someone', () => {
    renderEditor()
    fireEvent.click(screen.getByRole('button', { name: 'Remove Cy' }))
    expect(setReviewers).toHaveBeenCalledWith({ prId: 'pr_1', graphId: 'g1', users: ['u_bob'] }, expect.anything())
    fireEvent.click(screen.getByRole('button', { name: 'Remove Finance stewards' }))
    expect(setReviewers).toHaveBeenLastCalledWith({ prId: 'pr_1', graphId: 'g1', groups: [] }, expect.anything())
  })

  it('asks a group too', async () => {
    renderEditor()
    fireEvent.click(screen.getByRole('button', { name: /Add reviewers/ }))
    const ops = await screen.findByRole('button', { name: /Ops/ })
    expect(within(ops).getByText('1 member')).toBeInTheDocument()
    expect(screen.getByRole('button', { name: /Finance stewards.*4 members/ })).toHaveAttribute('aria-pressed', 'true')
    fireEvent.click(ops)
    expect(setReviewers).toHaveBeenCalledWith({ prId: 'pr_1', graphId: 'g1', groups: ['g_fin', 'g_ops'] }, expect.anything())
  })

  it('is read only for whoever may not change who reviews it', () => {
    renderEditor(pr(false))
    expect(screen.getAllByRole('listitem')).toHaveLength(3)
    expect(screen.queryByRole('button', { name: /again|Remove|Add reviewers/ })).toBeNull()
  })
})
