"""
Pydantic request/response schemas for the aggregation API.

These live inside the aggregation package so the package is self-contained.
The thin FastAPI adapter (app/api/v1/endpoints/aggregation.py) imports from here.
"""
from typing import List, Optional
from pydantic import BaseModel, Field, field_validator


# ── Shared validator helpers ─────────────────────────────────────────


def _validate_timeout_secs(value: Optional[int]) -> Optional[int]:
    if value is None:
        return value
    if not (60 <= value <= 86400):
        raise ValueError("timeout_secs must be between 60 and 86400 (24h)")
    return value


def _validate_max_retries(value: Optional[int]) -> Optional[int]:
    if value is None:
        return value
    if not (0 <= value <= 10):
        raise ValueError("max_retries must be between 0 and 10")
    return value


def _validate_projection_mode(value: Optional[str]) -> Optional[str]:
    if value is None:
        return value
    if value not in ("in_source", "dedicated"):
        raise ValueError("projection_mode must be 'in_source' or 'dedicated'")
    return value


def _validate_batch_size(value: Optional[int]) -> Optional[int]:
    if value is None:
        return value
    if not (100 <= value <= 50000):
        raise ValueError("batch_size must be between 100 and 50000")
    return value


# ── Pipeline tuning ──────────────────────────────────────────────────


class AggregationTuning(BaseModel):
    """Per-job overrides for the materialization pipeline's real knobs.

    All fields optional; absent fields fall back to the stored global
    defaults (frozen into the job at trigger time), then to env vars,
    then to code defaults — see docs/AGGREGATION_PIPELINE.md. Bounds
    mirror the pipeline's env clamps.
    """
    scan_range_width: Optional[int] = Field(
        None, alias="scanRangeWidth", ge=10_000, le=5_000_000,
        description="Edge-ID range width per scan query.",
    )
    max_pending_pairs: Optional[int] = Field(
        None, alias="maxPendingPairs", ge=50_000, le=50_000_000,
        description="In-memory pair cap before overflow flush.",
    )
    apply_chunk: Optional[int] = Field(
        None, alias="applyChunk", ge=1_000, le=200_000,
        description="Pairs resolved + written per apply chunk.",
    )
    delete_chunk: Optional[int] = Field(
        None, alias="deleteChunk", ge=100, le=50_000,
        description="Stale edges deleted per query.",
    )
    write_pacing_ratio: Optional[float] = Field(
        None, alias="writePacingRatio", ge=0.0, le=10.0,
        description="Sleep after each write for duration x ratio.",
    )
    extract_concurrency: Optional[int] = Field(
        None, alias="extractConcurrency", ge=1, le=4,
        description="Concurrent read-only range scans during extract/reconcile.",
    )
    materialize_leaf_pairs: Optional[bool] = Field(
        None, alias="materializeLeafPairs",
        description="Also materialize leaf-to-leaf mirror pairs (legacy behavior).",
    )
    materialize_fine_pairs: Optional[bool] = Field(
        None, alias="materializeFinePairs",
        description="Legacy full-cube mode: also materialize pairs involving "
                    "leaf-level nodes (scales as edges x depth; can exceed "
                    "FalkorDB memory). Default false: served on demand.",
    )
    max_materialized_edges: Optional[int] = Field(
        None, alias="maxMaterializedEdges", ge=10_000, le=50_000_000,
        description="Hard write budget: fail the job instead of writing more "
                    ":AGGREGATED edges than this (~0.5KB RAM each).",
    )

    class Config:
        populate_by_name = True

    def merged_over(self, defaults: Optional[dict]) -> dict:
        """Non-None fields of self layered over a defaults dict."""
        out = dict(defaults or {})
        for key, value in self.model_dump(exclude_none=True).items():
            out[key] = value
        return out


# ── Requests ─────────────────────────────────────────────────────────


