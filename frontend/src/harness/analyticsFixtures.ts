/**
 * Analytics fixtures — one per privacy posture.
 *
 * These states cannot be reached by hand in a dev environment. Seeing the
 * strict-privacy view requires a second user account with no workspace
 * bindings AND two feature flags set a particular way; seeing the
 * workspace-reporting view requires a third combination. So the redaction
 * work shipped twice without anyone having looked at it, and both times the
 * unit tests passed over it — which is exactly the gap `lensHarness` was
 * built to close for the graph body.
 *
 * Every fixture is a complete `AnalyticsSummary`, so the harness renders the
 * REAL tabs against it. No API, no providers, no auth.
 */
import type {
    AnalyticsSummary, WorkspaceAnalyticsRow,
} from '../services/analyticsService'

const BUCKETS = Array.from({ length: 14 }, (_, i) => {
    const d = new Date(Date.UTC(2026, 5, 2 + i))
    return d.toISOString().slice(0, 10)
})

const series = (seed: number, scale = 1) =>
    BUCKETS.map((_, i) =>
        Math.round((Math.abs(Math.sin((i + seed) * 1.7)) * 40 + 8) * scale))

const running = (start: number, step: number[]) => {
    let t = start
    return step.map((v) => (t += v))
}

const metric = (total: number, current: number, previous: number) => ({
    total, current, previous,
    changePct: previous ? Math.round(((current - previous) / previous) * 1000) / 10 : null,
})

const signups = series(1, 0.35)
const viewsCreated = series(4, 0.3)

