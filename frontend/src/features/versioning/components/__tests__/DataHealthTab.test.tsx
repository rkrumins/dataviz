/**
 * DataHealthTab — RTL specs for the manager-only sync/rebuild surface. The two projection mutations
 * and the watermark hook are mocked (per ViewHistoryTimeline.test.tsx); the reconcile mock drives its
 * result through the caller's onSuccess/onError so we assert the rendered business-plain copy.
 */
import { render, screen, fireEvent } from '@testing-library/react'
import { describe, it, expect, vi, beforeEach } from 'vitest'
import type { DriftReport, Watermark } from '@/services/versioningApiService'

const showToast = vi.fn()
const reconcileMutate = vi.fn()
const rebuildMutate = vi.fn()

let watermark: Watermark | undefined
let reconcileResolve: { ok: true; report: DriftReport } | { ok: false; error: Error }

vi.mock('@/components/ui/toast', () => ({ useToast: () => ({ showToast }) }))
vi.mock('../../hooks/useVersioning', () => ({
  useProjectionWatermark: () => ({ data: watermark }),
  useReconcileProjection: () => ({ mutate: reconcileMutate, isPending: false }),
  useRebuildProjection: () => ({ mutate: rebuildMutate, isPending: false }),
}))

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
  showToast.mockReset()
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
  it('shows "Up to date" and both version numbers for a fresh watermark', () => {
    watermark = { committed: 12, projected: 12, fresh: true, status: 'idle' }
    renderTab()
    expect(screen.getByText('Up to date')).toBeInTheDocument()
    expect(screen.getAllByText('#12')).toHaveLength(2)
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
})
