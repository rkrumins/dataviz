/**
 * A month of believable platform activity, for the Activity harness.
 *
 * Shaped like the API's answers, built relative to "now" so the timeline's
 * Today / Yesterday grouping and the relative times read naturally in a
 * screenshot taken on any day.
 */
import type {
    ActivityCatalogue,
    ActivityEvent,
    ActivityEventDetail,
    ActivitySummary,
} from '../services/activityService'

const HOUR = 3_600_000
const at = (hoursAgo: number) => new Date(Date.now() - hoursAgo * HOUR).toISOString()

// No stored pictures here (`hasImage: false`), so the harness asks for none:
// faces are the picked illustration or initials.
const PEOPLE = {
    ana: { id: 'usr_7f3a', name: 'Ana Okafor', email: 'ana.okafor@example.com', deleted: false, avatarId: 'rocket', hasImage: false },
    ben: { id: 'usr_19c2', name: 'Ben Lindqvist', email: 'ben.l@example.com', deleted: false, hasImage: false },
    chen: { id: 'usr_4d8e', name: 'Chen Wei', email: 'chen.wei@example.com', deleted: false, avatarId: 'cat', hasImage: false },
    dana: { id: 'usr_b210', name: 'Dana Ruiz', email: 'dana.ruiz@example.com', deleted: true, hasImage: false },
}

let n = 0
function event(over: Partial<ActivityEvent>): ActivityEvent {
    n += 1
    return {
        id: `evt_${String(n).padStart(4, '0')}`,
        eventType: 'aggregation.job.triggered',
        label: 'Triggered aggregation',
        category: 'operations',
        severity: 'info',
        outcome: 'success',
        summary: '',
        occurredAt: at(1),
        actorKind: 'user',
        actor: PEOPLE.ana,
        subject: null,
        target: null,
        workspaceId: 'ws_fin',
        workspaceName: 'Finance Analytics',
        dataSourceId: null,
        dataSourceName: null,
        statedReason: null,
        correlationId: `req-${n}`,
        details: {},
        resolvedNames: {},
        payload: { actor_id: 'usr_7f3a' },
        ...over,
        // Relayed within a moment unless a fixture says otherwise.
        recordedAt: over.recordedAt ?? over.occurredAt ?? at(1),
    }
}

const ledger = { id: 'ds_ledger', label: 'General Ledger' }

