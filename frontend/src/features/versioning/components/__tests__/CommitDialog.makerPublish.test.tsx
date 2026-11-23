/**
 * Publishing straight away is the server's word when it gives one (`BranchAccess.canPublish`):
 * the publish permission on the workspace — or, in the Playground, having made the graph. So the
 * maker of a Playground graph, who holds no publish permission, may Publish now; someone the
 * server says may not, may not, whatever their permissions; and from a server that doesn't say,
 * the permission decides, as before. The Review & Save stepper offers "Save & publish" the same way.
 */
import { render, screen } from '@testing-library/react'
import { MemoryRouter } from 'react-router-dom'
import { describe, it, expect, vi, beforeEach } from 'vitest'

const { holdsPublish } = vi.hoisted(() => ({ holdsPublish: { value: false } }))

vi.mock('../../hooks/useVersioning', () => ({
  usePublishBranch: () => ({ mutate: vi.fn(), isPending: false }),
  useOpenMergeRequest: () => ({ mutate: vi.fn(), isPending: false }),
  useLivePrForBranch: () => ({ livePr: undefined, pending: false }),
  useBranchViewChanges: () => ({ data: undefined, isLoading: false }),
  useDataSourceDraftsPolicy: () => ({ data: { effective: { selfMerge: true } } }),
}))
vi.mock('@/store/auth', () => ({
  usePermission: (perm: string) => perm !== 'workspace:datasource:publish' || holdsPublish.value,
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

const renderDialog = (canPublish?: boolean) =>
  render(
    <MemoryRouter>
      <CommitDialog workspaceId="ws_play" graphId="g1" branchId="br_1" changeSet={changeSet} onClose={() => {}}
        canPublish={canPublish} />
    </MemoryRouter>,
  )

const publishNow = () => screen.getByRole('button', { name: /publish now/i })

beforeEach(() => { holdsPublish.value = false })

describe('CommitDialog — the server’s word on publishing', () => {
  it('lets the maker of a Playground graph publish, without the publish permission', () => {
    renderDialog(true)
    expect(publishNow()).toBeEnabled()
  })

  it('holds Publish now where the server says no, whatever the permissions', () => {
    holdsPublish.value = true
    renderDialog(false)
    expect(publishNow()).toBeDisabled()
    expect(screen.getByRole('button', { name: /submit for review/i })).toBeEnabled()
  })

  it('falls back to the publish permission when the server doesn’t say', () => {
    const { unmount } = renderDialog(undefined)
    expect(publishNow()).toBeDisabled()
    unmount()
    holdsPublish.value = true
    renderDialog(undefined)
    expect(publishNow()).toBeEnabled()
  })
})
