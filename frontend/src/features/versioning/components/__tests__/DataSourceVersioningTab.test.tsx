/**
 * DataSourceVersioningTab — the data source's versioning hub shows where its versioned graph lives
 * (ProjectionHealthCard) once version control is on, with Rebuild and Check sync for managers only.
 * The data hooks are stubbed; the card itself has its own spec.
 */
import { render, screen } from '@testing-library/react'
import { MemoryRouter } from 'react-router-dom'
import { describe, it, expect, vi, beforeEach } from 'vitest'

let canManage = true
let resolved: Record<string, unknown> | undefined

vi.mock('@/store/auth', () => ({ usePermission: () => canManage }))
vi.mock('../../hooks/useVersioning', () => ({
  useResolveGraph: () => ({ data: resolved, isLoading: false }),
  useBranches: () => ({ data: [], isLoading: false }),
  useCommitLog: () => ({ data: { commits: [] } }),
  useMergeRequests: () => ({ data: [], isLoading: false }),
}))
vi.mock('../../model/useBootstrapWatch', () => ({
  useBootstrapWatch: () => ({ showReport: false, showProgress: false, job: null, dismissReport: () => {} }),
}))
vi.mock('../EnableVersioningFlow', () => ({ EnableVersioningFlow: () => null }))
vi.mock('../BootstrapProgress', () => ({ BootstrapProgress: () => null }))
vi.mock('@/features/reviews/components/PrListRow', () => ({ PrListRow: () => null }))
vi.mock('@/features/reviews/components/PrDetailDrawer', () => ({ PrDetailDrawer: () => null }))
vi.mock('../ProjectionHealthCard', () => ({
  ProjectionHealthCard: ({ graphId, showActions }: { graphId: string; showActions?: boolean }) =>
    <div data-testid="projection-health-card" data-graph={graphId} data-actions={String(!!showActions)} />,
}))

import { DataSourceVersioningTab } from '../DataSourceVersioningTab'

const renderTab = () =>
  render(
    <MemoryRouter>
      <DataSourceVersioningTab wsId="ws1" dataSourceId="ds1" />
    </MemoryRouter>,
  )

beforeEach(() => {
  canManage = true
  resolved = { graphId: 'g1', mainBranchId: 'b_main', mainHeadCommitSeq: 5, kind: 'bootstrap' }
})

describe('DataSourceVersioningTab — projection health', () => {
  it('shows a manager where the graph lives, with Rebuild and Check sync', () => {
    renderTab()
    const card = screen.getByTestId('projection-health-card')
    expect(card).toHaveAttribute('data-graph', 'g1')
    expect(card).toHaveAttribute('data-actions', 'true')
  })

  it('shows everyone else the same card read-only', () => {
    canManage = false
    renderTab()
    expect(screen.getByTestId('projection-health-card')).toHaveAttribute('data-actions', 'false')
  })

  it('shows no card while version control is off', () => {
    resolved = undefined
    renderTab()
    expect(screen.getByText('Version control is off')).toBeInTheDocument()
    expect(screen.queryByTestId('projection-health-card')).not.toBeInTheDocument()
  })
})
