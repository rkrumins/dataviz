/**
 * Universal envelope shape returned by every insights-service read.
 *
 * Status semantics:
 *  - fresh       — payload is current; render directly.
 *  - stale       — past freshness threshold but within absolute expiry;
 *                  a refresh job has been kicked off.
 *  - computing   — no usable cache; a job has been enqueued.
 *  - partial     — synthetic / fallback payload (e.g. ontology-derived schema).
 *  - unavailable — no cache + Redis enqueue failed; "background refresh
 *                  paused" affordance.
 *
 * provider_health is independent of envelope status — a provider can
 * be `degraded` while the cache is still `fresh` from a prior poll.
 */
export type MetaStatus = 'fresh' | 'stale' | 'computing' | 'partial' | 'unavailable'

export type ProviderHealth = 'ok' | 'degraded' | 'down' | 'unknown'

export interface InsightsMeta {
    status: MetaStatus
    source: 'cache' | 'ontology' | 'synthetic' | 'none'
    /** ISO 8601 timestamp of the last cache write, if any. */
    updated_at: string | null
    /** Seconds since `updated_at`. Null when no row exists. */
    staleness_secs: number | null
    /** Seconds remaining before the cached row crosses the freshness threshold. */
    ttl_seconds: number | null
    /** True when a refresh job is in flight (whether or not data is currently shown). */
    refreshing: boolean
    /** Redis stream message id of the current refresh job, if one was enqueued this turn. */
    job_id: string | null
    /** GET this URL to follow the refresh job's progress. */
    poll_url: string | null
    provider_health: ProviderHealth
    last_error: string | null
    /** Discovery scope identifiers — present on discovery envelopes. */
    provider_id?: string
    asset_name?: string
}

export interface Envelope<T> {
    data: T | null
    meta: InsightsMeta
}

/** Discovery-specific data payloads. */

/** Cached per-asset summary carried in bulk on the list endpoint so
 *  the UI can sort/paginate without one stats request per row. */
export interface AssetDetailSummary {
    name: string
    nodeCount: number | null
    edgeCount: number | null
    updatedAt: string | null
}

export interface AssetListPayload {
    assets: string[]
    assetsDetail?: AssetDetailSummary[]
}

export interface AssetStatsPayload {
    nodeCount: number
    edgeCount: number
    entityTypeCounts: Record<string, number>
    edgeTypeCounts: Record<string, number>
}

/** Historical entity counts.
 *
 *  Mirrors `HistoryPoint` / `LabelSeriesSummary` / `HistorySummary` /
 *  `CountHistoryPayload` / `ProviderHistoryPayload` in
 *  `backend/app/api/v1/endpoints/insights.py`. snake_case on the wire, like
 *  the rest of the insights surface. */

/** One observation of a data source's counts.
 *
 *  `node_min`/`node_max` are the extremes within the bucket and are present
 *  only at hour/day grain — a single closing value per bucket would hide a
 *  drop that happened and recovered inside it, which is the exact event this
 *  view exists to surface.
 *
 *  `node_delta` is relative to the previous snapshot, and is null on the first
 *  one (there is no predecessor a reader could open). */
export interface HistoryPoint {
    at: string
    node_count: number
    edge_count: number
    entity_type_counts: Record<string, number>
    edge_type_counts: Record<string, number>
    node_delta: number | null
    edge_delta: number | null
    node_min: number | null
    node_max: number | null
    /** Which collection lane observed it. */
    lane: 'probe' | 'poll' | 'deep' | 'sweep' | 'write'
    /** `heartbeat` rows are continuity, not events — the change ledger filters
     *  them out so a reader sees movement rather than ticks. */
    capture_reason: 'first' | 'changed' | 'heartbeat'
    /** How far this movement sits outside what is ordinary FOR THIS SOURCE,
     *  computed from the median absolute delta in the window. A fixed
     *  threshold cannot tell a catastrophic drop apart from a nightly rebuild. */
    significance: 'normal' | 'notable' | 'severe'
}

/** One `refresh_events` row inside the window — what the platform was doing
 *  while the counts moved. Mirrors `HistoryEvent` in
 *  `backend/app/api/v1/endpoints/insights.py`. */
export interface HistoryEvent {
    id: string
    ts: string
    origin: string
    actor: string
    scope: string
    outcome: string
    gate: string | null
    reason: string | null
    detail: string | null
    job_id: string | null
    run_id: string | null
}

export interface LabelSeriesSummary {
    label: string
    first: number
    last: number
    delta: number
    state: 'steady' | 'grew' | 'shrank' | 'new' | 'gone'
    /** One value per point in the window; absence in a snapshot is 0, not a
     *  gap — the probe lane drops zero-count buckets rather than reporting
     *  them, so absence IS zero. */
    points: number[]
}

