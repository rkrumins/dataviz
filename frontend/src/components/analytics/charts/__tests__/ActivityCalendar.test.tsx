/**
 * ActivityCalendar — a year, one labelled button a day, Monday-first weeks.
 */
import { fireEvent, render, screen } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'

import { ActivityCalendar } from '../ActivityCalendar'
import { calendarByMonth } from '../calendar'

function year() {
    const days: string[] = []
    const start = new Date('2025-11-25T00:00:00Z')
    for (let i = 0; i < 365; i++) {
        const d = new Date(start)
        d.setUTCDate(d.getUTCDate() + i)
        days.push(d.toISOString().slice(0, 10))
    }
    const actions = days.map((_, i) => (i % 3 === 0 ? i % 17 : 0))
    const signIns = days.map((_, i) => (i % 5 === 0 ? 1 : 0))
    return { days, actions, signIns }
}

describe('ActivityCalendar', () => {
    it('draws every day as a labelled button and reports a pick', () => {
        const { days, actions, signIns } = year()
        const onSelect = vi.fn()
        render(<ActivityCalendar days={days} actions={actions} signIns={signIns} onSelectDay={onSelect} />)
        const cells = screen.getAllByRole('button')
        expect(cells).toHaveLength(365)
        fireEvent.click(cells[364])
        expect(onSelect).toHaveBeenCalledWith(days[364])
        expect(cells[364]).toHaveAttribute('aria-label', expect.stringContaining('actions'))
    })

    it('is one tab stop, and arrow keys walk the days', () => {
        const { days, actions } = year()
        render(<ActivityCalendar days={days} actions={actions} />)
        const cells = screen.getAllByRole('button')
        expect(cells.filter((c) => c.tabIndex === 0)).toHaveLength(1)
        const last = cells[364]
        last.focus()
        fireEvent.focus(last)
        fireEvent.keyDown(last, { key: 'ArrowLeft' })
        expect(document.activeElement).toBe(cells[357])
        fireEvent.keyDown(document.activeElement!, { key: 'ArrowUp' })
        expect(document.activeElement).toBe(cells[356])
    })

    it('names the day under the pointer in words', () => {
        const { days, actions } = year()
        render(<ActivityCalendar days={days} actions={actions} />)
        fireEvent.mouseEnter(screen.getAllByRole('button')[0])
        expect(screen.getByText(/Tuesday, 25 November 2025|Tuesday, November 25, 2025/)).toBeInTheDocument()
    })

    it('shows the sign-in-only key only when sign-ins are known', () => {
        const { days, actions, signIns } = year()
        const { rerender } = render(<ActivityCalendar days={days} actions={actions} signIns={signIns} />)
        expect(screen.getByText('Signed in, did nothing')).toBeInTheDocument()
        rerender(<ActivityCalendar days={days} actions={actions} signIns={null} />)
        expect(screen.queryByText('Signed in, did nothing')).toBeNull()
    })

    it('folds the year into months for the table twin', () => {
        const m = calendarByMonth(['2026-01-30', '2026-01-31', '2026-02-01'], [2, 0, 5])
        expect(m).toEqual({ rows: ['Jan 2026', 'Feb 2026'], values: [2, 5], active: [1, 1] })
    })
})
