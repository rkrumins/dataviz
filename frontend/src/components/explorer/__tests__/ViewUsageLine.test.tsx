/**
 * The question a stranger to a view actually asks.
 *
 * Not "how many opens" — "is anyone using this, and how many different
 * people?". 340 opens by one person and 340 by twelve are the same number and
 * completely different answers, so distinct people leads and the
 * only-the-author case gets said outright.
 */
import { render, screen } from '@testing-library/react'
import { describe, expect, it } from 'vitest'

import { ViewUsageLine } from '../ViewUsageLine'
import type { ViewUsage } from '@/services/contentInsightsService'

function usage(over: Partial<ViewUsage> = {}): ViewUsage {
    return {
        viewId: 'v1', opens: 340, uniqueViewers: 12, lastOpenedAt: null,
        trend: [], windowDays: 30, lifetimeOpens: 340, onlyAuthor: false,
        yourOpens: 0, yourLastOpenedAt: null, ...over,
    }
}

describe('ViewUsageLine', () => {
    it('leads with people, not opens', () => {
        render(<ViewUsageLine usage={usage()} />)
        expect(screen.getByText(/12/)).toBeInTheDocument()
        expect(screen.getByText(/people/)).toBeInTheDocument()
        expect(screen.getByText(/340 opens/)).toBeInTheDocument()
    })

    it('says when only the author has ever opened it', () => {
        // The signal a count cannot carry: two opens by two people and two by
        // the author are both "2".
        render(<ViewUsageLine usage={usage({ opens: 2, uniqueViewers: 1, onlyAuthor: true })} />)
        expect(screen.getByText(/only its author/i)).toBeInTheDocument()
    })

    it('treats an unopened view as a finding, not an empty state', () => {
        render(<ViewUsageLine usage={usage({ opens: 0, uniqueViewers: 0 })} />)
        expect(screen.getByText(/not opened in 30 days/i)).toBeInTheDocument()
        // "0 opens" would read as a broken counter.
        expect(screen.queryByText(/0 opens/)).toBeNull()
    })

    it('flags a view your colleagues use and you never have', () => {
        render(<ViewUsageLine usage={usage()} />)
        expect(screen.getByText('New to you')).toBeInTheDocument()
    })

    it('prefers your own usage over the discovery note once you have some', () => {
        render(<ViewUsageLine usage={usage({ yourOpens: 4 })} />)
        expect(screen.getByText(/you opened it 4 times/i)).toBeInTheDocument()
        expect(screen.queryByText('New to you')).toBeNull()
    })

    it('reaches back past the window for someone who used to open it', () => {
        render(<ViewUsageLine usage={usage({
            yourOpens: 0, yourLastOpenedAt: '2025-01-01T00:00:00+00:00',
        })} />)
        expect(screen.getByText(/you last opened it/i)).toBeInTheDocument()
        // Not "new to you" — you have seen it, just not lately.
        expect(screen.queryByText('New to you')).toBeNull()
    })

    it('keeps lifetime in the tooltip, never in the headline', () => {
        // Leading with it would rank the catalogue by age.
        const { container } = render(
            <ViewUsageLine usage={usage({ opens: 12, lifetimeOpens: 4_000 })} />,
        )
        expect(screen.queryByText(/4,000/)).toBeNull()
        expect(container.querySelector('[title*="4,000 opens all time"]')).toBeTruthy()
    })

    it('renders nothing at all while usage is unknown', () => {
        // Decoration must never gate a catalogue.
        const { container } = render(<ViewUsageLine usage={undefined} />)
        expect(container).toBeEmptyDOMElement()
    })
})
