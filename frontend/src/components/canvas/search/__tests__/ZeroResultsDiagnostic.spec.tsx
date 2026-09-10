/**
 * Zero results, in the user's words.
 *
 * The card used to open on ontology diagnostics — edge-type flags,
 * root-URN clamps, compiled Cypher. All true, none of it actionable by
 * the person who typed a word and got nothing. The lead now says what
 * was looked for and offers the other three ways to match it; the
 * engine-level causes move under "Technical details".
 */
import { render, screen, fireEvent } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'

import type { QuickMatch } from '@/components/canvas/search/session/quickPredicate'
import { ProviderOverride } from '@/providers/GraphProviderContext'
import { RemoteGraphProvider } from '@/providers/RemoteGraphProvider'
import type { SearchQuery, SearchResultPage } from '@/types/search'

import { ZeroResultsDiagnostic } from '../ZeroResultsDiagnostic'


const EMPTY: SearchResultPage = {
    hits: [], candidateCount: 0, truncated: false,
    deadlineExceeded: false, cacheHit: false, elapsedMs: 3,
} as SearchResultPage

const QUERY = {
    predicate: {
        kind: 'text', target: 'any', match: 'substring', value: 'custmer',
    },
    options: {},
} as unknown as SearchQuery

function renderCard(onSwitchMatch?: (m: QuickMatch) => void) {
    const provider = Object.create(RemoteGraphProvider.prototype) as RemoteGraphProvider
    render(
        <ProviderOverride value={{
            provider, isLoading: false, error: null, scopeKind: 'ready',
            workspaceId: 'ws', dataSourceId: null,
            providerReady: true, providerVersion: 1,
        } as never}>
            <ZeroResultsDiagnostic
                result={EMPTY}
                query={QUERY}
                viewId="view-1"
                onSwitchMatch={onSwitchMatch}
            />
        </ProviderOverride>,
    )
}


describe('ZeroResultsDiagnostic', () => {
    it('leads with what was searched for, in business language', () => {
        renderCard()

        expect(screen.getByText(/Nothing in this view contains/)).toBeInTheDocument()
        expect(screen.getByText(/custmer/)).toBeInTheDocument()
    })

    it('offers the other match modes as one click each', () => {
        const onSwitchMatch = vi.fn()
        renderCard(onSwitchMatch)

        fireEvent.click(screen.getByRole('button', { name: 'Starts with' }))

        expect(onSwitchMatch).toHaveBeenCalledWith('prefix')
    })

    it('keeps the engine-level causes behind Technical details', () => {
        renderCard()

        expect(screen.getByRole('button', { name: /Technical details/ }))
            .toHaveAttribute('aria-expanded', 'false')
        expect(screen.queryByText(/No node matched your conditions/))
            .not.toBeInTheDocument()

        fireEvent.click(screen.getByRole('button', { name: /Technical details/ }))

        expect(screen.getByText(/No node matched your conditions/)).toBeInTheDocument()
    })
})
