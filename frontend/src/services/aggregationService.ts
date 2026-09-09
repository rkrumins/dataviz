import { authFetch } from './apiClient';

/**
 * Pipeline tuning overrides (camelCase aliases accepted by the backend).
 * All fields optional — omitted keys fall back to the worker's AIMD
 * self-tuning defaults. These are caps/floors, not fixed values.
 */
export interface AggregationTuning {
  // `null` means "clear this default" — the settings PUT merges `tuning`, so a
  // key that is simply absent is left as-is and only an explicit null removes
  // it. Omitting a key from a per-job request still means "inherit".
  scanRangeWidth?: number | null;      // 10,000 .. 5,000,000
  maxPendingPairs?: number | null;     // 50,000 .. 50,000,000
  applyChunk?: number | null;          // 1,000 .. 200,000
  deleteChunk?: number | null;         // 100 .. 50,000
  writePacingRatio?: number | null;    // 0 .. 10
  extractConcurrency?: number | null;  // 1 .. 4
  /** Share of the worker's memory limit at which the pipeline flushes early (fleet-wide). 30 .. 90 */
  flushMemPct?: number | null;
  /** Narrowest scan slice the pressure ladder descends to (default 1 row). 1 .. 5,000,000 */
  scanShrinkFloor?: number | null;
  /** Per-query budget for read scans, seconds (capped by the store's TIMEOUT_MAX). 5 .. 600 */
  scanTimeoutS?: number | null;
  /** Per-query budget for write/delete batches, seconds (capped by the store's TIMEOUT_MAX). 5 .. 600 */
  writeTimeoutS?: number | null;
  /** Fleet default for the stall window, seconds; a job's own timeoutSecs wins. 60 .. 604,800 */
  stallTimeoutSecs?: number | null;
  /** Wall-clock safety net, seconds — never below the stall window. 3,600 .. 604,800 */
  maxWallSecs?: number | null;
  /** Start from the knobs as set, ignoring what the last run of this source learned. */
  ignoreObserved?: boolean | null;
  materializeLeafPairs?: boolean;
  /**
   * Rollup storage. `true` (the shipped default) pre-creates every
   * ancestor-pair combination and FAILS the job above the write budget;
   * `'auto'` stores the full cube only while it fits the cube ceiling and
   * falls back to the depth-diagonal + on-demand reads above it. Absent
   * means "inherit" — the stored global default, then the env default —
   * which is why "Auto" must be sent as `'auto'` and never by omitting the
   * key: omission cannot override a stored `true`.
   */
  materializeFinePairs?: boolean | 'auto';
  /**
   * Optional explicit ceiling on stored :AGGREGATED edges, layered over the
   * measured shard budget. Absent (the norm) means the budget is what the
   * graph's own shard has free; set it only to hold a graph BELOW that.
   */
  maxMaterializedEdges?: number | null; // 10,000 .. 500,000,000
  /** Share of the owning shard's maxmemory the rebuild must leave free. */
  shardReservePct?: number | null;      // 0 .. 90
  /** Bytes one rolled-up edge costs on the shard; overrides the calibrated figure. */
  bytesPerEdge?: number | null;         // 64 .. 16384
}

export interface AggregationTriggerRequest {
  ontologyId?: string;
  projectionMode: string;
  batchSize: number;
  maxRetries?: number;
  timeoutSecs?: number;
  tuning?: AggregationTuning;
}

export interface AggregationSkipRequest {
  confirmed: boolean;
}

export interface AggregationScheduleRequest {
  cronExpression: string | null;
}

