"""Async, resumable, integrity-validated "enable version control" bootstrap.

Turning on version control for a data source that already holds data means copying
its ENTIRE provider graph into the versioned store. The old path did that inline in
the HTTP request: it paged the whole graph into one Python list (OFFSET pagination),
then wrote it in ONE transaction. That is fine at 10k entities and fatal at 10M —
the request times out, the web tier's memory is O(graph), and the user gets a
spinner with no idea whether anything survived.

This module replaces it with a job:

  [reset →] counting [⏸ decision] → nodes → edges → validate → heads → merkle → backfill
  → finalize → done

**Duplicates are decided before anything is copied.** `counting` is a PRE-FLIGHT: one narrow
pass (internal id, label, `urn`, `lastSyncedAt` — no payloads) into `bootstrap_nodes`. Two source
nodes sharing a urn cannot both become one versioned entity, and finding that out at validation,
after copying the whole graph, failed the job with no list of which urns collided. Now the job
pauses there (`awaiting_decision`) with the full, ranked list; a manager either collapses each urn
to one copy — the latest `lastSyncedAt`, then the lowest internal id — or gives up. A decision is
bound to the list's FINGERPRINT, so it can only ever apply to the list the manager was shown, and
the copy after it starts by running the pre-flight again: the same list carries on, a list the
waiting changed pauses again.

**Bounded memory.** The source is scanned in ID-RANGE windows (never OFFSET — deep
offsets re-scan and go quadratic) and written in per-window transactions, so peak
memory is O(window), not O(graph).

**Resumable.** Each window commits its rows, tallies, and its cursor in ONE
transaction, so a crash rewinds to the last committed window exactly. Version rows
carry DETERMINISTIC ids (hash of commit+entity) and insert ON CONFLICT DO NOTHING,
so replaying a window is a no-op. A `running` job whose heartbeat goes stale is
taken over by another worker — and the window's job-row write is a compare-and-set on
the worker's lease (``job_lease``), so a worker that lost the job rolls its window back
instead of writing beside the new owner.

**Invisible until proven.** The import commit is written at seq 2 while the graph's
head stays at genesis (seq 1). Every read path composes state bounded by
`main_head_commit_seq`, so a partial — or failed — ingest is invisible: the data
source simply reads as "not versioned yet". Validation therefore runs BEFORE
`entity_heads` is populated and long before the head flip: if it fails, there is
nothing to unwind and nothing to see.

**Proven, not assumed.** Validation compares the source's own counts (the same
helpers the projection reconciler uses) against what actually landed, per node label
and per edge type — that is the containment/lineage-preservation proof — asserts no
entity was dropped, and re-reads a random sample of entities from the SOURCE to
compare content hashes against the stored payloads. The full report is persisted on
the job and rendered in the UI.

**No reseed.** The versioned graph is pinned to the SOURCE FalkorDB graph the canvas
already reads, and validation has just proved the two agree — so finalize
fast-forwards the projection watermark instead of dropping and rewriting 10M
entities (which would also wipe the `:AGGREGATED` rollups and force an hours-long
re-aggregation). The one thing the projector needs that a raw source graph may lack
is the delete-anchoring keys (`n.entityId`, `r.id`); `backfill` adds them in place,
additively — and it runs BEFORE `finalize`, so the graph is never live without them. After a
collapse, `backfill` also makes the source graph match the copy: each discarded copy's edges move
to the copy that was kept, and the discarded copy is deleted.

`finalize` is the last step and the one that makes the copy live: until it runs the data source
is simply un-versioned, and abandoning the job leaves it as it was — with one exception the
decision states up front: copies a collapse has already deleted from the source graph are not
restored.
"""
from __future__ import annotations

import asyncio
import base64
import csv
import inspect
import io
import json
import logging
import random
import time
from dataclasses import dataclass
from datetime import datetime, timezone
from hashlib import blake2b
from typing import Any, AsyncIterator, Dict, List, Optional, Set, Tuple

from sqlalchemy import func, select, text
from sqlalchemy.dialects.postgresql import insert as pg_insert
from sqlalchemy.exc import IntegrityError

from . import config, db, job_lease
from .falkor_indexes import ensure_urn_indexes
from .job_lease import AWAITING_DECISION, Draining, Lease, Superseded
from .job_lease import friendly_infra_error as _friendly_infra_error
from .job_lease import is_transient as _is_transient
from .merkle import content_hash
from .merkle_store import MerkleStore
from .models import (
    BootstrapNodeORM,
    BranchORM,
    CommitORM,
    EdgeVersionORM,
    GraphORM,
    JobORM,
    NodeVersionORM,
    ProjectionStateORM,
    _now,
)
from .projection import _q, _READ_TIMEOUT_MS, _WRITE_TIMEOUT_MS
from .purge_worker import create_purge_job, delete_window
from .service import (
    ConcurrencyError,
    GraphVersioningService,
    _chunks,
    _rows_per_insert,
    _sanitize_node_properties,
)

logger = logging.getLogger(__name__)

# The job's own type. NOT 'ingest' — that belongs to the FILE-import worker
# (``import_export/service.py``). A worker claims work by ``job_type``, so sharing one
# would have each worker pick up the other's jobs and run them through the wrong phase
# machine. Keeping the claim sets disjoint by construction is the whole point.
BOOTSTRAP_JOB_TYPE = "bootstrap"

# Phase order. `last_cursor` is prefixed with the phase it belongs to, so a resume
# re-enters exactly where it stopped.
#
# `finalize` is LAST for a reason: it is the single irreversible step (it flips the head,
# which makes the graph live and writable). Everything that the live graph depends on must
# already be true when it runs — including `backfill`, which stamps the projector's
# delete/update anchors (`n.entityId`, `r.id`) onto the source graph. Finalizing first and
# backfilling after would leave a window (and, if backfill then failed, a permanent state)
# where the graph is editable but the projector cannot anchor: an edit would MERGE a
# DUPLICATE node beside the original, and a delete would match nothing and silently leave
# the entity on the canvas.
#
# `reset` is first and only ever entered by a restart (:func:`retry_bootstrap`): a new job
# starts at `counting`, with nothing to throw away.
PHASES = ("reset", "counting", "nodes", "edges", "validate", "heads", "merkle", "backfill",
          "finalize")

# Percent shown to the user. Scanning dominates the wall clock, so it owns the bulk
# of the bar; the tail phases are bounded work with honest, distinct labels.
_PHASE_FLOOR = {"reset": 0, "counting": 0, "nodes": 2, "edges": 2, "validate": 72,
                "heads": 76, "merkle": 88, "backfill": 92, "finalize": 98}
_SCAN_SPAN = 70          # nodes+edges occupy 2%..72%

# What a restart throws away before re-reading the source: the import commit's version rows
# and Merkle tree, main's entity heads and the pre-flight's view of the source — as (table, its
# PK, which rows), each deleted in PK-ordered windows like a purge's (see purge_worker). The commit
# itself stays: the re-read writes into it.
_RESET = (
    ("node_versions", "graph_id, id", "commit_id = :c"),
    ("edge_versions", "graph_id, id", "commit_id = :c"),
    ("merkle_nodes", "graph_id, commit_id, path", "commit_id = :c"),
    ("entity_heads", "graph_id, branch_id, entity_id", "branch_id = :b"),
    ("bootstrap_nodes", "graph_id, falkor_id", ""),
)

# What a person can do about a failed job, by its failure code: an INTEGRITY failure (the copy
# didn't match the source) only fails the same way again unless the source is re-read; an
# INFRASTRUCTURE one resumes where it stopped; an internal one is a bug — no action fixes it.
_FAILURE_ACTIONS = {"integrity": "restart", "infrastructure": "resume"}

# What a job IS survives a restart — who asked, and (for a package seed) what to copy where.
# What it FOUND does not: tallies, report and failure. Two things it DID do: the decision about
# duplicates (`duplicatePolicy`) — the new read applies it only if it finds the very list it was
# made on (the fingerprint), so keeping it is safe and spares a second decision on an identical
# list — and `sourceCollapse`, the mark that copies were removed from the source graph: nothing
# puts them back, so a restart must not forget it (the rollups still need rebuilding, and Give up
# must not promise an untouched source).
_KEPT_ON_RESTART = ("actor", "origin", "package", "ontology", "target", "duplicatePolicy",
                    "sourceCollapse")

# Which copy of a duplicated urn a collapse keeps — the ranking `_rank_duplicates_sql` applies: the
# one synced most recently (an unparseable or missing `lastSyncedAt` ranks last), then the lowest
# internal id, so a tie still has exactly one, repeatable winner.
DUPLICATE_RULE = "lastSyncedAt desc, internalId asc"

# A phase runner's answer when the job has stopped to wait for a person (see `_finish_preflight`):
# not "done", not "more to do" — the job row is already pending again, and nothing more is written.
_PAUSED = "paused"

# A query that returns PROPERTIES is capped at this many rows: the FalkorDB client parses its
# reply on the job's event loop, and a 100k-row payload reply is seconds of loop stall for every
# other job on the worker. (The pre-flight's narrow scan carries no properties and is not capped.)
_PROPS_ROWS_CAP = 20_000

# Duplicate copies re-pointed and deleted per backfill window (`backfill:dupes`).
_DUPES_WINDOW = 1000


# --------------------------------------------------------------------------- #
# Source scan (FalkorDB)                                                       #
#                                                                              #
# WHAT COUNTS AS "THE GRAPH": exactly what the application itself can see.     #
# The reader (`falkordb_provider._node_from_props` / `_edge_from_row`) drops a #
# node with no `urn` and any edge whose endpoints have none — such entities do #
# not render, search, or trace: they are not part of the user's graph. Copying #
# is scoped the same way, so "we copied everything" means the same thing to the#
# job as it does to the canvas. They are still COUNTED and surfaced in the      #
# report (never silently ignored).                                             #
#                                                                              #
# Derived/system artifacts are excluded outright: the `:AGGREGATED` rollup      #
# layer and its bookkeeping markers are the projector's and the aggregation     #
# worker's own output, not source data — importing them would make the graph    #
# own its own cache.                                                            #
# --------------------------------------------------------------------------- #
_DERIVED_LABELS = config.DERIVED_LABELS
_not_derived = config.not_derived_clause


def _has_urn(var: str) -> str:
    """A node the reader can see: it has a urn, and not an empty one — the reader's own rule
    (`_node_from_props`: no urn, no node). Held to everywhere a node is counted, ranked, copied or
    collapsed, so an empty urn is never a duplicated identifier nobody can ever copy."""
    return f"{var}.urn IS NOT NULL AND {var}.urn <> ''"


# EVERYTHING is anchored on a NODE id range — including the edges.
#
# The obvious way to window edges is `WHERE ID(r) >= $lo AND ID(r) < $hi`, and it is a
# trap: FalkorDB cannot seek an edge-id range, so every window re-scans the entire edge
# set and the phase goes quadratic. (Measured on a 6.2M-edge graph: ~230 edges/sec and
# falling, then a scan timeout.) Anchoring on the SOURCE NODE instead walks each node's
# adjacency list — what a graph database is actually for — and every edge is still
# emitted exactly once, by its source. It also means both phases share one cursor space,
# so `edges:<lo>` and `nodes:<lo>` mean the same thing.
#
# A NODE id range IS a seek: `GRAPH.EXPLAIN` on FalkorDB 4.18 plans every windowed statement below
# — the ANDed `ID(n) >= $lo AND ID(n) < $hi AND …` filters included — as a `NodeByIdSeek`, so a
# window costs its own size, not a scan of the graph (pinned by the live test
# `test_bootstrap_falkor_live.py`). The one full scan left is `max(ID(n))` itself, so it is read
# ONCE, by the pre-flight, and every later window uses the cached `summary.source.maxNodeId`.
_MAX_NODE_ID = "MATCH (n) RETURN max(ID(n))"
_COUNT_NODES = f"MATCH (n) WHERE {_has_urn('n')} AND {_not_derived('n')} RETURN count(n)"
# How many edges a node-id window actually holds — cheap (no properties materialized), and
# the only reliable way to size an edge window (see config.BOOTSTRAP_EDGE_TARGET).
_COUNT_EDGES_IN_WINDOW = (
    "MATCH (a) WHERE ID(a) >= $lo AND ID(a) < $hi "
    "MATCH (a)-[r]->() WHERE type(r) <> 'AGGREGATED' RETURN count(r)"
)
# The pre-flight. NARROW on purpose — no `properties()` — so a 100k-id window is a few MB, and the
# whole source is read in seconds before anything is copied. Derived nodes are dropped in Python;
# a node with no urn is counted as invisible (never rendered, never copied, but reported).
_PREFLIGHT_NODES = ("MATCH (n) WHERE ID(n) >= $lo AND ID(n) < $hi "
                    "RETURN ID(n), labels(n), n.urn, n.lastSyncedAt")
# The window's edges, split by whether the reader can see them (both ends carry a urn): the
# denominator the copy is checked against, replacing four unwindowed full-graph counts.
_PREFLIGHT_EDGES = ("MATCH (a) WHERE ID(a) >= $lo AND ID(a) < $hi "
                    "MATCH (a)-[r]->(b) WHERE type(r) <> 'AGGREGATED' "
                    f"RETURN {_has_urn('a')} AND {_has_urn('b')}, count(r)")

# The internal ids ride along: the node scan skips a collapsed copy by (id, urn, label), and the
# edge scan tells a collapse self-loop (two copies of one urn) from a genuine one (one node).
_SCAN_NODES = (
    f"MATCH (n) WHERE ID(n) >= $lo AND ID(n) < $hi AND {_has_urn('n')} AND {_not_derived('n')} "
    "RETURN ID(n), labels(n), properties(n)"
)
_SCAN_EDGES = (
    f"MATCH (a) WHERE ID(a) >= $lo AND ID(a) < $hi AND {_has_urn('a')} AND {_not_derived('a')} "
    f"MATCH (a)-[r]->(b) WHERE type(r) <> 'AGGREGATED' AND {_has_urn('b')} "
    "RETURN ID(a), ID(b), a.urn, b.urn, type(r), properties(r)"
)
_SCANS = {"preflight": _PREFLIGHT_NODES, "nodes": _SCAN_NODES, "edges": _SCAN_EDGES}
_SAMPLE_NODES = "UNWIND $urns AS u MATCH (n {urn: u}) RETURN ID(n), labels(n), properties(n)"
# Backfill: additive, idempotent, and scoped to the same entities we copied. Each says how many
# keys it set: a window with nothing left to stamp (any graph the platform wrote) held no write
# lock worth pausing after.
_BACKFILL_NODES = (
    f"MATCH (n) WHERE ID(n) >= $lo AND ID(n) < $hi AND {_not_derived('n')} "
    "AND n.entityId IS NULL AND n.urn IS NOT NULL "
    "SET n.entityId = n.urn RETURN count(n)"
)
_BACKFILL_EDGES = (
    f"MATCH (a) WHERE ID(a) >= $lo AND ID(a) < $hi AND a.urn IS NOT NULL AND {_not_derived('a')} "
    "MATCH (a)-[r]->(b) WHERE type(r) <> 'AGGREGATED' AND r.id IS NULL AND b.urn IS NOT NULL "
    "SET r.id = a.urn + '|' + type(r) + '|' + b.urn RETURN count(r)"
)
# How many writes `_BACKFILL_EDGES` would make in a window — what its width is fitted by.
_COUNT_BACKFILL_EDGES = (
    f"MATCH (a) WHERE ID(a) >= $lo AND ID(a) < $hi AND a.urn IS NOT NULL AND {_not_derived('a')} "
    "MATCH (a)-[r]->(b) WHERE type(r) <> 'AGGREGATED' AND r.id IS NULL AND b.urn IS NOT NULL "
    "RETURN count(r)"
)


def _q_label(label: str) -> str:
    """A source label as a cypher identifier — the source's own spelling, backticked, because only
    that spelling seeks its urn index."""
    return "`" + str(label).replace("`", "``") + "`"


