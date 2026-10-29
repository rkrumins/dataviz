/**
 * A search that failed can be run again from the error card, the query as
 * it is — without it, the only way back was to change the query.
 */
import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { describe, expect, it, vi } from 'vitest'

import { ErrorView } from '../ErrorView'


describe('ErrorView', () => {
    it('runs the search again on Try again', async () => {
        const onRetry = vi.fn()
        render(<ErrorView message="The search could not finish: Query timed out" onRetry={onRetry} />)
        expect(screen.getByText('Or refine the query above.')).toBeInTheDocument()
        await userEvent.setup().click(screen.getByRole('button', { name: 'Try again' }))
        expect(onRetry).toHaveBeenCalledTimes(1)
    })

    it('points at the query when there is nothing to retry with', () => {
        render(<ErrorView message="Unknown operator" />)
        expect(screen.queryByRole('button', { name: 'Try again' })).not.toBeInTheDocument()
        expect(screen.getByText('Refine the query above and click Run again.')).toBeInTheDocument()
    })
})
