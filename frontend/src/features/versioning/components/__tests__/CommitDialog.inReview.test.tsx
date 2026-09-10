/**
 * CommitDialog — a branch that is already in review must not be offered a second one.
 *
 * A PR's diff is computed live from its source branch, so edits made after it was raised are ALREADY
 * in it. Raising a second review would duplicate the first, and merging either would strand the
 * other on a merged branch — the bug this pins shut. The dialog must route to the existing review
 * instead of dead-ending, and "Publish now" (which bypasses that review) must ask first.
 */
import { render, screen, fireEvent } from '@testing-library/react'
import { MemoryRouter } from 'react-router-dom'
import { describe, it, expect, vi, beforeEach } from 'vitest'

const publishMutate = vi.fn()
const openMrMutate = vi.fn()
let livePr: { prId: string; title: string | null } | undefined

vi.mock('../../hooks/useVersioning', () => ({
  usePublishBranch: () => ({ mutate: publishMutate, isPending: false }),
  useOpenMergeRequest: () => ({ mutate: openMrMutate, isPending: false }),
  useLivePrForBranch: () => ({ livePr, pending: false }),
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

const changeSet = buildChangeSet([
  { entityId: 'e1', kind: 'node', status: 'added', label: 'Orders', origin: { source: 'committed' } },
] as never)

const renderDialog = () =>
  render(
    <MemoryRouter>
      <CommitDialog
        workspaceId="ws1" graphId="g1" branchId="br_1"
        changeSet={changeSet} onClose={() => {}}
      />
    </MemoryRouter>,
  )

beforeEach(() => {
  publishMutate.mockClear()
  openMrMutate.mockClear()
  livePr = undefined
})

describe('CommitDialog — branch already in review', () => {
  it('offers "Submit for review" when the branch has no open review', () => {
    renderDialog()
    expect(screen.getByRole('button', { name: /submit for review/i })).toBeInTheDocument()
    expect(screen.queryByText(/already in review/i)).not.toBeInTheDocument()
  })

  it('does NOT offer to raise a second review when one is already open', () => {
    livePr = { prId: 'pr_7', title: 'Add customer dimension' }
    renderDialog()
    expect(screen.queryByRole('button', { name: /submit for review/i })).not.toBeInTheDocument()
    expect(screen.getByRole('button', { name: /view review/i })).toBeInTheDocument()
  })

  it('names the open review and explains that the new changes are already in it', () => {
    livePr = { prId: 'pr_7', title: 'Add customer dimension' }
    renderDialog()
    expect(screen.getByText('Already in review')).toBeInTheDocument()
    expect(screen.getByText('Add customer dimension')).toBeInTheDocument()
    expect(screen.getByText(/already part of this review/i)).toBeInTheDocument()
  })

  it('makes "Publish now" over an open review an explicit two-step bypass', () => {
    livePr = { prId: 'pr_7', title: 'Add customer dimension' }
    renderDialog()

    fireEvent.click(screen.getByRole('button', { name: /publish now/i }))
    expect(publishMutate).not.toHaveBeenCalled()               // first press only warns
    expect(screen.getByText(/skips the open review/i)).toBeInTheDocument()

    fireEvent.click(screen.getByRole('button', { name: /publish anyway/i }))
    expect(publishMutate).toHaveBeenCalledTimes(1)             // confirmed → it goes
  })

  it('publishes without a confirmation step when there is no review to bypass', () => {
    renderDialog()
    fireEvent.click(screen.getByRole('button', { name: /publish now/i }))
    expect(publishMutate).toHaveBeenCalledTimes(1)
  })
})
