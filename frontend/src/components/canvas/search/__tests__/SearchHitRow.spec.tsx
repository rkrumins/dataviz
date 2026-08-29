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

import { SearchHitRow } from '../SearchHitRow'


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
