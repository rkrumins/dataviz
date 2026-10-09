/**
 * "Where did this match?"
 *
 * A bare word now matches the name, the path, the description, the tags
 * and every property value, so a row that shows only a name leaves the
 * user guessing why it is there. The backend answers with `highlights`;
 * the row states the field in the user's words and shows the snippet.
 */
import { render, screen } from '@testing-library/react'
import { describe, expect, it } from 'vitest'

import type { SearchHit } from '@/types/search'

import { SearchHitRow, markRanges } from '../SearchHitRow'


function hitWith(highlights: Array<{ field: string; snippet: string }>): SearchHit {
    return {
        node: {
            urn: 'a', displayName: 'orders', entityType: 'dataset', properties: {},
        },
        ancestorPath: [],
        highlights,
    } as unknown as SearchHit
}


describe('SearchHitRow — matched-in chip', () => {
    it('names the field the match landed in and shows the snippet', () => {
        render(<SearchHitRow hit={hitWith([
            { field: 'description', snippet: '…the customer ledger…' },
        ])} index={0} />)

        expect(screen.getByText('in description')).toBeInTheDocument()
        expect(screen.getByText('…the customer ledger…')).toBeInTheDocument()
    })

    it('says it in business language, not in wire spelling', () => {
        render(<SearchHitRow hit={hitWith([
            { field: 'qualifiedName', snippet: 'crm.public.customers' },
        ])} index={0} />)

        expect(screen.getByText('in path')).toBeInTheDocument()
    })

    it('unwraps a property key', () => {
        render(<SearchHitRow hit={hitWith([
            { field: 'property:owner', snippet: 'customer-ops' },
        ])} index={0} />)

        expect(screen.getByText('in property owner')).toBeInTheDocument()
    })

    it('stays silent when the backend sent no highlights', () => {
        render(<SearchHitRow hit={hitWith([])} index={0} />)

        expect(screen.queryByText(/^in /)).not.toBeInTheDocument()
    })
})


describe('markRanges', () => {
    it('leaves a snippet the server marked nothing in alone', () => {
        expect(markRanges('the customer ledger')).toEqual([
            { text: 'the customer ledger', mark: false },
        ])
        expect(markRanges('the customer ledger', [])).toEqual([
            { text: 'the customer ledger', mark: false },
        ])
    })

    it('splits the snippet around one marked span', () => {
        expect(markRanges('the customer ledger', [[4, 12]])).toEqual([
            { text: 'the ', mark: false },
            { text: 'customer', mark: true },
            { text: ' ledger', mark: false },
        ])
    })

    it('marks a span that starts at the first character and one that ends at the last', () => {
        expect(markRanges('orders', [[0, 6]])).toEqual([{ text: 'orders', mark: true }])
        expect(markRanges('daily orders', [[6, 12]])).toEqual([
            { text: 'daily ', mark: false },
            { text: 'orders', mark: true },
        ])
    })

    it('takes the ranges in whatever order they arrive', () => {
        expect(markRanges('a b c', [[4, 5], [0, 1]])).toEqual([
            { text: 'a', mark: true },
            { text: ' b ', mark: false },
            { text: 'c', mark: true },
        ])
    })

    // Belt and braces on a wire value: a range that overlapped the one
    // before it, or ran off the end, would otherwise duplicate or drop
    // characters — and the snippet is text the user reads.
    it('never duplicates or drops a character, whatever the ranges say', () => {
        expect(markRanges('orders', [[0, 4], [2, 6]]).map((p) => p.text).join(''))
            .toBe('orders')
        expect(markRanges('orders', [[3, 99]])).toEqual([
            { text: 'ord', mark: false },
            { text: 'ers', mark: true },
        ])
        expect(markRanges('orders', [[-2, 3]])).toEqual([
            { text: 'ord', mark: true },
            { text: 'ers', mark: false },
        ])
        expect(markRanges('orders', [[4, 4]])).toEqual([
            { text: 'orders', mark: false },
        ])
    })
})


describe('SearchHitRow — where the words landed', () => {
    it('marks the searched word inside the snippet, where the server pointed', () => {
        const { container } = render(<SearchHitRow hit={hitWith([
            { field: 'description', snippet: 'the customer ledger', ranges: [[4, 12]] },
        ] as never)} index={0} />)

        expect(container.querySelector('mark')?.textContent).toBe('customer')
    })

    it('marks the searched word inside the name when the caller says what it was', () => {
        const { container } = render(
            <SearchHitRow hit={hitWith([])} index={0} query="ord" />,
        )

        expect(container.querySelector('mark')?.textContent).toBe('ord')
    })

    it('leaves the name alone when nobody said what was searched', () => {
        const { container } = render(<SearchHitRow hit={hitWith([])} index={0} />)

        expect(container.querySelector('mark')).toBeNull()
        expect(screen.getByText('orders')).toBeInTheDocument()
    })
})
