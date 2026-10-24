/**
 * CanvasVersioningBar on a draft:
 *   • it reads the open and publishing drafts only — never every draft ever made — and learns that
 *     its own draft was closed from that one draft's status (its freshness), for the guard;
 *   • it offers Publish and Discard only on a draft the user can write, and names the owner of one
 *     they can only look at; an editor of a shared draft gets Publish (to request review) but not
 *     Discard, which needs its owner or a maintainer.
 */
import { render, screen } from '@testing-library/react'
import { describe, it, expect, vi, beforeEach } from 'vitest'

let branchesData: unknown[] = []
let freshness: Record<string, unknown> | undefined
const useBranches = vi.fn((..._args: unknown[]) => ({ data: branchesData, isFetching: false }))
const guard = vi.fn()

vi.mock('@/components/ui/notifications', () => ({ useAppNotifications: () => ({ notify: vi.fn() }) }))
vi.mock('@/store/auth', () => ({
  usePermission: () => true,
  useAuthStore: (sel: (s: unknown) => unknown) => sel({ user: { id: 'ana' } }),
}))
vi.mock('@/hooks/useDataSourceProviderMap', () => ({ useDataSourceProviderMap: () => ({ resolve: () => undefined }) }))
vi.mock('@/store/schema', () => ({ useActiveView: () => ({ id: 'v1', name: 'View' }) }))
vi.mock('@/store/branchStore', () => ({
  useBranchStore: (sel: (s: unknown) => unknown) => sel({
    committedDiffHidden: false, setCommittedDiffHidden: vi.fn(), setActiveChangeSet: vi.fn(), switchToMain: vi.fn(),
  }),
  useEffectiveBranchId: () => 'br_1',
}))
vi.mock('@/store/stagedChangesStore', () => ({ useStagedChangeCount: () => 0 }))
vi.mock('../../hooks/useVersioning', () => ({
  useResolveGraph: () => ({ data: { graphId: 'g1', mainHeadCommitSeq: 5, kind: 'bootstrap' }, isLoading: false }),
  useBranches: (...args: unknown[]) => useBranches(...args),
  useBranchFreshness: () => ({ data: freshness }),
  useDiffVsMain: () => ({ data: undefined, isLoading: false }),
  useBranchViewChanges: () => ({ data: undefined }),
  useAbandonDraft: () => ({ mutate: vi.fn(), isPending: false }),
}))
vi.mock('../../hooks/useActiveBranchGuard', () => ({ useActiveBranchGuard: (a: unknown) => guard(a) }))
vi.mock('../../model/useBootstrapWatch', () => ({
  useBootstrapWatch: () => ({ showReport: false, showProgress: false, job: null, dismissReport: () => {} }),
}))
vi.mock('../AggregationSyncChip', () => ({ AggregationSyncChip: () => null }))
vi.mock('../BootstrapProgress', () => ({ BootstrapProgress: () => null }))
vi.mock('../EnableVersioningFlow', () => ({ EnableVersioningFlow: () => null }))
vi.mock('../BranchSwitcher', () => ({ BranchSwitcher: () => null }))
vi.mock('../PullBeforeMergeBanner', () => ({ PullBeforeMergeBanner: () => null }))
vi.mock('../ReadRouteChip', () => ({ ReadRouteChip: () => null }))
vi.mock('../RefreshingBadge', () => ({ RefreshingBadge: () => null }))
vi.mock('../CommitDialog', () => ({ CommitDialog: () => null }))
vi.mock('../PublishReceiptBanner', () => ({ PublishReceiptBanner: () => null }))
vi.mock('../ViewVersioningPanel', () => ({ ViewVersioningPanel: () => null }))
vi.mock('../ChangesPanel', () => ({ ChangeCountChips: () => null }))

import { CanvasVersioningBar } from '../CanvasVersioningBar'

const draft = (over: Record<string, unknown>) => ({
  branchId: 'br_1', kind: 'draft', status: 'open', name: 'Q3', owner: 'ana', baseCommitSeq: 5,
  createdAt: '', updatedAt: '', ...over,
})

describe('CanvasVersioningBar on a draft', () => {
  beforeEach(() => {
    useBranches.mockClear()
    guard.mockClear()
    freshness = { behind: false, behindBy: 0, mainHeadCommitSeq: 5, baseCommitSeq: 5, status: 'open' }
  })

  it('reads only the drafts in play, and hands the guard its own draft\'s status', () => {
    branchesData = [draft({})]
    freshness = { ...freshness, status: 'merged' }
    render(<CanvasVersioningBar workspaceId="ws1" dataSourceId="ds1" />)
    expect(useBranches).toHaveBeenCalledWith('ws1', 'g1', 'v1')
    expect(guard).toHaveBeenLastCalledWith(expect.objectContaining({ currentBranchId: 'br_1', status: 'merged' }))
  })

  it('offers Publish and Discard on the user\'s own draft', () => {
    branchesData = [draft({})]
    render(<CanvasVersioningBar workspaceId="ws1" dataSourceId="ds1" />)
    expect(screen.getByRole('button', { name: /Publish/ })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Discard draft' })).toBeInTheDocument()
  })

  it('shows someone else\'s draft read-only, with its owner\'s name', () => {
    branchesData = [draft({ owner: 'bob', userNames: { bob: 'Bob Stone' } })]
    render(<CanvasVersioningBar workspaceId="ws1" dataSourceId="ds1" />)
    expect(screen.queryByRole('button', { name: /Publish/ })).not.toBeInTheDocument()
    expect(screen.queryByRole('button', { name: 'Discard draft' })).not.toBeInTheDocument()
    expect(screen.getByText(/Bob Stone’s draft · view only/)).toBeInTheDocument()
  })

  it('offers an editor of a shared draft Publish but not Discard; a maintainer both', () => {
    branchesData = [draft({ owner: 'bob', isShared: true, myRole: 'editor' })]
    const { unmount } = render(<CanvasVersioningBar workspaceId="ws1" dataSourceId="ds1" />)
    expect(screen.getByRole('button', { name: /Publish/ })).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: 'Discard draft' })).not.toBeInTheDocument()
    unmount()
    branchesData = [draft({ owner: 'bob', isShared: true, myRole: 'maintainer' })]
    render(<CanvasVersioningBar workspaceId="ws1" dataSourceId="ds1" />)
    expect(screen.getByRole('button', { name: 'Discard draft' })).toBeInTheDocument()
  })
})

