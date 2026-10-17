/**
 * CommitDialog — the author can ask workspace members to review: the people they pick go out with
 * the review as `reviewers`, so it cannot merge until they approve.
 */
import { render, screen, fireEvent } from '@testing-library/react'
import { MemoryRouter } from 'react-router-dom'
import { describe, it, expect, vi, beforeEach } from 'vitest'

const openMrMutate = vi.fn()
const listReviewerCandidates = vi.fn()

vi.mock('../../hooks/useVersioning', () => ({
  usePublishBranch: () => ({ mutate: vi.fn(), isPending: false }),
  useOpenMergeRequest: () => ({ mutate: openMrMutate, isPending: false }),
  useLivePrForBranch: () => ({ livePr: undefined, pending: false }),
  useBranchViewChanges: () => ({ data: undefined, isLoading: false }),
}))
vi.mock('@/services/versioningApiService', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/services/versioningApiService')>()),
  listReviewerCandidates: (wsId: string) => listReviewerCandidates(wsId),
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

beforeEach(() => {
  openMrMutate.mockClear()
  listReviewerCandidates.mockReset()
  listReviewerCandidates.mockResolvedValue([
    { userId: 'u_carol', displayName: 'Carol Chen', email: 'carol@example.com' },
    { userId: 'u_dave', displayName: 'Dave Diaz', email: 'dave@example.com' },
  ])
})

describe('CommitDialog — reviewers', () => {
  it('sends the reviewers picked with the review', async () => {
    render(
      <MemoryRouter>
        <CommitDialog workspaceId="ws1" graphId="g1" branchId="br_1" changeSet={changeSet} onClose={() => {}} />
      </MemoryRouter>,
    )
    fireEvent.click(screen.getByRole('button', { name: /add reviewers/i }))
    fireEvent.click(await screen.findByRole('button', { name: /Carol Chen/ }))
    expect(listReviewerCandidates).toHaveBeenCalledWith('ws1')
    fireEvent.click(screen.getByRole('button', { name: /submit for review/i }))
    expect(openMrMutate).toHaveBeenCalledTimes(1)
    expect(openMrMutate.mock.calls[0][0]).toMatchObject({ branchId: 'br_1', reviewers: ['u_carol'] })
  })

  it('sends no reviewers when none are picked', () => {
    render(
      <MemoryRouter>
        <CommitDialog workspaceId="ws1" graphId="g1" branchId="br_1" changeSet={changeSet} onClose={() => {}} />
      </MemoryRouter>,
    )
    fireEvent.click(screen.getByRole('button', { name: /submit for review/i }))
    expect(openMrMutate.mock.calls[0][0].reviewers).toBeUndefined()
    expect(listReviewerCandidates).not.toHaveBeenCalled()
  })
})
