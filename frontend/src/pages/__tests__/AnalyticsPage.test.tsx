/**
 * AnalyticsPage — URL is the single source of truth for tab and range.
 *
 * These are the behaviours that break silently: a tab that lives in state
 * instead of the URL survives a render but not a Back button, and a range that
 * isn't validated lets `?range=99` reach the API as a 422.
 */
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { MemoryRouter, Route, Routes } from 'react-router-dom'
import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'

import { AnalyticsPage } from '@/pages/AnalyticsPage'
import { analyticsService } from '@/services/analyticsService'

// jsdom has no matchMedia, and the charts ask it which palette to draw with.
// A browser always answers; the test environment has to be told to.
beforeAll(() => {
    window.matchMedia = window.matchMedia ?? (((query: string) => ({
        matches: false,
        media: query,
        onchange: null,
        addEventListener: vi.fn(),
        removeEventListener: vi.fn(),
        addListener: vi.fn(),
        removeListener: vi.fn(),
        dispatchEvent: vi.fn(),
    })) as unknown as typeof window.matchMedia)
})

vi.mock('@/services/analyticsService', () => ({
    analyticsService: {
        getSummary: vi.fn(),
        listWorkspaces: vi.fn(),
        getWorkspace: vi.fn(),
    },
}))

const SUMMARY = {
    windowDays: 30,
    generatedAt: '2026-06-15T12:00:00+00:00',
    range: {
        from: '2026-05-16T12:00:00+00:00', to: '2026-06-15T12:00:00+00:00',
        previousFrom: '2026-04-16T12:00:00+00:00', previousTo: '2026-05-16T12:00:00+00:00',
    },
    bucket: 'day' as const,
    totals: Object.fromEntries(
        ['users', 'activeUsers', 'workspaces', 'views', 'viewOpens', 'dataSources',
         'activity', 'ontologies', 'contextModels', 'catalogItems', 'groups']
            .map((k) => [k, { total: 12, current: 4, previous: 2, changePct: 100 }]),
    ) as never,
    series: {
        buckets: ['2026-06-13', '2026-06-14', '2026-06-15'],
        signups: [1, 2, 1], cumulativeUsers: [10, 12, 13], activeUsers: [2, 3, 4],
        signIns: [3, 4, 5], viewsCreated: [1, 0, 2], cumulativeViews: [5, 5, 7],
        workspacesCreated: [0, 1, 0], cumulativeWorkspaces: [2, 3, 3],
        viewOpens: [4, 6, 8], activityEvents: [2, 2, 3], dataSourcesOnboarded: [0, 1, 0],
    },
    engagement: {
        dau: 4, wau: 8, mau: 12, stickiness: 0.33, activationRate: 0.5,
        medianDaysToFirstView: 2.5,
        funnel: [
            { stage: 'Signed up', count: 4, rate: 1 },
            { stage: 'Became active', count: 3, rate: 0.75 },
            { stage: 'Opened a view', count: 2, rate: 0.5 },
            { stage: 'Created a view', count: 2, rate: 0.5 },
        ],
        growthAccounting: { new: 2, returning: 3, resurrected: 1, dormant: 1 },
        cohorts: [],
    },
    breakdowns: {
        usersByStatus: [{ key: 'active', count: 10 }, { key: 'pending', count: 2 }],
        usersBySignupSource: [{ key: 'local_signup', count: 12 }],
        viewsByVisibility: [{ key: 'private', count: 5 }, { key: 'workspace', count: 2 }],
        viewsByType: [{ key: 'graph', count: 7 }],
        activityByAction: [{ key: 'created', count: 3 }],
        collaborationRate: 0.29,
        contentConcentration: 0.8,
    },
    leaderboards: {
        topUsers: [{ userId: 'u1', name: 'Ada Lovelace', email: 'ada@x.io', events: 9, viewsOpened: 6, viewsCreated: 3 }],
        topViews: [{ viewId: 'v1', name: 'Revenue lineage', workspaceId: 'ws1', visibility: 'workspace', viewType: 'graph', opens: 8, uniqueViewers: 3, favourites: 1 }],
        topWorkspaces: [{ workspaceId: 'ws1', name: 'Finance', activity: 5, opens: 8 }],
        topCreators: [{ userId: 'u1', name: 'Ada Lovelace', viewsCreated: 3 }],
    },
    graph: { nodes: 4200, edges: 9100, entityTypes: 7, sourcesWithStats: 3 },
    coverage: { viewOpenTrackingSince: '2026-06-01T00:00:00+00:00' },
}

