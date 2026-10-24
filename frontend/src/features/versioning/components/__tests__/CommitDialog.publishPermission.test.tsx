/**
 * CommitDialog — "Publish now" advances the live version, which needs the publish permission on
 * the workspace. Someone who can edit but not publish sees it disabled, with the reason, and can
 * still submit the draft for review. So does an editor of a shared draft, which only its owner or a
 * maintainer may publish.
 */
import { render, screen, fireEvent } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { MemoryRouter } from 'react-router-dom'
import { describe, it, expect, vi, beforeEach } from 'vitest'

const publishMutate = vi.fn()
let canPublish = false

vi.mock('../../hooks/useVersioning', () => ({
  usePublishBranch: () => ({ mutate: publishMutate, isPending: false }),
  useOpenMergeRequest: () => ({ mutate: vi.fn(), isPending: false }),
  useLivePrForBranch: () => ({ livePr: undefined, pending: false }),
  useBranchViewChanges: () => ({ data: undefined, isLoading: false }),
}))
vi.mock('@/store/auth', () => ({
  usePermission: (perm: string) => perm !== 'workspace:datasource:publish' || canPublish,
}))
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

const renderDialog = (canPublishDraft?: boolean) =>
  render(
    <MemoryRouter>
      <CommitDialog workspaceId="ws1" graphId="g1" branchId="br_1" changeSet={changeSet} onClose={() => {}}
        canPublishDraft={canPublishDraft} />
    </MemoryRouter>,
  )

beforeEach(() => {
  publishMutate.mockClear()
})

describe('CommitDialog — publish permission', () => {
  it('disables "Publish now" without publish, says why, and still offers review', async () => {
    canPublish = false
    renderDialog()
    const publish = screen.getByRole('button', { name: /publish now/i })
    expect(publish).toBeDisabled()
    fireEvent.click(publish)
    expect(publishMutate).not.toHaveBeenCalled()
    await userEvent.setup().hover(publish.parentElement!)
    expect(await screen.findByRole('tooltip')).toHaveTextContent(/needs the publish permission/i)
    expect(screen.getByRole('button', { name: /submit for review/i })).toBeEnabled()
  })

  it('lets a publisher publish', () => {
    canPublish = true
    renderDialog()
    expect(screen.getByRole('button', { name: /publish now/i })).toBeEnabled()
  })

  it('disables "Publish now" for an editor of a shared draft, says why, and still offers review', async () => {
    canPublish = true
    renderDialog(false)
    const publish = screen.getByRole('button', { name: /publish now/i })
    expect(publish).toBeDisabled()
    await userEvent.setup().hover(publish.parentElement!)
    expect(await screen.findByRole('tooltip')).toHaveTextContent(/owner or a maintainer/i)
    expect(screen.getByRole('button', { name: /submit for review/i })).toBeEnabled()
  })
})

