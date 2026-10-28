/**
 * A search the panel runs says where it came from: a change made from the
 * results, a query loaded from the library — each kept with the draft it
 * put in shape, for the run's telemetry.
 */
import { fireEvent, render, screen } from '@testing-library/react'
import { MemoryRouter } from 'react-router-dom'
import { beforeEach, describe, expect, it, vi } from 'vitest'

import type { PanelView } from '@/hooks/useAdvancedSearch'
import { ProviderOverride } from '@/providers/GraphProviderContext'
import { RemoteGraphProvider } from '@/providers/RemoteGraphProvider'
import { useSearchStore } from '@/store/searchStore'
import { stubAdvanced } from '@/test/stubSearchSession'
import type { Predicate } from '@/types/search'

import { SearchMapPanel } from '../SearchMapPanel'


const RESULTS = {
    kind: 'results',
    query: {},
    result: {
        candidateCount: 1, truncated: false, deadlineExceeded: false, cacheHit: false, elapsedMs: 4,
        hits: [{ node: { urn: 'a', displayName: 'orders', entityType: 'table', properties: {} }, ancestorPath: [] }],
    },
    elapsedMs: 4,
} as unknown as PanelView

/** How it matches: the routes, run. */
const ROUTES_SHOWN = {
    ...RESULTS,
    result: { candidateCount: 0, truncated: false, deadlineExceeded: false, cacheHit: false, elapsedMs: 4, paths: [] },
} as unknown as PanelView

const PII: Predicate = { kind: 'tag', op: 'hasAny', values: ['PII'] }
const ROUTES: Predicate = { kind: 'group', op: 'and', children: [PII, { kind: 'entityType', op: 'in', values: ['dataset'] }] }

function renderPanel(view: PanelView) {
    const provider = Object.create(RemoteGraphProvider.prototype) as RemoteGraphProvider
    const session = stubAdvanced({ view })
    render(
        <ProviderOverride value={{
            provider, isLoading: false, error: null, scopeKind: 'ready',
            workspaceId: 'ws', dataSourceId: null, providerReady: true, providerVersion: 1,
        } as never}>
            <SearchMapPanel open onClose={vi.fn()} viewId="view-1" session={session} />
        </ProviderOverride>,
        { wrapper: MemoryRouter },
    )
    return session
}

const source = () => useSearchStore.getState().draftSource


describe('SearchMapPanel — where a search came from', () => {
    beforeEach(() => {
        localStorage.clear()
        useSearchStore.getState().clear()
    })

    it('Back to results is a change made from the results', () => {
        useSearchStore.getState().showRoutes(ROUTES, PII)
        const session = renderPanel(ROUTES_SHOWN)

        fireEvent.click(screen.getByRole('button', { name: /Back to results/ }))

        expect(useSearchStore.getState().draftPredicate).toEqual(PII)
        expect(source()).toBe('results')
        expect(session.runPredicate).toHaveBeenCalledTimes(1)
    })

    it('a query loaded from the library says so', () => {
        useSearchStore.getState().addRecent({ viewId: 'view-1', predicate: PII, label: 'tag:PII' })
        const session = renderPanel({ kind: 'idle' } as PanelView)

        fireEvent.click(screen.getByRole('button', { name: /Library/ }))
        fireEvent.click(screen.getByTitle(/^Load:/))

        expect(useSearchStore.getState().draftPredicate).toEqual(PII)
        expect(source()).toBe('library')
        expect(session.runPredicate).toHaveBeenCalledTimes(1)
    })
})
