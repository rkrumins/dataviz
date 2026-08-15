/**
 * freshnessService — the operator "Freshness cockpit" read + refresh surface.
 *
 * Wraps the F4/F5 admin endpoints:
 *   GET  /api/v1/admin/freshness                        — fleet overview (paged)
 *   GET  /api/v1/admin/data-sources/{id}/freshness      — per-source detail (+probe)
 *   POST /api/v1/admin/data-sources/{id}/refresh        — unified refresh verb
 *   POST /api/v1/admin/providers/{id}/refresh           — guarded provider batch
 *   GET  /api/v1/admin/refresh-batches/{id}             — batch progress
 *
 * Types mirror the committed pydantic aliases (camelCase on the wire). Every
 * Redis-sourced field is optional and degrades to null when the cache is cold.
 */
import { authFetch } from './apiClient'

export type RefreshScope = 'auto' | 'read-caches' | 'rollups' | 'full' | 'clear'

/** Coarse, UI-facing classification of a failed rebuild — drives the drawer's
 *  resolution guidance. Mirrors the backend ``classify_failure`` categories. */
export type FailureCategory =
    | 'out_of_memory'
    | 'provider_unavailable'
    | 'ontology'
    | 'timeout'
    | 'conflict'
    | 'unknown'

/** A reconciliation verdict, stamped by the sweep and read off the state row.
 *  Mirrors ``reconcile.DRIFT_STATES``. */
export type DriftStateValue =
    | 'inSync' | 'drifting' | 'overlayMissing' | 'neverBuilt'
    | 'blocked' | 'unobservable' | 'suspended'
    // Versioned graph: version control owns its rollups, so the sweep observes
    // and labels it but never acts. Mirrors ``reconcile.DRIFT_STATES``.
    | 'managed'

/** Why the sweep acted. Mirrors ``reconcile.REASONS``. */
export type ReconcileReason =
    | 'overlay_missing' | 'overlay_shrunk' | 'never_aggregated' | 'raw_drift'

export interface RefreshEventSummary {
    origin: string
    outcome: string
    ts: string
    actor?: string | null
    /** Set only on reconciliation events: the detector that fired. */
    reason?: ReconcileReason | string | null
    /** The counts behind ``reason`` — observed vs expected rollups, raw
     *  counts before → after, and how old the statistics were. */
    evidence?: Record<string, unknown> | null
    /** Derived server-side from origin, so the UI never decodes the origin
     *  vocabulary itself. */
    mode?: 'automatic' | 'manual' | null
    /** The aggregation job this event produced, when it produced one — the
     *  bridge from "why we rebuilt" to "what the rebuild did". */
    jobId?: string | null
}

export interface FreshnessRow {
    dataSourceId: string
    workspaceId?: string | null
    providerId?: string | null
    name?: string | null
    providerName?: string | null
    aggregationStatus?: string | null
    lastAggregatedAt?: string | null
    /** Currently always null server-side — use lastAggregatedAt for age. */
    lastMaterializedAt?: string | null
    cacheAsOf?: string | null
    generation?: number | null
    staleReason?: string | null
    /** Currently always null — derive "since" from lastEvent when accepted. */
    staleSince?: string | null
    cooldownUntil?: string | null
    storedFingerprint?: string | null
    /** Null unless the source was explicitly probed (fleet never probes). */
    drifted?: boolean | null
    runningJobId?: string | null
    lastEvent?: RefreshEventSummary | null
    /** Reconciliation, all stamped by the sweep — never recomputed on read. */
    driftState?: DriftStateValue | null
    /** Resolved per-source → global → env. */
    autoReconcile?: boolean | null
    lastCheckedAt?: string | null
    lastReconciledAt?: string | null
    lastReconcileReason?: ReconcileReason | string | null
    lastReconcileMode?: 'auto' | 'manual' | null
}

