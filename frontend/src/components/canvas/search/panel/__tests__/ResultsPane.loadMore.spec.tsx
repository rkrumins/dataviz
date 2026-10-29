/**
 * The page after the first: a failed one says so and why, and offers the
 * page again — the list it would have extended stays as it was. It used to
 * stop silently, the button back as if nothing had been asked.
 */
import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { describe, expect, it, vi } from 'vitest'

import type { EdgeEnd, EdgeHit, SearchResultPage } from '@/types/search'

import { ResultsPane } from '../ResultsPane'


vi.mock('../counts/useCounts', () => ({
    useCounts: () => ({ counts: new Map(), status: 'done' }),
}))


function end(urn: string): EdgeEnd {
    return { urn, displayName: urn, entityType: 'dataset', parent: null, ancestorPath: [] }
}

const EDGE: EdgeHit = {
    key: 'k1', id: 'e1', edgeType: 'FEEDS', properties: {},
    source: end('urn:a'), target: end('urn:b'),
}

function pane(loadMoreError: string | null) {
    const onLoadMore = vi.fn()
    const result = {
        edges: [EDGE], edgeTypeCounts: { FEEDS: 3 }, totalCount: 3, cursor: 'next',
        elapsedMs: 1, candidateCount: 3, truncated: false, deadlineExceeded: false, cacheHit: false,
    } as unknown as SearchResultPage
    render(
        <ResultsPane
            view={{
                kind: 'results',
                query: { predicate: { kind: 'edges' } }, result, elapsedMs: 1,
            } as never}
            viewId="v1"
            onScopeToGroup={vi.fn()}
            onLoadMore={onLoadMore}
            loadMoreError={loadMoreError}
        />,
    )
    return onLoadMore
}


describe('ResultsPane — a page that failed to load', () => {
    it('says why and offers it again', async () => {
        const onLoadMore = pane('The graph is busy.')
        expect(screen.getByRole('alert')).toHaveTextContent('Couldn’t load more. The graph is busy.')
        await userEvent.setup().click(screen.getByRole('button', { name: 'Try again' }))
        expect(onLoadMore).toHaveBeenCalledTimes(1)
    })

    it('offers the next page as usual when nothing failed', () => {
        pane(null)
        expect(screen.queryByRole('alert')).not.toBeInTheDocument()
        expect(screen.getByRole('button', { name: /Load more \(1 so far\)/ })).toBeInTheDocument()
    })
})


describe('ResultsPane — a match set too large to list', () => {
    function listing(total: number, onExportAll?: () => void) {
        const onLoadAll = vi.fn()
        const result = {
            edges: [EDGE], edgeTypeCounts: { FEEDS: total }, totalCount: total, cursor: 'next',
            elapsedMs: 1, candidateCount: total, truncated: false, deadlineExceeded: false, cacheHit: false,
        } as unknown as SearchResultPage
        render(
            <ResultsPane
                view={{
                    kind: 'results',
                    query: { predicate: { kind: 'edges' } }, result, elapsedMs: 1,
                } as never}
                viewId="v1"
                onScopeToGroup={vi.fn()}
                onLoadMore={vi.fn()}
                onLoadAll={onLoadAll}
                onExportAll={onExportAll}
            />,
        )
        return onLoadAll
    }

    it('loads them all when there are few enough to list', () => {
        listing(9_000, vi.fn())
        expect(screen.getByRole('button', { name: 'Load all' })).toBeInTheDocument()
        expect(screen.queryByRole('button', { name: /^Export all/ })).not.toBeInTheDocument()
    })

    it('exports them all, in one pass, past what it lists', async () => {
        const onExportAll = vi.fn()
        listing(180_000, onExportAll)
        expect(screen.queryByRole('button', { name: 'Load all' })).not.toBeInTheDocument()
        await userEvent.setup().click(screen.getByRole('button', { name: 'Export all 180,000' }))
        expect(onExportAll).toHaveBeenCalledTimes(1)
    })

    it('offers neither past what it lists when exporting is off — Load more stays', () => {
        listing(180_000)
        expect(screen.queryByRole('button', { name: 'Load all' })).not.toBeInTheDocument()
        expect(screen.queryByRole('button', { name: /^Export all/ })).not.toBeInTheDocument()
        expect(screen.getByRole('button', { name: /^Load more/ })).toBeInTheDocument()
    })
})
