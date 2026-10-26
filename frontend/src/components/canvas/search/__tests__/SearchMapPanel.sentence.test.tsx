/**
 * The query card opens in the Form cards, for everyone, as it always has;
 * the Sentence is a click away, and while it shows the query the one-line
 * statement above the results would only repeat it.
 */
import { fireEvent, render, screen } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'

import { ViewSearchSessionContext } from '@/components/canvas/search/session/ViewSearchSessionContext'
import type { ViewSearchSession } from '@/components/canvas/search/session/useViewSearchSessionController'
import type { PanelView } from '@/hooks/useAdvancedSearch'
import { ProviderOverride } from '@/providers/GraphProviderContext'
import { RemoteGraphProvider } from '@/providers/RemoteGraphProvider'
import { usePersonaStore } from '@/store/persona'
import { useSearchStore } from '@/store/searchStore'
import { stubAdvanced, stubSession } from '@/test/stubSearchSession'

import { SearchMapPanel } from '../SearchMapPanel'


const RESULTS = {
    kind: 'results',
    template: {}, inputs: {}, query: {},
    result: {
        candidateCount: 1, truncated: false, deadlineExceeded: false, cacheHit: false, elapsedMs: 4,
        hits: [{ node: { urn: 'a', displayName: 'orders', entityType: 'table', properties: {} }, ancestorPath: [] }],
    },
    elapsedMs: 4,
} as unknown as PanelView

/** The one-line statement of the query, above the match bar. */
const oneLine = () => screen.queryByText((_, el) => el?.tagName === 'P'
    && el.textContent === 'Anything that is tagged #PII.')

function renderPanel(session: ViewSearchSession) {
    const provider = Object.create(RemoteGraphProvider.prototype) as RemoteGraphProvider
    render(
        <ProviderOverride value={{
            provider, isLoading: false, error: null, scopeKind: 'ready',
            workspaceId: 'ws', dataSourceId: null, providerReady: true, providerVersion: 1,
        } as never}>
            <ViewSearchSessionContext.Provider value={session}>
                <SearchMapPanel open onClose={vi.fn()} viewId="view-1" session={session.advanced}
                                onClear={session.clearQuery} />
            </ViewSearchSessionContext.Provider>
        </ProviderOverride>,
    )
}

const answered = (refineOpen: boolean) => stubSession({ refineOpen, advanced: stubAdvanced({ view: RESULTS }) })


describe('SearchMapPanel — Sentence and Form', () => {
    beforeEach(() => {
        localStorage.clear()
        usePersonaStore.setState({ mode: 'business' })
        useSearchStore.getState().clear()
        useSearchStore.getState().commitDraft({ kind: 'tag', op: 'hasAny', values: ['PII'] })
    })

    it('opens in the Form cards, with the query in one line beside them', () => {
        renderPanel(answered(true))
        expect(screen.getByRole('radio', { name: 'Form' })).toBeChecked()
        expect(screen.queryByRole('list', { name: 'The query, as a sentence' })).not.toBeInTheDocument()
        expect(oneLine()).toBeInTheDocument()
    })

    it('reads it as a sentence a click away, which states the query on its own', () => {
        renderPanel(answered(true))
        fireEvent.click(screen.getByRole('radio', { name: 'Sentence' }))
        expect(screen.getByRole('list', { name: 'The query, as a sentence' })).toBeInTheDocument()
        expect(oneLine()).not.toBeInTheDocument()
    })

    it('states it in one line with the builder folded away', () => {
        renderPanel(answered(false))
        expect(oneLine()).toBeInTheDocument()
    })

    it('opens Technical in the Form cards too', () => {
        usePersonaStore.setState({ mode: 'technical' })
        renderPanel(answered(true))
        expect(screen.getByRole('radio', { name: 'Form' })).toBeChecked()
        expect(screen.queryByRole('list', { name: 'The query, as a sentence' })).not.toBeInTheDocument()
    })
})