/** The full, unredacted document an administrator sees. */
export const PRIVILEGED: AnalyticsSummary = {
    windowDays: 14,
    generatedAt: '2026-06-15T12:00:00+00:00',
    range: {
        from: '2026-06-01T00:00:00+00:00', to: '2026-06-15T00:00:00+00:00',
        previousFrom: '2026-05-18T00:00:00+00:00', previousTo: '2026-06-01T00:00:00+00:00',
    },
    bucket: 'day',
    totals: {
        users: metric(1284, 96, 71),
        activeUsers: metric(1284, 412, 388),
        workspaces: metric(37, 4, 2),
        views: metric(918, 63, 74),
        viewOpens: metric(24810, 3120, 2740),
        dataSources: metric(112, 6, 4),
        activity: metric(51200, 1840, 1610),
        ontologies: metric(24, 2, 1),
        contextModels: metric(310, 12, 15),
        catalogItems: metric(486, 21, 18),
        groups: metric(19, 1, 0),
    },
    series: {
        buckets: BUCKETS,
        signups,
        cumulativeUsers: running(1188, signups),
        activeUsers: series(2, 8),
        signIns: series(7, 11),
        viewsCreated,
        cumulativeViews: running(855, viewsCreated),
        workspacesCreated: BUCKETS.map((_, i) => (i % 5 === 0 ? 1 : 0)),
        cumulativeWorkspaces: running(33, BUCKETS.map((_, i) => (i % 5 === 0 ? 1 : 0))),
        viewOpens: series(3, 55),
        activityEvents: series(5, 32),
        dataSourcesOnboarded: BUCKETS.map((_, i) => (i % 4 === 0 ? 1 : 0)),
        previous: {
            signups: series(6, 0.3),
            viewsCreated: series(8, 0.34),
            viewOpens: series(9, 48),
            activeUsers: series(10, 7),
        },
    },
    engagement: {
        dau: 118, wau: 306, mau: 412,
        stickiness: 0.286,
        activationRate: 0.61,
        creationRate: 0.34,
        medianDaysToFirstView: 2.5,
        funnel: [
            { stage: 'Signed up', count: 96, rate: 1 },
            { stage: 'Became active', count: 81, rate: 0.844 },
            { stage: 'Opened a view', count: 74, rate: 0.771 },
            { stage: 'Traced lineage', count: 59, rate: 0.615 },
            { stage: 'Created a view', count: 33, rate: 0.344 },
        ],
        growthAccounting: { new: 96, returning: 289, resurrected: 27, dormant: 41 },
        cohorts: Array.from({ length: 5 }, (_, c) => ({
            // Real week starts, rolled into June — `2026-05-32` is not a date,
            // and a fixture that prints one is testing the fallback, not the
            // component.
            cohort: ['2026-05-04', '2026-05-11', '2026-05-18', '2026-05-25', '2026-06-01'][c],
            size: 60 - c * 7,
            weeks: Array.from({ length: 5 - c }, (_, w) => ({
                week: w,
                active: Math.round((60 - c * 7) * Math.pow(0.78, w)),
                rate: Math.pow(0.78, w),
            })),
        })),
    },
    breakdowns: {
        usersByStatus: [
            { key: 'active', count: 1142 }, { key: 'pending', count: 96 },
            { key: 'suspended', count: 46 },
        ],
        usersBySignupSource: [
            { key: 'sso_jit', count: 781 }, { key: 'invite', count: 302 },
            { key: 'local_signup', count: 174 }, { key: 'admin_created', count: 27 },
        ],
        viewsByVisibility: [
            { key: 'workspace', count: 512 }, { key: 'private', count: 301 },
            { key: 'enterprise', count: 105 },
        ],
        viewsByType: [
            { key: 'reference', count: 486 }, { key: 'graph', count: 297 },
            { key: 'hierarchy', count: 102 }, { key: 'layered-lineage', count: 33 },
        ],
        activityByAction: [
            { key: 'updated', count: 1820 }, { key: 'created', count: 918 },
            { key: 'shared', count: 402 }, { key: 'favourited', count: 260 },
            { key: 'visibility_changed', count: 141 }, { key: 'deleted', count: 74 },
        ],
        collaborationRate: 0.672,
        contentConcentration: 0.64,
    },
    leaderboards: {
        topUsers: [
            { userId: 'u1', name: 'Ada Lovelace', email: 'ada@example.com', events: 412, viewsOpened: 288, viewsCreated: 31 },
            { userId: 'u2', name: 'Grace Hopper', email: 'grace@example.com', events: 361, viewsOpened: 240, viewsCreated: 24 },
            { userId: 'u3', name: 'Katherine Johnson', email: 'kj@example.com', events: 298, viewsOpened: 211, viewsCreated: 18 },
            { userId: 'u4', name: 'Alan Turing', email: 'alan@example.com', events: 214, viewsOpened: 160, viewsCreated: 12 },
            { userId: 'u5', name: 'Barbara Liskov', email: 'bl@example.com', events: 186, viewsOpened: 140, viewsCreated: 9 },
        ],
        topViews: [
            { viewId: 'v1', name: 'Revenue lineage', workspaceId: 'ws1', visibility: 'enterprise', viewType: 'reference', opens: 1840, uniqueViewers: 214, favourites: 61, canOpen: true },
            { viewId: 'v2', name: 'Customer 360 pipeline', workspaceId: 'ws1', visibility: 'workspace', viewType: 'graph', opens: 1120, uniqueViewers: 142, favourites: 38, canOpen: true },
            { viewId: 'v3', name: 'Finance close', workspaceId: 'ws2', visibility: 'workspace', viewType: 'reference', opens: 890, uniqueViewers: 96, favourites: 24, canOpen: true },
            { viewId: 'v4', name: 'Marketing attribution', workspaceId: 'ws3', visibility: 'private', viewType: 'hierarchy', opens: 610, uniqueViewers: 51, favourites: 12, canOpen: true },
        ],
        topWorkspaces: [
            { workspaceId: 'ws1', name: 'Data Platform', activity: 18400, opens: 9200, canOpen: true },
            { workspaceId: 'ws2', name: 'Finance', activity: 9100, opens: 4800, canOpen: true },
            { workspaceId: 'ws3', name: 'Growth', activity: 5200, opens: 2600, canOpen: true },
        ],
        topCreators: [
            { userId: 'u1', name: 'Ada Lovelace', viewsCreated: 31 },
            { userId: 'u2', name: 'Grace Hopper', viewsCreated: 24 },
            { userId: 'u3', name: 'Katherine Johnson', viewsCreated: 18 },
        ],
    },
    graph: { nodes: 7_740_000, edges: 21_400_000, entityTypes: 42, sourcesWithStats: 108 },
    adoption: [
        { key: 'lineage', label: 'Lineage tracing', events: 8420, users: 302, previousEvents: 6100, changePct: 38.0, reach: 0.733, since: '2026-04-02T00:00:00+00:00' },
        { key: 'search', label: 'Graph search', events: 5210, users: 268, previousEvents: 4900, changePct: 6.3, reach: 0.65, since: '2026-04-02T00:00:00+00:00' },
        { key: 'views', label: 'Saved views', events: 24810, users: 388, previousEvents: 22400, changePct: 10.8, reach: 0.942, since: '2026-03-11T00:00:00+00:00' },
        { key: 'export', label: 'Export', events: 214, users: 41, previousEvents: 180, changePct: 18.9, reach: 0.1, since: '2026-04-02T00:00:00+00:00' },
        { key: 'versioning', label: 'Version control', events: 96, users: 22, previousEvents: 140, changePct: -31.4, reach: 0.053, since: '2026-04-02T00:00:00+00:00' },
        { key: 'ontology', label: 'Semantic layer', events: 0, users: 0, previousEvents: 0, changePct: null, reach: 0, since: null },
    ],
    valueMoments: {
        traces: 8420, tracesEmpty: 1980, traceSuccessRate: 0.765, tracedBy: 302,
        searches: 5210, searchMisses: 1140, searchHitRate: 0.781,
    },
    health: {
        reliability: {
            refreshes: 2140, failures: 61, successRate: 0.971,
            sourcesRefreshed: 104, sourcesUntouched: 8,
            byOutcome: [
                { key: 'completed', count: 1904 }, { key: 'noop', count: 175 },
                { key: 'failed', count: 44 }, { key: 'error', count: 17 },
            ],
        },
        access: {
            requests: 34, pending: 7, medianHoursToApprove: 18.5,
            oldestPendingDays: 6, invitesSent: 128, invitesRedeemed: 74,
            acceptanceRate: 0.578,
        },
        semanticLayer: {
            sourcesWithOntology: 61, sourcesTotal: 112, coverage: 0.545,
            sourcesDrifting: 4,
        },
    },
    annotations: [
        { bucket: BUCKETS[6], date: BUCKETS[6], title: 'v2.4 shipped — trace presets', kind: 'success' },
    ],
    insights: [
        { key: 'trace-empty', tone: 'bad', headline: '24% of lineage traces come back empty', detail: '1,980 of 8,420 traces in the last 14 days found no lineage. People are asking the core question and not getting an answer.', tab: 'engagement' },
        { key: 'signups', tone: 'good', headline: 'New sign-ups up 35%', detail: '96 new sign-ups in the last 14 days, against 71 in the previous period.', tab: 'growth' },
        { key: 'access-backlog', tone: 'bad', headline: '7 access requests pending', detail: 'The oldest has been waiting 6 days. Every one is someone who wanted to use the platform and cannot.', tab: 'growth' },
        { key: 'signup-mix', tone: 'neutral', headline: 'SSO is 61% of new accounts', detail: '781 of 1,284 accounts created in the last 14 days came in this way.', tab: 'growth' },
        { key: 'concentration', tone: 'watch', headline: 'Top views take 64% of all opens', detail: 'Attention is concentrated in a few views. The rest of the catalogue is not being discovered.', tab: 'content' },
    ],
    coverage: {
        viewOpenTrackingSince: '2026-03-11T00:00:00+00:00',
        trackingSince: {
            lineage: '2026-04-02T00:00:00+00:00', search: '2026-04-02T00:00:00+00:00',
            views: '2026-03-11T00:00:00+00:00', export: '2026-04-02T00:00:00+00:00',
            versioning: '2026-04-02T00:00:00+00:00', ontology: null,
        },
    },
}

