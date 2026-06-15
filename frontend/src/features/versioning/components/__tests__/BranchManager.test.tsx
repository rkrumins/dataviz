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

vi.mock('@/components/ui/toast', () => ({ useToast: () => ({ showToast }) }))
vi.mock('../PullLatestButton', () => ({ PullLatestButton: () => null }))
vi.mock('../BranchSettingsModal', () => ({ BranchSettingsModal: () => null }))
vi.mock('../CommitDialog', () => ({ CommitDialog: () => null }))
vi.mock('../../hooks/useVersioning', () => ({
  useBranches: () => ({ data: branchesData, isLoading: false }),
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
    showToast.mockClear(); abandonMutate.mockClear(); openMutate.mockClear()
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
})
