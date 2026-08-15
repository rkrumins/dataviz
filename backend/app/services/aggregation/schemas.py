"""
Pydantic request/response schemas for the aggregation API.

These live inside the aggregation package so the package is self-contained.
The thin FastAPI adapter (app/api/v1/endpoints/aggregation.py) imports from here.
"""
from typing import Any, Dict, List, Literal, Optional
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
        description="Legacy full-cube mode: materialize every ancestor-pair "
                    "combination, including leaf-involving and mixed-level "
                    "pairs (scales with raw-edge count; can exceed FalkorDB "
                    "memory). Default false: only the same-level diagonal is "
                    "stored; the rest is served on demand.",
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


class SourceChangedRequest(BaseModel):
    """Body for the source-changed signal. Both fields optional — an
    external loader can POST an empty body and get the defaults."""
    reason: str = Field("external_load")
    force: bool = Field(False)

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

    # WHY an automatic reconciliation queued this job — the typed detector
    # code plus the counts behind it, read from the ``refresh_events`` row
    # that names this job. Only populated for ``triggerSource='reconcile'``,
    # so a page with no reconciliation jobs costs no extra query. Without
    # these, Job History can say a rebuild was automatic but never why.
    reconcile_reason: Optional[str] = Field(None, alias="reconcileReason")
    reconcile_evidence: Optional[Dict] = Field(None, alias="reconcileEvidence")

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
    # Depth-stamp contract version of the materialized cube (from the in-graph
    # _AggMeta singleton). < 2 means the run predates sourceDepth/targetDepth,
    # so self-nesting hierarchies (Node⊃Node) read degenerate until re-run.
    # None when unknown (never aggregated / non-FalkorDB / probe failed).
    aggregation_stamp_version: Optional[int] = Field(None, alias="aggregationStampVersion")
    # True when a ready data source's cube predates the depth-stamp contract and
    # should be rebuilt. Drives the per-source "rebuild to fix nested
    # hierarchies" warning in the UI.
    needs_rebuild: bool = Field(False, alias="needsRebuild")
    # Reconciliation, so the data-source profile can answer "is this still in
    # step with its graph" without fetching the whole freshness doc. Read off
    # the state row this endpoint already loads — no extra query.
    drift_state: Optional[str] = Field(None, alias="driftState")
    last_reconciled_at: Optional[str] = Field(None, alias="lastReconciledAt")
    last_reconcile_reason: Optional[str] = Field(None, alias="lastReconcileReason")
    auto_reconcile: Optional[bool] = Field(None, alias="autoReconcile")
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


class SourceChangedResponse(BaseModel):
    """Result of the change-gated source-changed signal.

    ``changed`` is False only on the no-op path (fingerprints matched and
    ``force`` was not set) — nothing was invalidated or queued. When True,
    caches were invalidated and a rebuild was queued unless ``job_id`` is
    None (an aggregation job was already active, the source's status makes
    aggregation not applicable, or the rebuild was ``deferred`` by the
    cooldown throttle for the scheduler reconciler to pick up).
    """
    changed: bool
    job_id: Optional[str] = Field(None, alias="jobId")
    reason: str
    current_fingerprint: str = Field(alias="currentFingerprint")
    stored_fingerprint: Optional[str] = Field(None, alias="storedFingerprint")
    # True when the change was invalidated but the aggregation rebuild was
    # throttled by the cooldown window — the scheduler reconciler queues it
    # once the window elapses.
    deferred: bool = False
    # Id of the refresh_events audit row this invocation emitted, or None
    # if the emit failed (audit writes are best-effort — see
    # emit_refresh_event). Reachable by F3/F4 to avoid a duplicate emit.
    event_id: Optional[str] = Field(None, alias="eventId")

    class Config:
        populate_by_name = True


# ── Unified refresh verb (operator-facing) ───────────────────────────


