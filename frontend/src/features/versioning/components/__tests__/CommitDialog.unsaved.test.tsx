/**
 * Edits still staged on the canvas are not part of the draft yet. Publishing it then would leave
 * them behind on a closed draft, so "Publish now" waits until they are saved or discarded.
 * Submitting for review is not blocked: a review tracks the branch, so edits saved later land in it.
 */
import { render, screen, fireEvent } from '@testing-library/react'
import { MemoryRouter } from 'react-router-dom'
import { describe, it, expect, vi, beforeEach } from 'vitest'

const publishMutate = vi.fn()

vi.mock('../../hooks/useVersioning', () => ({
  usePublishBranch: () => ({ mutate: publishMutate, isPending: false }),
  useOpenMergeRequest: () => ({ mutate: vi.fn(), isPending: false }),
  useLivePrForBranch: () => ({ livePr: undefined, pending: false }),
  useBranchViewChanges: () => ({
    data: {
      branchId: 'br_1', hidden: 0,
      views: [{ viewId: 'view_new', workspaceId: 'ws1', name: 'Finance lineage', change: 'create', matchRate: 1 }],
    },
    isLoading: false,
  }),
}))
vi.mock('@/store/auth', () => ({ usePermission: () => true }))
vi.mock('@/components/ui/notifications', () => ({ useAppNotifications: () => ({ notify: vi.fn() }) }))
vi.mock('@/store/branchStore', () => ({
  useBranchStore: (sel: (s: unknown) => unknown) => sel({ switchToMain: vi.fn() }),
}))
vi.mock('@/store/publishReceiptStore', () => ({
  usePublishReceiptStore: (sel: (s: unknown) => unknown) => sel({ setReceipt: vi.fn() }),
}))

import { CommitDialog } from '../CommitDialog'
import { buildChangeSet } from '../../model/changeModel'
import { useStagedChangesStore, type StagedChange } from '@/store/stagedChangesStore'

const change = (id: string): StagedChange => ({
  id, type: 'rename_entity', targetId: `t-${id}`, after: {}, summary: id, timestamp: 0,
})

function renderDialog(branchId: string) {
  render(
    <MemoryRouter>
      <CommitDialog workspaceId="ws1" graphId="g1" branchId={branchId} changeSet={buildChangeSet([] as never)}
        onClose={vi.fn()} />
    </MemoryRouter>,
  )
}

beforeEach(() => {
  publishMutate.mockReset()
  useStagedChangesStore.setState({
    changes: [change('a'), change('b')], redoStack: [], _scopeKey: 'ws1::ds1::br_1', _byScope: {},
  })
})

describe('CommitDialog — unsaved canvas edits', () => {
  it('will not publish a draft with edits still staged on it', () => {
    renderDialog('br_1')
    expect(screen.getByText(/2 unsaved edits/)).toBeTruthy()
    const publish = screen.getByRole('button', { name: /Publish now/ })
    expect(publish).toHaveProperty('disabled', true)
    fireEvent.click(publish)
    expect(publishMutate).not.toHaveBeenCalled()
    expect(screen.getByRole('button', { name: /Submit for review/ })).toHaveProperty('disabled', false)
  })

  it('publishes a draft whose staged edits belong to another branch', () => {
    renderDialog('br_2')
    expect(screen.queryByText(/unsaved edit/)).toBeNull()
    fireEvent.click(screen.getByRole('button', { name: /Publish now/ }))
    expect(publishMutate).toHaveBeenCalledTimes(1)
  })
})