def _copy(var: str, label: Optional[str], urn: str = "row.urn") -> str:
    """One copy of a duplicated urn, as a pattern: by label + urn — an index seek. (A node with no
    label has no index to seek; it is matched by urn alone.)"""
    return f"({var}:{_q_label(label)} {{urn: {urn}}})" if label else f"({var} {{urn: {urn}}})"


# The duplicate collapse in the SOURCE graph (`backfill:dupes`). Every copy is reached by its
# label + urn — an index seek — and only THEN checked against its internal id: a discarded copy and
# the one kept share both label and urn, and FalkorDB re-uses a deleted node's id, so neither alone
# names one node. Never `UNWIND … MATCH (n) WHERE ID(n) = x`: FalkorDB does not drive that from a
# NodeByIdSeek, and it degrades to a full node scan PER ROW (see falkordb_materialize).
def _dupe_edges_cypher(label: Optional[str], direction: str) -> str:
    """A discarded copy's relationships, one direction: (copy id, other end's id, type, id-less)."""
    rel = "(l)-[r]->(o)" if direction == "out" else "(o)-[r]->(l)"
    return (f"UNWIND $rows AS row MATCH {_copy('l', label)} WHERE ID(l) = row.lid "
            f"MATCH {rel} WHERE type(r) <> 'AGGREGATED' RETURN ID(l), ID(o), type(r), r.id IS NULL")


def _dupe_repoint_cypher(label: Optional[str], kept_label: Optional[str], rel_type: str,
                         direction: str, keyed: bool) -> str:
    """Move a discarded copy's relationships of one type and direction onto the copy kept.

    The other end is reached THROUGH the relationship, never by a seek, so it may be anything — a
    node with no urn included. One whose urn is this copy's own is skipped: a relationship between
    two copies of one urn is a collapse self-loop (dropped, as the copy drops it — by urn, so the
    rows carry no list of the urn's copies, which for a urn with thousands of them made every row
    as long as that list), and a genuine one is `_dupe_self_loop_cypher`'s. Keyed by ``r.id`` (which the anchors step set on every relationship
    between two urns), so a re-run MERGEs onto what the first run created, and two relationships
    with distinct ids stay two — one per Postgres edge row. Without a key (an end with no urn) it
    MERGEs on (type, endpoints), as the reader would see it. If the other end is itself a discarded
    copy, it is moved when that copy is: each step moves only its own end, so the order the copies
    are handled in does not matter."""
    t = _q_label(rel_type)
    rel = f"(l)-[r:{t}]->(o)" if direction == "out" else f"(o)-[r:{t}]->(l)"
    key = " {id: r.id}" if keyed else ""
    new = f"(w)-[n:{t}{key}]->(o)" if direction == "out" else f"(o)-[n:{t}{key}]->(w)"
    return (f"UNWIND $rows AS row MATCH {_copy('l', label)} WHERE ID(l) = row.lid "
            f"MATCH {_copy('w', kept_label)} WHERE ID(w) = row.wid "
            f"MATCH {rel} WHERE r.id IS {'NOT ' if keyed else ''}NULL "
            "AND coalesce(o.urn, '') <> row.urn "
            f"MERGE {new} ON CREATE SET n = properties(r) RETURN count(n)")


def _dupe_self_loop_cypher(label: Optional[str], kept_label: Optional[str], rel_type: str) -> str:
    """A discarded copy's GENUINE self-loop (one node, pointing at itself) becomes the kept copy's."""
    t = _q_label(rel_type)
    return (f"UNWIND $rows AS row MATCH {_copy('l', label)} WHERE ID(l) = row.lid "
            f"MATCH {_copy('w', kept_label)} WHERE ID(w) = row.wid "
            f"MATCH (l)-[r:{t}]->(l) MERGE (w)-[n:{t} {{id: r.id}}]->(w) "
            "ON CREATE SET n = properties(r) RETURN count(n)")


def _dupe_delete_cypher(label: Optional[str]) -> str:
    return (f"UNWIND $rows AS row MATCH {_copy('l', label)} WHERE ID(l) = row.lid "
            "DETACH DELETE l RETURN count(row)")


def _vid(prefix: str, commit_id: str, entity_id: str) -> str:
    """Deterministic version-row id, so replaying a window after a crash collides
    with the row it already wrote (ON CONFLICT DO NOTHING) instead of duplicating it."""
    return prefix + blake2b(f"{commit_id}:{entity_id}".encode(), digest_size=12).hexdigest()


def _label_of(labels) -> Optional[str]:
    for lab in labels or []:
        if lab != "_GVRollupMeta":
            return lab
    return None


class _Reservoir:
    """Uniform sample of K items over a stream of unknown length, checkpointed with
    the job (so a resume keeps sampling correctly across the whole scan)."""

    def __init__(self, k: int, items: Optional[List[str]] = None, seen: int = 0):
        self.k, self.items, self.seen = k, list(items or []), int(seen)

    def offer(self, item: str) -> None:
        self.seen += 1
        if len(self.items) < self.k:
            self.items.append(item)
            return
        j = random.randint(1, self.seen)
        if j <= self.k:
            self.items[j - 1] = item


@dataclass
class _RunContext:
    """What every window of one run reads and nothing in the run changes — read once per run (per
    lease) instead of per window: a 10M-entity copy is thousands of windows, and the ontology rules
    alone are a management-DB round trip each."""
    commit_id: str
    commit_seq: int
    main_id: str
    falkor_graph_name: Optional[str]
    falkor_provider: Optional[str]
    actor: str
    rules: Any = None
    rules_loaded: bool = False
    dupe_indexes_ready: bool = False


@dataclass
class _Window:
    """One scan window, converted: the rows to insert, and what happened to every scanned row."""
    dicts: List[dict]
    scanned: Dict[str, int]                      # per label / type, before anything is dropped
    collapsed: Dict[str, int]                    # nodes: copies a duplicate decision collapsed
    rejects: dict
    meta: Dict[str, Tuple[str, int]]             # nodes: entity id → (source label, internal id)
    self_loops: int = 0                          # edges: between two copies of one urn
    dupes: int = 0                               # edges: same id twice in the window


