"""``graphver`` ORM schema — the durable source of truth for versioned graphs.

Plan §2 (+ §16.5 #2/#4, §17).  Conventions deliberately mirror the existing
``aggregation`` schema (separate Postgres schema, **no cross-schema FKs to
``public``**, logical references only, ISO-string timestamps).

Partitioning (configurable via :data:`config.PARTITIONS`): the high-cardinality
append-only tables use **fixed modulo HASH partitioning on ``graph_id``** — never
a partition per data source.  Postgres requires the partition key in every
PK/UNIQUE, so those tables use a composite PK ``(graph_id, id)``.  Child
partitions are created by :func:`create_schema_and_partitions`.

Append-only discipline: version tables are never ``UPDATE``d.  "Latest version"
is resolved via the small, mutable :class:`EntityHeadORM` pointer table (plan
§16.5 #4) instead of an ``is_head`` flag, so the version tables don't churn.
"""
from __future__ import annotations

from datetime import datetime, timezone

from sqlalchemy import (
    BigInteger,
    Boolean,
    CheckConstraint,
    Column,
    Float,
    ForeignKey,
    Index,
    Integer,
    PrimaryKeyConstraint,
    Text,
    UniqueConstraint,
    text,
)
from sqlalchemy.dialects.postgresql import JSONB

from . import config
from .db import VersioningBase, get_engine
from .ids import prefixed_id

_SCHEMA = config.graphver_schema()

# Tables that are HASH-partitioned on graph_id (child partitions created at
# bootstrap / migration time).
PARTITIONED_TABLES = [
    "commits",
    "node_versions",
    "edge_versions",
    "entity_heads",
    "merkle_nodes",
    "working_changes",
]

_PARTITION_BY = "HASH (graph_id)"


def _now() -> str:
    return datetime.now(timezone.utc).isoformat()


def _plain(*extra):
    return (*extra, {"schema": _SCHEMA})


def _partitioned(*extra):
    return (*extra, {"schema": _SCHEMA, "postgresql_partition_by": _PARTITION_BY})


def _fk(table: str, col: str = "id") -> str:
    return f"{_SCHEMA}.{table}.{col}"


# --------------------------------------------------------------------------- #
# Control-plane tables (low/medium cardinality, not partitioned)              #
# --------------------------------------------------------------------------- #
class GraphORM(VersioningBase):
    """A versioned graph — 1:1 with a management-DB data source (logical ref)."""

    __tablename__ = "graphs"

    id = Column(Text, primary_key=True, default=lambda: prefixed_id("graph"))
    data_source_id = Column(Text, nullable=False)          # logical ref to public
    workspace_id = Column(Text, nullable=False)            # logical ref (tenant)
    tenant_id = Column(Text, nullable=True)                # optional org grouping
    kind = Column(Text, nullable=False)                    # manual|authoritative|hybrid
    base_ontology_id = Column(Text, nullable=True)
    base_ontology_version_id = Column(Text, nullable=True)
    ontology_enforcement = Column(
        Text, nullable=False, default=lambda: config.DEFAULT_ONTOLOGY_ENFORCEMENT
    )
    audit_tier = Column(Text, nullable=False, default=lambda: config.DEFAULT_AUDIT_TIER)
    main_head_commit_seq = Column(BigInteger, nullable=False, default=0)
    fork_parent_graph_id = Column(Text, nullable=True)     # CoW fork base (logical)
    fork_base_commit_seq = Column(BigInteger, nullable=True)
    created_at = Column(Text, nullable=False, default=_now)
    created_by = Column(Text, nullable=True)
    updated_at = Column(Text, nullable=False, default=_now, onupdate=_now)

    __table_args__ = _plain(
        UniqueConstraint("data_source_id", name="uq_graphs_data_source"),
        Index("ix_graphs_workspace", "workspace_id"),
        Index("ix_graphs_tenant", "tenant_id"),
        Index("ix_graphs_fork_parent", "fork_parent_graph_id"),
        CheckConstraint(
            "kind IN ('manual','authoritative','hybrid')", name="ck_graphs_kind"
        ),
        CheckConstraint(
            "ontology_enforcement IN ('strict','permissive')", name="ck_graphs_enforce"
        ),
        CheckConstraint(
            "audit_tier IN ('commit_only','full_wip')", name="ck_graphs_audit"
        ),
    )


