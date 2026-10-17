/**
 * The Date menu edits two independent rules — created and updated — through one
 * switch. These pin what a click writes, because the rule is what a bookmark or a
 * saved filter keeps: a preset must store the RULE ("7d"), switching the clock must
 * carry a lone rule across, and the menu must give its keys back on Escape.
 */
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { beforeAll, describe, expect, it, vi } from 'vitest'

vi.mock('../api', () => ({ getViewHistogram: vi.fn(), getViewCount: vi.fn() }))

import { getViewCount, getViewHistogram } from '../api'
import { DateFilterMenu } from '../components/DateFilterMenu'
import { EMPTY_FILTERS } from '../model'

// The calendar asks `matchMedia` whether there's room for two months; jsdom has none.
beforeAll(() => {
  window.matchMedia = window.matchMedia ?? (((query: string) => ({
    matches: false, media: query, onchange: null,
    addEventListener: () => {}, removeEventListener: () => {},
    addListener: () => {}, removeListener: () => {}, dispatchEvent: () => false,
  })) as unknown as typeof window.matchMedia)
})

const TODAY = '2026-10-12'

function setup(props: Partial<React.ComponentProps<typeof DateFilterMenu>> = {}) {
  const onChange = vi.fn()
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  const utils = render(
    <QueryClientProvider client={qc}>
      <DateFilterMenu created={null} updated={null} onChange={onChange} today={TODAY} {...props} />
    </QueryClientProvider>,
  )
  return { onChange, ...utils }
}

/** A UTC hour bucket inside a LOCAL day, so the fold lands on that day in any zone. */
const bucket = (month: number, day: number, n: number) => ({
  t: new Date(2026, month - 1, day, 12).toISOString().slice(0, 13), n,
})

describe('DateFilterMenu', () => {
  it('stores a preset as its rule, on the Updated clock by default, and closes', async () => {
    const user = userEvent.setup()
    const { onChange } = setup()
    await user.click(screen.getByRole('button', { name: /date/i }))
    await user.click(screen.getByRole('button', { name: 'Past 7 days' }))
    expect(onChange).toHaveBeenCalledWith({ updated: '7d' })
    expect(screen.queryByRole('dialog', { name: 'Filter by date' })).toBeNull()
  })

  it('names the active rule on the trigger', () => {
    setup({ updated: '7d' })
    expect(screen.getByRole('button', { name: /Updated · Past 7 days/ })).toBeTruthy()
  })

  it('carries a lone rule across when the clock is switched', async () => {
    const user = userEvent.setup()
    const { onChange } = setup({ updated: '30d' })
    await user.click(screen.getByRole('button', { name: /Updated · Past 30 days/ }))
    await user.click(screen.getByRole('radio', { name: 'Created' }))
    expect(onChange).toHaveBeenCalledWith({ updated: null, created: '30d' })
  })

  it('applies any number of past days', async () => {
    const user = userEvent.setup()
    const { onChange } = setup()
    await user.click(screen.getByRole('button', { name: /date/i }))
    await user.type(screen.getByLabelText('Past'), '14')
    await user.click(screen.getByRole('button', { name: 'Apply' }))
    expect(onChange).toHaveBeenCalledWith({ updated: '14d' })
  })

  it('applies a range picked on the calendar, both ends included', async () => {
    const user = userEvent.setup()
    const { onChange, container } = setup()
    await user.click(screen.getByRole('button', { name: /date/i }))
    await user.click(screen.getByRole('button', { name: /Custom range/ }))
    fireEvent.click(container.querySelector('[data-day="2026-10-01"]')!)
    fireEvent.click(container.querySelector('[data-day="2026-10-05"]')!)
    expect(screen.getByText(/5 days/)).toBeTruthy()
    await user.click(screen.getByRole('button', { name: /Apply range/ }))
    expect(onChange).toHaveBeenCalledWith({ updated: '2026-10-01..2026-10-05' })
  })

  it('warns that Recent already limits creation dates', async () => {
    const user = userEvent.setup()
    setup({ created: '30d', recentActive: true })
    await user.click(screen.getByRole('button', { name: /Created · Past 30 days/ }))
    expect(screen.getByText(/Recent already limits/)).toBeTruthy()
  })

  it('closes on Escape and hands focus back to the trigger', async () => {
    const user = userEvent.setup()
    setup()
    const trigger = screen.getByRole('button', { name: /date/i })
    await user.click(trigger)
    await user.keyboard('{Escape}')
    expect(screen.queryByRole('dialog', { name: 'Filter by date' })).toBeNull()
    expect(document.activeElement).toBe(trigger)
  })

  it('counts each preset without its own rule, and asks separately for the older ones', async () => {
    vi.mocked(getViewHistogram).mockResolvedValue({
      field: 'updated', grain: 'hour', after: '', before: '', total: 9,
      buckets: [bucket(10, 12, 2), bucket(10, 10, 3), bucket(8, 1, 4)],
    })
    vi.mocked(getViewCount).mockResolvedValue({ total: 42 })
    const user = userEvent.setup()
    setup({
      updated: '7d',
      counting: { state: { ...EMPTY_FILTERS, updated: '7d', tags: ['pii'] }, ctx: { currentUserId: 'u_me', today: TODAY } },
    })
    await user.click(screen.getByRole('button', { name: /Updated · Past 7 days/ }))
    const preset = (label: string) => screen.getByText(label).closest('button')!.textContent
    await waitFor(() => expect(preset('Today')).toBe('Today2'))
    expect(preset('Past 7 days')).toBe('Past 7 days5')
    expect(preset('Past 90 days')).toBe('Past 90 days9')
    await waitFor(() => expect(preset('This year')).toBe('This year42'))

    const [, params] = vi.mocked(getViewHistogram).mock.calls[0]
    expect(params.updatedAfter).toBeUndefined()
    expect(params.tags).toEqual(['pii'])

    // The calendar shades the same days.
    await user.click(screen.getByRole('button', { name: /Custom range/ }))
    expect(screen.getByRole('button', { name: /October 10, 2026, 3 views updated/ })).toBeTruthy()
  })
})
