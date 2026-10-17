/**
 * Each number on the banner must be the filter it applies, counted with the other
 * filters; and the banner must step aside for a date filter of another kind,
 * whose question it would otherwise answer wrongly.
 */
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('../api', () => ({ getViewCount: vi.fn(), getViewHistogram: vi.fn() }))

import { getViewCount } from '../api'
import { SinceLastVisitBanner } from '../components/SinceLastVisitBanner'
import { visitMark } from '../visitMark'
import { EMPTY_FILTERS, type ViewFilterState } from '../model'

const WINDOW = { from: '2026-10-09T15:00:00.000Z', to: '2026-10-12T08:00:00.000Z' }
const CTX = { currentUserId: 'u_me', today: '2026-10-12', visit: WINDOW }

function renderBanner(state: ViewFilterState) {
  const onApply = vi.fn()
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  const utils = render(
    <QueryClientProvider client={qc}>
      <SinceLastVisitBanner state={state} ctx={CTX} window={WINDOW} onApply={onApply} onMarkSeen={() => {}} />
    </QueryClientProvider>,
  )
  return { onApply, ...utils }
}

beforeEach(() => {
  vi.mocked(getViewCount).mockReset()
  vi.mocked(getViewCount).mockImplementation(params =>
    Promise.resolve({ total: params.createdAfter === WINDOW.from ? 4 : 11 }))
})

describe('SinceLastVisitBanner', () => {
  it('counts with the other filters and applies exactly what it counted', async () => {
    const { onApply } = renderBanner({ ...EMPTY_FILTERS, tags: ['pii'] })
    fireEvent.click(await screen.findByRole('button', { name: /4 new/ }))
    expect(onApply).toHaveBeenCalledWith({ ...EMPTY_FILTERS, tags: ['pii'], created: 'visit' })
    fireEvent.click(screen.getByRole('button', { name: /11 updated/ }))
    expect(onApply).toHaveBeenLastCalledWith({ ...EMPTY_FILTERS, tags: ['pii'], updated: 'visit' })
    for (const [params] of vi.mocked(getViewCount).mock.calls) expect(params.tags).toEqual(['pii'])
  })

  it('shows which count is on, and turns it off again', async () => {
    const { onApply } = renderBanner({ ...EMPTY_FILTERS, created: 'visit' })
    const on = await screen.findByRole('button', { name: /4 new/ })
    expect(on.getAttribute('aria-pressed')).toBe('true')
    fireEvent.click(on)
    expect(onApply).toHaveBeenCalledWith(EMPTY_FILTERS)
  })

  it('steps aside for another date filter', async () => {
    const { container } = renderBanner({ ...EMPTY_FILTERS, updated: '7d' })
    await waitFor(() => expect(container.textContent).toBe(''))
    expect(getViewCount).not.toHaveBeenCalled()
  })
})

describe('visitMark', () => {
  it('marks new before updated, and only inside the window', () => {
    expect(visitMark({ createdAt: '2026-10-10T09:00:00', updatedAt: '2026-10-10T09:00:00' }, WINDOW)).toBe('new')
    expect(visitMark({ createdAt: '2026-09-01T09:00:00', updatedAt: '2026-09-01T09:00:00', dataUpdatedAt: '2026-10-11T09:00:00Z' }, WINDOW)).toBe('updated')
    // Changes made during this visit are your own, not news.
    expect(visitMark({ createdAt: '2026-09-01T09:00:00', updatedAt: '2026-10-12T09:00:00Z' }, WINDOW)).toBeNull()
    expect(visitMark({ createdAt: '2026-10-10T09:00:00', updatedAt: '2026-10-10T09:00:00' }, null)).toBeNull()
  })
})
