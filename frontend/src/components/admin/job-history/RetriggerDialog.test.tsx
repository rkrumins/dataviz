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
import userEvent from '@testing-library/user-event'
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
  // Renders the tuning it was handed, so a test can see what the dialog is
  // actually holding without reaching into the form's own controls.
  AggregationOverridesForm: ({ value }: { value?: { tuning?: unknown } }) => (
    <div data-testid="overrides-form">{JSON.stringify(value?.tuning ?? null)}</div>
  ),
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
    expect(link).toHaveAttribute('href', '/admin/graph-store?limits=10.0.0.1%3A6379')
    expect(screen.getByTestId('retrigger-preset-reason')).toHaveTextContent(/Gentle profile/)
  })
})

describe('RetriggerDialog — what "from scratch" means, and the purge option', () => {
  it('says plainly that it does not empty the store first', () => {
    render(
      <RetriggerDialog
        isOpen
        onClose={() => {}}
        initialValue={baseValue}
        title="Re-trigger aggregation"
        onConfirmRetrigger={noop}
      />,
    )

    // The words an operator reads "from scratch" as, contradicted where
    // they will see it: a refusal message is a bad place to learn this.
    const note = screen.getByTestId('retrigger-explainer')
    expect(note).toHaveTextContent(/does\s+not\s+empty/i)
    expect(note).toHaveTextContent(/only the difference is written/i)
  })

  it('offers the purge UNTICKED, and says it needs more memory rather than less', () => {
    render(
      <RetriggerDialog
        isOpen
        onClose={() => {}}
        initialValue={baseValue}
        title="Re-trigger aggregation"
        onConfirmRetrigger={noop}
      />,
    )

    const box = screen.getByTestId('retrigger-purge-first').querySelector('input')!
    expect(box).not.toBeChecked()
    // The trap this option sets: an operator who has just been refused for
    // memory reaches for "clear it all first" and makes the run need MORE.
    expect(screen.getByTestId('retrigger-purge-first'))
      .toHaveTextContent(/needs more memory, not less/i)
  })

  it('passes the choice to the parent, and the button says which it will do', async () => {
    const onConfirm = vi.fn(async () => {})
    const user = userEvent.setup()
    render(
      <RetriggerDialog
        isOpen
        onClose={() => {}}
        initialValue={baseValue}
        title="Re-trigger aggregation"
        onConfirmRetrigger={onConfirm}
      />,
    )

    await user.click(screen.getByRole('button', { name: /re-trigger from scratch/i }))
    expect(onConfirm).toHaveBeenLastCalledWith(baseValue, { purgeFirst: false })

    await user.click(screen.getByTestId('retrigger-purge-first').querySelector('input')!)
    // A destructive action must not hide behind the same label as the safe one.
    const purgeBtn = screen.getByRole('button', { name: /purge, then re-trigger/i })
    await user.click(purgeBtn)
    expect(onConfirm).toHaveBeenLastCalledWith(baseValue, { purgeFirst: true })
  })
})

describe('RetriggerDialog — putting the last run\u2019s settings back', () => {
  const lastRun = {
    ...baseValue,
    maxRetries: 1,
    tuning: { scanRangeWidth: 250_000, writePacingRatio: 0.5 },
  }

  it('offers the control and loads the run\u2019s settings on click', async () => {
    // Re-entering eleven knobs from a screenshot is its own kind of wrong
    // answer; the defaults staying the DEFAULT is why this is a button.
    render(
      <RetriggerDialog
        isOpen
        onClose={() => {}}
        initialValue={baseValue}
        previousRun={lastRun}
        title="Re-trigger aggregation"
        onConfirmRetrigger={noop}
      />,
    )

    expect(screen.getByTestId('overrides-form')).toHaveTextContent('null')
    await userEvent.click(screen.getByRole('button', { name: /use the last run/i }))
    expect(screen.getByTestId('overrides-form')).toHaveTextContent('250000')
  })

  it('says nothing when the run recorded no settings', () => {
    // A job from before the self-tuning pipeline: the control would put back
    // nothing, and an operator would be right to expect it to do something.
    render(
      <RetriggerDialog
        isOpen
        onClose={() => {}}
        initialValue={baseValue}
        previousRun={null}
        title="Re-trigger aggregation"
        onConfirmRetrigger={noop}
      />,
    )

    expect(screen.queryByTestId('retrigger-previous-run')).not.toBeInTheDocument()
  })
})
