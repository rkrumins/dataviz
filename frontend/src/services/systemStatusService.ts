/**
 * systemStatusService — typed client for the super-admin infrastructure
 * snapshot (``GET /api/v1/admin/system/status``).
 *
 * The backend fans in every probe concurrently and caches the assembled
 * snapshot ~10s, so polling this endpoint is cheap by construction —
 * concurrent admin viewers share one probe sweep.
 */
import { authFetch } from './apiClient'
import type { BuildState, Watermark } from './versioningApiService'

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
    /** FalkorDB only, once the graph store has been read: versioned graphs
     *  projecting here and the size of their keys (null when none is known). */
    versionedGraphs?: number
    versionedBytes?: number | null
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

/** An old FalkorDB key a moved graph still holds: it is dropped once the
 *  new key has caught up to ``afterSeq`` and ``retireAfter`` has passed. */
export interface RetiredProjectionKey {
    name: string
    provider: string | null
    retireAfter: string
    afterSeq: number
}

/** A graph's residency class (doc 17): Always stays in FalkorDB, Standard is
 *  evicted when unread for a while or under memory pressure, Coldline is
 *  loaded only when a request needs FalkorDB. */
export type ResidencyClass = 'always' | 'standard' | 'coldline'

/** Whether a graph's key is in FalkorDB: ``rehydrating`` is being loaded,
 *  ``waiting_capacity`` waits for room on its master. */
export type ResidencyState = 'resident' | 'evicted' | 'rehydrating' | 'waiting_capacity'

/** One row of the fleet inventory (``GET /api/v1/admin/versioning/graphs``):
 *  a projection row, plus whether the platform owns the key, whether the
 *  graph is a fork or an orphan (not a fork, and its data source is gone),
 *  the old keys a move left behind, and its residency. */
/** What a graph's readers get while a newer version lands: always the newest (from the database
 *  until the graph store has it), the last version while the next is written in place, or exactly
 *  the last version while the next is built beside it, then one switch. */
export type ReadMode = 'latest' | 'in_place' | 'beside'

export interface VersionedGraphRow extends ProjectionWorstRow {
    owned: boolean
    forkParentGraphId: string | null
    orphan: boolean
    retiredKeys: RetiredProjectionKey[]
    /** Null on a fork, which has no residency of its own: no key, and its reads count for its
     *  root's row. */
    residency: ResidencyClass | null
    residencyState: ResidencyState | null
    evictedReason: string | null
    lastReadAt: string | null
    sizeBytes: number | null
    /** While it is being loaded: since when (a load has no timeout). */
    rehydratingSince: string | null
    /** Its own read mode (null: it takes its workspace's or the platform's), and the one in force.
     *  Null on a fork, which follows its root. */
    readMode: ReadMode | null
    readModeEffective: ReadMode | null
    /** The mode chosen for it, wherever it was chosen; the one in force differs when it can't be had.
     *  These three are null on a fork. */
    readModeDeclared?: ReadMode | null
    /** Where the mode chosen was chosen: `graph`, `workspace`, `platform`, `env` or `default`. */
    readModeSource?: 'graph' | 'workspace' | 'platform' | 'env' | 'default' | null
    /** Why the mode in force differs from the one chosen: `{code, text, fix}` each, the server's words. */
    readModeWhy?: Array<{ code: string; text: string; fix: { feature?: string; setting?: string; to: unknown } | null }> | null
    /** A new version built beside its key (read mode beside), while one is; absent or null when
     *  none is. */
    build?: BuildState | null
}

/** One New-version build setting: as saved (null: unset), its default, and the value in force. */
export interface BuildPolicyValue {
    saved: number | boolean | string | null
    default: number | boolean | string
    effective: number | boolean | string
}

/** How the card shows one New-version build setting, and the range the server accepts.
 *  ``applies``: ``next`` (a build already under way keeps the value it started with), ``live``
 *  (read at every window and statement) or ``switch`` (when a build switches, or a key is moved). */
export interface BuildPolicyField {
    wire: string
    kind: 'bool' | 'int' | 'ratio' | 'choice'
    section: 'reads' | 'when' | 'room' | 'lifecycle' | 'pacing' | 'postgres'
    label: string
    help: string
    unit: 'rows' | 'pct' | 'bytes' | 'secs' | 'ms' | 'count' | 'ratio' | null
    min: number | null
    max: number | null
    choices: string[] | null
    applies: 'next' | 'live' | 'switch'
}

/** ``GET /api/v1/admin/versioning/build-policy``: each value by wire name, each setting in order
 *  (``fields``), who changed the values last and when, and ``enabled``: the New-version builds
 *  switch (Admin → Features). */
export interface BuildPolicy {
    values: Record<string, BuildPolicyValue>
    fields: BuildPolicyField[]
    updatedBy: string | null
    updatedAt: string | null
    enabled: boolean
}

/** What ``POST /api/v1/admin/versioning/graphs/{graphId}/projection/move``
 *  did: ``changed`` is false when the graph already was on the target. ``beside``: the move is
 *  built beside the graph's key (read mode beside) — ``building`` is the build, readers keep the
 *  current version until the switch, and nothing retires until then (``retiring`` null). With
 *  ``changed`` false, ``beside`` means this move was already under way. ``cancelled``: a move back
 *  to where the graph is cancelled the move under way (the build's id). */