class BootstrapRunner:
    """Executes bootstrap (`job_type='bootstrap'`) jobs. Hosted by the versioning worker's
    bootstrap lane, on the job lease (``job_lease``)."""

    def __init__(self, graph_factory, *, session_factory=None, consumer: str = "boot-1",
                 on_rollups_stale=None):
        self._factory = graph_factory
        self._session = session_factory or db.graphver_session
        self._consumer = consumer
        self._svc = GraphVersioningService()
        self._merkle = MerkleStore()
        self._logged: Dict[str, float] = {}  # job_id → last progress log (see _due)
        # Queues the rebuild of a graph's :AGGREGATED rollups (the projector's hook): a collapse
        # deleted nodes they were computed over.
        self._on_rollups_stale = on_rollups_stale
        self._contexts: Dict[Tuple[str, int], _RunContext] = {}

    # ---------------------------------------------------------------- infra --
    async def _client(self, ctx):
        c = self._factory(ctx.falkor_graph_name, ctx.falkor_provider)
        if inspect.isawaitable(c):
            c = await c
        return c

    async def _ctx(self, lease: Lease, graph_id: str) -> _RunContext:
        key = (lease.job_id, lease.epoch)
        ctx = self._contexts.get(key)
        if ctx is None:
            async with self._session() as s:
                job = await s.get(JobORM, lease.job_id)
                ps = await s.get(ProjectionStateORM, graph_id)
                commit = await self._import_commit(s, graph_id)
                main_id = await self._main_branch_id(s, graph_id)
            ctx = _RunContext(
                commit_id=commit.id, commit_seq=commit.commit_seq, main_id=main_id,
                falkor_graph_name=ps.falkor_graph_name if ps else None,
                falkor_provider=ps.falkor_provider if ps else None,
                actor=str(((job.summary if job else None) or {}).get("actor") or "system"))
            self._contexts[key] = ctx
        return ctx

    async def _rules(self, lease: Lease, ctx: _RunContext):
        if not ctx.rules_loaded:
            ctx.rules, ctx.rules_loaded = await _ontology_rules(lease.job_id), True
        return ctx.rules

    async def claim_one(self) -> Optional[Lease]:
        """Claim a pending job, or take over one whose worker looks dead (stale heartbeat).

        `JobORM` IS the durable queue — no second Redis stream to keep alive. Every claim is a
        new EPOCH (``job_lease.claim``), so the previous owner — which may be slow rather than
        dead, e.g. stuck in a long scan retry — finds out at its next write that it no longer
        holds the job, and stops instead of double-writing. A job paused for a person's decision
        is never claimed, and at most ``BOOTSTRAP_PER_PROVIDER`` jobs of one origin copy from one
        FalkorDB provider at once: every window is a scan of the source, and the canvases reading
        from that provider must not queue behind a wall of them.
        """
        return await job_lease.claim(self._session, job_lease.BOOTSTRAP_TYPES,
                                     phase_pred=job_lease.BOOTSTRAP_READY,
                                     provider_cap=config.BOOTSTRAP_PER_PROVIDER, lane="bootstrap")

    # ---------------------------------------------------------------- driver --
    async def run_job(self, lease: Lease) -> Dict[str, object]:
        """Drive a claimed job to a terminal state — or to a pause, when the pre-flight found
        duplicate identifiers nobody has decided about. Each phase is individually
        resumable; a raised error marks the job failed with a plain-language reason
        and leaves everything it wrote intact (a retry resumes from the cursor).

        Every write to the job row is fenced on ``lease``: a worker that lost the job — taken
        over, or abandoned by the user — finds out at its next write, which rolls back, and
        stops. The lease is checked between units of work, so a stopping worker hands the job
        back there (pending, cursor kept) for another worker to resume."""
        job_id = lease.job_id
        try:
            while True:
                lease.check()
                async with self._session() as s:
                    job = await s.get(JobORM, job_id)
                    if job is None or job.status != "running" or job.retry_count != lease.epoch:
                        raise Superseded("the job was abandoned or taken over")
                    phase, cursor = job.current_phase or "counting", job.last_cursor
                    graph_id = job.graph_id
                runner = getattr(self, f"_phase_{phase}")
                done = await self._run_phase(lease, runner, graph_id, phase)
                if done == _PAUSED:
                    # The pre-flight already put the job back to pending, waiting for a person —
                    # it holds no slot while it waits, and a decision re-queues it.
                    logger.info("bootstrap %s paused: duplicate identifiers await a decision "
                                "(graph=%s)", job_id, graph_id)
                    return {"job_id": job_id, "status": "paused"}
                if not done:
                    continue                                   # same phase, next window
                nxt = _next_phase(phase)
                if nxt is None:
                    if not await lease.finish("completed", current_phase=None, progress=100):
                        raise Superseded("the job was abandoned or taken over")
                    logger.info("bootstrap %s completed (graph=%s)", job_id, graph_id)
                    return {"job_id": job_id, "status": "completed"}
                async with self._session() as s:
                    # Compare-and-set: still ours, and still where this phase ended.
                    await lease.checkpoint(s, expect_cursor=cursor)
                    _advance_phase(await s.get(JobORM, job_id), nxt)
        except Superseded as exc:
            # Not an error: someone else owns this job now (a takeover, or the user
            # abandoned it). Our last write rolled back; stop quietly.
            logger.info("bootstrap %s handed off: %s", job_id, exc)
            return {"job_id": job_id, "status": "superseded"}
        except (Draining, asyncio.CancelledError) as exc:
            # The worker is stopping: hand the job back so another resumes it from its cursor.
            # Shielded — the release must land even as this task is cancelled.
            try:
                await asyncio.shield(lease.release())
            except Exception:  # noqa: BLE001 — unreleased, it goes stale and is taken over
                logger.exception("releasing bootstrap %s failed", job_id)
            if isinstance(exc, asyncio.CancelledError):
                raise
            return {"job_id": job_id, "status": "released"}
        except BootstrapFailure as exc:
            await self._fail(lease, exc.reason, exc.code)
            return {"job_id": job_id, "status": "failed", "error": exc.reason}
        except Exception as exc:                                   # pragma: no cover - infra
            logger.exception("bootstrap %s crashed", job_id)
            await self._fail(lease, _friendly_infra_error(exc), "infrastructure")
            return {"job_id": job_id, "status": "failed"}
        finally:
            self._contexts.pop((job_id, lease.epoch), None)

    async def _run_phase(self, lease: Lease, runner, graph_id: str, phase: str) -> bool:
        """Run one unit of a phase, waiting out transient infrastructure faults.

        Copying a 10M-entity graph takes tens of minutes — long enough to span a FalkorDB
        restart, a Postgres failover, a node rotation or a network blip. None of those may
        destroy a job that is most of the way done, so the worker RETRIES them with backoff
        instead of failing. What makes that safe is the window transaction: a window's rows,
        tallies and cursor commit together, so re-entering a phase runner either re-scans a
        window that rolled back (clean) or reads a cursor that already moved past one that
        landed (also clean). It can neither double-write nor mistake a replay for a duplicate.

        A fresh client is built per attempt, so a retry never reuses a dead connection.
        The budget is per unit of work — a successful window resets it — so it bounds how
        long an OUTAGE may last, not how long the job may take. Past it the job fails
        honestly and stays resumable from its cursor; nothing is lost either way. (The
        mechanics are ``Lease.retry_transient``; an integrity failure is never retried, and
        neither is a lost lease or a stopping worker.)
        """
        return await lease.retry_transient(
            lambda: runner(lease, graph_id), never=(BootstrapFailure,),
            on_retry=lambda exc: self._note_interruption(lease, phase, exc))

    async def _note_interruption(self, lease: Lease, phase: str, exc: Exception) -> None:
        """Record the outage on the job.

        The count is surfaced in the report, so "we hit turbulence and rode it out" is
        something the user is TOLD, not something we quietly paper over. Best-effort by
        design — if Postgres is the thing that is down, there is nothing to write and nothing
        to be done about it. (Staying alive through the outage is the LeaseKeeper's job.)
        """
        try:
            async with self._session() as s:
                job = await s.get(JobORM, lease.job_id)
                if job is None:
                    return
                summary = dict(job.summary or {})
                seen = list(summary.get("interruptions") or [])
                seen.append({"phase": phase, "error": type(exc).__name__, "at": _now()})
                summary["interruptions"] = seen[-20:]        # a tail, not a log
                await lease.checkpoint(s, summary=summary)
        except Superseded:
            raise                                            # not ours any more: stop waiting
        except Exception:                                    # pragma: no cover - infra
            logger.debug("bootstrap %s: could not record the interruption", lease.job_id)

    async def _fail(self, lease: Lease, reason: str, code: str) -> None:
        """Fail the job, fenced, recording ``summary.failure = {code, action, phase, reason}``:
        the action is what the UI offers (``_FAILURE_ACTIONS``). A job that is no longer ours is
        its owner's to record."""
        if not await lease.fail(reason, code, _FAILURE_ACTIONS.get(code)):
            logger.info("bootstrap %s: not failed — it is no longer this worker's", lease.job_id)
            return
        async with self._session() as s:
            job = await s.get(JobORM, lease.job_id)
        # An integrity failure (duplicate urns, dangling edges) raises BootstrapFailure,
        # which is CAUGHT — so without this line the most important event this worker can
        # report would be written to a table and to nothing else. Carry the identifiers an
        # on-call actually greps by; the job id alone means a Postgres round-trip.
        logger.error(
            "bootstrap %s FAILED in %s [%s]: %s (graph=%s data_source=%s workspace=%s "
            "cursor=%s processed=%s/%s)",
            lease.job_id, job.current_phase, code, reason, job.graph_id, job.data_source_id,
            job.workspace_id, job.last_cursor, job.processed, job.total)

    # ---------------------------------------------------------------- phases --
    async def _phase_reset(self, lease: Lease, graph_id: str) -> bool:
        """Throw away what an earlier run imported, so a restart re-reads the source from scratch.

        Restart used to do this inside the HTTP request: one DELETE per table over a whole
        commit — millions of rows in one transaction, under a request timeout. Here it is a
        phase, in purge-sized windows (:func:`purge_worker.delete_window`), each its own fenced
        transaction. ``reset:<n>`` names the table in hand (``_RESET``); DELETE is idempotent, so
        a window replayed after a crash just deletes whatever is still there."""
        ctx = await self._ctx(lease, graph_id)
        async with self._session() as s:
            job = await s.get(JobORM, lease.job_id)
            at = job.last_cursor
            step = int(at.split(":")[1]) if at else 0
            if step >= len(_RESET):
                return True
            table, pk, rows = _RESET[step]
            deleted = await delete_window(s, table, pk, graph_id, where=rows,
                                          params={"c": ctx.commit_id, "b": ctx.main_id})
            await lease.checkpoint(s, expect_cursor=at, progress=_PHASE_FLOOR["reset"],
                                   last_cursor=at if deleted else f"reset:{step + 1}")
        return False

    async def _phase_counting(self, lease: Lease, graph_id: str):
        """The PRE-FLIGHT: read the whole source, narrowly, before anything is copied.

        Window by window (``counting:<lo>``, the copy's own node-id space), each source node's
        internal id, label, urn and `lastSyncedAt` go into ``bootstrap_nodes``, and the window's
        node and edge counts are added to ``summary.source`` — the denominator every later check
        compares against (and the progress bar's total), counted with the SAME predicates the scan
        uses, so "scanned == source" is a meaningful statement. A window's rows, its tallies and
        its cursor commit together, so a crash rewinds all three to the last window that landed;
        a window read again (a resume, or a re-check after the source changed) first deletes what
        the last read of its id range left.

        The first call reads ``max(ID(n))`` — the run's one full scan — into ``source.maxNodeId``;
        every later window of every phase uses that. The last call ranks the duplicates and pauses
        for a decision if there are any (:meth:`_finish_preflight`)."""
        ctx = await self._ctx(lease, graph_id)
        async with self._session() as s:
            job = await s.get(JobORM, lease.job_id)
            cursor, summary = job.last_cursor, dict(job.summary or {})
            width = job.batch_size or config.BOOTSTRAP_SCAN_WIDTH
        client = await self._client(ctx)
        if cursor is None:
            # A fresh read: a new job, a restart, or a re-check — nothing has been copied yet in
            # any of them, so the tallies start from zero. A recorded decision is kept: the read
            # it was made on may well come out the same (its fingerprint says).
            summary.update(_fresh_tallies(await self._count(client, _MAX_NODE_ID)))
            summary.pop("duplicates", None)
            async with self._session() as s:
                await lease.checkpoint(s, expect_cursor=None, summary=summary, total=0,
                                       processed=0, last_cursor="counting:0")
            return False
        lo = int(cursor.split(":")[-1])
        max_id = (summary.get("source") or {}).get("maxNodeId")
        if max_id is None or lo > int(max_id):
            return await self._finish_preflight(lease, graph_id, cursor, lo)

        rows, width = await self._scan(client, "preflight", lo, width)
        hi = lo + width
        edges, hidden_edges = await self._preflight_edges(client, lo, hi)
        records, nodes, hidden_nodes = await asyncio.to_thread(_preflight_rows, rows, graph_id)
        async with self._session() as s:
            await s.execute(text(
                f'DELETE FROM {_t("bootstrap_nodes")} '
                "WHERE graph_id = :g AND falkor_id >= :lo AND falkor_id < :hi"
            ).bindparams(g=graph_id, lo=lo, hi=hi))
            for batch in _chunks(records, _rows_per_insert(records)):
                await s.execute(pg_insert(BootstrapNodeORM).values(batch))
            job = await s.get(JobORM, lease.job_id)
            summary = dict(job.summary or {})
            src = dict(summary.get("source") or {})
            for key, n in (("nodes", nodes), ("edges", edges), ("invisibleNodes", hidden_nodes),
                           ("invisibleEdges", hidden_edges)):
                src[key] = int(src.get(key, 0)) + n
            summary["source"] = src
            await lease.checkpoint(s, expect_cursor=cursor, summary=summary,
                                   total=src["nodes"] + src["edges"],
                                   last_cursor=f"counting:{hi}", batch_size=width)
        if self._due(lease.job_id):
            logger.info("bootstrap %s: pre-flight at %d of %s node ids (graph=%s)",
                        lease.job_id, hi, max_id, graph_id)
        return False

    async def _finish_preflight(self, lease: Lease, graph_id: str, cursor: str, end: int):
        """Rank the duplicates, fingerprint them, and decide whether the copy may start.

        Only duplicated urns are ranked — ``row_number() OVER (PARTITION BY urn ORDER BY
        last_synced_at DESC NULLS LAST, falkor_id)``: 1 is kept, >1 is collapsed into it. The
        FINGERPRINT (md5 over every urn|id|rank) names exactly this list: a decision carries it,
        so it applies only to the list the manager was shown. With duplicates and no decision for
        THIS fingerprint, the job pauses (``awaiting_decision``, pending, no cursor) and holds no
        slot until someone decides; with a matching decision — a re-check that found the same
        list — it carries on."""
        async with self._session() as s:
            # A source that shrank since an earlier read of it leaves rows past its new end.
            await s.execute(text(
                f'DELETE FROM {_t("bootstrap_nodes")} WHERE graph_id = :g AND falkor_id >= :end'
            ).bindparams(g=graph_id, end=end))
            await s.execute(_rank_duplicates_sql(), {"g": graph_id})
            dup = await _duplicate_summary(s, graph_id)
            job = await s.get(JobORM, lease.job_id)
            summary = dict(job.summary or {})
            summary["duplicates"] = dup
            decided = (summary.get("duplicatePolicy") or {}).get("fingerprint")
            pause = dup is not None and decided != dup["fingerprint"]
            values: Dict[str, Any] = {"summary": summary}
            if pause:
                values.update(_phase_start(AWAITING_DECISION), status="pending")
            await lease.checkpoint(s, expect_cursor=cursor, **values)
        src = summary.get("source") or {}
        logger.info("bootstrap %s: source has %d nodes / %d edges (%d/%d without an identifier)"
                    "%s", lease.job_id, src.get("nodes", 0), src.get("edges", 0),
                    src.get("invisibleNodes", 0), src.get("invisibleEdges", 0),
                    f"; {dup['identifiers']} identifier(s) used by {dup['extraCopies']} extra "
                    f"cop(ies) — {'waiting for a decision' if pause else 'collapsing, as decided'}"
                    if dup else "")
        return _PAUSED if pause else True

    async def _preflight_edges(self, client, lo: int, hi: int) -> Tuple[int, int]:
        """The window's edges: (visible — both ends carry a urn, hidden)."""
        res = await _q(client, _PREFLIGHT_EDGES, {"lo": lo, "hi": hi},
                       timeout_ms=_READ_TIMEOUT_MS, read_only=True)
        visible = hidden = 0
        for flag, n in getattr(res, "result_set", None) or []:
            if flag:
                visible += int(n or 0)
            else:
                hidden += int(n or 0)
        return visible, hidden

    async def _count(self, client, cypher: str) -> Optional[int]:
        # Deliberately NOT ``read_only``, though the cypher only reads: this is the
        # pre-flight's first query, and ``GRAPH.QUERY`` INSTANTIATES the graph key,
        # which is what leaves the later read-only phases a graph to read. Converting
        # it would lean the whole run on ``_q``'s empty-key retry instead.
        res = await _q(client, cypher, timeout_ms=_WRITE_TIMEOUT_MS)
        rs = getattr(res, "result_set", None) or []
        return int(rs[0][0]) if rs and rs[0] and rs[0][0] is not None else None

    async def _phase_nodes(self, lease: Lease, graph_id: str) -> bool:
        return await self._scan_phase(lease, graph_id, kind="nodes")

    async def _phase_edges(self, lease: Lease, graph_id: str) -> bool:
        return await self._scan_phase(lease, graph_id, kind="edges")

    async def _scan_phase(self, lease: Lease, graph_id: str, *, kind: str) -> bool:
        """One ID-range window: scan the source, convert, write version rows, and
        checkpoint tallies + cursor — all in ONE transaction, so the counters can
        never drift from the rows (and a crash rewinds both together)."""
        ctx = await self._ctx(lease, graph_id)
        async with self._session() as s:
            job = await s.get(JobORM, lease.job_id)
            cursor, summary = job.last_cursor, dict(job.summary or {})
            # Both phases remember the width that worked, so neither re-pays per window what it
            # took to find it: nodes a failed query, edges a halving ladder of counts.
            width = job.batch_size or config.BOOTSTRAP_SCAN_WIDTH
        client = await self._client(ctx)

        lo = int(cursor.split(":")[-1]) if cursor else 0
        max_id = await self._max_id_of(client, summary)
        if max_id is None or lo > max_id:
            return True                                        # nothing (left) to scan

        rules = await self._rules(lease, ctx)
        held = None
        if kind == "edges":
            width, held = await self._fit_edge_window(client, lo, width)
        else:
            width = min(width, _PROPS_ROWS_CAP)
        fitted = width
        rows, width = await self._scan(client, kind, lo, width)
        hi = lo + width

        # Convert → validate → rows. Rejections are counted, never silent. A window is up to
        # ~20k rows of pure-Python conversion and hashing: run it off the event loop, which
        # carries every other job on the worker.
        if kind == "nodes":
            losers = await self._losers(graph_id, lo, hi)
            win = await asyncio.to_thread(self._nodes_to_rows, rows, ctx, graph_id, rules, losers)
        else:
            endpoint_urns = {u for r in rows for u in (r[2], r[3]) if u}
            live = await self._known_nodes(graph_id, ctx.commit_id, endpoint_urns)
            win = await asyncio.to_thread(self._edges_to_rows, rows, ctx, graph_id, rules, live)

        model = NodeVersionORM if kind == "nodes" else EdgeVersionORM
        async with self._session() as s:
            rekeyed = await self._rekey_edge_collisions(s, graph_id, ctx, win.dicts) \
                if kind == "edges" else 0
            # ON CONFLICT DO NOTHING is what makes a replayed window a no-op — but it also
            # silently swallows a genuine duplicate identifier that first appeared in an
            # EARLIER window (the in-window `seen` set can't see across windows). So the tallies
            # come from what RETURNING says LANDED, not from the batch: whatever didn't land is a
            # duplicate. (Rows and cursor commit together, and only from the cursor this window
            # started at, so a resume never re-scans a window that landed — a conflict here really
            # is a duplicate.)
            landed: Set[str] = set()
            for batch in _chunks(win.dicts, _rows_per_insert(win.dicts)):
                res = await s.execute(
                    pg_insert(model).values(batch).on_conflict_do_nothing(
                        index_elements=["graph_id", "id"]).returning(model.entity_id))
                landed.update(res.scalars().all())
            job = await s.get(JobORM, lease.job_id)
            summary = dict(job.summary or {})
            written: Dict[str, int] = {}
            sample = None
            if kind == "nodes":
                sample = _Reservoir(config.BOOTSTRAP_SAMPLE_K,
                                    (summary.get("sample") or {}).get("nodes"),
                                    (summary.get("sample") or {}).get("nodesSeen", 0))
                for d in win.dicts:
                    eid, et = d["entity_id"], str(d["entity_type"] or "unknown")
                    if eid in landed:
                        _bump(written, et)
                        # The PHYSICAL label and the internal id, not the canonicalised entityType:
                        # validation re-reads these from the SOURCE, and only the source's own
                        # spelling seeks its index — then picks this very copy by its id.
                        label, fid = win.meta[eid]
                        sample.offer([label, eid, fid])
                    else:
                        win.rejects["duplicateUrns"] += 1
                        _bump(win.rejects["byLabel"], et)
                        _add_reject_sample(win.rejects, {
                            "kind": "node", "id": eid,
                            "reason": "another item shares this identifier"})
                sample = {"nodes": sample.items, "nodesSeen": sample.seen}
            else:
                for d in win.dicts:
                    if d["entity_id"] in landed:
                        _bump(written, d["edge_type"])
                win.dupes += len(win.dicts) - len(landed)
            summary = _merge_scan_summary(
                summary, kind, scanned=len(rows), written=len(landed), tallies=win.scanned,
                rejects=win.rejects, sample=sample, dupes=win.dupes, written_tallies=written,
                collapsed=win.collapsed, self_loops=win.self_loops, rekeyed=rekeyed)
            done, total = (int(summary["written"]["nodes"]) + int(summary["written"]["edges"]),
                           job.total)
            # The next window's width: the one that worked — and, for edges in a sparse band,
            # twice it, so one dense band doesn't shrink every window after it.
            remember = width
            if held is not None and width == fitted and held * 2 <= _edge_target():
                remember = min(config.BOOTSTRAP_SCAN_WIDTH, width * 2)
            # LAST, so the job row is locked only for the commit. Fenced on the lease AND on the
            # cursor this window started from: a worker that lost the job, or a window that
            # somehow landed twice, rolls back here — rows, tallies and all.
            await lease.checkpoint(
                s, expect_cursor=cursor, summary=summary, processed=done,
                progress=_percent(kind, done, total), last_cursor=f"{kind}:{hi}",
                batch_size=remember)
        # Copying 7.7M entities is thousands of windows and, without this, hours of total
        # silence between "source has N nodes" and "integrity checks passed" — from which an
        # on-call cannot tell a stuck job from a slow one. Throttled, so it stays a progress
        # line and not a log flood.
        if self._due(lease.job_id):
            logger.info("bootstrap %s: %s %s/%s (%d%%) cursor=%s:%d window=%d graph=%s",
                        lease.job_id, kind, done, total, _percent(kind, done, total),
                        kind, hi, width, graph_id)
        return False                                           # more windows may remain

    async def _losers(self, graph_id: str, lo: int, hi: int) -> Set[Tuple[int, str, Optional[str]]]:
        """The window's copies a duplicate decision collapsed, as (internal id, urn, label)."""
        async with self._session() as s:
            rows = (await s.execute(select(
                BootstrapNodeORM.falkor_id, BootstrapNodeORM.urn, BootstrapNodeORM.label).where(
                BootstrapNodeORM.graph_id == graph_id, BootstrapNodeORM.falkor_id >= lo,
                BootstrapNodeORM.falkor_id < hi, BootstrapNodeORM.copy_rank > 1))).all()
        return {(int(f), u, lab) for f, u, lab in rows}

    async def _rekey_edge_collisions(self, s, graph_id: str, ctx: _RunContext,
                                     dicts: List[dict]) -> int:
        """Re-key the window's edges whose id is also a NODE's id in this copy.

        Nodes and edges share one entity-id space (``entity_heads`` is keyed by it), so such an
        edge used to lose its head to the node's — silently, at the heads phase. It is re-keyed,
        deterministically, to ``edge:<id>`` and counted. One indexed lookup per window."""
        clash: Set[str] = set()
        for chunk in _chunks([d["entity_id"] for d in dicts], 10000):
            clash.update((await s.execute(select(NodeVersionORM.entity_id).where(
                NodeVersionORM.graph_id == graph_id, NodeVersionORM.commit_id == ctx.commit_id,
                NodeVersionORM.entity_id.in_(list(chunk))))).scalars().all())
        return _rekey(dicts, clash, ctx.commit_id)

    def _due(self, job_id: str, every: float = 30.0) -> bool:
        """True at most once every `every` seconds, per job."""
        now = time.monotonic()
        if now - self._logged.get(job_id, 0.0) < every:
            return False
        self._logged[job_id] = now
        return True

    async def _phase_validate(self, lease: Lease, graph_id: str) -> bool:
        """Prove the copy before ANY of it becomes visible.

        Runs before `entity_heads` exists and long before the head flip, so a failure
        leaves a graph that is still, in every sense, un-versioned."""
        ctx = await self._ctx(lease, graph_id)
        async with self._session() as s:
            job = await s.get(JobORM, lease.job_id)
            summary = dict(job.summary or {})
            # What actually landed, per label / per edge type — the containment &
            # lineage preservation proof (every declared relationship type survives).
            pg_labels = dict((await s.execute(text(
                f'SELECT entity_type, count(*) FROM {_t("node_versions")} '
                "WHERE graph_id = :g AND commit_id = :c GROUP BY 1"
            ).bindparams(g=graph_id, c=ctx.commit_id))).all())
            pg_types = dict((await s.execute(text(
                f'SELECT edge_type, count(*) FROM {_t("edge_versions")} '
                "WHERE graph_id = :g AND commit_id = :c GROUP BY 1"
            ).bindparams(g=graph_id, c=ctx.commit_id))).all())
            dangling = (await s.execute(text(
                f'SELECT count(*) FROM {_t("edge_versions")} e '
                f'WHERE e.graph_id = :g AND e.commit_id = :c AND ('
                f'  NOT EXISTS (SELECT 1 FROM {_t("node_versions")} n '
                "             WHERE n.graph_id = :g AND n.commit_id = :c "
                "               AND n.entity_id = e.source_entity_id) OR "
                f'  NOT EXISTS (SELECT 1 FROM {_t("node_versions")} n '
                "             WHERE n.graph_id = :g AND n.commit_id = :c "
                "               AND n.entity_id = e.target_entity_id))"
            ).bindparams(g=graph_id, c=ctx.commit_id))).scalar_one()
            # Every duplicated urn ends up as exactly one item. A kept copy deleted from the
            # source while the job waited — its id then re-used by another urn's node — leaves
            # its urn with no copy to keep: none was skipped by mistake, none landed either.
            unresolved = (await s.execute(text(
                f'SELECT count(DISTINCT b.urn) FROM {_t("bootstrap_nodes")} b '
                "WHERE b.graph_id = :g AND b.copy_rank IS NOT NULL AND NOT EXISTS ("
                f'  SELECT 1 FROM {_t("node_versions")} n WHERE n.graph_id = :g '
                "   AND n.commit_id = :c AND n.entity_id = b.urn)"
            ).bindparams(g=graph_id, c=ctx.commit_id))).scalar_one() \
                if summary.get("duplicates") else 0

        src = summary.get("source") or {}
        scanned = summary.get("scanned") or {}
        written = summary.get("written") or {}

        checks = _tally_checks(summary, pg_labels, pg_types)

        def check(key: str, ok: bool, detail: str, blocking: bool = True) -> None:
            checks.append({"key": key, "ok": bool(ok), "detail": detail, "blocking": blocking})

        # 5. No edge points at an item that isn't there.
        check("referentially_whole", int(dangling) == 0,
              f"{dangling} connection(s) referencing a missing item")
        if summary.get("duplicates"):
            check("duplicates_resolved", int(unresolved) == 0,
                  f"{unresolved} duplicated identifier(s) left without a copy to keep")
        # 6. The source is still the one that was read. Its windows were read against the
        #    pre-flight's largest id, so a node added since lies beyond them: only a recount sees
        #    it. (A job whose pre-flight predates the cached id counted the old way; skipped.)
        if "maxNodeId" in src:
            recount = await self._source_nodes(await self._client(ctx))
            check("source_stable", recount == src.get("nodes"),
                  f"the source holds {recount:,} items; {src.get('nodes'):,} were read"
                  if recount != src.get("nodes") else "the source did not change while copied")

        # 7. Re-read a random sample from the SOURCE and compare content hashes —
        #    counts alone can't catch a mangled payload.
        sampled = list((summary.get("sample") or {}).get("nodes") or [])
        matched, mismatched = await self._verify_sample(
            graph_id, ctx.commit_id, ctx, sampled, await self._rules(lease, ctx))
        check("sample_matches", not mismatched,
              f"{matched} of {len(sampled)} re-checked items match exactly")

        blocking = [c for c in checks if c["blocking"] and not c["ok"]]
        report = {
            "checks": checks,
            "source": src,
            "stored": {"nodes": written.get("nodes", 0), "edges": written.get("edges", 0)},
            "labels": dict(scanned.get("byLabel") or {}),
            "edgeTypes": dict(scanned.get("byType") or {}),
            "sampleChecked": len(sampled),
            "sampleMismatched": mismatched[:10],
            "mergedDuplicateConnections": int(summary.get("collapsedParallelEdges", 0)),
            # Not copied because the app can't see them either (no identifier) — stated
            # plainly rather than hidden, so "everything was copied" stays true.
            "skippedWithoutIdentifier": {
                "nodes": int(src.get("invisibleNodes", 0)),
                "edges": int(src.get("invisibleEdges", 0)),
            },
            "merkle": "pending",
        }
        async with self._session() as s:
            job = await s.get(JobORM, lease.job_id)
            summary = dict(job.summary or {})
            summary["report"] = report
            await lease.checkpoint(s, summary=summary, progress=_PHASE_FLOOR["validate"])

        if blocking:
            raise BootstrapFailure(_explain_failed_checks(blocking), "integrity")
        logger.info("bootstrap %s: integrity checks passed (%d checks)", lease.job_id,
                    len(checks))
        return True

    async def _phase_heads(self, lease: Lease, graph_id: str) -> bool:
        """Publish the entity head pointers (keyset-windowed, server-side INSERT…SELECT
        so no rows travel through Python). Only reached once validation has passed."""
        async with self._session() as s:
            job = await s.get(JobORM, lease.job_id)
            commit = await self._import_commit(s, graph_id)
            main_id = await self._main_branch_id(s, graph_id)
            at = job.last_cursor
            cursor = at or "heads:nodes:"
            kind = "edges" if cursor.startswith("heads:edges") else "nodes"
            after = cursor.split(":", 2)[2] if cursor.count(":") >= 2 else ""
            table = "node_versions" if kind == "nodes" else "edge_versions"
            row = (await s.execute(text(
                f'WITH page AS ('
                f'  SELECT id, entity_id, content_hash FROM {_t(table)}'
                "   WHERE graph_id = :g AND commit_id = :c AND entity_id > :after"
                "   ORDER BY entity_id LIMIT :w"
                "), ins AS ("
                f'  INSERT INTO {_t("entity_heads")} '
                "    (graph_id, branch_id, entity_id, entity_kind, head_version_id,"
                "     content_hash, is_tombstone, updated_at)"
                "  SELECT :g, :b, entity_id, :kind, id, content_hash, false, :now FROM page"
                "  ON CONFLICT (graph_id, branch_id, entity_id) DO NOTHING"
                ") SELECT count(*), max(entity_id) FROM page"
            ).bindparams(g=graph_id, c=commit.id, b=main_id, after=after,
                         kind=("node" if kind == "nodes" else "edge"),
                         now=_now(), w=config.BOOTSTRAP_WINDOW))).one()
            n, last = int(row[0]), row[1]
            if n == 0:
                if kind == "nodes":
                    await lease.checkpoint(s, expect_cursor=at, last_cursor="heads:edges:")
                    return False                               # switch to the edge pass
                return True                                    # both passes done
            await lease.checkpoint(s, expect_cursor=at, last_cursor=f"heads:{kind}:{last}",
                                   progress=_PHASE_FLOOR["heads"])
        return False

    async def _phase_merkle(self, lease: Lease, graph_id: str) -> bool:
        """The commit's Merkle root — the integrity fingerprint later commits inherit.

        Built inline while the tree fits in memory. Above the cap the root is left
        NULL (the column is expressly "async-filled for bulk") and the report SAYS so,
        rather than OOM-ing to produce a number nobody asked for yet."""
        async with self._session() as s:
            job = await s.get(JobORM, lease.job_id)
            commit = await self._import_commit(s, graph_id)
            main_id = await self._main_branch_id(s, graph_id)
            total = int(job.total or 0)
            summary = dict(job.summary or {})
            report = dict(summary.get("report") or {})
            if total > config.BOOTSTRAP_MERKLE_INLINE_MAX:
                report["merkle"] = "deferred"
                summary["report"] = report
                await lease.checkpoint(s, summary=summary)
                logger.info("bootstrap %s: merkle deferred (%d entities > cap)", lease.job_id,
                            total)
                return True
            # Replay-safety. Every other phase is idempotent through ON CONFLICT DO NOTHING;
            # `commit_tree` is not — it INSERTs bare, and its parent lookup is as-of
            # commit_seq-1, so it cannot see rows this commit already wrote. The phase body
            # and the phase ADVANCE commit in separate transactions, so a crash in between
            # re-enters merkle for the same commit and hits a duplicate key on
            # (graph_id, commit_id, path) — failing the job, and failing it again on every
            # resume. Clearing this commit's own tree first makes the rebuild total, and the
            # tree is a pure function of the commit's rows, so rebuilding is free of meaning.
            await s.execute(text(
                f'DELETE FROM {_t("merkle_nodes")} WHERE graph_id = :g AND commit_id = :c'
            ).bindparams(g=graph_id, c=commit.id))
            changes: Dict[str, Optional[str]] = {}
            for table in ("node_versions", "edge_versions"):
                rows = (await s.execute(text(
                    f'SELECT entity_id, content_hash FROM {_t(table)} '
                    "WHERE graph_id = :g AND commit_id = :c"
                ).bindparams(g=graph_id, c=commit.id))).all()
                changes.update({r[0]: r[1] for r in rows})
            commit.merkle_root = await self._merkle.commit_tree(
                s, graph_id, main_id, commit.id, commit.commit_seq, changes)
            report["merkle"] = "inline"
            summary["report"] = report
            await lease.checkpoint(s, summary=summary, progress=_PHASE_FLOOR["merkle"])
        return True

    async def _phase_finalize(self, lease: Lease, graph_id: str) -> bool:
        """Flip the head — the single moment the versioned graph becomes real — and
        fast-forward the projection watermark instead of reseeding.

        The graph is pinned to the SOURCE FalkorDB graph the canvas already reads and
        validation just proved the two agree, so a full reseed would drop and rewrite
        every entity (and wipe the `:AGGREGATED` rollups) to arrive back where we are.
        A duplicate collapse, though, deleted nodes from that graph, and the rollups were
        computed over them: their rebuild is queued once the head has flipped (again on a
        replay of this phase — queueing a rebuild twice is harmless, missing it is not).
        """
        async with self._session() as s:
            job = await s.get(JobORM, lease.job_id)
            commit = await self._import_commit(s, graph_id)
            # Fence FIRST: it takes the job row's lock before the flip touches the graph's —
            # the order abandon takes them in — so the two serialize rather than deadlock, and a
            # job abandoned under us rolls the flip back with it.
            await lease.checkpoint(s, target_commit_id=commit.id,
                                   progress=_PHASE_FLOOR["finalize"])
            graph = await s.get(GraphORM, graph_id)
            main = await s.get(BranchORM, await self._main_branch_id(s, graph_id))
            summary = dict(job.summary or {})
            stored = (summary.get("report") or {}).get("stored") or {}
            commit.stats = {"nodes": int(stored.get("nodes", 0)), "edges": int(stored.get("edges", 0))}
            main.head_commit_id = commit.id
            graph.main_head_commit_seq = commit.commit_seq
            graph.updated_at = _now()
            ps = await s.get(ProjectionStateORM, graph_id)
            if ps is not None:
                ps.projected_commit_seq = commit.commit_seq
                ps.target_commit_seq = commit.commit_seq
                ps.status = "idle"
                ps.last_projected_at = _now()
        logger.info("bootstrap %s: head flipped to seq %s (projection fast-forwarded)",
                    lease.job_id, commit.commit_seq)
        # On the decision, not on the tally of deletes: a window replayed after a crash between
        # its DETACH DELETE and its checkpoint finds its copies gone and counts none.
        if (_collapse_decided(summary) or "sourceCollapse" in summary) and self._on_rollups_stale:
            try:
                await self._on_rollups_stale(graph_id)
            except Exception:                                  # pragma: no cover - best effort
                logger.exception("bootstrap %s: queueing the rollup rebuild failed", lease.job_id)
        return True

    async def _phase_backfill(self, lease: Lease, graph_id: str) -> bool:
        """Make the source graph ready to be the live graph's projection, in steps:

        * ``backfill:nodes:<lo>`` / ``backfill:edges:<lo>`` stamp the projector's delete-anchoring
          keys (`n.entityId`, `r.id`), in ID-range windows. Additive and idempotent — a no-op on
          graphs the platform itself wrote. Runs before writes are unblocked, so the first
          incremental projection after enablement can anchor its deletes.
        * ``backfill:dupes:<urn>`` — only after a collapse — moves each discarded copy's edges to
          the copy kept and deletes it (:meth:`_backfill_dupes`), so the source graph holds what
          the copy holds. After the anchors: it moves edges BY their `r.id`.
        * ``backfill:tidy`` drops the pre-flight's rows for unique urns; the duplicate rows stay,
          as the record of what was collapsed (the list stays downloadable).

        Every write here lands on the customer's LIVE graph, holding its write lock while it runs,
        so each is fitted to ``BOOTSTRAP_BACKFILL_MAX_WRITES`` changes and followed by a
        ``BOOTSTRAP_BACKFILL_PAUSE_MS`` pause that lets the canvas's reads through."""
        ctx = await self._ctx(lease, graph_id)
        async with self._session() as s:
            job = await s.get(JobORM, lease.job_id)
            at, summary = job.last_cursor, dict(job.summary or {})
            width = job.batch_size or config.BOOTSTRAP_SCAN_WIDTH
        cursor = at or "backfill:nodes:0"
        _, step, arg = (cursor.split(":", 2) + ["", ""])[:3]
        if step == "dupes":
            return await self._backfill_dupes(lease, graph_id, at, arg)
        if step == "tidy":
            async with self._session() as s:
                deleted = await delete_window(s, "bootstrap_nodes", "graph_id, falkor_id",
                                              graph_id, where="copy_rank IS NULL")
                await lease.checkpoint(s, expect_cursor=at)
            return deleted == 0
        kind, lo = step, int(arg or 0)
        client = await self._client(ctx)
        max_id = await self._max_id_of(client, summary)
        if max_id is None or lo > max_id:
            nxt = ("backfill:edges:0" if kind == "nodes"
                   else "backfill:dupes:" if _collapse_decided(summary) else "backfill:tidy")
            extra: Dict[str, Any] = {}
            if nxt == "backfill:dupes:":
                # Marked BEFORE the first write to the source graph, and kept by a restart: from
                # the next statement on, copies may be gone from it for good.
                extra["summary"] = {**summary, "sourceCollapse": summary.get("sourceCollapse")
                                    or {"moved": 0, "deleted": 0}}
            async with self._session() as s:
                await lease.checkpoint(s, expect_cursor=at, last_cursor=nxt,
                                       batch_size=config.BOOTSTRAP_SCAN_WIDTH, **extra)
            return False
        cap = config.BOOTSTRAP_BACKFILL_MAX_WRITES
        held = None
        if kind == "nodes":
            width = min(width, cap)                            # at most one write per node
        else:
            width, held = await self._fit_window(client, _COUNT_BACKFILL_EDGES, lo, width, cap)
        fitted = width
        cypher = _BACKFILL_NODES if kind == "nodes" else _BACKFILL_EDGES
        while True:
            try:
                res = await _q(client, cypher, {"lo": lo, "hi": lo + width},
                               timeout_ms=_WRITE_TIMEOUT_MS)
                break
            except Exception as exc:
                # A write too big for the server's budget right now: halve it (idempotent — a
                # SET only where the key is still missing). Anything else is the phase retry's.
                if not _is_timeout(exc) or width <= config.BOOTSTRAP_SCAN_MIN_WIDTH:
                    raise
                width = max(config.BOOTSTRAP_SCAN_MIN_WIDTH, width // 2)
        rs = getattr(res, "result_set", None) or []
        if rs and rs[0] and rs[0][0]:
            await _backfill_pause()
        # As the edge scan does: a sparse window lets the next one grow back.
        remember = width
        if held is not None and width == fitted and held * 2 <= cap:
            remember = min(config.BOOTSTRAP_SCAN_WIDTH, width * 2)
        async with self._session() as s:
            await lease.checkpoint(s, expect_cursor=at, last_cursor=f"backfill:{kind}:{lo + width}",
                                   batch_size=remember, progress=_PHASE_FLOOR["backfill"])
        return False

    async def _backfill_dupes(self, lease: Lease, graph_id: str, at: str, after: str) -> bool:
        """Collapse the duplicates in the SOURCE graph, as they were collapsed in the copy.

        Up to ``_DUPES_WINDOW`` copies per window, whole urns at a time (``backfill:dupes:<last
        urn done>``), each window:

        1. reads each discarded copy's relationships (type and other end; never AGGREGATED — the
           rollups are rebuilt after finalize);
        2. moves them onto the copy kept (:func:`_dupe_repoint_cypher`): MERGEd by ``r.id``, so
           FalkorDB stays one relationship per Postgres edge row, and a relationship between two
           copies of one urn — dropped from the copy as a collapse self-loop — is not moved;
        3. deletes the discarded copies, each found by label, urn AND internal id;
        4. checkpoints, fenced on the cursor.

        Re-running a window after a crash between 2 and 3 MERGEs onto what the first run made and
        deletes what is left. The urn indexes of the duplicated labels are created (and waited
        for) first: every statement here seeks by label + urn, and an index still building would
        turn each seek into a label scan."""
        ctx = await self._ctx(lease, graph_id)
        client = await self._client(ctx)
        page = (f'SELECT urn, falkor_id, label, copy_rank FROM {_t("bootstrap_nodes")} '
                "WHERE graph_id = :g AND copy_rank IS NOT NULL ")
        async with self._session() as s:
            rows = (await s.execute(text(
                page + "AND urn > :after ORDER BY urn, copy_rank LIMIT :n"
            ).bindparams(g=graph_id, after=after, n=_DUPES_WINDOW + 1))).all()
            more = len(rows) > _DUPES_WINDOW
            if more and rows[0][0] == rows[-1][0]:
                # One urn with more copies than a window holds: take that urn whole.
                rows = (await s.execute(text(page + "AND urn = :u ORDER BY copy_rank").bindparams(
                    g=graph_id, u=rows[0][0]))).all()
                more = False
            labels = [] if ctx.dupe_indexes_ready else (await s.execute(text(
                f'SELECT DISTINCT label FROM {_t("bootstrap_nodes")} '
                "WHERE graph_id = :g AND copy_rank IS NOT NULL AND label IS NOT NULL"
            ).bindparams(g=graph_id))).scalars().all()
        if not rows:
            async with self._session() as s:
                await lease.checkpoint(s, expect_cursor=at, last_cursor="backfill:tidy")
            return False
        if not ctx.dupe_indexes_ready:
            await ensure_urn_indexes(client, labels, wait=True)
            ctx.dupe_indexes_ready = True
        groups = _copy_groups(rows, drop_last=more)

        # 1. What each discarded copy is connected to: (direction, other end's id, type, keyed).
        rels: Dict[int, Set[Tuple[str, int, str, bool]]] = {}
        for label, batch in _discarded_by_label(groups).items():
            for direction in ("out", "in"):
                res = await _q(client, _dupe_edges_cypher(label, direction), {"rows": batch},
                               timeout_ms=_READ_TIMEOUT_MS, read_only=True)
                for lid, oid, rtype, unkeyed in getattr(res, "result_set", None) or []:
                    rels.setdefault(int(lid), set()).add(
                        (direction, int(oid), str(rtype), not unkeyed))
        # Whole urns, as many as fit one window's writes (at least one).
        groups = _fit_groups(groups, rels, config.BOOTSTRAP_BACKFILL_MAX_WRITES)

        # 2. Move them onto the copy kept — one statement per (labels, type, direction, keyed),
        #    since neither a label nor a relationship type can be a parameter.
        moves: Dict[tuple, Dict[int, dict]] = {}
        for g in groups:
            kept_id, kept_label = g["kept"]
            for lid, label in g["discarded"]:
                row = {"urn": g["urn"], "lid": lid, "wid": kept_id}
                for direction, oid, rtype, keyed in rels.get(lid, ()):
                    if oid == lid and direction == "out":       # a genuine self-loop
                        key = (label, kept_label, rtype, "loop", True)
                    elif oid in g["skip"]:
                        # The same self-loop seen from its other end, or one joining two copies
                        # of this urn (a collapse self-loop: dropped, as the copy dropped it).
                        continue
                    else:
                        key = (label, kept_label, rtype, direction, keyed)
                    moves.setdefault(key, {})[lid] = row         # one row per copy and statement
        moved = 0
        for (label, kept_label, rtype, direction, keyed), batch in moves.items():
            cypher = (_dupe_self_loop_cypher(label, kept_label, rtype) if direction == "loop"
                      else _dupe_repoint_cypher(label, kept_label, rtype, direction, keyed))
            moved += await self._write(client, cypher, list(batch.values()))
        # 3. Delete the discarded copies.
        deleted = 0
        for label, batch in _discarded_by_label(groups).items():
            deleted += await self._write(client, _dupe_delete_cypher(label), batch)
        # 4. Checkpoint. The tallies count what THIS job's statements did — a window replayed
        #    after a crash finds its work done and adds nothing — so they are for the log, and
        #    nothing decides on them.
        async with self._session() as s:
            job = await s.get(JobORM, lease.job_id)
            summary = dict(job.summary or {})
            done = dict(summary.get("sourceCollapse") or {})
            done["deleted"] = int(done.get("deleted", 0)) + deleted
            done["moved"] = int(done.get("moved", 0)) + moved
            summary["sourceCollapse"] = done
            await lease.checkpoint(s, expect_cursor=at, summary=summary,
                                   last_cursor=f"backfill:dupes:{groups[-1]['urn']}",
                                   progress=_PHASE_FLOOR["backfill"])
        logger.info("bootstrap %s: collapsed %d duplicate cop(ies) in the source graph "
                    "(%d relationship(s) moved, through %s)", lease.job_id, deleted, moved,
                    groups[-1]["urn"])
        return False

    async def _write(self, client, cypher: str, rows: List[dict]) -> int:
        """One write to the live source graph, then the pause that lets its readers through.
        Returns the count the statement RETURNs."""
        if not rows:
            return 0
        res = await _q(client, cypher, {"rows": rows}, timeout_ms=_WRITE_TIMEOUT_MS)
        rs = getattr(res, "result_set", None) or []
        n = int(rs[0][0]) if rs and rs[0] and rs[0][0] is not None else 0
        if n:
            await _backfill_pause()
        return n

    # ------------------------------------------------------------- internals --
    async def _max_id(self, client) -> Optional[int]:
        """The node id space — every phase (nodes, edges, backfill) windows over it. A full scan:
        read once by the pre-flight, and again only to see whether the source changed."""
        res = await _q(client, _MAX_NODE_ID, timeout_ms=_READ_TIMEOUT_MS, read_only=True)
        rs = getattr(res, "result_set", None) or []
        val = rs[0][0] if rs and rs[0] else None
        return int(val) if val is not None else None

    async def _max_id_of(self, client, summary: dict) -> Optional[int]:
        """The pre-flight's cached largest id; a job whose pre-flight predates the cache (no
        ``maxNodeId``) reads it per window, as it always did."""
        src = summary.get("source") or {}
        if "maxNodeId" in src:
            return None if src["maxNodeId"] is None else int(src["maxNodeId"])
        return await self._max_id(client)

    async def _source_nodes(self, client) -> int:
        """The source's urn-bearing, non-derived nodes now — what the pre-flight counted."""
        res = await _q(client, _COUNT_NODES, timeout_ms=_READ_TIMEOUT_MS, read_only=True)
        rs = getattr(res, "result_set", None) or []
        return int(rs[0][0]) if rs and rs[0] and rs[0][0] is not None else 0

    async def _fit_edge_window(self, client, lo: int, width: int) -> Tuple[int, Optional[int]]:
        """Shrink the node span until the edges it holds fit one query.

        Node ids cluster by entity type, so a fixed node width is a terrible predictor of
        edge volume: on a real 5M-edge model, one 10k-node window held 15k edges and the
        next held 185k — enough to blow the server's per-query budget even at the minimum
        node width, which the reactive halve-on-failure ladder could not rescue (it only
        halves AFTER a 60s timeout, and it has a floor). Counting first is ~0.1s and
        costs nothing: no properties are materialized. Returns the width and the edges it holds.
        """
        return await self._fit_window(client, _COUNT_EDGES_IN_WINDOW, lo, width, _edge_target())

    async def _fit_window(self, client, count_cypher: str, lo: int, width: int,
                          target: int) -> Tuple[int, Optional[int]]:
        """Halve ``width`` until ``count_cypher`` over ``[lo, lo+width)`` is at most ``target``.
        Returns (width, that count) — the count None when counting failed (the scan's own ladder
        then has the last word)."""
        n = None
        while True:
            try:
                n = await self._count_window(client, lo, width, count_cypher)
            except Exception:                              # counting failed → let the ladder try
                return width, None
            if n <= target or width <= 1:
                return width, n
            width = max(1, width // 2)

    async def _count_window(self, client, lo: int, width: int,
                            cypher: str = _COUNT_EDGES_IN_WINDOW) -> int:
        res = await _q(client, cypher, {"lo": lo, "hi": lo + width},
                       timeout_ms=_READ_TIMEOUT_MS, read_only=True)
        rs = getattr(res, "result_set", None) or []
        return int(rs[0][0]) if rs and rs[0] and rs[0][0] is not None else 0

    async def _scan(self, client, kind: str, lo: int, width: int) -> Tuple[List[tuple], int]:
        """One window, halving on failure until it fits (a dense ID range, or one with fat
        property payloads, can blow the server's per-query budget).

        Returns the width that actually WORKED so the caller can remember it: rediscovering
        it from scratch every window means paying a failed query per window forever.

        Shrinks only for faults shrinking can FIX, and knows which those are:

        * A BROKEN PIPE is re-raised untouched — no window is small enough to travel down a
          dead socket, and laddering down to the floor would burn four doomed queries and then
          fail a perfectly good job. The phase-level retry waits it out instead.
        * A TIMEOUT shrinks. It is ambiguous — the server may be in trouble, or the question
          may be too big for it right now — and shrinking is harmless in the first case and
          the only cure in the second. A window sized for a healthy FalkorDB genuinely stops
          answering once that FalkorDB is near its memory ceiling. Once we are at the floor
          and it STILL times out, we re-raise and the phase retry waits: we have then done
          both things, in the order that costs least.
        """
        while True:
            try:
                res = await _q(client, _SCANS[kind], {"lo": lo, "hi": lo + width},
                               timeout_ms=_WRITE_TIMEOUT_MS, read_only=True)
                return list(getattr(res, "result_set", None) or []), width
            except Exception as exc:
                shrinkable = not _is_transient(exc) or _is_timeout(exc)
                if not shrinkable or width <= config.BOOTSTRAP_SCAN_MIN_WIDTH:
                    raise
                width = max(config.BOOTSTRAP_SCAN_MIN_WIDTH, width // 2)
                logger.warning("bootstrap scan window shrank to %d (lo=%d): %s",
                               width, lo, type(exc).__name__)

    async def _known_nodes(self, graph_id: str, commit_id: str, urns) -> set:
        """Which endpoint urns already exist as imported nodes (node phase precedes the
        edge phase, so this is authoritative) — replaces the old in-memory urn→id map,
        which is what made the previous bootstrap O(graph) in RAM."""
        known: set = set()
        ids = [u for u in urns if u]
        async with self._session() as s:
            for batch in _chunks(ids, 10000):
                rows = (await s.execute(select(NodeVersionORM.entity_id).where(
                    NodeVersionORM.graph_id == graph_id,
                    NodeVersionORM.commit_id == commit_id,
                    NodeVersionORM.entity_id.in_(list(batch)),
                ))).scalars().all()
                known.update(rows)
        return known

    def _nodes_to_rows(self, rows, ctx, graph_id, rules, losers) -> _Window:
        from backend.app.providers.falkordb_provider import _node_from_props
        from backend.app.providers.versioned_bootstrap import canonicalize_rows
        now = _now()
        win = _Window(dicts=[], scanned={}, collapsed={}, meta={},
                      rejects={"duplicateUrns": 0, "byLabel": {}, "samples": []})
        seen: set = set()
        for fid, labels, props in rows:
            props = dict(props or {})
            label = _label_of(labels)
            node = _node_from_props(props, label)
            if node is None or not node.urn:
                continue                                   # filtered by the scan; belt-and-braces
            row = {"kind": "node", **node.model_dump(by_alias=True, exclude_none=True)}
            canonicalize_rows([row], rules)
            if not row.get("entityType"):
                row["entityType"] = label or "unknown"
            payload = _sanitize_node_properties({k: v for k, v in row.items() if k != "kind"})
            et = str(payload.get("entityType") or "unknown")
            _bump(win.scanned, et)
            # A copy the decision collapsed is skipped — but only if it is STILL that copy: the
            # same internal id, urn AND label. FalkorDB re-uses a deleted node's id, so a copy
            # deleted while the job waited may have handed its id to a different node, which
            # must be copied like any other.
            if (int(fid), str(props.get("urn")), label) in losers:
                _bump(win.collapsed, et)
                continue
            eid = node.urn
            if eid in seen:
                win.rejects["duplicateUrns"] += 1
                _bump(win.rejects["byLabel"], et)
                _add_reject_sample(win.rejects, {"kind": "node", "id": eid,
                                                 "reason": "another item shares this identifier"})
                continue
            seen.add(eid)
            ch = content_hash(payload)
            win.meta[eid] = (label or "", int(fid))
            win.dicts.append(dict(
                graph_id=graph_id, id=_vid("nvb", ctx.commit_id, eid), entity_id=eid,
                commit_id=ctx.commit_id, commit_seq=ctx.commit_seq, branch_id=ctx.main_id,
                op="create", content_hash=ch, prev_content_hash=None, payload=payload,
                actor=ctx.actor, created_at=now, urn=payload.get("urn"),
                entity_type=payload.get("entityType"), display_name=payload.get("displayName"),
                qualified_name=payload.get("qualifiedName"),
            ))
        return win

    def _edges_to_rows(self, rows, ctx, graph_id, rules, live: set) -> _Window:
        from backend.app.providers.falkordb_provider import _edge_from_row
        from backend.app.services.versioning.entity_serde import edge_to_payload
        from backend.app.services.versioning.ontology import canonicalize_payload_types
        now = _now()
        win = _Window(dicts=[], scanned={}, collapsed={}, meta={},
                      rejects={"danglingEdges": 0, "samples": []})
        seen: set = set()
        for src_id, tgt_id, src_urn, tgt_urn, rel, props in rows:
            # Two COPIES of one urn joined by an edge: collapsed into one item, it would point at
            # itself — an artefact of the duplicate, not lineage. Dropped and counted. One node
            # pointing at itself (same id) is a genuine self-loop and is kept.
            if src_urn == tgt_urn and src_id != tgt_id:
                win.self_loops += 1
                continue
            if not src_urn or not tgt_urn or src_urn not in live or tgt_urn not in live:
                win.rejects["danglingEdges"] += 1
                _add_reject_sample(win.rejects, {"kind": "edge", "reason": "endpoint item not found",
                                                 "source": src_urn, "target": tgt_urn})
                continue
            edge = _edge_from_row(src_urn, tgt_urn, str(rel), dict(props or {}))
            eid = edge.id
            if eid in seen:
                win.dupes += 1
                continue
            seen.add(eid)
            # Canonical edge payload (confidence TOP-LEVEL, properties NESTED) via the shared
            # contract. The old hand-built shape FLATTENED user props and dropped `confidence`, so a
            # rebuild's reseed — which reads the canonical shape — blanked both. Endpoints are the
            # scan's urns (edge.source_urn/target_urn == src_urn/tgt_urn).
            payload = edge_to_payload(edge)
            canonicalize_payload_types(payload, rules)      # rewrite edgeType casing in place
            et = str(payload.get("edgeType") or rel)
            payload["edgeType"] = et
            ch = content_hash(payload)
            _bump(win.scanned, et)
            win.dicts.append(dict(
                graph_id=graph_id, id=_vid("evb", ctx.commit_id, eid), entity_id=eid,
                commit_id=ctx.commit_id, commit_seq=ctx.commit_seq, branch_id=ctx.main_id,
                op="create", content_hash=ch, prev_content_hash=None, payload=payload,
                actor=ctx.actor, created_at=now, source_entity_id=src_urn,
                target_entity_id=tgt_urn, edge_type=et, confidence=payload.get("confidence"),
                discriminator=payload.get("discriminator"),
            ))
        return win

    async def _verify_sample(self, graph_id, commit_id, ctx, samples, rules) -> Tuple[int, List[dict]]:
        """Re-read sampled entities from the SOURCE and compare content hashes with what
        we stored — the check that catches a mangled payload, which counts cannot.

        SEEK, don't scan. `MATCH (n {urn: $u})` names no label, so FalkorDB cannot use the
        per-label `urn` index and answers it by scanning every node — once per sampled urn.
        On the 2.08M-node model that is 64 full scans in a single query: measured at ~28s,
        against a 30s read budget, and it duly timed out and killed a copy that had just
        written all 7,093,010 rows perfectly. Seeking `(n:`Label` {urn: $u})` uses the index
        (measured 145× faster) and turns the whole check into a handful of milliseconds.

        The label must be the SOURCE's own spelling — which is why the scan stashes it in the
        sample rather than us reading `entity_type` back from Postgres, where canonicalisation
        may have re-spelled or aliased it into something the source graph never had. So is the
        node's internal id: a duplicated urn has several copies under one label, and only the
        copy that was stored is compared.
        """
        if not samples:
            return 0, []
        from backend.app.providers.falkordb_provider import _node_from_props
        from backend.app.providers.versioned_bootstrap import canonicalize_rows
        client = await self._client(ctx)

        # A job that started before the sample carried labels resumes with bare urns; those
        # fall back to the unlabelled scan, in small chunks so no single query can blow the
        # budget. New jobs never take this path. (Nor, before the ids, did a sample carry one.)
        by_label: Dict[str, List[str]] = {}
        unlabelled: List[str] = []
        wanted: List[Tuple[str, Optional[int]]] = []
        for item in samples:
            if isinstance(item, str):
                label, urn, fid = "", item, None
            else:
                label, urn, fid = item[0] or "", item[1], (item[2] if len(item) > 2 else None)
            wanted.append((urn, fid))
            if label:
                by_label.setdefault(label, []).append(urn)
            else:
                unlabelled.append(urn)

        rows: List[tuple] = []
        for label, group in by_label.items():
            cypher = (f"UNWIND $urns AS u MATCH (n:{_q_label(label)} {{urn: u}}) "
                      "RETURN ID(n), labels(n), properties(n)")
            for chunk in _chunks(group, _PROPS_ROWS_CAP):
                res = await _q(client, cypher, {"urns": list(chunk)},
                               timeout_ms=_READ_TIMEOUT_MS, read_only=True)
                rows.extend(getattr(res, "result_set", None) or [])
        for chunk in _chunks(unlabelled, 8):
            res = await _q(client, _SAMPLE_NODES, {"urns": list(chunk)},
                           timeout_ms=_READ_TIMEOUT_MS, read_only=True)
            rows.extend(getattr(res, "result_set", None) or [])

        by_id: Dict[int, Tuple[str, str]] = {}
        by_urn: Dict[str, str] = {}
        for nid, labels, props in rows:
            node = _node_from_props(dict(props or {}), _label_of(labels))
            if node is None or not node.urn:
                continue
            row = {"kind": "node", **node.model_dump(by_alias=True, exclude_none=True)}
            canonicalize_rows([row], rules)
            if not row.get("entityType"):
                row["entityType"] = _label_of(labels) or "unknown"
            digest = content_hash(
                _sanitize_node_properties({k: v for k, v in row.items() if k != "kind"}))
            by_id[int(nid)] = (node.urn, digest)
            by_urn[node.urn] = digest
        async with self._session() as s:
            stored = dict((await s.execute(
                select(NodeVersionORM.entity_id, NodeVersionORM.content_hash).where(
                    NodeVersionORM.graph_id == graph_id,
                    NodeVersionORM.commit_id == commit_id,
                    NodeVersionORM.entity_id.in_([u for u, _f in wanted]),
                ))).all())
        matched, mismatched = 0, []
        for urn, fid in wanted:
            if fid is None:
                fresh = by_urn.get(urn)
            else:
                got = by_id.get(int(fid))
                fresh = got[1] if got is not None and got[0] == urn else None
            if fresh is not None and fresh == stored.get(urn):
                matched += 1
            else:
                mismatched.append({"entityId": urn,
                                   "reason": "changed in the source while copying"
                                             if fresh is not None else "no longer in the source"})
        return matched, mismatched

    async def _import_commit(self, s, graph_id: str) -> CommitORM:
        commit = (await s.execute(select(CommitORM).where(
            CommitORM.graph_id == graph_id,
            CommitORM.idempotency_key == f"bootstrap:{graph_id}",
        ))).scalars().first()
        if commit is None:                                     # pragma: no cover - guarded at enqueue
            raise BootstrapFailure("the import commit is missing", "internal")
        return commit

    async def _main_branch_id(self, s, graph_id: str) -> str:
        return (await s.execute(select(BranchORM.id).where(
            BranchORM.graph_id == graph_id, BranchORM.kind == "main"))).scalars().one()


# --------------------------------------------------------------------------- #
# Job lifecycle (API-facing): enqueue, status, retry, abandon                   #
# --------------------------------------------------------------------------- #
async def create_bootstrap_job(
    *, data_source_id: str, workspace_id: str, actor: str,
    falkor_graph_name: Optional[str] = None, falkor_provider: Optional[str] = None,
    kind: str = "manual",
) -> Dict[str, object]:
    """Enqueue "enable version control" for a data source. Idempotent.

    Creates the graph shell (genesis + main + projection state) and the seq-2 `import`
    commit the worker fills in — but NEVER advances the head, so the data source keeps
    reading its live graph and simply isn't versioned yet until the job finishes.

    The projection watermark is parked at genesis (`projected == target == 1`) on
    purpose: the graph is pinned to the SOURCE FalkorDB graph, so a projector that
    thought it had work to do would DROP that graph and reseed it from an empty
    genesis — i.e. wipe the user's data. Nothing may project until finalize.

    A job that already exists is RETURNED, never acted on — in flight, paused, or failed
    (with its ``failure``): only the user's explicit retry knows whether to resume or restart,
    and re-queueing a live job would hand it to a second worker. Concurrent calls create one
    graph and one job — the loser of the ``uq_graphs_data_source`` race returns the winner's.
    While an abandoned attempt's graph is still being purged there is nothing to enable yet:
    :class:`BootstrapConflict` ``cleanup_in_progress``.
    """
    args = dict(data_source_id=data_source_id, workspace_id=workspace_id, actor=actor,
                falkor_graph_name=falkor_graph_name, falkor_provider=falkor_provider, kind=kind)
    try:
        return await _enqueue_bootstrap(**args)
    except IntegrityError:
        # Lost a concurrent enable race (uq_graphs_data_source): the winner's graph and job are
        # committed by now, so a second look finds them and returns its job.
        return await _enqueue_bootstrap(**args)


async def _enqueue_bootstrap(*, data_source_id: str, workspace_id: str, actor: str,
                             falkor_graph_name: Optional[str], falkor_provider: Optional[str],
                             kind: str) -> Dict[str, object]:
    async with db.graphver_session() as s:
        graph = (await s.execute(select(GraphORM).where(
            GraphORM.data_source_id == data_source_id))).scalars().first()

        if graph is not None:
            if graph.deleted_at is not None:
                raise BootstrapConflict(
                    "cleanup_in_progress",
                    "The previous attempt is still being cleaned up. Try again in a few minutes.")
            if graph.kind == "blank":
                raise ValueError("blank models start empty by design; there is nothing to import")
            if graph.main_head_commit_seq > 1:
                return {"graph_id": graph.id, "already_enabled": True}
            job = (await s.execute(select(JobORM).where(
                JobORM.job_type == BOOTSTRAP_JOB_TYPE, JobORM.graph_id == graph.id,
            ).order_by(JobORM.created_at.desc()))).scalars().first()
            if job is not None:
                return {"graph_id": graph.id, "job_id": job.id, "status": _api_status(job),
                        "failure": (job.summary or {}).get("failure")
                        if job.status == "failed" else None}
            main_id = await _main_branch(s, graph.id)
            gid = graph.id
        else:
            res = await GraphVersioningService().create_graph(
                data_source_id=data_source_id, workspace_id=workspace_id, kind=kind,
                actor=actor, falkor_graph_name=falkor_graph_name,
                falkor_provider=falkor_provider, session=s)
            gid, main_id = res["graph_id"], res["main_branch_id"]

        await s.flush()                                   # create_graph's rows are still pending
        ps = await s.get(ProjectionStateORM, gid)
        if ps is not None:
            ps.projected_commit_seq = 1                   # see docstring — never project mid-bootstrap
            ps.target_commit_seq = 1
        commit = await _ensure_import_commit(s, gid, main_id, actor)
        job = JobORM(
            job_type=BOOTSTRAP_JOB_TYPE, graph_id=gid, workspace_id=workspace_id,
            data_source_id=data_source_id, branch_id=main_id, status="pending",
            # What the claim's per-provider cap counts by.
            provider_id=falkor_provider,
            current_phase="counting", idempotency_key=f"bootstrap:{gid}",
            batch_size=config.BOOTSTRAP_SCAN_WIDTH, target_commit_id=commit.id,
            summary={"actor": actor},
        )
        s.add(job)
        await s.flush()
        return {"graph_id": gid, "job_id": job.id, "status": "pending"}


async def bootstrap_status(
    *, data_source_id: str, workspace_id: Optional[str] = None,
) -> Optional[Dict[str, object]]:
    """The data source's latest enablement job, in the shape the UI polls. Read-only.

    Besides progress: ``origin`` (``graph``, or ``package`` for a seed), ``queuedAhead`` (the
    bootstraps a pending job waits behind), ``attempt`` (each claim is one), ``stale`` (running,
    but its worker has not beaten in a takeover's time — it is about to resume elsewhere) and
    ``failure`` (``{code, action, phase, reason}`` — what the user can do about a failed job).
    A job paused by the pre-flight reads as ``needs_decision``, with ``duplicates`` — the counts,
    the fingerprint a decision must carry, a sample, and the ``decision`` once one is recorded for
    this list (``sharedWith`` is the API's to fill: it lives in the management DB). ``rejected``,
    ``collapsed`` and ``rekeyedEdges`` say what the copy turned away, collapsed and re-keyed;
    ``sourceCollapse`` is set once copies may have been removed from the source graph, and stays
    set through a restart — nothing puts them back.

    ``workspace_id`` scopes the lookup for tenant isolation — a graph must belong to the
    workspace in the URL, and existence isn't leaked across tenants (the rest of the
    versioning API enforces the same rule via ``graph_in_workspace``)."""
    async with db.graphver_session() as s:
        conds = [JobORM.job_type == BOOTSTRAP_JOB_TYPE,
                 JobORM.data_source_id == data_source_id]
        if workspace_id is not None:
            conds.append(JobORM.workspace_id == workspace_id)
        job = (await s.execute(select(JobORM).where(*conds
        ).order_by(JobORM.created_at.desc()))).scalars().first()
        if job is None:
            return None
        ahead = None
        if job.status == "pending" and job.current_phase != AWAITING_DECISION:
            ahead = (await s.execute(select(func.count()).select_from(JobORM).where(
                JobORM.job_type == BOOTSTRAP_JOB_TYPE, JobORM.status == "pending",
                JobORM.current_phase.is_distinct_from(AWAITING_DECISION),
                JobORM.created_at < job.created_at))).scalar_one()
        last = datetime.fromisoformat(job.updated_at or job.started_at or job.created_at)
        silent = (datetime.now(timezone.utc) - last).total_seconds()
        summary = job.summary or {}
        duplicates = summary.get("duplicates")
        if duplicates:
            policy = summary.get("duplicatePolicy") or {}
            duplicates = {**duplicates, "sharedWith": [], "sharedWithOtherWorkspaces": 0,
                          "decision": {
                              k: policy.get(k)
                              for k in ("policy", "fingerprint", "decidedBy", "decidedAt")
                          } if policy.get("fingerprint") == duplicates.get("fingerprint")
                          else None}
        rejected = summary.get("rejected")
        return {
            "jobId": job.id, "graphId": job.graph_id, "status": _api_status(job),
            "phase": job.current_phase, "processed": int(job.processed or 0),
            "total": int(job.total or 0), "percent": int(job.progress or 0),
            "startedAt": job.started_at, "updatedAt": job.updated_at,
            "error": job.error_message,
            "report": summary.get("report") if job.status in ("completed", "failed") else None,
            "origin": summary.get("origin") or "graph",
            "queuedAhead": ahead,
            "attempt": int(job.retry_count or 0),
            "stale": job.status == "running" and silent > config.INGEST_STALE_SECS,
            "failure": summary.get("failure") if job.status == "failed" else None,
            "duplicates": duplicates or None,
            "rejected": {k: rejected.get(k, [] if k == "samples" else 0)
                         for k in ("duplicateUrns", "danglingEdges", "samples")}
            if rejected else None,
            "collapsed": summary.get("collapsed"),
            "rekeyedEdges": int(summary.get("rekeyedEdges") or 0),
            "sourceCollapse": summary.get("sourceCollapse"),
        }


async def decide_duplicates(*, data_source_id: str, fingerprint: str, actor: str,
                            workspace_id: Optional[str] = None) -> Dict[str, object]:
    """Record "collapse the duplicates and continue" for a job paused on them, and queue it.

    One locked row, one decision: the job must be paused for exactly this (``not_awaiting_decision``
    otherwise), and ``fingerprint`` must be the list it paused on — a list that changed after the
    manager looked (a re-check found more copies) is refused, ``stale_decision``, never applied to
    copies nobody reviewed. The decision (``summary.duplicatePolicy``) is what the copy then acts
    on, and the copy starts by reading the source again with the pre-flight: a pause can last
    days, and the same list (fingerprint) carries on by itself while a changed one — a copy
    re-synced, a node deleted and its id re-used, another duplicate — pauses again.
    Recording the same decision again — a double click, a retried request — returns
    ``{already: True}`` and changes nothing.

    ``workspace_id`` scopes the job for tenant isolation, as retry and abandon do."""
    async with db.graphver_session() as s:
        job = await _latest_job(s, data_source_id, workspace_id, lock=True)
        if job is None:
            raise ValueError("no enablement job for this data source")
        summary = dict(job.summary or {})
        listed = (summary.get("duplicates") or {}).get("fingerprint")
        if _api_status(job) != "needs_decision":
            if (summary.get("duplicatePolicy") or {}).get("fingerprint") == fingerprint:
                return {"jobId": job.id, "already": True}
            raise BootstrapConflict(
                "not_awaiting_decision",
                "This copy is not waiting for a decision about duplicates any more.")
        if fingerprint != listed:
            raise BootstrapConflict(
                "stale_decision",
                "The list of duplicates changed since it was shown. Review it again.",
                fingerprint=listed)
        dup = summary.get("duplicates") or {}
        summary["duplicatePolicy"] = {
            "policy": "collapse", "rule": dup.get("rule"), "fingerprint": fingerprint,
            "identifiers": dup.get("identifiers"), "extraCopies": dup.get("extraCopies"),
            "decidedBy": actor, "decidedAt": _now()}
        summary.pop("takeovers", None)          # a person chose to go on: a fresh poison count
        job.summary = summary
        _advance_phase(job, "counting")
        job.updated_at = _now()
        logger.info("bootstrap %s: %s decided to collapse %s duplicate cop(ies) (fingerprint %s)",
                    job.id, actor, dup.get("extraCopies"), fingerprint)
        return {"jobId": job.id, "already": False}


async def duplicate_page(*, data_source_id: str, workspace_id: Optional[str] = None,
                         after: Optional[str] = None, limit: int = 100) -> Dict[str, object]:
    """One page of the job's duplicate list, every copy of every duplicated urn in (urn, copy)
    order: ``{items: [{urn, copy, kept, label, internalId, lastSyncedAt}], next}`` — pass ``next``
    back as ``after``; it is None on the last page. A keyset over the duplicates' own partial
    index, so the last page costs what the first does. :class:`LookupError` when the job found no
    duplicates; :class:`ValueError` for a cursor this did not issue."""
    graph_id = await _duplicates_graph(data_source_id, workspace_id)
    key = _decode_cursor(after)
    async with db.graphver_session() as s:
        rows = await _duplicate_rows(s, graph_id, key, limit + 1)
    items = [_copy_row(r) for r in rows[:limit]]
    nxt = _encode_cursor(rows[limit - 1]) if len(rows) > limit else None
    return {"items": items, "next": nxt}


def _csv_text(value: str) -> str:
    """A source-controlled string as a CSV cell a spreadsheet shows as text: a leading ``=``,
    ``+``, ``-``, ``@``, tab or CR would otherwise be run as a formula when the list is opened."""
    return "'" + value if value[:1] in ("=", "+", "-", "@", "\t", "\r") else value


async def duplicates_csv(*, data_source_id: str,
                         workspace_id: Optional[str] = None) -> AsyncIterator[str]:
    """The whole duplicate list as CSV, streamed. :class:`LookupError` (raised here, before the
    first byte) when there is none. Read in pages of 5,000 rows, each in a short session of its
    own, so a long download never holds a connection — or a snapshot — open between pages."""
    graph_id = await _duplicates_graph(data_source_id, workspace_id)

    async def stream() -> AsyncIterator[str]:
        out = io.StringIO()
        writer = csv.writer(out)
        writer.writerow(["urn", "copy", "kept", "reason", "label", "internal_id",
                         "last_synced_at"])
        key = None
        while True:
            async with db.graphver_session() as s:
                rows = await _duplicate_rows(s, graph_id, key, 5000)
            for urn, rank, label, fid, synced in rows:
                writer.writerow([_csv_text(urn), rank, "yes" if rank == 1 else "no",
                                 "kept" if rank == 1 else "collapsed into the copy kept",
                                 _csv_text(label or ""), fid,
                                 synced.isoformat() if synced else ""])
            yield out.getvalue()
            out.seek(0)
            out.truncate()
            if len(rows) < 5000:
                return
            key = (rows[-1][0], rows[-1][1])

    return stream()


async def retry_bootstrap(
    *, data_source_id: str, mode: str = "resume", workspace_id: Optional[str] = None,
) -> Dict[str, object]:
    """``resume`` picks up from the last committed window; ``restart`` throws away what
    was imported and re-reads the source from scratch (for a source that changed
    mid-copy). Neither can touch a graph whose head already flipped.

    Both only RE-QUEUE the job: a restart's deletes are the worker's ``reset`` phase, in
    windows, never this request's. And only a job that has stopped is re-queued — a FAILED one,
    or (to restart) one paused for a decision. Re-queueing a live job would hand it to a second
    worker while the first still runs it; that is :class:`BootstrapConflict` ``job_active``.
    Resuming an integrity failure would only fail the same check again: ``resume_not_possible``
    (restart instead).

    ``workspace_id`` scopes the job for tenant isolation (the API also checks the data
    source belongs to the workspace; this is the belt to that's braces)."""
    async with db.graphver_session() as s:
        conds = [JobORM.job_type == BOOTSTRAP_JOB_TYPE,
                 JobORM.data_source_id == data_source_id]
        if workspace_id is not None:
            conds.append(JobORM.workspace_id == workspace_id)
        # Locked, so the check and the re-queue are one decision against one row.
        job = (await s.execute(select(JobORM).where(*conds).order_by(
            JobORM.created_at.desc()).limit(1).with_for_update())).scalars().first()
        if job is None:
            raise ValueError("no enablement job for this data source")
        if job.status == "completed":
            return {"jobId": job.id, "status": "completed"}
        graph = await s.get(GraphORM, job.graph_id)
        if graph is not None and graph.main_head_commit_seq > 1:
            return {"jobId": job.id, "status": "completed"}
        paused = job.status == "pending" and job.current_phase == AWAITING_DECISION
        if not (job.status == "failed" or (mode == "restart" and paused)):
            raise BootstrapConflict(
                "job_active", "Enabling version control is still under way for this data source; "
                              "it can be retried once it stops.")
        summary = dict(job.summary or {})
        if mode == "resume" and (summary.get("failure") or {}).get("code") == "integrity":
            raise BootstrapConflict(
                "resume_not_possible",
                "Resuming would fail the same check again. Start over to re-read the source.",
                action="restart")
        if mode == "restart":
            _advance_phase(job, "reset")
            summary = {k: v for k, v in summary.items() if k in _KEPT_ON_RESTART}
            job.processed = 0
            job.progress = 0
        summary.pop("failure", None)
        summary.pop("takeovers", None)          # a person chose to go again: a fresh poison count
        job.summary = summary
        job.status = "pending"
        job.error_message = None
        job.completed_at = None
        job.updated_at = _now()
        return {"jobId": job.id, "status": "pending", "mode": mode}


async def abandon_bootstrap(
    *, data_source_id: str, workspace_id: Optional[str] = None, actor: str = "system",
) -> Dict[str, object]:
    """Give up on enablement and leave the data source exactly as it was: the graph shell
    and everything the job imported are removed, so it reads as un-versioned again.
    Refuses once the head has flipped (that graph is live — use the versioning UI). One thing is
    not put back: duplicate copies a decided collapse already deleted from the SOURCE graph
    (``backfill:dupes``) — the decision says so up front, and its CSV is the record of them.

    Off the request, and safe while a worker is mid-copy. ONE transaction cancels the job —
    which fences its worker: every job-row write it makes is a compare-and-set on a RUNNING job
    at its epoch, so its in-flight window rolls back — and soft-deletes the graph and queues its
    purge (``purge_worker.create_purge_job``). The purge removes the shell and the copy in
    windows on the worker; from this commit on the graph resolves as no graph at all, and
    enabling again waits for the purge (``cleanup_in_progress``). Idempotent: abandoning again
    returns the purge already queued — or, if it failed, queues it again.

    ``workspace_id`` scopes the job for tenant isolation — this call DELETES a graph, so it
    must never act on another tenant's data source id."""
    async with db.graphver_session() as s:
        conds = [JobORM.job_type == BOOTSTRAP_JOB_TYPE,
                 JobORM.data_source_id == data_source_id]
        if workspace_id is not None:
            conds.append(JobORM.workspace_id == workspace_id)
        job = (await s.execute(select(JobORM).where(*conds).order_by(
            JobORM.created_at.desc()).limit(1).with_for_update())).scalars().first()
        if job is None:
            raise ValueError("no enablement job for this data source")
        graph = await s.get(GraphORM, job.graph_id)
        if graph is not None and graph.main_head_commit_seq > 1:
            raise ConcurrencyError("version control is already enabled for this data source")
        if job.status != "cancelled":
            job.status = "cancelled"              # fences the worker
            job.completed_at = job.updated_at = _now()
        purge_id = await create_purge_job(
            graph_id=job.graph_id, workspace_id=job.workspace_id, actor=actor,
            data_source_id=job.data_source_id, session=s)
        logger.info("bootstrap %s abandoned; graph %s queued for purge (%s)",
                    job.id, job.graph_id, purge_id)
        return {"jobId": job.id, "status": "cancelled", "purgeJobId": purge_id}


async def _ensure_import_commit(s, graph_id: str, main_id: str, actor: str) -> CommitORM:
    """The seq-2 ``import`` commit the windows write into. Created up front (head stays
    at genesis) so every version row has its commit, and idempotent on re-enqueue."""
    commit = (await s.execute(select(CommitORM).where(
        CommitORM.graph_id == graph_id,
        CommitORM.idempotency_key == f"bootstrap:{graph_id}",
    ))).scalars().first()
    if commit is not None:
        return commit
    branch = await s.get(BranchORM, main_id)
    commit = CommitORM(
        graph_id=graph_id, branch_id=main_id, commit_seq=2,
        parent_commit_id=branch.head_commit_id, kind="import",
        message="enable version control", actor=actor,
        idempotency_key=f"bootstrap:{graph_id}",
    )
    s.add(commit)
    await s.flush()
    return commit


async def _main_branch(s, graph_id: str) -> str:
    return (await s.execute(select(BranchORM.id).where(
        BranchORM.graph_id == graph_id, BranchORM.kind == "main"))).scalars().one()


# --------------------------------------------------------------------------- #
# Errors + helpers                                                             #
# --------------------------------------------------------------------------- #
class BootstrapFailure(Exception):
    """A job failed for a reason we can explain to the user in plain language."""

    def __init__(self, reason: str, code: str = "integrity"):
        super().__init__(reason)
        self.reason, self.code = reason, code


class BootstrapConflict(Exception):
    """The job's state refuses this request (``job_active``, ``resume_not_possible``,
    ``cleanup_in_progress``). The API answers 409 with :attr:`detail` — ``{type, message, …}`` —
    so the UI can say why, and offer what IS possible."""

    def __init__(self, kind: str, message: str, **extra):
        super().__init__(message)
        self.detail = {"type": kind, "message": message, **extra}


def _phase_start(phase: str) -> Dict[str, Any]:
    """The job columns at the START of ``phase``: no cursor, and the full scan width — each phase
    re-learns its own window size (edge payloads are a different weight from node payloads)."""
    return {"current_phase": phase, "last_cursor": None, "batch_size": config.BOOTSTRAP_SCAN_WIDTH}


def _advance_phase(job: JobORM, phase: str) -> None:
    """Put ``job`` at the START of ``phase`` (:func:`_phase_start`). The one way a bootstrap
    changes phase: the worker's advance (after its compare-and-set), a restart's ``reset``, the
    pre-flight's pause, a decision, and a re-check of a source that changed all go through here
    (the worker's own as checkpoint values, so the change is fenced with its work)."""
    for column, value in _phase_start(phase).items():
        setattr(job, column, value)


def _api_status(job: JobORM) -> str:
    """The status the API reports: a job paused for a decision is stored as pending (every
    "is a job in flight?" check must still see it) but reads as ``needs_decision``."""
    if job.status == "pending" and job.current_phase == AWAITING_DECISION:
        return "needs_decision"
    return job.status


def _explain_failed_checks(failed: List[dict]) -> str:
    """Most specific, most actionable cause first. A data-quality problem in the source
    also trips the generic "didn't match" checks (a duplicate identifier, for instance,
    makes the re-read sample disagree too) — saying "the graph changed" there would send
    the user chasing the wrong thing."""
    keys = {c["key"] for c in failed}
    if "no_duplicate_items" in keys:
        return ("Some items in the source graph share an identifier that the check before "
                "copying did not see — the source changed while it was copied. Start over to "
                "check it again.")
    if "duplicates_resolved" in keys:
        return ("Some duplicated items have no copy left to keep: the source graph changed "
                "while it waited for the decision. Start over to check it again.")
    if {"no_dropped_connections", "referentially_whole"} & keys:
        return ("Some connections point at items that don't exist in the source graph, so the "
                "copy would lose them.")
    if {"nodes_seen", "edges_seen", "sample_matches", "source_stable"} & keys:
        return ("The source graph changed while we were copying it, so the copy can't be "
                "trusted. Retry when the graph is quiet.")
    return "The copy didn't match the source graph exactly, so it was not applied."


# ---------------------------------------------------------------------------- #
# Transient vs. terminal (``job_lease.is_transient``) — and which faults SHRINK  #
# ---------------------------------------------------------------------------- #
def _is_timeout(exc: BaseException) -> bool:
    """A TIMEOUT, as opposed to a broken pipe — the difference decides whether SHRINKING the
    window is a sane response, and the two are easy to conflate.

    "The server did not answer in time" has two causes that look identical from here: the
    server is in trouble (wait), or the question we asked was too big for it right now
    (shrink). The second is real and not rare — a scan window sized for a healthy server can
    stop coming back at all once that server is under memory pressure, which is exactly what
    a busy FalkorDB does. Shrinking is harmless if the cause was an outage, and it is the
    ONLY thing that helps if the cause was us. So a timeout shrinks first and waits second.

    A broken pipe is not ambiguous: no window is small enough to travel down a dead socket.
    """
    blurb = f"{type(exc).__name__}: {exc}".lower()
    return "timeout" in blurb or "timed out" in blurb


def _tally_matches(pg: Dict[str, int], src: Dict[str, int], *, allow_lower: bool = False) -> bool:
    """Every source type is present with the right count. `allow_lower` tolerates the
    parallel-connection merge (indistinguishable duplicates the read layer also merges)."""
    for k, v in src.items():
        got = int(pg.get(k, 0))
        if got == int(v):
            continue
        if allow_lower and 0 < got < int(v):
            continue
        return False
    return True


def _add_reject_sample(rejects: dict, item: dict) -> None:
    if len(rejects.get("samples") or []) < 10:
        rejects.setdefault("samples", []).append(item)


def _merge_scan_summary(summary: dict, kind: str, *, scanned: int, written: int,
                        tallies: dict, rejects: dict, sample, dupes: int,
                        written_tallies: Optional[dict] = None, collapsed: Optional[dict] = None,
                        self_loops: int = 0, rekeyed: int = 0) -> dict:
    """Add one window's tallies to the job's. ``tallies`` / ``written_tallies`` are per label
    (nodes) or per type (edges): what was scanned, and what landed; ``collapsed`` the copies a
    duplicate decision skipped, per label; ``self_loops`` the edges between two copies of one urn;
    ``rekeyed`` the edges whose id clashed with a node's."""
    sc = dict(summary.get("scanned") or {"nodes": 0, "edges": 0, "byLabel": {}, "byType": {}})
    wr = dict(summary.get("written") or {"nodes": 0, "edges": 0})
    rj = dict(summary.get("rejected") or {"duplicateUrns": 0, "danglingEdges": 0, "samples": []})
    cl = dict(summary.get("collapsed") or {"nodes": 0, "byLabel": {}, "selfLoops": 0})
    sc[kind] = int(sc.get(kind, 0)) + scanned
    wr[kind] = int(wr.get(kind, 0)) + written
    bucket = "byLabel" if kind == "nodes" else "byType"
    sc[bucket] = _add_tally(sc.get(bucket), tallies)
    wr[bucket] = _add_tally(wr.get(bucket), written_tallies)
    for k in ("duplicateUrns", "danglingEdges"):
        rj[k] = int(rj.get(k, 0)) + int((rejects or {}).get(k, 0))
    if (rejects or {}).get("byLabel"):
        rj["byLabel"] = _add_tally(rj.get("byLabel"), rejects["byLabel"])
    for s in (rejects or {}).get("samples") or []:
        _add_reject_sample(rj, s)
    cl["byLabel"] = _add_tally(cl.get("byLabel"), collapsed)
    cl["nodes"] = int(cl.get("nodes", 0)) + sum((collapsed or {}).values())
    cl["selfLoops"] = int(cl.get("selfLoops", 0)) + int(self_loops or 0)
    summary["scanned"], summary["written"], summary["rejected"] = sc, wr, rj
    summary["collapsed"] = cl
    summary["collapsedParallelEdges"] = int(summary.get("collapsedParallelEdges", 0)) + int(dupes or 0)
    summary["rekeyedEdges"] = int(summary.get("rekeyedEdges", 0)) + int(rekeyed or 0)
    if sample is not None:
        summary["sample"] = sample
    return summary


def _add_tally(into: Optional[dict], more: Optional[dict]) -> dict:
    out = dict(into or {})
    for k, v in (more or {}).items():
        out[k] = int(out.get(k, 0)) + int(v)
    return out


def _bump(tally: Dict[str, int], key: str) -> None:
    tally[key] = tally.get(key, 0) + 1


def _same_tally(a: Optional[dict], b: Optional[dict]) -> bool:
    """Equal as counts — a type tallied at 0 is the same as one never tallied."""
    return ({k: int(v) for k, v in (a or {}).items() if int(v)}
            == {k: int(v) for k, v in (b or {}).items() if int(v)})


def _tally_checks(summary: dict, pg_labels: Dict[str, int], pg_types: Dict[str, int]) -> List[dict]:
    """The counting half of validation: what the source held, what was scanned, what was turned
    away, collapsed or merged, and what landed — each reconciled with the next. Every scanned row
    is in exactly ONE of: written, collapsed (a decided duplicate copy; a collapse self-loop),
    rejected (a duplicate nobody decided about; a dangling edge) or merged (a parallel edge) — so
    each formula subtracts each once.

    A job whose pre-flight predates ``source.maxNodeId`` tallied less, and is checked as it
    always was."""
    src = summary.get("source") or {}
    scanned = summary.get("scanned") or {}
    written = summary.get("written") or {}
    rejected = summary.get("rejected") or {}
    collapsed = summary.get("collapsed") or {}
    checks: List[dict] = []

    def check(key: str, ok: bool, detail: str, blocking: bool = True) -> None:
        checks.append({"key": key, "ok": bool(ok), "detail": detail, "blocking": blocking})

    # 1. Everything in the source was seen.
    check("nodes_seen", scanned.get("nodes") == src.get("nodes"),
          f"scanned {scanned.get('nodes'):,} of {src.get('nodes'):,} items")
    check("edges_seen", scanned.get("edges") == src.get("edges"),
          f"scanned {scanned.get('edges'):,} of {src.get('edges'):,} connections")
    # 2. Nothing was silently dropped on the way in.
    check("no_duplicate_items", int(rejected.get("duplicateUrns", 0)) == 0,
          f"{rejected.get('duplicateUrns', 0)} item(s) sharing an identifier")
    check("no_dropped_connections", int(rejected.get("danglingEdges", 0)) == 0,
          f"{rejected.get('danglingEdges', 0)} connection(s) with a missing endpoint")
    # 3. What we wrote reconciles exactly with what we saw.
    exp_nodes = (int(scanned.get("nodes", 0)) - int(collapsed.get("nodes", 0))
                 - int(rejected.get("duplicateUrns", 0)))
    exp_edges = (int(scanned.get("edges", 0)) - int(rejected.get("danglingEdges", 0))
                 - int(summary.get("collapsedParallelEdges", 0))
                 - int(collapsed.get("selfLoops", 0)))
    check("nodes_written", written.get("nodes") == exp_nodes,
          f"{written.get('nodes'):,} items stored")
    check("edges_written", written.get("edges") == exp_edges,
          f"{written.get('edges'):,} connections stored")
    # 4. Types survived — per label and per relationship type.
    src_labels = dict(scanned.get("byLabel") or {})
    src_types = dict(scanned.get("byType") or {})
    if "maxNodeId" in src:
        kept = _add_tally(src_labels, {k: -int(v) for k, v in _add_tally(
            collapsed.get("byLabel"), rejected.get("byLabel")).items()})
        labels_ok = (_same_tally(pg_labels, written.get("byLabel"))
                     and _same_tally(kept, written.get("byLabel")))
        types_ok = (_tally_matches(pg_types, src_types, allow_lower=True)
                    and _same_tally(pg_types, written.get("byType")))
    else:
        labels_ok = _tally_matches(pg_labels, src_labels)
        types_ok = _tally_matches(pg_types, src_types, allow_lower=True)
    check("labels_preserved", labels_ok, f"{len(src_labels)} item type(s) preserved")
    check("types_preserved", types_ok, f"{len(src_types)} relationship type(s) preserved")
    # 5. The duplicates went as decided. Informational once decided — a copy deleted from the
    #    source while the job waited simply isn't there to collapse.
    dup = summary.get("duplicates")
    if dup:
        decided = (summary.get("duplicatePolicy") or {}).get("fingerprint") == dup.get("fingerprint")
        check("duplicates_collapsed", int(collapsed.get("nodes", 0)) == int(dup.get("extraCopies", 0)),
              f"{int(collapsed.get('nodes', 0)):,} duplicate cop(ies) of "
              f"{int(dup.get('identifiers', 0)):,} identifier(s) collapsed into the copy kept",
              blocking=not decided)
    return checks


def _rekey(dicts: List[dict], clash: Set[str], commit_id: str) -> int:
    """Re-key the edge rows whose id is in ``clash`` (a node's id) to ``edge:<id>``; how many."""
    n = 0
    for d in dicts:
        if d["entity_id"] in clash:
            d["entity_id"] = f"edge:{d['entity_id']}"
            d["id"] = _vid("evb", commit_id, d["entity_id"])
            n += 1
    return n


def _edge_target() -> int:
    """Edges per edge-scan window: the configured target, within the cap on property rows."""
    return min(config.BOOTSTRAP_EDGE_TARGET, _PROPS_ROWS_CAP)


async def _backfill_pause() -> None:
    await asyncio.sleep(max(0, config.BOOTSTRAP_BACKFILL_PAUSE_MS) / 1000.0)


def _collapse_decided(summary: dict) -> bool:
    """A decided collapse with copies to remove from the source graph."""
    dup = summary.get("duplicates") or {}
    return bool(summary.get("duplicatePolicy") and int(dup.get("extraCopies") or 0))


# ------------------------------------------------------------- pre-flight helpers --
def _fresh_tallies(max_id: Optional[int]) -> dict:
    """A job's tallies before anything is read: the source's own (counted by the pre-flight) and
    the copy's (counted by the windows)."""
    return {
        "source": {"nodes": 0, "edges": 0, "invisibleNodes": 0, "invisibleEdges": 0,
                   "maxNodeId": max_id},
        "scanned": {"nodes": 0, "edges": 0, "byLabel": {}, "byType": {}},
        "written": {"nodes": 0, "edges": 0, "byLabel": {}, "byType": {}},
        "rejected": {"duplicateUrns": 0, "danglingEdges": 0, "byLabel": {}, "samples": []},
        "collapsed": {"nodes": 0, "byLabel": {}, "selfLoops": 0},
        "collapsedParallelEdges": 0,
        "rekeyedEdges": 0,
        "sample": {"nodes": [], "nodesSeen": 0},
    }


def _preflight_rows(rows, graph_id: str) -> Tuple[List[dict], int, int]:
    """A pre-flight window's ``bootstrap_nodes`` rows, and its (visible, invisible) node counts.
    Derived bookkeeping nodes are neither."""
    records: List[dict] = []
    visible = invisible = 0
    for fid, labels, urn, synced in rows:
        if any(lab in _DERIVED_LABELS for lab in labels or []):
            continue
        if not urn:                     # no urn, or an empty one: the reader does not see it
            invisible += 1
            continue
        visible += 1
        records.append({"graph_id": graph_id, "falkor_id": int(fid), "urn": str(urn),
                        "label": _label_of(labels), "last_synced_at": _normalize_synced_at(synced),
                        "copy_rank": None})
    return records, visible, invisible


def _normalize_synced_at(value) -> Optional[datetime]:
    """A source node's ``lastSyncedAt`` as an aware datetime, so the duplicate ranking is
    chronological: ISO 8601 (``Z``, an offset, a space for the ``T``, or a bare date; no zone means
    UTC) and epoch seconds or milliseconds (a number, or a numeric string). Anything else is None
    — it ranks after every copy that has a usable time."""
    if value is None or isinstance(value, bool):
        return None
    if isinstance(value, datetime):
        return value if value.tzinfo else value.replace(tzinfo=timezone.utc)
    if isinstance(value, str):
        text_value = value.strip()
        try:
            value = float(text_value)
        except ValueError:
            try:
                parsed = datetime.fromisoformat(
                    text_value[:-1] + "+00:00" if text_value.endswith(("Z", "z")) else text_value)
            except ValueError:
                return None
            return parsed if parsed.tzinfo else parsed.replace(tzinfo=timezone.utc)
    if isinstance(value, (int, float)):
        # Past 1e11 a number is milliseconds: as seconds it would be the year 5138.
        seconds = value / 1000.0 if abs(value) >= 1e11 else float(value)
        try:
            return datetime.fromtimestamp(seconds, tz=timezone.utc)
        except (OverflowError, OSError, ValueError):
            return None
    return None


def _rank_duplicates_sql():
    """Rank the copies of every urn the source holds more than once — and only those."""
    t = _t("bootstrap_nodes")
    return text(
        f"WITH d AS (SELECT urn FROM {t} WHERE graph_id = :g GROUP BY urn HAVING count(*) > 1), "
        "r AS (SELECT b.falkor_id, row_number() OVER (PARTITION BY b.urn "
        "      ORDER BY b.last_synced_at DESC NULLS LAST, b.falkor_id) AS rank "
        f"     FROM {t} b JOIN d ON d.urn = b.urn WHERE b.graph_id = :g) "
        f"UPDATE {t} x SET copy_rank = r.rank FROM r "
        "WHERE x.graph_id = :g AND x.falkor_id = r.falkor_id")


async def _duplicate_summary(s, graph_id: str) -> Optional[dict]:
    """``summary.duplicates`` for the ranked list, or None when there are none: how many urns and
    extra copies, how many urns' copies share one label (``sameType``) or not (``crossType``), the
    rule, the FINGERPRINT (md5 over every urn|id|rank, in order — the list a decision is bound to)
    and the first 20 copies."""
    t = _t("bootstrap_nodes")
    head = (await s.execute(text(
        "SELECT count(DISTINCT urn), count(*) FILTER (WHERE copy_rank > 1), "
        "md5(string_agg(urn || '|' || falkor_id || '|' || copy_rank, ',' "
        "ORDER BY urn, copy_rank)) "
        f"FROM {t} WHERE graph_id = :g AND copy_rank IS NOT NULL"), {"g": graph_id})).one()
    if not head[0]:
        return None
    kinds = (await s.execute(text(
        "SELECT count(*) FILTER (WHERE n = 1), count(*) FILTER (WHERE n > 1) FROM ("
        f"SELECT count(DISTINCT coalesce(label, '')) AS n FROM {t} "
        "WHERE graph_id = :g AND copy_rank IS NOT NULL GROUP BY urn) k"), {"g": graph_id})).one()
    sample = await _duplicate_rows(s, graph_id, None, 20)
    return {"identifiers": int(head[0]), "extraCopies": int(head[1] or 0),
            "sameType": int(kinds[0] or 0), "crossType": int(kinds[1] or 0),
            "rule": DUPLICATE_RULE, "fingerprint": head[2], "detectedAt": _now(),
            "sample": [_copy_row(r) for r in sample]}


async def _duplicate_rows(s, graph_id: str, after: Optional[Tuple[str, int]], limit: int):
    """Copies of duplicated urns in (urn, copy) order, after the keyset ``after``:
    (urn, copy_rank, label, falkor_id, last_synced_at)."""
    keyset = "AND (urn, copy_rank) > (:u, :r) " if after else ""
    params: Dict[str, Any] = {"g": graph_id, "n": limit}
    if after:
        params.update(u=after[0], r=after[1])
    return (await s.execute(text(
        "SELECT urn, copy_rank, label, falkor_id, last_synced_at "
        f'FROM {_t("bootstrap_nodes")} WHERE graph_id = :g AND copy_rank IS NOT NULL '
        f"{keyset}ORDER BY urn, copy_rank LIMIT :n"), params)).all()


def _copy_row(row) -> dict:
    urn, rank, label, fid, synced = row
    return {"urn": urn, "copy": int(rank), "kept": int(rank) == 1, "label": label,
            "internalId": int(fid), "lastSyncedAt": synced.isoformat() if synced else None}


def _encode_cursor(row) -> str:
    return base64.urlsafe_b64encode(json.dumps([row[0], int(row[1])]).encode()).decode()


def _decode_cursor(after: Optional[str]) -> Optional[Tuple[str, int]]:
    if not after:
        return None
    try:
        urn, rank = json.loads(base64.urlsafe_b64decode(after.encode()).decode())
        return str(urn), int(rank)
    except (ValueError, TypeError) as exc:
        raise ValueError("not a cursor this list issued") from exc


async def _latest_job(s, data_source_id: str, workspace_id: Optional[str], *,
                      lock: bool = False) -> Optional[JobORM]:
    """The data source's latest enablement job, scoped to ``workspace_id`` when given."""
    conds = [JobORM.job_type == BOOTSTRAP_JOB_TYPE, JobORM.data_source_id == data_source_id]
    if workspace_id is not None:
        conds.append(JobORM.workspace_id == workspace_id)
    stmt = select(JobORM).where(*conds).order_by(JobORM.created_at.desc()).limit(1)
    return (await s.execute(stmt.with_for_update() if lock else stmt)).scalars().first()


async def _duplicates_graph(data_source_id: str, workspace_id: Optional[str]) -> str:
    async with db.graphver_session() as s:
        job = await _latest_job(s, data_source_id, workspace_id)
    if job is None or not (job.summary or {}).get("duplicates"):
        raise LookupError("enabling version control found no duplicate identifiers here")
    return job.graph_id


# ------------------------------------------------------------ collapse helpers --
def _copy_groups(rows, *, drop_last: bool) -> List[dict]:
    """A dupes window's rows — (urn, falkor_id, label, copy_rank), in (urn, rank) order — as one
    group per urn: ``{urn, kept: (id, label), discarded: [(id, label)], skip: {every copy's id}}``.
    ``drop_last`` drops the last urn (the page may have cut it short) unless it is the only one."""
    groups: List[dict] = []
    for urn, fid, label, rank in rows:
        if not groups or groups[-1]["urn"] != urn:
            groups.append({"urn": urn, "kept": None, "discarded": [], "skip": set()})
        g = groups[-1]
        g["skip"].add(int(fid))
        if int(rank) == 1:
            g["kept"] = (int(fid), label)
        else:
            g["discarded"].append((int(fid), label))
    if drop_last and len(groups) > 1:
        groups.pop()
    return groups


def _discarded_by_label(groups: List[dict]) -> Dict[Optional[str], List[dict]]:
    out: Dict[Optional[str], List[dict]] = {}
    for g in groups:
        for fid, label in g["discarded"]:
            out.setdefault(label, []).append({"urn": g["urn"], "lid": fid})
    return out


def _fit_groups(groups: List[dict], rels: Dict[int, Any], cap: int) -> List[dict]:
    """The leading urns whose writes — a relationship moved, a copy deleted — fit ``cap``; at
    least the first, however many it needs."""
    kept: List[dict] = []
    writes = 0
    for g in groups:
        writes += sum(len(rels.get(fid, ())) + 1 for fid, _label in g["discarded"])
        if kept and writes > cap:
            break
        kept.append(g)
    return kept


def _percent(kind: str, processed: int, total: Optional[int]) -> int:
    if not total:
        return _PHASE_FLOOR[kind]
    frac = min(1.0, max(0.0, processed / float(total)))
    return int(_PHASE_FLOOR["nodes"] + frac * _SCAN_SPAN)


def _next_phase(phase: str) -> Optional[str]:
    i = PHASES.index(phase)
    return PHASES[i + 1] if i + 1 < len(PHASES) else None


def _t(table: str) -> str:
    return f'"{config.graphver_schema()}"."{table}"'


def _now_minus(secs: int) -> str:
    from datetime import datetime, timedelta, timezone
    return (datetime.now(timezone.utc) - timedelta(seconds=secs)).isoformat()


async def _ontology_rules(job_id: str):
    """The data source's assigned ontology rules, so OUR copy is written in canonical
    casing from its first commit (same seed canonicalization the old path did). None
    when no ontology is explicitly assigned — legacy graphs are never retro-gated."""
    async with db.graphver_session() as s:
        job = await s.get(JobORM, job_id)
        ds_id, ws_id = (job.data_source_id, job.workspace_id) if job else (None, None)
    if not ds_id:
        return None
    try:
        from backend.app.db.engine import get_async_session
        from backend.app.db.repositories.data_source_repo import get_data_source_orm
        from backend.app.ontology.adapters.sqlalchemy_repo import SQLAlchemyOntologyRepository
        from backend.app.ontology.rules import resolved_ontology_to_rules
        from backend.app.ontology.service import LocalOntologyService
        async with get_async_session() as s:
            ds = await get_data_source_orm(s, ds_id)
            if ds is None or not ds.ontology_id:
                return None
            ont = LocalOntologyService(SQLAlchemyOntologyRepository(s))
            resolved = await ont.resolve(workspace_id=ws_id, data_source_id=ds_id)
            return resolved_ontology_to_rules(resolved)
    except Exception:                                          # pragma: no cover - best effort
        logger.exception("bootstrap %s: ontology rules unavailable; using source spellings", job_id)
        return None