const WORKSPACE_ROWS = [{
    workspaceId: 'ws1', name: 'Finance', createdAt: '2026-01-01T00:00:00+00:00',
    isActive: true, members: 5, views: 7, newViews: 2, dataSources: 3,
    activity: 5, opens: 8, activeUsers: 4, nodes: 4200, edges: 9100,
    lastActivityAt: '2026-06-15T09:00:00+00:00', dormant: false,
}]

function renderAt(path: string) {
    const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } })
    return render(
        <QueryClientProvider client={qc}>
            <MemoryRouter initialEntries={[path]}>
                <Routes><Route path="/analytics" element={<AnalyticsPage />} /></Routes>
            </MemoryRouter>
        </QueryClientProvider>,
    )
}

describe('AnalyticsPage', () => {
    beforeEach(() => {
        vi.mocked(analyticsService.getSummary).mockResolvedValue(SUMMARY as never)
        vi.mocked(analyticsService.listWorkspaces).mockResolvedValue(WORKSPACE_ROWS as never)
        vi.mocked(analyticsService.getWorkspace).mockResolvedValue({} as never)
    })

    it('resolves the active tab from the URL', async () => {
        renderAt('/analytics?tab=growth')
        await waitFor(() =>
            expect(screen.getByRole('tab', { name: /growth/i })).toHaveAttribute('aria-selected', 'true'))
        expect(screen.getByRole('tab', { name: /overview/i })).toHaveAttribute('aria-selected', 'false')
        // A Growth-only panel proves the tab actually switched the content.
        expect(await screen.findByText(/Retention by signup cohort/i)).toBeInTheDocument()
    })

    it('falls back to Overview when ?tab= is not a real tab', async () => {
        renderAt('/analytics?tab=not-a-tab')
        await waitFor(() =>
            expect(screen.getByRole('tab', { name: /overview/i })).toHaveAttribute('aria-selected', 'true'))
    })

    it('scopes every request to the range in the URL', async () => {
        renderAt('/analytics?range=90')
        await waitFor(() => expect(analyticsService.getSummary).toHaveBeenCalledWith(90))
    })

    it('ignores a range that is not an offered preset', async () => {
        renderAt('/analytics?range=9999')
        await waitFor(() => expect(analyticsService.getSummary).toHaveBeenCalledWith(30))
        expect(analyticsService.getSummary).not.toHaveBeenCalledWith(9999)
    })

    it('refetches everything below when the range changes', async () => {
        const user = userEvent.setup()
        renderAt('/analytics')
        await waitFor(() => expect(analyticsService.getSummary).toHaveBeenCalledWith(30))

        await user.click(screen.getByRole('button', { name: '7d' }))
        await waitFor(() => expect(analyticsService.getSummary).toHaveBeenCalledWith(7))
    })

    it('only fetches the workspace table on the tab that shows it', async () => {
        renderAt('/analytics?tab=overview')
        await waitFor(() => expect(analyticsService.getSummary).toHaveBeenCalled())
        expect(analyticsService.listWorkspaces).not.toHaveBeenCalled()

        renderAt('/analytics?tab=workspaces')
        await waitFor(() => expect(analyticsService.listWorkspaces).toHaveBeenCalledWith(30))
        expect(await screen.findByText('Finance')).toBeInTheDocument()
    })

    it('surfaces a load failure instead of rendering empty charts', async () => {
        vi.mocked(analyticsService.getSummary).mockRejectedValue(new Error('Session expired'))
        renderAt('/analytics')
        // The hook retries once before giving up, so the panel is a backoff
        // away rather than immediate.
        expect(
            await screen.findByText(/Couldn't load analytics/i, undefined, { timeout: 5000 }),
        ).toBeInTheDocument()
        expect(screen.getByText(/Session expired/i)).toBeInTheDocument()
    })
})
