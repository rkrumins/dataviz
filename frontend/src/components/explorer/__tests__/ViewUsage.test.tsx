/**
 * The question a stranger to a view actually asks.
 *
 * Not "how many opens" — "is anyone using this, and how many different
 * people?". 340 opens by one person and 340 by twelve are the same number and
 * completely different answers, so distinct people leads.
 *
 * Two forms, two registers: terse counters in the footer where a number reads
 * as a number, and a sentence only where there is something about the reader
 * worth interrupting a scan for.
 */
import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { describe, expect, it } from 'vitest'

import { ViewUsageCounters, ViewUsageDetails, ViewUsageNote } from '../ViewUsage'
import type { ViewUsage } from '@/services/contentInsightsService'

function usage(over: Partial<ViewUsage> = {}): ViewUsage {
    return {
        viewId: 'v1', opens: 340, uniqueViewers: 12, lastOpenedAt: null,
        trend: [], windowDays: 30, lifetimeOpens: 340, onlyAuthor: false,
        yourOpens: 0, yourLastOpenedAt: null, ...over,
    }
}

describe('ViewUsageCounters', () => {
    it('leads with people, not opens', () => {
        const { container } = render(<ViewUsageCounters usage={usage()} />)
        const text = container.textContent ?? ''
        expect(text.indexOf('12')).toBeLessThan(text.indexOf('340'))
    })

    it('gives EACH icon its own tooltip', async () => {
        // One shared description leaves somebody hovering the wrong half of
        // the row and learning nothing — and a bare "0 0" explains itself to
        // nobody. Hovered for real, because the reported failure was a tooltip
        // that existed in the markup and never appeared on screen.
        const user = userEvent.setup()
        render(<ViewUsageCounters usage={usage({ opens: 12, lifetimeOpens: 4_000 })} />)

        // Hovered by the icon's own screen-reader text, which is the only
        // thing that distinguishes one counter from the other.
        await user.hover(screen.getByText(/12 different people have opened/))
        expect(await screen.findByRole('tooltip'))
            .toHaveTextContent(/12 different people have opened this in the last 30 days/)
    })

    it('describes the opens icon separately from the people icon', async () => {
        const user = userEvent.setup()
        render(<ViewUsageCounters usage={usage({ opens: 12, uniqueViewers: 3, lifetimeOpens: 4_000 })} />)
        await user.hover(screen.getByText(/Opened 12 times/))
        const tip = await screen.findByRole('tooltip')
        expect(tip).toHaveTextContent(/Opened 12 times in the last 30 days/)
        expect(tip).toHaveTextContent(/4,000 opens all time/)
        expect(tip).not.toHaveTextContent(/different people/)
    })

    it('keeps the whole sentence in the tooltip, not on the card', () => {
        // As a line of prose this was the loudest text on a shelf of quiet
        // views. Beside a favourite count it reads as a counter.
        const { container } = render(
            <ViewUsageCounters usage={usage({ opens: 12, lifetimeOpens: 4_000 })} />,
        )
        // Visible text is counters; the sr-only text carries the sentence for
        // anyone who cannot hover at all.
        expect(container.querySelector('span')?.textContent).toBeTruthy()
    })

    it('shows a plain zero rather than announcing a non-event', async () => {
        const user = userEvent.setup()
        render(<ViewUsageCounters usage={usage({ opens: 0, uniqueViewers: 0 })} />)
        await user.hover(screen.getByText(/Nobody has opened this/))
        expect(await screen.findByRole('tooltip'))
            .toHaveTextContent(/Nobody has opened this in the last 30 days/)
    })

    it('says only-the-author in the tooltip, where a counter cannot', async () => {
        const user = userEvent.setup()
        render(<ViewUsageCounters usage={usage({ opens: 2, uniqueViewers: 1, onlyAuthor: true })} />)
        await user.hover(screen.getByText(/Only its author has opened this/))
        expect(await screen.findByRole('tooltip')).toHaveTextContent(/only its author/i)
    })

    it('renders nothing at all while usage is unknown', () => {
        // Decoration must never gate a catalogue.
        const { container } = render(<ViewUsageCounters usage={undefined} />)
        expect(container).toBeEmptyDOMElement()
    })
})

describe('ViewUsageNote', () => {
    it('flags a view your colleagues use and you never have', () => {
        render(<ViewUsageNote usage={usage()} />)
        expect(screen.getByText('New to you')).toBeInTheDocument()
    })

    it('says nothing once you have opened it', () => {
        // True, unsurprising, and already in the footer tooltip.
        const { container } = render(<ViewUsageNote usage={usage({ yourOpens: 4 })} />)
        expect(container).toBeEmptyDOMElement()
    })

    it('says nothing about someone who used to open it', () => {
        const { container } = render(<ViewUsageNote usage={usage({
            yourOpens: 0, yourLastOpenedAt: '2025-01-01T00:00:00+00:00',
        })} />)
        expect(container).toBeEmptyDOMElement()
    })

    it('says nothing when nobody else uses it either', () => {
        // "New to you" on a view nobody has opened is not a discovery.
        const { container } = render(<ViewUsageNote usage={usage({ opens: 0, uniqueViewers: 0 })} />)
        expect(container).toBeEmptyDOMElement()
    })

    it('says nothing when only the author has opened it', () => {
        const { container } = render(
            <ViewUsageNote usage={usage({ opens: 2, uniqueViewers: 1, onlyAuthor: true })} />,
        )
        expect(container).toBeEmptyDOMElement()
    })
})

describe('ViewUsageDetails', () => {
    it('spells out the whole picture where there is room for it', () => {
        // Somebody who opened a details panel is asking the longer question,
        // and should not have to hover four glyphs to assemble the answer.
        render(<ViewUsageDetails usage={usage({ opens: 340, uniqueViewers: 12, lifetimeOpens: 4_000 })} />)
        expect(screen.getByText(/12 different people have opened this in the last 30 days/))
            .toBeInTheDocument()
        expect(screen.getByText(/Opened 340 times in the last 30 days/)).toBeInTheDocument()
        expect(screen.getByText(/4,000 opens all time/)).toBeInTheDocument()
        expect(screen.getByText('New to you')).toBeInTheDocument()
    })

    it('says plainly when nobody has been near it', () => {
        render(<ViewUsageDetails usage={usage({ opens: 0, uniqueViewers: 0 })} />)
        expect(screen.getByText(/Nobody has opened this in the last 30 days/))
            .toBeInTheDocument()
    })

    it('renders nothing while usage is unknown', () => {
        const { container } = render(<ViewUsageDetails usage={undefined} />)
        expect(container).toBeEmptyDOMElement()
    })
})
