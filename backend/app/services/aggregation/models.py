"""
AggregationJobORM — package-local ORM table for aggregation job tracking.

This table stores all state needed for crash-recoverable, resumable
batch materialization. The worker reads everything from this record.
"""
import uuid
from datetime import datetime, timezone

from sqlalchemy import CheckConstraint, Column, ForeignKey, Index, Integer, Text, text
from backend.app.db.engine import Base


def _now() -> str:
    return datetime.now(timezone.utc).isoformat()


class AggregationJobORM(Base):
    __tablename__ = "aggregation_jobs"

    id = Column(Text, primary_key=True, default=lambda: f"agg_{uuid.uuid4().hex[:12]}")
    data_source_id = Column(
        Text,
        ForeignKey("workspace_data_sources.id", ondelete="CASCADE"),
        nullable=False,
    )
    ontology_id = Column(Text, nullable=True)  # audit trail — which ontology was used
    projection_mode = Column(Text, nullable=False, default="in_source")  # "in_source" | "dedicated"
    status = Column(Text, nullable=False, default="pending")  # pending|running|completed|failed|cancelled
    trigger_source = Column(Text, nullable=False, default="manual")  # onboarding|manual|schedule|drift

    # ── Resolved ontology edge types (frozen at trigger time) ────────
    containment_edge_types = Column(Text, nullable=True)  # JSON: ["CONTAINS", "HAS_SCHEMA"]
    lineage_edge_types = Column(Text, nullable=True)  # JSON: ["FLOWS_TO", "TRANSFORMS"]

    # ── Progress tracking (cursor-based checkpoint) ──────────────────
    progress = Column(Integer, nullable=False, default=0)  # 0-100
    total_edges = Column(Integer, nullable=False, default=0)  # total lineage edges to process
    processed_edges = Column(Integer, nullable=False, default=0)  # edges processed so far
    created_edges = Column(Integer, nullable=False, default=0)  # AGGREGATED edges created
    last_cursor = Column(Text, nullable=True)  # cursor-based resume point (NOT offset)
    batch_size = Column(Integer, nullable=False, default=1000)
    last_checkpoint_at = Column(Text, nullable=True)  # ISO timestamp of last batch commit

    # ── Error handling ───────────────────────────────────────────────
    error_message = Column(Text, nullable=True)
    retry_count = Column(Integer, nullable=False, default=0)  # how many times retried
    max_retries = Column(Integer, nullable=False, default=3)

    # ── Fingerprinting (change detection) ────────────────────────────
    graph_fingerprint_before = Column(Text, nullable=True)
    graph_fingerprint_after = Column(Text, nullable=True)

    # ── Idempotency (Phase 2 §2.2) ───────────────────────────────────
    # Optional caller-supplied key. Two triggers within 60 min sharing a key
    # for the same data_source_id collapse to the original job (returns 200,
    # not 409). Partial unique index lets the column be null for the vast
    # majority of jobs without enforcing uniqueness on NULL.
    idempotency_key = Column(Text, nullable=True)

    # ── Timestamps ───────────────────────────────────────────────────
    started_at = Column(Text, nullable=True)
    completed_at = Column(Text, nullable=True)
    updated_at = Column(Text, nullable=True)  # heartbeat — updated every checkpoint
    created_at = Column(Text, nullable=False, default=_now)

    # ── Index for concurrent job guard + status polling ───────────────
    __table_args__ = (
        Index("ix_agg_jobs_ds_status", "data_source_id", "status"),
        Index("ix_agg_jobs_created_at", "created_at"),
        Index(
            "ix_agg_jobs_idem_active",
            "data_source_id",
            "idempotency_key",
            unique=True,
            postgresql_where=text("idempotency_key IS NOT NULL"),
        ),
        CheckConstraint(
            "status IN ('pending', 'running', 'completed', 'failed', 'cancelled')",
            name="ck_agg_jobs_status",
        ),
        CheckConstraint(
            "trigger_source IN ('onboarding', 'manual', 'schedule', 'drift', 'api')",
            name="ck_agg_jobs_trigger_source",
        ),
        CheckConstraint(
            "projection_mode IN ('in_source', 'dedicated')",
            name="ck_agg_jobs_projection_mode",
        ),
    )