class BranchORM(VersioningBase):
    """A draft/branch, or the reserved ``main`` branch, of a graph."""

    __tablename__ = "branches"

    id = Column(Text, primary_key=True, default=lambda: prefixed_id("br"))
    graph_id = Column(
        Text, ForeignKey(_fk("graphs"), ondelete="CASCADE"), nullable=False
    )
    kind = Column(Text, nullable=False)                    # main|draft|fork_draft
    name = Column(Text, nullable=True)
    owner = Column(Text, nullable=True)                    # actor (per-user draft)
    is_shared = Column(Boolean, nullable=False, default=False)
    base_commit_seq = Column(BigInteger, nullable=True)    # main seq branched from
    head_commit_id = Column(Text, nullable=True)           # latest checkpoint (logical)
    status = Column(Text, nullable=False, default="open")  # open|publishing|merged|abandoned
    originating_view_id = Column(Text, nullable=True)      # per-view audit (logical)
    base_ontology_version_id = Column(Text, nullable=True)  # plan §16.5 #6
    created_at = Column(Text, nullable=False, default=_now)
    created_by = Column(Text, nullable=True)
    updated_at = Column(Text, nullable=False, default=_now, onupdate=_now)

    __table_args__ = _plain(
        Index("ix_branches_graph", "graph_id"),
        Index("ix_branches_owner", "owner"),
        Index("ix_branches_status", "status"),
        CheckConstraint(
            "kind IN ('main','draft','fork_draft')", name="ck_branches_kind"
        ),
        CheckConstraint(
            "status IN ('open','publishing','merged','abandoned')",
            name="ck_branches_status",
        ),
    )


class BranchMemberORM(VersioningBase):
    """Shared-branch collaborators — users *or* groups (plan §8)."""

    __tablename__ = "branch_members"

    id = Column(Text, primary_key=True, default=lambda: prefixed_id("bm"))
    branch_id = Column(
        Text, ForeignKey(_fk("branches"), ondelete="CASCADE"), nullable=False
    )
    subject_type = Column(Text, nullable=False)            # user|group
    subject_id = Column(Text, nullable=False)
    role = Column(Text, nullable=False)                    # editor|viewer|maintainer
    created_at = Column(Text, nullable=False, default=_now)

    __table_args__ = _plain(
        UniqueConstraint(
            "branch_id", "subject_type", "subject_id", name="uq_branch_member"
        ),
        CheckConstraint(
            "subject_type IN ('user','group')", name="ck_bm_subject_type"
        ),
        CheckConstraint(
            "role IN ('editor','viewer','maintainer')", name="ck_bm_role"
        ),
    )


class MergeRequestORM(VersioningBase):
    """A PR: draft→main or fork→base. Squash to main is gated by maintainer +
    approval + checks (plan §12.5, §16.5 #6, §17 #5)."""

    __tablename__ = "merge_requests"

    id = Column(Text, primary_key=True, default=lambda: prefixed_id("pr"))
    graph_id = Column(Text, nullable=False)                # logical
    source_branch_id = Column(Text, nullable=False)
    target_graph_id = Column(Text, nullable=False)
    target_branch = Column(Text, nullable=False, default="main")
    base_commit_seq = Column(BigInteger, nullable=True)
    status = Column(Text, nullable=False, default="open")
    conflicts = Column(JSONB, nullable=True)              # field-level conflict set
    resolutions = Column(JSONB, nullable=True)            # who resolved / chosen value
    reviewers = Column(JSONB, nullable=True)
    approved_by = Column(JSONB, nullable=True)
    approval_status = Column(Text, nullable=True)
    checks_status = Column(JSONB, nullable=True)          # ontology re-validation etc.
    resulting_commit_id = Column(Text, nullable=True)
    actor = Column(Text, nullable=True)
    created_at = Column(Text, nullable=False, default=_now)
    updated_at = Column(Text, nullable=False, default=_now, onupdate=_now)

    __table_args__ = _plain(
        Index("ix_mr_graph", "graph_id"),
        Index("ix_mr_status", "status"),
        CheckConstraint(
            "status IN ('open','conflicts','mergeable','approved','merged','closed')",
            name="ck_mr_status",
        ),
    )