class RefreshRequest(BaseModel):
    """Body for the unified ``refresh_source`` verb — every field optional.

    ``scope`` selects what converges:
      * ``auto``        — delegate to the change-gated source-changed signal.
      * ``read-caches`` — clear content + hierarchy + aggregated-LKG caches
                          and nudge stats (no change gate, no rebuild).
      * ``rollups``     — mark stale + queue an aggregation rebuild.
      * ``full``        — read-caches steps, then rollups steps.
      * ``clear``       — the read-caches steps, THEN clear the stale marker
                          (no gate, no cooldown, no rebuild) — un-sticks a
                          source stuck "recomputing" after a failed rebuild.

    ``force`` only affects ``auto`` (it overrides the change gate); the other
    scopes act unconditionally by construction. ``wait='complete'`` blocks on
    a queued rebuild (bounded) so a caller can refresh-then-read synchronously.
    """
    scope: Literal["auto", "read-caches", "rollups", "full", "clear"] = "auto"
    force: bool = Field(False)
    reason: Optional[str] = None
    wait: Literal["none", "complete"] = "none"

    class Config:
        populate_by_name = True


class RefreshRequestInternal(RefreshRequest):
    """Body for the Control Plane's ``refresh`` twin. Extends the public
    ``RefreshRequest`` with the two fields only an internal caller asserts:

      * ``origin`` — the audit origin: the loader script sends ``script``,
        external connectors ``connector``; the viz proxy leaves it ``api``.
        Restricted to the non-system origins (``drift``/``reconcile`` are
        emitted internally, never via this route).
      * ``actor`` — who triggered it. The viz proxy forwards the
        authenticated user id it already resolves for direct mode, so a
        UI-triggered refresh is attributed to the user in production
        (proxy) deployments too, not to ``internal``.
    """
    origin: Literal["script", "connector", "api"] = "api"
    actor: str = Field("internal", max_length=128)

    class Config:
        populate_by_name = True


class RefreshResponse(BaseModel):
    """Result of one ``refresh_source`` invocation.

    ``changed`` mirrors the ``auto`` change gate; the forced scopes always
    act, so it is True for them. ``gate`` is ``forced|changed|unchanged`` for
    ``auto`` and ``n/a`` for the other scopes. ``actions`` is the ordered list
    of what ran (plus a terminal ``job:<status>``/``job:timeout`` when
    ``wait='complete'`` polled a rebuild). ``event_id`` is the single
    refresh_events audit row this invocation is attributed to (the signal's
    own row for ``auto``, this verb's for the others).
    """
    scope: str
    gate: str
    changed: bool
    actions: List[str] = Field(default_factory=list)
    job_id: Optional[str] = Field(None, alias="jobId")
    deferred: bool = False
    event_id: Optional[str] = Field(None, alias="eventId")

    class Config:
        populate_by_name = True


# ── Freshness cockpit (operator-facing read models) ──────────────────


# Origins that are machine-initiated. Everything else is a person acting
# through the API or a connector on their behalf. Derived rather than stored:
# ``origin`` + ``actor`` already carry it.
_AUTOMATIC_ORIGINS = frozenset({"drift", "reconcile", "reconcile-sweep", "script"})


class RefreshEventSummary(BaseModel):
    """One row of the refresh_events audit trail, trimmed to what the
    freshness views render. Populated from ``RefreshEventORM``."""
    origin: str
    outcome: str
    ts: str
    actor: Optional[str] = None
    # WHY, for a reconciliation event: the typed detector code plus the counts
    # behind it. ``None`` on every other kind of refresh.
    reason: Optional[str] = None
    evidence: Optional[Dict] = None
    # "automatic" | "manual", derived from origin — the UI shows this rather
    # than making the reader decode an origin vocabulary.
    mode: Optional[str] = None
    # The aggregation job this event produced, so the activity trail can hand
    # the reader straight to what the rebuild actually did.
    job_id: Optional[str] = Field(None, alias="jobId")

    class Config:
        populate_by_name = True


