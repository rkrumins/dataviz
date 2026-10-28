/**
 * A Connections search in the panel: Find switches between entities and
 * the connections between them, as one undo step each way, and says what
 * the switch left out; the answer is the edges, counted as connections; a
 * display rule can't be made of it, and with the builder folded away
 * there's no Ask bar to add an entity condition to it.
 */
import { fireEvent, render, screen } from '@testing-library/react'
import { MemoryRouter } from 'react-router-dom'
import { beforeEach, describe, expect, it, vi } from 'vitest'

import { ViewSearchSessionContext } from '@/components/canvas/search/session/ViewSearchSessionContext'
import type { PanelView } from '@/hooks/useAdvancedSearch'
import { ProviderOverride } from '@/providers/GraphProviderContext'
import { RemoteGraphProvider } from '@/providers/RemoteGraphProvider'
import { useSearchStore } from '@/store/searchStore'
import { useViewLibraryStore } from '@/store/viewLibraryStore'
import type { EdgesPredicate, Predicate } from '@/types/search'
import { stubAdvanced, stubSession } from '@/test/stubSearchSession'

import { NO_RULE_FOR_CONNECTIONS } from '../panel/findMode'
import { SearchMapPanel } from '../SearchMapPanel'


vi.mock('@/hooks/usePropertyCatalog', () => ({
    usePropertyCatalog: () => ({
        catalog: null, reading: null, error: null, unavailable: true, refresh: vi.fn(),
    }),
}))

const DATASETS: Predicate = { kind: 'entityType', op: 'in', values: ['dataset'] }
const PII: Predicate = { kind: 'tag', op: 'hasAny', values: ['PII'] }
const BOTH: Predicate = { kind: 'group', op: 'and', children: [DATASETS, PII] }
const EDGES: EdgesPredicate = { kind: 'edges', sourceWhere: PII }

const CONNECTIONS = {
    kind: 'results', template: {}, inputs: {},
    query: { predicate: EDGES, scope: { viewId: 'view-1' }, options: { results: 'edges' } },
    result: {
        candidateCount: 1, totalCount: 1, truncated: false, deadlineExceeded: false, cacheHit: false, elapsedMs: 4,
        hits: [], edgeTypeCounts: { TRANSFORMS: 1 },
        edges: [{
            key: 'k1', id: 'e1', edgeType: 'TRANSFORMS', properties: {},
            source: { urn: 'urn:amount', displayName: 'amount', entityType: 'schemaField', parent: null, ancestorPath: [] },
            target: { urn: 'urn:amount_usd', displayName: 'amount_usd', entityType: 'schemaField', parent: null,
                ancestorPath: [] },
        }],
    },
    elapsedMs: 4,
} as unknown as PanelView

function renderPanel({ view, refineOpen = true }: { view?: PanelView; refineOpen?: boolean } = {}) {
    const advanced = stubAdvanced(view ? { view } : {})
    const session = stubSession({ refineOpen, advanced })
    const provider = Object.create(RemoteGraphProvider.prototype) as RemoteGraphProvider
    render(
        <ProviderOverride value={{
            provider, isLoading: false, error: null, scopeKind: 'ready',
            workspaceId: 'ws', dataSourceId: null, providerReady: true, providerVersion: 1,
        } as never}>
            <ViewSearchSessionContext.Provider value={session}>
                <SearchMapPanel open onClose={vi.fn()} viewId="view-1" session={advanced} onClear={session.clearQuery} />
            </ViewSearchSessionContext.Provider>
        </ProviderOverride>,
        { wrapper: MemoryRouter },
    )
    return advanced
}

const draft = () => useSearchStore.getState().draftPredicate


describe('SearchMapPanel — Connections', () => {
    beforeEach(() => {
        localStorage.clear()
        useSearchStore.getState().clear()
        useViewLibraryStore.setState({ viewId: null, branchId: null, canEdit: false })
    })

    it('finds the connections from what the query finds, and back, each switch one undo step', () => {
        useSearchStore.getState().commitDraft(BOTH)
        renderPanel()

        fireEvent.click(screen.getByRole('radio', { name: 'Connections' }))
        expect(draft()).toEqual({ kind: 'edges', sourceWhere: BOTH })
        expect(screen.getByRole('region', { name: 'From' })).toBeInTheDocument()
        expect(screen.getByRole('region', { name: 'To' })).toBeInTheDocument()

        fireEvent.click(screen.getByRole('radio', { name: 'Entities' }))
        expect(draft()).toEqual(BOTH)
        expect(screen.queryByRole('region', { name: 'From' })).not.toBeInTheDocument()

        useSearchStore.getState().undo()
        expect(draft()).toEqual({ kind: 'edges', sourceWhere: BOTH })
        useSearchStore.getState().undo()
        expect(draft()).toEqual(BOTH)
    })

    it('says what the switch left out, and stops saying it once the query changes', () => {
        useSearchStore.getState().commitDraft({ kind: 'group', op: 'and', children: [
            DATASETS, { kind: 'withinHops', urns: ['urn:a'], hops: 2 }] })
        renderPanel()

        fireEvent.click(screen.getByRole('radio', { name: 'Connections' }))
        expect(draft()).toEqual({ kind: 'edges', sourceWhere: DATASETS })
        expect(screen.getByRole('status')).toHaveTextContent(
            'Left out: “within N hops” — a connection is one edge. Undo brings it back.')

        fireEvent.click(screen.getByRole('radio', { name: 'Either way' }))
        expect(screen.queryByText(/Left out:/)).not.toBeInTheDocument()
    })

    it('answers with the edges, counted as connections, and makes no display rule of them', () => {
        // Someone who could make a rule of an entity search.
        useViewLibraryStore.setState({ viewId: 'view-1', branchId: null, canEdit: true })
        useSearchStore.getState().commitDraft(EDGES)
        renderPanel({ view: CONNECTIONS })

        expect(screen.getByText('amount_usd')).toBeInTheDocument()
        expect(screen.getByText('1 connection')).toBeInTheDocument()
        const rule = screen.getByRole('button', { name: 'Create display rule' })
        expect(rule).toBeDisabled()
        expect(rule).toHaveAttribute('title', NO_RULE_FOR_CONNECTIONS)
    })

    it('states the connections with the builder folded, offering no Ask bar to add to them', () => {
        useSearchStore.getState().commitDraft(EDGES)
        renderPanel({ view: CONNECTIONS, refineOpen: false })

        expect(screen.queryByRole('textbox', { name: 'Ask about this view' })).not.toBeInTheDocument()
        expect(screen.getByText((_, el) => el?.tagName === 'P' && /^Connections from/.test(el.textContent ?? '')))
            .toBeInTheDocument()
    })
})