export interface AggregationJobResponse {
  id: string;
  dataSourceId: string;
  status: 'pending' | 'running' | 'completed' | 'failed' | 'cancelled';
  triggerSource: string;
  /** Set only when ``triggerSource === 'reconcile'``: the detector that fired
   *  and the counts behind it, read from the audit event naming this job.
   *  "Automatic" alone just relocates the question — this answers it. */
  reconcileReason?: string | null;
  reconcileEvidence?: Record<string, unknown> | null;
  progress: number;
  totalEdges: number;
  processedEdges: number;
  createdEdges: number;
  batchSize: number;
  lastCheckpointAt?: string;
  /**
   * Cursor-based resume checkpoint. Non-null implies the worker can resume from this position.
   * BE-1 must expose this field on the API response — currently absent server-side; if missing
   * at runtime the Resume button stays hidden (treated as null).
   */
  lastCursor?: string | null;
  resumable: boolean;
  retryCount: number;
  maxRetries?: number;
  timeoutSecs?: number;
  errorMessage?: string;
  estimatedCompletionAt?: string;
  startedAt?: string;
  completedAt?: string;
  updatedAt?: string;
  createdAt: string;
  // Enrichment fields — populated by global listing endpoint
  workspaceId?: string;
  workspaceName?: string;
  dataSourceLabel?: string;
  projectionMode?: string;
  durationSeconds?: number;
  edgeCoveragePct?: number;
  /**
   * Short ID for the currently-active phase of the materialization pipeline.
   * One of: 'extracting' | 'computing' | 'reconciling' | 'applying'.
   * Null on providers that don't emit phase signals — UI falls back to a generic label.
   */
  currentPhase?: string | null;
  /**
   * Effective tuning the pipeline ran with (snake_case keys: scan_range_width,
   * max_pending_pairs, apply_chunk, delete_chunk, write_pacing_ratio,
   * extract_concurrency, materialize_leaf_pairs). Non-null implies the job ran
   * on the self-tuning pipeline.
   */
  tuning?: Record<string, unknown> | null;
  /**
   * The run's durable record: per-phase seconds and counters on success,
   * plus — written at the first checkpoint, so a failed or cancelled run has
   * it too — what the run ran with (`effective_tuning`) and what its pressure
   * ladder adapted to (`adapted`).
   */
  runStats?: AggregationRunStats | null;
  workerId?: string | null;
  /**
   * The same coarse bucket the Freshness cockpit shows for a failure
   * (`query_memory`, `timeout`, `write_budget`, `out_of_memory`, …); null
   * when there is no error.
   */
  failureCategory?: string | null;
  /**
   * Limits raised on the running job: the wall clock and per-query budgets in
   * force, and a bounded history of who raised what, from what, to what. The
   * stall window in force is `timeoutSecs`.
   */
  liveOverrides?: LiveOverrides | null;
}

export interface LiveLimitChange {
  at: string;
  by?: string | null;
  field:
    | 'timeout_secs' | 'max_wall_secs' | 'scan_timeout_s' | 'write_timeout_s'
    | 'write_pacing_ratio' | 'extract_concurrency' | 'scan_width' | string;
  from?: number | null;
  /** null = cleared, back to the job's setting. */
  to?: number | null;
}

export interface LiveOverrides {
  max_wall_secs?: number;
  scan_timeout_s?: number;
  write_timeout_s?: number;
  /** The scan shape changed on the running job: pacing (0 = none), a read-concurrency cap, a scan-width cap. */
  write_pacing_ratio?: number;
  extract_concurrency?: number;
  scan_width?: number;
  history?: LiveLimitChange[];
}

/** Live values a patch may clear — back to the job's settings. */
export type LiveResetKey = 'writePacingRatio' | 'extractConcurrency' | 'scanWidth' | 'scanTimeoutS' | 'writeTimeoutS';

/**
 * What can be changed on a pending or running job without cancelling it: the
 * four time limits, and the scan shape — pacing from the next write, a
 * read-concurrency cap from the next wave, a scan-width cap from the next scan
 * (the ladder may still narrow below it on its own).
 */
export interface JobLimitsPatch {
  /** Stall window, seconds (60 .. 604,800). */
  timeoutSecs?: number;
  /** Wall-clock safety net, seconds (3,600 .. 604,800); never applied below the stall window. */
  maxWallSecs?: number;
  /** Per-query budget for read scans, seconds (5 .. 600). */
  scanTimeoutS?: number;
  /** Per-query budget for write/delete batches, seconds (5 .. 600). */
  writeTimeoutS?: number;
  /** Sleep-after-write ratio (0 .. 10; 0 = no pacing), from the next write. */
  writePacingRatio?: number;
  /** A cap on read concurrency (1 .. 4), from the next wave. */
  extractConcurrency?: number;
  /** A cap on the scan width (1 .. 5,000,000), from the next scan. */
  scanWidth?: number;
  /** Live values to clear — back to the job's settings. */
  reset?: LiveResetKey[];
}

