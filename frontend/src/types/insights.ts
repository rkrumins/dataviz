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
export interface AssetListPayload {
    assets: string[]
}

export interface AssetStatsPayload {
    nodeCount: number
    edgeCount: number
    entityTypeCounts: Record<string, number>
    edgeTypeCounts: Record<string, number>
}