class ProjectionStateORM(VersioningBase):
    """FalkorDB projection watermark + placement/eviction state per graph
    (plan §5, §16.5 #9). Drives the read watermark and bounded-staleness."""

    __tablename__ = "projection_state"

    graph_id = Column(Text, primary_key=True)
    projected_commit_seq = Column(BigInteger, nullable=False, default=0)
    target_commit_seq = Column(BigInteger, nullable=False, default=0)
    status = Column(Text, nullable=False, default="idle")  # idle|projecting|rebuilding|evicted
    falkor_graph_name = Column(Text, nullable=True)
    shard_map = Column(JSONB, nullable=True)
    last_projected_at = Column(Text, nullable=True)
    last_error = Column(Text, nullable=True)
    updated_at = Column(Text, nullable=False, default=_now, onupdate=_now)

    __table_args__ = _plain(
        CheckConstraint(
            "status IN ('idle','projecting','rebuilding','evicted')",
            name="ck_proj_status",
        ),
    )


class JobORM(VersioningBase):
    """Crash-recoverable worker job (ingest / projection / rebuild).

    Mirrors ``AggregationJobORM`` (cursor checkpoint, idempotency key, phase,
    retry, monotonic sequence) — plan §4/§5/§17 #6."""

    __tablename__ = "jobs"

    id = Column(Text, primary_key=True, default=lambda: prefixed_id("vjob"))
    job_type = Column(Text, nullable=False)               # ingest|projection|rebuild
    graph_id = Column(Text, nullable=False)               # logical
    workspace_id = Column(Text, nullable=True)
    status = Column(Text, nullable=False, default="pending")
    progress = Column(Integer, nullable=False, default=0)
    total = Column(Integer, nullable=False, default=0)
    processed = Column(Integer, nullable=False, default=0)
    last_cursor = Column(Text, nullable=True)
    batch_size = Column(Integer, nullable=False, default=lambda: config.INGEST_BATCH_SIZE)
    current_phase = Column(Text, nullable=True)
    idempotency_key = Column(Text, nullable=True)
    retry_count = Column(Integer, nullable=False, default=0)
    max_retries = Column(Integer, nullable=False, default=3)
    last_sequence = Column(Integer, nullable=False, default=0)
    error_message = Column(Text, nullable=True)
    payload_uri = Column(Text, nullable=True)             # object-storage handle (bulk)
    target_commit_id = Column(Text, nullable=True)
    timeout_secs = Column(Integer, nullable=True)
    started_at = Column(Text, nullable=True)
    completed_at = Column(Text, nullable=True)
    updated_at = Column(Text, nullable=True)
    created_at = Column(Text, nullable=False, default=_now)

    __table_args__ = _plain(
        Index("ix_jobs_graph_status", "graph_id", "status"),
        Index("ix_jobs_type_status", "job_type", "status"),
        Index(
            "ix_jobs_idem_active",
            "graph_id",
            "idempotency_key",
            unique=True,
            postgresql_where=text("idempotency_key IS NOT NULL"),
        ),
        CheckConstraint(
            "status IN ('pending','running','completed','failed','cancelled')",
            name="ck_jobs_status",
        ),
        CheckConstraint(
            "job_type IN ('ingest','projection','rebuild')", name="ck_jobs_type"
        ),
    )


# --------------------------------------------------------------------------- #
# Versioned data (high cardinality, append-only, HASH-partitioned on graph_id) #
# --------------------------------------------------------------------------- #
class CommitORM(VersioningBase):
    """Append-only commit log — linear per branch (squash-only on main)."""

    __tablename__ = "commits"

    graph_id = Column(Text, nullable=False)
    id = Column(Text, nullable=False, default=lambda: prefixed_id("cmt"))
    branch_id = Column(Text, nullable=False)
    commit_seq = Column(BigInteger, nullable=False)
    parent_commit_id = Column(Text, nullable=True)
    merkle_root = Column(Text, nullable=True)             # async-filled for bulk
    kind = Column(Text, nullable=False)
    message = Column(Text, nullable=True)
    actor = Column(Text, nullable=True)
    contributors = Column(JSONB, nullable=True)           # distinct actors (squash)
    originating_view_id = Column(Text, nullable=True)
    change_reason = Column(Text, nullable=True)
    source_branch_id = Column(Text, nullable=True)        # squash provenance
    source_commit_ids = Column(JSONB, nullable=True)
    source_commit_count = Column(Integer, nullable=True)
    stats = Column(JSONB, nullable=True)
    created_at = Column(Text, nullable=False, default=_now)

    __table_args__ = _partitioned(
        PrimaryKeyConstraint("graph_id", "id", name="pk_commits"),
        UniqueConstraint(
            "graph_id", "branch_id", "commit_seq", name="uq_commits_branch_seq"
        ),
        Index("ix_commits_seq_brin", "commit_seq", postgresql_using="brin"),
        CheckConstraint(
            "kind IN ('genesis','edit','checkpoint','squash_publish','import',"
            "'sync','revert')",
            name="ck_commits_kind",
        ),
    )