class FreshnessRow(BaseModel):
    """One data source's freshness signals for the fleet view. Assembled
    from ONE SQL pass (workspace_data_sources ⋈ providers) plus ONE Redis
    pipeline (generation / cache-as-of / stale marker) — never a provider
    or FalkorDB call. Optional-heavy: every Redis-sourced field degrades to
    ``None`` when the cache is unreachable or the key is absent."""
    data_source_id: str = Field(alias="dataSourceId")
    workspace_id: Optional[str] = Field(None, alias="workspaceId")
    provider_id: Optional[str] = Field(None, alias="providerId")
    name: Optional[str] = None
    provider_name: Optional[str] = Field(None, alias="providerName")
    aggregation_status: Optional[str] = Field(None, alias="aggregationStatus")
    last_aggregated_at: Optional[str] = Field(None, alias="lastAggregatedAt")
    last_materialized_at: Optional[str] = Field(None, alias="lastMaterializedAt")
    cache_as_of: Optional[str] = Field(None, alias="cacheAsOf")
    generation: Optional[int] = None
    stale_reason: Optional[str] = Field(None, alias="staleReason")
    # The marker carries no reliable "since": its TTL is a 7-day backstop
    # that is refreshed on every re-signal, so a TTL-derived timestamp
    # would misreport when the source first went stale. Left None until a
    # marker set-time is durably recorded.
    stale_since: Optional[str] = Field(None, alias="staleSince")
    cooldown_until: Optional[str] = Field(None, alias="cooldownUntil")
    stored_fingerprint: Optional[str] = Field(None, alias="storedFingerprint")
    # Only ever set under an explicit probe (fleet never probes → None).
    drifted: Optional[bool] = None
    running_job_id: Optional[str] = Field(None, alias="runningJobId")
    last_event: Optional[RefreshEventSummary] = Field(None, alias="lastEvent")

    # ── Reconciliation ────────────────────────────────────────────────
    # Read straight off ``data_source_state`` — the sweep stamps them, the
    # read path never recomputes them (it must stay pure SQL + Redis).
    drift_state: Optional[str] = Field(None, alias="driftState")
    auto_reconcile: Optional[bool] = Field(None, alias="autoReconcile")
    last_checked_at: Optional[str] = Field(None, alias="lastCheckedAt")
    last_reconciled_at: Optional[str] = Field(None, alias="lastReconciledAt")
    last_reconcile_reason: Optional[str] = Field(None, alias="lastReconcileReason")
    last_reconcile_mode: Optional[str] = Field(None, alias="lastReconcileMode")
    # Failure surfacing for the fleet table: populated only when
    # aggregation_status is failed and the latest job is failed. Same
    # classifier as the drawer — so the row can name the cause without a
    # second round-trip. Best-effort; never raises.
    last_failure_reason: Optional[str] = Field(None, alias="lastFailureReason")
    last_failure_category: Optional[str] = Field(None, alias="lastFailureCategory")

    class Config:
        populate_by_name = True


class FreshnessDoc(FreshnessRow):
    """A single source's full freshness detail — the fleet row plus the
    per-source extras that cost one bounded LKG SCAN and (only under
    ``probe=true``) one provider ``get_schema_stats`` call."""
    lkg_count: Optional[int] = Field(None, alias="lkgCount")
    lkg_oldest_age_secs: Optional[int] = Field(None, alias="lkgOldestAgeSecs")
    live_fingerprint: Optional[str] = Field(None, alias="liveFingerprint")
    live_node_count: Optional[int] = Field(None, alias="liveNodeCount")
    live_edge_count: Optional[int] = Field(None, alias="liveEdgeCount")
    events: List[RefreshEventSummary] = Field(default_factory=list)
    # Rebuild-cadence detail for the drawer's "Rebuild cadence" row. The raw
    # per-source override (null = none), the RESOLVED window, and where it
    # came from ("custom" | "global" | "default") — computed server-side so a
    # ds:manage (non-admin) viewer never needs to read the global settings.
    rebuild_override_secs: Optional[int] = Field(None, alias="rebuildOverrideSecs")
    resolved_rebuild_interval_secs: Optional[int] = Field(
        None, alias="resolvedRebuildIntervalSecs",
    )
    rebuild_interval_source: Optional[str] = Field(
        None, alias="rebuildIntervalSource",
    )
    # Per-source cache footprint: a bounded SCAN of the CURRENT-generation
    # primary cache keys, tallied by endpoint. Doc-only (never on the fleet
    # path) — see ``count_cache_keys_by_endpoint``. ``None`` on a Redis
    # error/disabled cache, distinct from ``{}``/0 (nothing cached).
    cache_key_count: Optional[int] = Field(None, alias="cacheKeyCount")
    cache_key_count_by_endpoint: Optional[Dict[str, int]] = Field(
        None, alias="cacheKeyCountByEndpoint",
    )
    # Retry count stays doc-only (not needed to scan the fleet table).
    retry_count: Optional[int] = Field(None, alias="retryCount")

    # ── Reconciliation detail ─────────────────────────────────────────
    # The two numbers the drawer's integrity meter compares. ``observed`` is
    # what the stats service last counted in the graph; ``expected`` is what
    # the last successful job reported writing.
    observed_aggregated_edges: Optional[int] = Field(
        None, alias="observedAggregatedEdges",
    )
    expected_aggregated_edges: Optional[int] = Field(
        None, alias="expectedAggregatedEdges",
    )
    stats_as_of: Optional[str] = Field(None, alias="statsAsOf")
    # The check-cadence trio, mirroring the rebuild-interval trio above so the
    # drawer can say where the value came from without reading global settings.
    reconcile_interval_override_secs: Optional[int] = Field(
        None, alias="reconcileIntervalOverrideSecs",
    )
    resolved_reconcile_interval_secs: Optional[int] = Field(
        None, alias="resolvedReconcileIntervalSecs",
    )
    reconcile_interval_source: Optional[str] = Field(
        None, alias="reconcileIntervalSource",
    )
    next_check_at: Optional[str] = Field(None, alias="nextCheckAt")
    # Non-null when the sweep is deliberately not acting on this source
    # (no ontology, suspended by the breaker, overlay not observable…).
    blocked_reason: Optional[str] = Field(None, alias="blockedReason")

    class Config:
        populate_by_name = True


