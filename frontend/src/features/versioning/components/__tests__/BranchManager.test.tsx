/**
 * BranchManager — pins the overview behaviour:
 *   • lists open drafts by name;
 *   • Archive on a card opens a confirm, and confirming calls the abandon mutation with the id.
 * Child sub-flows (settings/publish/pull) are stubbed so the test stays focused on the manager.
 */
import { render, screen, fireEvent } from '@testing-library/react'
import { describe, it, expect, vi, beforeEach } from 'vitest'

const showToast = vi.fn()
const abandonMutate = vi.fn()
const openMutate = vi.fn()

let branchesData: unknown[] = []

const useBranchesMock = vi.fn(
  (_wsId?: string, _gid?: string | null, _viewId?: string | null) => ({ data: branchesData, isLoading: false }),
)

vi.mock('@/components/ui/toast', () => ({ useToast: () => ({ showToast }) }))
vi.mock('../PullLatestButton', () => ({ PullLatestButton: () => null }))
vi.mock('../BranchSettingsModal', () => ({ BranchSettingsModal: () => null }))
vi.mock('../CommitDialog', () => ({ CommitDialog: () => null }))
vi.mock('../../hooks/useVersioning', () => ({
  useBranches: (wsId?: string, gid?: string | null, viewId?: string | null) => useBranchesMock(wsId, gid, viewId),
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
    showToast.mockClear(); abandonMutate.mockClear(); openMutate.mockClear(); useBranchesMock.mockClear()
  })

  it('defaults to this view\'s drafts (passes viewId to useBranches)', () => {
    branchesData = []
    renderManager()
    expect(useBranchesMock).toHaveBeenCalledWith('ws1', 'g1', 'v1')
  })

  it('toggling "All data source drafts" fetches without a viewId filter', () => {
    branchesData = []
    renderManager()
    fireEvent.click(screen.getByText('All data source drafts'))
    expect(useBranchesMock).toHaveBeenLastCalledWith('ws1', 'g1', undefined)

    // Toggling back to "This view" restores the per-view filter.
    fireEvent.click(screen.getByText('This view'))
    expect(useBranchesMock).toHaveBeenLastCalledWith('ws1', 'g1', 'v1')
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
    // The card's Archive icon button (title), then the confirm's "Archive draft" button.
    fireEvent.click(screen.getByTitle('Archive this draft'))
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
})
