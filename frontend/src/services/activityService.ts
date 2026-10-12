/**
 * The activity ledger, as the Activity explorer reads it.
 *
 * Two mounts, one client. A platform auditor reads `/admin/activity`; a
 * workspace admin reads `/admin/workspaces/{id}/activity`, which the server
 * pins to that workspace's workspace-audience events — no parameter here can
 * widen it. An auditor looking at one workspace reads the platform endpoint
 * filtered to it, and so sees everything recorded against it.
 *
 * Ids stay authoritative: every name beside an id was resolved by the server
 * in a batch, and is ABSENT when the id resolves to nothing, so the UI shows
 * the id rather than inventing a name.
 */
import { authFetch } from './apiClient'
import { rangeQuery, type AnalyticsRangeSelection } from './analyticsService'

const PLATFORM_API = '/api/v1/admin/activity'

/** Exactly six, in a fixed order — the order IS the chart slot. */
export const ACTIVITY_CATEGORIES = [
    'operations', 'access', 'identity', 'data', 'content', 'platform',
] as const
export type ActivityCategory = typeof ACTIVITY_CATEGORIES[number]

export type ActivityScope =
    | { kind: 'platform' }
    /** One workspace. `asAuditor` reads it through the platform endpoint. */
    | { kind: 'workspace'; workspaceId: string; asAuditor?: boolean }

export type PersonRole = 'any' | 'actor' | 'subject'
export type ActivityOutcome = 'success' | 'failure' | 'denied'

/** A person named on an event. Named by the server or not at all. */
export interface ActivityPersonRef {
    id: string
    name?: string | null
    email?: string | null
    /** Soft-deleted, but still named: the log records what happened. */
    deleted: boolean
    /** The picked illustration, and whether a profile picture is stored. */
    avatarId?: string | null
    hasImage?: boolean
}

export interface ActivityTarget {
    type?: string | null
    id?: string | null
    /** The name it had AT THE TIME, when the event recorded one. */
    label?: string | null
}

export interface ActivityEvent {
    id: string
    eventType: string
    /** The verb phrase the type is filed under: "Triggered aggregation". */
    label: string
    category: ActivityCategory
    severity: 'info' | 'warning' | 'critical' | string
    outcome: ActivityOutcome
    /** One line, with every id it mentions named. */
    summary: string
    occurredAt: string
    recordedAt: string
    actorKind: 'user' | 'service' | 'system' | 'anonymous'
    actor?: ActivityPersonRef | null
    /** The person it happened TO, when it happened to one. */
    subject?: ActivityPersonRef | null
    target?: ActivityTarget | null
    workspaceId?: string | null
    workspaceName?: string | null
    dataSourceId?: string | null
    dataSourceName?: string | null
    /** Absent means "no reason given" — never an empty string. */
    statedReason?: string | null
    correlationId?: string | null
    details: Record<string, unknown>
    resolvedNames: Record<string, string>
    /** The event as emitted. Platform scope only. */
    payload?: Record<string, unknown> | null
}

export interface LedgerHealth {
    pending: number
    pendingCapped: boolean
    lagSeconds: number | null
    /** History is still being imported: counts are not final yet. */
    backfilling: boolean
    /** Newest recorded_at — the point "N new" counts from. */
    watermark: string | null
}

export interface ActivityPage {
    events: ActivityEvent[]
    nextCursor?: string | null
    /** First page only. */
    ledger?: LedgerHealth | null
}

export interface ActivityNewer {
    count: number
    capped: boolean
}

export interface ActivityEventDetail {
    event: ActivityEvent
    sameRequest: ActivityEvent[]
    sameTarget: ActivityEvent[]
}

export interface ActivityCatalogueEntry {
    type: string
    label: string
    category: ActivityCategory
    severity: string
    workspaceVisible: boolean
}

export interface ActivityCatalogue {
    categories: ActivityCategory[]
    eventTypes: ActivityCatalogueEntry[]
}

export interface ActivityMetric {
    current: number
    previous: number
    /** A RATIO (0.25 = +25%), null when the previous period had none. */
    delta: number | null
}

export interface ActivitySummary {
    window: {
        days: number
        start: string
        end: string
        granularity: 'day' | 'week'
        buckets: string[]
        previousStart: string
    }
    totals: {
        events: ActivityMetric
        people: ActivityMetric
        operations: ActivityMetric
        reasons: { given: number; of: number; share: number | null }
    }
    volume: { category: ActivityCategory; values: number[] }[]
    /** 7 × 24, Monday first, in UTC. */
    punchcard: number[][]
    topPeople: {
        id: string; count: number; name?: string | null; email?: string | null; deleted?: boolean
        avatarId?: string | null; hasImage?: boolean
    }[]
    topTargets: { type: string | null; id: string; label?: string | null; count: number }[]
    topActions: { type: string; count: number; label: string; category: ActivityCategory }[]
    handsOnSources: {
        dataSourceId: string
        workspaceId?: string | null
        count: number
        lastAt: string
        /** The usual gap between manual operations; null with only one. */
        medianGapHours: number | null
        name?: string | null
        workspaceName?: string | null
    }[]
    topReasons: { reason: string; count: number }[]
    /** The cadence figures read only the most recent operations. */
    cadenceCapped: boolean
    generatedAt?: string
}

