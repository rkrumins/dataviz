/**
 * "Version control is off — Enable version control": offered on a canvas only to
 * someone who may turn it on, by the rule the server applies to
 * POST /{ws}/graph/bootstrap — `workspace:datasource:manage` in the view's
 * workspace (a workspace admin's claims carry it; an org or platform admin's
 * shortcut covers every workspace) — and only on a data source that can be
 * versioned (FalkorDB). Anyone else sees no band at all. (The bar itself only
 * mounts while the `versioningEnabled` flag is on: CanvasRouter.)
 *
 * The permission store is the real one, fed claims shaped like the server's.
 */
import { render, screen } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'

import { useAuthStore } from '@/store/auth'

let providerType: string | undefined

vi.mock('@/components/ui/notifications', () => ({ useAppNotifications: () => ({ notify: vi.fn() }) }))
vi.mock('@/hooks/useDataSourceProviderMap', () => ({
  useDataSourceProviderMap: () => ({ resolve: () => (providerType ? { providerType } : undefined) }),
}))
vi.mock('@/store/schema', () => ({ useActiveView: () => ({ id: 'v1', name: 'View' }) }))
// One store state across renders, its actions stable, as the real store's are.
const branchState: Record<string, unknown> = {
  committedDiffHidden: false, setCommittedDiffHidden: vi.fn(), setActiveChangeSet: vi.fn(), switchToMain: vi.fn(),
  openRevision: vi.fn(), setHighlight: vi.fn(), viewId: null, activeChangeSet: null,
}
vi.mock('@/store/branchStore', () => ({
  useBranchStore: (sel: (s: unknown) => unknown) => sel(branchState),
  useEffectiveBranchId: () => null,
  useEffectiveRevision: () => null,
  useRevisionHighlight: () => null,
}))
// The ?rev= link reads the router, which this bar is never rendered without in the app.
vi.mock('../../hooks/useRevisionDeepLink', () => ({ useRevisionDeepLink: () => {} }))
vi.mock('@/store/stagedChangesStore', () => ({ useStagedChangeCount: () => 0 }))
vi.mock('../../hooks/useVersioning', () => ({
  // No versioned graph for this data source yet.
  useResolveGraph: () => ({ data: { graphId: null, mainHeadCommitSeq: 0 }, isLoading: false }),
  useBranches: () => ({ data: [], isFetching: false }),
  useBranchFreshness: () => ({ data: undefined, error: null }),
  useBranch: () => ({ data: undefined }),
  useRefreshDraftFromOthers: () => vi.fn(),
  useDiffVsMain: () => ({ data: undefined, isLoading: false }),
  useBranchViewChanges: () => ({ data: undefined }),
  useAbandonDraft: () => ({ mutate: vi.fn(), isPending: false }),
  useChangeIndex: () => ({ data: undefined, isLoading: false }),
  useChangeSummary: () => ({ data: undefined, isLoading: false }),
}))
vi.mock('../../hooks/useActiveBranchGuard', () => ({ useActiveBranchGuard: () => {} }))
vi.mock('../../model/useBootstrapWatch', () => ({
  useBootstrapWatch: () => ({ showReport: false, showProgress: false, job: null, dismissReport: () => {} }),
}))
vi.mock('../EnableVersioningFlow', () => ({ EnableVersioningFlow: () => null }))

import { CanvasVersioningBar } from '../CanvasVersioningBar'

function as(claims: { global?: string[]; ws?: Record<string, string[]> }) {
  useAuthStore.setState({ permissions: { global: claims.global ?? [], ws: claims.ws ?? {} } } as never)
}

const enable = () => screen.queryByRole('button', { name: /Enable version control/ })

describe('CanvasVersioningBar — turning version control on', () => {
  beforeEach(() => { providerType = 'falkordb' })

  it('is offered to a data-source manager of the view\'s workspace', () => {
    as({ ws: { ws1: ['workspace:view:read', 'workspace:datasource:read', 'workspace:datasource:manage'] } })
    render(<CanvasVersioningBar workspaceId="ws1" dataSourceId="ds1" />)
    expect(screen.getByText('Version control is off for this data source')).toBeInTheDocument()
    expect(enable()).toBeInTheDocument()
  })

  it('is offered to an organisation admin, in any workspace', () => {
    as({ global: ['system:org-admin'] })
    render(<CanvasVersioningBar workspaceId="ws1" dataSourceId="ds1" />)
    expect(enable()).toBeInTheDocument()
  })

  it('is not shown to a viewer of the workspace — no band at all', () => {
    as({ ws: { ws1: ['workspace:view:read', 'workspace:datasource:read', 'workspace:catalog:read'] } })
    const { container } = render(<CanvasVersioningBar workspaceId="ws1" dataSourceId="ds1" />)
    expect(enable()).toBeNull()
    expect(screen.queryByText(/Version control is off/)).toBeNull()
    expect(container).toBeEmptyDOMElement()
  })

  it('is not shown to someone who manages another workspace only', () => {
    as({ ws: { ws2: ['workspace:datasource:manage'], ws1: ['workspace:view:read'] } })
    render(<CanvasVersioningBar workspaceId="ws1" dataSourceId="ds1" />)
    expect(enable()).toBeNull()
  })

  it('is not shown on a data source that cannot be versioned', () => {
    providerType = 'neo4j'
    as({ ws: { ws1: ['workspace:datasource:manage'] } })
    render(<CanvasVersioningBar workspaceId="ws1" dataSourceId="ds1" />)
    expect(enable()).toBeNull()
  })
})
