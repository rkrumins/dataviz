"""
Aggregation-owned ORM tables.

These tables live in the ``aggregation`` Postgres schema, fully decoupled
from the viz-service's ``public`` schema.  No foreign keys cross the
schema boundary — data_source_id is a logical reference, not a FK.

Tables:
    aggregation.aggregation_jobs       Job state for crash-recoverable batch materialization.
    aggregation.data_source_state      Per-data-source aggregation status (lightweight).
"""
import uuid
from datetime import datetime, timezone

from sqlalchemy import CheckConstraint, Column, Index, Integer, Text, text
from backend.app.db.engine import Base


def _now() -> str:
    return datetime.now(timezone.utc).isoformat()


# Every value the jobs-table CHECK constraint accepts. ``purge`` marks the
# purge lifecycle row itself (managed by the insights worker; excluded from
# the reconciler, crash recovery and resume), so API callers may mint any
# source EXCEPT it — ``post_purge`` is the re-aggregation fired after a
# purge completes, ``auto`` the read-path backfill.
TRIGGER_SOURCES = (
    "onboarding", "manual", "schedule", "drift", "api",
    "purge", "post_purge", "auto",
    # Unpacks nested property containers into native fields. Reuses this row
    # (as purge does) so Job History stays uniform AND so it inherits the
    # one-active-job-per-source guard — an alignment must not rewrite node
    # properties while an aggregation materializes edges over the same graph.
    "property_alignment",
)
#: Sources a client may ask for directly. ``purge`` and ``property_alignment``
#: are claimed by their own endpoints, which do more than mint a row.
API_TRIGGER_SOURCES = tuple(
    s for s in TRIGGER_SOURCES if s not in ("purge", "property_alignment")
)


