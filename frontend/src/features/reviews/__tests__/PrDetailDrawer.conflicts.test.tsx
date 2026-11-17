/**
 * A review's merge that conflicts opens the resolver with what each resolution is built on — the
 * conflicting entities' own values, sent with the conflicts. One the answer left out is read on
 * its own; the review's whole diff is never downloaded. Until every value is here, the resolution
 * waits: built without one it would drop every field that did not conflict.
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
      actor: 'u_author', title: 'Tidy', reviewers: [], approvedBy: [], behind: false,
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

import { MergeConflictError } from '@/services/versioningApiService'
import { PrDetailDrawer } from '../components/PrDetailDrawer'

const conflict = (eid: string) => ({ entity_id: eid, path: ['description'], base: 'a', ours: 'b', theirs: 'c', kind: 'field' })

beforeEach(() => {
  mergeMutateAsync.mockReset()
  api.getChangeEntry.mockReset()
  api.getMergeRequestDiff.mockReset()
})

describe('PrDetailDrawer — merge conflicts', () => {
  it('resolves from the values sent with the conflicts, reading only one left out', async () => {
    let answer!: (v: unknown) => void
    api.getChangeEntry.mockReturnValue(new Promise((r) => { answer = r }))
    mergeMutateAsync.mockRejectedValueOnce(new MergeConflictError(
      [conflict('e1'), conflict('e2')], {}, { e1: { displayName: 'Orders', description: 'b', owner: 'ana' } }))
    render(<MemoryRouter><PrDetailDrawer wsId="ws1" prId="pr_1" onClose={vi.fn()} /></MemoryRouter>)
    fireEvent.click(screen.getByRole('button', { name: /^Merge/ }))

    expect(await screen.findByText('Reading 1 entity…')).toBeInTheDocument()
    expect(screen.getByRole('button', { name: /Merge with resolutions/ })).toBeDisabled()
    expect(api.getChangeEntry).toHaveBeenCalledTimes(1)
    expect(api.getChangeEntry).toHaveBeenCalledWith('ws1', 'g1', { branchId: 'br_1' }, 'e2')
    expect(api.getMergeRequestDiff).not.toHaveBeenCalled()

    answer({ entityId: 'e2', kind: 'node', status: 'modified', after: { displayName: 'Sales', description: 'b' } })
    await waitFor(() => expect(screen.getByRole('button', { name: /Merge with resolutions/ })).toBeEnabled())
    fireEvent.click(screen.getByRole('button', { name: /Merge with resolutions/ }))
    const resolutions = mergeMutateAsync.mock.calls[1][0].resolutions
    expect(resolutions.e1).toEqual({ displayName: 'Orders', description: 'b', owner: 'ana' })
    expect(resolutions.e2).toEqual({ displayName: 'Sales', description: 'b' })
  })

  it('says so when a value could not be read, and does not resolve without it', async () => {
    api.getChangeEntry.mockRejectedValue(new Error('down'))
    mergeMutateAsync.mockRejectedValueOnce(new MergeConflictError([conflict('e2')]))
    render(<MemoryRouter><PrDetailDrawer wsId="ws1" prId="pr_1" onClose={vi.fn()} /></MemoryRouter>)
    fireEvent.click(screen.getByRole('button', { name: /^Merge/ }))
    expect(await screen.findByText(/Couldn’t read every conflicting entity/)).toBeInTheDocument()
    expect(screen.getByRole('button', { name: /Merge with resolutions/ })).toBeDisabled()
  })
})
