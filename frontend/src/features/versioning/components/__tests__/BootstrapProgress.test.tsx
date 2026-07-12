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
vi.mock('@/components/ui/toast', () => ({ useToast: () => ({ showToast: vi.fn() }) }))
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

  it('offers resume, start over and give up', () => {
    render_(failed)
    fireEvent.click(screen.getByRole('button', { name: /Resume/ }))
    expect(retryMutate).toHaveBeenCalledWith('resume', expect.anything())

    fireEvent.click(screen.getByRole('button', { name: /Start over/ }))
    expect(retryMutate).toHaveBeenCalledWith('restart', expect.anything())

    fireEvent.click(screen.getByRole('button', { name: /Give up/ }))
    expect(abandonMutate).toHaveBeenCalled()
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