class AggregationTriggerRequest(BaseModel):
    ontology_id: Optional[str] = Field(None, alias="ontologyId")
    projection_mode: str = Field("in_source", alias="projectionMode")
    # Deprecated: the FalkorDB pipeline is range-based + AIMD self-tuning
    # and ignores batch_size. Accepted for backward compatibility; use
    # ``tuning`` instead.
    batch_size: int = Field(5000, alias="batchSize", ge=100, le=50000)
    tuning: Optional[AggregationTuning] = Field(
        None,
        description="Pipeline tuning overrides; merged over stored global "
                    "defaults and frozen onto the job at trigger time.",
    )
    # Phase 2 §2.2 — caller-supplied idempotency token. Two POSTs sharing
    # this key for the same data source within the past 60 minutes
    # collapse to the original job (200 OK with the existing job ID).
    # No key supplied → unique-per-call semantics, may 409 on dup.
    idempotency_key: Optional[str] = Field(
        None,
        alias="idempotencyKey",
        max_length=255,
    )
    timeout_secs: Optional[int] = Field(
        None,
        alias="timeoutSecs",
        description="Per-job timeout in seconds; 60 \u2264 value \u2264 86400 (24h).",
    )
    max_retries: Optional[int] = Field(
        None,
        alias="maxRetries",
        description="Max retry attempts on transient failures; 0 \u2264 value \u2264 10.",
    )

    @field_validator("timeout_secs")
    @classmethod
    def _check_timeout_secs(cls, v: Optional[int]) -> Optional[int]:
        return _validate_timeout_secs(v)

    @field_validator("max_retries")
    @classmethod
    def _check_max_retries(cls, v: Optional[int]) -> Optional[int]:
        return _validate_max_retries(v)

    class Config:
        populate_by_name = True


class AggregationSkipRequest(BaseModel):
    confirmed: bool = False  # must be True to skip

    class Config:
        populate_by_name = True


class AggregationScheduleRequest(BaseModel):
    cron_expression: Optional[str] = Field(None, alias="cronExpression")  # null = disable

    class Config:
        populate_by_name = True


class InternalTriggerRequest(BaseModel):
    """Used by the viz-service proxy to send pre-resolved trigger data
    to the Control Plane.

    Ontology resolution happens in the viz-service (which has OntologyORM
    access) so the Control Plane never needs to import OntologyORM.
    All fields are frozen into the job record at trigger time.
    """
    data_source_id: str = Field(alias="dataSourceId")
    workspace_id: str = Field(alias="workspaceId")
    ontology_id: str = Field(alias="ontologyId")
    containment_edge_types: List[str] = Field(alias="containmentEdgeTypes")
    lineage_edge_types: List[str] = Field(alias="lineageEdgeTypes")
    provider_id: str = Field(alias="providerId")
    graph_name: str = Field(alias="graphName")
    projection_mode: str = Field("in_source", alias="projectionMode")
    batch_size: int = Field(5000, alias="batchSize", ge=100, le=50000)
    tuning: Optional[AggregationTuning] = Field(
        None,
        description="Pipeline tuning overrides forwarded from the trigger.",
    )
    trigger_source: str = Field("manual", alias="triggerSource")
    idempotency_key: Optional[str] = Field(None, alias="idempotencyKey", max_length=255)
    timeout_secs: Optional[int] = Field(
        None,
        alias="timeoutSecs",
        description="Per-job timeout in seconds; 60 \u2264 value \u2264 86400 (24h).",
    )
    max_retries: Optional[int] = Field(
        None,
        alias="maxRetries",
        description="Max retry attempts on transient failures; 0 \u2264 value \u2264 10.",
    )

    @field_validator("timeout_secs")
    @classmethod
    def _check_timeout_secs(cls, v: Optional[int]) -> Optional[int]:
        return _validate_timeout_secs(v)

    @field_validator("max_retries")
    @classmethod
    def _check_max_retries(cls, v: Optional[int]) -> Optional[int]:
        return _validate_max_retries(v)

    class Config:
        populate_by_name = True


