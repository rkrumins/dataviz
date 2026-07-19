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

export type RefreshScope = 'auto' | 'read-caches' | 'rollups' | 'full'

export interface RefreshEventSummary {
    origin: string
    outcome: string
    ts: string
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
}

export interface FreshnessDoc extends FreshnessRow {
    lkgCount?: number | null
    lkgOldestAgeSecs?: number | null
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
}

/** Echo of the stored per-source override after a freshness-settings PATCH. */
export interface FreshnessSettings {
    dataSourceId: string
    rebuildMinIntervalSecs?: number | null
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
}

export interface FreshnessFleetResponse {
    rows: FreshnessRow[]
    total: number
    summary?: FreshnessSummary | null
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

    getBatch(batchId: string): Promise<BatchStatus> {
        return authFetch<BatchStatus>(`${BASE}/refresh-batches/${batchId}`)
    },

    /** Set or clear a source's rebuild-cadence override (null clears it →
     *  the source resolves the global/env default). ds:manage only. */
    patchFreshnessSettings(
        dsId: string,
        body: { rebuildMinIntervalSecs: number | null },
    ): Promise<FreshnessSettings> {
        return authFetch<FreshnessSettings>(`${BASE}/data-sources/${dsId}/freshness-settings`, {
            method: 'PATCH',
            body: JSON.stringify(body),
        })
    },
}
