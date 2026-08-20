/**
 * AnalyticsPage — URL is the single source of truth for tab and range.
 *
 * These are the behaviours that break silently: a tab that lives in state
 * instead of the URL survives a render but not a Back button, and a range that
 * isn't validated lets `?range=99` reach the API as a 422.
 */
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { render, screen, waitFor, within } from '@testing-library/react'
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

// Only the network calls are stubbed. `rangeKey`/`rangeQuery` are pure
// functions the hooks depend on, so replacing the whole module without them
// leaves the query key `undefined` and every render throws.
vi.mock('@/services/analyticsService', async (importOriginal) => {
    const actual = await importOriginal<typeof import('@/services/analyticsService')>()
    return {
        ...actual,
        analyticsService: {
            getSummary: vi.fn(),
            listWorkspaces: vi.fn(),
            getWorkspace: vi.fn(),
        },
    }
})

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
        previous: {
            signups: [0, 1, 0], viewsCreated: [1, 1, 0],
            viewOpens: [2, 2, 3], activeUsers: [1, 1, 2],
        },
    },
    engagement: {
        dau: 4, wau: 8, mau: 12, stickiness: 0.33, activationRate: 0.5,
        creationRate: 0.5, medianDaysToFirstView: 2.5,
        funnel: [
            { stage: 'Signed up', count: 4, rate: 1 },
            { stage: 'Became active', count: 3, rate: 0.75 },
            { stage: 'Opened a view', count: 2, rate: 0.5 },
            { stage: 'Traced lineage', count: 2, rate: 0.5 },
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
    adoption: [
        { key: 'lineage', label: 'Lineage tracing', events: 12, users: 3,
          previousEvents: 6, changePct: 100, reach: 0.75,
          since: '2026-06-01T00:00:00+00:00' },
        { key: 'export', label: 'Export', events: 0, users: 0,
          previousEvents: 0, changePct: null, reach: 0, since: null },
    ],
    valueMoments: {
        traces: 12, tracesEmpty: 4, traceSuccessRate: 0.667, tracedBy: 3,
        searches: 9, searchMisses: 1, searchHitRate: 0.889,
    },
    health: {
        reliability: {
            refreshes: 10, failures: 1, successRate: 0.9, sourcesRefreshed: 2,
            sourcesUntouched: 1, byOutcome: [{ key: 'completed', count: 9 }],
        },
        access: {
            requests: 3, pending: 1, medianHoursToApprove: 12,
            oldestPendingDays: 4, invitesSent: 4, invitesRedeemed: 1,
            acceptanceRate: 0.25,
        },
        semanticLayer: {
            sourcesWithOntology: 1, sourcesTotal: 3, coverage: 0.333,
            sourcesDrifting: 0,
        },
    },
    annotations: [{ bucket: '2026-06-14', date: '2026-06-14', title: 'v2.1 shipped', kind: 'info' }],
    insights: [
        { key: 'trace-empty', tone: 'bad' as const,
          headline: '33% of lineage traces come back empty',
          detail: '4 of 12 traces found no lineage.', tab: 'engagement' },
    ],
    coverage: {
        viewOpenTrackingSince: '2026-06-01T00:00:00+00:00',
        trackingSince: { lineage: '2026-06-01T00:00:00+00:00', export: null },
    },
}

const WORKSPACE_ROWS = [{
    workspaceId: 'ws1', name: 'Finance', createdAt: '2026-01-01T00:00:00+00:00',
    isActive: true, members: 5, views: 7, newViews: 2, dataSources: 3,
    activity: 5, opens: 8, activeUsers: 4, nodes: 4200, edges: 9100,
    lastActivityAt: '2026-06-15T09:00:00+00:00', dormant: false,
}]

/** The range object a preset resolves to — the shape the service now takes. */
const preset = (days: number) => ({ kind: 'preset' as const, days })

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
        await waitFor(() => expect(analyticsService.getSummary).toHaveBeenCalledWith(preset(90)))
    })

    it('ignores a range that is not an offered preset', async () => {
        renderAt('/analytics?range=9999')
        await waitFor(() => expect(analyticsService.getSummary).toHaveBeenCalledWith(preset(30)))
        expect(analyticsService.getSummary).not.toHaveBeenCalledWith(preset(9999))
    })

    it('refetches everything below when the range changes', async () => {
        const user = userEvent.setup()
        renderAt('/analytics')
        await waitFor(() => expect(analyticsService.getSummary).toHaveBeenCalledWith(preset(30)))

        await user.click(screen.getByRole('button', { name: '7d' }))
        await waitFor(() => expect(analyticsService.getSummary).toHaveBeenCalledWith(preset(7)))
    })

    it('only fetches the workspace table on the tab that shows it', async () => {
        renderAt('/analytics?tab=overview')
        await waitFor(() => expect(analyticsService.getSummary).toHaveBeenCalled())
        expect(analyticsService.listWorkspaces).not.toHaveBeenCalled()

        renderAt('/analytics?tab=workspaces')
        await waitFor(() => expect(analyticsService.listWorkspaces).toHaveBeenCalledWith(preset(30)))
        expect(await screen.findByText('Finance')).toBeInTheDocument()
    })

    // ── Custom date range ───────────────────────────────────────────

    it('reads a custom range out of the URL and sends it verbatim', async () => {
        renderAt('/analytics?from=2026-03-01&to=2026-03-31')
        await waitFor(() => expect(analyticsService.getSummary).toHaveBeenCalledWith({
            kind: 'custom', from: '2026-03-01', to: '2026-03-31',
        }))
        // The chip shows the range, so a pasted link is self-describing.
        expect(screen.getByRole('button', { name: /2026-03-01 → 2026-03-31/ }))
            .toBeInTheDocument()
    })

    it('falls back to the default preset when a custom range is nonsense', async () => {
        // End before start — the server would 422; the UI must not even ask.
        renderAt('/analytics?from=2026-03-31&to=2026-03-01')
        await waitFor(() =>
            expect(analyticsService.getSummary).toHaveBeenCalledWith(preset(30)))
    })

    it('applying a custom range clears the preset from the URL', async () => {
        const user = userEvent.setup()
        renderAt('/analytics?range=90')
        await waitFor(() =>
            expect(analyticsService.getSummary).toHaveBeenCalledWith(preset(90)))

        await user.click(screen.getByRole('button', { name: /custom/i }))
        const dialog = await screen.findByRole('dialog', { name: /custom date range/i })
        await user.type(within(dialog).getByLabelText('From'), '2026-03-01')
        await user.type(within(dialog).getByLabelText('To'), '2026-03-31')
        await user.click(within(dialog).getByRole('button', { name: /apply range/i }))

        await waitFor(() => expect(analyticsService.getSummary).toHaveBeenCalledWith({
            kind: 'custom', from: '2026-03-01', to: '2026-03-31',
        }))
    })

    // ── The new surfaces ────────────────────────────────────────────

    it('leads Overview with the narrative strip, linked to its tab', async () => {
        const user = userEvent.setup()
        renderAt('/analytics')
        const insight = await screen.findByText(/33% of lineage traces come back empty/i)
        expect(insight).toBeInTheDocument()

        // Clicking an insight goes where it can be investigated.
        await user.click(insight)
        await waitFor(() =>
            expect(screen.getByRole('tab', { name: /engagement/i }))
                .toHaveAttribute('aria-selected', 'true'))
    })

    it('says nothing at all when there are no insights', async () => {
        vi.mocked(analyticsService.getSummary).mockResolvedValue(
            { ...SUMMARY, insights: [] } as never)
        renderAt('/analytics')
        await waitFor(() => expect(analyticsService.getSummary).toHaveBeenCalled())
        // The heading is the strip; no heading means no manufactured findings.
        expect(screen.queryByRole('region', { name: /what changed/i })).toBeNull()
    })

    it('distinguishes an unused feature from an unmeasured one', async () => {
        renderAt('/analytics')
        expect(await screen.findByText('Lineage tracing')).toBeInTheDocument()
        // `export` has since: null — a zero bar would read as "nobody wants it".
        expect(screen.getByText(/not measured yet/i)).toBeInTheDocument()
    })

    it('shows the value moments that say whether tracing worked', async () => {
        renderAt('/analytics?tab=engagement')
        expect(await screen.findByText(/value moments/i)).toBeInTheDocument()
        expect(screen.getByText(/traces that found lineage/i)).toBeInTheDocument()
    })

    it('has a Health tab carrying freshness, access and coverage', async () => {
        renderAt('/analytics?tab=health')
        expect(await screen.findByText(/data freshness/i)).toBeInTheDocument()
        expect(screen.getByText(/access friction/i)).toBeInTheDocument()
        expect(screen.getByText(/semantic layer coverage/i)).toBeInTheDocument()
    })

    it('states the comparison and the timezone once, above every chart', async () => {
        renderAt('/analytics')
        expect(await screen.findByText(/faded lines show the previous period/i))
            .toBeInTheDocument()
        expect(screen.getByText(/bucketed in UTC/i)).toBeInTheDocument()
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
