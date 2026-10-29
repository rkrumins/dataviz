/**
 * Merging a review lands its draft and closes it. Edits still staged on the canvas for that draft
 * are not part of it yet, so Merge waits until they are saved or discarded — otherwise they are
 * left behind on a closed draft.
 */
import { render, screen, fireEvent } from '@testing-library/react'
import { MemoryRouter } from 'react-router-dom'
import { describe, it, expect, vi, beforeEach } from 'vitest'

const mergeMutateAsync = vi.fn()
const idle = { mutate: vi.fn(), mutateAsync: vi.fn(), isPending: false }

vi.mock('../../versioning/hooks/useVersioning', () => ({
  useMergeRequest: () => ({
    data: {
      prId: 'pr_1', graphId: 'g1', sourceBranchId: 'br_1', targetBranchId: 'main', status: 'open',
      actor: 'u_author', title: 'Tidy', reviewers: [], approvedBy: [], behind: false,
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
import { useStagedChangesStore, type StagedChange } from '@/store/stagedChangesStore'

const change = (id: string): StagedChange => ({
  id, type: 'rename_entity', targetId: `t-${id}`, after: {}, summary: id, timestamp: 0,
})

function renderDrawer() {
  render(<MemoryRouter><PrDetailDrawer wsId="ws1" prId="pr_1" onClose={vi.fn()} /></MemoryRouter>)
}

beforeEach(() => {
  mergeMutateAsync.mockReset()
  mergeMutateAsync.mockResolvedValue({ commitId: 'c1' })
})

describe('PrDetailDrawer — unsaved canvas edits on the draft', () => {
  it('will not merge while the draft has edits staged on the canvas', () => {
    useStagedChangesStore.setState({ changes: [change('a')], redoStack: [], _scopeKey: 'ws1::ds1::br_1', _byScope: {} })
    renderDrawer()
    expect(screen.getByText(/1 unsaved edit\b/)).toBeTruthy()
    const merge = screen.getByRole('button', { name: /Merge/ })
    expect(merge).toHaveProperty('disabled', true)
    fireEvent.click(merge)
    expect(mergeMutateAsync).not.toHaveBeenCalled()
  })

  it('merges when the staged edits belong to another draft', () => {
    useStagedChangesStore.setState({ changes: [change('a')], redoStack: [], _scopeKey: 'ws1::ds1::br_2', _byScope: {} })
    renderDrawer()
    fireEvent.click(screen.getByRole('button', { name: /Merge/ }))
    expect(mergeMutateAsync).toHaveBeenCalledTimes(1)
  })
})