class FreshnessSummary(BaseModel):
    """Fleet-wide stat-tile counts for the Freshness cockpit, computed over
    the workspace/provider-filtered set *before* the ``staleOnly`` facet and
    pagination are applied — the tiles describe the whole filtered fleet,
    not the visible page. ``None`` (on the response) when that filtered set
    exceeds 1000 sources, so the assembly never does unbounded work."""
    total: int
    ready: int = Field(0)  # aggregation_status == "ready"
    pending: int = Field(0)  # aggregation_status == "pending" (rebuild in flight)
    failed: int = Field(0)  # aggregation_status == "failed"
    not_built: int = Field(0, alias="notBuilt")  # status in ("none","skipped") or no state row
    recomputing: int = Field(0)  # stale marker present
    needs_attention: int = Field(0, alias="needsAttention")  # marker, failed, drifting, or suspended
    cache_stamped: int = Field(0, alias="cacheStamped")  # cacheAsOf non-null
    # driftState is a drifting/overlayMissing verdict from the last sweep.
    drifting: int = Field(0)
    # Circuit breaker tripped — automation stopped; a person has to look.
    # Counted in needsAttention too, but not in drifting (the overlay is
    # still wrong; the distinction is that the sweep will not retry).
    suspended: int = Field(0)

    class Config:
        populate_by_name = True


class ProviderFreshnessSummary(BaseModel):
    """Per-provider breakdown of the fleet ``summary`` — identical bucket
    semantics, grouped by ``(provider_id, provider_name)``. ``provider_id``/
    ``provider_name`` are ``None`` for the no-provider group. ``None`` on
    the response whenever ``summary`` is (the same >1000-source cutoff)."""
    provider_id: Optional[str] = Field(None, alias="providerId")
    provider_name: Optional[str] = Field(None, alias="providerName")
    total: int = 0
    ready: int = Field(0)
    pending: int = Field(0)
    failed: int = Field(0)
    not_built: int = Field(0, alias="notBuilt")
    needs_attention: int = Field(0, alias="needsAttention")
    cache_stamped: int = Field(0, alias="cacheStamped")
    drifting: int = Field(0)
    suspended: int = Field(0)

    class Config:
        populate_by_name = True


class FreshnessFleetResponse(BaseModel):
    """Paged fleet freshness response — ``total`` is the filtered count."""
    rows: List[FreshnessRow] = Field(default_factory=list)
    total: int = 0
    summary: Optional[FreshnessSummary] = None
    provider_summaries: Optional[List[ProviderFreshnessSummary]] = Field(
        None, alias="providerSummaries",
    )

    class Config:
        populate_by_name = True


# ── Global defaults (settings) ───────────────────────────────────────


