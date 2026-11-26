/**
 * People analytics — who did what, when, per person and per workspace.
 *
 * Mirrors ``backend/app/api/v1/endpoints/people_activity.py``. Who may ask and
 * what they are told is the server's decision (``services/people_scope``):
 * analytics administrators see everyone, a workspace admin sees their
 * workspace's people with no sign-ins, everyone sees themselves. Fields a lens
 * withholds arrive as `null`, never as `0` — "not shown" and "none" differ.
 */
import { authFetch } from './apiClient'
import { rangeQuery, type AnalyticsRangeSelection, type Insight } from './analyticsService'

const API = '/api/v1/admin/analytics/people'

/** What people do. The order is the charts' colour order; mirrors `KINDS`. */
export const ACTIVITY_KINDS = ['signin', 'browse', 'trace', 'search', 'build', 'operate', 'other'] as const
export type ActivityKind = (typeof ACTIVITY_KINDS)[number]
/** A feed also carries section moves, which are presence rather than activity. */
export type FeedKind = ActivityKind | 'section'

export type PeopleLens = 'full' | 'workspace'

export interface PeopleScope {
    workspaceId: string | null
    lens: PeopleLens
}

export interface PeopleMetric {
    current: number
    previous: number
    changePct: number | null
}

export interface PeopleWindow {
    days: number
    start: string
    end: string
    granularity: 'day' | 'week'
    buckets: string[]
}

/** How far the daily rollup every roster figure comes from reaches. */
export interface IndexCoverage {
    /** When today was last computed. */
    freshAt: string | null
    /** The oldest day from which every day to today is computed: a window from here is exact. */
    completeFrom: string | null
    /** The first day anything was recorded. */
    historyFrom: string | null
    /** The indexer has computed today recently — it is keeping the figures current. */
    running: boolean
    /** History is still being indexed, newest first. */
    backfilling: boolean
    progress: number | null
}

export interface PeopleCoverage {
    /** The newest activity-ledger row; `null` when the ledger is empty here. */
    ledgerThrough: string | null
    sectionsSince: string | null
    index: IndexCoverage
}

export interface PeopleSeries {
    buckets: string[]
    byKind: { kind: ActivityKind; values: number[] }[]
    activePeople: number[]
    signedIn: number[] | null
}

export interface KindCount { kind: ActivityKind; count: number }
export interface TypeCount { type: string; kind: ActivityKind; label: string; count: number }
export interface SectionCount { section: string; count: number; people: number }

export interface PersonRow {
    userId: string
    name: string
    /** Privileged readers only. */
    email?: string | null
    deleted: boolean
    actions: number
    previous: number
    changePct: number | null
    activeDays: number
    signIns: number | null
    signInDays: number | null
    idleSignInDays: number | null
    lastActiveAt: string | null
    lastSignInAt: string | null
    topKind: ActivityKind | null
    joinedInWindow: boolean
    /** Their activity line: actions per period of the window, in the scope. */
    line: number[]
    joinedAt: string | null
    firstActiveAt: string | null
    lastActiveEverAt: string | null
}

export interface QuietPerson {
    userId: string
    name: string
    email?: string | null
    joinedAt: string | null
    lastLoginAt: string | null
    lastActiveAt: string | null
}

export interface PeopleDoc {
    generatedAt: string
    window: PeopleWindow
    scope: PeopleScope
    coverage: PeopleCoverage
    totals: {
        activePeople: PeopleMetric
        signedIn: PeopleMetric | null
        actions: PeopleMetric
        avgActiveDays: number | null
        idleSignIns: { days: number; signInDays: number; rate: number | null } | null
        newcomers: number
        members: number | null
        quiet: number
    }
    series: PeopleSeries
    kinds: KindCount[]
    types: TypeCount[]
    punchcard: number[][]
    sections: SectionCount[]
    insights: Insight[]
    people: PersonRow[]
    quiet: { count: number; people: QuietPerson[] }
    page: { offset: number; limit: number; total: number }
}

export interface LinkedRef {
    id: string | null
    name: string | null
    locked: boolean
    deleted: boolean
    workspaceId: string | null
    canOpen: boolean
}

export interface PersonWorkspace {
    workspaceId: string | null
    name: string | null
    locked: boolean
    canOpen: boolean
    actions: number
    joinedAt: string | null
    firstActiveAt: string | null
    lastActiveAt: string | null
    member: boolean
}

export interface PersonDoc {
    generatedAt: string
    window: PeopleWindow
    scope: PeopleScope
    coverage: PeopleCoverage
    profile: {
        userId: string
        name: string
        email?: string | null
        status: string | null
        createdAt: string | null
        deleted: boolean
        lastLoginAt: string | null
        lastSeenAt: string | null
        lastActiveAt: string | null
        firstActiveAt: string | null
    }
    totals: {
        actions: PeopleMetric
        activeDays: PeopleMetric
        signIns: PeopleMetric | null
        idleSignInDays: number | null
        viewsOpened: PeopleMetric
        distinctViews: number
        traces: PeopleMetric
        traceEmptyRate: number | null
        searches: PeopleMetric
        searchMissRate: number | null
        longestStreak: number
        currentStreak: number
        lastActiveAt: string | null
    }
    series: PeopleSeries & {
        /** Their activity line: actions per period. */
        actions: number[]
        /** The same over the period before, index-aligned — the ghost behind the line. */
        previousActions: number[]
        signIns: number[] | null
    }
    kinds: KindCount[]
    types: TypeCount[]
    punchcard: number[][]
    sections: SectionCount[]
    typicalDay: { firstMinute: number | null; lastMinute: number | null; days: number }
    workspaces: PersonWorkspace[]
    views: (LinkedRef & { opens: number })[]
    signIns: {
        methods: { key: string; count: number }[]
        recent: { at: string; method: string }[]
        failed: number
        capped: boolean
    } | null
    standing: { rank: number; of: number; percentile: number } | null
    viewer: { isSelf: boolean; privileged: boolean }
}