/** Aggregate only — nobody is named, operations withheld. */
export const STRICT: AnalyticsSummary = {
    ...PRIVILEGED,
    redaction: {
        applied: true, mode: 'strict',
        showsPeople: false, showsOperations: false, reportsAllWorkspaces: false,
        visibleWorkspaces: 2, accessResolved: true,
        hidden: [
            'Individual activity and names',
            "Names of workspaces you are not in",
            'Access requests, invites and refresh health',
        ],
    },
    leaderboards: {
        ...PRIVILEGED.leaderboards,
        topUsers: [], topCreators: [],
        topViews: [
            PRIVILEGED.leaderboards.topViews[0],
            { ...PRIVILEGED.leaderboards.topViews[1], canOpen: true },
            { viewId: 'v3', name: 'Restricted view', workspaceId: 'ws2', visibility: 'restricted', viewType: 'restricted', opens: 890, uniqueViewers: 96, favourites: 24, redacted: true, canOpen: false },
            { viewId: 'v4', name: 'Restricted view', workspaceId: 'ws3', visibility: 'restricted', viewType: 'restricted', opens: 610, uniqueViewers: 51, favourites: 12, redacted: true, canOpen: false },
        ],
        topWorkspaces: [
            { workspaceId: 'ws1', name: 'Data Platform', activity: 18400, opens: 9200, canOpen: true },
            { workspaceId: 'ws2', name: 'Restricted workspace', activity: 9100, opens: 4800, redacted: true, canOpen: false },
            { workspaceId: 'ws3', name: 'Restricted workspace', activity: 5200, opens: 2600, redacted: true, canOpen: false },
        ],
    },
    health: { semanticLayer: PRIVILEGED.health.semanticLayer },
    insights: PRIVILEGED.insights.filter((i) => i.key !== 'access-backlog'),
}

