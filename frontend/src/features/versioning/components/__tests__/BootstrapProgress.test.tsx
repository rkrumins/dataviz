/**
 * BootstrapProgress — the states a user actually sees while (and after) their graph is
 * copied into version history: live phases, a pause over duplicate identifiers that a
 * manager decides, the integrity report that makes enabling an act of evidence rather
 * than faith, and a failure that says plainly that nothing was changed.
 */
import { fireEvent, render, screen } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'

const retryMutate = vi.fn()
const abandonMutate = vi.fn()
const decideMutate = vi.fn()
const openPanel = vi.fn()
const notify = vi.fn()

vi.mock('../../hooks/useVersioning', () => ({
  useRetryBootstrap: () => ({ mutate: retryMutate, isPending: false }),
  useAbandonBootstrap: () => ({ mutate: abandonMutate, isPending: false }),
  useDecideBootstrapDuplicates: () => ({ mutate: decideMutate, isPending: false }),
}))
vi.mock('@/components/ui/notifications', () => ({ useAppNotifications: () => ({ notify }) }))
vi.mock('@/store/versioningPanelStore', () => ({
  useVersioningPanelStore: (sel: (s: unknown) => unknown) => sel({ openPanel }),
}))

import { BootstrapDecisionError, type BootstrapJob } from '@/services/versioningApiService'
import { BootstrapProgress } from '../BootstrapProgress'

const base: BootstrapJob = {
  jobId: 'vjob_1',
  graphId: 'g1',
  status: 'running',
  phase: 'nodes',
  processed: 6_400_000,
  total: 9_800_000,
  percent: 47,
  report: null,
}

const DUPLICATES: NonNullable<BootstrapJob['duplicates']> = {
  identifiers: 2,
  extraCopies: 3,
  sameType: 1,
  crossType: 1,
  rule: 'latest_last_synced_at_then_lowest_id',
  fingerprint: 'fp_1',
  detectedAt: '2026-10-08T10:00:00Z',
  sample: [
    { urn: 'urn:li:dataset:orders', label: 'Dataset', internalId: 7, lastSyncedAt: '2026-10-01T09:00:00Z', kept: true },
    { urn: 'urn:li:dataset:orders', label: 'Dataset', internalId: 3, lastSyncedAt: '2026-09-01T09:00:00Z', kept: false },
    { urn: 'urn:li:dataset:users', label: 'Table', internalId: 11, lastSyncedAt: null, kept: true },
  ],
  decision: null,
  sharedWith: [],
  sharedWithOtherWorkspaces: 0,
}

const render_ = (job: Partial<BootstrapJob>) =>
  render(<BootstrapProgress job={{ ...base, ...job } as BootstrapJob} wsId="ws1" dataSourceId="ds1" />)

beforeEach(() => vi.clearAllMocks())

describe('while the copy is running', () => {
  it('names the phase, counts the items, and shows determinate progress', () => {
    render_({})
    expect(screen.getByText('Reading the graph')).toBeInTheDocument()
    expect(screen.getByText(/6,400,000 of 9,800,000 items copied/)).toBeInTheDocument()
    expect(screen.getByRole('progressbar')).toHaveAttribute('aria-valuenow', '47')
  })

  it('says it is queued before the worker picks it up', () => {
    render_({ status: 'pending', phase: null, processed: 0, total: 0, percent: 0 })
    expect(screen.getByText(/queued/)).toBeInTheDocument()
    expect(screen.getByText(/how big this graph is/)).toBeInTheDocument()
  })

  // ── time remaining: a big graph can run the better part of an hour, and a bare
  //    percentage leaves someone unable to decide whether to wait or come back later.
  //    But a confidently WRONG estimate is worse than none, so it must refuse to guess.

  it('estimates the time left from the throughput actually observed', () => {
    // 6.4M of 9.8M in 10 minutes => ~5.3 min for the remaining 3.4M.
    const startedAt = new Date(Date.now() - 10 * 60_000).toISOString()
    render_({ startedAt })
    expect(screen.getByText(/about 5 minutes left/)).toBeInTheDocument()
  })

  it('says nothing while the counter is frozen — checking and writing cannot be timed', () => {
    const startedAt = new Date(Date.now() - 10 * 60_000).toISOString()
    render_({ startedAt, phase: 'validate' })
    expect(screen.queryByText(/left/)).not.toBeInTheDocument()
  })

  it('says nothing in the first seconds, when it would only be guessing', () => {
    render_({ startedAt: new Date(Date.now() - 3_000).toISOString() })
    expect(screen.queryByText(/left/)).not.toBeInTheDocument()
  })
})

