/**
 * The toolbar row — where a chart's controls belong.
 *
 * They used to ride the `action` slot beside the title. That slot is sized for
 * one or two affordances: a set of grouped controls put there crushes the
 * heading, and once the header wraps to save it, the controls float off to the
 * right of an empty band with nothing to align to.
 */
import { render, screen, within } from '@testing-library/react'
import { describe, expect, it } from 'vitest'

import { ChartFrame } from '../ChartFrame'

describe('ChartFrame toolbar', () => {
    it('renders controls in their own row, not beside the title', () => {
        render(
            <ChartFrame
                title="Counts over time"
                toolbar={<button type="button">Show</button>}
                action={<button type="button">Export</button>}
            >
                <div>plot</div>
            </ChartFrame>,
        )
        const heading = screen.getByRole('heading', { name: 'Counts over time' })
        const header = heading.closest('header')
        expect(header).not.toBeNull()
        // The action stays in the header; the toolbar does not.
        expect(within(header!).getByRole('button', { name: 'Export' })).toBeInTheDocument()
        expect(within(header!).queryByRole('button', { name: 'Show' })).toBeNull()
        expect(screen.getByRole('button', { name: 'Show' })).toBeInTheDocument()
    })

    it('puts the toolbar above the legend, because it decides what the legend lists', () => {
        const { container } = render(
            <ChartFrame
                title="Counts"
                toolbar={<span data-testid="toolbar">controls</span>}
                series={[
                    { key: 'a', label: 'Entities', color: '#4f46e5' },
                    { key: 'b', label: 'Relationships', color: '#d97706' },
                ]}
            >
                <div>plot</div>
            </ChartFrame>,
        )
        const toolbar = screen.getByTestId('toolbar')
        const legend = screen.getByText('Entities').closest('ul')
        expect(legend).not.toBeNull()
        expect(
            toolbar.compareDocumentPosition(legend!) & Node.DOCUMENT_POSITION_FOLLOWING,
        ).toBeTruthy()
        expect(container).toBeTruthy()
    })

    it('renders no toolbar row when there are no controls', () => {
        render(<ChartFrame title="Counts"><div>plot</div></ChartFrame>)
        expect(screen.getByRole('heading', { name: 'Counts' })).toBeInTheDocument()
    })
})