/** Colleagues named; operations still withheld. The internal default. */
export const INTERNAL: AnalyticsSummary = {
    ...STRICT,
    redaction: {
        ...STRICT.redaction!, mode: 'internal', showsPeople: true,
        hidden: ["Names of workspaces you are not in", 'Access requests, invites and refresh health'],
    },
    leaderboards: {
        ...STRICT.leaderboards,
        topUsers: PRIVILEGED.leaderboards.topUsers.map((u) => ({ ...u, email: null })),
        topCreators: PRIVILEGED.leaderboards.topCreators,
    },
}

/** An operator has opened workspace reporting: every workspace is named,
 *  but the reader still cannot OPEN the ones they are not in. */
export const REPORTED: AnalyticsSummary = {
    ...INTERNAL,
    redaction: {
        ...INTERNAL.redaction!, reportsAllWorkspaces: true,
        hidden: ['Access requests, invites and refresh health'],
    },
    leaderboards: {
        ...INTERNAL.leaderboards,
        topViews: PRIVILEGED.leaderboards.topViews.map((v, i) => ({ ...v, canOpen: i < 2 })),
        topWorkspaces: PRIVILEGED.leaderboards.topWorkspaces.map((w, i) => ({ ...w, canOpen: i === 0 })),
    },
}

/** A brand-new tenant. Zeros everywhere — the state that reads as "this
 *  product is dead" unless it is designed for. */
export const FIRST_RUN: AnalyticsSummary = {
    ...PRIVILEGED,
    totals: Object.fromEntries(
        Object.keys(PRIVILEGED.totals).map((k) => [k, metric(0, 0, 0)]),
    ) as unknown as AnalyticsSummary['totals'],
    series: {
        ...PRIVILEGED.series,
        signups: BUCKETS.map(() => 0), cumulativeUsers: BUCKETS.map(() => 0),
        activeUsers: BUCKETS.map(() => 0), signIns: BUCKETS.map(() => 0),
        viewsCreated: BUCKETS.map(() => 0), cumulativeViews: BUCKETS.map(() => 0),
        workspacesCreated: BUCKETS.map(() => 0), cumulativeWorkspaces: BUCKETS.map(() => 0),
        viewOpens: BUCKETS.map(() => 0), activityEvents: BUCKETS.map(() => 0),
        dataSourcesOnboarded: BUCKETS.map(() => 0),
        previous: {
            signups: BUCKETS.map(() => 0), viewsCreated: BUCKETS.map(() => 0),
            viewOpens: BUCKETS.map(() => 0), activeUsers: BUCKETS.map(() => 0),
        },
    },
    engagement: {
        ...PRIVILEGED.engagement,
        dau: 0, wau: 0, mau: 0, stickiness: null,
        activationRate: null, creationRate: null, medianDaysToFirstView: null,
        funnel: PRIVILEGED.engagement.funnel.map((f) => ({ ...f, count: 0, rate: null })),
        growthAccounting: { new: 0, returning: 0, resurrected: 0, dormant: 0 },
        cohorts: [],
    },
    breakdowns: {
        usersByStatus: [], usersBySignupSource: [], viewsByVisibility: [],
        viewsByType: [], activityByAction: [],
        collaborationRate: null, contentConcentration: null,
    },
    leaderboards: { topUsers: [], topViews: [], topWorkspaces: [], topCreators: [] },
    graph: { nodes: 0, edges: 0, entityTypes: 0, sourcesWithStats: 0 },
    adoption: PRIVILEGED.adoption.map((a) => ({
        ...a, events: 0, users: 0, previousEvents: 0, changePct: null, reach: null, since: null,
    })),
    valueMoments: {
        traces: 0, tracesEmpty: 0, traceSuccessRate: null, tracedBy: 0,
        searches: 0, searchMisses: 0, searchHitRate: null,
    },
    annotations: [],
    insights: [],
    coverage: { viewOpenTrackingSince: null, trackingSince: {} },
}

