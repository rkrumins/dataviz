/**
 * The Query card's Cypher tab sits beside Visual and Code, and the card
 * reopens on it — the card remounts each time the Advanced drawer closes.
 * A native query's highlight is no draft's, so emptying the draft leaves
 * it lit.
 */
import { fireEvent, render, screen } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'

import { ViewSearchSessionContext } from '@/components/canvas/search/session/ViewSearchSessionContext'
import type { ViewSearchSession } from '@/components/canvas/search/session/useViewSearchSessionController'
import { ProviderOverride } from '@/providers/GraphProviderContext'
import { RemoteGraphProvider } from '@/providers/RemoteGraphProvider'
import { useSearchStore } from '@/store/searchStore'
import { stubSession } from '@/test/stubSearchSession'

import { SearchMapPanel } from '../SearchMapPanel'

vi.mock('@/components/canvas/search/panel/native/useCompiledQuery', () => ({
    useCompiledQuery: () => ({ status: 'compiling' }),
}))


function renderPanel(session: ViewSearchSession) {
    const provider = Object.create(RemoteGraphProvider.prototype) as RemoteGraphProvider
    return render(
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
    )
}


describe('SearchMapPanel — the Cypher tab', () => {
    beforeEach(() => {
        localStorage.clear()
        useSearchStore.getState().clear()
        useSearchStore.getState().seedDraftPredicate({ kind: 'entityType', op: 'in', values: ['dataset'] })
    })

    it('shows what the query compiles to, and reopens on it', () => {
        const first = renderPanel(stubSession({ refineOpen: true }))
        fireEvent.click(screen.getByRole('button', { name: 'Cypher' }))
        expect(screen.getByText('Compiling the query…')).toBeInTheDocument()
        first.unmount()

        renderPanel(stubSession({ refineOpen: true }))
        expect(screen.getByText('Compiling the query…')).toBeInTheDocument()
    })

    it.each([
        ['native:abc123', 'native:abc123'],     // a native query's highlight stays lit
        ['h1', null],                           // a search's goes with its draft
    ])('with no draft, a highlight from %s leaves %s', (published, left) => {
        useSearchStore.getState().clear()
        useSearchStore.getState().setResult({ viewId: 'view-1', matchUrns: ['urn:a'], queryHash: published })
        renderPanel(stubSession({ refineOpen: true }))
        expect(useSearchStore.getState().queryHash).toBe(left)
    })
})
