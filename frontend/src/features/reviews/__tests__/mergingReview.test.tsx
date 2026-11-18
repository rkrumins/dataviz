/**
 * A fork's review merged by a job is `merging` until the job ends: its badge says so, and its row
 * shows its changes but offers no Dismiss — the server refuses to close a review a job is merging.
 * (Which inbox queues it is in is the server's to say: every live review is in Everything open.)
 */
import { render, screen } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
import type { PullRequest } from '@/services/versioningApiService'

const mergingPr: PullRequest = {
  prId: 'pr_merging', status: 'merging', title: 'Q3 fork', createdAt: '2026-01-01T00:00:00Z',
  updatedAt: '2026-01-01T00:00:00Z', graphId: 'g_fork', sourceBranchId: 'b1', targetGraphId: 'g1',
  targetBranch: 'main',
}

vi.mock('@/features/versioning/hooks/useVersioning', () => ({
  usePrDiffSummary: (wsId?: string, prId?: string) => ({
    data: wsId && prId ? { counts: { added: 2, modified: 1, removed: 0 } } : undefined,
    isLoading: false,
  }),
  useChangeSummary: (wsId?: string, graphId?: string | null, origin?: { branchId?: string } | null) => ({
    data: wsId && graphId && origin?.branchId === 'b_draft' ? { counts: { added: 40000, modified: 0, removed: 0 } } : undefined,
    isLoading: false,
  }),
  useCloseMergeRequest: () => ({ mutate: vi.fn(), isPending: false }),
}))

import { PrStatusBadge } from '../components/PrMeta'
import { PrListRow } from '../components/PrListRow'

describe('a review being merged', () => {
  it('is badged Merging', () => {
    render(<PrStatusBadge status="merging" />)
    expect(screen.getByText('Merging')).toBeInTheDocument()
  })

  it('shows its changes and offers no Dismiss', () => {
    render(<PrListRow wsId="ws1" pr={mergingPr} onOpen={() => {}} />)
    expect(screen.getByText('3 changes')).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: /Dismiss/ })).not.toBeInTheDocument()
  })

  it('counts a draft’s review from its change list, not by merging it', () => {
    const draftPr: PullRequest = { ...mergingPr, prId: 'pr_draft', status: 'open', graphId: 'g1', sourceBranchId: 'b_draft' }
    render(<PrListRow wsId="ws1" pr={draftPr} onOpen={() => {}} />)
    expect(screen.getByText('40000 changes')).toBeInTheDocument()
  })
})
