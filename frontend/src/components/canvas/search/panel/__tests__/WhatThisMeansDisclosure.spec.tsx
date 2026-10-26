/**
 * WhatThisMeansDisclosure — verifies the source of the predicate it
 * summarises: the optional ``predicate`` prop (store-decoupled, used by
 * VisualQueryBuilder) takes precedence; when omitted it falls back to the
 * singleton ``draftPredicate`` so the live Advanced-Search panel keeps
 * working with zero-arg call sites. A relationship's or a route end's
 * nested builder doesn't repeat it.
 */
import { render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it } from 'vitest'

import { useSearchStore } from '@/store/searchStore'
import type { Predicate } from '@/types/search'

import { RelationContext } from '../relationContext'
import { WhatThisMeansDisclosure } from '../WhatThisMeansDisclosure'


const twoFilterAnd: Predicate = {
    kind: 'group', op: 'and', children: [
        { kind: 'tag', op: 'hasAny', values: ['PII'] },
        { kind: 'entityType', op: 'in', values: ['dataset'] },
    ],
}

afterEach(() => {
    useSearchStore.setState({ draftPredicate: null })
})


describe('WhatThisMeansDisclosure', () => {
    it('summarises the predicate passed via prop (ignores the store)', () => {
        // Store draft is null, but the prop carries a 2-filter AND.
        useSearchStore.setState({ draftPredicate: null })
        render(<WhatThisMeansDisclosure predicate={twoFilterAnd} />)
        expect(screen.getByText(/Matches all of 2 filters/i)).toBeInTheDocument()
    })

    it('falls back to the store draft when no prop is given', () => {
        useSearchStore.setState({ draftPredicate: twoFilterAnd })
        render(<WhatThisMeansDisclosure />)
        expect(screen.getByText(/Matches all of 2 filters/i)).toBeInTheDocument()
    })

    it('shows the empty hint when prop is null even if the store has a draft', () => {
        useSearchStore.setState({ draftPredicate: twoFilterAnd })
        render(<WhatThisMeansDisclosure predicate={null} />)
        expect(screen.getByText(/No filters yet/i)).toBeInTheDocument()
    })

    it('stays out of a nested condition, which the query’s own disclosure reads', () => {
        const { container } = render(
            <RelationContext.Provider value={{ depth: 1, rule: false, viewId: 'v1' }}>
                <WhatThisMeansDisclosure predicate={twoFilterAnd} />
            </RelationContext.Provider>,
        )
        expect(container).toBeEmptyDOMElement()
    })
})
