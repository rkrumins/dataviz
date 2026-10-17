/**
 * BranchManager — pins the overview behaviour:
 *   • lists open drafts by name;
 *   • Archive on a card opens a confirm, and confirming calls the abandon mutation with the id;
 *   • a draft being published stays listed, badged 'Publishing…';
 *   • the Archived tab lists merged and abandoned drafts.
 * Child sub-flows (settings/publish/pull) are stubbed so the test stays focused on the manager.
 */
import { render, screen, fireEvent } from '@testing-library/react'
import { describe, it, expect, vi, beforeEach } from 'vitest'

const notify = vi.fn()
const abandonMutate = vi.fn()
const openMutate = vi.fn()

let branchesData: unknown[] = []
let archivedData: unknown[] = []

const useBranchesMock = vi.fn(
  (_wsId?: string, _gid?: string | null, _viewId?: string | null, status?: string[]) =>
    ({ data: status ? archivedData : branchesData, isLoading: false }),
)

vi.mock('@/components/ui/notifications', () => ({ useAppNotifications: () => ({ notify }) }))
vi.mock('../PullLatestButton', () => ({ PullLatestButton: () => null }))
vi.mock('../BranchSettingsModal', () => ({ BranchSettingsModal: () => null }))
vi.mock('../CommitDialog', () => ({ CommitDialog: () => null }))
vi.mock('../../hooks/useVersioning', () => ({
  useBranches: (wsId?: string, gid?: string | null, viewId?: string | null, status?: string[]) =>
    useBranchesMock(wsId, gid, viewId, status),
  useOpenDraft: () => ({ mutate: openMutate, isPending: false }),
  useAbandonDraft: () => ({ mutate: abandonMutate, isPending: false }),
  useDiffVsMain: () => ({ data: undefined, isLoading: false }),
}))

import { BranchManager } from '../BranchManager'

const draft = (over: Record<string, unknown>) =>
  ({
    branchId: 'br_1', kind: 'draft', status: 'open', name: 'Q3 pricing',
    owner: 'ana@acme.com', baseCommitSeq: 5, originatingViewId: null,
    createdAt: '2026-06-10T00:00:00Z', updatedAt: '2026-06-14T00:00:00Z',
    ...over,
  })

const renderManager = () =>
  render(
    <BranchManager
      wsId="ws1" graphId="g1" viewId="v1" mainHead={5} currentBranchId={null}
      canManage switchToDraft={vi.fn()} onClose={vi.fn()}
    />,
  )

describe('BranchManager', () => {
  beforeEach(() => {
    notify.mockClear(); abandonMutate.mockClear(); openMutate.mockClear(); useBranchesMock.mockClear()
  })

  it('defaults to this view\'s drafts (passes viewId to useBranches)', () => {
    branchesData = []
    renderManager()
    expect(useBranchesMock).toHaveBeenCalledWith('ws1', 'g1', 'v1', undefined)
  })

  it('toggling "All data source drafts" fetches without a viewId filter', () => {
    branchesData = []
    renderManager()
    fireEvent.click(screen.getByText('All data source drafts'))
    expect(useBranchesMock).toHaveBeenLastCalledWith('ws1', 'g1', undefined, undefined)

    // Toggling back to "This view" restores the per-view filter.
    fireEvent.click(screen.getByText('This view'))
    expect(useBranchesMock).toHaveBeenLastCalledWith('ws1', 'g1', 'v1', undefined)
  })

  it('lists open drafts by name', () => {
    branchesData = [draft({ branchId: 'br_1', name: 'Q3 pricing' }), draft({ branchId: 'br_2', name: 'Logo refresh' })]
    renderManager()
    expect(screen.getByText('Q3 pricing')).toBeInTheDocument()
    expect(screen.getByText('Logo refresh')).toBeInTheDocument()
  })

  it('archives a draft after confirmation', () => {
    branchesData = [draft({ branchId: 'br_1', name: 'Q3 pricing' })]
    renderManager()
    // The card's Archive icon button, then the confirm's "Archive draft"
    // button. Found by its accessible NAME, not by a `title`: the row's icon
    // controls carry an explicit `aria-label` now, because the `title` that
    // used to name them has become a HoverTip and a sighted-only tooltip
    // would have left them nameless.
    fireEvent.click(screen.getByRole('button', { name: 'Archive this draft' }))
    fireEvent.click(screen.getByRole('button', { name: /archive draft/i }))
    expect(abandonMutate).toHaveBeenCalledWith('br_1', expect.anything())
  })

  it('shows an empty state when there are no drafts', () => {
    branchesData = []
    renderManager()
    expect(screen.getByText(/Create a draft to edit safely/i)).toBeInTheDocument()
  })

  it('resolves the owner id via userNames and searches by the resolved name', () => {
    branchesData = [draft({ branchId: 'br_1', name: 'Q3 pricing', owner: 'usr_abc123', userNames: { usr_abc123: 'Ana Lee' } })]
    renderManager()
    expect(screen.getByText('Ana Lee')).toBeInTheDocument()
    expect(screen.queryByText('usr_abc123')).not.toBeInTheDocument()

    fireEvent.change(screen.getByPlaceholderText('Search drafts…'), { target: { value: 'ana lee' } })
    expect(screen.getByText('Q3 pricing')).toBeInTheDocument()
  })

  it('keeps a draft being published in the list, badged and without Publish or Archive', () => {
    branchesData = [
      draft({ branchId: 'br_1', name: 'Q3 pricing' }),
      draft({ branchId: 'br_2', name: 'Logo refresh', status: 'publishing' }),
    ]
    renderManager()
    expect(screen.getByText('Logo refresh')).toBeInTheDocument()
    expect(screen.getByText('Publishing…')).toBeInTheDocument()
    expect(screen.getAllByRole('button', { name: 'Archive this draft' })).toHaveLength(1)
    expect(screen.getAllByRole('button', { name: /^Publish$/ })).toHaveLength(1)
  })

  it('the Archived tab asks for merged and abandoned drafts and lists them read-only', () => {
    branchesData = [draft({ branchId: 'br_1', name: 'Q3 pricing' })]
    archivedData = [
      draft({ branchId: 'br_8', name: 'Shipped pricing', status: 'merged' }),
      draft({ branchId: 'br_9', name: 'Dropped idea', status: 'abandoned' }),
    ]
    renderManager()
    fireEvent.click(screen.getByRole('button', { name: 'Archived' }))
    expect(useBranchesMock).toHaveBeenLastCalledWith('ws1', 'g1', 'v1', ['merged', 'abandoned'])
    expect(screen.getByText('Shipped pricing')).toBeInTheDocument()
    expect(screen.getByText('Dropped idea')).toBeInTheDocument()
    expect(screen.queryByText('Q3 pricing')).not.toBeInTheDocument()
    expect(screen.queryByRole('button', { name: 'Archive this draft' })).not.toBeInTheDocument()
    expect(screen.queryByRole('button', { name: /^Open$/ })).not.toBeInTheDocument()

    fireEvent.click(screen.getByRole('button', { name: 'Active' }))
    expect(useBranchesMock).toHaveBeenLastCalledWith('ws1', 'g1', 'v1', undefined)
    expect(screen.getByText('Q3 pricing')).toBeInTheDocument()
  })
})
