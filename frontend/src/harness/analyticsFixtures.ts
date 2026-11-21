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
    AnalyticsCollaborationDoc, AnalyticsDataDoc, AnalyticsSummary, AnalyticsUsageDoc,
    DiscussedView, WorkspaceAnalyticsDetail, WorkspaceAnalyticsRow,
} from '../services/analyticsService'

const BUCKETS = Array.from({ length: 14 }, (_, i) => {
    const d = new Date(Date.UTC(2026, 5, 2 + i))
    return d.toISOString().slice(0, 10)
})

const PREV_BUCKETS = Array.from({ length: 14 }, (_, i) => {
    const d = new Date(Date.UTC(2026, 4, 19 + i))
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
        layoutTemplates: metric(310, 12, 15),
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
            buckets: PREV_BUCKETS,
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
        contentConcentration: 0.64, viewsNotOpened: 590, viewsNotOpenedShare: 0.643,
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
            { viewId: 'v1', createdByName: 'Ada Lovelace', createdByEmail: 'ada@example.com', name: 'Revenue lineage', workspaceId: 'ws1', visibility: 'enterprise', viewType: 'reference', opens: 1840, uniqueViewers: 214, favourites: 61, canOpen: true },
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
        { key: 'trace-empty', tone: 'bad', headline: '24% of lineage traces come back empty', detail: '1,980 of 8,420 traces in the last 14 days found no lineage. People are asking the core question and not getting an answer.', tab: 'engagement', spark: null },
        { key: 'signups', tone: 'good', headline: 'New sign-ups up 35%', detail: '96 new sign-ups in the last 14 days, against 71 in the previous period.', tab: 'growth', spark: signups },
        { key: 'access-backlog', tone: 'bad', headline: '7 access requests pending', detail: 'The oldest has been waiting 6 days. Every one is someone who wanted to use the platform and cannot.', tab: 'growth', spark: null },
        { key: 'signup-mix', tone: 'neutral', headline: 'SSO is 61% of new accounts', detail: '781 of 1,284 accounts created in the last 14 days came in this way.', tab: 'growth', spark: null },
        { key: 'concentration', tone: 'watch', headline: 'Top views take 64% of all opens', detail: 'Attention is concentrated in a few views. The rest of the catalogue is not being discovered.', tab: 'content', spark: null },
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
            buckets: PREV_BUCKETS,
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
        collaborationRate: null, contentConcentration: null, viewsNotOpened: 0, viewsNotOpenedShare: null,
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

// ── The Data tab's document ──────────────────────────────────────────

/** A level that grows most days and drops once — a source pruned on day 7. */
const ENTITIES = running(410_000, BUCKETS.map((_, i) =>
    i === 6 ? -9_000 : Math.round(2_400 + Math.abs(Math.sin(i * 1.3)) * 3_000)))
const share = (values: number[], ratio: number) => values.map((v) => Math.round(v * ratio))
const level = (start: number, end: number) => ({
    start, end, change: end - start,
    changePct: start ? Math.round(((end - start) / start) * 1000) / 10 : null,
})
const ONBOARDED = [0, 1, 0, 2, 1, 0, 0, 3, 1, 0, 1, 0, 2, 1]
const VERSIONED = [0, 1, 0, 1, 0, 0, 0, 1, 1, 0, 0, 0, 1, 0]

export const DATA_PRIVILEGED: AnalyticsDataDoc = {
    windowDays: 14,
    generatedAt: PRIVILEGED.generatedAt,
    range: PRIVILEGED.range,
    bucket: 'day',
    coverage: { entitiesSince: '2026-04-20', jobsKeptDays: 90 },
    growth: {
        buckets: BUCKETS,
        entities: ENTITIES,
        relationships: ENTITIES.map((v, i) => Math.round(v * 2.6 + i * 900)),
        totals: {
            entities: level(ENTITIES[0], ENTITIES[ENTITIES.length - 1]),
            relationships: level(Math.round(ENTITIES[0] * 2.6), Math.round(ENTITIES[ENTITIES.length - 1] * 2.6 + 13 * 900)),
            sources: 58,
        },
        byWorkspace: [
            { workspaceId: 'ws1', name: 'Data Platform', entities: share(ENTITIES, 0.46) },
            { workspaceId: 'ws2', name: 'Finance', entities: share(ENTITIES, 0.27) },
            { workspaceId: 'ws3', name: 'Growth', entities: share(ENTITIES, 0.15) },
            { workspaceId: 'ws4', name: 'Archive 2024', entities: share(ENTITIES, 0.07) },
            { workspaceId: null, name: 'Other', entities: share(ENTITIES, 0.05) },
        ],
        byProviderType: [
            { key: 'neo4j', entities: share(ENTITIES, 0.52) },
            { key: 'falkordb', entities: share(ENTITIES, 0.31) },
            { key: 'datahub', entities: share(ENTITIES, 0.12) },
            { key: 'spanner', entities: share(ENTITIES, 0.05) },
        ],
        movers: [
            { dataSourceId: 'ds1', name: 'Warehouse lineage', workspaceId: 'ws1', workspaceName: 'Data Platform', canOpen: true, ...level(84_000, 101_500) },
            { dataSourceId: 'ds2', name: 'Ledger', workspaceId: 'ws2', workspaceName: 'Finance', canOpen: true, ...level(41_200, 32_200) },
            { dataSourceId: 'ds3', name: 'Events catalogue', workspaceId: 'ws3', workspaceName: 'Growth', canOpen: true, ...level(0, 6_400) },
            { dataSourceId: 'ds4', name: 'dbt models', workspaceId: 'ws1', workspaceName: 'Data Platform', canOpen: true, ...level(12_900, 15_100) },
            { dataSourceId: 'ds5', name: 'Payments', workspaceId: 'ws2', workspaceName: 'Finance', canOpen: true, ...level(8_800, 9_900) },
        ],
    },
    onboarding: {
        buckets: BUCKETS,
        total: ONBOARDED,
        versioned: VERSIONED,
        external: ONBOARDED.map((n, i) => n - VERSIONED[i]),
        totals: { sources: metric(58, 12, 7) },
        byProviderType: [
            { key: 'neo4j', count: 5 }, { key: 'falkordb', count: 4 },
            { key: 'datahub', count: 2 }, { key: 'spanner', count: 1 },
        ],
        firstBuild: { medianHours: 5.4, p90Hours: 31, measured: 11, awaiting: 1 },
    },
    versionControl: {
        available: true,
        byKind: [
            { key: 'authoritative', count: 9 }, { key: 'manual', count: 4 },
            { key: 'hybrid', count: 3 }, { key: 'blank', count: 1 },
        ],
        adopted: {
            buckets: BUCKETS,
            series: [
                { key: 'authoritative', values: [0, 1, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 1, 0] },
                { key: 'manual', values: [0, 0, 0, 0, 0, 0, 0, 1, 0, 0, 0, 0, 0, 0] },
            ],
        },
        share: { versioned: 17, total: 58 },
    },
    details: {
        sources: 58, described: 41, tagged: 33, withContacts: 26,
        trust: [
            { key: 'certified', count: 17 }, { key: 'in_review', count: 6 },
            { key: 'deprecated', count: 3 }, { key: 'none', count: 32 },
        ],
        classification: [
            { key: 'public', count: 4 }, { key: 'internal', count: 22 },
            { key: 'confidential', count: 11 }, { key: 'restricted', count: 2 },
            { key: 'none', count: 19 },
        ],
        topTags: [
            { key: 'finance', count: 14 }, { key: 'pii', count: 9 }, { key: 'dbt', count: 8 },
            { key: 'marketing', count: 6 }, { key: 'month-end', count: 5 }, { key: 'events', count: 4 },
            { key: 'gold', count: 3 },
        ],
        byWorkspace: [
            { workspaceId: 'ws1', name: 'Data Platform', sources: 34, described: 27, tagged: 22, withContacts: 18, certified: 11, canOpen: true },
            { workspaceId: 'ws2', name: 'Finance', sources: 12, described: 10, tagged: 8, withContacts: 6, certified: 5, canOpen: true },
            { workspaceId: 'ws3', name: 'Growth', sources: 7, described: 3, tagged: 2, withContacts: 1, certified: 1, canOpen: true },
            { workspaceId: 'ws4', name: 'Archive 2024', sources: 2, described: 0, tagged: 0, withContacts: 0, certified: 0, canOpen: true },
        ],
    },
    requests: {
        data: {
            asked: metric(64, 9, 6), connected: 5, declined: 1, open: 7,
            openByUrgency: [
                { key: 'this_week', count: 2 }, { key: 'this_month', count: 3 }, { key: 'no_rush', count: 2 },
            ],
            medianHoursToConnect: 52,
        },
        workspaces: {
            submitted: metric(23, 4, 2), approved: 3, declined: 0, open: 2,
            changesRequested: 1, medianHoursToDecision: 19,
        },
    },
}

/** As a member of one team sees it: two of the workspaces are not theirs. */
const hidden = new Set(['ws2', 'ws3'])
export const DATA_LOCKED: AnalyticsDataDoc = {
    ...DATA_PRIVILEGED,
    growth: {
        ...DATA_PRIVILEGED.growth,
        byWorkspace: DATA_PRIVILEGED.growth.byWorkspace.map((b) => (
            b.workspaceId && hidden.has(b.workspaceId) ? { ...b, name: 'Restricted workspace', redacted: true } : b)),
        movers: DATA_PRIVILEGED.growth.movers.map((m) => (
            m.workspaceId && hidden.has(m.workspaceId)
                ? {
                    ...m, name: 'Restricted source', dataSourceId: null, workspaceId: null,
                    workspaceName: 'Restricted workspace', redacted: true, canOpen: false,
                }
                : m)),
    },
    details: {
        ...DATA_PRIVILEGED.details!,
        // `marketing` and `events` are only used in workspaces not theirs.
        topTags: DATA_PRIVILEGED.details!.topTags.filter((t) => !['marketing', 'events'].includes(t.key)),
        byWorkspace: DATA_PRIVILEGED.details!.byWorkspace.map((r) => (
            r.workspaceId && hidden.has(r.workspaceId)
                ? { ...r, workspaceId: null, name: 'Restricted workspace', redacted: true, canOpen: false }
                : r)),
    },
    // Below the posture that shows operations.
    requests: undefined,
    redaction: { applied: true, reportsAllWorkspaces: false, showsOperations: false },
}

const zeros = BUCKETS.map(() => 0)
export const DATA_FIRST_RUN: AnalyticsDataDoc = {
    ...DATA_PRIVILEGED,
    coverage: { entitiesSince: null, jobsKeptDays: 90 },
    growth: {
        buckets: BUCKETS, entities: zeros, relationships: zeros,
        totals: { entities: level(0, 0), relationships: level(0, 0), sources: 0 },
        byWorkspace: [], byProviderType: [], movers: [],
    },
    onboarding: {
        buckets: BUCKETS, total: zeros, versioned: zeros, external: zeros,
        totals: { sources: metric(0, 0, 0) }, byProviderType: [],
        firstBuild: { medianHours: null, p90Hours: null, measured: 0, awaiting: 0 },
    },
    versionControl: {
        available: true, byKind: [],
        adopted: { buckets: BUCKETS, series: [] }, share: { versioned: 0, total: 0 },
    },
    details: {
        sources: 0, described: 0, tagged: 0, withContacts: 0,
        trust: DATA_PRIVILEGED.details!.trust.map((t) => ({ ...t, count: 0 })),
        classification: DATA_PRIVILEGED.details!.classification.map((c) => ({ ...c, count: 0 })),
        topTags: [], byWorkspace: [],
    },
    requests: {
        data: {
            asked: metric(0, 0, 0), connected: 0, declined: 0, open: 0,
            openByUrgency: DATA_PRIVILEGED.requests!.data.openByUrgency.map((u) => ({ ...u, count: 0 })),
            medianHoursToConnect: null,
        },
        workspaces: {
            submitted: metric(0, 0, 0), approved: 0, declined: 0, open: 0,
            changesRequested: 0, medianHoursToDecision: null,
        },
    },
}

// ── The Collaboration tab's document ─────────────────────────────────

const ASKED = series(9, 0.11)
const ANSWERED = ASKED.map((v, i) => Math.max(0, v - (i % 3 === 0 ? 2 : 1)))
const sum = (values: number[]) => values.reduce((a, b) => a + b, 0)

const discussed = (questions: number, replies: number, answered: number, open: number) => ({
    questions, replies, messages: questions + replies, answered, open, canOpen: true,
})

export const COLLAB_PRIVILEGED: AnalyticsCollaborationDoc = {
    windowDays: 14,
    generatedAt: PRIVILEGED.generatedAt,
    range: PRIVILEGED.range,
    bucket: 'day',
    kpis: {
        asked: metric(412, sum(ASKED), 51),
        answerRate: {
            current: Math.round((sum(ANSWERED) / sum(ASKED)) * 1000) / 1000,
            previous: 0.64, answered: sum(ANSWERED),
        },
        firstResponseHours: { current: 5.5, previous: 7.2, changePct: -23.6, measured: 44 },
        answerHours: { current: 26, previous: 31.5, changePct: -17.5, measured: 27 },
        waitingOverWeek: { total: 5 },
        open: { total: 19 },
        askers: metric(38, 38, 33),
        answerers: metric(21, 21, 24),
        replies: metric(186, 186, 152),
        privateShare: { current: 0.12, previous: 0.09 },
    },
    series: { buckets: BUCKETS, asked: ASKED, answered: ANSWERED },
    leaderboards: {
        views: [
            { viewId: 'v1', name: 'Revenue lineage', workspaceId: 'ws2', workspaceName: 'Finance', visibility: 'workspace', ...discussed(9, 23, 7, 3) },
            { viewId: 'v2', name: 'Customer 360', workspaceId: 'ws1', workspaceName: 'Data Platform', visibility: 'enterprise', ...discussed(6, 14, 5, 1) },
            { viewId: 'v3', name: 'Orders pipeline', workspaceId: 'ws1', workspaceName: 'Data Platform', visibility: 'workspace', ...discussed(5, 9, 3, 2) },
            { viewId: 'v4', name: 'Marketing attribution', workspaceId: 'ws3', workspaceName: 'Growth', visibility: 'private', ...discussed(3, 7, 1, 2) },
            { viewId: 'v5', name: 'Churn model inputs', workspaceId: 'ws3', workspaceName: 'Growth', visibility: 'workspace', ...discussed(2, 4, 2, 0) },
            { viewId: 'v6', name: 'Warehouse overview', workspaceId: 'ws1', workspaceName: 'Data Platform', visibility: 'enterprise', ...discussed(1, 3, 1, 0) },
        ],
        sources: [
            { dataSourceId: 'ds2', name: 'Ledger', workspaceId: 'ws2', workspaceName: 'Finance', ...discussed(7, 18, 5, 2) },
            { dataSourceId: 'ds1', name: 'Warehouse lineage', workspaceId: 'ws1', workspaceName: 'Data Platform', ...discussed(5, 11, 4, 1) },
            { dataSourceId: 'ds3', name: 'Events catalogue', workspaceId: 'ws3', workspaceName: 'Growth', ...discussed(4, 6, 2, 2) },
            { dataSourceId: 'ds5', name: 'Payments', workspaceId: 'ws2', workspaceName: 'Finance', ...discussed(2, 2, 2, 0) },
            { dataSourceId: 'ds6', name: 'CRM', workspaceId: 'ws1', workspaceName: 'Data Platform', ...discussed(1, 0, 0, 1) },
        ],
        workspaces: [
            { workspaceId: 'ws2', name: 'Finance', questions: 18, answered: 14, answerRate: 0.778, firstResponseHours: 4.2, replies: 43, canOpen: true },
            { workspaceId: 'ws1', name: 'Data Platform', questions: 18, answered: 14, answerRate: 0.778, firstResponseHours: 3.1, replies: 37, canOpen: true },
            { workspaceId: 'ws3', name: 'Growth', questions: 9, answered: 5, answerRate: 0.556, firstResponseHours: 11.5, replies: 17, canOpen: true },
            { workspaceId: 'ws4', name: 'Archive 2024', questions: 1, answered: 0, answerRate: 0, firstResponseHours: null, replies: 0, canOpen: true },
        ],
        answerers: [
            { userId: 'u1', name: 'Priya Raman', accepted: 9, replies: 31 },
            { userId: 'u2', name: 'Tom Okafor', accepted: 7, replies: 22 },
            { userId: 'u3', name: 'Lena Fischer', accepted: 5, replies: 19 },
            { userId: 'u4', name: 'Marco Rossi', accepted: 3, replies: 12 },
            { userId: 'u5', name: 'Ada Lovelace', accepted: 2, replies: 9 },
            { userId: 'u6', name: 'Sam Chen', accepted: 1, replies: 14 },
        ],
        waiting: [
            { discussionId: 'd1', subjectType: 'data_source', subjectId: 'ds2', subjectName: 'Ledger', workspaceId: 'ws2', workspaceName: 'Finance', askedAt: '2026-05-23T09:00:00+00:00', ageDays: 23, replies: 2, private: false, excerpt: 'Why does the daily balance here differ from the finance close?', askedByName: 'Asha Patel', canOpen: true },
            { discussionId: 'd2', subjectType: 'view', subjectId: 'v4', subjectName: 'Marketing attribution', workspaceId: 'ws3', workspaceName: 'Growth', askedAt: '2026-05-29T09:00:00+00:00', ageDays: 17, replies: 0, private: true, excerpt: null, askedByName: 'Bo Lindqvist', canOpen: true },
            { discussionId: 'd3', subjectType: 'view', subjectId: 'v2', subjectName: 'Customer 360', workspaceId: 'ws1', workspaceName: 'Data Platform', askedAt: '2026-06-03T09:00:00+00:00', ageDays: 12, replies: 1, private: false, excerpt: 'Is the churn flag computed nightly or on demand?', askedByName: 'Chen Wei', canOpen: true },
            { discussionId: 'd4', subjectType: 'data_source', subjectId: 'ds3', subjectName: 'Events catalogue', workspaceId: 'ws3', workspaceName: 'Growth', askedAt: '2026-06-06T09:00:00+00:00', ageDays: 9, replies: 0, private: false, excerpt: 'Which events are deduplicated before they land here?', askedByName: 'Dana Ortiz', canOpen: true },
            { discussionId: 'd5', subjectType: 'view', subjectId: 'v3', subjectName: 'Orders pipeline', workspaceId: 'ws1', workspaceName: 'Data Platform', askedAt: '2026-06-07T09:00:00+00:00', ageDays: 8, replies: 3, private: false, excerpt: 'What does the dashed edge between staging and orders mean?', askedByName: 'Eli Novak', canOpen: true },
            { discussionId: 'd6', subjectType: 'data_source', subjectId: 'ds1', subjectName: 'Warehouse lineage', workspaceId: 'ws1', workspaceName: 'Data Platform', askedAt: '2026-06-10T09:00:00+00:00', ageDays: 5, replies: 0, private: false, excerpt: 'Can the dbt docs be linked from this source?', askedByName: 'Fay Morgan', canOpen: true },
            { discussionId: 'd7', subjectType: 'view', subjectId: 'v1', subjectName: 'Revenue lineage', workspaceId: 'ws2', workspaceName: 'Finance', askedAt: '2026-06-13T09:00:00+00:00', ageDays: 2, replies: 1, private: false, excerpt: 'Who owns the FX conversion step?', askedByName: 'Gus Hale', canOpen: true },
        ],
    },
}

/** As a member of Data Platform and Archive 2024 sees it — the same rules as
 *  `analytics_collaboration_repo.redact_collaboration`. */
const hiddenView = (v: DiscussedView): boolean =>
    v.visibility !== 'enterprise' && !!v.workspaceId && hidden.has(v.workspaceId)
export const COLLAB_STRICT: AnalyticsCollaborationDoc = {
    ...COLLAB_PRIVILEGED,
    leaderboards: {
        views: COLLAB_PRIVILEGED.leaderboards.views.map((v) => (hiddenView(v)
            ? { ...v, viewId: null, name: 'Restricted view', workspaceId: null, workspaceName: 'Restricted workspace', visibility: 'restricted', redacted: true, canOpen: false }
            : v)),
        sources: COLLAB_PRIVILEGED.leaderboards.sources.map((s) => (s.workspaceId && hidden.has(s.workspaceId)
            ? { ...s, dataSourceId: null, name: 'Restricted source', workspaceId: null, workspaceName: 'Restricted workspace', redacted: true, canOpen: false }
            : s)),
        workspaces: COLLAB_PRIVILEGED.leaderboards.workspaces.map((w) => (hidden.has(w.workspaceId)
            ? { ...w, name: 'Restricted workspace', redacted: true, canOpen: false }
            : w)),
        answerers: [],
        waiting: COLLAB_PRIVILEGED.leaderboards.waiting.map(({ excerpt: _e, askedByName: _a, ...q }) => (
            q.private || (q.workspaceId && hidden.has(q.workspaceId))
                ? {
                    ...q, discussionId: null, subjectId: null, subjectName: null,
                    workspaceId: q.workspaceId && !hidden.has(q.workspaceId) ? q.workspaceId : null,
                    workspaceName: q.workspaceId && !hidden.has(q.workspaceId) ? q.workspaceName : null,
                    redacted: true, canOpen: false,
                }
                : q)),
    },
    redaction: {
        applied: true, showsPeople: false, reportsAllWorkspaces: false,
        hidden: ['Who answers most', 'What was asked, and by whom'],
    },
}

/** Questions are on, and nobody has asked one yet. */
export const COLLAB_EMPTY: AnalyticsCollaborationDoc = {
    ...COLLAB_PRIVILEGED,
    kpis: {
        asked: metric(0, 0, 0),
        answerRate: { current: null, previous: null, answered: 0 },
        firstResponseHours: { current: null, previous: null, changePct: null, measured: 0 },
        answerHours: { current: null, previous: null, changePct: null, measured: 0 },
        waitingOverWeek: { total: 0 }, open: { total: 0 },
        askers: metric(0, 0, 0), answerers: metric(0, 0, 0), replies: metric(0, 0, 0),
        privateShare: { current: null, previous: null },
    },
    series: { buckets: BUCKETS, asked: zeros, answered: zeros },
    leaderboards: { views: [], sources: [], workspaces: [], answerers: [], waiting: [] },
}

// ── One workspace's drill-in ─────────────────────────────────────────

export const DETAIL_PRIVILEGED: WorkspaceAnalyticsDetail = {
    workspaceId: 'ws1', name: 'Data Platform',
    description: 'Warehouse, pipelines and the lineage between them',
    createdAt: '2025-11-04T00:00:00+00:00', isActive: true,
    windowDays: 14, generatedAt: PRIVILEGED.generatedAt, range: PRIVILEGED.range, bucket: 'day',
    totals: {
        views: metric(412, 21, 17), viewOpens: metric(9200, 9200, 8100),
        activeUsers: metric(44, 44, 39), activity: metric(18400, 18400, 16900),
        members: { total: 48 }, dataSources: { total: 34 }, layoutTemplates: { total: 12 },
    },
    series: {
        buckets: BUCKETS,
        viewsCreated: series(4, 0.08), cumulativeViews: running(391, series(4, 0.08)),
        activityEvents: series(5, 22), activeUsers: series(2, 0.9), viewOpens: series(3, 12),
        entities: share(ENTITIES, 0.46), relationships: share(ENTITIES, 1.2),
    },
    growth: { entities: level(188_600, 196_400), relationships: level(492_000, 511_000) },
    breakdowns: {
        viewsByVisibility: [{ key: 'workspace', count: 230 }, { key: 'enterprise', count: 92 }, { key: 'private', count: 90 }],
        viewsByType: [{ key: 'graph', count: 210 }, { key: 'reference', count: 120 }, { key: 'layered-lineage', count: 82 }],
        activityByAction: [{ key: 'updated', count: 9800 }, { key: 'created', count: 3100 }],
    },
    topViews: PRIVILEGED.leaderboards.topViews.slice(0, 4),
    topContributors: [
        { userId: 'u1', name: 'Priya Raman', events: 1840 },
        { userId: 'u2', name: 'Tom Okafor', events: 1210 },
        { userId: 'u3', name: 'Lena Fischer', events: 960 },
    ],
    graph: { nodes: 4_100_000, edges: 12_800_000, entityTypes: 31, sourcesWithStats: 34 },
    collaboration: {
        asked: metric(96, 18, 15),
        answerRate: { current: 0.778, previous: 0.7, answered: 14 },
        firstResponseHours: { current: 3.1, previous: 4.4, changePct: -29.5, measured: 16 },
        waitingOverWeek: { total: 2 },
        open: { total: 6 },
        views: COLLAB_PRIVILEGED.leaderboards.views.filter((v) => v.workspaceId === 'ws1'),
        sources: COLLAB_PRIVILEGED.leaderboards.sources.filter((s) => s.workspaceId === 'ws1'),
    },
    sourceDetails: {
        sources: 34, described: 27, tagged: 22, withContacts: 18,
        trust: [
            { key: 'certified', count: 11 }, { key: 'in_review', count: 4 },
            { key: 'deprecated', count: 2 }, { key: 'none', count: 17 },
        ],
        classification: DATA_PRIVILEGED.details!.classification,
    },
}

/** A member at the strict level — as the server redacts the drill-in for
 *  them: the people are withheld; its questions are counts and views they
 *  may open, so those stay. */
export const DETAIL_STRICT: WorkspaceAnalyticsDetail = {
    ...DETAIL_PRIVILEGED,
    topContributors: [],
    operations: undefined,
    redaction: { applied: true, showsPeople: false, member: true },
}

// ── The usage document ───────────────────────────────────────────────

/** Office hours, Monday to Friday, with a lighter Saturday morning. */
const PUNCHCARD = Array.from({ length: 7 }, (_, day) => Array.from({ length: 24 }, (_, hour) => {
    if (day === 6) return 0
    if (day === 5) return hour >= 9 && hour < 12 ? 6 : 0
    const office = hour >= 8 && hour < 18
    return office ? Math.round(30 + Math.sin((hour - 8) / 3) * 25 + day * 4) : hour >= 6 && hour < 21 ? 4 : 0
}))

const PULSE = [
    { workspaceId: 'ws1', name: 'Data Platform', values: series(3, 1.4) },
    { workspaceId: 'ws2', name: 'Finance', values: series(5, 0.9) },
    { workspaceId: 'ws3', name: 'Growth', values: series(8, 0.6).map((v, i) => (i >= 6 && i <= 8 ? 0 : v)) },
    { workspaceId: 'ws4', name: 'Archive 2024', values: BUCKETS.map((_, i) => (i < 2 ? 3 : 0)) },
].map((p) => ({ ...p, total: p.values.reduce((a, b) => a + b, 0), canOpen: true }))

export const USAGE_PRIVILEGED: AnalyticsUsageDoc = {
    windowDays: 14,
    generatedAt: PRIVILEGED.generatedAt,
    range: PRIVILEGED.range,
    bucket: 'day',
    content: {
        buckets: BUCKETS,
        uniqueViewers: series(2, 0.9),
        viewers: metric(212, 212, 188),
        viewsOpened: 146,
        reach: [
            { key: '1', count: 58 }, { key: '2–5', count: 61 },
            { key: '6–20', count: 22 }, { key: '21+', count: 5 },
        ],
        byType: [
            { key: 'graph', built: 31, opens: 2210 }, { key: 'reference', built: 9, opens: 940 },
            { key: 'layered-lineage', built: 14, opens: 310 }, { key: 'list', built: 9, opens: 85 },
        ],
        byVisibility: [
            { key: 'workspace', built: 29, opens: 2400 }, { key: 'enterprise', built: 10, opens: 780 },
            { key: 'private', built: 24, opens: 365 },
        ],
        firstOpen: { medianHours: 9.5, withinWeek: 38, opened: 44, built: 63 },
    },
    engagement: {
        presence: [
            { key: 'active', count: 412 }, { key: 'seen', count: 160 }, { key: 'recent', count: 290 },
            { key: 'dormant', count: 330 }, { key: 'never', count: 92 },
        ],
        punchcard: PUNCHCARD,
    },
    health: {
        buckets: BUCKETS,
        runs: [
            { key: 'byHand', values: series(6, 0.12) },
            { key: 'automatic', values: series(1, 0.5) },
            { key: 'onboarding', values: ONBOARDED },
            { key: 'other', values: BUCKETS.map((_, i) => (i % 5 === 0 ? 1 : 0)) },
        ],
        totals: { byHand: 41, automatic: 233, onboarding: 12, other: 3 },
        byHand: metric(41, 41, 29),
        manualShare: 0.1419,
        failureRate: 0.062,
        handsOnSources: [
            { dataSourceId: 'ds2', workspaceId: 'ws2', count: 14, lastAt: '2026-06-15T08:10:00+00:00', medianGapHours: 22, name: 'Ledger' },
            { dataSourceId: 'ds1', workspaceId: 'ws1', count: 9, lastAt: '2026-06-14T16:00:00+00:00', medianGapHours: 40, name: 'Warehouse lineage' },
            { dataSourceId: 'ds3', workspaceId: 'ws3', count: 5, lastAt: '2026-06-12T10:30:00+00:00', medianGapHours: 70, name: 'Events catalogue' },
            { dataSourceId: 'ds5', workspaceId: 'ws2', count: 3, lastAt: '2026-06-09T09:00:00+00:00', medianGapHours: null, name: 'Payments' },
        ],
    },
    workspaces: {
        buckets: BUCKETS,
        pulse: PULSE,
        rows: [
            { workspaceId: 'ws1', activity: PULSE[0].total, manualOperations: 9, accessChanges: 6 },
            { workspaceId: 'ws2', activity: PULSE[1].total, manualOperations: 17, accessChanges: 2 },
            { workspaceId: 'ws3', activity: PULSE[2].total, manualOperations: 5, accessChanges: 0 },
            { workspaceId: 'ws4', activity: PULSE[3].total, manualOperations: 0, accessChanges: 1 },
        ],
    },
}

/** Below the posture that shows operations, with two workspaces not theirs. */
export const USAGE_LOCKED: AnalyticsUsageDoc = {
    ...USAGE_PRIVILEGED,
    health: undefined,
    workspaces: {
        ...USAGE_PRIVILEGED.workspaces,
        pulse: PULSE.map((p) => (hidden.has(p.workspaceId)
            ? { ...p, name: 'Restricted workspace', redacted: true, canOpen: false } : p)),
        rows: USAGE_PRIVILEGED.workspaces.rows.map((r) => ({ ...r, manualOperations: null, accessChanges: null })),
    },
    redaction: { applied: true, showsOperations: false, hidden: ['operations'] },
}

export const USAGE_FIRST_RUN: AnalyticsUsageDoc = {
    ...USAGE_PRIVILEGED,
    content: {
        buckets: BUCKETS, uniqueViewers: zeros, viewers: metric(0, 0, 0), viewsOpened: 0,
        reach: USAGE_PRIVILEGED.content.reach.map((r) => ({ ...r, count: 0 })),
        byType: [], byVisibility: [],
        firstOpen: { medianHours: null, withinWeek: 0, opened: 0, built: 0 },
    },
    engagement: {
        presence: USAGE_PRIVILEGED.engagement.presence.map((p) => ({ ...p, count: p.key === 'active' ? 1 : 0 })),
        punchcard: PUNCHCARD.map((row) => row.map(() => 0)),
    },
    health: {
        ...USAGE_PRIVILEGED.health!,
        runs: USAGE_PRIVILEGED.health!.runs.map((r) => ({ ...r, values: zeros })),
        totals: { byHand: 0, automatic: 0, onboarding: 0, other: 0 },
        byHand: metric(0, 0, 0), manualShare: null, failureRate: null, handsOnSources: [],
    },
    workspaces: { buckets: BUCKETS, pulse: [], rows: [] },
}

export const ANALYTICS_FIXTURES = {
    privileged: {
        summary: PRIVILEGED, rows: WORKSPACE_ROWS, data: DATA_PRIVILEGED, usage: USAGE_PRIVILEGED,
        collaboration: COLLAB_PRIVILEGED, detail: DETAIL_PRIVILEGED,
    },
    strict: {
        summary: STRICT, rows: WORKSPACE_ROWS_LOCKED, data: DATA_LOCKED, usage: USAGE_LOCKED,
        collaboration: COLLAB_STRICT, detail: DETAIL_STRICT,
    },
    internal: {
        summary: INTERNAL, rows: WORKSPACE_ROWS_LOCKED, data: DATA_LOCKED, usage: USAGE_LOCKED,
        collaboration: COLLAB_STRICT, detail: DETAIL_STRICT,
    },
    reported: {
        summary: REPORTED, rows: WORKSPACE_ROWS, data: DATA_PRIVILEGED, usage: USAGE_LOCKED,
        collaboration: COLLAB_STRICT, detail: DETAIL_STRICT,
    },
    firstRun: {
        summary: FIRST_RUN, rows: [] as WorkspaceAnalyticsRow[],
        data: DATA_FIRST_RUN, usage: USAGE_FIRST_RUN,
        collaboration: COLLAB_EMPTY, detail: DETAIL_PRIVILEGED,
    },
} as const

export type AnalyticsFixtureName = keyof typeof ANALYTICS_FIXTURES