/** Where a knob's value came from for one run. */
export type RunKnobSource = 'job' | 'hint' | 'env';

/**
 * Every knob's value for one run (snake_case, as the pipeline stores them)
 * and, under `sources`, where each came from. `stall_timeout_secs`,
 * `max_wall_secs` and `max_retries` are the worker's own limits.
 */
export interface EffectiveTuningSnapshot {
  scan_range_width?: number;
  max_pending_pairs?: number;
  apply_chunk?: number;
  delete_chunk?: number;
  write_pacing_ratio?: number;
  extract_concurrency?: number;
  materialize_leaf_pairs?: boolean;
  materialize_fine_pairs?: 'auto' | 'true' | 'false' | string;
  max_materialized_edges?: number | null;
  shard_reserve_pct?: number;
  bytes_per_edge?: number;
  scan_shrink_floor?: number;
  scan_timeout_s?: number;
  write_timeout_s?: number;
  flush_mem_pct?: number;
  ignore_observed?: boolean;
  stall_timeout_secs?: number;
  max_wall_secs?: number;
  max_retries?: number;
  sources?: Record<string, RunKnobSource | string>;
  [key: string]: unknown;
}

/** One per-query pressure event the ladder absorbed. */
export interface PressureEvent {
  scan: string;
  kind: 'memory' | 'timeout' | string;
  lo?: number;
  hi?: number;
  size?: number;
}

/**
 * What the pressure ladder changed during a run — the current sticky scan
 * width, the narrowest it needed, how often it shrank, the read concurrency
 * and reconcile strategy in force, the write batch / delete chunk it settled
 * on, timeout retries, and (bounded) which scans were under pressure. Absent
 * on a run that ran at its settings.
 */
export interface AdaptedRunState {
  scan_width?: number | null;
  scan_width_min?: number;
  scan_shrinks?: number;
  extract_concurrency?: number;
  reconcile_strategy?: 'keys_only' | string;
  write_batch?: number | null;
  write_batch_min?: number;
  write_shrinks?: number;
  delete_chunk?: number | null;
  delete_chunk_min?: number;
  delete_shrinks?: number;
  timeout_retries?: number;
  budget_rechecks?: number;
  /** The memory-aware flush: early flushes and base roll-ups on worker memory pressure, the peak RSS and the limit (MB). */
  memory_flushes?: number;
  memory_rollups?: number;
  rss_high_water_mb?: number;
  mem_limit_mb?: number;
  pressure?: PressureEvent[];
  by_scan?: Record<string, { events: number; min_size: number; kind: string }>;
  /** What the previous run of this source taught it, applied at the start. */
  from_last_run?: Record<string, number | string>;
  /** What an operator changed on the running job, in force now. */
  live?: Partial<Record<'scan_timeout_s' | 'write_timeout_s' | 'write_pacing_ratio' | 'extract_concurrency' | 'scan_width', number>>;
}

export interface AggregationRunStats {
  extract_s?: number;
  compute_s?: number;
  reconcile_s?: number;
  apply_s?: number;
  writes?: number;
  deletes?: number;
  pairs?: number;
  scanned_edges?: number;
  fine_merges_skipped?: number;
  regime?: 'cube' | 'boundary' | string;
  materialize_budget?: number;
  cube_estimate?: number;
  write_budget?: Record<string, unknown>;
  bytes_per_edge_observed?: number;
  scan_width_min?: number;
  scan_shrinks?: number;
  budget_rechecks?: number;
  /** The store's per-query ceiling the ladder narrowed against; null when unknown. */
  query_mem_capacity?: number | null;
  effective_tuning?: EffectiveTuningSnapshot;
  adapted?: AdaptedRunState;
  advisories?: Array<{ kind: string; severity?: string; message: string }>;
  pairs_by_level?: Record<string, number>;
  [key: string]: unknown;
}

export interface ResumeOverrides {
  batchSize?: number;
  projectionMode?: 'in_source' | 'dedicated';
  maxRetries?: number;
  timeoutSecs?: number;
  tuning?: AggregationTuning;
}