export const ACTIVITY_EVENTS: ActivityEvent[] = [
    event({
        summary: 'Triggered aggregation of General Ledger', occurredAt: at(0.2),
        target: { type: 'data_source', id: ledger.id, label: ledger.label },
        dataSourceId: ledger.id, dataSourceName: ledger.label,
        statedReason: 'Upstream ETL re-ran after the March close fix',
        details: { jobId: 'agg_51c09e3f2a1b', triggerSource: 'manual' },
        recordedAt: at(0.19),
        payload: {
            actor_id: 'usr_7f3a', data_source_id: ledger.id, workspace_id: 'ws_fin',
            stated_reason: 'Upstream ETL re-ran after the March close fix', correlation_id: 'req-1',
            details: { jobId: 'agg_51c09e3f2a1b', triggerSource: 'manual' },
        },
    }),
    event({
        eventType: 'aggregation.job.limits_changed', label: 'Changed a running job’s limits',
        summary: 'Changed the limits of a running aggregation of General Ledger', occurredAt: at(0.5),
        actor: PEOPLE.ben,
        target: { type: 'data_source', id: ledger.id, label: ledger.label },
        dataSourceId: ledger.id, dataSourceName: ledger.label,
        statedReason: 'Quarter-end load on the shard — give it room',
        details: {
            jobId: 'agg_51c09e3f2a1b',
            changes: [
                { field: 'timeout_secs', from: 10_800, to: 21_600 },
                { field: 'write_pacing_ratio', from: 1, to: 2 },
                { field: 'scan_width', from: 200_000, to: null },
            ],
        },
    }),
    event({
        eventType: 'rbac.group.member_added', label: 'Added to a group', category: 'access',
        summary: "Added Chen Wei to group 'Finance Reviewers'", occurredAt: at(0.9),
        actor: PEOPLE.ben, subject: PEOPLE.chen,
        target: { type: 'group', id: 'grp_fr', label: 'Finance Reviewers' },
        statedReason: 'Covering quarter-end reviews while Dana is out',
        resolvedNames: { grp_fr: 'Finance Reviewers' },
    }),
    ...['a', 'b', 'c'].map((_, i) => event({
        eventType: 'user.logged_in', label: 'Signed in', category: 'identity',
        summary: 'Signed in via Okta', occurredAt: at(1.4 + i * 0.3), actor: PEOPLE.chen,
        workspaceId: null, workspaceName: null,
    })),
    event({
        eventType: 'aggregation.source.refresh_requested', label: 'Refreshed a data source',
        summary: 'Requested a rollup rebuild of Revenue Forecast', occurredAt: at(3.5), actor: PEOPLE.ben,
        target: { type: 'data_source', id: 'ds_rev', label: 'Revenue Forecast' },
        dataSourceId: 'ds_rev', dataSourceName: 'Revenue Forecast',
        details: { scope: 'rollups', outcome: 'accepted', jobId: 'agg_77aa10' },
    }),
    event({
        eventType: 'user.access_denied', label: 'Was refused access', category: 'identity',
        summary: 'Refused workspace:datasource:manage on Finance Analytics', outcome: 'denied',
        occurredAt: at(5), actor: PEOPLE.chen, severity: 'warning',
    }),
    event({
        eventType: 'platform.feature_flag.changed', label: 'Changed a feature flag', category: 'platform',
        summary: "Feature 'versioningEnabled' set to true", occurredAt: at(22), actor: PEOPLE.ana,
        target: { type: 'feature_flag', id: 'versioningEnabled', label: 'versioningEnabled' },
        workspaceId: null, workspaceName: null,
        statedReason: 'Pilot version control with the finance team',
        details: { key: 'versioningEnabled', from: false, value: true },
    }),
    event({
        eventType: 'workspace.versioning.enabled', label: 'Turned on version control', category: 'data',
        summary: 'Turned on version control for General Ledger', occurredAt: at(21.5), actor: PEOPLE.ana,
        target: { type: 'data_source', id: ledger.id, label: ledger.label },
        dataSourceId: ledger.id, dataSourceName: ledger.label,
        statedReason: 'Pilot version control with the finance team',
        details: { jobId: 'vjob_31f', graphId: 'vg_8812' },
    }),
    event({
        eventType: 'aggregation.job.cancelled', label: 'Cancelled aggregation', severity: 'warning',
        summary: 'Cancelled aggregation of Revenue Forecast', occurredAt: at(26), actor: PEOPLE.ben,
        target: { type: 'data_source', id: 'ds_rev', label: 'Revenue Forecast' },
        dataSourceId: 'ds_rev', dataSourceName: 'Revenue Forecast',
        details: { jobId: 'agg_6610ef', status: 'running' },
    }),
    event({
        eventType: 'workspace.data_source.added', label: 'Added a data source', category: 'data',
        summary: 'Added data source Supplier Contracts', occurredAt: at(49), actor: PEOPLE.dana,
        target: { type: 'data_source', id: 'ds_sup', label: 'Supplier Contracts' },
        dataSourceId: 'ds_sup', dataSourceName: 'Supplier Contracts',
        statedReason: 'Procurement asked for contract lineage',
        details: { providerId: 'prov_falkor', graphName: 'supplier_contracts' },
    }),
    event({
        eventType: 'visualization.view.created', label: 'Created a view', category: 'content',
        summary: "Created view 'Close checklist lineage'", occurredAt: at(52), actor: PEOPLE.chen,
        target: { type: 'view', id: 'view_c1', label: 'Close checklist lineage' },
    }),
]

const DAYS = 30
const buckets = Array.from({ length: DAYS }, (_, i) =>
    new Date(Date.now() - (DAYS - 1 - i) * 24 * HOUR).toISOString().slice(0, 10))
const wave = (base: number, amp: number, phase = 0) =>
    buckets.map((_, i) => {
        const weekday = new Date(buckets[i]).getUTCDay()
        const weekend = weekday === 0 || weekday === 6
        return Math.max(0, Math.round((base + amp * Math.sin(i / 3 + phase)) * (weekend ? 0.25 : 1)))
    })

const punchcard = Array.from({ length: 7 }, (_, d) => Array.from({ length: 24 }, (_, h) => {
    const workday = d < 5
    const office = h >= 8 && h <= 18
    const peak = h === 10 || h === 14 ? 1.6 : 1
    return Math.round((workday ? (office ? 9 : 1) : office ? 2 : 0) * peak * (d === 1 ? 1.3 : 1))
}))

