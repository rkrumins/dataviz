/**
 * PropertyValueChips — the premium value/entity-type chips: capped display
 * with an inline "+N" that expands to reveal the rest, and a `title`
 * tooltip on each value.
 */
import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { describe, it, expect } from 'vitest'

import { EntityTypeChips, SampleValueChips } from '../PropertyValueChips'


describe('SampleValueChips', () => {
    const values = ['balance', 'city', 'country', 'currency', 'date', 'decimal']

    it('caps at `max` and shows a "+N" pill', () => {
        render(<SampleValueChips values={values} max={4} />)
        expect(screen.getByText('balance')).toBeInTheDocument()
        expect(screen.getByText('currency')).toBeInTheDocument()
        // 5th/6th hidden until expanded.
        expect(screen.queryByText('date')).not.toBeInTheDocument()
        expect(screen.getByRole('button', { name: '+2' })).toBeInTheDocument()
    })

    it('expands inline to reveal all values, then collapses', async () => {
        const user = userEvent.setup()
        render(<SampleValueChips values={values} max={4} />)
        await user.click(screen.getByRole('button', { name: '+2' }))
        expect(screen.getByText('date')).toBeInTheDocument()
        expect(screen.getByText('decimal')).toBeInTheDocument()
        await user.click(screen.getByRole('button', { name: /show less/i }))
        expect(screen.queryByText('date')).not.toBeInTheDocument()
    })

    it('puts the full value in a title for truncation', () => {
        render(<SampleValueChips values={['a-very-long-sample-value']} />)
        expect(screen.getByTitle('a-very-long-sample-value')).toBeInTheDocument()
    })

    it('renders nothing when there are no values', () => {
        const { container } = render(<SampleValueChips values={[]} />)
        expect(container).toBeEmptyDOMElement()
    })
})


describe('EntityTypeChips', () => {
    it('caps at `max` and shows a "+N" overflow count', () => {
        render(<EntityTypeChips types={['dataset', 'container', 'report', 'dashboard']} max={2} />)
        expect(screen.getByText('dataset')).toBeInTheDocument()
        expect(screen.getByText('container')).toBeInTheDocument()
        expect(screen.queryByText('report')).not.toBeInTheDocument()
        expect(screen.getByText('+2')).toBeInTheDocument()
    })
})