export interface PaginatedJobsResponse {
  items: AggregationJobResponse[];
  total: number;
  limit: number;
  offset: number;
}

export interface JobHistoryFilters {
  status?: string[];
  workspaceId?: string;
  dataSourceId?: string[];
  projectionMode?: string;
  triggerSource?: string;
  dateFrom?: string;
  dateTo?: string;
  search?: string;
  limit?: number;
  offset?: number;
}

export interface DataSourceReadinessResponse {
  dataSourceId: string;
  isReady: boolean;
  aggregationStatus: 'none' | 'pending' | 'running' | 'ready' | 'failed' | 'skipped';
  canCreateViews: boolean;
  activeJob?: AggregationJobResponse;
  driftDetected: boolean;
  lastAggregatedAt?: string;
  aggregationEdgeCount: number;
  /** Depth-stamp contract version of the materialized cube; < 2 predates
   *  sourceDepth/targetDepth (self-nesting hierarchies read degenerate). */
  aggregationStampVersion?: number | null;
  /** True when a ready cube predates the depth-stamp contract and should be
   *  rebuilt — drives the per-source "rebuild to fix nested hierarchies" warning. */
  needsRebuild?: boolean;
  /** Reconciliation verdict from the last drift check, so the profile can say
   *  whether the rollups still match the graph without a second request. */
  driftState?: string | null;
  lastReconciledAt?: string | null;
  lastReconcileReason?: string | null;
  /** Resolved per-source → global → env. */
  autoReconcile?: boolean | null;
  /** The operator hold in force, widest scope first — the control that would
   *  release it. Null when nothing is holding this source. */
  heldBy?: 'fleet' | 'provider' | 'source' | null;
  heldKind?: 'paused' | 'stopped' | null;
  heldUntil?: string | null;
  /** Is this source's read cache caught up with its published history?
   *  NULL MEANS UNKNOWN, NEVER HEALTHY — null for an unversioned source, for
   *  a versioned graph pinned to no graph target, and when the store could
   *  not be read. Only `=== false` is the affirmative "it is behind". */
  projectorCurrent?: boolean | null;
  /** How far behind, as a count of published changes. 0 when current; null
   *  under the same three unknown cases as `projectorCurrent`. */
  projectionCommitsBehind?: number | null;
  message: string;
}

export interface DriftCheckResponse {
  driftDetected: boolean;
  currentFingerprint?: string;
  storedFingerprint?: string;
  lastCheckedAt?: string;
}

export interface JobsSummary {
  total: number;
  byStatus: Record<string, number>;
  successRate: number | null;
  avgDurationSeconds: number | null;
}

/**
 * Persisted global rebuild cadence — the env-only cooldown/drift knobs made
 * editable. Each field null = "unset → env default".
 */
export interface AggregationCadence {
  rebuildMinIntervalSecs?: number | null; // 0 .. 86400 (0 disables the throttle)
  driftAutoRebuild?: boolean | null;
  /** Whether sources are actively probed for changed counts. Off means drift
   *  is only noticed when the much slower stats poll happens to refresh. */
  probeEnabled?: boolean | null;
  /** How often each source's counts are re-read, 15 .. 86400. This is the
   *  self-detection SLO — a source nobody notifies us about is noticed within
   *  roughly this window plus one sweep tick. */
  probeIntervalSecs?: number | null;
}

/**
 * Every tuning knob's ENV-resolved default, read live by the server — what
 * "empty" really means in the editors, and where an "Environment default"
 * chip gets its number. The last three are information only (env-only).
 */
