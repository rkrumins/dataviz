/**
 * WorkspaceReviewsInbox — a data source whose PR read partly failed keeps the PRs that did load
 * and is named in an inline error, instead of vanishing from the inbox as if it had no PRs.
 * The per-data-source feed (its own spec) is stubbed to report what it loaded.
 */
import { useEffect } from 'react'
import { render, screen } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
import type { ReviewItem } from '../components/DataSourceReviewFeed'
import type { PullRequest } from '@/services/versioningApiService'

const openPr: PullRequest = {
  prId: 'pr_open', status: 'mergeable', title: 'Fix regions', createdAt: '2026-01-01T00:00:00Z',
  updatedAt: '2026-01-01T00:00:00Z', graphId: 'g1', sourceBranchId: 'b1', targetGraphId: 'g1', targetBranch: 'main',
}

const state = {
  workspaces: [{ id: 'ws1', dataSources: [{ id: 'ds1', label: 'Sales' }, { id: 'ds2', label: 'Ops' }] }],
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
      if (dataSourceId === 'ds1') onLoaded(dataSourceId, [{ pr: openPr, sourceLabel }], true)
      else onLoaded(dataSourceId, [], false)
    }, [dataSourceId, sourceLabel, onLoaded])
    return null
  },
}))
vi.mock('../components/PrListRow', () => ({
  PrListRow: ({ pr }: { pr: PullRequest }) => <div>{pr.title}</div>,
}))
vi.mock('../components/PrDetailDrawer', () => ({ PrDetailDrawer: () => null }))

import { WorkspaceReviewsInbox } from '../components/WorkspaceReviewsInbox'

describe('WorkspaceReviewsInbox', () => {
  it('lists the PRs a partly failed data source loaded and names it in an inline error', () => {
    render(<WorkspaceReviewsInbox wsId="ws1" />)
    expect(screen.getByText('Fix regions')).toBeInTheDocument()
    const alert = screen.getByRole('alert')
    expect(alert).toHaveTextContent('Sales')
    expect(alert).not.toHaveTextContent('Ops')
  })
})
