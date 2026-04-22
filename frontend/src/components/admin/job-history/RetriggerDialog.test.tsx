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
import { describe, expect, it, vi } from 'vitest'
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
})
