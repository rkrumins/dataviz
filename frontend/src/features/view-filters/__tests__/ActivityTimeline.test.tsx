/**
 * The activity strip is a way to pick dates, so what it writes is a date rule —
 * the same one the Date menu would — and the keyboard must reach everything the
 * pointer can. It counts with every filter except its own field's rule, or picking
 * a range would blank out the rest of the strip.
 */
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('../api', () => ({ getViewHistogram: vi.fn(), getViewCount: vi.fn() }))

import { getViewHistogram } from '../api'
import { ActivityTimeline } from '../components/ActivityTimeline'
import { EMPTY_FILTERS, type ViewFilterState } from '../model'

const TODAY = '2026-10-12'
const CTX = { currentUserId: 'u_me', today: TODAY }

/** A UTC hour bucket inside a LOCAL day, so the fold lands on that day in any zone. */
const bucket = (month: number, day: number, n: number) => ({
  t: new Date(2026, month - 1, day, 12).toISOString().slice(0, 13), n,
})

function renderTimeline(state: ViewFilterState = EMPTY_FILTERS) {
  const onSelectRule = vi.fn()
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  render(
    <QueryClientProvider client={qc}>
      <ActivityTimeline
        field="updated"
        onFieldChange={() => {}}
        state={state}
        ctx={CTX}
        onSelectRule={onSelectRule}
        collapsed={false}
        onCollapsedChange={() => {}}
      />
    </QueryClientProvider>,
  )
  return { onSelectRule, chart: screen.getByRole('group', { name: /Views updated each day/ }) }
}

beforeEach(() => {
  vi.mocked(getViewHistogram).mockReset()
  vi.mocked(getViewHistogram).mockResolvedValue({
    field: 'updated', grain: 'hour', after: '', before: '', total: 5,
    buckets: [bucket(10, 12, 2), bucket(10, 11, 3)],
  })
})

describe('ActivityTimeline', () => {
  it('totals the window, counted without its own rule', async () => {
    renderTimeline({ ...EMPTY_FILTERS, updated: '30d', tags: ['pii'] })
    await waitFor(() => expect(screen.getByText(/updated · Past 30 days/)).toBeTruthy())
    const [window, params] = vi.mocked(getViewHistogram).mock.calls[0]
    expect(window.field).toBe('updated')
    expect(params.updatedAfter).toBeUndefined()
    expect(params.tags).toEqual(['pii'])
  })

  it('reads the day under the cursor and applies it on Enter', async () => {
    const { chart, onSelectRule } = renderTimeline()
    await screen.findByText(/in the past 90 days/)
    fireEvent.focus(chart)
    fireEvent.keyDown(chart, { key: 'ArrowLeft' })
    expect(document.querySelector('[aria-live="polite"].sr-only')!.textContent).toMatch(/: 3 views updated$/)
    fireEvent.keyDown(chart, { key: 'Enter' })
    expect(onSelectRule).toHaveBeenCalledWith('2026-10-11')
  })

  it('extends a range with Shift and lets go of a rule on Escape', async () => {
    const { chart, onSelectRule } = renderTimeline({ ...EMPTY_FILTERS, updated: '7d' })
    await screen.findByText(/updated · Past 7 days/)
    fireEvent.focus(chart)
    fireEvent.keyDown(chart, { key: 'ArrowLeft', shiftKey: true })
    fireEvent.keyDown(chart, { key: 'ArrowLeft', shiftKey: true })
    fireEvent.keyDown(chart, { key: 'Enter' })
    expect(onSelectRule).toHaveBeenLastCalledWith('2026-10-10..2026-10-12')
    fireEvent.keyDown(chart, { key: 'Escape' })
    expect(onSelectRule).toHaveBeenLastCalledWith(null)
  })

  it('offers a retry when the counts fail', async () => {
    vi.mocked(getViewHistogram).mockRejectedValue(new Error('boom'))
    renderTimeline()
    expect(await screen.findByText(/Couldn.t load the activity/)).toBeTruthy()
    expect(screen.getByRole('button', { name: /Try again/ })).toBeTruthy()
  })
})
