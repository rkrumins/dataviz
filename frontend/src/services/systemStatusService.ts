/**
 * systemStatusService — typed client for the super-admin infrastructure
 * snapshot (``GET /api/v1/admin/system/status``).
 *
 * The backend fans in every probe concurrently and caches the assembled
 * snapshot ~10s, so polling this endpoint is cheap by construction —
 * concurrent admin viewers share one probe sweep.
 */
import { authFetch } from './apiClient'

export type ServiceStatus = 'healthy' | 'degraded' | 'down' | 'unknown'

export interface ServiceEntry {
    key: string
    label: string
    status: ServiceStatus
    latencyMs: number | null
    error: string | null
    /** Free-form per-service facts (curated by the backend probes). The
     *  keys each tile reads are narrowed via the getters in the page. */
    detail: Record<string, unknown>
}

export interface StreamDepth {
    len: number | null
    pending: number | null
    oldestPendingAgeMs: number | null
    consumers: number | null
    /** XINFO GROUPS "lag" — entries added but not yet read by the group. */
    groupLag: number | null
    entriesAdded: number | null
    lastGeneratedId: string | null
    kind?: string
    lane?: string
}

export interface DlqDepth {
    len: number | null
    oldestAgeMs: number | null
}

export interface StreamsSection {
    aggregation: { jobs: StreamDepth; dlq: DlqDepth }
    insights: { streams: Record<string, StreamDepth>; dlq: DlqDepth }
}

export interface ProjectionWorstRow {
    graphId: string
    workspaceId: string
    dataSourceId: string
    falkorGraphName: string | null
    lag: number
    status: string
    lastError: string | null
    lastProjectedAt: string | null
    progressDone: number | null
    progressTotal: number | null
}

export interface ProjectionSection {
    totalGraphs: number
    fresh: number
    lagging: number
    projecting: number
    rebuilding: number
    evicted: number
    failed: number
    maxLag: number
    worst: ProjectionWorstRow[]
}

export interface AggregationJobsSection {
    total?: number
    byStatus?: Record<string, number>
    successRate?: number | null
    avgDurationSeconds?: number | null
    stuckJobs: number | null
}

export interface StatsPollingError {
    dataSourceId: string
    workspaceId: string
    label: string | null
    lastPolledAt: string | null
    lastError: string
}

export interface StatsPollingSection {
    byStatus: Record<string, number>
    overdue: number
    recentErrors: StatsPollingError[]
}

export interface OutboxSection {
    pending: number
    oldestPendingAgeS: number | null
    /** null = this process doesn't own the relay (role-based ownership). */
    relayAlive: boolean | null
}

export interface SystemStatusSnapshot {
    status: 'healthy' | 'degraded' | 'down'
    generatedAt: string
    cacheAgeMs: number
    services: ServiceEntry[]
    streams: StreamsSection | null
    projection: ProjectionSection | null
    aggregationJobs: AggregationJobsSection | null
    statsPolling: StatsPollingSection | null
    outbox: OutboxSection | null
}

export const systemStatusService = {
    get: (): Promise<SystemStatusSnapshot> =>
        authFetch<SystemStatusSnapshot>('/api/v1/admin/system/status'),
}
