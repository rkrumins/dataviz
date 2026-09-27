/**
 * CommitDialog while a property operation is being written into the draft: publishing is held —
 * the server refuses it meanwhile, since part of the operation would go out without the rest —
 * and the dialog says which operation it waits for. Once it has finished, Publish is back.
 */
import { render, screen } from '@testing-library/react'
import { MemoryRouter } from 'react-router-dom'
import { describe, it, expect, vi } from 'vitest'

let ops: Array<Record<string, unknown>> = []

vi.mock('../../hooks/useVersioning', () => ({
  usePublishBranch: () => ({ mutate: vi.fn(), isPending: false }),
  usePropertyOps: () => ({ data: { ops, draftChanges: 3, maxDraftChanges: 100_000 } }),
  useOpenMergeRequest: () => ({ mutate: vi.fn(), isPending: false }),
  useLivePrForBranch: () => ({ livePr: undefined, pending: false }),
  // Something to publish: a view the draft creates.
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

function renderDialog() {
  render(
    <MemoryRouter>
      <CommitDialog workspaceId="ws1" graphId="g1" branchId="br_1"
        changeSet={buildChangeSet([] as never)} onClose={vi.fn()} />
    </MemoryRouter>,
  )
}

describe('CommitDialog while a property operation runs', () => {
  it('holds Publish, naming the operation it waits for', () => {
    ops = [{ jobId: 'j1', status: 'running', op: { kind: 'set', key: 'owner', value: 'alice' } }]
    renderDialog()
    expect(screen.getByRole('button', { name: /publish now/i })).toBeDisabled()
    expect(screen.getByText('Set owner = alice')).toBeInTheDocument()
  })

  it('publishes once it has finished', () => {
    ops = [{ jobId: 'j1', status: 'completed', op: { kind: 'set', key: 'owner', value: 'alice' } }]
    renderDialog()
    expect(screen.getByRole('button', { name: /publish now/i })).toBeEnabled()
    expect(screen.queryByText('Set owner = alice')).not.toBeInTheDocument()
  })
})