/** Everything a selection can say. Absent fields are not filters. */
export interface ActivityQuery {
    range: AnalyticsRangeSelection
    categories?: ActivityCategory[]
    eventTypes?: string[]
    person?: string
    personRole?: PersonRole
    /** Platform scope only; a workspace scope is already pinned. */
    workspaceId?: string
    dataSourceId?: string
    targetType?: string
    targetId?: string
    outcome?: ActivityOutcome
    hasReason?: boolean
    /** Include the per-request "access denied" refusals. */
    includeNoise?: boolean
    q?: string
}

/** Text search reads every payload in its window, so the server caps it. */
export const SEARCH_MAX_DAYS = 92

export function activityBase(scope: ActivityScope): string {
    if (scope.kind === 'workspace' && !scope.asAuditor) {
        return `/api/v1/admin/workspaces/${encodeURIComponent(scope.workspaceId)}/activity`
    }
    return PLATFORM_API
}

/** The query string for a selection, in a stable order — it is also the
 *  cache key, so two equal selections must spell it the same way. */
export function activityQueryString(scope: ActivityScope, query: ActivityQuery): string {
    const p = new URLSearchParams(rangeQuery(query.range))
    const set = (key: string, value: string | undefined | null) => {
        if (value) p.set(key, value)
    }
    set('category', query.categories?.join(','))
    set('eventType', query.eventTypes?.join(','))
    set('person', query.person?.trim())
    if (query.person?.trim() && query.personRole && query.personRole !== 'any') {
        p.set('personRole', query.personRole)
    }
    // A workspace an auditor is looking at is pinned the same way a
    // workspace admin's is: as a filter nothing else can drop.
    set('workspaceId', scope.kind === 'workspace' && scope.asAuditor
        ? scope.workspaceId
        : scope.kind === 'platform' ? query.workspaceId : undefined)
    set('dataSourceId', query.dataSourceId)
    set('targetType', query.targetType)
    set('targetId', query.targetId)
    set('outcome', query.outcome)
    if (query.hasReason !== undefined) p.set('hasReason', String(query.hasReason))
    if (query.includeNoise) p.set('includeNoise', 'true')
    set('q', query.q?.trim())
    return p.toString()
}

export const activityService = {
    /** A page of events, newest first. Pass `nextCursor` back for more. */
    listEvents(
        scope: ActivityScope, query: ActivityQuery,
        cursor?: string | null, limit = 50,
    ): Promise<ActivityPage> {
        const qs = new URLSearchParams(activityQueryString(scope, query))
        qs.set('limit', String(limit))
        if (cursor) qs.set('cursor', cursor)
        return authFetch<ActivityPage>(`${activityBase(scope)}/events?${qs}`)
    },

    /** How many matching events arrived since `since` (a ledger watermark). */
    countNewer(scope: ActivityScope, query: ActivityQuery, since: string): Promise<ActivityNewer> {
        const qs = new URLSearchParams(activityQueryString(scope, query))
        qs.set('since', since)
        return authFetch<ActivityNewer>(`${activityBase(scope)}/events/newer?${qs}`)
    },

    /** One event, the rest of its request, and the latest on its target. */
    getEvent(scope: ActivityScope, eventId: string): Promise<ActivityEventDetail> {
        return authFetch<ActivityEventDetail>(
            `${activityBase(scope)}/events/${encodeURIComponent(eventId)}`,
        )
    },

    /** The insight band for a selection. The server ignores a text search. */
    getSummary(scope: ActivityScope, query: ActivityQuery): Promise<ActivitySummary> {
        return authFetch<ActivitySummary>(
            `${activityBase(scope)}/summary?${activityQueryString(scope, { ...query, q: undefined })}`,
        )
    },

    /** Every event type there is to filter on. */
    getCatalogue(scope: ActivityScope): Promise<ActivityCatalogue> {
        return authFetch<ActivityCatalogue>(`${activityBase(scope)}/catalogue`)
    },

    /** A link that downloads the selection as CSV (itself recorded). */
    exportUrl(scope: ActivityScope, query: ActivityQuery): string {
        return `${activityBase(scope)}/export.csv?${activityQueryString(scope, query)}`
    },
}
