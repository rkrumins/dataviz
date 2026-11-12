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

import logging
import re
from datetime import datetime, timedelta, timezone

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
from sqlalchemy import inspect as sa_inspect
from sqlalchemy.dialects.postgresql import JSONB, TIMESTAMP

from . import config
from .db import VersioningBase, get_engine
from .ids import prefixed_id

logger = logging.getLogger(__name__)

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
    kind = Column(Text, nullable=False)                    # manual|authoritative|hybrid|blank
    base_ontology_id = Column(Text, nullable=True)
    base_ontology_version_id = Column(Text, nullable=True)
    ontology_spec = Column(JSONB, nullable=True)           # inline vocab: {entity_types, edge_types}
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
    # SOFT DELETE. A versioned graph holds human-authored history — commits, drafts, curation.
    # Destroying it is irreversible and reclaiming millions of version rows is a long background
    # job, so the graph disappears from every read the instant the user asks while the rows
    # survive a grace period. An undo window is the difference between a mistake and a disaster.
    # EVERY read path must filter `deleted_at IS NULL` (see ix_graphs_live).
    deleted_at = Column(Text, nullable=True)
    deleted_by = Column(Text, nullable=True)
    # live|frozen, and the revision a freeze or unfreeze compares and bumps. Trashed and purging
    # are derived from deleted_at (and a purge job) until lifecycle v2 stores them; changed_at
    # restarts the idle-draft TTL at unfreeze (20261018_1200_gv_lifecycle).
    lifecycle_state = Column(Text, nullable=False, default="live", server_default=text("'live'"))
    lifecycle_rev = Column(BigInteger, nullable=False, default=0, server_default=text("0"))
    lifecycle_changed_at = Column(Text, nullable=True)

    __table_args__ = _plain(
        UniqueConstraint("data_source_id", name="uq_graphs_data_source"),
        Index("ix_graphs_workspace", "workspace_id"),
        Index("ix_graphs_tenant", "tenant_id"),
        Index("ix_graphs_fork_parent", "fork_parent_graph_id"),
        CheckConstraint(
            "kind IN ('manual','authoritative','hybrid','blank')", name="ck_graphs_kind"
        ),
        CheckConstraint(
            "ontology_enforcement IN ('strict','permissive')", name="ck_graphs_enforce"
        ),
        CheckConstraint(
            "audit_tier IN ('commit_only','full_wip')", name="ck_graphs_audit"
        ),
        CheckConstraint(
            "lifecycle_state IN ('live','frozen')", name="ck_graphs_lifecycle_state"
        ),
    )


