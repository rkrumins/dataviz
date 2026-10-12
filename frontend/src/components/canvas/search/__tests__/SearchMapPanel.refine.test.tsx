/**
 * The builder is a MODE the session holds, not something the panel
 * derives from whether results happen to be on screen.
 *
 * Deriving it was a live bug: on a cold open the builder showed only
 * because there was no results section yet, so the first value the user
 * typed auto-ran 250 ms later, the view turned to 'running', and the card
 * they were typing in unmounted mid-word. `showBuilder` therefore reads
 * `session.refineOpen` and nothing else — the session decides at OPEN
 * time whether there is an answer to open on.
 */
import { render, screen } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'

import { ViewSearchSessionContext } from '@/components/canvas/search/session/ViewSearchSessionContext'
import type { ViewSearchSession } from '@/components/canvas/search/session/useViewSearchSessionController'
import type { PanelView } from '@/hooks/useAdvancedSearch'
import { ProviderOverride } from '@/providers/GraphProviderContext'
import { RemoteGraphProvider } from '@/providers/RemoteGraphProvider'
import { useSearchStore } from '@/store/searchStore'
import { stubAdvanced, stubSession } from '@/test/stubSearchSession'

import { SearchMapPanel } from '../SearchMapPanel'


/** QueryCard's "New query" control. It sits in the card's footer, which
 *  the card only paints once there is a draft to act on — hence the
 *  committed draft below, which is also the real state: the session
 *  commits the very predicate it dispatches. */
const BUILDER = { name: 'New query' }

const RESULTS = {
    kind: 'results',
    template: {}, inputs: {}, query: {},
    result: {
        candidateCount: 1, truncated: false, deadlineExceeded: false,
        cacheHit: false, elapsedMs: 4,
        hits: [{
            node: { urn: 'a', displayName: 'orders', entityType: 'table', properties: {} },
            ancestorPath: [],
        }],
    },
    elapsedMs: 4,
} as unknown as PanelView


function renderPanel(session: ViewSearchSession) {
    // `instanceof RemoteGraphProvider` gates the panel's own calls, so the
    // stub carries the real prototype.
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
    )
}


describe('SearchMapPanel — the builder follows Refine, not the results', () => {
    beforeEach(() => {
        useSearchStore.getState().clear()
        useSearchStore.getState().commitDraft({
            kind: 'text', target: 'any', match: 'substring', value: 'orders',
        })
    })

    it('keeps the builder mounted when results arrive under it', () => {
        renderPanel(stubSession({
            refineOpen: true,
            advanced: stubAdvanced({ view: RESULTS }),
        }))

        expect(screen.getByRole('button', BUILDER)).toBeInTheDocument()
    })

    it('opens on the answer when Refine is closed', () => {
        renderPanel(stubSession({
            refineOpen: false,
            advanced: stubAdvanced({ view: RESULTS }),
        }))

        expect(screen.queryByRole('button', BUILDER)).not.toBeInTheDocument()
    })

    it('shows the builder with no results only because the session said so', () => {
        renderPanel(stubSession({ refineOpen: true }))

        expect(screen.getByRole('button', BUILDER)).toBeInTheDocument()
    })

    it('does not conjure the builder back from an empty results section', () => {
        // Idle pipeline AND Refine closed. The old rule
        // (`refineOpen || !showResultsSection`) showed the card here,
        // which is what made it unmount as soon as a query ran.
        renderPanel(stubSession({ refineOpen: false }))

        expect(screen.queryByRole('button', BUILDER)).not.toBeInTheDocument()
    })

    it('offers Refine as a toggle once there is an answer behind it', () => {
        const session = stubSession({
            refineOpen: true,
            advanced: stubAdvanced({ view: RESULTS }),
        })
        renderPanel(session)

        screen.getByRole('button', { name: 'Refine' }).click()

        expect(session.closeRefine).toHaveBeenCalledTimes(1)
        expect(session.refine).not.toHaveBeenCalled()
    })

    it('does not offer a hide chip with nothing to hide behind', () => {
        // Cold open: the builder is all there is. A chip whose only job
        // is to put it away would either do nothing or blank the rail.
        renderPanel(stubSession({ refineOpen: true }))

        expect(screen.queryByRole('button', { name: 'Refine' }))
            .not.toBeInTheDocument()
    })
})