describe('when the copy lands', () => {
  const done: Partial<BootstrapJob> = {
    status: 'completed',
    phase: null,
    percent: 100,
    report: {
      checks: [
        { key: 'nodes_seen', ok: true, detail: 'scanned 6 of 6 items', blocking: true },
        { key: 'types_preserved', ok: true, detail: '2 relationship type(s) preserved', blocking: true },
      ],
      source: { nodes: 6, edges: 3 },
      stored: { nodes: 6, edges: 3 },
      labels: { Table: 6 },
      edgeTypes: { FLOWS_TO: 3 },
      sampleChecked: 6,
      sampleMismatched: [],
      mergedDuplicateConnections: 0,
      merkle: 'inline',
    },
  }

  it('shows the integrity report and states zero data loss', () => {
    render_(done)
    expect(screen.getByText('Everything checked out')).toBeInTheDocument()
    expect(screen.getByText('scanned 6 of 6 items')).toBeInTheDocument()
    expect(screen.getByText('2 relationship type(s) preserved')).toBeInTheDocument()
    expect(screen.getByText(/Zero data loss/)).toBeInTheDocument()
  })

  it('offers a way into the new history', () => {
    render_(done)
    fireEvent.click(screen.getByRole('button', { name: /View history/ }))
    expect(openPanel).toHaveBeenCalledWith('history')
  })

  it('discloses merged duplicates and a deferred fingerprint honestly', () => {
    render_({
      ...done,
      report: { ...done.report!, mergedDuplicateConnections: 4, merkle: 'deferred' },
    })
    expect(screen.getByText(/4 duplicate connection/)).toBeInTheDocument()
    expect(screen.getByText(/fingerprint is deferred/)).toBeInTheDocument()
  })

  it('discloses the duplicate items collapsed, as decided', () => {
    render_({ ...done, collapsed: { nodes: 3, byLabel: { Dataset: 3 }, selfLoops: 0 } })
    expect(screen.getByText(/3 duplicate item\(s\) were collapsed/)).toBeInTheDocument()
  })
})