class NodeVersionORM(VersioningBase):
    """Append-only node version row — also the node-level audit log."""

    __tablename__ = "node_versions"

    graph_id = Column(Text, nullable=False)
    id = Column(Text, nullable=False, default=lambda: prefixed_id("nv"))
    entity_id = Column(Text, nullable=False)              # stable ULID (rename-safe)
    commit_id = Column(Text, nullable=False)
    commit_seq = Column(BigInteger, nullable=False)
    branch_id = Column(Text, nullable=False)
    op = Column(Text, nullable=False)                     # create|update|delete
    content_hash = Column(Text, nullable=False)
    prev_content_hash = Column(Text, nullable=True)
    urn = Column(Text, nullable=True)
    entity_type = Column(Text, nullable=True)
    display_name = Column(Text, nullable=True)
    qualified_name = Column(Text, nullable=True)
    payload = Column(JSONB, nullable=True)               # null = tombstone
    actor = Column(Text, nullable=True)
    change_reason = Column(Text, nullable=True)
    created_at = Column(Text, nullable=False, default=_now)

    __table_args__ = _partitioned(
        PrimaryKeyConstraint("graph_id", "id", name="pk_node_versions"),
        Index("ix_nv_entity_hist", "graph_id", "entity_id", "commit_seq"),
        Index("ix_nv_branch_changeset", "graph_id", "branch_id", "commit_seq"),
        Index("ix_nv_content_hash", "graph_id", "content_hash"),
        Index("ix_nv_commit", "graph_id", "commit_id"),
        Index("ix_nv_seq_brin", "commit_seq", postgresql_using="brin"),
        CheckConstraint("op IN ('create','update','delete')", name="ck_nv_op"),
    )


class EdgeVersionORM(VersioningBase):
    """Append-only edge version row — endpoints are stable entity_ids
    (rename-safe), with an optional discriminator for parallel edges (§17 #2)."""

    __tablename__ = "edge_versions"

    graph_id = Column(Text, nullable=False)
    id = Column(Text, nullable=False, default=lambda: prefixed_id("ev"))
    entity_id = Column(Text, nullable=False)
    commit_id = Column(Text, nullable=False)
    commit_seq = Column(BigInteger, nullable=False)
    branch_id = Column(Text, nullable=False)
    op = Column(Text, nullable=False)
    content_hash = Column(Text, nullable=False)
    prev_content_hash = Column(Text, nullable=True)
    source_entity_id = Column(Text, nullable=False)
    target_entity_id = Column(Text, nullable=False)
    edge_type = Column(Text, nullable=True)
    discriminator = Column(Text, nullable=True)
    confidence = Column(Float, nullable=True)
    payload = Column(JSONB, nullable=True)
    actor = Column(Text, nullable=True)
    change_reason = Column(Text, nullable=True)
    created_at = Column(Text, nullable=False, default=_now)

    __table_args__ = _partitioned(
        PrimaryKeyConstraint("graph_id", "id", name="pk_edge_versions"),
        Index("ix_ev_entity_hist", "graph_id", "entity_id", "commit_seq"),
        Index("ix_ev_source", "graph_id", "source_entity_id"),
        Index("ix_ev_target", "graph_id", "target_entity_id"),
        Index("ix_ev_branch_changeset", "graph_id", "branch_id", "commit_seq"),
        Index("ix_ev_seq_brin", "commit_seq", postgresql_using="brin"),
        CheckConstraint("op IN ('create','update','delete')", name="ck_ev_op"),
    )


class EntityHeadORM(VersioningBase):
    """Mutable head pointer per (graph, branch, entity) — keeps version tables
    strictly append-only (plan §16.5 #4). A draft holds only its changed
    entities and falls back to ``main`` for the rest."""

    __tablename__ = "entity_heads"

    graph_id = Column(Text, nullable=False)
    branch_id = Column(Text, nullable=False)
    entity_id = Column(Text, nullable=False)
    entity_kind = Column(Text, nullable=False)            # node|edge
    head_version_id = Column(Text, nullable=False)
    content_hash = Column(Text, nullable=False)
    is_tombstone = Column(Boolean, nullable=False, default=False)
    updated_at = Column(Text, nullable=False, default=_now, onupdate=_now)

    __table_args__ = _partitioned(
        PrimaryKeyConstraint(
            "graph_id", "branch_id", "entity_id", name="pk_entity_heads"
        ),
        Index("ix_heads_kind", "graph_id", "branch_id", "entity_kind"),
        CheckConstraint("entity_kind IN ('node','edge')", name="ck_heads_kind"),
    )


