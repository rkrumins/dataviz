/**
 * With the builder folded away over an answer, a new question is still
 * one line away: the Ask bar sits above the answer, and a question
 * applied there runs at once — there is no card to auto-run it.
 */
import { fireEvent, render, screen } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'

import { ViewSearchSessionContext } from '@/components/canvas/search/session/ViewSearchSessionContext'
import type { ViewSearchSession } from '@/components/canvas/search/session/useViewSearchSessionController'
import type { PanelView } from '@/hooks/useAdvancedSearch'
import { ProviderOverride } from '@/providers/GraphProviderContext'
import { RemoteGraphProvider } from '@/providers/RemoteGraphProvider'
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


describe('SearchMapPanel — asking over an answer', () => {
    beforeEach(() => {
        localStorage.clear()
        useSearchStore.getState().clear()
        useSearchStore.getState().commitDraft({ kind: 'tag', op: 'hasAny', values: ['PII'] })
    })

    it('asks from above the answer, and runs the question at once', () => {
        const advanced = stubAdvanced({ view: RESULTS })
        renderPanel(stubSession({ refineOpen: false, advanced }))
        const input = screen.getByRole('textbox', { name: 'Ask about this view' })
        fireEvent.change(input, { target: { value: 'and orders' } })
        fireEvent.keyDown(input, { key: 'Enter' })
        const tagged = { kind: 'tag', op: 'hasAny', values: ['PII'] }
        expect(useSearchStore.getState().draftPredicate).toMatchObject({ kind: 'group', op: 'and',
            children: [tagged, { kind: 'text', value: 'orders' }] })
        expect(advanced.runPredicate).toHaveBeenCalledTimes(1)
    })

    it('leaves asking to the card while the builder shows', () => {
        renderPanel(stubSession({ refineOpen: true, advanced: stubAdvanced({ view: RESULTS }) }))
        expect(screen.getAllByRole('textbox', { name: 'Ask about this view' })).toHaveLength(1)
    })
})