export interface ProjectionMoveResult {
    graphId: string
    changed: boolean
    from: { providerId: string; key: string }
    to: { providerId: string; key: string }
    retiring: RetiredProjectionKey | null
    beside?: boolean
    building?: BuildState | null
    cancelled?: string | null
    watermark: Watermark
}

/** A state the inventory filters by: `rehydrating` is loading as each row says it (a load, or a copy
 *  written from nothing); `building`, a new version built beside its copy. */
export type ProjectionBucket = 'fresh' | 'lagging' | 'projecting' | 'rebuilding' | 'evicted'
    | 'rehydrating' | 'waiting_capacity' | 'failed' | 'building'

export interface VersionedGraphsFilter {
    provider?: string
    status?: ProjectionBucket
    kind?: 'main' | 'fork' | 'orphan'
    q?: string
}

export interface ProjectionSection {
    totalGraphs: number
    fresh: number
    lagging: number
    projecting: number
    rebuilding: number
    evicted: number
    /** Residency (doc 17): being loaded, and waiting for room on their master. */
    rehydrating?: number
    waitingCapacity?: number
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

export interface ReconciliationSection {
    enabled: boolean
    intervalSecs: number
    lastStartedAt: string | null
    stopped: boolean
    notYetRun: boolean
    suspendedCount: number
}

export interface OutboxSection {
    pending: number
    oldestPendingAgeS: number | null
    /** Whether events are reaching the activity ledger: false once one has
     *  waited minutes while nothing was recorded. */
    relayAlive: boolean | null
}

export interface OverviewSection {
    workspaces?: number
    dataSources?: number
    providers?: { total: number; active: number }
    /** Graphs backed by a data source that still exists (live). */
    versionedGraphs?: number
    /** Graphs whose data source was deleted — no GC, so they accumulate. */
    orphanedGraphs?: number
    openReviews?: number
    commits?: number
}

/**
 * "Enable version control" jobs. Needed here because they are invisible to every other
 * section by construction: a bootstrapping graph parks its projection watermark (so the
 * projector never drops the source graph mid-copy), which makes it read as idle, lag-free
 * and FRESH to the projection probe. A copy that failed days ago — and is silently blocking
 * writes to that data source — would otherwise render as "in sync".
 */
export interface BootstrapJobEntry {
    jobId: string
    graphId: string
    dataSourceId: string | null
    workspaceId: string | null
    status: 'pending' | 'running' | 'failed' | 'completed' | 'cancelled'
    phase: string | null
    processed: number
    total: number
    error: string | null
    updatedAt: string | null
}

export interface BootstrapJobsSection {
    running: number
    pending: number
    failed: number
    completed: number
    /** `running`, but the worker's heartbeat is older than the takeover window and nobody
     *  has claimed it — i.e. the whole worker tier is gone, not merely one pod. */
    stalled: number
    jobs: BootstrapJobEntry[]
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
    bootstrapJobs: BootstrapJobsSection | null
    statsPolling: StatsPollingSection | null
    reconciliation: ReconciliationSection | null
    outbox: OutboxSection | null
}

export const systemStatusService = {
    get: (): Promise<SystemStatusSnapshot> =>
        authFetch<SystemStatusSnapshot>('/api/v1/admin/system/status'),
    /** Reseed every versioned graph on a FalkorDB provider from Postgres
     *  (after its instance was restored). ``dryRun`` only counts them. */
    resetWatermarks: (provider: string, opts?: { dryRun?: boolean }): Promise<{
        provider: string; graphsReset?: number; graphsToReset?: number
    }> =>
        authFetch('/api/v1/admin/versioning/watermarks/reset', {
            method: 'POST',
            body: JSON.stringify({ provider, dryRun: !!opts?.dryRun }),
        }),
    /** Move one versioned graph's projection to another FalkorDB provider or
     *  key; without ``key`` the server picks the graph's next platform key. */
    moveProjection: (graphId: string, body: { providerId: string; key?: string }): Promise<ProjectionMoveResult> =>
        authFetch<ProjectionMoveResult>(`/api/v1/admin/versioning/graphs/${encodeURIComponent(graphId)}/projection/move`, {
            method: 'POST',
            body: JSON.stringify(body),
        }),
    /** New-version builds: each setting as saved, its default and the value in force. */
    buildPolicy: (): Promise<BuildPolicy> =>
        authFetch<BuildPolicy>('/api/v1/admin/versioning/build-policy'),
    /** Load now: ask for an evicted graph's load, which admission decides. */
    loadGraph: (graphId: string): Promise<{ graphId: string; state: ResidencyState; loadRequested: boolean }> =>
        authFetch(`/api/v1/admin/versioning/graphs/${encodeURIComponent(graphId)}/load`, { method: 'POST' }),
    /** Adopt a graph projecting into the customer's own key onto a platform key. */
    adoptGraph: (graphId: string): Promise<{ graphId: string; from: { providerId: string; key: string }; to: { providerId: string; key: string } }> =>
        authFetch(`/api/v1/admin/versioning/graphs/${encodeURIComponent(graphId)}/adopt`, { method: 'POST' }),
}
