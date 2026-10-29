/**
 * The empty panel reaches every kind of filter.
 *
 * Its omnibox once carried an "All filters" link that opened the Advanced
 * drawer's Options tab — not filters at all — and the filter palette was
 * mounted only once a first filter existed. The hero now offers the
 * palette itself, and picking from it starts the query.
 */
import { fireEvent, render, screen } from '@testing-library/react'
import { MemoryRouter } from 'react-router-dom'
import { beforeEach, describe, expect, it, vi } from 'vitest'

import { ViewSearchSessionContext } from '@/components/canvas/search/session/ViewSearchSessionContext'
import type { ViewSearchSession } from '@/components/canvas/search/session/useViewSearchSessionController'
import { ProviderOverride } from '@/providers/GraphProviderContext'
import { RemoteGraphProvider } from '@/providers/RemoteGraphProvider'
import { useSearchStore } from '@/store/searchStore'
import { stubSession } from '@/test/stubSearchSession'

import { SearchMapPanel } from '../SearchMapPanel'


function renderPanel(session: ViewSearchSession) {
    const provider = Object.create(RemoteGraphProvider.prototype) as RemoteGraphProvider
    render(
        <ProviderOverride value={{
            provider, isLoading: false, error: null, scopeKind: 'ready',
            workspaceId: 'ws', dataSourceId: null,
            providerReady: true, providerVersion: 1,
        } as never}>
            <ViewSearchSessionContext.Provider value={session}>
                <SearchMapPanel
                    open
                    onClose={vi.fn()}
                    viewId="view-1"
                    session={session.advanced}
                    onClear={session.clearQuery}
                />
            </ViewSearchSessionContext.Provider>
        </ProviderOverride>,
        { wrapper: MemoryRouter },
    )
}


describe('SearchMapPanel — the empty hero offers every filter', () => {
    beforeEach(() => {
        useSearchStore.getState().clear()
    })

    it('opens the filter palette, not the Advanced drawer', () => {
        renderPanel(stubSession({ refineOpen: true }))

        expect(screen.queryByRole('button', { name: 'All filters' })).not.toBeInTheDocument()
        fireEvent.click(screen.getByRole('button', { name: 'Add filter' }))
        expect(screen.getByText('Tags & properties')).toBeInTheDocument()
        expect(screen.getByText('Graph shape')).toBeInTheDocument()
    })

    it('offers questions to try under the Ask bar, in the Form too', () => {
        localStorage.clear()
        renderPanel(stubSession({ refineOpen: true }))

        // The Form leads with the filters' search box; Ask follows it.
        expect(screen.getByRole('textbox', { name: 'Ask about this view' })).toHaveAttribute(
            'placeholder', 'Or ask in plain words…')
        expect(screen.getByText('Try')).toBeInTheDocument()
        expect(screen.getAllByRole('button', { name: /tagged|feed|with no/i }).length).toBeGreaterThan(0)
    })

    it('starts the query with the filter picked', () => {
        renderPanel(stubSession({ refineOpen: true }))

        fireEvent.click(screen.getByRole('button', { name: 'Add filter' }))
        fireEvent.click(screen.getByText('No downstream lineage'))

        const draft = useSearchStore.getState().draftPredicate
        expect(JSON.stringify(draft)).toContain('"isLeaf"')
    })
})
