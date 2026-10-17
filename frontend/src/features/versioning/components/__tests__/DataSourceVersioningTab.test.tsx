/**
 * DataSourceVersioningTab — the data source's versioning hub shows where its versioned graph lives
 * (ProjectionHealthCard) once version control is on, with Rebuild and Check sync for managers only.
 * It counts only drafts still in play, and a failed lookup is an error, not "version control is off".
 * With version control off, Enable is offered only for a data source whose graph can be copied into
 * version history (FalkorDB): the server refuses the rest with 422 `provider_unsupported`.
 * Its Merge requests section reads the data source's open PRs, the inbox's read, so an older open PR
 * is not hidden behind newer merged or closed ones.
 * The data hooks are stubbed; the card itself has its own spec.
 */
import { fireEvent, render, screen } from '@testing-library/react'
import { MemoryRouter } from 'react-router-dom'
import { describe, it, expect, vi, beforeEach } from 'vitest'

let canManage = true
let resolved: Record<string, unknown> | undefined
let resolveError: Error | null
let branches: Array<Record<string, unknown>>
let providerType: string | undefined
let openPrs: Array<Record<string, unknown>>
const refetch = vi.fn()
const useDataSourcePullRequests = vi.fn((..._args: unknown[]) => ({ data: openPrs, isLoading: false }))

vi.mock('@/store/auth', () => ({ usePermission: () => canManage }))
vi.mock('@/hooks/useDataSourceProviderMap', () => ({
  useDataSourceProviderMap: () => ({
    resolve: () => (providerType ? { providerType } : undefined),
  }),
}))
vi.mock('../../hooks/useVersioning', () => ({
  useResolveGraph: () => ({
    data: resolved, isLoading: false, isError: !!resolveError, error: resolveError, refetch,
  }),
  useBranches: () => ({ data: branches, isLoading: false }),
  useCommitLog: () => ({ data: { commits: [] } }),
  useDataSourcePullRequests: (...args: unknown[]) => useDataSourcePullRequests(...args),
}))
vi.mock('../../model/useBootstrapWatch', () => ({
  useBootstrapWatch: () => ({ showReport: false, showProgress: false, job: null, dismissReport: () => {} }),
}))
vi.mock('../EnableVersioningFlow', () => ({ EnableVersioningFlow: () => null }))
vi.mock('../BootstrapProgress', () => ({ BootstrapProgress: () => null }))
vi.mock('@/features/reviews/components/PrListRow', () => ({
  PrListRow: ({ pr }: { pr: { title: string } }) => <div>{pr.title}</div>,
}))
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
  resolveError = null
  branches = []
  providerType = undefined
  openPrs = []
  refetch.mockReset()
  useDataSourcePullRequests.mockClear()
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

describe('DataSourceVersioningTab — status header', () => {
  const branch = (id: string, kind: string, status: string) =>
    ({ branchId: id, kind, status, createdAt: '', updatedAt: '' })

  it('counts open and publishing drafts, not merged or abandoned ones', () => {
    branches = [
      branch('b_main', 'main', 'open'),
      branch('d1', 'draft', 'open'),
      branch('d2', 'draft', 'publishing'),
      branch('d3', 'draft', 'merged'),
      branch('d4', 'draft', 'abandoned'),
    ]
    renderTab()
    expect(screen.getByText(/main at commit #5 · 2 open drafts/)).toBeInTheDocument()
  })
})

describe('DataSourceVersioningTab — merge requests', () => {
  it('lists the data source\'s open PRs from the open read, not the latest page of every status', () => {
    openPrs = [{ prId: 'pr_old', status: 'mergeable', title: 'Old fix', createdAt: '2025-01-01T00:00:00Z' }]
    renderTab()
    expect(screen.getByText('Old fix')).toBeInTheDocument()
    expect(screen.queryByText('No open merge requests.')).not.toBeInTheDocument()
    expect(useDataSourcePullRequests).toHaveBeenCalledWith('ws1', 'ds1', 'open', true)
  })
})

describe('DataSourceVersioningTab — resolve errors', () => {
  it('shows a failed lookup as an error with Retry, not as "version control is off"', () => {
    resolved = undefined
    resolveError = new Error('Internal Server Error')
    renderTab()
    expect(screen.getByRole('alert')).toHaveTextContent('Could not check version control')
    expect(screen.queryByText('Version control is off')).not.toBeInTheDocument()
    expect(screen.queryByText('Enable version control')).not.toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: /retry/i }))
    expect(refetch).toHaveBeenCalled()
  })

  it('still offers Enable when the lookup says there is no versioned graph (404)', () => {
    resolved = undefined
    resolveError = new Error('no versioned graph for data source')
    renderTab()
    expect(screen.getByText('Version control is off')).toBeInTheDocument()
    expect(screen.getByText('Enable version control')).toBeInTheDocument()
  })
})

describe('DataSourceVersioningTab — Enable', () => {
  beforeEach(() => { resolved = undefined })

  it('is offered for a FalkorDB data source', () => {
    providerType = 'falkordb'
    renderTab()
    expect(screen.getByRole('button', { name: /enable version control/i })).toBeTruthy()
  })

  it('is offered when the provider is unknown to this viewer', () => {
    renderTab()
    expect(screen.getByRole('button', { name: /enable version control/i })).toBeTruthy()
  })

  it('is not offered for a provider whose graph cannot be copied', () => {
    providerType = 'neo4j'
    renderTab()
    expect(screen.queryByRole('button', { name: /enable version control/i })).toBeNull()
    expect(screen.getByText(/only FalkorDB data sources can be versioned/i)).toBeTruthy()
  })
})
