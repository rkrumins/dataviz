/**
 * HistoryMonthPicker — a year of months shaded by how busy each was; a month opens to its days. The
 * end of a month (or a day) is its last revision: it opens on the canvas, compares with now, or brings
 * the list to it. A month whose last revision is the head is Published as it is now.
 */
import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { describe, expect, it, vi } from 'vitest'
import type { HistoryMonth } from '@/services/versioningApiService'

import { HistoryMonthPicker } from '../HistoryMonthPicker'

const MONTHS: HistoryMonth[] = [
  { month: '2026-09', count: 4, firstSeq: 2, lastSeq: 5, days: [
    { day: '2026-09-02', count: 1, firstSeq: 2, lastSeq: 2 },
    { day: '2026-09-30', count: 3, firstSeq: 3, lastSeq: 5 },
  ] },
  { month: '2026-10', count: 12, firstSeq: 6, lastSeq: 17, days: [
    { day: '2026-10-31', count: 12, firstSeq: 6, lastSeq: 17 },
  ] },
]

function setup(over: Partial<React.ComponentProps<typeof HistoryMonthPicker>> = {}) {
  const props = {
    months: MONTHS, loading: false, headSeq: 17, canOpen: true,
    onOpen: vi.fn(), onCompare: vi.fn(), onJump: vi.fn(), ...over,
  }
  render(<HistoryMonthPicker {...props} />)
  return props
}

const monthName = (m: number) => new Date(2026, m - 1, 1).toLocaleDateString(undefined, { month: 'short' })

describe('HistoryMonthPicker', () => {
  it('lists a year of months with how many revisions each saw; empty ones are not offered', async () => {
    const user = userEvent.setup()
    setup()
    await user.click(screen.getByLabelText('Go to a month'))
    expect(screen.getByRole('gridcell', { name: `${monthName(10)} 2026: 12 revisions` })).toBeEnabled()
    expect(screen.getByRole('gridcell', { name: `${monthName(9)} 2026: 4 revisions` })).toBeEnabled()
    expect(screen.getByRole('gridcell', { name: `${monthName(1)} 2026: 0 revisions` })).toBeDisabled()
  })

  it("opens the end of a month — or of one of its days — and compares it with now", async () => {
    const user = userEvent.setup()
    const props = setup()
    await user.click(screen.getByLabelText('Go to a month'))
    await user.click(screen.getByRole('gridcell', { name: `${monthName(9)} 2026: 4 revisions` }))
    expect(screen.getByText(/Revision #5 · 4 revisions that month/)).toBeInTheDocument()

    await user.click(screen.getByRole('gridcell', { name: '2: 1 revision' }))
    expect(screen.getByText(/Revision #2 · 1 revision that day/)).toBeInTheDocument()
    await user.click(screen.getByText('Open on canvas'))
    expect(props.onOpen).toHaveBeenCalledWith(2)
  })

  it('says a month ending at the head is Published as it is now, and brings the list to a month', async () => {
    const user = userEvent.setup()
    const props = setup()
    await user.click(screen.getByLabelText('Go to a month'))
    await user.click(screen.getByRole('gridcell', { name: `${monthName(10)} 2026: 12 revisions` }))
    expect(screen.getByText('This is Published as it is now.')).toBeInTheDocument()
    expect(screen.getByText('Open on canvas').closest('button')).toBeDisabled()
    expect(screen.getByText('Compare with now').closest('button')).toBeDisabled()
    await user.click(screen.getByText('Show this month in the list'))
    expect(props.onJump).toHaveBeenCalledWith('2026-10')
  })
})
