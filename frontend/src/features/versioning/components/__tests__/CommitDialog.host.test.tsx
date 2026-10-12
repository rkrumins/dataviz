/**
 * CommitDialog inside another dialog (an import's success step): it still goes to the review it
 * opened, and tells its host it has left, so the host closes too; once the draft is published it
 * says so, so the host can open what went live.
 */
import { render, screen, fireEvent } from '@testing-library/react'
import { MemoryRouter, useLocation } from 'react-router-dom'
import { describe, it, expect, vi, beforeEach } from 'vitest'

const publishMutate = vi.fn()
const openMrMutate = vi.fn()

vi.mock('../../hooks/useVersioning', () => ({
  usePublishBranch: () => ({ mutate: publishMutate, isPending: false }),
  useOpenMergeRequest: () => ({ mutate: openMrMutate, isPending: false }),
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

function LocationProbe() {
  const location = useLocation()
  return <span data-testid="location">{location.pathname + location.search}</span>
}

function renderDialog() {
  const onClose = vi.fn()
  const onLeave = vi.fn()
  const onPublished = vi.fn()
  render(
    <MemoryRouter>
      <CommitDialog workspaceId="ws1" graphId="g1" branchId="br_1" changeSet={buildChangeSet([] as never)}
        onClose={onClose} onLeave={onLeave} onPublished={onPublished} />
      <LocationProbe />
    </MemoryRouter>,
  )
  return { onClose, onLeave, onPublished }
}

beforeEach(() => {
  publishMutate.mockReset()
  openMrMutate.mockReset()
})

describe('CommitDialog — inside another dialog', () => {
  it('goes to the review it opened, and tells its host it has left', () => {
    openMrMutate.mockImplementation((_v, opts) => opts.onSuccess({ prId: 'pr_7' }))
    const { onClose, onLeave, onPublished } = renderDialog()
    fireEvent.click(screen.getByRole('button', { name: /Submit for review/ }))
    expect(screen.getByTestId('location')).toHaveTextContent('/workspaces/ws1/reviews?pr=pr_7')
    expect(onClose).toHaveBeenCalled()
    expect(onLeave).toHaveBeenCalledTimes(1)
    expect(onPublished).not.toHaveBeenCalled()
  })

  it('says when the draft is published', () => {
    publishMutate.mockImplementation((_v, opts) => opts.onSuccess({ commitId: 'c1' }))
    const { onLeave, onPublished } = renderDialog()
    fireEvent.click(screen.getByRole('button', { name: /Publish now/ }))
    expect(onPublished).toHaveBeenCalledTimes(1)
    expect(onLeave).not.toHaveBeenCalled()
  })

  it('tells its host it has left for a view on the draft', () => {
    const { onLeave } = renderDialog()
    fireEvent.click(screen.getByRole('button', { name: /Open/ }))
    expect(screen.getByTestId('location')).toHaveTextContent('/views/view_new?branch=br_1')
    expect(onLeave).toHaveBeenCalledTimes(1)
  })
})