export interface PersonCalendar {
    generatedAt: string
    scope: PeopleScope
    days: string[]
    actions: number[]
    signIns: number[] | null
}

export interface ActivityEventRow {
    id: string
    at: string
    type: string
    kind: FeedKind
    label: string
    section: string | null
    outcome: string | null
    target: { type: string | null; id: string | null; label: string | null } | null
    workspace: { workspaceId: string | null; name: string | null; locked: boolean; canOpen: boolean } | null
    view: LinkedRef | null
    summary: string | null
}

export interface DaySession {
    start: string
    end: string
    actions: number
    kinds: Partial<Record<FeedKind, number>>
}

export interface PersonDay {
    day: string
    scope: PeopleScope
    events: ActivityEventRow[]
    sessions: DaySession[]
    truncated: boolean
    kinds: Partial<Record<FeedKind, number>>
}

export interface PersonFeedPage {
    scope: PeopleScope
    events: ActivityEventRow[]
    /** Pass back as `before` for the next page; `null` at the end. */
    next: string | null
}

/** A few people's activity lines on one axis, to compare them. */
export interface PeopleLines {
    buckets: string[]
    granularity: 'day' | 'week'
    lines: Record<string, number[]>
    names: Record<string, string>
    scope: PeopleScope
}

/** Everyone active on one day in a scope — exactly, not a sample. */
export interface ScopeDay {
    day: string
    scope: PeopleScope
    active: number
    signedIn: number | null
    kinds: KindCount[]
    people: {
        userId: string
        name: string
        actions: number
        signIns: number | null
        kinds: Partial<Record<ActivityKind, number>>
    }[]
}

export type PeopleSort = 'actions' | 'activeDays' | 'lastActiveAt' | 'name' | 'change' | 'signIns'

export interface PeopleQuery {
    workspaceId?: string | null
    q?: string
    sort?: PeopleSort
    order?: 'asc' | 'desc'
    offset?: number
    limit?: number
}

function qs(parts: Record<string, string | number | null | undefined>): string {
    const out = new URLSearchParams()
    for (const [k, v] of Object.entries(parts)) {
        if (v !== null && v !== undefined && v !== '') out.set(k, String(v))
    }
    const s = out.toString()
    return s ? `&${s}` : ''
}

const person = (id: string) => `${API}/${encodeURIComponent(id)}`

export const peopleActivityService = {
    roster(range: AnalyticsRangeSelection, query: PeopleQuery = {}): Promise<PeopleDoc> {
        return authFetch<PeopleDoc>(`${API}?${rangeQuery(range)}${qs({
            workspace: query.workspaceId, q: query.q, sort: query.sort, order: query.order,
            offset: query.offset, limit: query.limit,
        })}`)
    },

    lines(ids: string[], range: AnalyticsRangeSelection, workspaceId?: string | null): Promise<PeopleLines> {
        return authFetch<PeopleLines>(`${API}/lines?${rangeQuery(range)}${qs({
            ids: ids.join(','), workspace: workspaceId,
        })}`)
    },

    scopeDay(day: string, workspaceId?: string | null): Promise<ScopeDay> {
        return authFetch<ScopeDay>(
            `${API}/days/${encodeURIComponent(day)}?${qs({ workspace: workspaceId }).slice(1)}`)
    },

    person(id: string, range: AnalyticsRangeSelection, workspaceId?: string | null): Promise<PersonDoc> {
        return authFetch<PersonDoc>(`${person(id)}?${rangeQuery(range)}${qs({ workspace: workspaceId })}`)
    },

    calendar(id: string, workspaceId?: string | null): Promise<PersonCalendar> {
        return authFetch<PersonCalendar>(`${person(id)}/calendar?${qs({ workspace: workspaceId }).slice(1)}`)
    },

    day(id: string, day: string, workspaceId?: string | null): Promise<PersonDay> {
        return authFetch<PersonDay>(
            `${person(id)}/days/${encodeURIComponent(day)}?${qs({ workspace: workspaceId }).slice(1)}`)
    },

    events(id: string, opts: {
        workspaceId?: string | null; kinds?: FeedKind[]; before?: string | null; limit?: number
    } = {}): Promise<PersonFeedPage> {
        return authFetch<PersonFeedPage>(`${person(id)}/events?${qs({
            workspace: opts.workspaceId, kinds: opts.kinds?.length ? opts.kinds.join(',') : null,
            before: opts.before, limit: opts.limit,
        }).slice(1)}`)
    },
}
