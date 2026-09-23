/**
 * CommitDialog — a draft can change views as well as data (an import staged in it, layer edits).
 * They go live with the draft, so a draft of views alone must still be publishable, and the dialog
 * says which views it changes; views the reader can't open are counted, never named.
 */
import { render, screen, fireEvent } from '@testing-library/react'
import { MemoryRouter } from 'react-router-dom'
import { describe, it, expect, vi, beforeEach } from 'vitest'
import type { BranchViewChanges } from '@/services/versioningApiService'

const publishMutate = vi.fn()
let viewChanges: BranchViewChanges | undefined

vi.mock('../../hooks/useVersioning', () => ({
  usePublishBranch: () => ({ mutate: publishMutate, isPending: false }),
  useOpenMergeRequest: () => ({ mutate: vi.fn(), isPending: false }),
  useLivePrForBranch: () => ({ livePr: undefined, pending: false }),
  useBranchViewChanges: () => ({ data: viewChanges, isLoading: false }),
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

const noGraphChanges = buildChangeSet([] as never)

const renderDialog = () =>
  render(
    <MemoryRouter>
      <CommitDialog workspaceId="ws1" graphId="g1" branchId="br_1" changeSet={noGraphChanges} onClose={() => {}} />
    </MemoryRouter>,
  )

beforeEach(() => {
  publishMutate.mockClear()
  viewChanges = undefined
})

describe('CommitDialog — a draft that changes views', () => {
  it('has nothing to publish when it changes neither data nor views', () => {
    viewChanges = { branchId: 'br_1', views: [], hidden: 0 }
    renderDialog()
    expect(screen.getByText(/No changes detected/)).toBeInTheDocument()
    expect(screen.getByRole('button', { name: /publish now/i })).toBeDisabled()
  })

  it('publishes a draft of views alone, and names what goes live', () => {
    viewChanges = {
      branchId: 'br_1',
      hidden: 1,
      views: [{
        viewId: 'view_new', workspaceId: 'ws1', name: 'Finance lineage', change: 'create',
        origin: { environment: 'dev', version: 12 }, matchRate: 0.995,
        stats: { layers: 3, assignments: 1240 }, goesLiveAs: 'workspace',
      }],
    }
    renderDialog()
    expect(screen.getByText(/This draft changes views, which go live with it/)).toBeInTheDocument()
    expect(screen.getByText('Finance lineage')).toBeInTheDocument()
    expect(screen.getByText(/from dev v12 · 99.5% matched · 3 layers, 1,240 placements · goes live shared with its workspace/)).toBeInTheDocument()
    expect(screen.getByText(/And 1 change to views you can’t open/)).toBeInTheDocument()

    const publish = screen.getByRole('button', { name: /publish now/i })
    expect(publish).not.toBeDisabled()
    fireEvent.click(publish)
    expect(publishMutate).toHaveBeenCalledWith(expect.objectContaining({ branchId: 'br_1' }), expect.anything())
  })
})
