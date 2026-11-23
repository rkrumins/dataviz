/**
 * A workspace's drill-in: the questions about its views and sources, and how
 * well its sources are described.
 */
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { act, render, screen, within } from '@testing-library/react'
import { MemoryRouter } from 'react-router-dom'
import { beforeAll, describe, expect, it, vi } from 'vitest'

import { WorkspaceInsightsPanel } from '../WorkspaceInsightsPanel'
import { DETAIL_PRIVILEGED } from '@/harness/analyticsFixtures'
import { rangeKey, type WorkspaceAnalyticsDetail } from '@/services/analyticsService'
import { DEFAULT_FEATURES, useFeaturesStore } from '@/store/features'

beforeAll(() => {
    window.matchMedia = window.matchMedia ?? (((query: string) => ({
        matches: query.includes('min-width'), media: query, onchange: null,
        addEventListener: vi.fn(), removeEventListener: vi.fn(),
        addListener: vi.fn(), removeListener: vi.fn(), dispatchEvent: vi.fn(),
    })) as unknown as typeof window.matchMedia)
})

const RANGE = { kind: 'preset' as const, days: 14 }

function renderPanel(detail: WorkspaceAnalyticsDetail, { conversations = true } = {}) {
    act(() => {
        useFeaturesStore.setState({ values: { ...DEFAULT_FEATURES, conversationsEnabled: conversations } })
    })
    // The panel reads its document through react-query: seed it, as a
    // warmed cache would.
    const client = new QueryClient({ defaultOptions: { queries: { staleTime: Infinity, retry: false } } })
    client.setQueryData(['analytics', 'workspace', detail.workspaceId, rangeKey(RANGE)], detail)
    render(
        <QueryClientProvider client={client}>
            <MemoryRouter>
                <WorkspaceInsightsPanel workspaceId={detail.workspaceId} range={RANGE} onClose={() => {}} />
            </MemoryRouter>
        </QueryClientProvider>,
    )
}

function frame(title: string): HTMLElement {
    const el = screen.getByRole('heading', { name: title }).closest('section')
    if (!el) throw new Error(`no frame ${title}`)
    return el as HTMLElement
}

describe('WorkspaceInsightsPanel · questions and source details', () => {
    it('carries the questions about its views and sources', () => {
        renderPanel(DETAIL_PRIVILEGED)
        const questions = screen.getByRole('region', { name: 'Questions' })

        expect(within(questions).getByText('Questions asked', { selector: 'p' })).toBeInTheDocument()
        expect(within(questions).getByText('18')).toBeInTheDocument()
        expect(within(questions).getByText('78%')).toBeInTheDocument()
        expect(within(questions).getByText('3h')).toBeInTheDocument()
        expect(within(frame('Most discussed views')).getByRole('link', { name: 'Customer 360' }))
            .toHaveAttribute('href', '/views/v2')
        expect(within(frame('Sources with the most questions')).getByRole('link', { name: 'Warehouse lineage' }))
            .toHaveAttribute('href', '/workspaces/ws1?tab=data&section=sources&ds=ds1&dstab=questions')
    })

    it('says how well its sources are described', () => {
        renderPanel(DETAIL_PRIVILEGED)
        const details = frame('How its sources are described')

        expect(within(details).getByText('79%')).toBeInTheDocument()
        expect(within(details).getByText('27 of 34')).toBeInTheDocument()
        expect(within(details).getByText('Certified')).toBeInTheDocument()
    })

    it('leaves questions out where they are switched off and none were asked', () => {
        renderPanel({
            ...DETAIL_PRIVILEGED,
            collaboration: {
                ...DETAIL_PRIVILEGED.collaboration!,
                asked: { total: 0, current: 0, previous: 0, changePct: null },
                views: [], sources: [],
            },
        }, { conversations: false })
        expect(screen.queryByRole('region', { name: 'Questions' })).toBeNull()
        // Source details are not about questions, and stay.
        expect(frame('How its sources are described')).toBeInTheDocument()
    })

    it('survives a document cached before either existed', () => {
        renderPanel({ ...DETAIL_PRIVILEGED, collaboration: undefined, sourceDetails: undefined })
        expect(screen.getByRole('heading', { name: 'Graph scale' })).toBeInTheDocument()
        expect(screen.queryByRole('region', { name: 'Questions' })).toBeNull()
        expect(screen.queryByRole('heading', { name: 'How its sources are described' })).toBeNull()
    })
})
