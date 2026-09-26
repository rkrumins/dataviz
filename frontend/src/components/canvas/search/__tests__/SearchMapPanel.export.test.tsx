/**
 * The way to export a search's matches: an Export action beside the count,
 * for a search that found entities — not a path search's routes, and not
 * where exporting is turned off — opening the export of exactly that search.
 */
import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, describe, expect, it, vi } from 'vitest'

import { ProviderOverride } from '@/providers/GraphProviderContext'
import { RemoteGraphProvider } from '@/providers/RemoteGraphProvider'
import type { PanelView } from '@/hooks/useAdvancedSearch'
import { useFeaturesStore } from '@/store/features'
import { stubAdvanced } from '@/test/stubSearchSession'

import { SearchMapPanel } from '../SearchMapPanel'


vi.mock('@/hooks/usePropertyCatalog', () => ({
    usePropertyCatalog: () => ({
        catalog: null, reading: null, error: null, unavailable: true, refresh: vi.fn(),
    }),
}))

const HIT = {
    node: { urn: 'a', displayName: 'orders', entityType: 'table', properties: {} },
    ancestorPath: [],
}

function resultsView(result: Record<string, unknown>): PanelView {
    return {
        kind: 'results', template: {}, inputs: {},
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

const exportAction = () => screen.queryByRole('button', { name: /^Export$/ })

afterEach(() => {
    useFeaturesStore.setState((s) => ({ values: { ...s.values, graphExportEnabled: true } }))
})


describe('SearchMapPanel — exporting the matches', () => {
    it("opens the export of the search's matches, counted", async () => {
        renderPanel({ totalCount: 1234 })

        await userEvent.click(exportAction()!)

        expect(screen.getByRole('dialog', { name: 'Export 1,234 matches' })).toBeInTheDocument()
    })

    it("doesn't claim a count the search is still making", async () => {
        renderPanel({ status: 'running', candidateCount: 10 })

        await userEvent.click(exportAction()!)

        expect(screen.getByRole('dialog', { name: 'Export every match' })).toBeInTheDocument()
    })

    it('has nothing to export for a search that found nothing', () => {
        renderPanel({ totalCount: 0, hits: [] })

        expect(exportAction()).toBeNull()
    })

    it("doesn't offer a path search's routes", () => {
        renderPanel({ totalCount: 3, paths: [] })

        expect(exportAction()).toBeNull()
    })

    it('is not offered where exporting is turned off', () => {
        useFeaturesStore.setState((s) => ({ values: { ...s.values, graphExportEnabled: false } }))
        renderPanel({ totalCount: 3 })

        expect(exportAction()).toBeNull()
    })
})
