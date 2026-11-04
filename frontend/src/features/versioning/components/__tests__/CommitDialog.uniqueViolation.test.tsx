/**
 * A publish refused because values that must be unique are shared says which, in the dialog: one
 * row per value — "sap_id 'X' is used by 2 Table entities" — and how many there are in all when
 * the server listed only some of them.
 */
import { render, screen, fireEvent } from '@testing-library/react'
import { MemoryRouter } from 'react-router-dom'
import { describe, it, expect, vi } from 'vitest'
import { UniqueViolationError } from '@/services/versioningApiService'

const publishMutate = vi.fn()
vi.mock('../../hooks/useVersioning', () => ({
  useDataSourceDraftsPolicy: () => ({ data: undefined }),
  usePublishBranch: () => ({ mutate: publishMutate, isPending: false }),
  useOpenMergeRequest: () => ({ mutate: vi.fn(), isPending: false }),
  useLivePrForBranch: () => ({ livePr: undefined, pending: false }),
  useBranchViewChanges: () => ({ data: { branchId: 'br_1', hidden: 0, views: [] }, isLoading: false }),
}))
vi.mock('@/store/auth', () => ({ usePermission: () => true }))
const notify = vi.fn()
vi.mock('@/components/ui/notifications', () => ({ useAppNotifications: () => ({ notify }) }))
vi.mock('@/store/branchStore', () => ({
  useBranchStore: (sel: (s: unknown) => unknown) => sel({ switchToMain: vi.fn() }),
}))
vi.mock('@/store/publishReceiptStore', () => ({
  usePublishReceiptStore: (sel: (s: unknown) => unknown) => sel({ setReceipt: vi.fn() }),
}))

import { CommitDialog } from '../CommitDialog'
import { buildChangeSet } from '../../model/changeModel'

describe('CommitDialog — a publish refused for values that must be unique', () => {
  it('lists each shared value with its count of entities, and the total', () => {
    publishMutate.mockImplementation((_v, opts: { onError: (e: unknown) => void }) => opts.onError(new UniqueViolationError([
      { type: 'Table', field: 'sap_id', value: 'X', entities: ['urn:t:1', 'urn:t:2'] },
      { type: 'Table', field: 'sap_id', value: 'Y', entities: ['urn:t:3', 'urn:t:4', 'urn:t:5'] },
    ], 5)))
    render(
      <MemoryRouter>
        <CommitDialog workspaceId="ws1" graphId="g1" branchId="br_1"
          changeSet={buildChangeSet([{ entityId: 'a', kind: 'node', status: 'added', label: 'A', origin: { source: 'branch', branchId: 'br_1' } }])}
          onClose={vi.fn()} />
      </MemoryRouter>,
    )
    fireEvent.click(screen.getByRole('button', { name: /publish now/i }))

    expect(screen.getByText("sap_id 'X' is used by 2 Table entities")).toBeInTheDocument()
    expect(screen.getByText("sap_id 'Y' is used by 3 Table entities")).toBeInTheDocument()
    expect(screen.getByText(/5 values that must be unique are used more than once/)).toBeInTheDocument()
    expect(screen.getByText(/and 3 more/)).toBeInTheDocument()
    expect(notify).not.toHaveBeenCalled()
  })
})