export const ACTIVITY_SUMMARY: ActivitySummary = {
    window: {
        days: DAYS, start: buckets[0], end: new Date().toISOString(),
        granularity: 'day', buckets, previousStart: buckets[0],
    },
    totals: {
        events: { current: 4812, previous: 4105, delta: 0.1722 },
        people: { current: 38, previous: 35, delta: 0.0857 },
        operations: { current: 126, previous: 171, delta: -0.2632 },
        reasons: { given: 97, of: 141, share: 0.688 },
    },
    volume: [
        { category: 'operations', values: wave(9, 4) },
        { category: 'access', values: wave(14, 6, 1) },
        { category: 'identity', values: wave(95, 20, 2) },
        { category: 'data', values: wave(5, 3, 3) },
        { category: 'content', values: wave(30, 10, 4) },
        { category: 'platform', values: wave(1, 1, 5) },
    ],
    punchcard,
    topPeople: [
        { ...PEOPLE.ana, count: 412 },
        { ...PEOPLE.ben, count: 268 },
        { ...PEOPLE.chen, count: 191 },
        { ...PEOPLE.dana, count: 77 },
        { id: 'usr_0aa1', count: 54 },
    ],
    topTargets: [],
    topActions: [
        { type: 'user.logged_in', count: 2210, label: 'Signed in', category: 'identity' },
        { type: 'visualization.view.created', count: 318, label: 'Created a view', category: 'content' },
        { type: 'rbac.group.member_added', count: 96, label: 'Added to a group', category: 'access' },
        { type: 'aggregation.job.triggered', count: 71, label: 'Triggered aggregation', category: 'operations' },
        { type: 'aggregation.source.refresh_requested', count: 38, label: 'Refreshed a data source', category: 'operations' },
    ],
    handsOnSources: [
        { dataSourceId: ledger.id, workspaceId: 'ws_fin', count: 23, lastAt: at(0.2), medianGapHours: 30, name: ledger.label, workspaceName: 'Finance Analytics' },
        { dataSourceId: 'ds_rev', workspaceId: 'ws_fin', count: 17, lastAt: at(3.5), medianGapHours: 41, name: 'Revenue Forecast', workspaceName: 'Finance Analytics' },
        { dataSourceId: 'ds_sup', workspaceId: 'ws_proc', count: 6, lastAt: at(49), medianGapHours: 120, name: 'Supplier Contracts', workspaceName: 'Procurement' },
    ],
    topReasons: [
        { reason: 'Upstream ETL re-ran after the March close fix', count: 11 },
        { reason: 'Covering quarter-end reviews while Dana is out', count: 6 },
        { reason: 'Pilot version control with the finance team', count: 4 },
    ],
    cadenceCapped: false,
}

export const ACTIVITY_CATALOGUE: ActivityCatalogue = {
    categories: ['operations', 'access', 'identity', 'data', 'content', 'platform'],
    eventTypes: [
        { type: 'aggregation.job.triggered', label: 'Triggered aggregation', category: 'operations', severity: 'info', workspaceVisible: true },
        { type: 'aggregation.job.cancelled', label: 'Cancelled aggregation', category: 'operations', severity: 'warning', workspaceVisible: true },
        { type: 'aggregation.source.refresh_requested', label: 'Refreshed a data source', category: 'operations', severity: 'info', workspaceVisible: true },
        { type: 'rbac.group.member_added', label: 'Added to a group', category: 'access', severity: 'info', workspaceVisible: false },
        { type: 'user.logged_in', label: 'Signed in', category: 'identity', severity: 'info', workspaceVisible: false },
        { type: 'workspace.data_source.added', label: 'Added a data source', category: 'data', severity: 'info', workspaceVisible: true },
        { type: 'visualization.view.created', label: 'Created a view', category: 'content', severity: 'info', workspaceVisible: false },
        { type: 'platform.feature_flag.changed', label: 'Changed a feature flag', category: 'platform', severity: 'info', workspaceVisible: false },
    ],
}

export function activityDetail(id: string): ActivityEventDetail {
    const found = ACTIVITY_EVENTS.find((e) => e.id === id) ?? ACTIVITY_EVENTS[0]
    return {
        event: found,
        sameRequest: found.eventType === 'rbac.group.member_added'
            ? [event({
                eventType: 'user.sessions_revoked', label: 'Sessions revoked', category: 'identity',
                summary: 'Revoked 2 sessions for Chen Wei', actor: PEOPLE.ben, occurredAt: found.occurredAt,
            })]
            : [],
        sameTarget: ACTIVITY_EVENTS.filter((e) => e.id !== found.id && e.target?.id && e.target.id === found.target?.id),
    }
}