describe('when the copy fails', () => {
  const failed: Partial<BootstrapJob> = {
    status: 'failed',
    error: 'The source graph changed while we were copying it, so the copy can\'t be trusted.',
  }

  it('leads with the reassurance that nothing changed, in plain language', () => {
    render_(failed)
    expect(screen.getByText('We stopped before changing anything')).toBeInTheDocument()
    expect(screen.getByText(/source graph changed while we were copying/)).toBeInTheDocument()
    expect(screen.getByText(/untouched and still reads exactly as it did/)).toBeInTheDocument()
  })

  it('resumes on one click — the safe action costs nothing', () => {
    render_(failed)
    fireEvent.click(screen.getByRole('button', { name: /Resume/ }))
    expect(retryMutate).toHaveBeenCalledWith('resume', expect.anything())
  })

  // ── the two destructive actions sit right next to Resume. A single stray click on
  //    "Start over" would throw away everything already copied — on a large graph, an hour
  //    of work — when Resume would have finished it. They must ask, and say what it costs.

  it('will not start over on one click, and says what starting over would cost', () => {
    render_(failed)
    fireEvent.click(screen.getByRole('button', { name: /Start over/ }))
    expect(retryMutate).not.toHaveBeenCalled()

    expect(screen.getByText(/throws away the/)).toBeInTheDocument()
    expect(screen.getByText('6,400,000 items')).toBeInTheDocument()   // the count it would lose
    expect(screen.getByText(/Resuming keeps them/)).toBeInTheDocument()

    fireEvent.click(screen.getByRole('button', { name: /Yes, start over/ }))
    expect(retryMutate).toHaveBeenCalledWith('restart', expect.anything())
  })

  it('will not give up on one click, and promises the data source is untouched', () => {
    render_(failed)
    fireEvent.click(screen.getByRole('button', { name: /Give up/ }))
    expect(abandonMutate).not.toHaveBeenCalled()
    expect(screen.getByText(/Your data source is not touched/)).toBeInTheDocument()

    fireEvent.click(screen.getByRole('button', { name: /Yes, remove it/ }))
    expect(abandonMutate).toHaveBeenCalled()
  })

  it('lets the user back out of a destructive action', () => {
    render_(failed)
    fireEvent.click(screen.getByRole('button', { name: /Start over/ }))
    fireEvent.click(screen.getByRole('button', { name: /^Cancel$/ }))
    expect(retryMutate).not.toHaveBeenCalled()
    expect(screen.getByRole('button', { name: /Resume/ })).toBeInTheDocument()
  })

  it('hides the recovery actions from users who cannot manage the source', () => {
    render(
      <BootstrapProgress
        job={{ ...base, ...failed } as BootstrapJob}
        wsId="ws1" dataSourceId="ds1" canManage={false}
      />,
    )
    expect(screen.queryByRole('button', { name: /Resume/ })).not.toBeInTheDocument()
  })

  // ── the failure says what can fix it, and only that is offered: resuming an integrity failure
  //    would only fail the same way again, and an internal one is a bug no button fixes.

  it('offers only Start over when resuming cannot help, and says why', () => {
    render_({ ...failed, failure: { code: 'integrity', action: 'restart', phase: 'validate' } })
    expect(screen.queryByRole('button', { name: /Resume/ })).not.toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: /Start over/ }))
    expect(screen.getByText(/would only fail the same way again/)).toBeInTheDocument()
    expect(screen.queryByText(/Resuming keeps them/)).not.toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: /Yes, start over/ }))
    expect(retryMutate).toHaveBeenCalledWith('restart', expect.anything())
  })

  it('offers Resume when the failure can be resumed', () => {
    render_({ ...failed, failure: { code: 'infrastructure', action: 'resume', phase: 'edges' } })
    expect(screen.getByRole('button', { name: /Resume/ })).toBeInTheDocument()
  })

  it('offers no retry for a failure no retry can fix — only Give up', () => {
    render_({ ...failed, failure: { code: 'internal', action: null, phase: 'heads' } })
    expect(screen.queryByRole('button', { name: /Resume/ })).not.toBeInTheDocument()
    expect(screen.queryByRole('button', { name: /Start over/ })).not.toBeInTheDocument()
    expect(screen.getByRole('button', { name: /Give up/ })).toBeInTheDocument()
  })

  it('stops promising an untouched source once a collapse was decided', () => {
    render_({ ...failed, duplicates: { ...DUPLICATES, decision: {
      policy: 'collapse', fingerprint: 'fp_1', decidedBy: 'u1', decidedAt: '2026-10-08T10:00:00Z' } } })
    expect(screen.queryByText(/untouched/)).not.toBeInTheDocument()
    expect(screen.getByText(/may already have been removed/)).toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: /Give up/ }))
    expect(screen.queryByText(/Your data source is not touched/)).not.toBeInTheDocument()
    expect(screen.getByText(/already removed from your data source are\s+not put back/)).toBeInTheDocument()
  })

  it('remembers that copies left the source after a restart forgot the list', () => {
    // A restart re-reads the source — whose duplicates the collapse already removed — so there is
    // no list or decision left; `sourceCollapse` is what still says copies are gone.
    render_({ ...failed, duplicates: null, sourceCollapse: { moved: 3, deleted: 2 } })
    fireEvent.click(screen.getByRole('button', { name: /Give up/ }))
    expect(screen.queryByText(/Your data source is not touched/)).not.toBeInTheDocument()
    expect(screen.getByText(/already removed from your data source are\s+not put back/)).toBeInTheDocument()
  })

  it('keeps the technical details one click away', () => {
    render_(failed)
    expect(screen.queryByText(/job vjob_1/)).not.toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: /Technical details/ }))
    expect(screen.getByText(/job vjob_1/)).toBeInTheDocument()
  })
})

// ── paused before copying anything: the source uses some identifiers more than once, and
//    version history keeps one item per identifier. Collapsing removes data from the
//    customer's own graph, so it is a manager's informed decision — never ours.

