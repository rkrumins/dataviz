/**
 * AnalyticsPage — URL is the single source of truth for tab and range.
 *
 * These are the behaviours that break silently: a tab that lives in state
 * instead of the URL survives a render but not a Back button, and a range that
 * isn't validated lets `?range=99` reach the API as a 422.
 */
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { act, render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { MemoryRouter, Route, Routes } from 'react-router-dom'
import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'

import { AnalyticsPage } from '@/pages/AnalyticsPage'
// Tracks the constant rather than a literal: the default window is a
// product decision that may move again, and a test asserting "30" would
// fail for the change rather than for a regression.
import { DEFAULT_RANGE_DAYS } from '@/components/analytics/RangePicker'
import { analyticsService } from '@/services/analyticsService'
import { useAuthStore } from '@/store/auth'

// jsdom has no matchMedia, and the charts ask it which palette to draw with.
// A browser always answers; the test environment has to be told to.
//
// Width queries answer TRUE — jsdom reports a 1024px viewport, so a desktop
// answer is the honest one, and the date grid renders one month or two
// depending on it. Everything else asked here is a `prefers-*` query, where
// false is the right default.
beforeAll(() => {
    window.matchMedia = window.matchMedia ?? (((query: string) => ({
        matches: query.includes('min-width'),
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
        viewsByType: [{ key: 'graph', count: 7 }, { key: 'reference', count: 4 }],
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

/** One workspace drill-in, as the detail endpoint returns it. */
const DETAIL = {
    workspaceId: 'ws1', name: 'Finance', description: null,
    createdAt: '2026-01-01T00:00:00+00:00', isActive: true,
    windowDays: 30, generatedAt: SUMMARY.generatedAt,
    range: SUMMARY.range, bucket: 'day' as const,
    totals: Object.fromEntries(
        ['views', 'viewOpens', 'activeUsers', 'activity', 'members', 'dataSources', 'contextModels']
            .map((k) => [k, { total: 4, current: 2, previous: 1, changePct: 100 }]),
    ) as never,
    series: {
        buckets: SUMMARY.series.buckets,
        viewsCreated: [1, 0, 1], cumulativeViews: [2, 2, 3],
        activityEvents: [1, 2, 1], activeUsers: [1, 2, 2], viewOpens: [2, 3, 4],
    },
    breakdowns: { viewsByVisibility: [], viewsByType: [], activityByAction: [] },
    topViews: [],
    topContributors: [],
    graph: { nodes: 10, edges: 20, entityTypes: 3, sourcesWithStats: 1 },
}

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

/** Days in the previous calendar month, as the ISO strings the grid keys on.
 *  A `to` of 0 means "the last day of that month". */
function lastMonthDays(fromDay: number, toDay: number): { from: string; to: string } {
    const now = new Date()
    const y = now.getUTCFullYear()
    const m = now.getUTCMonth() - 1
    const iso = (t: number) => new Date(t).toISOString().slice(0, 10)
    return {
        from: iso(Date.UTC(y, m, fromDay)),
        to: iso(toDay === 0 ? Date.UTC(y, m + 1, 0) : Date.UTC(y, m, toDay)),
    }
}

/** The grid's day buttons carry the ISO date, so the query needs neither a
 *  locale nor a weekday name to find one. */
function dayCell(root: HTMLElement, day: string): HTMLElement {
    const cell = root.querySelector<HTMLElement>(`[data-day="${day}"]`)
    if (!cell) throw new Error(`no day cell for ${day}`)
    return cell
}

describe('AnalyticsPage', () => {
    beforeEach(() => {
        // Zustand state survives between tests, so a test that seeds admin
        // claims would silently privilege every test after it. Reset first.
        act(() => {
            useAuthStore.setState({
                status: 'authenticated',
                isAuthenticated: true,
                permissions: { sid: 's1', global: [], ws: {} },
                permissionsStatus: 'ready',
            })
        })
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
        await waitFor(() => expect(analyticsService.getSummary).toHaveBeenCalledWith(preset(DEFAULT_RANGE_DAYS)))
        expect(analyticsService.getSummary).not.toHaveBeenCalledWith(preset(9999))
    })

    it('refetches everything below when the range changes', async () => {
        const user = userEvent.setup()
        renderAt('/analytics')
        await waitFor(() => expect(analyticsService.getSummary).toHaveBeenCalledWith(preset(DEFAULT_RANGE_DAYS)))

        await user.click(screen.getByRole('button', { name: '7d' }))
        await waitFor(() => expect(analyticsService.getSummary).toHaveBeenCalledWith(preset(7)))
    })

    it('only fetches the workspace table on the tab that shows it', async () => {
        renderAt('/analytics?tab=overview')
        await waitFor(() => expect(analyticsService.getSummary).toHaveBeenCalled())
        expect(analyticsService.listWorkspaces).not.toHaveBeenCalled()

        renderAt('/analytics?tab=workspaces')
        await waitFor(() => expect(analyticsService.listWorkspaces).toHaveBeenCalledWith(preset(DEFAULT_RANGE_DAYS)))
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
            expect(analyticsService.getSummary).toHaveBeenCalledWith(preset(DEFAULT_RANGE_DAYS)))
    })

    it('applying a custom range clears the preset from the URL', async () => {
        const user = userEvent.setup()
        renderAt('/analytics?range=90')
        await waitFor(() =>
            expect(analyticsService.getSummary).toHaveBeenCalledWith(preset(90)))

        await user.click(screen.getByRole('button', { name: /custom/i }))
        const dialog = await screen.findByRole('dialog', { name: /custom date range/i })

        // The grid opens on [last month, this month], so last month's 1st and
        // 28th are always on screen and always in the past — no pinned clock,
        // and no month where the 28th does not exist.
        const { from, to } = lastMonthDays(1, 28)
        await user.click(dayCell(dialog, from))
        await user.click(dayCell(dialog, to))
        await user.click(within(dialog).getByRole('button', { name: /apply range/i }))

        await waitFor(() => expect(analyticsService.getSummary).toHaveBeenCalledWith({
            kind: 'custom', from, to,
        }))
    })

    it('a named period fills the calendar, and Apply commits it', async () => {
        const user = userEvent.setup()
        renderAt('/analytics')

        await user.click(screen.getByRole('button', { name: /custom/i }))
        const dialog = await screen.findByRole('dialog', { name: /custom date range/i })

        // Presets all END today. A named month is the question they cannot
        // ask, which is the only reason this popover exists.
        await user.click(within(dialog).getByRole('button', { name: 'Last month' }))
        const { from, to } = lastMonthDays(1, 0)
        await user.click(within(dialog).getByRole('button', { name: /apply range/i }))

        await waitFor(() => expect(analyticsService.getSummary).toHaveBeenCalledWith({
            kind: 'custom', from, to,
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
        expect(await screen.findByText(/are the previous\s+period/i))
            .toBeInTheDocument()
        expect(screen.getByText(/bucketed in UTC/i)).toBeInTheDocument()
    })

    // ── Comparison marks ────────────────────────────────────────────

    it('keeps plotting a window in which nothing happened', async () => {
        // The reported case: no views created this month, plenty last month.
        // Hiding the chart would hide the comparison that explains the zero —
        // and "No views created in this range" is the least useful thing the
        // panel could say when the answer is sitting in the previous period.
        vi.mocked(analyticsService.getSummary).mockResolvedValue({
            ...SUMMARY,
            series: { ...SUMMARY.series, viewsCreated: [0, 0, 0] },
        } as never)
        renderAt('/analytics?tab=content')

        // By heading: the legend names the series too, so a bare text query
        // matches twice.
        expect(await screen.findByRole('heading', { name: 'Views created' }))
            .toBeInTheDocument()
        expect(screen.queryByText(/No views created in this range/i)).toBeNull()
    })

    it('says a chart is empty only when BOTH periods are', async () => {
        vi.mocked(analyticsService.getSummary).mockResolvedValue({
            ...SUMMARY,
            series: {
                ...SUMMARY.series,
                viewsCreated: [0, 0, 0],
                previous: { ...SUMMARY.series.previous, viewsCreated: [0, 0, 0] },
            },
        } as never)
        renderAt('/analytics?tab=content')

        expect(await screen.findByText(/No views created in this range/i))
            .toBeInTheDocument()
    })

    // ── Terminology ─────────────────────────────────────────────────

    it('calls a reference view a Context View', async () => {
        // The stored enum is `reference`; every other surface in the product
        // says "Context View". Analytics used to render the raw key.
        renderAt('/analytics?tab=content')
        expect(await screen.findByText('Context View')).toBeInTheDocument()
        expect(screen.queryByText(/^Reference$/)).toBeNull()
    })

    // ── Self-explanatory metrics ────────────────────────────────────

    it('explains what a metric means, on demand', async () => {
        const user = userEvent.setup()
        renderAt('/analytics?tab=engagement')

        const button = await screen.findByRole('button', { name: /what does "stickiness" mean/i })
        // Click, not hover: hover cards strobe across a KPI row and do not
        // exist on touch at all.
        await user.click(button)

        const tip = await screen.findByRole('tooltip')
        expect(within(tip).getByText(/daily or occasionally/i)).toBeInTheDocument()
        expect(within(tip).getByText(/how it's calculated/i)).toBeInTheDocument()
        expect(within(tip).getByText(/why it matters/i)).toBeInTheDocument()

        await user.keyboard('{Escape}')
        await waitFor(() => expect(screen.queryByRole('tooltip')).toBeNull())
    })

    // ── Redaction ───────────────────────────────────────────────────

    const REDACTED = {
        ...SUMMARY,
        redaction: {
            applied: true as const,
            mode: 'strict' as const,
            showsPeople: false,
            showsOperations: false,
            reportsAllWorkspaces: false,
            visibleWorkspaces: 1,
            accessResolved: true,
            hidden: ['Individual activity and names'],
        },
        leaderboards: { ...SUMMARY.leaderboards, topUsers: [], topCreators: [] },
        health: { semanticLayer: SUMMARY.health.semanticLayer },
    }

    it('says individual activity is hidden rather than that nobody was active', async () => {
        // The bug this prevents: an empty leaderboard and a withheld one look
        // identical, and "nobody has been active" is a false statement to make
        // to someone who simply may not see who was.
        vi.mocked(analyticsService.getSummary).mockResolvedValue(REDACTED as never)
        renderAt('/analytics')

        expect(await screen.findByText(/individual activity is hidden/i)).toBeInTheDocument()
        expect(screen.queryByText(/nobody has been active/i)).toBeNull()
    })

    it('still shows platform-wide totals to a redacted viewer', async () => {
        vi.mocked(analyticsService.getSummary).mockResolvedValue(REDACTED as never)
        renderAt('/analytics')
        // The notice explains the shape of what they are looking at.
        expect(await screen.findByText(/you're seeing figures for/i))
            .toBeInTheDocument()
        // And the aggregates are still there — that is the whole point.
        expect(screen.getAllByText(/active users/i).length).toBeGreaterThan(0)
        expect(screen.getAllByText(/total users/i).length).toBeGreaterThan(0)
    })

    it('shows colleagues at the internal level, not just to admins', async () => {
        // The bug this catches: the guards keyed on `redaction.applied`, which
        // is true for EVERY non-privileged reader — so colleagues stayed hidden
        // at the very level whose purpose is to show them.
        vi.mocked(analyticsService.getSummary).mockResolvedValue({
            ...REDACTED,
            redaction: {
                ...REDACTED.redaction, mode: 'internal' as const, showsPeople: true,
            },
            leaderboards: SUMMARY.leaderboards,
        } as never)
        renderAt('/analytics')

        expect(await screen.findByText('Ada Lovelace')).toBeInTheDocument()
        expect(screen.queryByText(/individual activity is hidden/i)).toBeNull()
    })

    it('withholds operational health from a redacted viewer', async () => {
        vi.mocked(analyticsService.getSummary).mockResolvedValue(REDACTED as never)
        renderAt('/analytics?tab=health')

        expect(await screen.findByText(/refresh outcomes are hidden/i)).toBeInTheDocument()
        expect(screen.getByText(/access requests are hidden/i)).toBeInTheDocument()
        // The section HEADINGS stay for everyone — only the figures under them
        // are withheld. A reader who may not see the numbers should still learn
        // that the platform tracks this and what it is for.
        expect(screen.getByRole('heading', { name: /data freshness/i })).toBeInTheDocument()
        expect(screen.getByRole('heading', { name: /access friction/i })).toBeInTheDocument()
        // Semantic coverage is a platform fact and stays.
        expect(screen.getByText(/semantic layer coverage/i)).toBeInTheDocument()
    })

    it('warns rather than lies when access could not be resolved', async () => {
        vi.mocked(analyticsService.getSummary).mockResolvedValue({
            ...REDACTED,
            redaction: { ...REDACTED.redaction, accessResolved: false },
        } as never)
        renderAt('/analytics')
        expect(await screen.findByText(/couldn't confirm your workspace access/i))
            .toBeInTheDocument()
    })

    it('locks a workspace row instead of dropping it', async () => {
        vi.mocked(analyticsService.getSummary).mockResolvedValue(REDACTED as never)
        vi.mocked(analyticsService.listWorkspaces).mockResolvedValue([
            WORKSPACE_ROWS[0],
            {
                workspaceId: 'ws2', name: 'Restricted workspace', redacted: true,
                createdAt: '2026-02-01T00:00:00+00:00', isActive: true,
                members: null, views: null, newViews: null, dataSources: null,
                activity: null, opens: null, activeUsers: null,
                nodes: null, edges: null, lastActivityAt: null, dormant: false,
            },
        ] as never)
        renderAt('/analytics?tab=workspaces')

        expect(await screen.findByText('Finance')).toBeInTheDocument()

        // Locked rows are COLLAPSED, not dropped — every one renders
        // identically, so a tenancy that is mostly closed to the reader would
        // otherwise bury the rows they can act on. The summary still accounts
        // for them, because the table has to agree with the totals above it.
        expect(screen.queryByText('Restricted workspace')).toBeNull()
        const summary = screen.getByRole('button', { name: /more workspace/i })
        expect(summary).toHaveTextContent('1')
        expect(summary).toHaveTextContent(/counted in the figures above/i)

        // Opening it brings the row back, with its way forward: a locked row
        // is a dead end unless it offers one, and the product already has an
        // access-request queue to put them in.
        await userEvent.click(summary)
        expect(screen.getByText('Restricted workspace')).toBeInTheDocument()
        expect(screen.getByRole('button', { name: /request access/i }))
            .toBeInTheDocument()
    })

    it('links a workspace you can open, and does not link one you cannot', async () => {
        vi.mocked(analyticsService.getSummary).mockResolvedValue(REDACTED as never)
        vi.mocked(analyticsService.listWorkspaces).mockResolvedValue([
            { ...WORKSPACE_ROWS[0], canOpen: true },
            {
                ...WORKSPACE_ROWS[0], workspaceId: 'ws3', name: 'Reported Only',
                canOpen: false, redacted: false,
            },
        ] as never)
        renderAt('/analytics?tab=workspaces')

        // Openable → a real link, pointing where the app would actually go.
        const link = await screen.findByRole('link', { name: 'Finance' })
        expect(link).toHaveAttribute('href', '/workspaces/ws1')

        // Named because an operator opened reporting, but not openable — so no
        // link. Reporting on something is not a door into it.
        expect(screen.queryByRole('link', { name: 'Reported Only' })).toBeNull()
        expect(screen.getByText('Reported Only')).toBeInTheDocument()
    })

    it('tells an administrator what everyone else can see', async () => {
        // The setting is otherwise invisible to the person who owns it: they
        // would have to sign in as somebody else to check what they changed.
        act(() => {
            useAuthStore.setState({
                status: 'authenticated',
                isAuthenticated: true,
                permissions: { sid: 's1', global: ['system:admin'], ws: {} },
                permissionsStatus: 'ready',
            })
        })
        renderAt('/analytics')
        expect(await screen.findByText(/only administrators and auditors/i))
            .toBeInTheDocument()
        // Read-only: the control itself lives in settings, one click away.
        expect(screen.getByRole('link', { name: /change/i }))
            .toHaveAttribute('href', '/admin/features')
    })

    it('shows a reader their own limits, not the deployment posture', async () => {
        // The mirror image: a non-privileged reader gets the redaction notice
        // in the second person and never sees the operator's status line.
        act(() => {
            useAuthStore.setState({
                status: 'authenticated',
                isAuthenticated: true,
                permissions: { sid: 's1', global: [], ws: { ws1: ['workspace:view:read'] } },
                permissionsStatus: 'ready',
            })
        })
        vi.mocked(analyticsService.getSummary).mockResolvedValue(REDACTED as never)
        renderAt('/analytics')

        expect(await screen.findByText(/you're seeing figures for/i)).toBeInTheDocument()
        expect(screen.queryByText(/only administrators and auditors/i)).toBeNull()
    })

    it('says contributors are hidden rather than that nobody contributed', async () => {
        // The drill-in's roster is the one place an email address could reach a
        // reader who may not see people. An EMPTY leaderboard and a withheld one
        // render identically unless the panel says which.
        vi.mocked(analyticsService.getSummary).mockResolvedValue(REDACTED as never)
        vi.mocked(analyticsService.getWorkspace).mockResolvedValue({
            ...DETAIL,
            redaction: { applied: true, showsPeople: false, member: false },
        } as never)
        renderAt('/analytics?tab=workspaces')

        await userEvent.click(await screen.findByText('Finance'))

        expect(await screen.findByText(/contributors are hidden/i)).toBeInTheDocument()
        expect(screen.queryByText(/nobody has contributed here/i)).toBeNull()
    })

    it('names contributors in a workspace the reader belongs to', async () => {
        vi.mocked(analyticsService.getSummary).mockResolvedValue(REDACTED as never)
        vi.mocked(analyticsService.getWorkspace).mockResolvedValue({
            ...DETAIL,
            topContributors: [{ userId: 'u1', name: 'Ada Lovelace', events: 9 }],
            redaction: { applied: true, showsPeople: true, member: true },
        } as never)
        renderAt('/analytics?tab=workspaces')

        await userEvent.click(await screen.findByText('Finance'))

        expect(await screen.findByText('Ada Lovelace')).toBeInTheDocument()
        expect(screen.queryByText(/contributors are hidden/i)).toBeNull()
    })

    it('guides a brand-new deployment instead of showing six empty charts', async () => {
        // Zeros everywhere is a real state, and six panels each saying "no
        // activity in this range" reads as a broken dashboard rather than as an
        // empty one.
        const zero = { total: 0, current: 0, previous: 0, changePct: null }
        vi.mocked(analyticsService.getSummary).mockResolvedValue({
            ...SUMMARY,
            totals: { ...(SUMMARY.totals as Record<string, unknown>), workspaces: zero, views: zero, dataSources: zero },
        } as never)
        renderAt('/analytics')

        expect(await screen.findByText(/nothing to measure yet/i)).toBeInTheDocument()
        // Everyone gets the step they can take; the admin-only ones stay hidden
        // for a reader holding no claims.
        expect(screen.getByRole('link', { name: /create a workspace/i })).toBeInTheDocument()
        expect(screen.queryByRole('link', { name: /invite your team/i })).toBeNull()
    })

    it('does not call a live platform a first run', async () => {
        vi.mocked(analyticsService.getSummary).mockResolvedValue(SUMMARY as never)
        renderAt('/analytics')
        await screen.findByText(/accounts in total/i)
        expect(screen.queryByText(/nothing to measure yet/i)).toBeNull()
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