class ResumeOverrides(BaseModel):
    """Optional parameter overrides applied to a job before resuming it.

    All fields are optional; absent fields preserve the job's existing
    values. Bounds match AggregationTriggerRequest.
    """
    batch_size: Optional[int] = Field(
        None,
        alias="batchSize",
        description="Edges per batch; 100 \u2264 value \u2264 50000.",
    )
    projection_mode: Optional[str] = Field(
        None,
        alias="projectionMode",
        description="One of 'in_source' or 'dedicated'.",
    )
    max_retries: Optional[int] = Field(
        None,
        alias="maxRetries",
        description="Max retry attempts on transient failures; 0 \u2264 value \u2264 10.",
    )
    timeout_secs: Optional[int] = Field(
        None,
        alias="timeoutSecs",
        description="Per-job timeout in seconds; 60 \u2264 value \u2264 86400 (24h).",
    )
    tuning: Optional[AggregationTuning] = Field(
        None,
        description="Pipeline tuning overrides; non-None fields replace the "
                    "job's frozen tuning before resuming.",
    )

    @field_validator("batch_size")
    @classmethod
    def _check_batch_size(cls, v: Optional[int]) -> Optional[int]:
        return _validate_batch_size(v)

    @field_validator("projection_mode")
    @classmethod
    def _check_projection_mode(cls, v: Optional[str]) -> Optional[str]:
        return _validate_projection_mode(v)

    @field_validator("max_retries")
    @classmethod
    def _check_max_retries(cls, v: Optional[int]) -> Optional[int]:
        return _validate_max_retries(v)

    @field_validator("timeout_secs")
    @classmethod
    def _check_timeout_secs(cls, v: Optional[int]) -> Optional[int]:
        return _validate_timeout_secs(v)

    class Config:
        populate_by_name = True


# ── Responses ────────────────────────────────────────────────────────


class AggregationJobResponse(BaseModel):
    id: str
    data_source_id: str = Field(alias="dataSourceId")
    status: str
    trigger_source: str = Field(alias="triggerSource")
    progress: int  # 0-100
    total_edges: int = Field(alias="totalEdges")
    processed_edges: int = Field(alias="processedEdges")
    created_edges: int = Field(alias="createdEdges")
    batch_size: int = Field(alias="batchSize")
    last_checkpoint_at: Optional[str] = Field(None, alias="lastCheckpointAt")
    resumable: bool  # True when status is 'failed'/'cancelled' (manual resume always allowed)
    retry_count: int = Field(alias="retryCount")
    error_message: Optional[str] = Field(None, alias="errorMessage")
    estimated_completion_at: Optional[str] = Field(None, alias="estimatedCompletionAt")
    started_at: Optional[str] = Field(None, alias="startedAt")
    completed_at: Optional[str] = Field(None, alias="completedAt")
    updated_at: Optional[str] = Field(None, alias="updatedAt")
    created_at: str = Field(alias="createdAt")

    # Resume / re-trigger plumbing — surfaced so the UI can pre-populate the
    # override dialog and decide whether the "Resume from cursor" button is
    # available (only when last_cursor is non-null on a failed/cancelled job).
    last_cursor: Optional[str] = Field(None, alias="lastCursor")
    max_retries: Optional[int] = Field(None, alias="maxRetries")
    timeout_secs: Optional[int] = Field(None, alias="timeoutSecs")

    # Enrichment fields — populated by global listing endpoint, None for per-DS endpoints
    workspace_id: Optional[str] = Field(None, alias="workspaceId")
    workspace_name: Optional[str] = Field(None, alias="workspaceName")
    data_source_label: Optional[str] = Field(None, alias="dataSourceLabel")
    projection_mode: Optional[str] = Field(None, alias="projectionMode")
    duration_seconds: Optional[float] = Field(None, alias="durationSeconds")
    edge_coverage_pct: Optional[float] = Field(None, alias="edgeCoveragePct")

    # UI phase visibility. Short ID identifying which phase of the
    # materialization pipeline is currently running — 'extracting' /
    # 'computing' / 'reconciling' / 'applying' (see
    # ``backend/app/services/aggregation/models.py:current_phase``).
    # NULL on providers that don't emit phase signals — the frontend
    # falls back to a generic label in that case.
    current_phase: Optional[str] = Field(None, alias="currentPhase")

    # Iteration 2 — per-job pipeline tuning (frozen at trigger; see
    # AggregationTuning), durable per-phase run stats written on
    # completion, and the worker that executed the job.
    tuning: Optional[dict] = None
    run_stats: Optional[dict] = Field(None, alias="runStats")
    worker_id: Optional[str] = Field(None, alias="workerId")

    class Config:
        populate_by_name = True