export interface FreshnessDoc extends FreshnessRow {
    lkgCount?: number | null
    lkgOldestAgeSecs?: number | null
    /** Per-source cache footprint: total live-generation cache keys, and the
     *  same tallied by endpoint segment. ``null`` = Redis error/disabled cache
     *  (unavailable), distinct from ``{}``/0 = nothing cached yet. Doc-only. */
    cacheKeyCount?: number | null
    cacheKeyCountByEndpoint?: Record<string, number> | null
    liveFingerprint?: string | null
    liveNodeCount?: number | null
    liveEdgeCount?: number | null
    events: RefreshEventSummary[]
    /** Raw per-source rebuild-interval override (null = none). */
    rebuildOverrideSecs?: number | null
    /** Effective rebuild window after resolving override → global → default. */
    resolvedRebuildIntervalSecs?: number | null
    /** Where the resolved interval came from. */
    rebuildIntervalSource?: 'custom' | 'global' | 'default' | null
    /** Failure surfacing (doc-only, populated only when the latest job failed):
     *  the raw error, a coarse category for resolution guidance, and how many
     *  attempts have been made. All null on a healthy source. */
    lastFailureReason?: string | null
    lastFailureCategory?: FailureCategory | null
    retryCount?: number | null
    /** The two numbers the integrity meter compares: what the statistics scan
     *  last counted in the graph, and what the last successful build reported
     *  writing. Measured at different instants, so small gaps are normal. */
    observedAggregatedEdges?: number | null
    expectedAggregatedEdges?: number | null
    statsAsOf?: string | null
    /** The check-cadence trio, mirroring the rebuild trio above. */
    reconcileIntervalOverrideSecs?: number | null
    resolvedReconcileIntervalSecs?: number | null
    reconcileIntervalSource?: 'custom' | 'global' | 'default' | null
    nextCheckAt?: string | null
    /** Set when the sweep is deliberately not acting on this source. */
    blockedReason?: string | null
}

/** Echo of the stored per-source overrides after a freshness-settings PATCH.
 *  Each field is null when no override is set (the source inherits). */
export interface FreshnessSettings {
    dataSourceId: string
    rebuildMinIntervalSecs?: number | null
    autoReconcileEnabled?: boolean | null
    reconcileCheckIntervalSecs?: number | null
}

/** PATCH body. Only the keys you send are written — every field treats an
 *  explicit null as "clear this override", so omitting one leaves it alone. */
export interface FreshnessSettingsPatch {
    rebuildMinIntervalSecs?: number | null
    autoReconcileEnabled?: boolean | null
    reconcileCheckIntervalSecs?: number | null
}

// ── Reconciliation ──────────────────────────────────────────────────

export interface ReconcileFinding {
    dataSourceId: string
    name?: string | null
    workspaceId?: string | null
    providerId?: string | null
    providerName?: string | null
    reason: ReconcileReason | string
    evidence: Record<string, unknown>
}

export interface ReconcileRun {
    id: string
    startedAt?: string | null
    finishedAt?: string | null
    mode: 'auto' | 'manual' | 'preview'
    actor?: string | null
    scanned: number
    skipped: number
    seeded: number
    findings: number
    actions: number
    errors: number
    byReason: Record<string, number>
    bySkip: Record<string, number>
}

/** Persisted policy plus the env defaults behind it, so an editor can seed
 *  from ``persisted ?? envDefault`` and a no-op save round-trips the real
 *  current default rather than pinning a wrong value. */
export interface ReconcilePolicy {
    enabled?: boolean | null
    checkIntervalSecs?: number | null
    maxActionsPerRun?: number | null
    shrinkTolerancePct?: number | null
    /** Unset = every detector on. An EMPTY array = every detector OFF. */
    detectors?: string[] | null
    envEnabled: boolean
    envCheckIntervalSecs: number
    envMaxActionsPerRun: number
    envShrinkTolerancePct: number
    envStatsMaxAgeSecs: number
    allDetectors: string[]
}

export interface ReconcileOverview {
    policy: ReconcilePolicy
    runs: ReconcileRun[]
}

