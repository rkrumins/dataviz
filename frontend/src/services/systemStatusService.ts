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

export interface ConsumerDetail {
    name: string | null
    pending: number
    idleMs: number | null
}

export interface StreamDepth {
    /** Consumer group name — supplied by the backend, not reconstructed. */
    group: string
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
    /** Per-consumer PEL breakdown (largest pending first). */
    consumerDetail: ConsumerDetail[] | null
    /** Pending messages held by consumers past the dead-idle threshold. */
    orphanedPending: number | null
    deadConsumers: number | null
}

export interface DlqSource {
    dataSourceId: string
    workspaceId: string | null
    count: number
    /** Resolved from the management DB so the UI shows a name, not an id. */
    label?: string | null
    workspaceName?: string | null
    providerName?: string | null
    providerType?: string | null
}

export interface DlqDepth {
    len: number | null
    oldestAgeMs: number | null
    /** Breakdown of why entries died (reason → count). */
    reasons: Record<string, number> | null
    /** Data sources generating the most dead-letters. */
    topSources: DlqSource[] | null
    kinds: Record<string, number> | null
    sampled: number | null
}

/** A stream/DLQ carries its own identity (name, family) so the UI and
 *  diagnostics stay generic — no hardcoded family structure. */
export interface StreamDescriptor extends StreamDepth {
    name: string
    family: string
}

export interface DlqDescriptor extends DlqDepth {
    name: string
    family: string
}

export interface StreamsSection {
    streams: StreamDescriptor[]
    dlqs: DlqDescriptor[]
}

/** A registered graph data provider (any type) + its resolved health. */
export interface GraphProvider {
    id: string
    name: string
    /** falkordb | neo4j | spanner | datahub | mock | … */
    type: string
    status: ServiceStatus
    error: string | null
    isActive: boolean
}

export interface ProjectionWorstRow {
    graphId: string
    workspaceId: string
    workspaceName: string | null
    dataSourceId: string
    dataSourceLabel: string | null
    /** The provider backing this data source (falkordb/neo4j/…). */
    providerName: string | null
    providerType: string | null
    kind: string | null
    falkorGraphName: string | null
    falkorProvider: string | null
    committed: number | null
    projected: number | null
    target: number | null
    lag: number
    status: string
    lastError: string | null
    lastProjectedAt: string | null
    progressDone: number | null
    progressTotal: number | null
    updatedAt: string | null
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

export interface OverviewSection {
    workspaces?: number
    dataSources?: number
    providers?: { total: number; active: number }
    versionedGraphs?: number
    openReviews?: number
    commits?: number
}

export interface SystemStatusSnapshot {
    status: 'healthy' | 'degraded' | 'down'
    generatedAt: string
    cacheAgeMs: number
    overview: OverviewSection | null
    services: ServiceEntry[]
    graphProviders: GraphProvider[] | null
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
