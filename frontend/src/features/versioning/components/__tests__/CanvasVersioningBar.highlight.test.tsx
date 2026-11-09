/**
 * CanvasVersioningBar, a comparison of two revisions highlighted on the canvas: it asks for no more
 * of the comparison's changes than the canvas rings (20,000), and past that it says how many there
 * are and opens their list in History instead of drawing. A large draft's rings ask for every change,
 * as they always have.
 */
import { fireEvent, render, screen } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { DiffTooLargeError } from '@/services/versioningApiService'

const state = vi.hoisted(() => ({
  branchId: null as string | null,
  diffError: null as unknown,
  index: undefined as unknown,
}))
const useChangeIndex = vi.hoisted(() => vi.fn())

vi.mock('@/components/ui/notifications', () => ({ useAppNotifications: () => ({ notify: vi.fn() }) }))
vi.mock('@/store/auth', () => ({
  usePermission: () => true,
  useAuthStore: (sel: (s: unknown) => unknown) => sel({ user: { id: 'ana' } }),
}))
vi.mock('@/hooks/useDataSourceProviderMap', () => ({ useDataSourceProviderMap: () => ({ resolve: () => undefined }) }))
vi.mock('@/store/schema', () => ({ useActiveView: () => ({ id: 'v1', name: 'View' }) }))
// One store state across renders, its actions stable, as the real store's are.
const branchState: Record<string, unknown> = {
  committedDiffHidden: false, setCommittedDiffHidden: vi.fn(), setActiveChangeSet: vi.fn(), switchToMain: vi.fn(),
  openRevision: vi.fn(), setHighlight: vi.fn(), viewId: 'v1', activeChangeSet: null,
}
vi.mock('@/store/branchStore', () => ({
  useBranchStore: (sel: (s: unknown) => unknown) => sel(branchState),
  useEffectiveBranchId: () => state.branchId,
  useEffectiveRevision: () => null,
  useRevisionHighlight: () => ({ fromSeq: 3, toSeq: 12 }),
}))
vi.mock('../../hooks/useRevisionViewer', () => ({ useRevisionViewer: () => true }))
vi.mock('../../hooks/useRevisionDeepLink', () => ({ useRevisionDeepLink: () => {} }))
vi.mock('@/store/stagedChangesStore', () => ({ useStagedChangeCount: () => 0 }))
vi.mock('../../hooks/useVersioning', () => ({
  useResolveGraph: () => ({ data: { graphId: 'g1', mainHeadCommitSeq: 12, kind: 'bootstrap' }, isLoading: false }),
  useBranches: () => ({ data: [], isFetching: false }),
  useBranchFreshness: () => ({ data: undefined, error: null }),
  useBranch: () => ({ data: undefined }),
  useRefreshDraftFromOthers: () => vi.fn(),
  useDiffVsMain: () => ({ data: undefined, error: state.diffError, isLoading: false }),
  useChangeIndex: (...args: unknown[]) => {
    useChangeIndex(...args)
    return { data: args[2] ? state.index : undefined, isLoading: false }
  },
  useChangeSummary: () => ({ data: undefined, isLoading: false }),
  useBranchViewChanges: () => ({ data: undefined }),
  useAbandonDraft: () => ({ mutate: vi.fn(), isPending: false }),
}))
vi.mock('../../hooks/useActiveBranchGuard', () => ({ useActiveBranchGuard: () => {} }))
vi.mock('../../model/useBootstrapWatch', () => ({
  useBootstrapWatch: () => ({ showReport: false, showProgress: false, job: null, dismissReport: () => {} }),
}))
vi.mock('../AggregationSyncChip', () => ({ AggregationSyncChip: () => null }))
vi.mock('../BranchSwitcher', () => ({ BranchSwitcher: () => null }))
vi.mock('../ReadRouteChip', () => ({ ReadRouteChip: () => null }))
vi.mock('../RefreshingBadge', () => ({ RefreshingBadge: () => null }))
vi.mock('../PublishReceiptBanner', () => ({ PublishReceiptBanner: () => null }))
vi.mock('../ForkStrip', () => ({ ForkStrip: () => null }))
vi.mock('../ViewVersioningPanel', () => ({
  ViewVersioningPanel: (p: { initialTab: string; compare: { fromSeq: number; toSeq: number | null } | null }) => (
    <p>{p.initialTab} on {p.compare?.fromSeq}→{p.compare?.toSeq}</p>
  ),
}))