export interface ReconcileActivityItem {
    runId: string
    runStartedAt?: string | null
    ts?: string | null
    dataSourceId: string
    name?: string | null
    workspaceId?: string | null
    providerId?: string | null
    providerName?: string | null
    reason?: ReconcileReason | string | null
    mode: 'auto' | 'manual'
    outcome: 'rebuilt' | 'held' | 'failed'
    skip?: string | null
    jobId?: string | null
    evidence: Record<string, unknown>
}

export interface ReconcileActivity {
    since: string
    items: ReconcileActivityItem[]
}

export interface ReconcileRunResult {
    run?: ReconcileRun | null
    findings: ReconcileFinding[]
    /** Another replica held the sweep lock, so nothing ran. Not an error. */
    skipped: boolean
}

/** Fleet-wide stat-tile counts, computed server-side over the
 *  workspace/provider-filtered set *before* the ``staleOnly`` facet and
 *  pagination. ``null`` on the response when that set exceeds the backend's
 *  bound (the assembly never does unbounded work). Mirrors the committed
 *  ``FreshnessSummary`` pydantic aliases; ``needsAttention`` is a per-row OR
 *  (marker present OR failed), not ``recomputing + failed``. */
export interface FreshnessSummary {
    total: number
    ready: number
    /** A rebuild job is in flight (counts the same signal as ``runningJobId``). */
    pending: number
    failed: number
    notBuilt: number
    /** A stale marker is present. */
    recomputing: number
    needsAttention: number
    /** Rows with a non-null ``cacheAsOf``. */
    cacheStamped: number
    /** Rows whose last reconciliation check found the rollups out of step
     *  (``drifting`` or ``overlayMissing``). */
    drifting: number
    /** Circuit breaker tripped — automation stopped; a person has to look. */
    suspended?: number
}

/** Per-provider breakdown of the fleet ``summary`` — identical bucket
 *  semantics, grouped by provider. ``providerId``/``providerName`` are null
 *  for the no-provider group. Note: no ``recomputing`` field (unlike the fleet
 *  ``summary``); client-count from rows if a strip needs it. */
export interface ProviderFreshnessSummary {
    providerId?: string | null
    providerName?: string | null
    total: number
    ready: number
    pending: number
    failed: number
    notBuilt: number
    needsAttention: number
    cacheStamped: number
    drifting: number
    suspended?: number
}

export interface FreshnessFleetResponse {
    rows: FreshnessRow[]
    total: number
    summary?: FreshnessSummary | null
    /** Per-provider summaries, aligned with ``summary``: ``null`` above the
     *  same >1000-source cap (coverage chips degrade to a client count). */
    providerSummaries?: ProviderFreshnessSummary[] | null
}

export interface RefreshResponse {
    scope: string
    gate: string
    changed: boolean
    actions: string[]
    jobId?: string | null
    deferred: boolean
    eventId?: string | null
}

export interface BatchItemResult {
    dataSourceId: string
    outcome: 'done' | 'error'
    jobId?: string | null
    /** Data source label; absent on older batches still in Redis. */
    name?: string | null
    /** What ran for this source, from the per-source RefreshResponse. */
    actions?: string[]
    /** Cooldown held the rebuild off — "done" but nothing was queued. */
    deferred?: boolean
}

export interface BatchStatus {
    batchId: string
    providerId: string
    total: number
    done: number
    results: BatchItemResult[]
    state: 'running' | 'done'
}

export interface FleetParams {
    workspaceId?: string | null
    providerId?: string | null
    staleOnly?: boolean
    page?: number
    pageSize?: number
}

const BASE = '/api/v1/admin'

