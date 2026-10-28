/**
 * The routes "How it matches" shows offer the way back: Back to results
 * runs the query whose results they explain again — for as long as the
 * routes are the query.
 */
import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { beforeEach, describe, expect, it, vi } from 'vitest'

import { useSearchStore } from '@/store/searchStore'
import type { PathHit, Predicate, SearchResultPage } from '@/types/search'

import { ResultsPane } from '../ResultsPane'


vi.mock('../counts/useCounts', () => ({
    useCounts: () => ({ counts: new Map(), status: 'done' }),
}))

const DASHBOARDS: Predicate = { kind: 'entityType', op: 'in', values: ['dashboard'] }
const FROM: Predicate = { kind: 'related', axis: 'downstream', where: DASHBOARDS }
const ROUTES: Predicate = {
    kind: 'path', sourceUrns: ['urn:a'], targetUrns: [], direction: 'outgoing', targetWhere: DASHBOARDS,
}
const PATH: PathHit = {
    hopCount: 1,
    nodes: [{ urn: 'urn:a', displayName: 'orders', entityType: 'dataset' },
        { urn: 'urn:b', displayName: 'Revenue', entityType: 'dashboard' }],
    edges: [{ edgeType: 'FEEDS', sourceUrn: 'urn:a', targetUrn: 'urn:b' }],
} as unknown as PathHit

function pane(draft: Predicate) {
    const onRefine = vi.fn()
    const result = {
        paths: [PATH], hits: [], elapsedMs: 1, candidateCount: 1, truncated: false,
        deadlineExceeded: false, cacheHit: false,
    } as unknown as SearchResultPage
    render(
        <ResultsPane
            view={{
                kind: 'results',
                query: { predicate: ROUTES }, result, elapsedMs: 1,
            } as never}
            viewId="v1"
            onScopeToGroup={vi.fn()}
            draft={draft}
            onRefine={onRefine}
        />,
    )
    return onRefine
}


describe('ResultsPane — the routes How it matches showed', () => {
    beforeEach(() => {
        useSearchStore.getState().clear()
        useSearchStore.setState({ routesFrom: { routes: ROUTES, from: FROM } })
    })

    it('goes back to the results they explain', async () => {
        const onRefine = pane(ROUTES)
        expect(screen.getByText('Revenue')).toBeInTheDocument()
        await userEvent.setup().click(screen.getByRole('button', { name: 'Back to results' }))
        expect(onRefine).toHaveBeenCalledWith(FROM)
    })

    it('offers no way back once the routes are no longer the query', () => {
        pane({ ...ROUTES, maxHops: 2 } as Predicate)
        expect(screen.queryByRole('button', { name: 'Back to results' })).not.toBeInTheDocument()
    })
})
