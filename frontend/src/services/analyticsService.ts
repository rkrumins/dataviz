/**
 * Platform analytics service — business insights across the whole application.
 *
 * Backs the Analytics section. Server-gated on `system:audit:read` OR
 * `system:org-admin`; the sidebar hides the section for anyone holding neither,
 * so a 403 here means the two have drifted apart.
 *
 * These types ARE the contract. The endpoint returns a wide analytics document
 * rather than a domain entity, so the backend types it loosely on purpose and
 * this file is where its shape is written down.
 */
import { authFetch } from './apiClient'

const ANALYTICS_API = '/api/v1/admin/analytics'

/** A count with its period-over-period movement. */
export interface Metric {
    /** All-time total. */
    total: number
    /** Count inside the selected window. */
    current?: number
    /** The same measure over the immediately preceding window of equal length. */
    previous?: number
    /** Percent change, or `null` when the previous window had no base. */
    changePct?: number | null
}

export interface AnalyticsRange {
    from: string
    to: string
    previousFrom: string
    previousTo: string
}

export interface PlatformTotals {
    users: Metric
    activeUsers: Metric
    workspaces: Metric
    views: Metric
    viewOpens: Metric
    dataSources: Metric
    activity: Metric
    ontologies: Metric
    contextModels: Metric
    catalogItems: Metric
    groups: Metric
}

/** Every series shares `buckets` as its x-axis, so charts can never disagree. */
export interface PlatformSeries {
    buckets: string[]
    signups: number[]
    cumulativeUsers: number[]
    activeUsers: number[]
    signIns: number[]
    viewsCreated: number[]
    cumulativeViews: number[]
    workspacesCreated: number[]
    cumulativeWorkspaces: number[]
    viewOpens: number[]
    activityEvents: number[]
    dataSourcesOnboarded: number[]
    /**
     * The same measures over the PREVIOUS period, aligned by bucket index
     * (bucket 3 of last month under bucket 3 of this one) and padded to the
     * current window's length.
     *
     * Drawn as a recessive ghost behind each live series. The KPI delta says a
     * number moved; this says what shape the move was — steady growth, one
     * spike, or a late collapse all produce the same percentage.
     */
    previous: {
        signups: number[]
        viewsCreated: number[]
        viewOpens: number[]
        activeUsers: number[]
    }
}

export interface FunnelStageDto {
    stage: string
    count: number
    rate: number | null
}

export interface CohortDto {
    cohort: string
    size: number
    weeks: { week: number; active: number; rate: number | null }[]
}

export interface Engagement {
    dau: number
    wau: number
    mau: number
    /** DAU ÷ MAU — habit, not traffic. `null` when there is no MAU. */
    stickiness: number | null
    /** Share of the window's cohort that reached the VALUE moment — traced
     *  lineage. Authoring a view is a later, heavier commitment and is scored
     *  separately as `creationRate`. */
    activationRate: number | null
    creationRate: number | null
    medianDaysToFirstView: number | null
    funnel: FunnelStageDto[]
    growthAccounting: {
        new: number
        returning: number
        resurrected: number
        dormant: number
    }
    cohorts: CohortDto[]
}

export interface ClassCount {
    key: string
    count: number
}

export interface Breakdowns {
    usersByStatus: ClassCount[]
    usersBySignupSource: ClassCount[]
    viewsByVisibility: ClassCount[]
    viewsByType: ClassCount[]
    activityByAction: ClassCount[]
    collaborationRate: number | null
    contentConcentration: number | null
}

export interface TopUser {
    userId: string
    name: string
    email: string | null
    events: number
    viewsOpened: number
    viewsCreated: number
}

export interface TopView {
    viewId: string
    name: string
    workspaceId: string
    visibility: string
    viewType: string
    opens: number
    uniqueViewers: number
    favourites: number
}

export interface Leaderboards {
    topUsers: TopUser[]
    topViews: TopView[]
    topWorkspaces: { workspaceId: string; name: string; activity: number; opens: number }[]
    topCreators: { userId: string; name: string; viewsCreated: number }[]
}

export interface GraphScale {
    nodes: number
    edges: number
    entityTypes: number
    sourcesWithStats: number
}

/** One row of the feature-adoption matrix. */
export interface AdoptionRow {
    key: string
    label: string
    events: number
    users: number
    previousEvents: number
    changePct: number | null
    /** Share of ACTIVE users who touched this feature — not of all users. */
    reach: number | null
    /** When this feature's instrumentation first produced data. `null` means
     *  never measured, which is different from "nobody used it". */
    since: string | null
}

/**
 * Did the product answer the question it was asked?
 *
 * A trace that returns no lineage and a search that finds no match are FAILED
 * value moments — the user asked and got nothing back. Rates are `null` rather
 * than `0` when there is no basis, because "no traces ran" is not "0% success".
 */
export interface ValueMoments {
    traces: number
    tracesEmpty: number
    traceSuccessRate: number | null
    tracedBy: number
    searches: number
    searchMisses: number
    searchHitRate: number | null
}

export interface Reliability {
    refreshes: number
    failures: number
    successRate: number | null
    sourcesRefreshed: number
    sourcesUntouched: number
    byOutcome: ClassCount[]
}