export interface EnvTuningDefaults {
  scanRangeWidth?: number | null;
  maxPendingPairs?: number | null;
  applyChunk?: number | null;
  deleteChunk?: number | null;
  writePacingRatio?: number | null;
  extractConcurrency?: number | null;
  materializeLeafPairs?: boolean | null;
  materializeFinePairs?: 'auto' | 'true' | 'false' | null;
  maxMaterializedEdges?: number | null;
  shardReservePct?: number | null;
  bytesPerEdge?: number | null;
  scanShrinkFloor?: number | null;
  scanTimeoutS?: number | null;
  writeTimeoutS?: number | null;
  stallTimeoutSecs?: number | null;
  maxWallSecs?: number | null;
  ignoreObserved?: boolean | null;
  estimateMarginPct?: number | null;
  maxCubeEdges?: number | null;
  budgetRecheckEdges?: number | null;
  /** Information only: backoff retries a narrowest scan gets before an outage is declared. */
  scanTimeoutRetries?: number | null;
  /** Information only: the width at or below which RECONCILE switches to keys-only. */
  reconcileKeysOnlyWidth?: number | null;
  /** Information only: the graph store's own per-query cap (TIMEOUT_MAX), milliseconds. */
  serverTimeoutMaxMs?: number | null;
  /** The memory-aware flush: the share of the worker's memory limit it fires at (a fleet knob). */
  flushMemPct?: number | null;
  /** Information only: pairs the accumulator must hold before a memory-aware flush fires. */
  flushMinPairs?: number | null;
}

export interface AggregationSettingsResponse {
  tuning: AggregationTuning | null;
  cadence?: AggregationCadence | null;
  /** Live env default of every knob (present whether or not a row exists). */
  envTuningDefaults?: EnvTuningDefaults | null;
  /** Effective ENV defaults (server-read) — the cadence editor seeds from
   *  `persisted ?? envDefault` so a no-op save round-trips the real default. */
  envRebuildMinIntervalSecs?: number | null;
  envDriftAutoRebuild?: boolean | null;
  envProbeEnabled?: boolean | null;
  envProbeIntervalSecs?: number | null;
  /** Tri-state, so a string: "auto" is a third mode, not a missing bool. */
  envMaterializeFinePairs?: 'auto' | 'true' | 'false' | null;
  updatedAt?: string | null;
  updatedBy?: string | null;
}

// ── Capacity: what the write budget measures, for people ───────────────
//
// The same reading and arithmetic the rebuild uses before it writes rollups,
// assembled per shard and per source. Mirrors the backend capacity schemas.

export interface CapacityLimitValue {
  value: number | string | boolean | null;
  /** 'global' = the stored Defaults row; 'default' = the environment. */
  source: 'global' | 'default';
}

export interface CapacityLimits {
  shardReservePct: CapacityLimitValue;
  bytesPerEdge: CapacityLimitValue;
  /** value null = no explicit ceiling: the shard governs. */
  maxMaterializedEdges: CapacityLimitValue;
  /** 'auto' | 'true' | 'false' — the fleet-wide Rollup storage. */
  rollupStorage: CapacityLimitValue;
  estimateMarginPct: number;
  maxCubeEdges: number;
  staticCap: number;
  budgetRecheckEdges: number;
  /** The graph store container's memory limit when the deployment states it
   *  (FALKORDB_CONTAINER_MEMORY_BYTES); the app cannot read it. */
  containerMemoryBytes?: number | null;
}

export interface CapacitySource {
  dataSourceId: string;
  label?: string | null;
  workspaceId?: string | null;
  providerId?: string | null;
  providerName?: string | null;
  graphKey?: string | null;
  projectionMode?: string | null;
  aggregationStatus?: string | null;
  edgeCount: number;
  bytesPerEdge: number;
  bytesPerEdgeSource: 'calibrated' | 'default';
  footprintBytes: number;
  lastCubeEstimate?: number | null;
  lastRegime?: string | null;
  lastFailureCategory?: string | null;
}

export interface ShardCapacity {
  endpoint: string;
  used?: number | null;
  maxmemory?: number | null;
  policy?: string | null;
  measurable: boolean;
  whyNot?: string | null;
  usedPct?: number | null;
  reservePct: number;
  reserveBytes?: number | null;
  availableBytes?: number | null;
  /** How many more rollup edges fit at the fleet bytes-per-edge; null when unmeasurable. */
  allowedGrowthEdges?: number | null;
  governedBy: string;
  staticCap: number;
  /** What running rebuilds hold in the node's reservation ledger — allowed to
   *  write, not yet in `used` — already taken off `availableBytes`. */
  reservedBytes?: number | null;
  reservedByJobs?: number | null;
  /** The node's per-query memory ceiling (QUERY_MEM_CAPACITY), bytes; null when unlimited or unreadable. */
  queryMemCapacity?: number | null;
  /** The node's per-query time cap (TIMEOUT_MAX) and its default, ms — what
   *  every timeout knob is really clamped to; null when unlimited or unreadable. */
  timeoutMaxMs?: number | null;
  timeoutDefaultMs?: number | null;
  /** The node's THREAD_COUNT: the memory ceiling is charged per thread. */
  threadCount?: number | null;
  sources: CapacitySource[];
}

