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
    activationRate: number | null
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
    coverage: {
        /** When view-open tracking began. `null` means no opens recorded yet —
         *  the charts say so rather than implying nobody opened anything. */
        viewOpenTrackingSince: string | null
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

export const analyticsService = {
    /** Platform-wide insights over the trailing `days` window. */
    getSummary(days: number): Promise<AnalyticsSummary> {
        return authFetch<AnalyticsSummary>(`${ANALYTICS_API}/summary?days=${days}`)
    },

    /** One aggregate row per live workspace. */
    listWorkspaces(days: number): Promise<WorkspaceAnalyticsRow[]> {
        return authFetch<WorkspaceAnalyticsRow[]>(`${ANALYTICS_API}/workspaces?days=${days}`)
    },

    /** Full insights for a single workspace. */
    getWorkspace(workspaceId: string, days: number): Promise<WorkspaceAnalyticsDetail> {
        return authFetch<WorkspaceAnalyticsDetail>(
            `${ANALYTICS_API}/workspaces/${encodeURIComponent(workspaceId)}?days=${days}`,
        )
    },
}