class PaginatedJobsResponse(BaseModel):
    items: List[AggregationJobResponse]
    total: int
    limit: int
    offset: int

    class Config:
        populate_by_name = True


class DataSourceReadinessResponse(BaseModel):
    data_source_id: str = Field(alias="dataSourceId")
    is_ready: bool = Field(alias="isReady")
    aggregation_status: str = Field(alias="aggregationStatus")
    can_create_views: bool = Field(alias="canCreateViews")
    active_job: Optional[AggregationJobResponse] = Field(None, alias="activeJob")
    drift_detected: bool = Field(False, alias="driftDetected")
    last_aggregated_at: Optional[str] = Field(None, alias="lastAggregatedAt")
    aggregation_edge_count: int = Field(0, alias="aggregationEdgeCount")
    message: str

    class Config:
        populate_by_name = True


class DriftCheckResponse(BaseModel):
    drift_detected: bool = Field(alias="driftDetected")
    current_fingerprint: Optional[str] = Field(None, alias="currentFingerprint")
    stored_fingerprint: Optional[str] = Field(None, alias="storedFingerprint")
    last_checked_at: Optional[str] = Field(None, alias="lastCheckedAt")

    class Config:
        populate_by_name = True


# ── Global defaults (settings) ───────────────────────────────────────


class AggregationSettingsRequest(BaseModel):
    """PUT /aggregation/settings body — replaces the stored defaults."""
    tuning: AggregationTuning

    class Config:
        populate_by_name = True


class AggregationSettingsResponse(BaseModel):
    tuning: Optional[AggregationTuning] = None
    updated_at: Optional[str] = Field(None, alias="updatedAt")
    updated_by: Optional[str] = Field(None, alias="updatedBy")

    class Config:
        populate_by_name = True


# ── Worker fleet reporting ───────────────────────────────────────────


class WorkerActiveJob(BaseModel):
    job_id: str = Field(alias="jobId")
    graph_name: Optional[str] = Field(None, alias="graphName")
    phase: Optional[str] = None
    large: bool = False

    class Config:
        populate_by_name = True


class WorkerInfo(BaseModel):
    worker_id: str = Field(alias="workerId")
    hostname: Optional[str] = None
    pid: Optional[int] = None
    started_at: Optional[str] = Field(None, alias="startedAt")
    last_heartbeat_at: Optional[str] = Field(None, alias="lastHeartbeatAt")
    concurrency: int = 0
    active_jobs: List[WorkerActiveJob] = Field(default_factory=list, alias="activeJobs")
    large_jobs_active: int = Field(0, alias="largeJobsActive")
    rss_mb: Optional[float] = Field(None, alias="rssMb")
    mem_limit_mb: Optional[float] = Field(None, alias="memLimitMb")
    drain: bool = False

    class Config:
        populate_by_name = True


class WorkersResponse(BaseModel):
    workers: List[WorkerInfo] = Field(default_factory=list)
    queue_depth: int = Field(0, alias="queueDepth")
    queue_pending: int = Field(0, alias="queuePending")

    class Config:
        populate_by_name = True