describe('when the source has duplicate identifiers', () => {
  const paused: Partial<BootstrapJob> = {
    status: 'needs_decision', phase: 'awaiting_decision', processed: 0, total: 0, percent: 0,
    duplicates: DUPLICATES,
  }

  it('says what collides, split by type, and that nothing has been copied', () => {
    render_(paused)
    expect(screen.getByText('Some identifiers are used more than once')).toBeInTheDocument()
    expect(screen.getByText(/2 identifier\(s\) each belong to more than one item/)).toBeInTheDocument()
    expect(screen.getByText(/1 where\s+the copies share a type, 1 where they don't/)).toBeInTheDocument()
    expect(screen.getByText(/3 extra copies in all/)).toBeInTheDocument()
    expect(screen.getByText('Nothing has been copied yet.')).toBeInTheDocument()
    expect(screen.queryByRole('progressbar')).not.toBeInTheDocument()
  })

  it('shows a sample with the copy that would be kept marked, and the whole list as CSV', () => {
    render_(paused)
    const rows = screen.getAllByRole('listitem')
    expect(rows).toHaveLength(3)
    expect(rows[0]).toHaveTextContent('urn:li:dataset:orders')
    expect(rows[0]).toHaveTextContent('kept')
    expect(rows[1]).not.toHaveTextContent('kept')
    expect(screen.getByText(/Showing 3 of 5 copies/)).toBeInTheDocument()
    const csv = screen.getByRole('link', { name: /Download full list \(CSV\)/ })
    expect(csv).toHaveAttribute('href', '/api/v1/ws1/graph/bootstrap/duplicates?dataSourceId=ds1&format=csv')
  })

  it('will not collapse on one click, and says exactly what collapsing does', () => {
    render_(paused)
    fireEvent.click(screen.getByRole('button', { name: /Collapse 3 duplicates and continue/ }))
    expect(decideMutate).not.toHaveBeenCalled()

    expect(screen.getByText(/latest lastSyncedAt\), then the one with the lowest internal id/)).toBeInTheDocument()
    expect(screen.getByText(/move to the kept copy/)).toBeInTheDocument()
    expect(screen.getByText('those copies are removed from the source graph')).toBeInTheDocument()
    expect(screen.getByText(/Rollups are rebuilt/)).toBeInTheDocument()
    expect(screen.getByText(/Giving up later won't restore them/)).toBeInTheDocument()

    fireEvent.click(screen.getByRole('button', { name: /Yes, collapse and continue/ }))
    expect(decideMutate).toHaveBeenCalledWith('fp_1', expect.anything())
  })

  it('asks for a fresh look when the list changed before the decision landed', () => {
    decideMutate.mockImplementationOnce((_fp, opts) => opts.onError(new BootstrapDecisionError('stale_decision')))
    render_(paused)
    fireEvent.click(screen.getByRole('button', { name: /Collapse 3 duplicates/ }))
    fireEvent.click(screen.getByRole('button', { name: /Yes, collapse and continue/ }))
    expect(screen.getByRole('alert')).toHaveTextContent(/The list changed — review it again/)
    expect(notify).not.toHaveBeenCalledWith('error', expect.anything())
  })

  it('warns that collapsing changes the graph for every data source that reads it', () => {
    render_({ ...paused, duplicates: { ...DUPLICATES, sharedWith: [{ dataSourceId: 'ds2', name: 'Finance DWH' }] } })
    expect(screen.getByText('Finance DWH')).toBeInTheDocument()
    expect(screen.getByText(/Collapsing removes the extra copies for it too/)).toBeInTheDocument()
  })

  it('counts the readers in other workspaces without naming them', () => {
    render_({ ...paused, duplicates: { ...DUPLICATES, sharedWithOtherWorkspaces: 2 } })
    expect(screen.getByText('2 data sources in other workspaces')).toBeInTheDocument()
    expect(screen.getByText(/Collapsing removes the extra copies for them too/)).toBeInTheDocument()
  })

  it('re-checks the source at once — nothing has been copied, so there is nothing to lose', () => {
    render_(paused)
    fireEvent.click(screen.getByRole('button', { name: /Re-check source/ }))
    expect(retryMutate).toHaveBeenCalledWith('restart', expect.anything())
  })

  it('will not give up on one click', () => {
    render_(paused)
    fireEvent.click(screen.getByRole('button', { name: /Give up/ }))
    expect(abandonMutate).not.toHaveBeenCalled()
    expect(screen.getByText(/Your data source is not touched/)).toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: /Yes, remove it/ }))
    expect(abandonMutate).toHaveBeenCalled()
  })

  it('tells someone who cannot decide that it waits for a manager', () => {
    render(
      <BootstrapProgress
        job={{ ...base, ...paused } as BootstrapJob}
        wsId="ws1" dataSourceId="ds1" canManage={false}
      />,
    )
    expect(screen.getByText(/Waiting for a workspace manager/)).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: /Collapse/ })).not.toBeInTheDocument()
    expect(screen.queryByRole('button', { name: /Give up/ })).not.toBeInTheDocument()
    expect(screen.getByRole('link', { name: /Download full list/ })).toBeInTheDocument()
  })
})