export const freshnessService = {
    listFleet(params: FleetParams = {}): Promise<FreshnessFleetResponse> {
        const q = new URLSearchParams()
        if (params.workspaceId) q.set('workspaceId', params.workspaceId)
        if (params.providerId) q.set('providerId', params.providerId)
        if (params.staleOnly) q.set('staleOnly', 'true')
        if (params.page) q.set('page', String(params.page))
        if (params.pageSize) q.set('pageSize', String(params.pageSize))
        const qs = q.toString()
        return authFetch<FreshnessFleetResponse>(`${BASE}/freshness${qs ? `?${qs}` : ''}`)
    },

    getSourceDoc(dsId: string, probe = false): Promise<FreshnessDoc> {
        return authFetch<FreshnessDoc>(
            `${BASE}/data-sources/${dsId}/freshness?probe=${probe ? 'true' : 'false'}`,
        )
    },

    /** Unified refresh verb. The explicit scopes act unconditionally, so
     *  ``force`` is only ever forwarded for the ``auto`` scope. */
    refreshSource(
        dsId: string,
        body: { scope: RefreshScope; force?: boolean; reason?: string },
    ): Promise<RefreshResponse> {
        return authFetch<RefreshResponse>(`${BASE}/data-sources/${dsId}/refresh`, {
            method: 'POST',
            body: JSON.stringify(body),
        })
    },

    /** Guarded batch across every live source under a provider. 409 when a
     *  batch is already running for the provider. system:admin only. */
    refreshProvider(
        providerId: string,
        body: { scope: RefreshScope; force?: boolean },
    ): Promise<BatchStatus> {
        return authFetch<BatchStatus>(`${BASE}/providers/${providerId}/refresh`, {
            method: 'POST',
            body: JSON.stringify(body),
        })
    },

    /** Guarded batch across every live source in the whole fleet (every
     *  provider/workspace). 409 when a fleet batch is already running.
     *  system:admin only. The returned batch's ``providerId`` is the
     *  ``__fleet__`` sentinel. */
    refreshAll(body: { scope: RefreshScope; force?: boolean }): Promise<BatchStatus> {
        return authFetch<BatchStatus>(`${BASE}/freshness/refresh-all`, {
            method: 'POST',
            body: JSON.stringify(body),
        })
    },

    getBatch(batchId: string): Promise<BatchStatus> {
        return authFetch<BatchStatus>(`${BASE}/refresh-batches/${batchId}`)
    },

    /** Set or clear a source's rebuild-cadence and reconciliation overrides
     *  (null on a field clears it → the source resolves the global/env
     *  default). ds:manage only.
     *
     *  Send ONLY the fields you mean to change: the server applies exactly
     *  the keys present, because an explicit null means "clear". */
    patchFreshnessSettings(
        dsId: string,
        body: FreshnessSettingsPatch,
    ): Promise<FreshnessSettings> {
        return authFetch<FreshnessSettings>(`${BASE}/data-sources/${dsId}/freshness-settings`, {
            method: 'PATCH',
            body: JSON.stringify(body),
        })
    },

    // ── Reconciliation ───────────────────────────────────────────────

    /** Policy + recent sweep runs. Ingestion-read. */
    getReconciliation(limit = 20): Promise<ReconcileOverview> {
        return authFetch<ReconcileOverview>(
            `${BASE}/freshness/reconciliation?limit=${limit}`,
        )
    },

    /** Overnight blotter: findings joined to jobs by run_id. Default 24h. */
    getReconciliationActivity(since = '24h'): Promise<ReconcileActivity> {
        return authFetch<ReconcileActivity>(
            `${BASE}/freshness/reconciliation/activity?since=${encodeURIComponent(since)}`,
        )
    },

    /** Update the global policy. Partial: only the keys sent are written.
     *  Platform-admin only. */
    putReconciliation(body: Partial<ReconcilePolicy>): Promise<ReconcilePolicy> {
        return authFetch<ReconcilePolicy>(`${BASE}/freshness/reconciliation`, {
            method: 'PUT',
            body: JSON.stringify(body),
        })
    },

    /** Run a sweep now. ``dryRun`` evaluates and reports without queueing
     *  anything — the blast-radius preview. Platform-admin only. */
    reconcileNow(
        body: { dryRun?: boolean; dataSourceIds?: string[] } = {},
    ): Promise<ReconcileRunResult> {
        return authFetch<ReconcileRunResult>(`${BASE}/freshness/reconcile-now`, {
            method: 'POST',
            body: JSON.stringify(body),
        })
    },
}
