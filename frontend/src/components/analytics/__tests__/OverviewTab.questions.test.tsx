/**
 * The Overview's findings about questions wait for questions to be on: the document is cached for
 * every reader, so the switch is applied where it is shown.
 */
import { render, screen } from '@testing-library/react'
import { MemoryRouter } from 'react-router-dom'
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest'

import { OverviewTab } from '../OverviewTab'
import { PRIVILEGED } from '@/harness/analyticsFixtures'
import type { AnalyticsSummary, Insight } from '@/services/analyticsService'
import { DEFAULT_FEATURES, useFeaturesStore } from '@/store/features'

beforeAll(() => {
    window.matchMedia = window.matchMedia ?? (((query: string) => ({
        matches: query.includes('min-width'), media: query, onchange: null,
        addEventListener: vi.fn(), removeEventListener: vi.fn(),
        addListener: vi.fn(), removeListener: vi.fn(), dispatchEvent: vi.fn(),
    })) as unknown as typeof window.matchMedia)
})
afterEach(() => useFeaturesStore.setState({ values: { ...DEFAULT_FEATURES } }))

const finding = (key: string, headline: string): Insight => ({
    key, tone: 'watch', headline, detail: '', tab: null, spark: null,
} as unknown as Insight)

const data: AnalyticsSummary = {
    ...PRIVILEGED,
    insights: [
        finding('questions-waiting', '3 questions have waited over a week'),
        finding('most-discussed', 'Most discussed: Revenue lineage'),
        ...PRIVILEGED.insights,
    ],
}

function renderTab() {
    render(
        <MemoryRouter>
            <OverviewTab data={data} range={{ kind: 'preset', days: 14 }} isStale={false} onWorkspaceClick={vi.fn()} />
        </MemoryRouter>,
    )
}

describe('OverviewTab · findings about questions', () => {
    it('leaves them out while questions are off', () => {
        renderTab()
        expect(screen.queryByText('3 questions have waited over a week')).toBeNull()
        expect(screen.queryByText('Most discussed: Revenue lineage')).toBeNull()
    })

    it('shows them while questions are on', () => {
        useFeaturesStore.setState({ values: { ...DEFAULT_FEATURES, conversationsEnabled: true } })
        renderTab()
        expect(screen.getByText('3 questions have waited over a week')).toBeInTheDocument()
        expect(screen.getByText('Most discussed: Revenue lineage')).toBeInTheDocument()
    })
})
