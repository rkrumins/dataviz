/**
 * The query's shape drawn above its sentence: a button for what it finds
 * and for each relative, with their counts, and one for each relationship
 * — each opening its part of the sentence. Folding it away is remembered.
 */
import { fireEvent, render, screen } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'

import type { Predicate } from '@/types/search'

import type { ClauseCounts } from '../../counts/useClauseCounts'
import { buildSentence } from '../../sentence/clauseModel'
import { layoutQueryMap } from '../layoutQueryMap'
import { QueryMap } from '../QueryMap'


const draft: Predicate = { kind: 'group', op: 'and', children: [
    { kind: 'entityType', op: 'in', values: ['dataset'] },
    { kind: 'related', axis: 'downstream', maxHops: 3, where: { kind: 'group', op: 'and', children: [
        { kind: 'entityType', op: 'in', values: ['chart'] },
        { kind: 'tag', op: 'hasAny', values: ['Finance'] },
    ] } },
] }

const counts: ClauseCounts = {
    status: 'done',
    total: { count: 9, complete: true },
    clauses: [
        { alone: { count: 13, complete: true }, cumulative: null, where: null, reason: null },
        { alone: null, cumulative: null, where: { count: 0, complete: true }, reason: null },
    ],
}

function setup() {
    const onOpen = vi.fn()
    render(<QueryMap map={layoutQueryMap(buildSentence(draft))} counts={counts} onOpen={onOpen} />)
    return { onOpen }
}


describe('QueryMap', () => {
    beforeEach(() => localStorage.clear())

    it('names what the query finds and each relative, with how many there are', () => {
        setup()
        expect(screen.getByRole('button', { name: 'Change what the query finds: datasets, 9' })).toBeInTheDocument()
        expect(screen.getByRole('button', { name: /Change which relatives: chart, is tagged #Finance, 0$/ }))
            .toBeInTheDocument()
    })

    it('opens the part of the sentence a node or an edge stands for', () => {
        const { onOpen } = setup()
        fireEvent.click(screen.getByRole('button', { name: /Change which relatives/ }))
        expect(onOpen).toHaveBeenLastCalledWith('1:rel')
        fireEvent.click(screen.getByRole('button', { name: 'Change how they relate: feeds, 1–3 hops' }))
        expect(onOpen).toHaveBeenLastCalledWith('1:verb')
        fireEvent.click(screen.getByRole('button', { name: /Change what the query finds/ }))
        expect(onOpen).toHaveBeenLastCalledWith('subject:types')
    })

    it('folds away, and stays folded the next time', () => {
        const { unmount } = render(
            <QueryMap map={layoutQueryMap(buildSentence(draft))} counts={counts} onOpen={() => {}} />)
        fireEvent.click(screen.getByRole('button', { name: 'Map', expanded: true }))
        expect(screen.queryByRole('button', { name: /Change which relatives/ })).not.toBeInTheDocument()
        unmount()
        setup()
        expect(screen.getByRole('button', { name: 'Map', expanded: false })).toBeInTheDocument()
    })
})
