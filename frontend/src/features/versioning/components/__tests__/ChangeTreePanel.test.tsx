/**
 * ChangeTreePanel — RTL tests for the hierarchical diff view:
 *   • the impact header renders global counts + the entityType rollup;
 *   • a top-level container row renders with its rolled-up counts;
 *   • expanding a container lazily calls `fetchChildren` and appends the children.
 */
import { render, screen, fireEvent, waitFor } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
import { ChangeTreePanel } from '../ChangeTreePanel'
import type { DiffSummaryResponse, DiffChildrenResponse } from '@/services/versioningApiService'

const summary: DiffSummaryResponse = {
  groups: [
    {
      key: 'DS',
      kind: 'container',
      label: 'Sales',
      entityType: 'Dataset',
      status: 'unchanged',
      counts: { added: 1, modified: 2, removed: 0 },
      childTotal: 2,
      deleted: false,
    },
  ],
  groupTotal: 1,
  counts: { added: 1, modified: 2, removed: 0 },
  impact: { Dataset: 1, Table: 2, Column: 2 },
}

const children: DiffChildrenResponse = {
  entries: [
    {
      key: 'C1', kind: 'leaf', label: 'amount', entityType: 'Column', status: 'modified',
      counts: { added: 0, modified: 1, removed: 0 }, childTotal: 0, deleted: false,
      before: { displayName: 'amount' }, after: { displayName: 'amount_usd' },
    },
  ],
  total: 1,
}

const origin = { source: 'branch', branchId: 'br1' } as const

describe('ChangeTreePanel', () => {
  it('renders the impact header and a top-level group', () => {
    render(<ChangeTreePanel summary={summary} fetchChildren={vi.fn()} origin={origin} />)
    expect(screen.getByText(/3 changes/i)).toBeInTheDocument()
    // entityType rollup chips
    expect(screen.getByText('Tables')).toBeInTheDocument()
    expect(screen.getByText('Columns')).toBeInTheDocument()
    // the container row
    expect(screen.getByText('Sales')).toBeInTheDocument()
  })

  it('lazily loads children when a container is expanded', async () => {
    const fetchChildren = vi.fn().mockResolvedValue(children)
    render(<ChangeTreePanel summary={summary} fetchChildren={fetchChildren} origin={origin} />)

    // child not present until expanded
    expect(screen.queryByText('amount')).not.toBeInTheDocument()
    fireEvent.click(screen.getByText('Sales'))

    await waitFor(() => expect(fetchChildren).toHaveBeenCalledWith('DS', 0))
    expect(await screen.findByText('amount')).toBeInTheDocument()
  })

  it('shows the empty hint when there are no groups', () => {
    render(
      <ChangeTreePanel
        summary={{ groups: [], groupTotal: 0, counts: { added: 0, modified: 0, removed: 0 }, impact: {} }}
        fetchChildren={vi.fn()}
        origin={origin}
        emptyHint="Nothing here."
      />,
    )
    expect(screen.getByText('Nothing here.')).toBeInTheDocument()
  })
})
