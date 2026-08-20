import { render, screen, within } from '@testing-library/react'
import { describe, expect, it } from 'vitest'

import { LabelLedger } from './LabelLedger'
import type { LabelSeriesSummary } from '@/types/insights'

function label(over: Partial<LabelSeriesSummary> & { label: string }): LabelSeriesSummary {
    return {
        first: 0, last: 0, delta: 0, state: 'steady', points: [0, 0, 0], ...over,
    }
}

describe('LabelLedger', () => {
    it('floats a disappeared label above a larger numeric change', () => {
        render(<LabelLedger labels={[
            label({ label: 'Huge', first: 1000, last: 9000, delta: 8000, state: 'grew' }),
            label({ label: 'Vanished', first: 40, last: 0, delta: -40, state: 'gone' }),
        ]} />)
        const rows = screen.getAllByRole('row').slice(1) // drop the header
        expect(within(rows[0]).getByText('Vanished')).toBeInTheDocument()
    })

    it('badges only the categorical states', () => {
        render(<LabelLedger labels={[
            label({ label: 'Vanished', first: 40, last: 0, delta: -40, state: 'gone' }),
            label({ label: 'Arrived', first: 0, last: 12, delta: 12, state: 'new' }),
            label({ label: 'Bigger', first: 5, last: 9, delta: 4, state: 'grew' }),
        ]} />)
        expect(screen.getByText('Gone')).toBeInTheDocument()
        expect(screen.getByText('New')).toBeInTheDocument()
        expect(screen.queryByText('Grew')).toBeNull()
    })

    it('shows start, current and change for each label', () => {
        render(<LabelLedger labels={[
            label({ label: 'Table', first: 100, last: 130, delta: 30, state: 'grew' }),
        ]} />)
        expect(screen.getByText('100')).toBeInTheDocument()
        expect(screen.getByText('130')).toBeInTheDocument()
        expect(screen.getByText('+30')).toBeInTheDocument()
        expect(screen.getByText('+30%')).toBeInTheDocument()
    })

    it('reports an empty window rather than an empty table', () => {
        render(<LabelLedger labels={[]} />)
        expect(screen.getByText(/no entities recorded in this window/i)).toBeInTheDocument()
    })

    it('paginates a long label list', () => {
        const labels = Array.from({ length: 30 }, (_, i) =>
            label({ label: `L${i}`, first: i, last: i + 1, delta: 1, state: 'grew' }))
        render(<LabelLedger labels={labels} />)
        expect(screen.getByText('Showing 12 of 30')).toBeInTheDocument()
    })
})