class ForkBaseORM(VersioningBase):
    """The parent's ``main`` seq a fork's ``main`` reads from each fork seq on: one row at the fork
    point, written by ``fork_graph``, and one per Update from parent. A read of the fork at seq S
    composes its parent at the ``parent_seq`` of the latest row with ``fork_seq <= S``
    (``service.fork_base_at``; 20261030_1100_gv_fork_bases)."""

    __tablename__ = "fork_bases"

    fork_graph_id = Column(Text, ForeignKey(_fk("graphs"), ondelete="CASCADE"), nullable=False)
    fork_seq = Column(BigInteger, nullable=False)
    parent_seq = Column(BigInteger, nullable=False)
    created_at = Column(TIMESTAMP(timezone=True), nullable=False, server_default=text("now()"))
    created_by = Column(Text, nullable=True)

    __table_args__ = _plain(
        PrimaryKeyConstraint("fork_graph_id", "fork_seq", name="pk_fork_bases"),
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
    description = Column(Text, nullable=True)              # optional, user-editable
    owner = Column(Text, nullable=True)                    # actor (per-user draft)
    is_shared = Column(Boolean, nullable=False, default=False)  # has member rows
    # public: everyone who reads the data source sees it, and everyone who edits it may write;
    # private: its owner, its members and the people on its review only. ``main`` reads public.
    visibility = Column(Text, nullable=False, default="private", server_default=text("'private'"))
    base_commit_seq = Column(BigInteger, nullable=True)    # main seq branched from
    head_commit_id = Column(Text, nullable=True)           # latest checkpoint (logical)
    status = Column(Text, nullable=False, default="open")  # open|publishing|merged|abandoned
    originating_view_id = Column(Text, nullable=True)      # per-view audit (logical)
    base_ontology_version_id = Column(Text, nullable=True)  # plan §16.5 #6
    created_at = Column(Text, nullable=False, default=_now)
    created_by = Column(Text, nullable=True)
    updated_at = Column(Text, nullable=False, default=_now, onupdate=_now)
    # A closed draft's changes, removed once it has been closed for the retention window
    # (``draft_retention``): when the removal began — reads of its changes are refused from then —
    # and when it finished (NULL while it is under way: the next pass carries on). Its record
    # stays: this row, its members, its commits and its review.
    pruned_at = Column(Text, nullable=True)
    prune_finished_at = Column(Text, nullable=True)

    __table_args__ = _plain(
        Index("ix_branches_graph", "graph_id"),
        Index("ix_branches_owner", "owner"),
        Index("ix_branches_status", "status"),
        Index("ix_branches_graph_vis", "graph_id", "visibility", "status"),
        CheckConstraint(
            "kind IN ('main','draft','fork_draft')", name="ck_branches_kind"
        ),
        CheckConstraint(
            "status IN ('open','publishing','merged','abandoned')",
            name="ck_branches_status",
        ),
        CheckConstraint(
            "visibility IN ('public','private')", name="ck_branches_visibility"
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
        Index("ix_bm_subject", "subject_type", "subject_id"),
        CheckConstraint(
            "subject_type IN ('user','group')", name="ck_bm_subject_type"
        ),
        CheckConstraint(
            "role IN ('editor','viewer','maintainer')", name="ck_bm_role"
        ),
    )


# Every status a review is stored with (``ck_mr_status``): ``merging`` while a job merges a fork's
# review, handed back when the job ends without landing it. WIDEN-ONLY, as the commit kinds.
MR_STATUSES = ("open", "conflicts", "mergeable", "approved", "merged", "closed", "merging")


class MergeRequestORM(VersioningBase):
    """A PR: draft→main or fork→base. Squash to main is gated by maintainer +
    approval + checks (plan §12.5, §16.5 #6, §17 #5)."""

    __tablename__ = "merge_requests"

    id = Column(Text, primary_key=True, default=lambda: prefixed_id("pr"))
    graph_id = Column(Text, nullable=False)                # logical (source side)
    source_graph_id = Column(Text, nullable=True)          # == target_graph_id ⇒ draft→main MR; NULL ⇒ legacy fork PR
    source_branch_id = Column(Text, nullable=False)
    target_graph_id = Column(Text, nullable=False)
    target_branch = Column(Text, nullable=False, default="main")
    base_commit_seq = Column(BigInteger, nullable=True)
    status = Column(Text, nullable=False, default="open")
    title = Column(Text, nullable=True)                   # human title + description (review UX)
    description = Column(Text, nullable=True)
    conflicts = Column(JSONB, nullable=True)              # field-level conflict set
    resolutions = Column(JSONB, nullable=True)            # who resolved / chosen value
    reviewers = Column(JSONB, nullable=True)
    approved_by = Column(JSONB, nullable=True)
    # {actor: {headCommitId, headSeq, at}}: the source branch's head each approval was of. A
    # content commit after it makes the approval stale (GraphVersioningService._approvals).
    approvals = Column(JSONB, nullable=True)
    approval_status = Column(Text, nullable=True)
    checks_status = Column(JSONB, nullable=True)          # ontology re-validation etc.
    resulting_commit_id = Column(Text, nullable=True)
    actor = Column(Text, nullable=True)                   # who raised it
    created_at = Column(Text, nullable=False, default=_now)   # when raised
    updated_at = Column(Text, nullable=False, default=_now, onupdate=_now)
    merged_at = Column(Text, nullable=True)               # when + who merged
    merged_by = Column(Text, nullable=True)
    merged_via = Column(Text, nullable=True)              # 'review' | 'direct_publish' (see _apply_draft_squash)
    # A fork's review: the fork's head the merge took. Its next review merges from there.
    merged_source_seq = Column(BigInteger, nullable=True)
    closed_at = Column(Text, nullable=True)               # when + who closed (without merging)
    closed_by = Column(Text, nullable=True)

    __table_args__ = _plain(
        Index("ix_mr_graph", "graph_id"),
        Index("ix_mr_source", "source_graph_id"),
        Index("ix_mr_status", "status"),
        # ONE LIVE PR PER SOURCE BRANCH. A PR points at a branch and its diff is computed live from
        # that branch, so commits made after it was raised are already in it — a second PR from the
        # same branch is a duplicate, not a new proposal. Merging either marks the branch `merged`,
        # stranding the sibling as an unmergeable row the UI still shows as actionable. The service
        # pre-check (`_assert_no_live_pr`) produces the friendly error; THIS closes the race where
        # two concurrent opens both pass that check.
        Index(
            "uq_mr_live_source_branch", "source_branch_id", unique=True,
            postgresql_where=text("status NOT IN ('merged','closed')"),
        ),
        CheckConstraint(
            # Existing DBs get 'merging' via migration 20261101_1000_gv_fork_sync and, for a separate
            # GRAPHVER_DB_URL alembic never reaches, _ensure_schema_upgrades.
            "status IN (" + ",".join(f"'{v}'" for v in MR_STATUSES) + ")",
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
    # idle|projecting|rebuilding|evicted, or reseeding: an operator reset the watermark (DR) and
    # the next pass reseeds the key; that pass's claim makes it rebuilding. An evicted graph stays
    # evicted until a load, whatever the Graph residency switch says: waiting_capacity while its
    # master has no room for it, rehydrating while it is loaded (20261030_1300_gv_ps_residency).
    status = Column(Text, nullable=False, default="idle")
    falkor_graph_name = Column(Text, nullable=True)
    falkor_provider = Column(Text, nullable=True)   # FalkorDB instance hosting this cache (per-provider eviction)
    shard_map = Column(JSONB, nullable=True)
    # A moved graph's old platform keys, waiting to be dropped once the new key has caught up:
    # ``[{name, provider, retireAfter, afterSeq, movedBy}]``, NULL when none
    # (``move_projection``; 20261018_1100_gv_ps_retired).
    retired_keys = Column(JSONB, nullable=True)
    # A customer graph's own spelling of its types, where it differs from the declared one:
    # ``{"nodes": {declared: physical}, "edges": {declared: physical}}``, recorded when the enable
    # finishes. The projector writes and matches with it, so a ``:table`` graph never gets a second,
    # ``:Table`` copy of a node. NULL on platform keys and on graphs enabled before it
    # (20261028_1000_gv_ps_unowned).
    physical_types = Column(JSONB, nullable=True)
    # What a pass found in a customer graph that history does not hold, kept rather than deleted:
    # ``{at, nodes, edges, via}``, NULL when nothing. Cleared once it is gone or brought into
    # history (20261028_1000_gv_ps_unowned).
    external_drift = Column(JSONB, nullable=True)
    # When the graph's quarantined entities (``projection_quarantine``) are next retried, NULL
    # when it holds none: what a pass and the poll read, so a graph with nothing held costs no
    # query of the quarantine (20261112_1000_gv_proj_quarantine).
    quarantine_next_at = Column(Text, nullable=True)
    # A lineage-summaries build the projector asked for and did not get: ``{pending, since,
    # asked}``, where ``pending`` says why (``active``: a job was already running, which may have
    # read the graph before the change that asked; ``refused``: a hold, or the service could not
    # be reached). The liveness loop asks again, every GRAPHVER_ROLLUP_REASK_SECS, until one is
    # queued. ``moved``: the summaries already count writes the next full seed brings (it cleared
    # what was held, or a window that moved them escalated), so the full seed that publishes hands
    # them to the job instead of moving them by its difference, and clears it. NULL when nothing
    # is owed (20261112_1200_gv_ps_rollup_state): None is stored as SQL NULL, not JSON ``null``.
    rollup_state = Column(JSONB(none_as_null=True), nullable=True)
    last_projected_at = Column(Text, nullable=True)
    last_error = Column(Text, nullable=True)
    # THE GUARDRAIL. A bootstrapped graph is PINNED to the customer's REAL FalkorDB graph — that
    # pinning is what makes projection a fast-forward instead of a reseed. So "delete the versioned
    # graph" must NEVER mean "delete that FalkorDB graph": it is not ours, it predates us, and it
    # may be shared. We own it IFF WE GENERATED ITS NAME.
    #
    # DEFAULT FALSE, deliberately. The costs are not symmetric: refusing to delete leaks a graph;
    # deleting wrongly destroys a customer's data. A graph we cannot prove we created is a graph
    # we will not delete.
    owns_falkor_graph = Column(Boolean, nullable=False, default=False)
    # Live progress of an in-flight FULL reseed (items applied / total), written
    # throttled by the projector and cleared on completion/failure — drives the
    # Data health rebuild progress bar. NULL when no full seed is running.
    progress_done = Column(BigInteger, nullable=True)
    progress_total = Column(BigInteger, nullable=True)
    # The fencing token. A projection pass claims the row by bumping it and publishes only while it
    # is still its own; evict, rebuild, repin and the bootstrap head flip bump it too, so a pass
    # they overtook never writes over them (20261017_1550_gv_ps_fencing).
    epoch = Column(BigInteger, nullable=False, default=0, server_default=text("0"))
    # Consecutive failed passes, and when the poll may retry (ISO-8601 UTC, like _now()).
    failed_attempts = Column(Integer, nullable=False, default=0, server_default=text("0"))
    next_retry_at = Column(Text, nullable=True)
    # The passes in a row that failed on a timeout or memory refusal the statement ladder could not
    # absorb, which the escalation counts (GRAPHVER_PROJECTION_ESCALATE_AFTER): a pass that ends any
    # other way sets it back to 0 (20261112_1700_gv_ps_pressure).
    pressure_failures = Column(Integer, nullable=False, default=0, server_default=text("0"))
    updated_at = Column(Text, nullable=False, default=_now, onupdate=_now)
    # Residency (20261030_1300_gv_ps_residency). The class a system admin set: ``always`` (never
    # evicted), ``standard`` (evicted when unread for the Standard idle time or under memory
    # pressure, loaded again on the next read) or ``coldline`` (loaded only when a request needs
    # FalkorDB, evicted after the Coldline idle time).
    residency = Column(Text, nullable=False, default="standard", server_default=text("'standard'"))
    # When a person last read the graph (a fork's reads count for its root), flushed by each
    # process once a minute. NULL: never read since the column existed.
    last_read_at = Column(TIMESTAMP(timezone=True), nullable=True)
    # Why it was evicted (idle_standard | idle_coldline | pressure, by the capacity loop; lost:
    # its master lost the key, as liveness found; load_stalled: its load could not tell whether
    # its key needs summaries, its ontology unreadable; admin), NULL while it is resident.
    evicted_reason = Column(Text, nullable=True)
    # The key's measured size in bytes, and when: what evicting it frees and loading it costs.
    size_bytes = Column(BigInteger, nullable=True)
    size_measured_at = Column(TIMESTAMP(timezone=True), nullable=True)
    # When its load in flight started (status ``rehydrating``); NULL once it is done. A load has no
    # timeout, so one that never finishes is told by this.
    rehydrating_since = Column(TIMESTAMP(timezone=True), nullable=True)

    __table_args__ = _plain(
        CheckConstraint(
            "status IN ('idle','projecting','rebuilding','evicted','reseeding','rehydrating',"
            "'waiting_capacity')",
            name="ck_proj_status",
        ),
        CheckConstraint("residency IN ('always','standard','coldline')", name="ck_ps_residency"),
        CheckConstraint(
            "evicted_reason IS NULL OR "
            "evicted_reason IN ('idle_standard','idle_coldline','pressure','lost','admin',"
            "'load_stalled')",
            name="ck_ps_evicted_reason",
        ),
        # One versioned graph per FalkorDB graph: two projecting into one key would each reconcile
        # the other's entities away (``ensure_ps_key_index``; 20261017_1500_gv_ps_keys).
        Index("uq_ps_key", text("coalesce(falkor_provider, 'default')"), "falkor_graph_name",
              unique=True, postgresql_where=text("falkor_graph_name IS NOT NULL")),
    )


# Every job type the code writes. ``ck_jobs_type`` allows these (∪ whatever a DB already holds).
# An import that holds its draft (``uq_jobs_ingest_active``).
_INGEST_ACTIVE = "job_type = 'ingest' AND status IN ('pending','running')"
JOB_TYPES = ("ingest", "projection", "rebuild", "export", "bootstrap", "publish", "purge",
             "package_inspect", "fork_update", "fork_merge")


class ProjectionQuarantineORM(VersioningBase):
    """A projector statement that still failed for one entity on its own, after its retries: held
    here so the rest of its window lands and publishes, instead of the entity failing every pass
    for the whole graph (a dead-letter queue, as a CDC sink keeps one). Each later pass retries the
    graph's rows first, oldest first; a row that lands, or a newer write of the same entity that
    lands, removes it. While a graph holds any, its passes publish unverified.

    ``entity_key`` names the entity as the statement does: a node's urn, or an edge's id with its
    type and ends (``<id>@<type>:<source urn>-><target urn>``). ``cypher`` and ``params`` are the
    statement and its one row, as sent."""

    __tablename__ = "projection_quarantine"

    graph_id = Column(Text, nullable=False)
    statement = Column(Text, nullable=False)          # the statement kind: node_merge, edge_delete…
    entity_key = Column(Text, nullable=False)
    entity_kind = Column(Text, nullable=False)        # node | edge
    cypher = Column(Text, nullable=False)
    params = Column(JSONB, nullable=False)
    error = Column(Text, nullable=True)
    attempts = Column(Integer, nullable=False, default=1)
    first_at = Column(Text, nullable=False, default=_now)
    last_at = Column(Text, nullable=False, default=_now)

    __table_args__ = _plain(
        PrimaryKeyConstraint("graph_id", "statement", "entity_key", name="pk_projection_quarantine"),
        CheckConstraint("entity_kind IN ('node','edge')", name="ck_projection_quarantine_kind"),
    )


class RollupDeltaORM(VersioningBase):
    """A projection window's net lineage-summary deltas, while it has more cells than it nets in
    memory (``GRAPHVER_ROLLUP_NET_MAX_CELLS``): one row per ``:AGGREGATED`` cell the window moves,
    keyed by its ends' urns, with ``dw`` (the cube regime's delta), ``dwc`` (the canonical one's;
    NULL outside canonical mode), the raw types, and the stamps the cell is written with. Each part
    of the window netted in memory adds to its cells here; the pass then applies them a page at a
    time and deletes its rows. Rows a pass did not finish are deleted by the next one that nets
    here, before it starts."""

    __tablename__ = "rollup_deltas"

    graph_id = Column(Text, nullable=False)
    to_seq = Column(BigInteger, nullable=False)
    s = Column(Text, nullable=False)
    t = Column(Text, nullable=False)
    dw = Column(BigInteger, nullable=False, default=0)
    dwc = Column(BigInteger, nullable=True)
    types = Column(JSONB, nullable=False, default=list)
    sd = Column(Integer, nullable=True)
    td = Column(Integer, nullable=True)
    sl = Column(Integer, nullable=True)
    tl = Column(Integer, nullable=True)
    slb = Column(Text, nullable=True)
    tlb = Column(Text, nullable=True)
    dg = Column(Text, nullable=True)

    __table_args__ = _plain(
        PrimaryKeyConstraint("graph_id", "to_seq", "s", "t", name="pk_rollup_deltas"),
    )


class KeyIndexORM(VersioningBase):
    """A property imports match nodes by (``identifier=prop.<name>``) and how far its index
    (``entity_keys``) describes ``main``: ``seq``, a main commit. ``building`` until the first import
    that named it has read every live node; ``ready`` after, and caught up from main's version log
    before each import that uses it."""

    __tablename__ = "key_index"

    graph_id = Column(Text, nullable=False)
    key_name = Column(Text, nullable=False)
    status = Column(Text, nullable=False, default="building")
    seq = Column(BigInteger, nullable=False, default=0)
    # Part-way through the commit after ``seq``, one too large for a page: ``<seq>|<entity id>``, the
    # last of its versions read.
    cursor = Column(Text, nullable=True)
    created_at = Column(Text, nullable=False, default=_now)
    created_by_job = Column(Text, nullable=True)

    __table_args__ = _plain(
        PrimaryKeyConstraint("graph_id", "key_name", name="pk_key_index"),
        CheckConstraint("status IN ('building','ready')", name="ck_key_index_status"),
    )


class EntityKeyORM(VersioningBase):
    """A node of ``main`` holding ``key_value`` in the matching property ``key_name``: what an import
    by ``identifier=prop.<name>`` finds it by. A deleted node keeps its last value, ``live`` false, so
    a row naming it again brings it back under its id. The secondary index reads an entity's own
    entries, which a version of it replaces."""

    __tablename__ = "entity_keys"

    graph_id = Column(Text, nullable=False)
    key_name = Column(Text, nullable=False)
    key_value = Column(Text, nullable=False)
    entity_id = Column(Text, nullable=False)
    live = Column(Boolean, nullable=False, default=True)

    __table_args__ = _plain(
        PrimaryKeyConstraint("graph_id", "key_name", "key_value", "entity_id", name="pk_entity_keys"),
        Index("ix_entity_keys_entity", "graph_id", "key_name", "entity_id"),
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

    # --- Import/Export (bulk CRUD) — plan Phase 0.3 -------------------------- #
    # Full traceability metadata: a job is attributable to workspace/data source/provider/graph.
    data_source_id = Column(Text, nullable=True)          # logical ref (management DB)
    provider_id = Column(Text, nullable=True)             # logical ref (management DB)
    scope_view_id = Column(Text, nullable=True)           # NULL = whole data source
    branch_id = Column(Text, nullable=True)               # the import's draft branch
    reconcile_mode = Column(Text, nullable=True)          # upsert | replace
    identity_strategy = Column(Text, nullable=True)       # auto | entity_id | urn
    # A replace import sent with allowMassDelete: past the replace guard's limits, it deletes all the
    # same (20261112_1400_gv_job_mass_delete).
    allow_mass_delete = Column(Boolean, nullable=True)
    # What an import runs under, as its data source and the platform set it when it was made
    # (``services.import_settings``): where its identifier came from, and the replace guard's limits
    # with where each came from. A resumed job keeps them (20261112_1600_import_settings).
    import_settings = Column(JSONB, nullable=True)
    on_invalid = Column(Text, nullable=True)              # quarantine | auto_fix | reject_all
    import_format = Column(Text, nullable=True)           # ndjson|csv|tsv|xlsx|json|zip
    field_scope = Column(JSONB, nullable=True)            # E4: allow-list of columns to write
    # The request that queued it — ``{actor, apiKeyId, correlationId}`` — bound again where it runs
    # (``provenance.bound``), so its commits and activity events name the key that started it.
    provenance = Column(JSONB, nullable=True)
    auto_publish = Column(Boolean, nullable=False, default=False, server_default=text("false"))
    source_uri = Column(Text, nullable=True)              # uploaded file
    preview_uri = Column(Text, nullable=True)             # full field-level diff artifact
    report_uri = Column(Text, nullable=True)              # rejected/invalid rows report
    result_uri = Column(Text, nullable=True)              # export artifact
    base_commit_seq = Column(BigInteger, nullable=True)   # main head at parse time (OCC)
    preview_digest = Column(Text, nullable=True)
    as_of_seq = Column(BigInteger, nullable=True)         # E5: point-in-time export
    # {new,updated,deleted,unchanged,invalid,auto_fixed} tallies (avoids column sprawl).
    summary = Column(JSONB, nullable=True)

    __table_args__ = _plain(
        Index("ix_jobs_graph_status", "graph_id", "status"),
        Index("ix_jobs_type_status", "job_type", "status"),
        Index("ix_jobs_ds", "data_source_id", "status"),
        Index(
            "ix_jobs_idem_active",
            "graph_id",
            "idempotency_key",
            unique=True,
            postgresql_where=text("idempotency_key IS NOT NULL"),
        ),
        # One import at a time per draft: two would interleave their windows, and a replace
        # among them would delete what the other writes.
        Index(
            "uq_jobs_ingest_active",
            "branch_id",
            unique=True,
            postgresql_where=text(_INGEST_ACTIVE),
        ),
        CheckConstraint(
            "status IN ('pending','running','completed','failed','cancelled')",
            name="ck_jobs_status",
        ),
        CheckConstraint(
            # 'bootstrap' = "enable version control" (bootstrap_worker). Deliberately NOT
            # 'ingest': that is the file-import worker's type, and a worker claims by
            # job_type — sharing one would have the two run each other's jobs. 'publish' = a
            # large draft's publish on the transfer runner; 'purge' = reclaiming a deleted graph
            # (purge_worker); 'package_inspect' = checking an uploaded view package; 'fork_update'
            # and 'fork_merge' = a large Update from parent and a large fork review's merge, on the
            # transfer runner. Existing DBs are widened by migration (20261008_1000_jobs_check_widen,
            # 20261101_1000_gv_fork_sync) and, for a separate GRAPHVER_DB_URL alembic never reaches,
            # by _ensure_schema_upgrades.
            "job_type IN (" + ",".join(f"'{t}'" for t in JOB_TYPES) + ")",
            name="ck_jobs_type",
        ),
    )


class ImportRowORM(VersioningBase):
    """Normalized staging row for an async import (plan Phase 0.2).

    The uploaded file is parsed ONCE into this table (cursor-ordered by ``row_index``), then the
    worker resolves/diffs/builds it onto the draft by streaming keyset scan — resumable across a
    crash and reused by both preview and apply, so re-runs are idempotent. Plain (non-partitioned)
    and GC'd by job after a terminal state (rows are transient, keyed by ``job_id`` not ``graph_id``)."""

    __tablename__ = "import_rows"

    job_id = Column(Text, nullable=False)
    row_index = Column(BigInteger, nullable=False)        # parse-order cursor
    kind = Column(Text, nullable=False)                   # node | edge
    raw = Column(JSONB, nullable=False)                   # normalized (bulk_ingest) row shape
    match_key = Column(Text, nullable=True)               # urn | endpoint-triple | qualifiedName
    matched_entity_id = Column(Text, nullable=True)       # resolved at the resolve phase
    resolved_op = Column(Text, nullable=True)             # create|update|delete|unchanged|invalid
    status = Column(Text, nullable=True)                  # new|updated|unchanged|deleted|invalid|auto_fixed
    reasons = Column(JSONB, nullable=True)                # violations / suggestions
    # Why the row was refused, as a stable code a client acts on (resolve.CODES); the reasons say
    # it in words (20261112_1300_gv_import_row_code).
    code = Column(Text, nullable=True)
    content_hash = Column(Text, nullable=True)            # of the normalized payload
    base_content_hash = Column(Text, nullable=True)       # echoed OCC token from the file

    __table_args__ = _plain(
        PrimaryKeyConstraint("job_id", "row_index", name="pk_import_rows"),
        # A window reads one kind's rows in parse order (``kind`` + ``row_index`` > cursor); the PK
        # alone made it walk the other kind's rows too. (Migration 20261008_1200_import_rows_idx,
        # which also drops the (job, kind, match_key) and (job, status) indexes nothing reads.)
        Index("ix_import_rows_kind_row", "job_id", "kind", "row_index"),
        Index("ix_import_rows_matched", "job_id", "matched_entity_id"),   # a replace's absence check
        CheckConstraint("kind IN ('node','edge')", name="ck_import_rows_kind"),
    )


class BootstrapNodeORM(VersioningBase):
    """One source node seen by an "enable version control" pre-flight (``bootstrap_worker``).

    The pre-flight reads every node's internal id, label, ``urn`` and ``lastSyncedAt`` BEFORE
    anything is copied, so duplicate identifiers are found — and decided — up front instead of
    failing the job after the whole copy. ``copy_rank`` is NULL for a unique urn; for a duplicated
    one it ranks the copies (latest ``last_synced_at``, then lowest ``falkor_id``): 1 is kept, >1 is
    collapsed into it. ``TIMESTAMPTZ``, not text, so the ranking is chronological, not lexical.
    Unique rows are deleted when the job finishes; the duplicate rows stay as its audit list."""

    __tablename__ = "bootstrap_nodes"

    graph_id = Column(Text, nullable=False)
    falkor_id = Column(BigInteger, nullable=False)        # the source node's ID(n)
    urn = Column(Text, nullable=False)
    label = Column(Text, nullable=True)
    last_synced_at = Column(TIMESTAMP(timezone=True), nullable=True)
    copy_rank = Column(Integer, nullable=True)            # a urn may have >32,767 copies

    __table_args__ = _plain(
        PrimaryKeyConstraint("graph_id", "falkor_id", name="pk_bootstrap_nodes"),
        Index("ix_bootstrap_nodes_urn", "graph_id", "urn"),
        Index("ix_bootstrap_nodes_dupes", "graph_id", "urn", "copy_rank",
              postgresql_where=text("copy_rank IS NOT NULL")),
    )


# --------------------------------------------------------------------------- #
# Versioned data (high cardinality, append-only, HASH-partitioned on graph_id) #
# --------------------------------------------------------------------------- #
# Every kind of commit the code writes (``ck_commits_kind``): ``sync_parent`` is a fork's Update
# from parent.
COMMIT_KINDS = ("genesis", "edit", "checkpoint", "squash_publish", "import", "sync", "revert",
                "restore", "pull", "sync_parent")


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
    idempotency_key = Column(Text, nullable=True)         # dedup bulk ingest / client retries
    # Who made it, as the audit trail needs to say (``provenance.commit_provenance``): ``human``,
    # ``service`` (a service account) or ``system``; the API key it was made through; and the
    # request it came from — a job's commits carry the request that queued the job. NULL on
    # commits made before these existed: ``provenance.actor_kind_sql`` derives the kind from
    # ``actor`` for them.
    actor_kind = Column(Text, nullable=True)
    api_key_id = Column(Text, nullable=True)
    correlation_id = Column(Text, nullable=True)

    __table_args__ = _partitioned(
        PrimaryKeyConstraint("graph_id", "id", name="pk_commits"),
        UniqueConstraint(
            "graph_id", "branch_id", "commit_seq", name="uq_commits_branch_seq"
        ),
        Index("ix_commits_seq_brin", "commit_seq", postgresql_using="brin"),
        Index("ix_commits_idem", "graph_id", "idempotency_key"),
        # One commit per key on a branch: two saves sent with one Idempotency-Key land once.
        Index(
            "uq_commits_idem",
            "graph_id",
            "branch_id",
            "idempotency_key",
            unique=True,
            postgresql_where=text("idempotency_key IS NOT NULL"),
        ),
        CheckConstraint(
            # Existing DBs get 'restore' via migration 20260713_1200_restore_kind, 'pull' via
            # 20260714_1600_pull_commit_kind and 'sync_parent' via 20261101_1000_gv_fork_sync
            # (create_all never alters live tables); keep the sets in sync. WIDEN-ONLY: never drop a
            # value from COMMIT_KINDS — a kind already written to a live table would make the
            # constraint unaddable and wedge alembic.
            "kind IN (" + ",".join(f"'{k}'" for k in COMMIT_KINDS) + ")",
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
        Index("ix_nv_urn", "graph_id", "urn"),
        Index("ix_nv_qname", "graph_id", "qualified_name"),     # a windowed import's lookups
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

    Serialized across processes by a transaction-scoped advisory lock: every worker lane pod
    runs this on start, and they start together — two ``create_all``s racing on an empty schema
    both find a table missing and the second CREATE fails.
    """
    eng = engine or get_engine()
    async with eng.begin() as conn:
        await conn.execute(text("SELECT pg_advisory_xact_lock(hashtext('graphver:schema'))"))
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
        await conn.run_sync(_ensure_schema_upgrades)


def _ensure_schema_upgrades(conn) -> None:
    """Bring an EXISTING graphver schema up to what the code writes — the part of the alembic
    chain that touches graphver tables, for a store alembic never reaches.

    With ``GRAPHVER_DB_URL`` pointing at a separate database, alembic migrates only the management
    DB, and ``create_all`` creates missing tables but never alters an existing one's checks or
    indexes. Without this, such a store keeps the CHECK it was born with and rejects every job type
    added since. Each step is idempotent and a no-op once applied, so it runs on every start, in its
    own savepoint (:func:`_bounded_step`). The steps the running code cannot do without (the job
    types it inserts, the columns it maps) are required: one that fails stops the start."""
    _bounded_step(conn, "ck_jobs_type was not widened",
                  lambda: widen_job_type_check(conn, JOB_TYPES), required=True)

    # 20261008_1200_import_rows_idx (``bootstrap_nodes`` is a new table: ``create_all`` makes it).
    def import_rows_indexes() -> None:
        if sa_inspect(conn).has_table("import_rows", schema=_SCHEMA):
            rows = f'"{_SCHEMA}"."import_rows"'
            conn.execute(text(f"CREATE INDEX IF NOT EXISTS ix_import_rows_kind_row ON {rows} "
                              "(job_id, kind, row_index)"))
            conn.execute(text(f'DROP INDEX IF EXISTS "{_SCHEMA}"."ix_import_rows_match"'))
            conn.execute(text(f'DROP INDEX IF EXISTS "{_SCHEMA}"."ix_import_rows_status"'))
    _bounded_step(conn, "the import_rows indexes were not swapped", import_rows_indexes)
    # 20261017_1500_gv_ps_keys. Never strict here: a store holding two live pins on one key starts
    # without the index rather than not at all.
    _bounded_step(conn, "uq_ps_key was not built", lambda: ensure_ps_key_index(conn, strict=False))
    _bounded_step(conn, "projection_state.quarantine_next_at was not added",
                  lambda: ensure_ps_quarantine_column(conn), required=True)
    _bounded_step(conn, "projection_state.rollup_state was not added",
                  lambda: ensure_ps_rollup_state_column(conn), required=True)
    _bounded_step(conn, "projection_state.pressure_failures was not added",
                  lambda: ensure_ps_pressure_failures_column(conn), required=True)
    _bounded_step(conn, "import_rows.code was not added",
                  lambda: ensure_import_rows_code_column(conn), required=True)
    _bounded_step(conn, "jobs.allow_mass_delete was not added",
                  lambda: ensure_jobs_mass_delete_column(conn), required=True)
    _bounded_step(conn, "jobs.import_settings was not added",
                  lambda: ensure_jobs_import_settings_column(conn), required=True)
    # 20261017_1550_gv_ps_fencing.
    _bounded_step(conn, "the projection fencing columns were not added",
                  lambda: ensure_ps_fencing_columns(conn), required=True)
    # 20261017_1900_gv_commits_idem.
    _bounded_step(conn, "uq_commits_idem was not built", lambda: ensure_commits_idem_index(conn))
    # 20261017_1950_gv_ingest_active. Two imports still running on one draft leave the index for a
    # later start.
    _bounded_step(conn, "uq_jobs_ingest_active was not built",
                  lambda: ensure_ingest_active_index(conn, strict=False))
    # 20261017_2000_gv_ps_reseeding.
    _bounded_step(conn, "the reseeding status was not allowed",
                  lambda: ensure_ps_reseeding_status(conn), required=True)
    # 20261018_1000_gv_mr_approvals.
    _bounded_step(conn, "merge_requests.approvals was not added",
                  lambda: ensure_mr_approvals_column(conn), required=True)
    # 20261018_1100_gv_ps_retired.
    _bounded_step(conn, "the retired_keys column was not added",
                  lambda: ensure_ps_retired_keys_column(conn), required=True)
    # 20261018_1200_gv_lifecycle. Every graph read queues behind its lock request: short tries.
    _bounded_step(conn, "the graph lifecycle columns were not added",
                  lambda: ensure_graph_lifecycle_columns(conn), required=True, tries=10)
    # 20261028_1000_gv_ps_unowned.
    _bounded_step(conn, "the customer key columns were not added",
                  lambda: ensure_ps_customer_key_columns(conn), required=True)
    # 20261029_1000_gv_branch_vis. Every draft request reads branches: short tries.
    _bounded_step(conn, "the draft visibility column was not added",
                  lambda: ensure_branch_visibility(conn), required=True, tries=10)
    # 20261030_1000_gv_mr_merged_seq.
    _bounded_step(conn, "merge_requests.merged_source_seq was not added",
                  lambda: ensure_mr_merged_source_seq(conn), required=True)
    # 20261030_1100_gv_fork_bases (``create_all`` makes the table; this fills it in).
    _bounded_step(conn, "the forks' bases were not filled in",
                  lambda: ensure_fork_bases(conn), required=True)
    # 20261030_1300_gv_ps_residency.
    _bounded_step(conn, "the residency columns were not added",
                  lambda: ensure_ps_residency(conn), required=True)
    # 20261101_1000_gv_fork_sync (its job types are the first step's).
    _bounded_step(conn, "sync_parent and merging were not allowed",
                  lambda: ensure_fork_sync_checks(conn), required=True)
    # 20261110_1000_gv_commit_prov. Every save writes commits: short tries.
    _bounded_step(conn, "the commits' provenance columns were not added",
                  lambda: ensure_commit_provenance_columns(conn), required=True, tries=10)
    # 20261111_1000_gv_draft_prune. Every draft request reads branches: short tries.
    _bounded_step(conn, "the closed drafts' prune columns were not added",
                  lambda: ensure_branch_prune_columns(conn), required=True, tries=10)


def _bounded_step(conn, failure: str, step, *, required: bool = False, tries: int = 1) -> None:
    """Run one schema step in a savepoint that waits at most five seconds for a lock, as the
    migrations do (``_bound_lock_wait``): a table a save or a job's heartbeat holds makes the step
    give up rather than queue every later write on the table behind it. Then, or on any other
    failure, the step is rolled back and logged, and the worker starts without it; the next start
    tries again. A ``required`` step's failure is raised instead: the worker exits and its restart
    tries again, rather than run against a schema its code cannot use.

    ``tries`` splits the five seconds into tries of half a second each, for a table every request
    reads: what queues behind the step's lock request then waits at most that long, and goes
    through between tries."""
    for attempt in range(tries):
        try:
            with conn.begin_nested():
                conn.execute(text(f"SET LOCAL lock_timeout = '{'5s' if tries == 1 else '500ms'}'"))
                step()
            return
        except Exception as exc:
            if attempt + 1 < tries and getattr(getattr(exc, "orig", None), "sqlstate", None) == "55P03":
                continue                                 # the lock wait ran out: try again
            logger.exception("%s; the next start tries again", failure)
            if required:
                raise
            return


def ensure_ps_fencing_columns(conn) -> None:
    """Add ``projection_state``'s fencing columns (``epoch``, ``failed_attempts``,
    ``next_retry_at``). A no-op without the table, and once they are there: an ALTER takes the
    table's ACCESS EXCLUSIVE lock even when it adds nothing, and every worker start runs this.
    ``conn`` is a synchronous connection (alembic's bind, or ``run_sync``'s)."""
    inspector = sa_inspect(conn)
    if not inspector.has_table("projection_state", schema=_SCHEMA):
        return                            # create_schema_and_partitions builds it from the models
    present = {c["name"] for c in inspector.get_columns("projection_state", schema=_SCHEMA)}
    if {"epoch", "failed_attempts", "next_retry_at"} <= present:
        return
    ps = f'"{_SCHEMA}"."projection_state"'
    conn.execute(text(f"ALTER TABLE {ps} ADD COLUMN IF NOT EXISTS epoch BIGINT NOT NULL DEFAULT 0"))
    conn.execute(text(
        f"ALTER TABLE {ps} ADD COLUMN IF NOT EXISTS failed_attempts INTEGER NOT NULL DEFAULT 0"))
    conn.execute(text(f"ALTER TABLE {ps} ADD COLUMN IF NOT EXISTS next_retry_at TEXT"))


def ensure_ps_quarantine_column(conn) -> None:
    """Add ``projection_state.quarantine_next_at``: when the graph's quarantined entities are next
    retried, NULL (every existing graph) when it holds none. Nullable with no default, so nothing
    is rewritten. A no-op without the table, and once it is there: an ALTER takes the table's
    ACCESS EXCLUSIVE lock even when it adds nothing, and every worker start runs this. ``conn`` is
    a synchronous connection (alembic's bind, or ``run_sync``'s)."""
    inspector = sa_inspect(conn)
    if not inspector.has_table("projection_state", schema=_SCHEMA):
        return                            # create_schema_and_partitions builds it from the models
    if "quarantine_next_at" in {c["name"] for c in inspector.get_columns("projection_state",
                                                                         schema=_SCHEMA)}:
        return
    conn.execute(text(f'ALTER TABLE "{_SCHEMA}"."projection_state" '
                      "ADD COLUMN IF NOT EXISTS quarantine_next_at TEXT"))


def ensure_jobs_mass_delete_column(conn) -> None:
    """Add ``jobs.allow_mass_delete``: a replace import that may delete past the replace guard's
    limits, NULL (every job made before) when not. Nullable with no default, so nothing is
    rewritten; a no-op without the table and once the column is there."""
    inspector = sa_inspect(conn)
    if not inspector.has_table("jobs", schema=_SCHEMA):
        return
    if "allow_mass_delete" in {c["name"] for c in inspector.get_columns("jobs", schema=_SCHEMA)}:
        return
    conn.execute(text(f'ALTER TABLE "{_SCHEMA}"."jobs" ADD COLUMN IF NOT EXISTS allow_mass_delete BOOLEAN'))


def ensure_jobs_import_settings_column(conn) -> None:
    """Add ``jobs.import_settings``: what an import runs under, as resolved when it was made; NULL
    (every job made before) runs under the platform's. Nullable with no default, so nothing is
    rewritten; a no-op without the table and once the column is there."""
    inspector = sa_inspect(conn)
    if not inspector.has_table("jobs", schema=_SCHEMA):
        return
    if "import_settings" in {c["name"] for c in inspector.get_columns("jobs", schema=_SCHEMA)}:
        return
    conn.execute(text(f'ALTER TABLE "{_SCHEMA}"."jobs" ADD COLUMN IF NOT EXISTS import_settings JSONB'))


def ensure_import_rows_code_column(conn) -> None:
    """Add ``import_rows.code``: why a staged row was refused, as a stable code, NULL for every row
    staged before. Nullable with no default, so nothing is rewritten; a no-op without the table and
    once the column is there."""
    inspector = sa_inspect(conn)
    if not inspector.has_table("import_rows", schema=_SCHEMA):
        return
    if "code" in {c["name"] for c in inspector.get_columns("import_rows", schema=_SCHEMA)}:
        return
    conn.execute(text(f'ALTER TABLE "{_SCHEMA}"."import_rows" ADD COLUMN IF NOT EXISTS code TEXT'))


def ensure_ps_rollup_state_column(conn) -> None:
    """Add ``projection_state.rollup_state``: a lineage-summaries build the projector asked for
    and did not get, NULL (every existing graph) when nothing is owed. Nullable with no default,
    so nothing is rewritten; a no-op without the table and once the column is there, like
    :func:`ensure_ps_quarantine_column`."""
    inspector = sa_inspect(conn)
    if not inspector.has_table("projection_state", schema=_SCHEMA):
        return
    if "rollup_state" in {c["name"] for c in inspector.get_columns("projection_state",
                                                                   schema=_SCHEMA)}:
        return
    conn.execute(text(f'ALTER TABLE "{_SCHEMA}"."projection_state" '
                      "ADD COLUMN IF NOT EXISTS rollup_state JSONB"))


def ensure_ps_pressure_failures_column(conn) -> None:
    """Add ``projection_state.pressure_failures``: the passes in a row that failed under pressure,
    0 for every existing graph. Its default is a constant, which Postgres keeps in the catalog, so
    nothing is rewritten; a no-op without the table and once the column is there, like
    :func:`ensure_ps_quarantine_column`."""
    inspector = sa_inspect(conn)
    if not inspector.has_table("projection_state", schema=_SCHEMA):
        return
    if "pressure_failures" in {c["name"] for c in inspector.get_columns("projection_state",
                                                                        schema=_SCHEMA)}:
        return
    conn.execute(text(f'ALTER TABLE "{_SCHEMA}"."projection_state" '
                      "ADD COLUMN IF NOT EXISTS pressure_failures INTEGER NOT NULL DEFAULT 0"))


def ensure_ps_reseeding_status(conn) -> None:
    """Let ``ck_proj_status`` allow ``reseeding``. A no-op without the table, and once it does:
    rebuilding the check takes the table's ACCESS EXCLUSIVE lock, and every worker start runs
    this. ``conn`` is a synchronous connection (alembic's bind, or ``run_sync``'s)."""
    if not sa_inspect(conn).has_table("projection_state", schema=_SCHEMA):
        return                            # create_schema_and_partitions builds it from the models
    ps = f'"{_SCHEMA}"."projection_state"'
    current = conn.execute(text(
        "SELECT pg_get_constraintdef(oid) FROM pg_constraint "
        "WHERE conname = 'ck_proj_status' AND conrelid = CAST(:ps AS regclass)"),
        {"ps": ps}).scalar()
    if current is not None and "'reseeding'" in current:
        return
    conn.execute(text(f"ALTER TABLE {ps} DROP CONSTRAINT IF EXISTS ck_proj_status"))
    conn.execute(text(
        f"ALTER TABLE {ps} ADD CONSTRAINT ck_proj_status "
        "CHECK (status IN ('idle','projecting','rebuilding','evicted','reseeding'))"))


def ensure_ps_retired_keys_column(conn) -> None:
    """Add ``projection_state.retired_keys``, a moved graph's old keys. A no-op without the table,
    and once it is there (an ALTER takes the table's ACCESS EXCLUSIVE lock even when it adds
    nothing). ``conn`` is a synchronous connection (alembic's bind, or ``run_sync``'s)."""
    inspector = sa_inspect(conn)
    if not inspector.has_table("projection_state", schema=_SCHEMA):
        return                            # create_schema_and_partitions builds it from the models
    if "retired_keys" in {c["name"] for c in inspector.get_columns("projection_state",
                                                                    schema=_SCHEMA)}:
        return
    conn.execute(text(
        f'ALTER TABLE "{_SCHEMA}"."projection_state" ADD COLUMN IF NOT EXISTS retired_keys JSONB'))


def ensure_ps_customer_key_columns(conn) -> None:
    """Add ``projection_state.physical_types`` and ``external_drift``, a customer graph's own
    spelling of its types and what was written to it outside history. A no-op without the table,
    and once they are there (an ALTER takes the table's ACCESS EXCLUSIVE lock even when it adds
    nothing). ``conn`` is a synchronous connection (alembic's bind, or ``run_sync``'s)."""
    inspector = sa_inspect(conn)
    if not inspector.has_table("projection_state", schema=_SCHEMA):
        return                            # create_schema_and_partitions builds it from the models
    present = {c["name"] for c in inspector.get_columns("projection_state", schema=_SCHEMA)}
    if {"physical_types", "external_drift"} <= present:
        return
    ps = f'"{_SCHEMA}"."projection_state"'
    conn.execute(text(f"ALTER TABLE {ps} ADD COLUMN IF NOT EXISTS physical_types JSONB"))
    conn.execute(text(f"ALTER TABLE {ps} ADD COLUMN IF NOT EXISTS external_drift JSONB"))


def ensure_branch_visibility(conn) -> None:
    """Add ``branches.visibility`` (public or private), its check and the listing index, and the
    index that finds a person's or group's drafts among ``branch_members``. Every existing draft
    reads private and ``main`` public. A member row left on a draft that isn't shared granted
    nothing, and would grant access from now on, so it is deleted; a draft marked shared with no
    member left is unmarked, so ``is_shared`` means "has members". A no-op without the table, and
    once it is all there (an ALTER takes the table's ACCESS EXCLUSIVE lock even when it adds
    nothing). ``conn`` is a synchronous connection (alembic's bind, or ``run_sync``'s)."""
    inspector = sa_inspect(conn)
    if not inspector.has_table("branches", schema=_SCHEMA):
        return                            # create_schema_and_partitions builds it from the models
    has_members = inspector.has_table("branch_members", schema=_SCHEMA)
    present = {c["name"] for c in inspector.get_columns("branches", schema=_SCHEMA)}
    indexed = {i["name"] for i in inspector.get_indexes("branches", schema=_SCHEMA)}
    if has_members:
        indexed |= {i["name"] for i in inspector.get_indexes("branch_members", schema=_SCHEMA)}
    if "visibility" in present and "ix_branches_graph_vis" in indexed and (
            not has_members or "ix_bm_subject" in indexed):
        return
    branches = f'"{_SCHEMA}"."branches"'
    members = f'"{_SCHEMA}"."branch_members"'
    if "visibility" not in present:
        conn.execute(text(
            f"ALTER TABLE {branches} ADD COLUMN IF NOT EXISTS visibility TEXT NOT NULL DEFAULT 'private'"))
        conn.execute(text(f"ALTER TABLE {branches} DROP CONSTRAINT IF EXISTS ck_branches_visibility"))
        conn.execute(text(f"ALTER TABLE {branches} ADD CONSTRAINT ck_branches_visibility "
                          "CHECK (visibility IN ('public','private'))"))
        conn.execute(text(f"UPDATE {branches} SET visibility = 'public' WHERE kind = 'main'"))
        if has_members:
            left = conn.execute(text(
                f"DELETE FROM {members} m USING {branches} b "
                "WHERE b.id = m.branch_id AND NOT b.is_shared")).rowcount
            if left:
                logger.warning("%d member row(s) left on drafts that weren't shared were deleted: "
                               "they granted nothing", left)
            conn.execute(text(
                f"UPDATE {branches} b SET is_shared = false WHERE b.is_shared "
                f"AND NOT EXISTS (SELECT 1 FROM {members} m WHERE m.branch_id = b.id)"))
    conn.execute(text(
        f"CREATE INDEX IF NOT EXISTS ix_branches_graph_vis ON {branches} (graph_id, visibility, status)"))
    if has_members:
        conn.execute(text(
            f"CREATE INDEX IF NOT EXISTS ix_bm_subject ON {members} (subject_type, subject_id)"))


def ensure_mr_approvals_column(conn) -> None:
    """Add ``merge_requests.approvals``, the head each approval was of. A no-op without the table,
    and once it is there (an ALTER takes the table's ACCESS EXCLUSIVE lock even when it adds
    nothing). ``conn`` is a synchronous connection (alembic's bind, or ``run_sync``'s)."""
    inspector = sa_inspect(conn)
    if not inspector.has_table("merge_requests", schema=_SCHEMA):
        return                            # create_schema_and_partitions builds it from the models
    if "approvals" in {c["name"] for c in inspector.get_columns("merge_requests", schema=_SCHEMA)}:
        return
    conn.execute(text(f'ALTER TABLE "{_SCHEMA}"."merge_requests" ADD COLUMN IF NOT EXISTS approvals JSONB'))


#: ``commits``' provenance columns (``20261110_1000_gv_commit_prov``): nullable, so adding one is a
#: catalog change with no rewrite of any partition.
COMMIT_PROVENANCE_COLUMNS = ("actor_kind", "api_key_id", "correlation_id")


def ensure_commit_provenance_columns(conn) -> None:
    """Add ``commits.actor_kind``, ``api_key_id`` and ``correlation_id`` — who made a commit, with
    which API key, in which request — and ``jobs.provenance``, the request that queued a job. The
    commits' columns go on the partitioned parent, which adds them to every partition; all are
    nullable with no default, so nothing is rewritten. Nothing is backfilled: a commit from before
    reads its kind from its actor (``provenance.actor_kind_sql``), and its key and request were
    never recorded. A no-op without the tables, and once the columns are there (an ALTER takes the
    table's ACCESS EXCLUSIVE lock even when it adds nothing). ``conn`` is a synchronous connection
    (alembic's bind, or ``run_sync``'s)."""
    inspector = sa_inspect(conn)
    if inspector.has_table("commits", schema=_SCHEMA):
        have = {c["name"] for c in inspector.get_columns("commits", schema=_SCHEMA)}
        missing = [c for c in COMMIT_PROVENANCE_COLUMNS if c not in have]
        if missing:
            conn.execute(text(f'ALTER TABLE "{_SCHEMA}"."commits" '
                              + ", ".join(f"ADD COLUMN IF NOT EXISTS {c} TEXT" for c in missing)))
    if inspector.has_table("jobs", schema=_SCHEMA) and "provenance" not in {
            c["name"] for c in inspector.get_columns("jobs", schema=_SCHEMA)}:
        conn.execute(text(f'ALTER TABLE "{_SCHEMA}"."jobs" ADD COLUMN IF NOT EXISTS provenance JSONB'))


#: ``branches``' columns for a closed draft whose changes were removed
#: (``20261111_1000_gv_draft_prune``): nullable, so adding them is a catalog change.
BRANCH_PRUNE_COLUMNS = ("pruned_at", "prune_finished_at")


def ensure_branch_prune_columns(conn) -> None:
    """Add ``branches.pruned_at`` and ``prune_finished_at``: when the removal of a closed draft's
    changes began, and when it finished. Nullable text with no default, so nothing is
    rewritten, and every existing draft reads as never pruned. A no-op without the table, and once
    the columns are there (an ALTER takes the table's ACCESS EXCLUSIVE lock even when it adds
    nothing). ``conn`` is a synchronous connection (alembic's bind, or ``run_sync``'s)."""
    inspector = sa_inspect(conn)
    if not inspector.has_table("branches", schema=_SCHEMA):
        return                            # create_schema_and_partitions builds it from the models
    have = {c["name"] for c in inspector.get_columns("branches", schema=_SCHEMA)}
    missing = [c for c in BRANCH_PRUNE_COLUMNS if c not in have]
    if missing:
        conn.execute(text(f'ALTER TABLE "{_SCHEMA}"."branches" '
                          + ", ".join(f"ADD COLUMN IF NOT EXISTS {c} TEXT" for c in missing)))


def ensure_mr_merged_source_seq(conn) -> None:
    """Add ``merge_requests.merged_source_seq``, the fork's head a merged review of a fork took, and
    fill it in for the forks' reviews merged before it existed: the latest of the fork's commits
    their squash names. A no-op without the table, and once it is there (an ALTER takes the table's
    ACCESS EXCLUSIVE lock even when it adds nothing). ``conn`` is a synchronous connection
    (alembic's bind, or ``run_sync``'s)."""
    inspector = sa_inspect(conn)
    if not inspector.has_table("merge_requests", schema=_SCHEMA):
        return                            # create_schema_and_partitions builds it from the models
    if "merged_source_seq" in {c["name"] for c in inspector.get_columns("merge_requests", schema=_SCHEMA)}:
        return
    mrs, commits = f'"{_SCHEMA}"."merge_requests"', f'"{_SCHEMA}"."commits"'
    conn.execute(text(f"ALTER TABLE {mrs} ADD COLUMN IF NOT EXISTS merged_source_seq BIGINT"))
    conn.execute(text(
        f"UPDATE {mrs} mr SET merged_source_seq = ("
        f"SELECT max(c.commit_seq) FROM {commits} sq JOIN {commits} c ON c.graph_id = mr.graph_id "
        "AND c.id IN (SELECT jsonb_array_elements_text(sq.source_commit_ids)) "
        "WHERE sq.graph_id = mr.target_graph_id AND sq.id = mr.resulting_commit_id "
        "AND jsonb_typeof(sq.source_commit_ids) = 'array') "
        "WHERE mr.status = 'merged' AND mr.resulting_commit_id IS NOT NULL "
        "AND mr.graph_id <> mr.target_graph_id"))


def ensure_fork_bases(conn) -> None:
    """Create ``fork_bases``, the parent seq a fork reads from each fork seq on, and give every fork
    with a fork point and no row its first: ``(fork, fork_base_commit_seq, fork_base_commit_seq)``,
    as a fork's genesis commit sits at its fork point. A fork with no fork point keeps none, and
    reads its parent at genesis as before. Safe to re-run: a fork that has a row is left alone, and
    the table is created only when missing (creating it locks ``graphs`` for its foreign key).
    ``conn`` is a synchronous connection (alembic's bind, or ``run_sync``'s)."""
    inspector = sa_inspect(conn)
    if not inspector.has_table("graphs", schema=_SCHEMA):
        return                            # create_schema_and_partitions builds it from the models
    graphs, bases = f'"{_SCHEMA}"."graphs"', f'"{_SCHEMA}"."fork_bases"'
    if not inspector.has_table("fork_bases", schema=_SCHEMA):
        conn.execute(text(
            f"CREATE TABLE IF NOT EXISTS {bases} ("
            f"fork_graph_id TEXT NOT NULL REFERENCES {graphs} (id) ON DELETE CASCADE, "
            "fork_seq BIGINT NOT NULL, parent_seq BIGINT NOT NULL, "
            "created_at TIMESTAMPTZ NOT NULL DEFAULT now(), created_by TEXT, "
            "CONSTRAINT pk_fork_bases PRIMARY KEY (fork_graph_id, fork_seq))"))
    filled = conn.execute(text(
        f"INSERT INTO {bases} (fork_graph_id, fork_seq, parent_seq, created_by) "
        f"SELECT g.id, g.fork_base_commit_seq, g.fork_base_commit_seq, g.created_by FROM {graphs} g "
        "WHERE g.fork_parent_graph_id IS NOT NULL AND g.fork_base_commit_seq IS NOT NULL "
        f"AND NOT EXISTS (SELECT 1 FROM {bases} b WHERE b.fork_graph_id = g.id) "
        "ON CONFLICT DO NOTHING")).rowcount
    if filled:
        logger.info("fork_bases: gave %d fork(s) their fork point", filled)


def ensure_ps_residency(conn) -> None:
    """Add ``projection_state``'s residency columns (``residency``, Standard for every graph,
    ``last_read_at``, ``evicted_reason``, ``size_bytes``, ``size_measured_at``,
    ``rehydrating_since``) with the checks on
    the class and the reason, and let ``ck_proj_status`` allow ``rehydrating`` and
    ``waiting_capacity``. A no-op without the table, and once it is all there: an ALTER takes the
    table's ACCESS EXCLUSIVE lock even when it adds nothing, and every worker start runs this.
    ``conn`` is a synchronous connection (alembic's bind, or ``run_sync``'s)."""
    inspector = sa_inspect(conn)
    if not inspector.has_table("projection_state", schema=_SCHEMA):
        return                            # create_schema_and_partitions builds it from the models
    ps = f'"{_SCHEMA}"."projection_state"'
    present = {c["name"] for c in inspector.get_columns("projection_state", schema=_SCHEMA)}
    checks = dict(conn.execute(text(
        "SELECT conname, pg_get_constraintdef(oid) FROM pg_constraint "
        "WHERE conrelid = CAST(:ps AS regclass) AND contype = 'c'"), {"ps": ps}).all())
    columns = {"residency", "last_read_at", "evicted_reason", "size_bytes", "size_measured_at",
               "rehydrating_since"}
    widened = "'waiting_capacity'" in (checks.get("ck_proj_status") or "")
    reasons = "'load_stalled'" in (checks.get("ck_ps_evicted_reason") or "")
    if columns <= present and widened and reasons and "ck_ps_residency" in checks:
        return
    conn.execute(text(
        f"ALTER TABLE {ps} ADD COLUMN IF NOT EXISTS residency TEXT NOT NULL DEFAULT 'standard'"))
    conn.execute(text(f"ALTER TABLE {ps} ADD COLUMN IF NOT EXISTS last_read_at TIMESTAMPTZ"))
    conn.execute(text(f"ALTER TABLE {ps} ADD COLUMN IF NOT EXISTS evicted_reason TEXT"))
    conn.execute(text(f"ALTER TABLE {ps} ADD COLUMN IF NOT EXISTS size_bytes BIGINT"))
    conn.execute(text(f"ALTER TABLE {ps} ADD COLUMN IF NOT EXISTS size_measured_at TIMESTAMPTZ"))
    conn.execute(text(f"ALTER TABLE {ps} ADD COLUMN IF NOT EXISTS rehydrating_since TIMESTAMPTZ"))
    conn.execute(text(f"ALTER TABLE {ps} DROP CONSTRAINT IF EXISTS ck_ps_residency"))
    conn.execute(text(f"ALTER TABLE {ps} ADD CONSTRAINT ck_ps_residency "
                      "CHECK (residency IN ('always','standard','coldline'))"))
    conn.execute(text(f"ALTER TABLE {ps} DROP CONSTRAINT IF EXISTS ck_ps_evicted_reason"))
    conn.execute(text(
        f"ALTER TABLE {ps} ADD CONSTRAINT ck_ps_evicted_reason CHECK (evicted_reason IS NULL OR "
        "evicted_reason IN ('idle_standard','idle_coldline','pressure','lost','admin',"
        "'load_stalled'))"))
    if not widened:
        conn.execute(text(f"ALTER TABLE {ps} DROP CONSTRAINT IF EXISTS ck_proj_status"))
        conn.execute(text(
            f"ALTER TABLE {ps} ADD CONSTRAINT ck_proj_status CHECK (status IN ('idle','projecting',"
            "'rebuilding','evicted','reseeding','rehydrating','waiting_capacity'))"))


def ensure_fork_sync_checks(conn) -> None:
    """Let ``ck_commits_kind`` allow ``sync_parent`` (a fork's Update from parent) and
    ``ck_mr_status`` allow ``merging`` (a fork's review a job is merging). WIDEN-ONLY: each check
    becomes what this code writes ∪ what it allows now. One is rebuilt only while it does not allow
    its value yet: rebuilding takes the table's ACCESS EXCLUSIVE lock and checks every row again,
    and every worker start runs this. A no-op without the tables. ``conn`` is a synchronous
    connection (alembic's bind, or ``run_sync``'s)."""
    inspector = sa_inspect(conn)
    for table, name, column, values, new in (
            ("commits", "ck_commits_kind", "kind", COMMIT_KINDS, "sync_parent"),
            ("merge_requests", "ck_mr_status", "status", MR_STATUSES, "merging")):
        if not inspector.has_table(table, schema=_SCHEMA):
            continue                      # create_schema_and_partitions builds it from the models
        qualified = f'"{_SCHEMA}"."{table}"'
        current = conn.execute(text(
            "SELECT pg_get_constraintdef(oid) FROM pg_constraint "
            "WHERE conname = :name AND conrelid = CAST(:t AS regclass)"),
            {"name": name, "t": qualified}).scalar()
        if current is not None and f"'{new}'" in current:
            continue
        allowed = set(values) | set(re.findall(r"'([^']*)'", current or ""))
        conn.execute(text(f"ALTER TABLE {qualified} DROP CONSTRAINT IF EXISTS {name}"))
        conn.execute(text(
            f"ALTER TABLE {qualified} ADD CONSTRAINT {name} CHECK ({column} IN ("
            + ", ".join(f"'{v}'" for v in sorted(allowed)) + "))"))


def ensure_graph_lifecycle_columns(conn) -> None:
    """Add ``graphs.lifecycle_state``, ``lifecycle_rev`` and ``lifecycle_changed_at``, and the check
    that stores only live or frozen. A no-op without the table, and once they are there (an ALTER
    takes the table's ACCESS EXCLUSIVE lock even when it adds nothing). Every existing graph reads
    live at rev 0: none was frozen before the columns existed. ``conn`` is a synchronous
    connection (alembic's bind, or ``run_sync``'s)."""
    inspector = sa_inspect(conn)
    if not inspector.has_table("graphs", schema=_SCHEMA):
        return                            # create_schema_and_partitions builds it from the models
    present = {c["name"] for c in inspector.get_columns("graphs", schema=_SCHEMA)}
    if {"lifecycle_state", "lifecycle_rev", "lifecycle_changed_at"} <= present:
        return
    graphs = f'"{_SCHEMA}"."graphs"'
    conn.execute(text(
        f"ALTER TABLE {graphs} ADD COLUMN IF NOT EXISTS lifecycle_state TEXT NOT NULL DEFAULT 'live'"))
    conn.execute(text(
        f"ALTER TABLE {graphs} ADD COLUMN IF NOT EXISTS lifecycle_rev BIGINT NOT NULL DEFAULT 0"))
    conn.execute(text(f"ALTER TABLE {graphs} ADD COLUMN IF NOT EXISTS lifecycle_changed_at TEXT"))
    conn.execute(text(f"ALTER TABLE {graphs} DROP CONSTRAINT IF EXISTS ck_graphs_lifecycle_state"))
    conn.execute(text(f"ALTER TABLE {graphs} ADD CONSTRAINT ck_graphs_lifecycle_state "
                      "CHECK (lifecycle_state IN ('live','frozen'))"))


def ensure_ps_key_index(conn, *, strict: bool) -> None:
    """Build ``uq_ps_key``: one versioned graph per FalkorDB graph (provider, name).

    First, a tombstoned graph that does not own the key lets go of a key another graph also pins
    (its pin is cleared and logged; a restore does not bring it back). Pins still shared after that
    belong to live or owned graphs, which corrupt each other's projection and must be resolved by
    hand: ``strict`` (the migration) raises, naming them; otherwise (every worker start) the error
    is logged and the index left unbuilt. A no-op once the index exists. ``conn`` is a synchronous
    connection (alembic's bind, or ``run_sync``'s)."""
    if not sa_inspect(conn).has_table("projection_state", schema=_SCHEMA):
        # A database installed at head has no graphver schema until create_schema_and_partitions
        # creates it, and that builds the index from the models.
        return
    if conn.execute(text("SELECT 1 FROM pg_indexes WHERE schemaname = :s AND indexname = 'uq_ps_key'"),
                    {"s": _SCHEMA}).first():
        return
    ps, graphs = f'"{_SCHEMA}"."projection_state"', f'"{_SCHEMA}"."graphs"'
    released = conn.execute(text(
        f"UPDATE {ps} p SET falkor_graph_name = NULL FROM {graphs} g "
        "WHERE g.id = p.graph_id AND g.deleted_at IS NOT NULL AND NOT p.owns_falkor_graph "
        "AND p.falkor_graph_name IS NOT NULL "
        f"AND EXISTS (SELECT 1 FROM {ps} o WHERE o.graph_id <> p.graph_id "
        "AND o.falkor_graph_name = p.falkor_graph_name "
        "AND coalesce(o.falkor_provider, 'default') = coalesce(p.falkor_provider, 'default')) "
        "RETURNING p.graph_id, p.falkor_graph_name")).all()
    for graph_id, name in released:
        logger.warning("uq_ps_key: released FalkorDB graph %s from tombstoned graph %s", name, graph_id)
    shared = conn.execute(text(
        f"SELECT coalesce(falkor_provider, 'default'), falkor_graph_name, "
        f"array_agg(graph_id ORDER BY graph_id) FROM {ps} WHERE falkor_graph_name IS NOT NULL "
        "GROUP BY 1, 2 HAVING count(*) > 1")).all()
    if shared:
        message = ("versioned graphs share a FalkorDB graph, so uq_ps_key cannot be built; clear "
                   "projection_state.falkor_graph_name on all but one of each: " + "; ".join(
                       f"{provider}/{name}: {', '.join(ids)}" for provider, name, ids in shared))
        if strict:
            raise RuntimeError(message)
        logger.error(message)
        return
    conn.execute(text(
        f"CREATE UNIQUE INDEX IF NOT EXISTS uq_ps_key ON {ps} "
        "(coalesce(falkor_provider, 'default'), falkor_graph_name) "
        "WHERE falkor_graph_name IS NOT NULL"))


def ensure_commits_idem_index(conn) -> None:
    """Build ``uq_commits_idem``: one commit per idempotency key on a branch, so a save retried
    with its key lands once. A later commit sharing its key with an earlier one on the branch
    (bulk, sync and bootstrap look before they insert, so two could race in) has the key cleared
    first; every lookup returns one row anyway. A no-op once the index exists: on the partitioned
    ``commits`` even ``CREATE INDEX IF NOT EXISTS`` locks every partition, and every worker start
    runs this. ``conn`` is a synchronous connection (alembic's bind, or ``run_sync``'s)."""
    if not sa_inspect(conn).has_table("commits", schema=_SCHEMA):
        return                            # create_schema_and_partitions builds it from the models
    if conn.execute(text("SELECT to_regclass(:i)"), {"i": f'"{_SCHEMA}".uq_commits_idem'}).scalar():
        return
    commits = f'"{_SCHEMA}"."commits"'
    cleared = conn.execute(text(
        f"UPDATE {commits} c SET idempotency_key = NULL FROM ("
        "SELECT graph_id, id, row_number() OVER (PARTITION BY graph_id, branch_id, idempotency_key "
        f"ORDER BY commit_seq) AS rn FROM {commits} WHERE idempotency_key IS NOT NULL) d "
        "WHERE c.graph_id = d.graph_id AND c.id = d.id AND d.rn > 1")).rowcount
    if cleared:
        logger.warning("uq_commits_idem: cleared the repeated idempotency key of %d commits", cleared)
    conn.execute(text(
        f"CREATE UNIQUE INDEX IF NOT EXISTS uq_commits_idem ON {commits} "
        "(graph_id, branch_id, idempotency_key) WHERE idempotency_key IS NOT NULL"))


def ensure_ingest_active_index(conn, *, strict: bool) -> None:
    """Build ``uq_jobs_ingest_active``: one import pending or running per draft. First, as the
    transfer lane's JobReaper would, the imports nothing will run are failed (never queued for
    ``JOB_NEVER_QUEUED_SECS``, or queued past ``TRANSFER_QUEUE_TIMEOUT_SECS``); then, of the
    imports left on one draft, the first (a running one first) keeps it and a later one that never
    started is failed. Imports that still share a draft have started, and are never failed here:
    ``strict`` (the migration) raises naming them; otherwise the build waits for a later start.
    A no-op once the index exists. ``conn`` is a synchronous connection (alembic's bind, or
    ``run_sync``'s)."""
    if not sa_inspect(conn).has_table("jobs", schema=_SCHEMA):
        return                            # create_schema_and_partitions builds it from the models
    if conn.execute(text("SELECT to_regclass(:i)"), {"i": f'"{_SCHEMA}".uq_jobs_ingest_active'}).scalar():
        return
    jobs = f'"{_SCHEMA}"."jobs"'
    now = datetime.now(timezone.utc)

    def fail(where: str, message: str, **params) -> int:
        return conn.execute(text(
            f"UPDATE {jobs} j SET status = 'failed', error_message = :msg, completed_at = :now, "
            f"updated_at = :now {where}"), {"msg": message, "now": now.isoformat(), **params}).rowcount

    pending = "j.job_type = 'ingest' AND j.status = 'pending'"
    reaped = fail(f"WHERE {pending} AND j.current_phase = 'queued' AND j.updated_at < :cut",
                  config.JOB_NOT_STARTED,
                  cut=(now - timedelta(seconds=config.TRANSFER_QUEUE_TIMEOUT_SECS)).isoformat())
    reaped += fail(f"WHERE {pending} AND j.current_phase IS NULL AND j.created_at < :cut",
                   config.JOB_NEVER_QUEUED,
                   cut=(now - timedelta(seconds=config.JOB_NEVER_QUEUED_SECS)).isoformat())
    stacked = fail(
        f"FROM (SELECT id, row_number() OVER (PARTITION BY branch_id ORDER BY status = 'running' "
        f"DESC, created_at) AS rn FROM {jobs} WHERE branch_id IS NOT NULL AND {_INGEST_ACTIVE}) d "
        f"WHERE j.id = d.id AND d.rn > 1 AND {pending} AND j.started_at IS NULL",
        "Another import was already running on this draft. Start this one again when it has finished.")
    if reaped or stacked:
        logger.warning("uq_jobs_ingest_active: failed %d import(s) nothing would run and %d queued "
                       "behind another on its draft", reaped, stacked)
    shared = conn.execute(text(
        f"SELECT branch_id, string_agg(id, ', ' ORDER BY created_at) FROM {jobs} "
        f"WHERE branch_id IS NOT NULL AND {_INGEST_ACTIVE} GROUP BY branch_id HAVING count(*) > 1")).all()
    if shared:
        message = ("uq_jobs_ingest_active: imports running together on one draft ("
                   + "; ".join(f"{branch}: {ids}" for branch, ids in shared)
                   + "). Let them finish, or fail the stale ones, then run this again.")
        if strict:
            raise RuntimeError(message)
        logger.warning("%s The next start tries again.", message)
        return
    conn.execute(text(
        f"CREATE UNIQUE INDEX IF NOT EXISTS uq_jobs_ingest_active ON {jobs} (branch_id) "
        f"WHERE {_INGEST_ACTIVE}"))


def widen_job_type_check(conn, required) -> None:
    """Make ``ck_jobs_type`` allow ``required`` ∪ every type already in the table. WIDEN-ONLY.

    ``graphver.jobs`` is shared by several producers, and a CHECK rebuilt from a hard-coded list
    has wedged alembic on it before: a type some row already holds makes the narrower constraint
    unaddable. So the domain can only grow, and can never fail on rows already there — the
    migrations' downgrades widen too and delete nothing. When the constraint already allows every
    type it is left alone: rebuilding it takes an ACCESS EXCLUSIVE lock and re-validates the table,
    which every worker start would otherwise do. ``conn`` is a synchronous connection (alembic's
    bind, or ``run_sync``'s)."""
    if not sa_inspect(conn).has_table("jobs", schema=_SCHEMA):
        # A database installed at head has no graphver schema until create_schema_and_partitions
        # creates it, and that builds the constraint from the models.
        return
    jobs = f'"{_SCHEMA}"."jobs"'

    def quoted(types):
        return ["'" + t.replace("'", "''") + "'" for t in sorted(types)]

    current = conn.execute(text(
        "SELECT pg_get_constraintdef(oid) FROM pg_constraint "
        "WHERE conname = 'ck_jobs_type' AND conrelid = CAST(:jobs AS regclass)"),
        {"jobs": jobs}).scalar()
    if current is not None and all(q in current for q in quoted(required)):
        return                            # the rows there already satisfy it
    present = {row[0] for row in conn.execute(text(f"SELECT DISTINCT job_type FROM {jobs}"))
               if row[0]}
    allowed = ", ".join(quoted(set(required) | present))
    conn.execute(text(f"ALTER TABLE {jobs} DROP CONSTRAINT IF EXISTS ck_jobs_type"))
    conn.execute(text(
        f"ALTER TABLE {jobs} ADD CONSTRAINT ck_jobs_type CHECK (job_type IN ({allowed}))"))