class AggregationJobORM(Base):
    """Job tracking table — the worker reads everything from this record.

    All context needed for execution (provider_id, graph_name, edge types)
    is denormalized and frozen at trigger time so the worker is fully
    self-sufficient without querying the public schema.
    """
    __tablename__ = "aggregation_jobs"

    id = Column(Text, primary_key=True, default=lambda: f"agg_{uuid.uuid4().hex[:12]}")

    # ── Logical reference (NOT a FK) — decoupled from public schema ──
    data_source_id = Column(Text, nullable=False, index=True)

    # ── Denormalized context (frozen at trigger time) ────────────────
    # These fields are copied from the viz-service's data at trigger
    # time so the worker and Control Plane never need to JOIN to public.
    workspace_id = Column(Text, nullable=True)
    provider_id = Column(Text, nullable=True)
    graph_name = Column(Text, nullable=True)
    data_source_label = Column(Text, nullable=True)

    ontology_id = Column(Text, nullable=True)  # audit trail — which ontology was used
    projection_mode = Column(Text, nullable=False, default="in_source")
    status = Column(Text, nullable=False, default="pending")
    trigger_source = Column(Text, nullable=False, default="manual")

    # ── Resolved ontology edge types (frozen at trigger time) ────────
    containment_edge_types = Column(Text, nullable=True)  # JSON: ["CONTAINS", "HAS_SCHEMA"]
    lineage_edge_types = Column(Text, nullable=True)  # JSON: ["FLOWS_TO", "TRANSFORMS"]

    # Entity-type → hierarchy level map, frozen at trigger time. JSON
    # object: {"dataset": 3, "container": 2, ...}. The worker injects this
    # into the provider (set_entity_type_levels) so ancestor-chain depth
    # adapts to deep ontologies and AGGREGATED edges get correct
    # source/target level stamps — without the worker importing the
    # ontology module. Its keys also drive per-label index creation
    # (ensure_indices). NULL on rows created before this column existed
    # and on the legacy/non-streaming path (degrades to max_depth=10 +
    # label-scan trace fallback, both correct).
    entity_type_levels = Column(Text, nullable=True)  # JSON: {"<entity_type>": <level int>}

    # Node-identity property frozen at trigger time — the physical graph
    # property that stands in for the platform's canonical ``urn``. NULL means
    # "urn" (default, and every legacy row). Freezing it here (rather than
    # reading the data-source row at pickup) is what lets an operator change the
    # data source's identity_property mid-lifecycle and have the NEXT run pick
    # up the new value while an in-flight run keeps its own frozen value.
    identity_property = Column(Text, nullable=True)

    # Node display-name property frozen at trigger time — the physical graph
    # property holding the human name (default "name"). Stamped onto
    # `displayName` by the aggregation run so the read stack renders it.
    name_property = Column(Text, nullable=True)

    # ── Progress tracking (cursor-based checkpoint) ──────────────────
    progress = Column(Integer, nullable=False, default=0)  # 0-100
    total_edges = Column(Integer, nullable=False, default=0)
    processed_edges = Column(Integer, nullable=False, default=0)
    created_edges = Column(Integer, nullable=False, default=0)  # AGGREGATED edges created
    last_cursor = Column(Text, nullable=True)  # cursor-based resume point (NOT offset)
    batch_size = Column(Integer, nullable=False, default=1000)
    last_checkpoint_at = Column(Text, nullable=True)

    # ── Error handling ───────────────────────────────────────────────
    error_message = Column(Text, nullable=True)
    retry_count = Column(Integer, nullable=False, default=0)
    max_retries = Column(Integer, nullable=False, default=3)

    # ── Phase visibility ──────────────────────────────────────────────
    # Short string identifying which phase of the materialization
    # pipeline is currently running. Surfaced to the UI so operators can
    # see what a long-running job is doing. Values: 'extracting' /
    # 'computing' / 'reconciling' / 'applying'. NULL on legacy rows and
    # on providers that don't emit phase signals — frontend falls back
    # to a generic label.
    current_phase = Column(Text, nullable=True)

    # ── Dynamic timeout (estimated from graph size at trigger time) ──
    timeout_secs = Column(Integer, nullable=True)  # None = use global default

    # ── Pipeline tuning + run reporting (Iteration 2) ─────────────────
    # tuning_json: JSON object of pipeline knob overrides (scan range
    # width, memory cap, pacing, chunks, extract concurrency, leaf-pair
    # toggle). Frozen at trigger time = request.tuning merged over the
    # stored global defaults; resume overrides replace it. NULL = env
    # defaults only (legacy rows).
    tuning_json = Column(Text, nullable=True)
    # run_stats: JSON written on completion — per-phase durations plus
    # writes/deletes/pairs counters for the job detail UI.
    run_stats = Column(Text, nullable=True)
    # worker_id: which worker (pod/consumer) executed this job.
    worker_id = Column(Text, nullable=True)

    # ── Fingerprinting (change detection) ────────────────────────────
    graph_fingerprint_before = Column(Text, nullable=True)
    graph_fingerprint_after = Column(Text, nullable=True)

    # ── Idempotency ─────────────────────────────────────────────────
    idempotency_key = Column(Text, nullable=True)

    # Ontology resolution fingerprint at trigger time. Stable hash over
    # the assigned ontology's revision + entity / relationship type
    # definitions (computed by ``backend.app.ontology.gate``). The
    # idempotency replay (60-min window keyed by idempotency_key) only
    # short-circuits when this matches the current ontology fingerprint;
    # any change to containment / lineage classifications shifts the
    # fingerprint and forces a fresh resolve. NULL on rows created
    # before this column existed and on aggregation_data_source_state
    # entries cleared by the ontology PUT invalidation hook — both are
    # treated as "stale, recompute".
    ontology_fingerprint = Column(Text, nullable=True)

    # Per-emit sequence counter for the platform JobEmitter. Strictly
    # monotonic per job_id. The worker increments it on every progress
    # / heartbeat / terminal event published, and persists the highest
    # value at outer-batch boundaries. On crash + resume, the recovered
    # worker reads ``last_sequence`` and continues numbering from there
    # so downstream consumers (SSE clients, audit log) can detect gaps
    # and dedup retried events via ``(job_id, sequence)``. Nullable for
    # back-compat with rows created before this column existed; treat
    # NULL as 0.
    last_sequence = Column(Integer, nullable=True, default=0)

    # ── Timestamps ───────────────────────────────────────────────────
    started_at = Column(Text, nullable=True)
    completed_at = Column(Text, nullable=True)
    updated_at = Column(Text, nullable=True)
    created_at = Column(Text, nullable=False, default=_now)

    __table_args__ = (
        Index("ix_agg_jobs_ds_status", "data_source_id", "status"),
        Index("ix_agg_jobs_created_at", "created_at"),
        Index("ix_agg_jobs_workspace", "workspace_id"),
        Index(
            "ix_agg_jobs_idem_active",
            "data_source_id",
            "idempotency_key",
            unique=True,
            # Only ACTIVE rows participate in uniqueness (the name always
            # promised this): the replay window is 60 min, so a key reused
            # against a long-completed job must create a fresh run, not
            # explode on a forever-unique tombstone.
            postgresql_where=text(
                "idempotency_key IS NOT NULL "
                "AND status IN ('pending', 'running')"
            ),
        ),
        CheckConstraint(
            "status IN ('pending', 'running', 'completed', 'failed', 'cancelled')",
            name="ck_agg_jobs_status",
        ),
        CheckConstraint(
            "trigger_source IN ({})".format(
                ", ".join(f"'{s}'" for s in TRIGGER_SOURCES)
            ),
            name="ck_agg_jobs_trigger_source",
        ),
        CheckConstraint(
            "projection_mode IN ('in_source', 'dedicated')",
            name="ck_agg_jobs_projection_mode",
        ),
        {"schema": "aggregation"},
    )