import { CanvasVersioningBar } from '../CanvasVersioningBar'
import { useCanvasStore } from '@/store/canvas'
import { buildChangeSet } from '../../model/changeModel'

const setActiveChangeSet = vi.mocked(branchState.setActiveChangeSet as (cs: unknown) => void)

beforeEach(() => {
  state.branchId = null
  state.diffError = null
  state.index = undefined
  useChangeIndex.mockClear()
  setActiveChangeSet.mockClear()
})

describe('CanvasVersioningBar — a comparison highlighted on the canvas', () => {
  it('asks for no more than 20,000 of its changes, and rings them', () => {
    state.index = { origin: { fromSeq: 3, toSeq: 12 }, entries: [['n1', 'n', 'a', 'Table']], total: 1, truncated: false }
    render(<CanvasVersioningBar workspaceId="ws1" dataSourceId="ds1" />)

    expect(useChangeIndex).toHaveBeenCalledWith('ws1', 'g1', { fromSeq: 3, toSeq: 12 }, 20_000)
    expect(screen.getByText('What changed after #3 up to #12')).toBeInTheDocument()
    expect(setActiveChangeSet).toHaveBeenCalledWith(expect.objectContaining({
      changes: [expect.objectContaining({ entityId: 'n1', status: 'added' })],
    }))
  })

  it('past that, says how many changed and opens their list instead of drawing', () => {
    state.index = { origin: { fromSeq: 3, toSeq: 12 }, entries: [], total: 48_213, truncated: true }
    render(<CanvasVersioningBar workspaceId="ws1" dataSourceId="ds1" />)

    expect(screen.getByText('Too many changes to highlight (48,213) —')).toBeInTheDocument()
    expect(setActiveChangeSet).not.toHaveBeenCalled()
    fireEvent.click(screen.getByRole('button', { name: 'Open the list' }))
    expect(screen.getByText('history on 3→12')).toBeInTheDocument()
  })

  it("leaves a large draft's rings as they were: every change, no cap", () => {
    state.branchId = 'br_1'
    state.diffError = new DiffTooLargeError(300_000, 100_000)
    render(<CanvasVersioningBar workspaceId="ws1" dataSourceId="ds1" />)

    expect(useChangeIndex).toHaveBeenCalledWith('ws1', 'g1', { branchId: 'br_1' })
  })
})

describe('CanvasVersioningBar — what a comparison drew of its deletions', () => {
  beforeEach(() => {
    state.index = { origin: { fromSeq: 3, toSeq: 12 }, entries: [], total: 0, truncated: false }
    branchState.activeChangeSet = null
    useCanvasStore.setState({ deletedDrawn: null })
  })

  it('counts the comparison, says how many deletions it drew of how many, and opens the list', () => {
    const origin = { source: 'compare', fromSeq: 3, toSeq: 12 } as const
    branchState.activeChangeSet = buildChangeSet([
      { entityId: 'a', kind: 'node', status: 'added', label: 'a', origin },
      ...Array.from({ length: 4 }, (_, i) => ({ entityId: `d${i}`, kind: 'node' as const, status: 'removed' as const, label: `d${i}`, origin })),
    ])
    useCanvasStore.setState({ deletedDrawn: { drawn: 3, total: 4 } })
    render(<CanvasVersioningBar workspaceId="ws1" dataSourceId="ds1" />)

    expect(screen.getByText('3 of 4 deleted drawn')).toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: 'Open the list' }))
    expect(screen.getByText('history on 3→12')).toBeInTheDocument()
  })

  it('says nothing of drawing when every deletion is drawn', () => {
    useCanvasStore.setState({ deletedDrawn: { drawn: 4, total: 4 } })
    render(<CanvasVersioningBar workspaceId="ws1" dataSourceId="ds1" />)
    expect(screen.queryByText(/deleted drawn/)).toBeNull()
  })

  it("says the same on a draft, whose Changes lists every one", () => {
    state.branchId = 'br_1'
    useCanvasStore.setState({ deletedDrawn: { drawn: 500, total: 1_200 } })
    render(<CanvasVersioningBar workspaceId="ws1" dataSourceId="ds1" />)

    fireEvent.click(screen.getByRole('button', { name: '500 of 1,200 deleted drawn' }))
    expect(screen.getByText(/^changes on/)).toBeInTheDocument()
  })
})