export interface UnresolvedSource {
  dataSourceId: string;
  label?: string | null;
  workspaceId?: string | null;
  providerId?: string | null;
  whyNot: string;
}

export interface AggregationCapacityResponse {
  limits: CapacityLimits;
  shards: ShardCapacity[];
  unresolved: UnresolvedSource[];
  sourcesTotal: number;
  truncated: boolean;
  measuredAt: string;
  cacheAgeMs: number;
}

export interface FullDetailPreflight {
  estimateEdges?: number | null;
  estimateSource?: 'lastRun' | null;
  growthEdges?: number | null;
  neededBytes?: number | null;
  verdict: 'fits' | 'short' | 'unknown';
  blockedBy?: string | null;
  shortfallBytes?: number | null;
  shortfallEdges?: number | null;
  marginPct: number;
}

export interface AutoPreflight {
  neverRefused: boolean;
  cubeCeiling: number;
  wouldStoreCube?: boolean | null;
  fallback: string;
}

export interface SourceCapacityResponse {
  source: CapacitySource;
  shard: ShardCapacity;
  limits: CapacityLimits;
  fullDetail: FullDetailPreflight;
  auto: AutoPreflight;
  measuredAt: string;
}

/**
 * A change to one graph store node's per-query limits, applied at runtime
 * with GRAPH.CONFIG SET — it lasts until the server restarts, and the
 * response hands back the FALKORDB_ARGS fragment that makes it permanent.
 * At least one of the two limits. Raising the memory ceiling needs the
 * container's memory limit, which the app cannot read.
 */
export interface GraphStoreLimitsPatch {
  /** TIMEOUT_MAX, milliseconds (1,000 .. 3,600,000); never below the node's TIMEOUT_DEFAULT. */
  timeoutMaxMs?: number;
  /** QUERY_MEM_CAPACITY, bytes per query (1 .. 1 TiB); 0 (unlimited) is refused. */
  queryMemCapacity?: number;
  /** The graph store container's memory limit, bytes — required to raise the ceiling. */
  containerMemoryBytes?: number;
  /** Queries that may hold the ceiling at once, for the sizing formula (at most, and by default, THREAD_COUNT). */
  concurrentQueries?: number;
  /** Cluster mode: set the same limits on every primary, not only the node named. */
  applyToAllNodes?: boolean;
}

export interface GraphStoreLimitsResponse {
  shard: ShardCapacity;
  /** What the changed names read before (null = unlimited or unreadable), and what was set. */
  previous: Record<string, number | null>;
  applied: Record<string, number>;
  appliedTo: string[];
  /** e.g. `TIMEOUT_MAX 300000 QUERY_MEM_CAPACITY 1073741824` — paste into FALKORDB_ARGS. */
  argsFragment: string;
  /** The container memory the sizing formula asks for at the applied ceiling; null when maxmemory is unknown. */
  containerNeededBytes?: number | null;
  concurrentQueries?: number | null;
  threadCountAssumed: boolean;
  measuredAt: string;
}

export interface AggregationWorkerJob {
  jobId: string;
  graphName?: string | null;
  phase?: string | null;
  large: boolean;
}

export interface AggregationWorker {
  workerId: string;
  hostname?: string | null;
  pid?: number | null;
  startedAt?: string | null;
  lastHeartbeatAt?: string | null;
  concurrency: number;
  activeJobs: AggregationWorkerJob[];
  largeJobsActive: number;
  rssMb?: number | null;
  memLimitMb?: number | null;
  drain: boolean;
}

export interface WorkersResponse {
  workers: AggregationWorker[];
  queueDepth: number;
  queuePending: number;
}

class AggregationService {
  async getJobsSummary(): Promise<JobsSummary> {
    return authFetch<JobsSummary>('/api/v1/admin/aggregation-jobs/summary');
  }

