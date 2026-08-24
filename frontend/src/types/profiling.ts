/**
 * Wire types for `/api/v1/profiling`.
 *
 * Series-major, mirroring the backend: a payload is a list of SERIES, each
 * with its own points. The previous shape was one point per instant with the
 * per-type maps embedded inside it, which forced every consumer to pivot
 * before it could draw anything and made "which measure" and "broken down by
 * what" entangled rather than orthogonal.
 */

export type ProfilingScope = 'source' | 'workspace' | 'provider' | 'all'
export type ProfilingMetric = 'total' | 'nodes' | 'edges'
export type ProfilingBreakdown = 'none' | 'entity_type' | 'edge_type'
export type ProfilingGrain = 'auto' | 'raw' | 'hour' | 'day'
export type ProfilingWindow = '24h' | '7d' | '30d' | '90d' | 'custom'

export type Significance = 'normal' | 'notable' | 'severe' | 'critical'

export interface SeriesPoint {
    t: string
    v: number
    /** Intra-bucket extremes, present only at hour/day grain and only when
     *  every contributing source reported them. Half a band is a lie about
     *  the other half. */
    min?: number
    max?: number
}

export interface ProfilingSeries {
    key: string
    label: string
    kind: 'metric' | 'type'
    points: SeriesPoint[]
}

export interface SeriesPayload {
    scope: ProfilingScope
    id: string | null
    from: string
    to: string
    window: ProfilingWindow
    grain: Exclude<ProfilingGrain, 'auto'>
    requested_metric: ProfilingMetric
    breakdown: ProfilingBreakdown
    buckets: string[]
    series: ProfilingSeries[]
    totals: { nodes: number[]; edges: number[]; total: number[] }
    /** Which altitude this is. "Nothing moved" means very different things
     *  across a deployment and across one workspace's sources. */
    platform_wide: boolean
    truncated: boolean
    vanished_types: { type: string; peak: number }[]
    /** Where this scope's record begins, so a short series can say so rather
     *  than reading as data loss. */
    coverage_from: string | null
    sources_observed: number
    previous?: SeriesPayload
}

export interface BoardRow {
    data_source_id: string
    name: string
    catalog_item_id: string | null
    workspace_id: string | null
    workspace_name: string | null
    provider_id: string | null
    provider_name: string | null
    /** Picks the logo. A name alone cannot. */
    provider_type: string | null
    first: number
    last: number
    delta: number
    pct_change: number | null
    points: number[]
    observations: number
    last_observed_at: string | null
    significance: Significance
    baseline: number
}

export interface BoardPayload {
    from: string
    to: string
    window: ProfilingWindow
    metric: 'nodes' | 'edges'
    platform_wide: boolean
    rows: BoardRow[]
    total: number
    offset: number
    limit: number
    /** Sources with no observation in the window. COUNTED, never listed at
     *  zero — one that was not observed did not drop to nothing. */
    unobserved: number
}

export interface Observation {
    id: string
    at: string
    lane: 'probe' | 'poll' | 'deep' | 'sweep' | 'write'
    reason: 'first' | 'changed' | 'heartbeat' | 'run'
    /** The refresh event whose run produced this, when one did. */
    refresh_event_id: string | null
    node_count: number
    edge_count: number
    node_delta: number | null
    edge_delta: number | null
    entity_type_counts: Record<string, number>
    edge_type_counts: Record<string, number>
    type_deltas: string | null
    significance: { nodes: Significance; edges: Significance }
}

export interface RefreshEvent {
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

export interface ObservationsPayload {
    id: string
    from: string
    to: string
    window: ProfilingWindow
    observations: Observation[]
    total: number
    offset: number
    limit: number
    baselines: { nodes: number; edges: number }
    events: RefreshEvent[]
    /** Facts about the PERIOD, counted server-side. Deriving these from the
     *  returned page makes the total shrink as the page does. */
    counts: {
        observations: number
        moved: number
        checkpoints: number
        runs: number
    }
}

export type FindingKind = 'movement' | 'type_gone' | 'silent'

export interface Finding {
    id: string
    data_source_id: string
    detected_at: string
    observed_at: string | null
    workspace_id: string | null
    workspace_name: string | null
    provider_id: string | null
    provider_name: string | null
    /** Picks the logo. A name alone cannot. */
    provider_type: string | null
    data_source_label: string | null
    graph_name: string | null
    catalog_item_id: string | null
    severity: Exclude<Significance, 'normal'>
    direction: 'drop' | 'rise'
    metric: 'nodes' | 'edges'
    finding: FindingKind
    subject_type: string | null
    delta: number
    count: number
    baseline: number
    evidence: string | null
    acknowledged_at: string | null
    acknowledged_by: string | null
}

export interface FindingsPayload {
    alerts: Finding[]
    total: number
    openCount: number
    offset: number
    limit: number
    platform_wide: boolean
}

export interface ProfilingPolicy {
    rawRetentionDays: number
    hourlyRetentionDays: number
    dailyRetentionDays: number
    maxRowsPerSource: number
    heartbeatSecs: number
    silentAfterSecs: number
    alertsEnabled: boolean
    alertMinSeverity: string
    alertCooldownSecs: number
    /** What the deployment would use with nothing persisted — the editor shows
     *  these as placeholders, so a blank field means "inherit" rather than
     *  pinning today's value forever. */
    defaults: {
        rawRetentionDays: number
        hourlyRetentionDays: number
        dailyRetentionDays: number
        maxRowsPerSource: number
        heartbeatSecs: number
        silentAfterSecs: number
        alertMinSeverity: string
        alertCooldownSecs: number
    }
    /** Fields an operator has actually set, so the editor can mark them. */
    overridden: string[]
    editable: boolean
    /** Deployment cadences: reported so an operator can see how hard the
     *  service works, never settable — the purge cannot delete raw beyond the
     *  compaction watermark, so a live-editable compact interval is a way to
     *  stall retention from a settings page. */
    cadences: {
        captureHeartbeatSecs: number
        compactIntervalSecs: number
        retentionIntervalSecs: number
        alertIntervalSecs: number
        readOnly: true
    }
}

/** `-1` clears an override and returns that field to the deployment default. */
export const INHERIT_DEFAULT = -1
