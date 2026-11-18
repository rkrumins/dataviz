/**
 * ChangeTreePanel — RTL tests for the hierarchical diff view:
 *   • the impact header renders global counts + the entityType rollup;
 *   • a top-level container row renders with its rolled-up counts;
 *   • expanding a container lazily calls `fetchChildren` and appends the children.
 */
import { render, screen, fireEvent, waitFor } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'

const listed = vi.hoisted(() => vi.fn())
vi.mock('../ChangeList', () => ({
  ChangeList: (props: unknown) => { listed(props); return <div>the change list</div> },
}))

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

  it('lists what changed one line each — a container’s own change and each change inside it open only when asked', async () => {
    const own: DiffSummaryResponse = { ...summary, groups: [{ ...summary.groups[0], status: 'modified',
      before: { displayName: 'Sales', description: 'old' }, after: { displayName: 'Sales', description: 'new' } }] }
    const fetchChildren = vi.fn().mockResolvedValue(children)
    render(<ChangeTreePanel summary={own} fetchChildren={fetchChildren} origin={origin} />)
    fireEvent.click(screen.getByText('Sales'))
    expect(await screen.findByText('amount')).toBeInTheDocument()
    // Every affected entity is listed; no field is open yet.
    expect(screen.getByText('Its own change')).toBeInTheDocument()
    expect(screen.queryByText('old')).not.toBeInTheDocument()
    expect(screen.queryByText('amount_usd')).not.toBeInTheDocument()
    // Drilled into on demand.
    fireEvent.click(screen.getByText('Its own change'))
    expect(screen.getByText('old')).toBeInTheDocument()
    fireEvent.click(screen.getByText('amount'))
    expect(screen.getByText('amount_usd')).toBeInTheDocument()
  })

  it('says a large set is still being prepared while it is asked for again', () => {
    const { rerender } = render(<ChangeTreePanel isLoading fetchChildren={vi.fn()} origin={origin} />)
    expect(screen.getByText(/Computing changes/)).toBeInTheDocument()
    expect(screen.queryByText(/Still preparing these changes/)).not.toBeInTheDocument()
    rerender(<ChangeTreePanel isLoading preparing fetchChildren={vi.fn()} origin={origin} />)
    expect(screen.getByRole('status')).toHaveTextContent(/Still preparing these changes/)
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

  const tooLarge: DiffSummaryResponse = {
    groups: [], groupTotal: 0,
    counts: { added: 0, modified: 100000, removed: 0 },
    entityCounts: { added: 0, modified: 100000, removed: 0 },
    edgeCounts: { added: 0, modified: 0, removed: 0 },
    impact: { SchemaField: 100000 },
    tooLarge: { changed: 100000, limit: 20000 },
  }

  it('counts a set too large to lay out as a tree', () => {
    render(
      <ChangeTreePanel summary={tooLarge} fetchChildren={vi.fn()} origin={origin}
        emptyHint="Nothing here." summaryFirst />,
    )
    expect(screen.getByText('100000 changes')).toBeInTheDocument()
    expect(screen.getByText(/100,000 entities changed — too many to lay out here/)).toBeInTheDocument()
    expect(screen.queryByText('Nothing here.')).not.toBeInTheDocument()
    expect(screen.queryByText(/Show details/)).not.toBeInTheDocument()
  })

  it('lists a set too large for the tree from its change list, a page at a time', () => {
    listed.mockClear()
    render(
      <ChangeTreePanel summary={tooLarge} fetchChildren={vi.fn()} origin={origin} emptyHint="Nothing here."
        summaryFirst list={{ wsId: 'ws1', graphId: 'g1', origin: { branchId: 'br_1' } }} />,
    )
    expect(screen.getByText('100000 changes')).toBeInTheDocument()
    expect(screen.getByText('the change list')).toBeInTheDocument()
    expect(listed).toHaveBeenCalledWith(expect.objectContaining({
      wsId: 'ws1', graphId: 'g1', origin: { branchId: 'br_1' },
    }))
    expect(screen.queryByText(/too many to lay out here/)).not.toBeInTheDocument()
  })

  it('says the tree failed, offers to try again and lists the changes — never "nothing here"', () => {
    listed.mockClear()
    const onRetry = vi.fn()
    render(
      <ChangeTreePanel summary={undefined} error={new Error('timeout')} onRetry={onRetry} fetchChildren={vi.fn()}
        origin={origin} emptyHint="Nothing here." list={{ wsId: 'ws1', graphId: 'g1', origin: { branchId: 'br_1' } }} />,
    )
    expect(screen.getByRole('alert')).toHaveTextContent(/Couldn’t lay these changes out as a tree/)
    expect(screen.getByText('the change list')).toBeInTheDocument()
    expect(screen.queryByText('Nothing here.')).not.toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: /Try again/ }))
    expect(onRetry).toHaveBeenCalledTimes(1)
  })
})