  async triggerAggregation(
    dataSourceId: string,
    request: AggregationTriggerRequest,
    triggerSource: 'manual' | 'onboarding' = 'manual'
  ): Promise<AggregationJobResponse> {
    return authFetch<AggregationJobResponse>(
      `/api/v1/admin/data-sources/${dataSourceId}/aggregation-jobs?triggerSource=${triggerSource}`,
      {
        method: 'POST',
        body: JSON.stringify(request),
      }
    );
  }

  async getReadiness(dataSourceId: string): Promise<DataSourceReadinessResponse> {
    return authFetch<DataSourceReadinessResponse>(
      `/api/v1/admin/data-sources/${dataSourceId}/readiness`
    );
  }

  async listJobs(dataSourceId: string, status?: string): Promise<AggregationJobResponse[]> {
    const query = status ? `?status=${status}` : '';
    return authFetch<AggregationJobResponse[]>(
      `/api/v1/admin/data-sources/${dataSourceId}/aggregation-jobs${query}`
    );
  }

  async getJob(dataSourceId: string, jobId: string): Promise<AggregationJobResponse> {
    return authFetch<AggregationJobResponse>(
      `/api/v1/admin/data-sources/${dataSourceId}/aggregation-jobs/${jobId}`
    );
  }

  async resumeJob(
    dataSourceId: string,
    jobId: string,
    overrides?: ResumeOverrides,
  ): Promise<AggregationJobResponse> {
    const init: RequestInit = { method: 'POST' };
    if (overrides && Object.keys(overrides).length > 0) {
      init.body = JSON.stringify(overrides);
    }
    return authFetch<AggregationJobResponse>(
      `/api/v1/admin/data-sources/${dataSourceId}/aggregation-jobs/${jobId}/resume`,
      init,
    );
  }

  /**
   * Raise (or lower) a pending or running job's time limits without
   * cancelling it. The worker re-reads the row within ~30 s; per-query
   * budgets apply to the next query. 422 on a terminal job — use Resume
   * with overrides there.
   */
  async setJobLimits(dataSourceId: string, jobId: string, patch: JobLimitsPatch): Promise<AggregationJobResponse> {
    return authFetch<AggregationJobResponse>(
      `/api/v1/admin/data-sources/${dataSourceId}/aggregation-jobs/${jobId}/limits`,
      { method: 'PATCH', body: JSON.stringify(patch) },
    );
  }

  /**
   * Set a graph store node's per-query limits (TIMEOUT_MAX, QUERY_MEM_CAPACITY)
   * at runtime — system administrators only. Verified by a fresh read of the
   * node; 422 with the numbers when the change is refused, 404 when the
   * capacity sweep knows no such node.
   */
  async setGraphStoreLimits(endpoint: string, patch: GraphStoreLimitsPatch): Promise<GraphStoreLimitsResponse> {
    return authFetch<GraphStoreLimitsResponse>(
      `/api/v1/admin/graph-store/${encodeURIComponent(endpoint)}/limits`,
      { method: 'PATCH', body: JSON.stringify(patch) },
    );
  }

  async cancelJob(dataSourceId: string, jobId: string): Promise<AggregationJobResponse> {
    return authFetch<AggregationJobResponse>(
      `/api/v1/admin/data-sources/${dataSourceId}/aggregation-jobs/${jobId}/cancel`,
      { method: 'POST' }
    );
  }

  async deleteJob(jobId: string): Promise<void> {
    return authFetch<void>(
      `/api/v1/admin/aggregation-jobs/${jobId}`,
      { method: 'DELETE' }
    );
  }

  /**
   * Queue an asynchronous purge job. Returns immediately with the job
   * row in `running` state — `deletedEdges` is 0 at this point and gets
   * populated once the background task finishes. Frontend should
   * monitor progress via the standard aggregation-jobs endpoints
   * (Job History UI handles this automatically).
   *
   * By default a fresh aggregation job is triggered automatically when
   * the purge completes (container-level lineage is blind until the
   * canonical cells are rebuilt); pass `skipReaggregate: true` for a
   * purge-and-stay-empty.
   */
  async purgeAggregation(
    dataSourceId: string,
    opts?: { skipReaggregate?: boolean },
  ): Promise<{
    deletedEdges: number
    dataSourceId: string
    jobId: string
    status: 'running' | 'completed' | 'failed'
  }> {
    const qs = opts?.skipReaggregate ? '?skipReaggregate=true' : '';
    return authFetch(
      `/api/v1/admin/data-sources/${dataSourceId}/purge-aggregation${qs}`,
      { method: 'POST' }
    );
  }

