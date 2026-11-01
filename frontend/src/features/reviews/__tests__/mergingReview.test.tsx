/**
 * A fork's review merged by a job is `merging` until the job ends: its badge says so, the inbox
 * counts and lists it among the reviews in progress, and its row shows its changes but offers no
 * Dismiss — the server refuses to close a review a job is merging.
 */
import { useEffect } from 'react'
import { render, screen } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
import type { ReviewItem } from '../components/DataSourceReviewFeed'
import type { PullRequest } from '@/services/versioningApiService'

const mergingPr: PullRequest = {
  prId: 'pr_merging', status: 'merging', title: 'Q3 fork', createdAt: '2026-01-01T00:00:00Z',
  updatedAt: '2026-01-01T00:00:00Z', graphId: 'g_fork', sourceBranchId: 'b1', targetGraphId: 'g1',
  targetBranch: 'main',
}

const state = {
  workspaces: [{ id: 'ws1', dataSources: [{ id: 'ds1', label: 'Sales' }] }],
  loadWorkspaces: vi.fn(),
}
vi.mock('@/store/workspaces', () => ({
  useWorkspacesStore: (sel: (s: typeof state) => unknown) => sel(state),
}))
vi.mock('@/store/auth', () => ({
  useAuthStore: (sel: (s: { user: null }) => unknown) => sel({ user: null }),
}))
vi.mock('../components/DataSourceReviewFeed', () => ({
  DataSourceReviewFeed: ({ dataSourceId, sourceLabel, onLoaded }: {
    dataSourceId: string; sourceLabel: string
    onLoaded: (ds: string, items: ReviewItem[], failed: boolean) => void
  }) => {
    useEffect(() => {
      onLoaded(dataSourceId, [{ pr: mergingPr, sourceLabel }], false)
    }, [dataSourceId, sourceLabel, onLoaded])
    return null
  },
}))
vi.mock('../components/PrDetailDrawer', () => ({ PrDetailDrawer: () => null }))
vi.mock('@/features/versioning/hooks/useVersioning', () => ({
  usePrDiffSummary: (wsId?: string, prId?: string) => ({
    data: wsId && prId ? { counts: { added: 2, modified: 1, removed: 0 } } : undefined,
    isLoading: false,
  }),
  useCloseMergeRequest: () => ({ mutate: vi.fn(), isPending: false }),
}))

import { PrStatusBadge } from '../components/PrMeta'
import { PrListRow } from '../components/PrListRow'
import { WorkspaceReviewsInbox } from '../components/WorkspaceReviewsInbox'

describe('a review being merged', () => {
  it('is badged Merging', () => {
    render(<PrStatusBadge status="merging" />)
    expect(screen.getByText('Merging')).toBeInTheDocument()
  })

  it('is listed and counted among the reviews in progress', () => {
    render(<WorkspaceReviewsInbox wsId="ws1" />)
    expect(screen.getByText('Q3 fork')).toBeInTheDocument()
    expect(screen.getAllByText('Merging').length).toBeGreaterThan(0)
  })

  it('shows its changes and offers no Dismiss', () => {
    render(<PrListRow wsId="ws1" pr={mergingPr} onOpen={() => {}} />)
    expect(screen.getByText('3 changes')).toBeInTheDocument()
    expect(screen.queryByTitle(/Dismiss/)).not.toBeInTheDocument()
  })
})