class AggregationCadence(BaseModel):
    """Persisted global rebuild cadence — the env-only knobs
    ``AGGREGATION_REBUILD_MIN_INTERVAL_SECS`` and
    ``AGGREGATION_DRIFT_AUTO_REBUILD`` made editable. Each field ``None``
    means "unset → fall through to the env default"; this is NOT part of
    ``AggregationTuning`` on purpose (cadence is a scheduler/cooldown
    concern, never frozen onto a per-job pipeline run)."""
    rebuild_min_interval_secs: Optional[int] = Field(
        None, alias="rebuildMinIntervalSecs", ge=0, le=86400,
        description="Minimum seconds between automatic rebuilds of a source "
                    "(0 disables the throttle). Unset → env default.",
    )
    drift_auto_rebuild: Optional[bool] = Field(
        None, alias="driftAutoRebuild",
        description="Whether the scheduler auto-queues a rebuild when it "
                    "detects drift. Unset → env default.",
    )

    # ── Automatic reconciliation (the drift / overlay-integrity sweep) ──
    # Carried here rather than in a new column because ``cadence_json`` is
    # already the persisted-global store, already read through the cached
    # ``read_global_cadence``, already env-echoed by ``get_settings``, and
    # already editable from the Freshness cadence dialog. A separate store
    # would duplicate all four.
    reconcile_enabled: Optional[bool] = Field(
        None, alias="reconcileEnabled",
        description="Whether the sweep may automatically reconcile sources "
                    "whose rollups have drifted. Unset → env default.",
    )
    reconcile_check_interval_secs: Optional[int] = Field(
        None, alias="reconcileCheckIntervalSecs", ge=300, le=86400,
        description="How often each source is checked for drift. The 300s "
                    "floor keeps a mistyped value from hammering the fleet. "
                    "Unset → env default.",
    )
    reconcile_max_actions_per_run: Optional[int] = Field(
        None, alias="reconcileMaxActionsPerRun", ge=0, le=200,
        description="Cap on rebuilds queued by a single sweep. The remainder "
                    "is picked up next sweep. 0 = detect but never act.",
    )
    reconcile_shrink_tolerance_pct: Optional[int] = Field(
        None, alias="reconcileShrinkTolerancePct", ge=0, le=100,
        description="How far the observed rollup may fall below the expected "
                    "count before it reads as shrunk. The two numbers are "
                    "measured at different instants, so some slack is "
                    "required, not merely kind.",
    )
    reconcile_detectors: Optional[List[str]] = Field(
        None, alias="reconcileDetectors",
        description="Which detectors may ACT, from overlay_missing, "
                    "overlay_shrunk, never_aggregated, raw_drift. Unset = "
                    "all enabled; an EMPTY list = all disabled (detection "
                    "still runs and is still surfaced).",
    )

    class Config:
        populate_by_name = True


class AggregationSettingsRequest(BaseModel):
    """PUT /aggregation/settings body. ``tuning`` and ``cadence`` are
    independent: each is applied only when present, so the tuning-defaults
    editor and the cadence editor can write without clobbering each other."""
    tuning: Optional[AggregationTuning] = None
    cadence: Optional[AggregationCadence] = None

    class Config:
        populate_by_name = True


class AggregationSettingsResponse(BaseModel):
    tuning: Optional[AggregationTuning] = None
    cadence: Optional[AggregationCadence] = None
    # Effective ENV defaults (read server-side), so the cadence editor can
    # seed its controls from ``persisted ?? envDefault`` — a no-op save then
    # round-trips the real current default instead of pinning a wrong value.
    env_rebuild_min_interval_secs: Optional[int] = Field(
        None, alias="envRebuildMinIntervalSecs",
    )
    env_drift_auto_rebuild: Optional[bool] = Field(
        None, alias="envDriftAutoRebuild",
    )
    updated_at: Optional[str] = Field(None, alias="updatedAt")
    updated_by: Optional[str] = Field(None, alias="updatedBy")

    class Config:
        populate_by_name = True


class FreshnessSettingsRequest(BaseModel):
    """PATCH /data-sources/{id}/freshness-settings body — the per-source
    overrides. ``None`` on any field clears that override (back to the
    resolved global/env default).

    Every field means "clear" when explicitly sent as null, so the handler
    MUST apply only the keys actually present in the request body
    (``model_fields_set``). Treating an absent field as null would make a
    partial PATCH impossible: sending only ``autoReconcileEnabled`` would
    silently wipe the rebuild-interval override.
    """
    rebuild_min_interval_secs: Optional[int] = Field(
        None, alias="rebuildMinIntervalSecs", ge=0, le=86400,
    )
    auto_reconcile_enabled: Optional[bool] = Field(
        None, alias="autoReconcileEnabled",
        description="Per-source automatic-reconciliation flag. Null inherits "
                    "the global setting.",
    )
    reconcile_check_interval_secs: Optional[int] = Field(
        None, alias="reconcileCheckIntervalSecs", ge=300, le=86400,
        description="How often this source is checked for drift. Null "
                    "inherits the global cadence.",
    )

    class Config:
        populate_by_name = True


