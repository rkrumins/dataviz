/**
 * BranchSettingsModal — a draft's level, and handing it on:
 *   • its owner or a maintainer makes it public or private, after a dialog that says what changes:
 *     made private, whose unsaved edits are saved first, under their names;
 *   • edits that clash leave the level as it was, and the dialog says whose they are;
 *   • a level the data source's policy rules out can't be chosen, and says why;
 *   • anyone else sees the level, and can't change it;
 *   • its owner hands it to someone else, staying on as a maintainer unless they untick it;
 *   • Save changes only the name and description.
 */
import { render, screen, fireEvent, waitFor } from '@testing-library/react'
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { StagedChangesUnsavedError, type Branch } from '@/services/versioningApiService'

const notify = vi.fn()
const updateMutate = vi.fn()
const levelMutateAsync = vi.fn()
const transferMutateAsync = vi.fn()
let membersData: { members: unknown[]; myRole: string | null } | undefined
let impact: { visibility: string; saved: Array<{ actor: string; changes: number }>; userNames?: Record<string, string> } | undefined
let policy: { effective: { levels: string } } | undefined

vi.mock('@/components/ui/notifications', () => ({ useAppNotifications: () => ({ notify }) }))
vi.mock('@/services/userDirectoryService', () => ({ searchDirectory: vi.fn() }))
vi.mock('@/store/auth', () => ({
  useAuthStore: (selector: (s: unknown) => unknown) => selector({ user: { id: 'alice' } }),
}))
vi.mock('../../hooks/useVersioning', () => ({
  useUpdateBranch: () => ({ mutate: updateMutate, isPending: false }),
  useBranchMembers: () => ({ data: membersData, isLoading: false }),
  useAddBranchMember: () => ({ mutate: vi.fn(), mutateAsync: vi.fn(), isPending: false }),
  useRemoveBranchMember: () => ({ mutate: vi.fn(), isPending: false }),
  useSetDraftLevel: () => ({ mutateAsync: levelMutateAsync, isPending: false }),
  useDraftLevelImpact: (_ws: string, _g: string, _b: string, visibility: string | null) =>
    ({ data: visibility ? impact : undefined, isLoading: false }),
  useTransferDraft: () => ({ mutateAsync: transferMutateAsync, isPending: false }),
  useDataSourceDraftsPolicy: () => ({ data: policy }),
}))

import { searchDirectory } from '@/services/userDirectoryService'
import { BranchSettingsModal } from '../BranchSettingsModal'

const access = (canManage: boolean) => ({ canRead: true, canWrite: true, canManage })

const branch = (over: Partial<Branch> = {}) =>
  ({
    branchId: 'br_1', kind: 'draft', status: 'open', name: 'Q3 pricing', owner: 'alice',
    visibility: 'public', access: access(true), baseCommitSeq: 5, originatingViewId: null,
    createdAt: '2026-06-10T00:00:00Z', updatedAt: '2026-06-14T00:00:00Z',
    ...over,
  }) as Branch

const onClose = vi.fn()
const renderModal = (b: Branch = branch()) =>
  render(<BranchSettingsModal wsId="ws1" graphId="g1" viewId={null} dataSourceId="ds1" branch={b} onClose={onClose} />)

