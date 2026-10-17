/**
 * ProjectionHealthCard — where one versioned graph's fast read layer lives (provider, key, whose
 * key it is, node/shard/slot) and how healthy it is (watermark, epoch, backoff, liveness). The
 * watermark and placement hooks and the two projection mutations are mocked; the actions only
 * render when the caller says the viewer may manage.
 */
import { render, screen, fireEvent } from '@testing-library/react'
import { MemoryRouter } from 'react-router-dom'
import { describe, it, expect, vi, beforeEach } from 'vitest'
import type { DriftReport, Watermark } from '@/services/versioningApiService'
import type { GraphPlacementResponse } from '@/services/graphStoreService'

const notify = vi.fn()
const reconcileMutate = vi.fn()
const rebuildMutate = vi.fn()
const refetch = vi.fn()

let wmQ: { data?: Watermark; isLoading: boolean; isError: boolean }
let placementQ: { data?: GraphPlacementResponse; isLoading: boolean; isError: boolean }
const placementCalls: Array<string | null> = []

vi.mock('@/components/ui/notifications', () => ({ useAppNotifications: () => ({ notify }) }))
vi.mock('../../hooks/useVersioning', () => ({
  useProjectionWatermark: () => ({ ...wmQ, refetch }),
  useReconcileProjection: () => ({ mutate: reconcileMutate, isPending: false }),
  useRebuildProjection: () => ({ mutate: rebuildMutate, isPending: false }),
}))
vi.mock('@/components/admin/shared/useGraphStoreTopology', () => ({
  useGraphPlacementByGraph: (graphId: string | null) => {
    placementCalls.push(graphId)
    return placementQ
  },
}))

import { ProjectionHealthCard } from '../ProjectionHealthCard'

const WM: Watermark = {
  committed: 12, projected: 12, fresh: true, status: 'idle',
  projectionKey: 'gv_g1', providerId: 'prov_1', providerName: 'Primary graph store', owned: true,
  epoch: 7, failedAttempts: 0, nextRetryAt: null, livenessError: null,
}

const PLACEMENT: GraphPlacementResponse = {
  dataSourceId: 'ds-1', providerId: 'prov_1', providerName: 'Primary graph store', instanceId: 'i1',
  mode: 'cluster', reachable: true,
  placements: [{
    graphKey: 'gv_g1', role: 'source', slot: 4321, shardIndex: 1, present: true,
    master: {
      endpoint: '10.0.0.2:6379', role: 'master', status: 'up',
      memory: { used: 2 ** 30, maxmemory: 4 * 2 ** 30, usedPct: 25 },
    } as never,
    replicas: [], siblings: 0, siblingsSample: [], edgeCount: 900, measuredBytes: 2 ** 20,
  }],
  totals: { masters: 3, replicas: 3, nodesUp: 6, nodesTotal: 6 } as never,
  cacheAgeMs: 0, stale: false,
}

const report = (over: Partial<DriftReport> = {}): DriftReport => ({
  graphId: 'g1', falkorGraphName: 'gv_g1', committedSeq: 12, projectedSeq: 12,
  status: 'idle', fresh: true, pgNodes: 40, pgEdges: 12, falkorNodes: 40, falkorEdges: 12,
  missingNodes: [], extraNodes: [], missingEdges: [], extraEdges: [], mismatched: [],
  truncated: false, inSync: true, checkedAt: new Date().toISOString(), durationMs: 900,
  skippedReason: null, ...over,
})

const renderCard = (showActions = false) =>
  render(
    <MemoryRouter>
      <ProjectionHealthCard wsId="ws1" graphId="g1" showActions={showActions} />
    </MemoryRouter>,
  )

beforeEach(() => {
  notify.mockReset()
  reconcileMutate.mockReset()
  rebuildMutate.mockReset()
  refetch.mockReset()
  placementCalls.length = 0
  wmQ = { data: { ...WM }, isLoading: false, isError: false }
  placementQ = { data: PLACEMENT, isLoading: false, isError: false }
})