export const WORKSPACE_ROWS: WorkspaceAnalyticsRow[] = [
    { workspaceId: 'ws1', name: 'Data Platform', createdAt: '2025-11-04T00:00:00+00:00', isActive: true, members: 48, views: 412, newViews: 21, dataSources: 34, activity: 18400, opens: 9200, activeUsers: 44, nodes: 4_100_000, edges: 12_800_000, lastActivityAt: '2026-06-15T09:12:00+00:00', dormant: false, canOpen: true },
    { workspaceId: 'ws2', name: 'Finance', createdAt: '2026-01-18T00:00:00+00:00', isActive: true, members: 22, views: 187, newViews: 9, dataSources: 12, activity: 9100, opens: 4800, activeUsers: 19, nodes: 2_200_000, edges: 5_900_000, lastActivityAt: '2026-06-14T17:40:00+00:00', dormant: false, canOpen: true },
    { workspaceId: 'ws3', name: 'Growth', createdAt: '2026-03-02T00:00:00+00:00', isActive: true, members: 11, views: 96, newViews: 3, dataSources: 7, activity: 5200, opens: 2600, activeUsers: 8, nodes: 980_000, edges: 2_100_000, lastActivityAt: '2026-06-11T08:05:00+00:00', dormant: false, canOpen: true },
    { workspaceId: 'ws4', name: 'Archive 2024', createdAt: '2024-06-01T00:00:00+00:00', isActive: true, members: 4, views: 41, newViews: 0, dataSources: 2, activity: 0, opens: 0, activeUsers: 0, nodes: 310_000, edges: 640_000, lastActivityAt: '2025-12-02T11:00:00+00:00', dormant: true, canOpen: true },
]

/** Two of the four locked — the state a member of one team actually sees. */
export const WORKSPACE_ROWS_LOCKED: WorkspaceAnalyticsRow[] = [
    WORKSPACE_ROWS[0],
    ...WORKSPACE_ROWS.slice(1, 3).map((r) => ({
        ...r, name: 'Restricted workspace', redacted: true, canOpen: false,
        members: null, views: null, newViews: null, dataSources: null,
        activity: null, opens: null, activeUsers: null, nodes: null, edges: null,
        lastActivityAt: null, dormant: false,
    })),
    WORKSPACE_ROWS[3],
]

export const ANALYTICS_FIXTURES = {
    privileged: { summary: PRIVILEGED, rows: WORKSPACE_ROWS },
    strict: { summary: STRICT, rows: WORKSPACE_ROWS_LOCKED },
    internal: { summary: INTERNAL, rows: WORKSPACE_ROWS_LOCKED },
    reported: { summary: REPORTED, rows: WORKSPACE_ROWS },
    firstRun: { summary: FIRST_RUN, rows: [] as WorkspaceAnalyticsRow[] },
} as const

export type AnalyticsFixtureName = keyof typeof ANALYTICS_FIXTURES