class FreshnessSettingsResponse(BaseModel):
    """The stored per-source overrides after a PATCH (each echoes the
    effective override; ``None`` = no override, source resolves global/env)."""
    data_source_id: str = Field(alias="dataSourceId")
    rebuild_min_interval_secs: Optional[int] = Field(
        None, alias="rebuildMinIntervalSecs",
    )
    auto_reconcile_enabled: Optional[bool] = Field(
        None, alias="autoReconcileEnabled",
    )
    reconcile_check_interval_secs: Optional[int] = Field(
        None, alias="reconcileCheckIntervalSecs",
    )

    class Config:
        populate_by_name = True


# ── Reconciliation (the drift / overlay-integrity sweep) ─────────────


class ReconcileFinding(BaseModel):
    """One source the sweep would act on (or did). Powers the preview, so an
    operator can see the blast radius before switching automation on."""
    data_source_id: str = Field(alias="dataSourceId")
    name: Optional[str] = None
    workspace_id: Optional[str] = Field(None, alias="workspaceId")
    provider_id: Optional[str] = Field(None, alias="providerId")
    provider_name: Optional[str] = Field(None, alias="providerName")
    reason: str
    evidence: Dict = Field(default_factory=dict)

    class Config:
        populate_by_name = True


class ReconcileRun(BaseModel):
    """One pass of the sweep — the "when did this last run and what did it
    find" record, one row per pass rather than per source."""
    id: str
    started_at: Optional[str] = Field(None, alias="startedAt")
    finished_at: Optional[str] = Field(None, alias="finishedAt")
    mode: str = "auto"
    actor: Optional[str] = None
    scanned: int = 0
    skipped: int = 0
    seeded: int = 0
    findings: int = 0
    actions: int = 0
    errors: int = 0
    by_reason: Dict[str, int] = Field(default_factory=dict, alias="byReason")
    by_skip: Dict[str, int] = Field(default_factory=dict, alias="bySkip")

    class Config:
        populate_by_name = True


class ReconcilePolicyResponse(BaseModel):
    """Resolved global policy plus the env defaults behind it, so the editor
    can seed from ``persisted ?? envDefault`` and a no-op save round-trips the
    real current default instead of pinning a wrong value — the same contract
    ``AggregationSettingsResponse`` already honours for cadence."""
    enabled: Optional[bool] = None
    check_interval_secs: Optional[int] = Field(None, alias="checkIntervalSecs")
    max_actions_per_run: Optional[int] = Field(None, alias="maxActionsPerRun")
    shrink_tolerance_pct: Optional[int] = Field(None, alias="shrinkTolerancePct")
    detectors: Optional[List[str]] = None

    env_enabled: bool = Field(True, alias="envEnabled")
    env_check_interval_secs: int = Field(3600, alias="envCheckIntervalSecs")
    env_max_actions_per_run: int = Field(10, alias="envMaxActionsPerRun")
    env_shrink_tolerance_pct: int = Field(10, alias="envShrinkTolerancePct")
    env_stats_max_age_secs: int = Field(2700, alias="envStatsMaxAgeSecs")
    all_detectors: List[str] = Field(default_factory=list, alias="allDetectors")

    class Config:
        populate_by_name = True


class ReconcileOverviewResponse(BaseModel):
    """GET /freshness/reconciliation — policy plus recent runs."""
    policy: ReconcilePolicyResponse
    runs: List[ReconcileRun] = Field(default_factory=list)

    class Config:
        populate_by_name = True


class ReconcileActivityItem(BaseModel):
    """One overnight-ledger row: a finding from a sweep, joined to the
    refresh_event (and job) it produced when it produced one."""
    run_id: str = Field(alias="runId")
    run_started_at: Optional[str] = Field(None, alias="runStartedAt")
    ts: Optional[str] = None
    data_source_id: str = Field(alias="dataSourceId")
    name: Optional[str] = None
    workspace_id: Optional[str] = Field(None, alias="workspaceId")
    provider_id: Optional[str] = Field(None, alias="providerId")
    provider_name: Optional[str] = Field(None, alias="providerName")
    reason: Optional[str] = None
    mode: str = "auto"  # auto | manual
    outcome: str  # rebuilt | held | failed
    skip: Optional[str] = None
    job_id: Optional[str] = Field(None, alias="jobId")
    evidence: Dict[str, Any] = Field(default_factory=dict)

    class Config:
        populate_by_name = True


