/**
 * DraftsWhoseOwnerLeft — a workspace admin hands on the drafts whose owner left:
 *   • each row says the draft's name ('Untitled draft' without one), its owner by name, its level
 *     and when it last changed — never what it holds;
 *   • Hand on opens the hand-on form for that draft, the previous owner kept on only if ticked, and
 *     the list is read again once it's done;
 *   • with none, it says so;
 *   • anyone else sees nothing, and the list isn't asked for.
 */
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { OwnerLeftDraft } from '@/services/versioningApiService'

const notify = vi.fn()
const refetch = vi.fn()
const transferMutateAsync = vi.fn()
let isAdmin = true
let rows: OwnerLeftDraft[] | undefined
const useDraftsWhoseOwnerLeft = vi.fn((_ws?: string | null) => ({ data: rows, isLoading: false, refetch }))

vi.mock('@/components/ui/notifications', () => ({ useAppNotifications: () => ({ notify }) }))
vi.mock('@/services/userDirectoryService', () => ({ searchDirectory: vi.fn() }))
vi.mock('@/store/auth', () => ({ usePermission: (p: string) => p === 'workspace:admin' && isAdmin }))
vi.mock('@/features/versioning/hooks/useVersioning', () => ({
  useDraftsWhoseOwnerLeft: (ws?: string | null) => useDraftsWhoseOwnerLeft(ws),
  useTransferDraft: () => ({ mutateAsync: transferMutateAsync, isPending: false }),
}))

import { searchDirectory } from '@/services/userDirectoryService'
import { DraftsWhoseOwnerLeft } from '../DraftsWhoseOwnerLeft'

const draft = (over: Partial<OwnerLeftDraft> = {}): OwnerLeftDraft => ({
  graphId: 'g1', branchId: 'b1', dataSourceId: 'ds1', name: 'Q3 pricing', owner: 'ana', visibility: 'private',
  status: 'open', updatedAt: new Date(Date.now() - 3 * 86_400_000).toISOString(), userNames: { ana: 'Ana Lee' },
  ...over,
})

beforeEach(() => {
  for (const f of [notify, refetch, transferMutateAsync, useDraftsWhoseOwnerLeft]) f.mockClear()
  isAdmin = true
  rows = [draft()]
  transferMutateAsync.mockResolvedValue({})
  vi.mocked(searchDirectory).mockResolvedValue({
    users: [{ id: 'dave', displayName: 'Dave', email: 'dave@acme.com' }], groups: [],
  } as never)
})

describe('drafts whose owner left', () => {
  it('lists each with its name, owner, level and when it last changed', () => {
    rows = [draft(), draft({ branchId: 'b2', name: null, visibility: 'public' })]
    render(<DraftsWhoseOwnerLeft wsId="ws1" />)
    const [first, second] = screen.getAllByRole('listitem')
    expect(first).toHaveTextContent('Q3 pricing')
    expect(first).toHaveTextContent('Ana Lee')
    expect(within(first).getByText('Private')).toBeInTheDocument()
    expect(first).toHaveTextContent('3d ago')
    expect(second).toHaveTextContent('Untitled draft')
    expect(within(second).getByText('Public')).toBeInTheDocument()
  })

  it('hands one on, keeping its owner on only if ticked, and reads the list again', async () => {
    render(<DraftsWhoseOwnerLeft wsId="ws1" />)
    fireEvent.click(screen.getByRole('button', { name: 'Hand on' }))
    fireEvent.change(screen.getByLabelText('New owner'), { target: { value: 'dav' } })
    fireEvent.click(await screen.findByText('Dave'))
    expect(screen.getByRole('checkbox', { name: 'Keep Ana Lee on as a maintainer' })).not.toBeChecked()
    fireEvent.click(screen.getByRole('button', { name: 'Hand on to Dave' }))
    await waitFor(() => expect(transferMutateAsync).toHaveBeenCalledWith({ branchId: 'b1', to: 'dave', keepPrevious: false }))
    await waitFor(() => expect(refetch).toHaveBeenCalled())
    expect(screen.queryByLabelText('New owner')).not.toBeInTheDocument()
  })

  it('says when no draft is waiting for a new owner', () => {
    rows = []
    render(<DraftsWhoseOwnerLeft wsId="ws1" />)
    expect(screen.getByText('No drafts are waiting for a new owner')).toBeInTheDocument()
  })

  it('shows nothing to someone who isn’t a workspace admin, and doesn’t ask for the list', () => {
    isAdmin = false
    const { container } = render(<DraftsWhoseOwnerLeft wsId="ws1" />)
    expect(container).toBeEmptyDOMElement()
    expect(useDraftsWhoseOwnerLeft).not.toHaveBeenCalledWith('ws1')
  })
})
