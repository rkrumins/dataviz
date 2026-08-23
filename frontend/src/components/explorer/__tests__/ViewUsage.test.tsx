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
import { describe, expect, it } from 'vitest'

import { ViewUsageCounters, ViewUsageNote } from '../ViewUsage'
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

    it('keeps the whole sentence in the tooltip, not on the card', () => {
        // As a line of prose this was the loudest text on a shelf of quiet
        // views. Beside a favourite count it reads as a counter.
        const { container } = render(
            <ViewUsageCounters usage={usage({ opens: 12, lifetimeOpens: 4_000 })} />,
        )
        expect(container.textContent).not.toMatch(/opens by|all time/)
        const title = container.querySelector('[title]')?.getAttribute('title') ?? ''
        expect(title).toMatch(/12 opens by 12 people in the last 30 days/)
        expect(title).toMatch(/4,000 opens all time/)
    })

    it('shows a plain zero rather than announcing a non-event', () => {
        const { container } = render(<ViewUsageCounters usage={usage({ opens: 0, uniqueViewers: 0 })} />)
        expect(container.textContent).toMatch(/0/)
        expect(container.textContent).not.toMatch(/not opened/i)
        expect(container.querySelector('[title]')?.getAttribute('title'))
            .toMatch(/Not opened in the last 30 days/)
    })

    it('says only-the-author in the tooltip, where a counter cannot', () => {
        const { container } = render(
            <ViewUsageCounters usage={usage({ opens: 2, uniqueViewers: 1, onlyAuthor: true })} />,
        )
        expect(container.querySelector('[title]')?.getAttribute('title'))
            .toMatch(/only its author/i)
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
