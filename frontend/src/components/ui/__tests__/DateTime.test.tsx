/**
 * An instant, readable at a glance and exact on hover: the label fits its
 * age, the hover card has the local time, UTC and ISO, and the tile for a
 * detail view puts the ISO form one click from the clipboard.
 */
import { act, fireEvent, render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, describe, expect, it, vi } from 'vitest'

import { DateTime, DateTimeTile } from '../DateTime'

afterEach(() => { vi.useRealTimers() })

async function hover(el: Element) {
    fireEvent.mouseEnter(el.parentElement!)
    await act(async () => { await new Promise((r) => setTimeout(r, 80)) })
}

describe('DateTime', () => {
    it('labels a recent instant by how recent, and spells it out on hover', async () => {
        const at = new Date(Date.now() - 12 * 60_000).toISOString()
        render(<DateTime at={at} />)
        const time = screen.getByText('12 min ago')
        expect(time.tagName).toBe('TIME')
        expect(time).toHaveAttribute('dateTime', at)

        await hover(time)
        const tip = screen.getByRole('tooltip')
        expect(tip).toHaveTextContent(/12 minutes ago/i)
        expect(tip).toHaveTextContent('Local')
        expect(tip).toHaveTextContent('UTC')
        expect(tip).toHaveTextContent(at)
    })

    it('reads a timestamp without a zone as UTC, as the server means it', () => {
        render(<DateTime at="2026-10-12T08:41:07" />)
        expect(document.querySelector('time')).toHaveAttribute('dateTime', '2026-10-12T08:41:07.000Z')
    })

    it('drops the day in a list grouped by day', () => {
        vi.useFakeTimers({ now: new Date(2026, 9, 12, 15, 0) })
        const morning = new Date(2026, 9, 12, 9, 41)
        render(<DateTime at={morning.toISOString()} variant="clock" />)
        const clock = new Intl.DateTimeFormat(undefined, { hour: '2-digit', minute: '2-digit' }).format(morning)
        expect(document.querySelector('time')).toHaveTextContent(new RegExp(`^${clock}$`))
    })

    it('says nothing it does not know', () => {
        render(<DateTime at={null} prefix="Started " />)
        expect(screen.getByText('—')).toBeInTheDocument()
        expect(screen.queryByText(/Started/)).not.toBeInTheDocument()
    })

    it('moves with the shared clock', () => {
        vi.useFakeTimers({ now: new Date('2026-10-12T12:00:00Z') })
        render(<DateTime at="2026-10-12T11:59:50Z" />)
        expect(screen.getByText('just now')).toBeInTheDocument()
        act(() => { vi.advanceTimersByTime(5 * 60_000) })
        expect(screen.getByText('5 min ago')).toBeInTheDocument()
    })
})

describe('DateTimeTile', () => {
    it('shows the time large, with its zone, date, UTC — and copies the ISO form', async () => {
        const writeText = vi.fn().mockResolvedValue(undefined)
        Object.defineProperty(navigator, 'clipboard', { value: { writeText }, configurable: true })
        const at = '2026-10-12T08:41:07.000Z'
        render(<DateTimeTile at={at} label="When" footnote="Reached the log 3 min later" />)

        expect(screen.getByText('When')).toBeInTheDocument()
        expect(screen.getByText(/08:41:07 UTC/)).toBeInTheDocument()
        expect(screen.getByText('Reached the log 3 min later')).toBeInTheDocument()
        await userEvent.click(screen.getByRole('button', { name: 'Copy when as ISO 8601' }))
        expect(writeText).toHaveBeenCalledWith(at)
        expect(await screen.findByRole('button', { name: 'Copy when as ISO 8601: copied' })).toBeInTheDocument()
    })

    it('holds its place when there is no instant', () => {
        render(<DateTimeTile at={undefined} label="Finished" />)
        expect(screen.getByText('Finished')).toBeInTheDocument()
        expect(screen.getByText('—')).toBeInTheDocument()
        expect(screen.queryByRole('button')).not.toBeInTheDocument()
    })
})
