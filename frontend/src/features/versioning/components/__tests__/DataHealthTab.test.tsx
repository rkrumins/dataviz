/**
 * DataHealthTab — RTL specs for the manager-only sync/rebuild surface. The two projection mutations
 * and the watermark hook are mocked (per ViewHistoryTimeline.test.tsx); the reconcile mock drives its
 * result through the caller's onSuccess/onError so we assert the rendered business-plain copy.
 * Rebuild lifecycle transitions are driven by rerendering with a mutated watermark — the mock returns
 * a fresh object per render, so the terminal-state effect re-evaluates exactly like a live poll tick.
 */
import { render, screen, fireEvent } from '@testing-library/react'
import { describe, it, expect, vi, beforeEach } from 'vitest'
import type { DriftReport, Watermark } from '@/services/versioningApiService'

const notify = vi.fn()
const reconcileMutate = vi.fn()
const rebuildMutate = vi.fn()

let watermark: Watermark | undefined
let reconcileResolve: { ok: true; report: DriftReport } | { ok: false; error: Error }

vi.mock('@/components/ui/notifications', () => ({ useAppNotifications: () => ({ notify }) }))
vi.mock('../../hooks/useVersioning', () => ({
  useProjectionWatermark: () => ({ data: watermark ? { ...watermark } : undefined, dataUpdatedAt: Date.now() }),
  useReconcileProjection: () => ({ mutate: reconcileMutate, isPending: false }),
  useRebuildProjection: () => ({ mutate: rebuildMutate, isPending: false }),
}))

// The header chip's sync reading (lineage-summaries automation). Undefined by default: no row.
let syncDoc: unknown
vi.mock('@/features/sync-status/useSyncStatus', () => ({ useSyncStatus: () => ({ data: syncDoc }) }))

import { DataHealthTab } from '../DataHealthTab'

const baseReport = (over: Partial<DriftReport> = {}): DriftReport => ({
  graphId: 'g1', falkorGraphName: 'fg', committedSeq: 12, projectedSeq: 12,
  status: 'idle', fresh: true, pgNodes: 40, pgEdges: 12, falkorNodes: 40, falkorEdges: 12,
  missingNodes: [], extraNodes: [], missingEdges: [], extraEdges: [], mismatched: [],
  truncated: false, inSync: true, checkedAt: new Date().toISOString(), durationMs: 1200,
  skippedReason: null, ...over,
})

const renderTab = () => render(<DataHealthTab wsId="ws1" graphId="g1" />)

beforeEach(() => {
  syncDoc = undefined
  notify.mockReset()
  reconcileMutate.mockReset()
  rebuildMutate.mockReset()
  watermark = { committed: 12, projected: 12, fresh: true, status: 'idle' }
  reconcileResolve = { ok: true, report: baseReport() }
  reconcileMutate.mockImplementation((_vars: unknown, opts: any) => {
    if (reconcileResolve.ok) opts.onSuccess(reconcileResolve.report)
    else opts.onError(reconcileResolve.error)
  })
  rebuildMutate.mockImplementation((_v: unknown, opts: any) =>
    opts?.onSuccess?.({ started: true, alreadyRunning: false, watermark }))
})

