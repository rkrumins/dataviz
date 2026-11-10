/**
 * ViewVersioningPanel's Changes tab on the Context View: a summary of what the canvas shows — the
 * draft's saved changes, or on Published the latest revision's — with Review changes, which closes
 * the panel and lists them beside the canvas. Elsewhere it keeps the draft's tree.
 */
import { fireEvent, render, screen } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'

const h = vi.hoisted(() => ({ treeAsked: [] as unknown[], summaryAsked: [] as unknown[] }))
vi.mock('../../hooks/useVersioning', () => ({
  useBranchDiffSummary: (_ws: string, _g: string, branchId: string | null) => {
    h.treeAsked.push(branchId)
    return { data: undefined, isLoading: false }
  },
  useBranchViewChanges: () => ({ data: undefined, isLoading: false }),
  useChangeSummary: (_ws: string, _g: string, origin: unknown) => {
    h.summaryAsked.push(origin)
    return {
      isLoading: false,
      data: {
        origin, counts: { added: 3, modified: 0, removed: 4 }, impact: {}, total: 7, listed: 7, approximate: false,
        byType: [{ kind: 'node', type: 'Table', added: 3, modified: 0, removed: 4 }],
      },
    }
  },
}))
vi.mock('@/services/versioningApiService', () => ({ getBranchDiffChildren: vi.fn() }))
vi.mock('@/store/stagedChangesStore', () => ({
  useStagedChangesStore: (sel: (s: unknown) => unknown) => sel({ changes: [], openReviewPanel: vi.fn() }),
}))
vi.mock('../ChangeTreePanel', () => ({ ChangeTreePanel: () => <p>the draft’s tree</p> }))
vi.mock('../../../reviews/components/ViewPrList', () => ({ ViewPrList: () => null }))
vi.mock('../ViewHistoryTimeline', () => ({ ViewHistoryTimeline: () => null }))
vi.mock('../DataHealthTab', () => ({ DataHealthTab: () => null }))

import { useBranchStore } from '@/store/branchStore'
import { useReviewStore } from '@/store/reviewStore'
import { ViewVersioningPanel } from '../ViewVersioningPanel'

const onClose = vi.fn()
const renderPanel = (branchId: string | null) =>
  render(<ViewVersioningPanel wsId="ws1" graphId="g1" viewId="v1" branchId={branchId} onClose={onClose} />)

beforeEach(() => {
  h.treeAsked = []
  h.summaryAsked = []
  onClose.mockReset()
  useBranchStore.getState().reset()
  useBranchStore.setState({ workspaceId: 'ws1', dataSourceId: 'ds1', viewId: 'v1', graphId: 'g1', mainHeadCommitSeq: 42 })
  useReviewStore.setState({ available: true, navigatorOpen: false, listOpen: false, scope: null, operation: null, filter: {} })
})

describe('ViewVersioningPanel — Changes, on the Context View', () => {
  it("summarises a draft's saved changes and reviews them beside the canvas", () => {
    useBranchStore.setState({ currentBranchId: 'br_1' })
    renderPanel('br_1')

    const card = screen.getByRole('region', { name: 'Committed in this branch' })
    expect(card).toHaveTextContent('7 changes')
    expect(h.summaryAsked.at(-1)).toEqual({ branchId: 'br_1' })
    expect(h.treeAsked.every((b) => b === null)).toBe(true)            // no tree to fetch for
    fireEvent.click(screen.getByRole('button', { name: 'Review 4 deleted' }))
    expect(onClose).toHaveBeenCalled()
    expect(useReviewStore.getState()).toMatchObject({ navigatorOpen: true, scope: { kind: 'draft' }, operation: 'removed' })
  })

  it('summarises the latest revision on Published, where it had nothing to say', () => {
    renderPanel(null)

    expect(screen.getByRole('region', { name: 'The latest revision · #42' })).toBeInTheDocument()
    expect(h.summaryAsked.at(-1)).toEqual({ fromSeq: 41, toSeq: 42 })
    fireEvent.click(screen.getByRole('button', { name: 'Review changes' }))
    expect(useReviewStore.getState()).toMatchObject({ navigatorOpen: true, scope: { kind: 'in', seq: 42 }, operation: null })
  })

  it('keeps the draft’s tree, and says to switch to one, elsewhere', () => {
    useReviewStore.setState({ available: false })
    useBranchStore.setState({ currentBranchId: 'br_1' })
    const { unmount } = renderPanel('br_1')
    expect(screen.getByText('the draft’s tree')).toBeInTheDocument()
    expect(h.treeAsked.at(-1)).toBe('br_1')
    unmount()

    renderPanel(null)
    expect(screen.getByText('Switch to a draft to review its changes.')).toBeInTheDocument()
  })
})
