/**
 * The hero count, against the two other places the same number appears.
 *
 * `candidateCount` is what the scan had to CONSIDER, and it stops at the
 * candidate cap; `totalCount` is the server's exact size of the match
 * set, paid for with one uncapped count when the cap fired. The results
 * list and the canvas header both prefer the exact one — the MatchBar
 * did not, so on any query that hit the cap the panel's own headline
 * disagreed with the list six inches below it.
 */
import { render, screen } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'

import { ProviderOverride } from '@/providers/GraphProviderContext'
import { RemoteGraphProvider } from '@/providers/RemoteGraphProvider'
import type { PanelView } from '@/hooks/useAdvancedSearch'
import { stubAdvanced } from '@/test/stubSearchSession'

import { SearchMapPanel } from '../SearchMapPanel'


const HIT = {
    node: { urn: 'a', displayName: 'orders', entityType: 'table', properties: {} },
    ancestorPath: [],
}

function resultsView(result: Record<string, unknown>): PanelView {
    return {
        kind: 'results',
        template: {},
        inputs: {},
        // The empty-result path renders the diagnostic, which reads the
        // predicate that produced it.
        query: {
            predicate: { kind: 'text', target: 'any', value: 'orders', match: 'substring' },
            scope: { viewId: 'view-1' },
        },
        result: {
            truncated: false, deadlineExceeded: false, cacheHit: false,
            elapsedMs: 4, hits: [HIT], ...result,
        },
        elapsedMs: 4,
    } as unknown as PanelView
}

function renderPanel(result: Record<string, unknown>) {
    const provider = Object.create(RemoteGraphProvider.prototype) as RemoteGraphProvider
    render(
        <ProviderOverride value={{
            provider, isLoading: false, error: null, scopeKind: 'ready',
            workspaceId: 'ws', dataSourceId: null,
            providerReady: true, providerVersion: 1,
        } as never}>
            <SearchMapPanel
                open
                onClose={vi.fn()}
                viewId="view-1"
                session={stubAdvanced({ view: resultsView(result) })}
            />
        </ProviderOverride>,
    )
}

/** The hero number, whatever the surrounding chrome says. */
const hero = () => screen.getByText(/^[\d,]+\+?$/)


describe('SearchMapPanel — the headline count', () => {
    it('reports the exact total, not the capped candidate count', () => {
        renderPanel({ totalCount: 87432, candidateCount: 50000, truncated: true })

        expect(hero().textContent).toBe('87,432+')
    })

    it('falls back to the candidate count when the server could not count', () => {
        // The uncapped count did not fit in the remaining budget, so the
        // wire carries no total and "50,000+" is the honest answer.
        renderPanel({ candidateCount: 50000, truncated: true })

        expect(hero().textContent).toBe('50,000+')
    })

    it('falls back to the page it has when neither number is on the wire', () => {
        renderPanel({})

        expect(hero().textContent).toBe('1')
    })

    it('reports a real zero rather than reaching past it', () => {
        renderPanel({ totalCount: 0, candidateCount: 0, hits: [] })

        expect(hero().textContent).toBe('0')
    })
})