describe('a draft’s level', () => {
  beforeEach(() => {
    for (const f of [notify, updateMutate, levelMutateAsync, transferMutateAsync, onClose]) f.mockReset()
    membersData = { members: [], myRole: 'owner' }
    impact = { visibility: 'private', saved: [{ actor: 'bob', changes: 2 }], userNames: { bob: 'Bob B' } }
    policy = { effective: { levels: 'any' } }
    levelMutateAsync.mockResolvedValue({})
    transferMutateAsync.mockResolvedValue({})
  })

  it('is made private after a dialog that names whose unsaved edits are saved first', async () => {
    renderModal()
    expect(screen.getByRole('button', { name: /Public/ })).toHaveAttribute('aria-pressed', 'true')
    fireEvent.click(screen.getByRole('button', { name: /Private/ }))
    const dialog = await screen.findByRole('dialog', { name: 'Make this draft private?' })
    expect(dialog).toHaveTextContent('Bob B')
    expect(dialog).toHaveTextContent('2 unsaved changes')
    fireEvent.click(screen.getByRole('button', { name: 'Make private' }))
    await waitFor(() => expect(levelMutateAsync).toHaveBeenCalledWith({ branchId: 'br_1', visibility: 'private' }))
    expect(notify).toHaveBeenCalledWith('success', expect.stringContaining('private'))
  })

  it('is made public after a dialog that says who will see it', async () => {
    renderModal(branch({ visibility: 'private' }))
    fireEvent.click(screen.getByRole('button', { name: /Public/ }))
    const dialog = await screen.findByRole('dialog', { name: 'Make this draft public?' })
    expect(dialog).toHaveTextContent('Everyone who can see this data source')
    fireEvent.click(screen.getByRole('button', { name: 'Make public' }))
    await waitFor(() => expect(levelMutateAsync).toHaveBeenCalledWith({ branchId: 'br_1', visibility: 'public' }))
  })

  it('stays as it was when someone’s edits clash, naming whose', async () => {
    levelMutateAsync.mockRejectedValue(new StagedChangesUnsavedError({ actors: ['bob'] }))
    renderModal()
    fireEvent.click(screen.getByRole('button', { name: /Private/ }))
    fireEvent.click(await screen.findByRole('button', { name: 'Make private' }))
    expect(await screen.findByRole('alert')).toHaveTextContent('Bob B')
    expect(screen.getByRole('dialog', { name: 'Make this draft private?' })).toBeInTheDocument()
  })

  it('can’t be one the data source’s policy rules out', () => {
    policy = { effective: { levels: 'public_only' } }
    renderModal()
    expect(screen.getByRole('button', { name: /Private/ })).toBeDisabled()
  })

  it('is read-only to someone who doesn’t manage the draft', () => {
    membersData = { members: [], myRole: 'editor' }
    renderModal(branch({ owner: 'bob', access: access(false) }))
    expect(screen.getByRole('button', { name: /Private/ })).toBeDisabled()
    expect(screen.getByRole('button', { name: /Public/ })).toBeDisabled()
  })
})

describe('handing a draft on', () => {
  beforeEach(() => {
    for (const f of [notify, updateMutate, transferMutateAsync, onClose]) f.mockReset()
    membersData = { members: [], myRole: 'owner' }
    policy = { effective: { levels: 'any' } }
    transferMutateAsync.mockResolvedValue({})
    vi.mocked(searchDirectory).mockResolvedValue({
      users: [{ id: 'dave', displayName: 'Dave', email: 'dave@acme.com' }], groups: [],
    } as never)
  })

  it('goes to who its owner picks, keeping them on as a maintainer unless they untick it', async () => {
    renderModal()
    fireEvent.change(screen.getByLabelText('New owner'), { target: { value: 'dav' } })
    fireEvent.click(await screen.findByText('Dave'))
    const stay = screen.getByRole('checkbox', { name: 'Stay on as a maintainer' })
    expect(stay).toBeChecked()
    fireEvent.click(stay)
    fireEvent.click(screen.getByRole('button', { name: 'Hand on to Dave' }))
    await waitFor(() => expect(transferMutateAsync).toHaveBeenCalledWith(
      { branchId: 'br_1', to: 'dave', keepPrevious: false }))
    expect(onClose).toHaveBeenCalled()
  })

  it('is its owner’s to do', () => {
    membersData = { members: [], myRole: 'maintainer' }
    renderModal(branch({ owner: 'bob' }))
    expect(screen.queryByLabelText('New owner')).not.toBeInTheDocument()
  })
})

describe('saving', () => {
  it('changes the name and description only', () => {
    membersData = { members: [], myRole: 'owner' }
    renderModal()
    fireEvent.change(screen.getByPlaceholderText('Untitled draft'), { target: { value: 'Q4 pricing' } })
    fireEvent.click(screen.getByRole('button', { name: 'Save changes' }))
    expect(updateMutate.mock.calls[0][0]).toEqual({ branchId: 'br_1', name: 'Q4 pricing', description: '' })
  })
})
