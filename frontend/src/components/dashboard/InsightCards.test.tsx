/**
 * The dashboard's cards quote the server's workspace summary — the same numbers
 * Administration → Global Overview shows — and say what they count.
 */
import { render, screen } from '@testing-library/react'
import { MemoryRouter } from 'react-router-dom'
import { describe, expect, it } from 'vitest'

import type { WorkspaceSummary } from '@/services/workspaceService'
import { InsightCards } from './InsightCards'

const SUMMARY: WorkspaceSummary = {
    coverage: 'all',
    totals: {
        workspaces: 3, dataSources: 7, activeDataSources: 6, pendingDataSources: 0,
        nodes: 1_284_000, edges: 4_500, entityTypes: ['Table'], views: 42, sharedGraphs: 1,
    },
    workspaces: [],
}

function renderCards(summary: WorkspaceSummary | undefined) {
    return render(
        <MemoryRouter>
            <InsightCards summary={summary} semanticLayers={{ total: 5, published: 3 }} />
        </MemoryRouter>,
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
})