export interface AccessFriction {
    requests: number
    pending: number
    medianHoursToApprove: number | null
    oldestPendingDays: number | null
    invitesSent: number
    invitesRedeemed: number
    acceptanceRate: number | null
}

export interface SemanticAdoption {
    sourcesWithOntology: number
    sourcesTotal: number
    coverage: number | null
    sourcesDrifting: number
}

export interface PlatformHealth {
    reliability: Reliability
    access: AccessFriction
    semanticLayer: SemanticAdoption
}

/** An announcement, anchored to a bucket on the shared x-axis. */
export interface Annotation {
    bucket: string
    date: string
    title: string
    kind: string
}

/** One computed observation for the "What changed" strip. */
export interface Insight {
    key: string
    tone: 'good' | 'watch' | 'bad' | 'neutral'
    headline: string
    detail: string
    /** Which tab answers this in more depth, if any. */
    tab: string | null
}

export interface AnalyticsSummary {
    windowDays: number
    generatedAt: string
    range: AnalyticsRange
    bucket: 'day' | 'week'
    totals: PlatformTotals
    series: PlatformSeries
    engagement: Engagement
    breakdowns: Breakdowns
    leaderboards: Leaderboards
    graph: GraphScale
    adoption: AdoptionRow[]
    valueMoments: ValueMoments
    health: PlatformHealth
    annotations: Annotation[]
    /** Ranked, most significant first. Empty on a young install — the strip
     *  says nothing rather than manufacturing observations. */
    insights: Insight[]
    coverage: {
        /** When view-open tracking began. `null` means no opens recorded yet —
         *  the charts say so rather than implying nobody opened anything. */
        viewOpenTrackingSince: string | null
        /** Per feature, because each signal starts the day its instrumentation
         *  shipped. Lets the UI say "not measured yet" instead of plotting a
         *  zero that reads as "unused". */
        trackingSince: Record<string, string | null>
    }
}

export interface WorkspaceAnalyticsRow {
    workspaceId: string
    name: string
    createdAt: string
    isActive: boolean
    members: number
    views: number
    newViews: number
    dataSources: number
    activity: number
    opens: number
    activeUsers: number
    nodes: number
    edges: number
    lastActivityAt: string | null
    dormant: boolean
}

export interface WorkspaceAnalyticsDetail {
    workspaceId: string
    name: string
    description: string | null
    createdAt: string
    isActive: boolean
    windowDays: number
    generatedAt: string
    range: AnalyticsRange
    bucket: 'day' | 'week'
    totals: {
        views: Metric
        viewOpens: Metric
        activeUsers: Metric
        activity: Metric
        members: Metric
        dataSources: Metric
        contextModels: Metric
    }
    series: {
        buckets: string[]
        viewsCreated: number[]
        cumulativeViews: number[]
        activityEvents: number[]
        activeUsers: number[]
        viewOpens: number[]
    }
    breakdowns: {
        viewsByVisibility: ClassCount[]
        viewsByType: ClassCount[]
        activityByAction: ClassCount[]
    }
    topViews: TopView[]
    topContributors: { userId: string; name: string; email: string | null; events: number }[]
    graph: GraphScale
}

/**
 * The slice every number is measured over. Two ways to say it, and the server
 * resolves both to the same shape:
 *
 *   * `{ days }`        — a trailing window. What the presets send.
 *   * `{ from, to }`    — explicit `YYYY-MM-DD` bounds, both inclusive.
 *
 * Modelled as a union rather than three optional fields so "a preset AND a
 * custom range at once" cannot be expressed.
 */
export type AnalyticsRangeSelection =
    | { kind: 'preset'; days: number }
    | { kind: 'custom'; from: string; to: string }

/** Query string for one selection. Shared by all three endpoints so they can
 *  never disagree about which window they are showing. */
export function rangeQuery(range: AnalyticsRangeSelection): string {
    return range.kind === 'custom'
        ? `from=${encodeURIComponent(range.from)}&to=${encodeURIComponent(range.to)}`
        : `days=${range.days}`
}

/** Stable cache-key fragment for a selection. */
export function rangeKey(range: AnalyticsRangeSelection): string {
    return range.kind === 'custom' ? `${range.from}..${range.to}` : `d${range.days}`
}

export const analyticsService = {
    /** Platform-wide insights over one window. */
    getSummary(range: AnalyticsRangeSelection): Promise<AnalyticsSummary> {
        return authFetch<AnalyticsSummary>(
            `${ANALYTICS_API}/summary?${rangeQuery(range)}`,
        )
    },

    /** One aggregate row per live workspace. */
    listWorkspaces(range: AnalyticsRangeSelection): Promise<WorkspaceAnalyticsRow[]> {
        return authFetch<WorkspaceAnalyticsRow[]>(
            `${ANALYTICS_API}/workspaces?${rangeQuery(range)}`,
        )
    },

    /** Full insights for a single workspace. */
    getWorkspace(
        workspaceId: string, range: AnalyticsRangeSelection,
    ): Promise<WorkspaceAnalyticsDetail> {
        return authFetch<WorkspaceAnalyticsDetail>(
            `${ANALYTICS_API}/workspaces/${encodeURIComponent(workspaceId)}`
            + `?${rangeQuery(range)}`,
        )
    },
}