/** The largest single negative movement in the window, computed from the raw
 *  rows rather than the downsampled points. */
export interface HistoryDrop {
    at: string
    label: string | null
    before: number
    after: number
    delta: number
}

export interface HistorySummary {
    node_first: number
    node_last: number
    node_delta: number
    node_pct_change: number | null
    edge_first: number
    edge_last: number
    edge_delta: number
    edge_pct_change: number | null
    snapshots: number
    changed_snapshots: number
    labels_added: string[]
    labels_removed: string[]
    largest_drop: HistoryDrop | null
    /** The typical absolute movement for this source in this window. Reported
     *  so the UI can say WHY something was called notable. */
    change_baseline: number
    notable_changes: number
    severe_changes: number
    /** Oldest snapshot held at ANY age. Without it, a series that simply
     *  started last Tuesday reads identically to one that lost everything
     *  before Tuesday. */
    coverage_from: string | null
    retention_days: number
}

export interface CountHistoryPayload {
    data_source_id: string
    from: string
    to: string
    grain: 'raw' | 'hour' | 'day'
    points: HistoryPoint[]
    labels: LabelSeriesSummary[]
    edge_labels: LabelSeriesSummary[]
    /** Platform activity in the same window, for correlation. */
    events: HistoryEvent[]
    summary: HistorySummary
}

export interface ProviderHistoryTotal {
    at: string
    node_count: number
    edge_count: number
    /** How many sources had been observed at least once by this bucket. */
    sources: number
}

export interface ProviderSeriesEntry {
    data_source_id: string
    name: string
    points: Array<{ at: string; node_count: number; edge_count: number }>
}

export interface ProviderHistoryPayload {
    provider_id: string
    from: string
    to: string
    grain: 'hour' | 'day'
    totals: ProviderHistoryTotal[]
    sources: ProviderSeriesEntry[]
    retention_days: number
}

/** Mirrors `HistoryRetentionResponse` in
 *  `backend/app/api/v1/endpoints/platform_settings.py`. This one IS camelCase
 *  — it is a platform-settings route, not an insights envelope. */
export interface HistoryRetentionPolicy {
    /** null = inheriting the env default. */
    retentionDays: number | null
    maxRowsPerSource: number | null
    heartbeatSecs: number | null
    envRetentionDays: number
    envMaxRowsPerSource: number
    envHeartbeatSecs: number
    effectiveRetentionDays: number
    effectiveMaxRowsPerSource: number
    effectiveHeartbeatSecs: number
    enabled: boolean
}

export interface HistoryRetentionUpdate {
    retentionDays?: number
    maxRowsPerSource?: number
    heartbeatSecs?: number
}


/** One recorded counts anomaly. Mirrors `CountAlert` in
 *  `backend/app/api/v1/endpoints/insights.py`. */
export interface CountAlert {
    id: string
    data_source_id: string
    catalog_item_id: string | null
    workspace_id: string | null
    provider_id: string | null
    /** Names frozen at alert time. An operator opening a week-old alert needs
     *  to know which source under which provider was hit, by which point the
     *  provider may have been renamed and the source relabelled or deleted. */
    provider_name: string | null
    graph_name: string | null
    data_source_label: string | null
    /** When the movement happened — not when it was noticed. Evaluation runs
     *  on a tick, so the two differ by up to one interval. */
    observed_at: string
    detected_at: string
    severity: 'notable' | 'severe' | 'critical'
    direction: 'drop' | 'rise'
    node_delta: number
    node_count: number
    /** What it was judged against. "Unusual" without this is a claim; with
     *  it, an argument. */
    baseline: number
    evidence: {
        nodes?: {
            added?: Record<string, number>
            removed?: Record<string, number>
            changed?: Record<string, [number, number]>
        }
    } | null
    acknowledged_at: string | null
    acknowledged_by: string | null
}

export interface CountAlertsResponse {
    alerts: CountAlert[]
    /** Unacknowledged across the whole fleet, not just this page. */
    openCount: number
}

/** Mirrors `AlertPolicyResponse`. camelCase — a policy route, not an
 *  insights envelope. */
export interface AlertPolicy {
    enabled: boolean | null
    minSeverity: 'notable' | 'severe' | null
    cooldownSecs: number | null
    envEnabled: boolean
    envMinSeverity: 'notable' | 'severe'
    envCooldownSecs: number
    effectiveEnabled: boolean
    effectiveMinSeverity: 'notable' | 'severe'
    effectiveCooldownSecs: number
}

export interface AlertPolicyUpdate {
    enabled?: boolean
    minSeverity?: 'notable' | 'severe'
    cooldownSecs?: number
}
