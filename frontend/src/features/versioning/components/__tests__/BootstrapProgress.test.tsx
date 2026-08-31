/**
 * BootstrapProgress — the three states a user actually sees while (and after) their
 * graph is copied into version history: live phases, the integrity report that makes
 * enabling an act of evidence rather than faith, and a failure that says plainly that
 * nothing was changed.
 */
import { fireEvent, render, screen } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'

const retryMutate = vi.fn()
const abandonMutate = vi.fn()
const openPanel = vi.fn()

vi.mock('../../hooks/useVersioning', () => ({
  useRetryBootstrap: () => ({ mutate: retryMutate, isPending: false }),
  useAbandonBootstrap: () => ({ mutate: abandonMutate, isPending: false }),
}))
vi.mock('@/components/ui/notifications', () => ({ useAppNotifications: () => ({ notify: vi.fn() }) }))
vi.mock('@/store/versioningPanelStore', () => ({
  useVersioningPanelStore: (sel: (s: unknown) => unknown) => sel({ openPanel }),
}))

import type { BootstrapJob } from '@/services/versioningApiService'
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

  it('keeps the technical details one click away', () => {
    render_(failed)
    expect(screen.queryByText(/job vjob_1/)).not.toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: /Technical details/ }))
    expect(screen.getByText(/job vjob_1/)).toBeInTheDocument()
  })
})