class ReconcileActivityResponse(BaseModel):
    """GET /freshness/reconciliation/activity — overnight blotter."""
    since: str
    items: List[ReconcileActivityItem] = Field(default_factory=list)

    class Config:
        populate_by_name = True


class ReconcilePolicyRequest(BaseModel):
    """PUT /freshness/reconciliation. Partial-update semantics, same as the
    per-source PATCH: only explicitly-sent keys are written."""
    enabled: Optional[bool] = None
    check_interval_secs: Optional[int] = Field(
        None, alias="checkIntervalSecs", ge=300, le=86400,
    )
    max_actions_per_run: Optional[int] = Field(
        None, alias="maxActionsPerRun", ge=0, le=200,
    )
    shrink_tolerance_pct: Optional[int] = Field(
        None, alias="shrinkTolerancePct", ge=0, le=100,
    )
    detectors: Optional[List[str]] = None

    class Config:
        populate_by_name = True


class ReconcileRunRequest(BaseModel):
    """POST /freshness/reconcile-now."""
    dry_run: bool = Field(False, alias="dryRun")
    data_source_ids: Optional[List[str]] = Field(None, alias="dataSourceIds")

    class Config:
        populate_by_name = True


class ReconcileRunInternal(ReconcileRunRequest):
    """Body for the Control Plane's sweep twin — adds ``actor``, the
    initiator's user id forwarded by the viz proxy (which forces it, so a
    caller cannot attribute a sweep to someone else). Mirrors
    ``RefreshRequestInternal``."""
    actor: Optional[str] = Field(None, max_length=128)

    class Config:
        populate_by_name = True


class ReconcileRunResponse(BaseModel):
    """The outcome of an on-demand sweep. ``findings`` is populated on a dry
    run so the preview can render what WOULD be reconciled."""
    run: Optional[ReconcileRun] = None
    findings: List[ReconcileFinding] = Field(default_factory=list)
    # True when another replica held the sweep lock, so nothing ran.
    skipped: bool = False

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


# ── Guarded provider refresh batch (F5; reused for the fleet-wide
# refresh-all batch, G2) ──────────────────────────────────────────────


class BatchRefreshRequest(BaseModel):
    """Body for the provider batch-refresh verb (also reused, unchanged,
    by the fleet-wide refresh-all verb). ``scope``/``force`` are forwarded
    to ``refresh_source`` for every live data source in scope;
    ``max_concurrent`` bounds the fan-out (the runner additionally caps it
    at 4 regardless of what's requested)."""
    scope: Literal["auto", "read-caches", "rollups", "full", "clear"] = "auto"
    force: bool = Field(False)
    max_concurrent: int = Field(2, ge=1, alias="maxConcurrent")

    class Config:
        populate_by_name = True


class BatchRefreshRequestInternal(BatchRefreshRequest):
    """Body for the Control Plane's batch-refresh twin — adds the two
    internal-channel fields (mirrors ``RefreshRequestInternal``): ``origin``
    is caller-asserted, ``actor`` is the batch initiator's user id forwarded
    by the viz proxy (defaults to ``internal`` for direct callers)."""
    origin: Literal["script", "connector", "api"] = "api"
    actor: str = Field("internal", max_length=128)

    class Config:
        populate_by_name = True


class BatchItemResult(BaseModel):
    """One data source's outcome within a refresh batch.

    ``name``/``actions``/``deferred`` exist so the completion dialog can say
    WHAT it did to each source instead of listing opaque ids with a tick.
    All three default, because the error branch has no ``RefreshResponse``
    to read and an exception there would strand the batch at "running"."""
    data_source_id: str = Field(alias="dataSourceId")
    outcome: Literal["done", "error"]
    job_id: Optional[str] = Field(None, alias="jobId")
    name: Optional[str] = None
    actions: List[str] = Field(default_factory=list)
    deferred: bool = False

    class Config:
        populate_by_name = True


class BatchStatus(BaseModel):
    """Progress/result of one guarded provider refresh batch, assembled
    from the ``refreshbatch:{batch_id}`` Redis hash."""
    batch_id: str = Field(alias="batchId")
    provider_id: str = Field(alias="providerId")
    total: int = 0
    done: int = 0
    results: List[BatchItemResult] = Field(default_factory=list)
    state: Literal["running", "done"] = "running"

    class Config:
        populate_by_name = True