describe('DataHealthTab', () => {
  it('shows the in-sync hero, saved in the system of record and in sync in the graph', () => {
    watermark = { committed: 12, projected: 12, fresh: true, status: 'idle' }
    renderTab()
    expect(screen.getByText('Everything is in sync')).toBeInTheDocument()
    expect(screen.getByText('Saved · published version #12')).toBeInTheDocument()
    expect(screen.getByText('In sync · version #12')).toBeInTheDocument()
  })

  it('says how far the graph is behind the system of record, and when it is catching up or failed', () => {
    watermark = { committed: 15, projected: 12, fresh: false, status: 'idle' }
    const { unmount } = renderTab()
    expect(screen.getByText('Saved · published version #15')).toBeInTheDocument()
    expect(screen.getByText('3 versions behind')).toBeInTheDocument()
    unmount()
    watermark = { committed: 13, projected: 12, fresh: false, status: 'projecting' }
    const second = renderTab()
    expect(screen.getByText('Catching up · 1 version behind')).toBeInTheDocument()
    second.unmount()
    watermark = { committed: 13, projected: 12, fresh: false, status: 'idle', lastError: 'boom' }
    renderTab()
    expect(screen.getByText('Out of sync · 1 version behind')).toBeInTheDocument()
  })

  it('surfaces a recorded failure as "Attention needed" with the reason behind a disclosure', () => {
    watermark = {
      committed: 12, projected: 0, fresh: false, status: 'idle', target: 12,
      lastError: 'Error 111 connecting to localhost:6379. Connection refused.',
    }
    renderTab()
    expect(screen.getByText('Attention needed')).toBeInTheDocument()
    // The raw reason stays behind the technical disclosure.
    expect(screen.queryByText(/Connection refused/)).not.toBeInTheDocument()
    fireEvent.click(screen.getByText('Technical details'))
    expect(screen.getByText(/Connection refused/)).toBeInTheDocument()
    expect(screen.getByText(/target #12/)).toBeInTheDocument()
  })

  it('renders the in-sync success copy with item and connection counts', () => {
    reconcileResolve = { ok: true, report: baseReport({ inSync: true, pgNodes: 40, pgEdges: 12 }) }
    renderTab()
    fireEvent.click(screen.getByRole('button', { name: 'Check sync' }))
    expect(screen.getByText(/matches the source of truth — 40 items and 12 connections checked/i)).toBeInTheDocument()
  })

  it('renders a drift summary, an expandable technical breakdown, and a Rebuild CTA', () => {
    reconcileResolve = { ok: true, report: baseReport({
      inSync: false, fresh: false, status: 'idle', truncated: true,
      missingNodes: [{ entityId: 'ent_1', displayName: 'Orders', urn: 'urn:orders' }],
    }) }
    renderTab()
    fireEvent.click(screen.getByRole('button', { name: 'Check sync' }))

    expect(screen.getByText('The fast read layer is out of date.')).toBeInTheDocument()
    expect(screen.getByText(/1 item missing from the fast read layer/i)).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Rebuild' })).toBeInTheDocument()

    // Samples are hidden until the disclosure is opened.
    expect(screen.queryByText(/Orders \(ent_1\)/)).not.toBeInTheDocument()
    fireEvent.click(screen.getByText('Technical details'))
    expect(screen.getByText(/Orders \(ent_1\)/)).toBeInTheDocument()
    expect(screen.getByText(/and more not shown/i)).toBeInTheDocument()
  })

  it('shows a neutral note and no drift UI when the check is skipped', () => {
    reconcileResolve = { ok: true, report: baseReport({ inSync: false, skippedReason: 'projection in flight' }) }
    renderTab()
    fireEvent.click(screen.getByRole('button', { name: 'Check sync' }))

    expect(screen.getByText(/A refresh is in progress — try again in a moment\./)).toBeInTheDocument()
    expect(screen.queryByText(/missing from the fast read layer/i)).not.toBeInTheDocument()
    expect(screen.queryByText('The fast read layer is out of date.')).not.toBeInTheDocument()
    expect(screen.queryByRole('button', { name: 'Rebuild' })).not.toBeInTheDocument()
  })

  it('opens a confirm before rebuilding: confirming calls the mutation, cancelling does not', () => {
    renderTab()

    // Cancel does not rebuild.
    fireEvent.click(screen.getByRole('button', { name: 'Rebuild fast read layer' }))
    expect(screen.getByText('Rebuild the fast read layer?')).toBeInTheDocument()
    fireEvent.click(screen.getByText('Cancel'))
    expect(rebuildMutate).not.toHaveBeenCalled()
    expect(screen.queryByText('Rebuild the fast read layer?')).not.toBeInTheDocument()

    // Confirming does.
    fireEvent.click(screen.getByRole('button', { name: 'Rebuild fast read layer' }))
    fireEvent.click(screen.getByRole('button', { name: 'Rebuild' }))
    expect(rebuildMutate).toHaveBeenCalledTimes(1)
  })

  it('walks the rebuild through running → live progress → verified done', () => {
    const { rerender } = renderTab()
    fireEvent.click(screen.getByRole('button', { name: 'Rebuild fast read layer' }))
    fireEvent.click(screen.getByRole('button', { name: 'Rebuild' }))
    expect(screen.getByText(/Rebuilding… this can take a few minutes/)).toBeInTheDocument()

    // Poll tick: full seed underway with live item counts.
    watermark = {
      committed: 12, projected: 0, fresh: false, status: 'rebuilding', target: 12,
      progressDone: 5000, progressTotal: 10000,
    }
    rerender(<DataHealthTab wsId="ws1" graphId="g1" />)
    expect(screen.getByText('Rebuilding the fast read layer…')).toBeInTheDocument()
    expect(screen.getAllByText(/5,000 of 10,000 items/).length).toBeGreaterThan(0)

    // Poll tick: caught up — done, and the auto-verify (shallow reconcile) reports counts.
    watermark = { committed: 12, projected: 12, fresh: true, status: 'idle', target: 12 }
    rerender(<DataHealthTab wsId="ws1" graphId="g1" />)
    expect(reconcileMutate).toHaveBeenCalledWith({ deep: false }, expect.anything())
    expect(screen.getByText(/Rebuilt and verified — 40 items and 12 connections checked/)).toBeInTheDocument()
  })

  it('lands on a terminal failed state with the recorded reason and a working Retry', () => {
    const { rerender } = renderTab()
    fireEvent.click(screen.getByRole('button', { name: 'Rebuild fast read layer' }))
    fireEvent.click(screen.getByRole('button', { name: 'Rebuild' }))

    // Poll tick: it started…
    watermark = { committed: 12, projected: 0, fresh: false, status: 'rebuilding', target: 12 }
    rerender(<DataHealthTab wsId="ws1" graphId="g1" />)
    // …then died: idle, still behind, reason recorded.
    watermark = {
      committed: 12, projected: 0, fresh: false, status: 'idle', target: 12,
      lastError: 'projection cancelled (timeout)',
    }
    rerender(<DataHealthTab wsId="ws1" graphId="g1" />)

    expect(screen.getByText("The rebuild couldn't finish.")).toBeInTheDocument()
    expect(screen.getByText('projection cancelled (timeout)')).toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: 'Retry rebuild' }))
    expect(rebuildMutate).toHaveBeenCalledTimes(2)
  })

  it('says the lineage summaries need rebuilding when every item matches but they do not', () => {
    reconcileResolve = { ok: true, report: baseReport({
      rollups: { status: 'untrusted', aggregated: 2692, stubs: 2692 } }) }
    renderTab()
    fireEvent.click(screen.getByRole('button', { name: 'Check sync' }))
    expect(screen.getByText(/lineage summaries between containers need rebuilding/)).toBeInTheDocument()
    fireEvent.click(screen.getAllByRole('button', { name: 'Rebuild fast read layer' })[0])
    expect(screen.getByRole('heading', { name: 'Rebuild fast read layer' })).toBeInTheDocument()
  })

  it('says the summaries are being rebuilt automatically — and offers nothing to press — when a rebuild is queued', () => {
    syncDoc = {
      kind: 'versioned', dataSourceId: 'ds', checkedAt: '',
      versioned: { graphId: 'g1', committed: 12, projected: 12, fresh: true, status: 'idle' },
      summaries: { aggregationStatus: 'ready', driftState: 'managed', jobId: 'agg_1', jobStatus: 'pending' },
    }
    reconcileResolve = { ok: true, report: baseReport({
      rollups: { status: 'untrusted', aggregated: 2692, stubs: 0 } }) }
    renderTab()
    expect(screen.getByText('Queued · starts shortly')).toBeInTheDocument()          // the hero's third row
    fireEvent.click(screen.getByRole('button', { name: 'Check sync' }))
    expect(screen.getByText(/being brought up to date automatically/)).toBeInTheDocument()
    expect(screen.queryByText(/need rebuilding/)).toBeNull()
  })

  it('stays quiet about healthy summaries', () => {
    reconcileResolve = { ok: true, report: baseReport({
      rollups: { status: 'ok', aggregated: 12, stubs: 0 } }) }
    renderTab()
    fireEvent.click(screen.getByRole('button', { name: 'Check sync' }))
    expect(screen.queryByText(/lineage summaries/)).toBeNull()
    expect(screen.getByText(/The fast read layer matches the source of truth/)).toBeInTheDocument()
  })
})
