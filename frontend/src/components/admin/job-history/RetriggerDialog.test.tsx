/**
 * RetriggerDialog — RTL smoke tests for the conditional Resume button.
 *
 * Covers the contract called out in the FE plan:
 *   • No `originatingJob` → Resume hidden, only "Re-trigger from scratch".
 *   • `originatingJob` with non-null lastCursor + failed status → BOTH
 *     buttons visible.
 *   • `originatingJob` with NULL lastCursor → Resume hidden.
 *
 * The shared `AggregationOverridesForm` is mocked out — it has its own
 * tests, and its full render pulls in framer-motion + radix tooltip
 * which add noise without buying coverage of the dialog's own logic.
 */
import { render, screen } from '@testing-library/react'
import { MemoryRouter } from 'react-router-dom'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { describe, expect, it, vi } from 'vitest'

const { getSourceCapacity } = vi.hoisted(() => ({ getSourceCapacity: vi.fn() }))
vi.mock('@/store/auth', () => ({ usePermission: () => true }))
vi.mock('@/services/aggregationService', async () => {
  const actual = await vi.importActual<typeof import('@/services/aggregationService')>('@/services/aggregationService')
  return { ...actual, aggregationService: { ...actual.aggregationService, getSourceCapacity } }
})

import { RetriggerDialog } from './RetriggerDialog'

// The form is owned by Wave-1 FE-1 and has its own tests; here we only
// need the dialog's button-visibility logic.
vi.mock('../shared/AggregationOverridesForm', () => ({
  AggregationOverridesForm: () => <div data-testid="overrides-form" />,
}))

const baseValue = {
  batchSize: 5000,
  projectionMode: 'in_source' as const,
  maxRetries: 3,
  timeoutMinutes: 120,
}

const noop = async () => {}

describe('RetriggerDialog', () => {
  it('hides the Resume button when no originatingJob is supplied', () => {
    render(
      <RetriggerDialog
        isOpen
        onClose={() => {}}
        initialValue={baseValue}
        title="Trigger aggregation"
        onConfirmRetrigger={noop}
      />,
    )

    expect(screen.getByRole('button', { name: /re-trigger from scratch/i }))
      .toBeInTheDocument()
    expect(screen.queryByRole('button', { name: /resume from cursor/i }))
      .not.toBeInTheDocument()
  })

  it('shows BOTH buttons for a failed job with a non-null lastCursor', () => {
    render(
      <RetriggerDialog
        isOpen
        onClose={() => {}}
        initialValue={baseValue}
        title="Re-trigger aggregation"
        originatingJob={{ id: 'j1', lastCursor: 'cur', status: 'failed' }}
        onConfirmRetrigger={noop}
        onConfirmResume={noop}
      />,
    )

    expect(screen.getByRole('button', { name: /resume from cursor/i }))
      .toBeInTheDocument()
    expect(screen.getByRole('button', { name: /re-trigger from scratch/i }))
      .toBeInTheDocument()
  })

  it('hides the Resume button when lastCursor is null even on a failed job', () => {
    render(
      <RetriggerDialog
        isOpen
        onClose={() => {}}
        initialValue={baseValue}
        title="Re-trigger aggregation"
        originatingJob={{ id: 'j1', lastCursor: null, status: 'failed' }}
        onConfirmRetrigger={noop}
        onConfirmResume={noop}
      />,
    )

    expect(screen.getByRole('button', { name: /re-trigger from scratch/i }))
      .toBeInTheDocument()
    expect(screen.queryByRole('button', { name: /resume from cursor/i }))
      .not.toBeInTheDocument()
  })

  it('says why the form opened on a profile the operator did not pick', () => {
    render(
      <RetriggerDialog
        isOpen
        onClose={() => {}}
        initialValue={baseValue}
        title="Re-trigger aggregation"
        onConfirmRetrigger={noop}
        presetReason="Pre-selected the Gentle profile: the last run hit the graph store’s per-query memory limit."
      />,
    )
    expect(screen.getByTestId('retrigger-preset-reason')).toHaveTextContent(/Gentle profile/)
  })

  it('offers a system administrator the way to the node’s per-query limit after a memory failure', async () => {
    const GB = 2 ** 30
    getSourceCapacity.mockResolvedValue({
      source: { dataSourceId: 'ds1', edgeCount: 10, bytesPerEdge: 512, bytesPerEdgeSource: 'default', footprintBytes: 5120 },
      shard: {
        endpoint: '10.0.0.1:6379', used: 2 * GB, maxmemory: 6 * GB, measurable: true, usedPct: 33, reservePct: 20,
        availableBytes: 2.8 * GB, allowedGrowthEdges: 5_000_000, governedBy: 'shard', staticCap: 25_000_000,
        queryMemCapacity: 512 * 2 ** 20, timeoutMaxMs: 180_000, threadCount: 4, sources: [],
      },
      limits: {
        shardReservePct: { value: 20, source: 'default' }, bytesPerEdge: { value: 512, source: 'default' },
        maxMaterializedEdges: { value: null, source: 'default' }, rollupStorage: { value: 'true', source: 'default' },
        estimateMarginPct: 25, maxCubeEdges: 8_000_000, staticCap: 25_000_000, budgetRecheckEdges: 1_000_000,
      },
      fullDetail: { verdict: 'unknown', marginPct: 25 },
      auto: { neverRefused: true, cubeCeiling: 8_000_000, fallback: 'diagonal' },
      measuredAt: 'x',
    })
    const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } })
    render(
      <QueryClientProvider client={qc}>
        <MemoryRouter>
          <RetriggerDialog
            isOpen
            onClose={() => {}}
            initialValue={baseValue}
            title="Re-trigger aggregation"
            dataSourceId="ds1"
            presetReason="Pre-selected the Gentle profile: the last run hit the graph store’s per-query memory limit."
            presetAction="raise-per-query-limit"
            onConfirmRetrigger={noop}
          />
        </MemoryRouter>
      </QueryClientProvider>,
    )
    const link = await screen.findByTestId('raise-per-query-limit')
    expect(link).toHaveAttribute('href', '/admin/infrastructure?limits=10.0.0.1%3A6379')
    expect(screen.getByTestId('retrigger-preset-reason')).toHaveTextContent(/Gentle profile/)
  })
})
