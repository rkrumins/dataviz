/**
 * SyncStatusChip in each view. The Business view keeps the verdict and drops the path: one plain
 * pill in the same colour, saying Up to date, Updating or May be out of date, with no card to
 * open — so no store names, no revision ids and no account of the graph's kind. The Technical
 * view keeps the button and the card behind it. The status hook is mocked.
 */
import { fireEvent, render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { SyncStatus } from '../syncStatusApi'

let data: SyncStatus | undefined

vi.mock('../useSyncStatus', () => ({
  useSyncStatus: () => ({ data, isError: false, isFetching: false, refetch: vi.fn() }),
}))

import { SyncStatusChip } from '../SyncStatusChip'
import { usePersonaStore } from '@/store/persona'

/** Relative, so "checked 2m ago" never depends on today's date. */
const minutesAgo = (m: number) => new Date(Date.now() - m * 60_000).toISOString()

function versioned(over: Partial<NonNullable<SyncStatus['versioned']>> = {}): SyncStatus {
  const at = minutesAgo(2)
  const rev = { commitId: 'cmt_01M3AH4A26Y5ZFJ60G1ZYNM07A', createdAt: at, actorName: 'System Admin', message: 'Publish draft' }
  return {
    kind: 'versioned', dataSourceId: 'ds', checkedAt: at,
    versioned: { graphId: 'g', committed: 11, projected: 11, fresh: true, status: 'idle', committedRevision: rev, projectedRevision: rev, lastProjectedAt: at, ...over },
    summaries: { aggregationStatus: 'ready', driftState: 'managed', lastJobStatus: 'completed', lastSuccessAt: at },
    counts: { nodes: 1922, edges: 2288, readAt: at },
  }
}

const renderChip = () => render(<SyncStatusChip workspaceId="ws1" dataSourceId="ds" viewId="v1" />)

beforeEach(() => {
  data = versioned()
})

describe('SyncStatusChip in the Business view', () => {
  beforeEach(() => usePersonaStore.setState({ mode: 'business' }))

  it('says it is up to date and when that was checked, with nothing to open and no store names', () => {
    renderChip()
    expect(screen.getByText('Up to date · checked 2m ago')).toBeInTheDocument()
    expect(screen.queryByRole('button')).toBeNull()
    for (const word of ['Postgres', 'FalkorDB', 'cmt_', 'v11']) {
      expect(document.body.textContent).not.toContain(word)
    }
  })

  it('says it is updating while the graph catches up', () => {
    data = versioned({ projected: 9, fresh: false, status: 'projecting' })
    renderChip()
    expect(screen.getByText('Updating…')).toBeInTheDocument()
  })

  it('says an earlier version is showing while the newer one is written, and which on hover', async () => {
    data = versioned({ projected: 9, fresh: false, status: 'projecting', served: 9 })
    renderChip()
    await userEvent.setup().hover(screen.getByText('Showing an earlier version · updating…'))
    const tip = await screen.findByRole('tooltip')
    expect(tip).toHaveTextContent('Showing an earlier version while the graph updates')
    expect(tip).toHaveTextContent('Views show version #9')
    expect(tip).toHaveTextContent('until version #11 is written to the graph, then refresh on their own')
    for (const word of ['Postgres', 'FalkorDB', 'cmt_']) {
      expect(document.body.textContent).not.toContain(word)
    }
  })

  it('says it may be out of date when the graph is behind', () => {
    data = versioned({ projected: 10, fresh: false })
    renderChip()
    expect(screen.getByText('May be out of date')).toBeInTheDocument()
  })

  it('says the same when the graph failed to refresh', () => {
    data = versioned({ projected: 10, fresh: false, lastError: 'boom' })
    renderChip()
    expect(screen.getByText('May be out of date')).toBeInTheDocument()
  })

  it('says it is checking until a status arrives', () => {
    data = undefined
    renderChip()
    expect(screen.getByText('Checking sync…')).toBeInTheDocument()
  })
})

describe('SyncStatusChip in the Technical view', () => {
  it('says which earlier version views show and which is being written', () => {
    data = versioned({ projected: 9, fresh: false, status: 'projecting', served: 9 })
    renderChip()
    const chip = screen.getByRole('button', { name: /^Sync status/ })
    expect(chip).toHaveTextContent('Showing #9 · writing #11')
    fireEvent.click(chip)
    expect(screen.getByText('Showing an earlier version while the graph updates')).toBeInTheDocument()
    expect(screen.getByText('Views show version #9 until version #11 is written, then refresh on their own')).toBeInTheDocument()
  })

  it('is a button saying the version, opening the card that names the stores', () => {
    renderChip()
    const chip = screen.getByRole('button', { name: /^Sync status/ })
    expect(chip).toHaveTextContent('In sync · v11')
    fireEvent.click(chip)
    expect(screen.getByText('Postgres')).toBeInTheDocument()
    expect(screen.getByText('FalkorDB')).toBeInTheDocument()
  })
})