describe('ProjectionHealthCard', () => {
  it('names the provider and key, badges a platform-owned key, and places it on its node', () => {
    renderCard()
    expect(screen.getByText('Primary graph store')).toBeInTheDocument()
    expect(screen.getByText('gv_g1', { selector: 'dd' })).toBeInTheDocument()
    expect(screen.getByText('Platform copy')).toBeInTheDocument()
    expect(screen.queryByText('Customer graph')).not.toBeInTheDocument()
    // Node, shard and slot come from placement by GRAPH id (a fork's key is not its source's).
    expect(placementCalls).toContain('g1')
    expect(screen.getByText('10.0.0.2:6379')).toBeInTheDocument()
    expect(screen.getByText(/Shard 2/)).toBeInTheDocument()
    expect(screen.getByText(/slot 4,321/)).toBeInTheDocument()
    expect(screen.getByRole('meter')).toHaveAttribute('aria-valuenow', '25')
  })

  it('badges a key the customer owns as their graph', () => {
    wmQ.data = { ...WM, owned: false, projectionKey: 'warehouse' }
    renderCard()
    expect(screen.getByText('Customer graph')).toBeInTheDocument()
    expect(screen.queryByText('Platform copy')).not.toBeInTheDocument()
  })

  it('shows the watermark, epoch, backoff and liveness reading', () => {
    wmQ.data = {
      ...WM, committed: 15, projected: 12, fresh: false, epoch: 9, failedAttempts: 3,
      nextRetryAt: '2026-10-17T12:00:00Z', livenessError: 'liveness: key gv_g1 is empty',
    }
    renderCard()
    expect(screen.getByText('#12 of #15')).toBeInTheDocument()
    expect(screen.getByText('9')).toBeInTheDocument()
    expect(screen.getByText(/3 failed attempts in a row/)).toBeInTheDocument()
    expect(screen.getByText('liveness: key gv_g1 is empty')).toBeInTheDocument()
  })

  it('says a healthy graph has no backoff and no liveness problem', () => {
    renderCard()
    expect(screen.getByText('#12 of #12')).toBeInTheDocument()
    expect(screen.getByText('None')).toBeInTheDocument()
    expect(screen.getByText('No problems recorded')).toBeInTheDocument()
  })

  it('says an evicted graph was unloaded, not that it is behind', () => {
    wmQ.data = { ...WM, projected: 0, fresh: false, status: 'evicted' }
    renderCard()
    expect(screen.getByText(/Unloaded to free memory/)).toBeInTheDocument()
    expect(screen.queryByText('#0 of #12')).not.toBeInTheDocument()
  })

  it('shows a skeleton while the watermark loads', () => {
    wmQ = { data: undefined, isLoading: true, isError: false }
    renderCard()
    expect(screen.getByLabelText('Loading the fast read layer')).toHaveAttribute('aria-busy', 'true')
  })

  it('says when the watermark could not be read, with a retry', () => {
    wmQ = { data: undefined, isLoading: false, isError: true }
    renderCard()
    expect(screen.getByText(/could not read where this graph lives/i)).toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: 'Retry' }))
    expect(refetch).toHaveBeenCalled()
  })

  it('says a graph with no key yet is not in the graph store, and asks for no placement', () => {
    wmQ.data = { ...WM, projectionKey: null, providerId: null, providerName: null, owned: false }
    renderCard()
    expect(screen.getByText('Not in the graph store yet')).toBeInTheDocument()
    expect(placementCalls.every((g) => g === null)).toBe(true)
  })

  it('keeps the card when node details are unavailable', () => {
    placementQ = { data: undefined, isLoading: false, isError: true }
    renderCard()
    expect(screen.getByText('Primary graph store')).toBeInTheDocument()
    expect(screen.getByText(/node and shard details are unavailable/i)).toBeInTheDocument()
  })

  it('is read-only unless the viewer may manage', () => {
    renderCard(false)
    expect(screen.queryByRole('button', { name: 'Check sync' })).not.toBeInTheDocument()
    expect(screen.queryByRole('button', { name: 'Rebuild' })).not.toBeInTheDocument()
  })

  it('lets a manager check sync and see the result', () => {
    reconcileMutate.mockImplementation((_v: unknown, opts: { onSuccess: (r: DriftReport) => void }) =>
      opts.onSuccess(report({ inSync: true, pgNodes: 40, pgEdges: 12 })))
    renderCard(true)
    fireEvent.click(screen.getByRole('button', { name: 'Check sync' }))
    expect(reconcileMutate).toHaveBeenCalledWith({ deep: false }, expect.anything())
    expect(screen.getByText(/In sync — 40 items and 12 connections checked/)).toBeInTheDocument()
  })

  it('lets a manager rebuild after confirming', () => {
    rebuildMutate.mockImplementation((_v: unknown, opts: { onSuccess: (r: unknown) => void }) =>
      opts.onSuccess({ started: true, alreadyRunning: false, watermark: WM }))
    renderCard(true)
    fireEvent.click(screen.getByRole('button', { name: 'Rebuild' }))
    expect(rebuildMutate).not.toHaveBeenCalled()
    expect(screen.getByText(/No data is lost/)).toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: 'Rebuild now' }))
    expect(rebuildMutate).toHaveBeenCalled()
    expect(notify).toHaveBeenCalledWith('info', expect.stringMatching(/rebuild started/i))
  })
})
