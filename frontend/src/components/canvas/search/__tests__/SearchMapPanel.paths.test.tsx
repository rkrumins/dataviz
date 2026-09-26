/**
 * A path search's result is a list of routes, not a set of matches: the
 * count counts paths, a search that stopped at its path limit says so and
 * how to see more (not the candidate cap, which a path search doesn't
 * use), and the routes say plainly they can't be exported.
 */
import { render, screen } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'

import { ProviderOverride } from '@/providers/GraphProviderContext'
import { RemoteGraphProvider } from '@/providers/RemoteGraphProvider'
import type { PanelView } from '@/hooks/useAdvancedSearch'
import { stubAdvanced } from '@/test/stubSearchSession'

import { SearchMapPanel } from '../SearchMapPanel'


vi.mock('@/hooks/usePropertyCatalog', () => ({
    usePropertyCatalog: () => ({
        catalog: null, reading: null, error: null, unavailable: true, refresh: vi.fn(),
    }),
}))

const PATH = {
    hopCount: 1,
    nodes: [
        { urn: 'urn:a', displayName: 'A', entityType: 'Table' },
        { urn: 'urn:b', displayName: 'B', entityType: 'Table' },
    ],
    edges: [{ edgeType: 'FLOWS_TO', sourceUrn: 'urn:a', targetUrn: 'urn:b' }],
}

function renderPaths(result: Record<string, unknown>) {
    const view = {
        kind: 'results', template: {}, inputs: {},
        query: {
            predicate: { kind: 'path', sourceUrns: ['urn:a'], targetUrns: ['urn:b'] },
            scope: { viewId: 'view-1' },
            options: { results: 'paths' },
        },
        result: {
            truncated: false, deadlineExceeded: false, cacheHit: false,
            elapsedMs: 4, hits: [], ...result,
        },
        elapsedMs: 4,
    } as unknown as PanelView
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
                session={stubAdvanced({ view })}
            />
        </ProviderOverride>,
    )
}


describe("SearchMapPanel — a path search's routes", () => {
    it('counts paths, and says a search that stopped at its path limit may have more', () => {
        renderPaths({ paths: Array(32).fill(PATH), candidateCount: 32, truncated: true })

        expect(screen.getByText('32+')).toBeInTheDocument()
        expect(screen.getByText('paths')).toBeInTheDocument()
        expect(screen.getByText(/the most one search returns/)).toBeInTheDocument()
        expect(screen.getByText(/Raise maxPaths/)).toBeInTheDocument()
        expect(screen.queryByText(/candidate cap/i)).not.toBeInTheDocument()
    })

    it("says routes can't be exported", () => {
        renderPaths({ paths: [PATH], candidateCount: 1 })

        expect(screen.getByText('path')).toBeInTheDocument()
        expect(screen.getByText(/Paths can't be exported/)).toBeInTheDocument()
        expect(screen.queryByRole('button', { name: /^Export$/ })).not.toBeInTheDocument()
    })
})
