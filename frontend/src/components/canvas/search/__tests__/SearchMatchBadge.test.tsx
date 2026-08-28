/**
 * The roll-up badge is a count of matches inside a subtree. While the
 * search still has pages to fetch, that count is derived only from the
 * ancestor paths of the hits that HAVE loaded — so it understates, and
 * it must say so. A number that is wrong and silent is worse than one
 * that admits it.
 */
import { render, screen } from '@testing-library/react'
import { beforeEach, describe, expect, it } from 'vitest'

import { SearchMatchBadge } from '../SearchMatchBadge'
import { useSearchStore } from '@/store/searchStore'


const BREAKDOWN = new Map([['dataset', 12]])


function publish(partial: boolean) {
    useSearchStore.getState().setResult({
        viewId: 'view-1',
        matchUrns: ['urn:a'],
        queryHash: 'q',
        source: 'quick',
        partial,
    })
}


describe('SearchMatchBadge', () => {
    beforeEach(() => { useSearchStore.getState().clear() })

    it('reads as an exact count once every page has loaded', () => {
        publish(false)
        render(<SearchMatchBadge count={12} breakdown={BREAKDOWN} schema={null} />)
        expect(screen.getByText('12')).toBeInTheDocument()
        expect(screen.queryByText('+')).toBeNull()
    })

    it('marks the count as a lower bound while pages remain', () => {
        publish(true)
        render(<SearchMatchBadge count={12} breakdown={BREAKDOWN} schema={null} />)
        expect(screen.getByLabelText(/at least 12 matches/i)).toBeInTheDocument()
    })

    it('drops the qualifier when the result set is cleared', () => {
        publish(true)
        const { rerender } = render(
            <SearchMatchBadge count={12} breakdown={BREAKDOWN} schema={null} />,
        )
        expect(screen.getByLabelText(/at least 12/i)).toBeInTheDocument()

        publish(false)
        rerender(<SearchMatchBadge count={12} breakdown={BREAKDOWN} schema={null} />)
        expect(screen.getByLabelText(/^12 matches/i)).toBeInTheDocument()
    })
})