class AggregationDataSourceStateORM(Base):
    """Lightweight per-data-source aggregation state.

    Replaces the aggregation-specific columns that were previously
    stored on ``public.workspace_data_sources``.  The Control Plane
    reads/writes this table.  The viz-service syncs its own copy
    via Redis events.
    """
    __tablename__ = "data_source_state"
    __table_args__ = ({"schema": "aggregation"},)

    data_source_id = Column(Text, primary_key=True)
    workspace_id = Column(Text, nullable=False, index=True)
    aggregation_status = Column(Text, nullable=False, default="none")
    last_aggregated_at = Column(Text, nullable=True)
    aggregation_edge_count = Column(Integer, nullable=False, default=0)
    graph_fingerprint = Column(Text, nullable=True)
    aggregation_schedule = Column(Text, nullable=True)  # cron expression
    # Per-source rebuild-cooldown override (seconds). NULL = fall through to
    # the persisted global cadence, then the env default. Resolved by
    # ``resolve_rebuild_interval`` across the service, scheduler and web tier.
    rebuild_min_interval_secs = Column(Integer, nullable=True)


class AggregationSettingsORM(Base):
    """Global aggregation defaults (single row, id='global').

    Stores the default pipeline tuning applied to every job at trigger
    time (request-level tuning overrides layer on top). Editable via
    GET/PUT /aggregation/settings and the admin Defaults dialog.
    """
    __tablename__ = "aggregation_settings"
    __table_args__ = ({"schema": "aggregation"},)

    id = Column(Text, primary_key=True, default="global")
    tuning_json = Column(Text, nullable=True)  # JSON: AggregationTuning fields
    # JSON: AggregationCadence fields (rebuild_min_interval_secs,
    # drift_auto_rebuild). Kept separate from tuning_json so the global
    # cadence never leaks into per-job frozen tuning.
    cadence_json = Column(Text, nullable=True)
    updated_at = Column(Text, nullable=True)
    updated_by = Column(Text, nullable=True)