  async skipAggregation(dataSourceId: string): Promise<DataSourceReadinessResponse> {
    return authFetch<DataSourceReadinessResponse>(
      `/api/v1/admin/data-sources/${dataSourceId}/skip-aggregation`,
      {
        method: 'POST',
        body: JSON.stringify({ confirmed: true }),
      }
    );
  }

  async setSchedule(dataSourceId: string, cronExpression: string | null): Promise<void> {
    return authFetch<void>(
      `/api/v1/admin/data-sources/${dataSourceId}/aggregation-schedule`,
      {
        method: 'PUT',
        body: JSON.stringify({ cronExpression }),
      }
    );
  }

  async listJobsGlobal(filters: JobHistoryFilters = {}): Promise<PaginatedJobsResponse> {
    const params = new URLSearchParams();
    if (filters.status?.length) filters.status.forEach(s => params.append('status', s));
    if (filters.workspaceId) params.set('workspaceId', filters.workspaceId);
    if (filters.dataSourceId?.length) filters.dataSourceId.forEach(id => params.append('dataSourceId', id));
    if (filters.projectionMode) params.set('projectionMode', filters.projectionMode);
    if (filters.triggerSource) params.set('triggerSource', filters.triggerSource);
    if (filters.dateFrom) params.set('dateFrom', filters.dateFrom);
    if (filters.dateTo) params.set('dateTo', filters.dateTo);
    if (filters.search) params.set('search', filters.search);
    if (filters.limit) params.set('limit', String(filters.limit));
    if (filters.offset !== undefined) params.set('offset', String(filters.offset));
    const qs = params.toString();
    return authFetch<PaginatedJobsResponse>(
      `/api/v1/admin/aggregation-jobs${qs ? `?${qs}` : ''}`
    );
  }

  async checkDrift(dataSourceId: string): Promise<DriftCheckResponse> {
    return authFetch<DriftCheckResponse>(
      `/api/v1/admin/data-sources/${dataSourceId}/check-drift`
    );
  }

  async getAggregationSettings(): Promise<AggregationSettingsResponse> {
    return authFetch<AggregationSettingsResponse>(
      '/api/v1/admin/aggregation/settings'
    );
  }

  async putAggregationSettings(tuning: AggregationTuning): Promise<AggregationSettingsResponse> {
    return authFetch<AggregationSettingsResponse>(
      '/api/v1/admin/aggregation/settings',
      {
        method: 'PUT',
        body: JSON.stringify({ tuning }),
      }
    );
  }

  /** Update ONLY the global rebuild cadence — the backend applies tuning and
   *  cadence independently, so this never clobbers the pipeline defaults. */
  async putAggregationCadence(cadence: AggregationCadence): Promise<AggregationSettingsResponse> {
    return authFetch<AggregationSettingsResponse>(
      '/api/v1/admin/aggregation/settings',
      {
        method: 'PUT',
        body: JSON.stringify({ cadence }),
      }
    );
  }

  /** Every shard with rollups on it, what fits, and the sources on each —
   *  cached briefly server-side; `fresh` forces a new sweep. */
  async getFleetCapacity(fresh = false): Promise<AggregationCapacityResponse> {
    return authFetch<AggregationCapacityResponse>(
      `/api/v1/admin/aggregation/capacity${fresh ? '?fresh=true' : ''}`
    );
  }

  /** One source's footprint, its shard's headroom and the pre-flight fit. */
  async getSourceCapacity(dsId: string): Promise<SourceCapacityResponse> {
    return authFetch<SourceCapacityResponse>(
      `/api/v1/admin/data-sources/${encodeURIComponent(dsId)}/capacity`
    );
  }

  async listAggregationWorkers(): Promise<WorkersResponse> {
    return authFetch<WorkersResponse>(
      '/api/v1/admin/aggregation/workers'
    );
  }
}

export const aggregationService = new AggregationService();