class MerkleNodeORM(VersioningBase):
    """Hierarchical CoW Merkle tree nodes per commit (only changed buckets are
    materialised; unchanged subtrees inherited from earlier commits via the
    ``(graph_id, branch_id, path, commit_seq)`` as-of index)."""

    __tablename__ = "merkle_nodes"

    graph_id = Column(Text, nullable=False)
    branch_id = Column(Text, nullable=False)
    commit_id = Column(Text, nullable=False)
    commit_seq = Column(BigInteger, nullable=False)
    path = Column(Text, nullable=False)                   # "" = root, else "a/3/.."
    level = Column(Integer, nullable=False)
    hash = Column(Text, nullable=False)
    bucket = Column(JSONB, nullable=True)                 # leaf only: {entity_id: content_hash}
    child_count = Column(Integer, nullable=True)

    __table_args__ = _partitioned(
        PrimaryKeyConstraint("graph_id", "commit_id", "path", name="pk_merkle_nodes"),
        Index("ix_merkle_commit", "graph_id", "commit_id"),
        Index("ix_merkle_asof", "graph_id", "branch_id", "path", "commit_seq"),
    )


class WorkingChangeORM(VersioningBase):
    """Durable draft staging buffer — client edits bulk-flushed here before a
    checkpoint folds them into version rows (plan §3, decision #10)."""

    __tablename__ = "working_changes"

    graph_id = Column(Text, nullable=False)
    id = Column(Text, nullable=False, default=lambda: prefixed_id("wc"))
    branch_id = Column(Text, nullable=False)
    seq = Column(BigInteger, nullable=False)
    op = Column(Text, nullable=False)                     # create|update|delete
    entity_kind = Column(Text, nullable=False)            # node|edge
    entity_id = Column(Text, nullable=False)
    payload = Column(JSONB, nullable=True)
    base_content_hash = Column(Text, nullable=True)       # OCC against head at edit
    actor = Column(Text, nullable=True)
    change_reason = Column(Text, nullable=True)
    committed_into_commit_id = Column(Text, nullable=True)
    created_at = Column(Text, nullable=False, default=_now)

    __table_args__ = _partitioned(
        PrimaryKeyConstraint("graph_id", "id", name="pk_working_changes"),
        Index("ix_wc_branch_seq", "graph_id", "branch_id", "seq"),
        Index(
            "ix_wc_uncommitted",
            "graph_id",
            "branch_id",
            "seq",
            postgresql_where=text("committed_into_commit_id IS NULL"),
        ),
        CheckConstraint("op IN ('create','update','delete')", name="ck_wc_op"),
        CheckConstraint(
            "entity_kind IN ('node','edge')", name="ck_wc_entity_kind"
        ),
    )


# --------------------------------------------------------------------------- #
# Bootstrap (dev/test/migration helper)                                       #
# --------------------------------------------------------------------------- #
async def create_schema_and_partitions(engine=None) -> None:
    """Create the ``graphver`` schema, all tables, and the hash partitions.

    Idempotent.  Used by the dev bootstrap and the Alembic migration body.
    Child partitions are created *after* ``create_all`` so the partitioned
    indexes defined on each parent are auto-attached to them (PG 11+).
    """
    eng = engine or get_engine()
    async with eng.begin() as conn:
        await conn.execute(text(f'CREATE SCHEMA IF NOT EXISTS "{_SCHEMA}"'))
        await conn.run_sync(VersioningBase.metadata.create_all)
        n = config.PARTITIONS
        for tname in PARTITIONED_TABLES:
            for rem in range(n):
                await conn.execute(
                    text(
                        f'CREATE TABLE IF NOT EXISTS "{_SCHEMA}"."{tname}_p{rem}" '
                        f'PARTITION OF "{_SCHEMA}"."{tname}" '
                        f"FOR VALUES WITH (MODULUS {n}, REMAINDER {rem})"
                    )
                )
