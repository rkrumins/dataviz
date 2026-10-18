/**
 * The dashboard's cards quote the server's workspace summary — the same numbers
 * Administration → Global Overview shows — say what they count and how they
 * moved, and open a sheet with what is behind them.
 */
import { fireEvent, render, screen, within } from '@testing-library/react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { MotionConfig } from 'framer-motion'
import { MemoryRouter } from 'react-router-dom'
import { describe, expect, it, vi } from 'vitest'

import type { OntologyDefinitionResponse } from '@/services/ontologyDefinitionService'
import type { WorkspaceSummary, WorkspaceSummaryTrend } from '@/services/workspaceService'

vi.mock('@/services/viewApiService', async (importOriginal) => ({
    ...(await importOriginal<typeof import('@/services/viewApiService')>()),
    listPopularViews: vi.fn().mockResolvedValue([
        { id: 'v1', name: 'Orders lineage', viewType: 'reference', workspaceName: 'Finance', favouriteCount: 4 },
    ]),
    getRecentViews: vi.fn().mockResolvedValue([]),
}))

import { InsightCards } from './InsightCards'

const SUMMARY: WorkspaceSummary = {
    coverage: 'all',
    totals: {
        workspaces: 3, dataSources: 7, activeDataSources: 6, pendingDataSources: 0,
        nodes: 1_284_000, edges: 4_500, entityTypes: ['Table'], views: 42, sharedGraphs: 1,
    },
    workspaces: [],
}

const ONTOLOGIES = [
    { id: 'o1', name: 'Core', isPublished: true, createdAt: '2026-01-01T00:00:00Z', updatedAt: '2026-01-02T00:00:00Z', version: 2, entityTypeDefinitions: {} },
    { id: 'o2', name: 'Sales', isPublished: true, createdAt: '2026-01-01T00:00:00Z', updatedAt: '2026-01-03T00:00:00Z', version: 1, entityTypeDefinitions: {} },
    { id: 'o3', name: 'Ops', isPublished: true, createdAt: '2026-01-01T00:00:00Z', updatedAt: '2026-01-04T00:00:00Z', version: 1, entityTypeDefinitions: {} },
    { id: 'o4', name: 'Draft A', isPublished: false, createdAt: '2026-10-10T00:00:00Z', updatedAt: '2026-10-10T00:00:00Z', version: 1, entityTypeDefinitions: {} },
    { id: 'o5', name: 'Draft B', isPublished: false, createdAt: '2026-10-12T00:00:00Z', updatedAt: '2026-10-12T00:00:00Z', version: 1, entityTypeDefinitions: {} },
] as unknown as OntologyDefinitionResponse[]

const TREND: WorkspaceSummaryTrend = {
    days: ['2026-10-09', '2026-10-10', '2026-10-11', '2026-10-12'],
    workspaces: [3, 3, 3, 3],
    dataSources: [6, 6, 7, 7],
    views: [39, 40, 41, 42],
    nodes: [null, 1_000_000, 1_100_000, 1_100_000],
    edges: [null, 4_000, 4_400, 4_500],
}

function renderCards(summary: WorkspaceSummary | undefined, trend?: WorkspaceSummaryTrend) {
    return render(
        <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
            <MotionConfig reducedMotion="always">
                <MemoryRouter>
                    <InsightCards summary={summary} trend={trend} ontologies={ONTOLOGIES} />
                </MemoryRouter>
            </MotionConfig>
        </QueryClientProvider>,
    )
}

describe('InsightCards', () => {
    it('counts data sources, with the graph figures Admin shows underneath', () => {
        renderCards(SUMMARY)
        expect(screen.getByText('Data Sources')).toBeInTheDocument()
        expect(screen.getByText('7')).toBeInTheDocument()
        expect(screen.getByText('1.3M entities · 4.5k relationships')).toBeInTheDocument()
        expect(screen.queryByText('Data Assets')).not.toBeInTheDocument()
    })

    it('quotes the Explorer total for views and the workspace count', () => {
        renderCards(SUMMARY)
        expect(screen.getByText('42')).toBeInTheDocument()
        expect(screen.getByText('Every business area')).toBeInTheDocument()
        expect(screen.getByText('3 published')).toBeInTheDocument()
    })

    it('says whose workspaces are counted when the caller sees only their own', () => {
        renderCards({ ...SUMMARY, coverage: 'granted' })
        expect(screen.getByText('Business areas you work in')).toBeInTheDocument()
    })

    it('says sources are still being counted instead of showing a partial total', () => {
        renderCards({ ...SUMMARY, totals: { ...SUMMARY.totals, pendingDataSources: 2 } })
        expect(screen.getByText('Counting 2 sources…')).toBeInTheDocument()
    })

    it('shows a dash, not a zero, before the numbers arrive', () => {
        renderCards(undefined)
        expect(screen.getAllByText('—')).toHaveLength(3)
    })

    it('says how each number moved over the trend window, and stays quiet when it did not', () => {
        renderCards(SUMMARY, TREND)
        expect(screen.getByText('+3 in 4 days')).toBeInTheDocument()            // views 39 → 42
        expect(screen.getByText('+2 in 4 days')).toBeInTheDocument()            // two layers made on 10 and 12 Oct
        expect(screen.getByText('▲ 10.0% entities in 4 days')).toBeInTheDocument() // unmeasured first day skipped
        expect(screen.getAllByText(/in 4 days/)).toHaveLength(3)                // workspaces held at 3
    })

    it('opens what is behind a number instead of leaving the page', async () => {
        renderCards(SUMMARY, TREND)
        fireEvent.click(screen.getByRole('button', { name: /Context Views/ }))
        const sheet = await screen.findByRole('dialog', { name: 'Context Views' })
        expect(within(sheet).getByText('views you can open')).toBeInTheDocument()
        expect(await within(sheet).findByText('Orders lineage')).toBeInTheDocument()
        expect(within(sheet).getByRole('link', { name: /Open Explorer/ })).toHaveAttribute('href', '/explorer')

        fireEvent.click(within(sheet).getByRole('button', { name: 'Close' }))
        expect(screen.queryByRole('dialog')).not.toBeInTheDocument()
    })
})
