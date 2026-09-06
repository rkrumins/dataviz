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
  /** Hard write budget: fail the job instead of writing more :AGGREGATED edges than this. */
  maxMaterializedEdges?: number | null; // 10,000 .. 50,000,000
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
  /** Per-phase run stats (keys: extract_s, compute_s, reconcile_s, apply_s, writes, deletes, pairs, scanned_edges). */
  runStats?: Record<string, number | string | Record<string, number>> | null;
  workerId?: string | null;
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

export interface AggregationSettingsResponse {
  tuning: AggregationTuning | null;
  cadence?: AggregationCadence | null;
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

  async listAggregationWorkers(): Promise<WorkersResponse> {
    return authFetch<WorkersResponse>(
      '/api/v1/admin/aggregation/workers'
    );
  }
}

export const aggregationService = new AggregationService();
