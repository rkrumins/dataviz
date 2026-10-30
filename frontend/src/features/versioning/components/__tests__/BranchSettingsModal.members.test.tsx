/**
 * BranchSettingsModal — a draft's members:
 *   • the owner sees each member's name and role, can remove one and add someone as any role;
 *   • a private draft with nobody added says only its owner sees it;
 *   • a maintainer manages members, and who sees the draft; an editor only reads the list.
 * (Its level, and handing it on: BranchSettingsModal.level.test.tsx.)
 */
import { render, screen, fireEvent, within, waitFor } from '@testing-library/react'
import { describe, it, expect, vi, beforeEach } from 'vitest'
import type { Branch, BranchMember } from '@/services/versioningApiService'

const notify = vi.fn()
const updateMutate = vi.fn()
const addMutateAsync = vi.fn()
const addMutate = vi.fn()
const removeMutate = vi.fn()
let membersData: { members: BranchMember[]; myRole: string | null } | undefined

vi.mock('@/components/ui/notifications', () => ({ useAppNotifications: () => ({ notify }) }))
vi.mock('@/services/userDirectoryService', () => ({ searchDirectory: vi.fn() }))
vi.mock('@/store/auth', () => ({
  useAuthStore: (selector: (s: unknown) => unknown) => selector({ user: { id: 'alice' } }),
}))
vi.mock('../../hooks/useVersioning', () => ({
  useUpdateBranch: () => ({ mutate: updateMutate, isPending: false }),
  useBranchMembers: () => ({ data: membersData, isLoading: false }),
  useAddBranchMember: () => ({ mutate: addMutate, mutateAsync: addMutateAsync, isPending: false }),
  useRemoveBranchMember: () => ({ mutate: removeMutate, isPending: false }),
  useSetDraftLevel: () => ({ mutateAsync: vi.fn(), isPending: false }),
  useDraftLevelImpact: () => ({ data: undefined, isLoading: false }),
  useTransferDraft: () => ({ mutateAsync: vi.fn(), isPending: false }),
  useDataSourceDraftsPolicy: () => ({ data: undefined }),
}))

import { searchDirectory } from '@/services/userDirectoryService'
import { BranchSettingsModal } from '../BranchSettingsModal'

const branch = (over: Partial<Branch> = {}) =>
  ({
    branchId: 'br_1', kind: 'draft', status: 'open', name: 'Q3 pricing', owner: 'alice',
    isShared: true, baseCommitSeq: 5, originatingViewId: null,
    createdAt: '2026-06-10T00:00:00Z', updatedAt: '2026-06-14T00:00:00Z',
    ...over,
  }) as Branch

const bobAndEng: BranchMember[] = [
  { subjectType: 'user', subjectId: 'bob', role: 'editor', name: 'Bob B' },
  { subjectType: 'group', subjectId: 'grp_eng', role: 'viewer', name: 'Eng' },
]

const renderModal = (b: Branch = branch()) =>
  render(<BranchSettingsModal wsId="ws1" graphId="g1" viewId={null} branch={b} onClose={vi.fn()} />)

/** Search the picker for Dave and add him with the picker's chosen role. */
const addDave = async (role: string) => {
  vi.mocked(searchDirectory).mockResolvedValue({
    users: [{ id: 'dave', displayName: 'Dave', email: 'dave@acme.com' }], groups: [],
  } as never)
  fireEvent.click(screen.getByTitle(`Grant ${role} access`))
  fireEvent.focus(screen.getByPlaceholderText('Add a user…'))
  fireEvent.click(await screen.findByText('Dave'))
}

describe('BranchSettingsModal members', () => {
  beforeEach(() => {
    for (const f of [notify, updateMutate, addMutateAsync, addMutate, removeMutate]) f.mockReset()
    addMutateAsync.mockResolvedValue({})
  })

  it('shows the owner each member, and lets them remove one and add someone', async () => {
    membersData = { members: bobAndEng, myRole: 'owner' }
    renderModal()
    expect(screen.getByText('Bob B')).toBeInTheDocument()
    expect(screen.getByText('Eng')).toBeInTheDocument()
    const bobRole = screen.getByRole('radiogroup', { name: 'Role of Bob B' })
    expect(within(bobRole).getByRole('radio', { checked: true })).toHaveTextContent('Editor')
    const engRole = screen.getByRole('radiogroup', { name: 'Role of Eng' })
    expect(within(engRole).getByRole('radio', { checked: true })).toHaveTextContent('Viewer')

    fireEvent.click(screen.getByRole('button', { name: 'Remove Bob B' }))
    expect(removeMutate.mock.calls[0][0]).toEqual({ subjectType: 'user', subjectId: 'bob' })

    await addDave('maintainer')
    await waitFor(() => expect(addMutateAsync).toHaveBeenCalledWith(
      { subjectType: 'user', subjectId: 'dave', role: 'maintainer' }))
  })

  it('says only its owner sees a private draft with nobody added', async () => {
    membersData = { members: [], myRole: 'owner' }
    renderModal(branch({ isShared: false, visibility: 'private' }))
    expect(screen.getByText('Only you can see this draft')).toBeInTheDocument()
    await addDave('editor')
    await waitFor(() => expect(addMutateAsync).toHaveBeenCalled())
  })

  it('lets a maintainer manage members, and who sees the draft', () => {
    membersData = { members: bobAndEng, myRole: 'maintainer' }
    const access = { canRead: true, canWrite: true, canManage: true }
    renderModal(branch({ owner: 'bob', visibility: 'private', access }))
    expect(screen.getByPlaceholderText('Add a user…')).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Remove Bob B' })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: /Public/ })).toBeEnabled()
    expect(screen.queryByLabelText('New owner')).not.toBeInTheDocument()   // handing on is the owner's
  })

  it('shows an editor the members read-only', () => {
    membersData = { members: bobAndEng, myRole: 'editor' }
    const access = { canRead: true, canWrite: true, canManage: false }
    renderModal(branch({ owner: 'bob', visibility: 'private', access }))
    expect(screen.getByText('Bob B')).toBeInTheDocument()
    expect(screen.queryByPlaceholderText('Add a user…')).not.toBeInTheDocument()
    expect(screen.queryByRole('button', { name: 'Remove Bob B' })).not.toBeInTheDocument()
    expect(screen.queryByRole('radiogroup', { name: 'Role of Bob B' })).not.toBeInTheDocument()
    expect(screen.getByRole('button', { name: /Public/ })).toBeDisabled()
  })
})
