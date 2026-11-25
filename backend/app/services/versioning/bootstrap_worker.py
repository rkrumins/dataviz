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

**A new data source seeded from a view package** is this same job with ``summary.origin =
'package'`` (``package_seed``): the source is the package's data instead of a FalkorDB graph, and
its target is a brand-new, empty key, so the copy is projected into it (``index``, ``project``)
rather than backfilled. ``reset``, ``heads``, ``merkle`` and ``finalize`` are shared.
"""
from __future__ import annotations

import asyncio
import base64
import contextlib
import copy
import csv
import functools
import hashlib
import inspect
import io
import json
import logging
import random
import time
from dataclasses import dataclass, field
from datetime import datetime, timezone
from hashlib import blake2b
from typing import Any, AsyncIterator, Dict, List, Optional, Sequence, Set, Tuple

from sqlalchemy import func, select, text
from sqlalchemy.dialects.postgresql import insert as pg_insert
from sqlalchemy.exc import IntegrityError

from backend.app.providers.falkordb_provider import _edge_from_row, _json_object

from . import config, db, job_lease
from .entity_serde import (
    SOURCE_DERIVED_NODE_KEYS,
    SOURCE_KEY_PREFIX,
    edge_to_payload,
    source_node_payload,
    storable,
)
from .falkor_indexes import ensure_urn_indexes
from .job_lease import AWAITING_DECISION, Draining, Lease, Superseded
from .job_lease import friendly_infra_error as _friendly_infra_error
from .job_lease import is_transient as _is_transient
from .merkle import content_hash
from .merkle_store import MerkleStore
from . import provenance
from .provenance import commit_provenance
from .models import (
    BootstrapNodeORM,
    BootstrapReviewORM,
    BranchORM,
    CommitORM,
    EdgeVersionORM,
    GraphORM,
    JobORM,
    NodeVersionORM,
    ProjectionStateORM,
    _now,
)
from .ontology import canonicalize_payload_types
from .projection import _graph_edge_id, _q, _READ_TIMEOUT_MS, _WRITE_TIMEOUT_MS
from .purge_worker import create_purge_job, delete_window
from .service import (
    ConcurrencyError,
    GraphVersioningService,
    _chunks,
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
PHASES = ("reset", "counting", "nodes", "edges", "connections", "resolve", "validate", "heads",
          "merkle", "backfill", "finalize")
# A package seed (``package_seed``) writes a brand-new key instead of backfilling a source graph:
# its urn indexes are made (and waited for) first, then the copy is projected into it — all before
# `finalize` flips the head, so the source goes live with its graph in place.
PACKAGE_PHASES = ("reset", "counting", "nodes", "edges", "validate", "heads", "merkle", "index",
                  "project", "finalize")
_PHASES_BY_ORIGIN = {"graph": PHASES, "package": PACKAGE_PHASES}

# Percent shown to the user. Scanning dominates the wall clock, so it owns the bulk
# of the bar; the tail phases are bounded work with honest, distinct labels.
_PHASE_FLOOR = {"reset": 0, "counting": 0, "nodes": 2, "edges": 2, "connections": 72,
                "resolve": 72, "validate": 72,
                "heads": 76, "merkle": 88, "backfill": 92, "index": 89, "project": 90,
                "finalize": 98}
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
    ("bootstrap_review", "graph_id, kind, entity_id, seq", ""),
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
                    "sourceCollapse", "identityStamped")

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
# Backfill: idempotent, and scoped to the same entities we copied. Each says how many keys it
# set: a window with nothing left to stamp (any graph the platform wrote) held no write lock worth
# pausing after. A node's anchor is its new id, its urn: one a projection left from an earlier
# graph of this key is put right, or the tombstone sweep, which matches on it, misses its deletes.
_BACKFILL_NODES = (
    f"MATCH (n) WHERE ID(n) >= $lo AND ID(n) < $hi AND {_not_derived('n')} "
    "AND n.urn IS NOT NULL AND (n.entityId IS NULL OR n.entityId <> n.urn) "
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


# One INSERT per window — a graph's copy and a package seed's alike: the rows as typed columns,
# unnested server-side. A multi-row VALUES of the same rows is ~2,000 rows per statement (the
# bind-parameter cap) and SQLAlchemy compiles each on the event loop — measured at 5.7 s of loop
# per 20,000-row window, every other job on the worker waiting it out. Here the statement is one
# constant string and the columns are built off the loop.
_VERSION_COLUMNS = {
    "nodes": (("id", "text"), ("entity_id", "text"), ("content_hash", "text"),
              ("payload", "text"), ("urn", "text"), ("entity_type", "text"),
              ("display_name", "text"), ("qualified_name", "text")),
    "edges": (("id", "text"), ("entity_id", "text"), ("content_hash", "text"),
              ("payload", "text"), ("source_entity_id", "text"), ("target_entity_id", "text"),
              ("edge_type", "text"), ("confidence", "float8"), ("discriminator", "text")),
}


def _versions_insert_sql(kind: str):
    cols = _VERSION_COLUMNS[kind]
    names = [c for c, _type in cols]
    picked = ", ".join(f"CAST(v.{c} AS jsonb)" if c == "payload" else f"v.{c}" for c in names)
    arrays = ", ".join(f"CAST(:{c} AS {t}[])" for c, t in cols)
    table = "node_versions" if kind == "nodes" else "edge_versions"
    return text(
        f'INSERT INTO {_t(table)} (graph_id, commit_id, commit_seq, branch_id, op, '
        f"prev_content_hash, actor, created_at, {', '.join(names)}) "
        f"SELECT :graph_id, :commit_id, :commit_seq, :branch_id, 'create', NULL, :actor, "
        f":created_at, {picked} FROM unnest({arrays}) AS v({', '.join(names)}) "
        "ON CONFLICT (graph_id, id) DO NOTHING RETURNING entity_id")


def _version_columns(kind: str, dicts: List[dict]) -> Dict[str, list]:
    """The rows as one list per column, payloads as JSON text (cast to jsonb by the statement)."""
    return {c: [json.dumps(d[c]) if c == "payload" else d[c] for d in dicts]
            for c, _type in _VERSION_COLUMNS[kind]}


async def _insert_versions(s, kind: str, ctx, graph_id: str, dicts: List[dict]) -> Set[str]:
    """Insert a window's version rows (``kind`` ``nodes``|``edges``; every row of the import
    commit, made in one window), skipping any whose id is stored already; the entity ids that
    landed."""
    if not dicts:
        return set()
    columns = await asyncio.to_thread(_version_columns, kind, dicts)
    res = await s.execute(_versions_insert_sql(kind), {
        "graph_id": graph_id, "commit_id": ctx.commit_id, "commit_seq": ctx.commit_seq,
        "branch_id": ctx.main_id, "actor": ctx.actor, "created_at": dicts[0]["created_at"],
        **columns})
    return set(res.scalars().all())


async def _land_every_edge(s, ctx, graph_id: str, dicts: List[dict],
                           landed: Set[str]) -> Tuple[int, Set[str]]:
    """Give each edge row that didn't land — its id is a connection's an earlier window copied —
    an id of its own (:func:`_own_id`) and insert it again, until every one has landed: another
    connection that shares a source id, or another version of one, is never dropped. Returns how
    many were re-keyed, and every entity id that landed."""
    taken = {d["entity_id"] for d in dicts}
    left = [d for d in dicts if d["entity_id"] not in landed]
    moved = 0
    for _attempt in range(8):
        if not left:
            return moved, landed
        for d in left:
            d["entity_id"] = _own_id(d["entity_id"], taken)
            d["id"] = _vid("evb", ctx.commit_id, d["entity_id"])
            taken.add(d["entity_id"])
        moved += len(left)
        landed = landed | await _insert_versions(s, "edges", ctx, graph_id, left)
        left = [d for d in left if d["entity_id"] not in landed]
    raise BootstrapFailure("Some connections could not be given an id of their own, so the copy "
                           "would lose them. Start over; if it happens again, report it.",
                           "internal")


async def _insert_review(s, rows: List[dict]) -> None:
    """Hold rows for the review (``bootstrap_review``), in the window's own transaction; a row a
    replayed window held already is kept as it is."""
    for chunk in _chunks(rows, 1000):
        await s.execute(pg_insert(BootstrapReviewORM).values(list(chunk)).on_conflict_do_nothing())


def _readable(props: dict) -> dict:
    """A source node's properties as the node model takes them: a ``lastSyncedAt`` some loader
    stored as a bare epoch number, as its text. The model takes a string and the reader drops a
    node it cannot build, but the pre-flight ranked that copy by its time — and may keep it."""
    synced = props.get("lastSyncedAt")
    if synced is not None and not isinstance(synced, str):
        props["lastSyncedAt"] = str(synced)
    return props


def _node_payload(props: dict, label: Optional[str], rules) -> Optional[dict]:
    """A source node (``properties(n)`` and its label) as the payload history keeps — every
    property it holds (``entity_serde.source_node_payload``), its type in the ontology's spelling.
    None when it has no urn. A value history can't hold is still in it (see :func:`storable`)."""
    payload = source_node_payload(_readable(dict(props or {})), label)
    if payload is None or not payload.get("urn"):
        return None
    canonicalize_payload_types(payload, rules)
    if not payload.get("entityType"):
        payload["entityType"] = label or "unknown"
    return _sanitize_node_properties(payload)


def _edge_payload(src_urn: str, tgt_urn: str, rel, props: dict, rules) -> Tuple[str, dict]:
    """A source relationship (``properties(r)``) as ``(its id, the payload history keeps)``: every
    property it holds (``falkordb_provider._edge_from_row``), its type in the ontology's spelling."""
    edge = _edge_from_row(src_urn, tgt_urn, str(rel), props)
    payload = edge_to_payload(edge)
    canonicalize_payload_types(payload, rules)
    payload["edgeType"] = str(payload.get("edgeType") or rel)
    return edge.id, payload


#: A source node's top-level fields the copy fills from its own properties of those names.
_NODE_FIELDS = ("displayName", "qualifiedName", "description", "tags", "layerAssignment",
                "sourceSystem", "lastSyncedAt", "entityType")


def _unaccounted(raw: dict, payload: dict, *, label: Optional[str] = None,
                 rel: Optional[str] = None) -> List[str]:
    """The source's property names the payload has nowhere — the check that a conversion lost
    nothing, made by name, apart from the conversion itself: a name is accounted for as one of
    the payload's properties, as ``__src.<name>``, or as the field of that name. A node's derived
    bookkeeping, an ``entityId`` that is its urn and an ``entityType`` that is its label say
    nothing new; an edge's ``id`` is its identity. ``rel`` marks an edge."""
    names: List[str] = []
    bags = ("properties",) if rel is not None else ("properties", "propertiesRaw")
    projected = rel is not None and "gvHash" in raw
    for k, v in raw.items():
        if k in bags and _json_object(v) is not None:
            names.extend(_json_object(v))
        elif not projected:
            names.append(k)
    props = payload.get("properties") or {}
    lost = []
    for k in dict.fromkeys(names):
        if k in props or f"{SOURCE_KEY_PREFIX}{k}" in props:
            continue
        if rel is not None:
            if k in ("id", "gvHash") or (k == "confidence" and payload.get("confidence") is not None):
                continue
        else:
            if k in SOURCE_DERIVED_NODE_KEYS or k == "urn" or (k in _NODE_FIELDS and k in payload):
                continue
            if (k == "entityId" and raw.get(k) == raw.get("urn")) or (
                    k == "entityType" and raw.get(k) == label):
                continue
        lost.append(k)
    return lost


def _value_rows(graph_id: str, entity_id: str, issues: List[dict], about: dict) -> List[dict]:
    """``bootstrap_review`` rows (kind ``values``) for the values one entity's payload had to change
    to be stored (``entity_serde.storable``), each naming its property and what was wrong."""
    return [{"graph_id": graph_id, "kind": "values", "entity_id": entity_id, "seq": i,
             "detail": {**about, "property": i_["path"].removeprefix("properties."),
                        "problem": i_["problem"], "storedAs": i_["value"]}}
            for i, i_ in enumerate(issues)]


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
    # A package seed's open data stream and the projection's level map (``package_seed``).
    stream: Any = None
    level_map: Optional[Dict[str, int]] = None


@dataclass
class _Window:
    """One scan window, converted: the rows to insert, and what happened to every scanned row."""
    dicts: List[dict]
    scanned: Dict[str, int]                      # per label / type, before anything is dropped
    collapsed: Dict[str, int]                    # nodes: copies a duplicate decision collapsed
    rejects: dict
    meta: Dict[str, Tuple[str, int]]             # nodes: entity id → (source label, internal id)
    self_loops: int = 0                          # edges: between two copies of one urn
    dupes: int = 0                               # edges: one connection said twice under one id
    reidentified: int = 0                        # edges: given an id of their own (`_own_id`)
    # The graph's own spellings of each declared type (``projection_state.physical_types``).
    spellings: Dict[str, Set[str]] = field(default_factory=dict)


class BootstrapRunner:
    """Executes bootstrap (`job_type='bootstrap'`) jobs. Hosted by the versioning worker's
    bootstrap lane, on the job lease (``job_lease``)."""

    def __init__(self, graph_factory, *, session_factory=None, consumer: str = "boot-1",
                 on_rollups_stale=None, projector=None, store=None):
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
        # A package seed projects its copy into its new key (``FalkorProjector._apply``) and reads
        # the package from the object store (the configured one unless given).
        self._projector = projector
        self._store = store

    def _object_store(self):
        if self._store is None:
            from backend.app.services.storage.object_store import get_object_store
            self._store = get_object_store()
        return self._store

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
        """:meth:`_run_job`, as the request that started the enablement: its commit and activity
        name that key and request (``provenance.bound``)."""
        with provenance.bound(await provenance.job_provenance(lease.job_id, self._session)):
            return await self._run_job(lease)

    async def _run_job(self, lease: Lease) -> Dict[str, object]:
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
                    origin = (job.summary or {}).get("origin") or "graph"
                runner = self._phase_runner(phase, origin)
                done = await self._run_phase(lease, runner, graph_id, phase)
                if done == _PAUSED:
                    # The pre-flight already put the job back to pending, waiting for a person —
                    # it holds no slot while it waits, and a decision re-queues it.
                    logger.info("bootstrap %s paused: %s await a decision (graph=%s)", job_id,
                                "connections and values held for review"
                                if phase == "connections" else "duplicate identifiers", graph_id)
                    return {"job_id": job_id, "status": "paused"}
                if not done:
                    continue                                   # same phase, next window
                nxt = _next_phase(phase, origin)
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
            await self._fail(lease, exc.reason, exc.code, exc.action)
            return {"job_id": job_id, "status": "failed", "error": exc.reason}
        except Exception as exc:                                   # pragma: no cover - infra
            logger.exception("bootstrap %s crashed", job_id)
            await self._fail(lease, _friendly_infra_error(exc), "infrastructure")
            return {"job_id": job_id, "status": "failed"}
        finally:
            ctx = self._contexts.pop((job_id, lease.epoch), None)
            if getattr(ctx, "stream", None) is not None:
                # A package seed's stream holds a spooled copy of the upload until it is closed.
                with contextlib.suppress(Exception):
                    await ctx.stream.aclose()

    def _phase_runner(self, phase: str, origin: str):
        """``phase``'s runner for a job of ``origin``: a package seed's own phases are
        ``package_seed``'s, the shared ones (reset, heads, merkle, finalize) this runner's."""
        if origin == "package":
            from . import package_seed
            if phase in package_seed.OWN_PHASES:
                return functools.partial(getattr(package_seed, f"phase_{phase}"), self)
        return getattr(self, f"_phase_{phase}")

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

    async def _fail(self, lease: Lease, reason: str, code: str,
                    action: Optional[str] = None) -> None:
        """Fail the job, fenced, recording ``summary.failure = {code, action, phase, reason}``:
        the action is what the UI offers (``action``, else ``_FAILURE_ACTIONS`` by code). A job
        that is no longer ours is its owner's to record."""
        if not await lease.fail(reason, code, action or _FAILURE_ACTIONS.get(code)):
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
            await self._require_whole_replies(client)
            # A graph keyed by another property (``id``) gets ``urn`` stamped from it first, so
            # the read below sees every node. Again on every fresh read: it only fills what is
            # missing. The tally is kept through a restart, as the stamps are.
            stamped = await _stamp_identity(lease.job_id)
            if stamped is not None:
                before = int((summary.get("identityStamped") or {}).get("stamped", 0))
                summary["identityStamped"] = {**stamped, "stamped": before + int(stamped["stamped"])}
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
        records, nodes, hidden_nodes = await asyncio.to_thread(_preflight_columns, rows, graph_id)
        async with self._session() as s:
            await s.execute(text(
                f'DELETE FROM {_t("bootstrap_nodes")} '
                "WHERE graph_id = :g AND falkor_id >= :lo AND falkor_id < :hi"
            ).bindparams(g=graph_id, lo=lo, hi=hi))
            if records:
                await s.execute(_bootstrap_nodes_insert_sql(), {"g": graph_id, **records})
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
        list — it carries on.

        First, a node with no identifier (no urn, even after the stamp) stops the enable: version
        history can't keep it, and copying around it is how an ``id``-keyed graph used to finish
        green with nothing copied."""
        async with self._session() as s:
            summary = dict((await s.get(JobORM, lease.job_id)).summary or {})
        hidden = int((summary.get("source") or {}).get("invisibleNodes", 0))
        if hidden:
            raise BootstrapFailure(_no_identifier(
                hidden, (summary.get("identityStamped") or {}).get("property") or "urn"), "integrity")
        await self._analyze_bootstrap_nodes(lease)
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
                summary["awaiting"] = "duplicates"
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

    async def _analyze_bootstrap_nodes(self, lease: Lease) -> None:
        """Refresh the planner's statistics of ``bootstrap_nodes`` once the pre-flight has filled
        it: until autovacuum gets there they describe the table without this graph's rows, and
        every query of them — the ranking, the summary, the losers each window skips — is planned
        for a handful. Best effort (it needs the table's owner)."""
        try:
            async with self._session() as s:
                await s.execute(text(f'ANALYZE {_t("bootstrap_nodes")}'))
                await s.commit()
        except Exception as exc:                                 # noqa: BLE001 — best effort
            logger.warning("bootstrap %s: could not refresh statistics: %s", lease.job_id, exc)

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

    async def _require_whole_replies(self, client) -> None:
        """Refuse a graph server that cuts replies short. FalkorDB's ``RESULTSET_SIZE`` caps every
        reply at that many rows and drops the rest with no error and no marker, and the stock
        ``falkordb/falkordb`` image ships it at 10000. Every read here takes its reply as the whole
        answer, so a capped server reads as a smaller graph: a pre-flight window cut short hides
        duplicates, a copy window skips items, and a collapse that saw only some of a copy's
        relationships deletes the rest with the copy. A server that will not say (or a client
        with no raw command) reads as uncapped."""
        from backend.app.providers.shard_capacity import _read_config_int

        cap = await _read_config_int(client, None, "RESULTSET_SIZE")
        if cap is not None:
            raise BootstrapFailure(
                f"The graph server returns at most {cap:,} rows per query and drops the rest "
                "without saying so (its RESULTSET_SIZE setting), so the copy could miss items "
                "and a duplicate collapse could delete relationships it never saw. Set "
                "RESULTSET_SIZE to -1 (no limit) on the graph server, then resume.",
                "infrastructure")

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

        async with self._session() as s:
            rekeyed = await self._rekey_edge_collisions(s, graph_id, ctx, win.dicts) \
                if kind == "edges" else 0
            # ON CONFLICT DO NOTHING is what makes a replayed window a no-op — but it also
            # silently swallows a genuine duplicate identifier that first appeared in an
            # EARLIER window (the in-window `seen` set can't see across windows). So the tallies
            # come from what RETURNING says LANDED, not from the batch: whatever didn't land is a
            # duplicate. (Rows and cursor commit together, and only from the cursor this window
            # started at, so a resume never re-scans a window that landed — a conflict here really
            # is a duplicate.) A node that didn't land is a duplicate identifier; a connection
            # gets an id of its own and lands — whether it is another version of one already
            # copied is the ``connections`` phase's to settle, never a silent drop here.
            landed = await _insert_versions(s, kind, ctx, graph_id, win.dicts)
            if kind == "edges":
                more, landed = await _land_every_edge(s, ctx, graph_id, win.dicts, landed)
                rekeyed += more
            job = await s.get(JobORM, lease.job_id)
            summary = dict(job.summary or {})
            written: Dict[str, int] = {}
            sample = None
            await _insert_review(s, [
                r for d in win.dicts if d.get("issues") and d["entity_id"] in landed
                for r in _value_rows(graph_id, d["entity_id"], d["issues"], d["about"])])
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
                sample = {**(summary.get("sample") or {}), "nodes": sample.items,
                          "nodesSeen": sample.seen}
            else:
                # The edges validation re-reads from the source, where it holds them (``at``).
                sample = _Reservoir(config.BOOTSTRAP_SAMPLE_K,
                                    (summary.get("sample") or {}).get("edges"),
                                    (summary.get("sample") or {}).get("edgesSeen", 0))
                for d in win.dicts:
                    if d["entity_id"] in landed:
                        _bump(written, d["edge_type"])
                        sample.offer([*d["at"], d["entity_id"]])
                sample = {**(summary.get("sample") or {}), "edges": sample.items,
                          "edgesSeen": sample.seen}
            summary = _merge_scan_summary(
                summary, kind, scanned=len(rows), written=len(landed), tallies=win.scanned,
                rejects=win.rejects, sample=sample, dupes=win.dupes, written_tallies=written,
                collapsed=win.collapsed, self_loops=win.self_loops,
                rekeyed=rekeyed + win.reidentified, spellings=win.spellings)
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

    async def _phase_connections(self, lease: Lease, graph_id: str):
        """Settle every connection the source holds more than once — the same ends and type,
        whether under one id or several — before anything is checked or goes live. Version history
        keeps one connection per source, type and target, and the projector writes one.

        Copies that say the same thing lose nothing: one read twice under one source id folds,
        ones with ids of their own stay (:func:`_settle`). Copies that differ are held whole
        (``bootstrap_review``, kind ``copies``), out of the copy, for a person to decide — keep
        one, or merge them. A window of groups at a time, each its
        own fenced transaction (``connections:<key>``), found by one aggregate over the import
        commit. When none is left, the job pauses for review if anything is held — the values
        stored as text included — and no decision was made on this very list."""
        ctx = await self._ctx(lease, graph_id)
        async with self._session() as s:
            job = await s.get(JobORM, lease.job_id)
            cursor, summary = job.last_cursor, dict(job.summary or {})
            after = json.loads(cursor.split(":", 1)[1]) if cursor else None
            groups = await _connection_groups(s, graph_id, ctx.commit_id, after,
                                              _CONNECTIONS_PAGE)
            if groups:
                held_vids = [c[1] for g in groups if _differ(g) for c in g[3]]
                payloads = await _payloads_of(s, graph_id, held_vids)
                held, drop, tally = _settle(graph_id, groups, payloads)
                await _insert_review(s, held)
                for chunk in _chunks(drop, 5000):
                    await s.execute(text(
                        f'DELETE FROM {_t("edge_versions")} WHERE graph_id = :g AND id = ANY(:ids)'
                    ).bindparams(g=graph_id, ids=list(chunk)))
                summary = _merge_connections(summary, tally)
                key = json.dumps(list(groups[-1][:3]))
                await lease.checkpoint(s, expect_cursor=cursor, summary=summary,
                                       last_cursor=f"connections:{key}")
                return False                               # the next call starts after them
            review = await _review_summary(s, graph_id)
            if review is None:
                return True
            summary["review"] = review
            decided = (summary.get("reviewPolicy") or {}).get("fingerprint") == review["fingerprint"]
            values: Dict[str, Any] = {"summary": summary}
            if not decided:
                summary["awaiting"] = "review"
                values.update(_phase_start(AWAITING_DECISION), status="pending")
            await lease.checkpoint(s, expect_cursor=cursor, **values)
        logger.info("bootstrap %s: %s connection(s) held in %s version(s), %s value(s) stored as "
                    "text — %s", lease.job_id, review["copies"]["connections"],
                    review["copies"]["versions"], review["values"]["count"],
                    "as decided" if decided else "waiting for a review")
        return True if decided else _PAUSED

    async def _phase_resolve(self, lease: Lease, graph_id: str) -> bool:
        """Copy each held connection as the review decided (:func:`_resolved`): the version kept,
        or the versions merged. A window of connections at a time (``resolve:<last id>``), each
        its own fenced transaction; version rows insert ON CONFLICT DO NOTHING, so a replayed
        window is a no-op. Values were stored as text by the copy: nothing to do for them."""
        ctx = await self._ctx(lease, graph_id)
        async with self._session() as s:
            job = await s.get(JobORM, lease.job_id)
            cursor, summary = job.last_cursor, dict(job.summary or {})
            policy = (summary.get("reviewPolicy") or {}).get("copies") or {}
            after = cursor.split(":", 1)[1] if cursor else None
            ids = (await s.execute(text(
                f'SELECT DISTINCT entity_id FROM {_t("bootstrap_review")} '
                "WHERE graph_id = :g AND kind = 'copies' AND (CAST(:a AS text) IS NULL "
                "OR entity_id > :a) ORDER BY entity_id LIMIT :n"
            ).bindparams(g=graph_id, a=after, n=_CONNECTIONS_PAGE))).scalars().all()
            if not ids:
                return True
            rows = (await s.execute(select(
                BootstrapReviewORM.entity_id, BootstrapReviewORM.seq, BootstrapReviewORM.detail,
                BootstrapReviewORM.choice).where(
                BootstrapReviewORM.graph_id == graph_id, BootstrapReviewORM.kind == "copies",
                BootstrapReviewORM.entity_id.in_(list(ids))).order_by(
                BootstrapReviewORM.entity_id, BootstrapReviewORM.seq))).all()
            groups: Dict[str, List[dict]] = {}
            choices: Dict[str, Optional[dict]] = {}
            for eid, seq, detail, choice in rows:
                groups.setdefault(eid, []).append({"seq": seq, "detail": detail})
                if seq == 1:
                    choices[eid] = choice
            now = _now()
            dicts = []
            for eid, copies in groups.items():
                payload = _resolved(copies, choices.get(eid), policy)
                dicts.append(dict(
                    graph_id=graph_id, id=_vid("evb", ctx.commit_id, eid), entity_id=eid,
                    content_hash=content_hash(payload), payload=payload,
                    source_entity_id=payload["sourceEntityId"],
                    target_entity_id=payload["targetEntityId"], edge_type=payload["edgeType"],
                    confidence=payload.get("confidence"), discriminator=None, created_at=now))
            landed = await _insert_versions(s, "edges", ctx, graph_id, dicts)
            written: Dict[str, int] = {}
            for d in dicts:
                if d["entity_id"] in landed:
                    _bump(written, d["edge_type"])
            summary = _merge_connections(summary, {"resolved": len(landed), "byType": written})
            await lease.checkpoint(s, expect_cursor=cursor, summary=summary,
                                   last_cursor=f"resolve:{ids[-1]}")
        return False                                       # the next call starts after them

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
        # 7b. The same for connections: re-read where the source holds them, every property.
        edge_sampled = list((summary.get("sample") or {}).get("edges") or [])
        edge_matched, edge_mismatched, edge_skipped = await self._verify_edge_sample(
            graph_id, ctx, edge_sampled, await self._rules(lease, ctx))
        check("edge_sample_matches", not edge_mismatched,
              f"{edge_matched} of {len(edge_sampled) - edge_skipped} re-checked connections match "
              "exactly")
        # 8. One spelling per type. History keeps the declared spelling; the projector writes the
        #    graph's own back into it (projection_state.physical_types), so there must be one.
        spelled = _spelled_two_ways(summary)
        check("one_spelling_per_type", not spelled,
              "; ".join(f"{t} is spelled {' and '.join(v)}" for t, v in spelled[:5])
              if spelled else "each type is spelled one way in the graph")

        blocking = [c for c in checks if c["blocking"] and not c["ok"]]
        report = {
            "checks": checks,
            "source": src,
            "stored": {"nodes": written.get("nodes", 0), "edges": written.get("edges", 0)},
            "labels": dict(scanned.get("byLabel") or {}),
            "edgeTypes": dict(scanned.get("byType") or {}),
            "sampleChecked": len(sampled),
            "sampleMismatched": mismatched[:10],
            "edgeSampleChecked": len(edge_sampled) - edge_skipped,
            "edgeSampleMismatched": edge_mismatched[:10],
            # Copies of one connection that said the same thing: one is kept, nothing is lost.
            "mergedDuplicateConnections": int(summary.get("collapsedParallelEdges", 0))
            + int((summary.get("connections") or {}).get("folded", 0)),
            # What the review decided, and what was kept as the source has it but elsewhere.
            "resolvedConnections": int((summary.get("connections") or {}).get("resolved", 0)),
            "reidentifiedConnections": int(summary.get("rekeyedEdges") or 0),
            "valuesStoredAsText": int(((summary.get("review") or {}).get("values") or {})
                                      .get("count", 0)),
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

        A package seed's key holds the copy too — its ``project`` phase wrote it and proved the
        counts — so it is fast-forwarded the same way; then what a publish runs after a full
        projection runs for it (the rollups are built for the first time, the readers' caches
        and ontology alias map refreshed: ``FalkorProjector.run_publish_hooks``), best effort.
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
                ps.served_commit_seq = commit.commit_seq     # the source's own graph holds it
                ps.target_commit_seq = commit.commit_seq
                ps.status = "idle"
                ps.last_projected_at = _now()
                ps.epoch = ProjectionStateORM.epoch + 1      # fenced by the lease, with the flip
                if not ps.owns_falkor_graph:
                    # The graph's own spelling of the types it spells differently: the projector
                    # writes and matches with it from the first publish on.
                    ps.physical_types = _physical_types(summary)
        logger.info("bootstrap %s: head flipped to seq %s (projection fast-forwarded)",
                    lease.job_id, commit.commit_seq)
        # On the decision, not on the tally of deletes: a window replayed after a crash between
        # its DETACH DELETE and its checkpoint finds its copies gone and counts none.
        if (_collapse_decided(summary) or "sourceCollapse" in summary) and self._on_rollups_stale:
            try:
                await self._on_rollups_stale(graph_id)
            except Exception:                                  # pragma: no cover - best effort
                logger.exception("bootstrap %s: queueing the rollup rebuild failed", lease.job_id)
        if summary.get("origin") == "package" and self._projector is not None:
            try:
                await self._projector.run_publish_hooks(graph_id, full_seed=True,
                                                        rollups_stale=True)
            except Exception:                                  # pragma: no cover - best effort
                logger.exception("bootstrap %s: the publish hooks failed", lease.job_id)
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

    async def read_graph(self, client, rules) -> Tuple[List[dict], Dict[str, Dict[str, Set[str]]],
                                                      Set[str]]:
        """Read a graph whole, as the enable reads it, into the rows a sync takes
        (``GraphVersioningService.bring_into_history``): the same node-id windows and statements
        (nodes with a urn, nothing derived; relationships between two of them, rollups left out),
        the same readers, and the ontology's spelling of each type (``rules``). The provider's
        paged reader is not that: a page a node with no urn shortened read as the last one, and
        it read relationships to such nodes, the rollups, and child counts no history holds.

        Returns the rows — every property each holds, as the enable copies it; each declared
        type's spellings in the graph (``{"nodes": {type: {labels}}, "edges": {...}}``, as the
        enable's ``physicalTypes``); and the identifiers several nodes share with different
        contents, and the connections held more than once with different properties, left out of
        the rows, since no one copy is the graph's. A server that cuts replies short is refused
        first, and so is a value history can't store (:class:`BootstrapFailure`)."""
        await self._require_whole_replies(client)
        max_id = await self._max_id(client)
        full = min(config.BOOTSTRAP_SCAN_WIDTH, _PROPS_ROWS_CAP)
        nodes: Dict[str, dict] = {}
        spellings: Dict[str, Dict[str, Set[str]]] = {"nodes": {}, "edges": {}}
        clashes: Set[str] = set()
        unstorable: List[str] = []
        lo, width = 0, full
        while max_id is not None and lo <= max_id:
            found, width = await self._scan(client, "nodes", lo, width)
            lo += width
            for _fid, labels, props in found:
                label = _label_of(labels)
                payload = _node_payload(dict(props or {}), label, rules)
                if payload is None:
                    continue
                payload, issues = storable(payload)
                urn = str(payload["urn"])
                unstorable.extend(f"the item {urn}: {i['path'].removeprefix('properties.')} "
                                  f"({i['problem']})" for i in issues)
                row = {"kind": "node", "id": urn, **payload}
                if label:
                    spellings["nodes"].setdefault(row["entityType"], set()).add(label)
                if nodes.setdefault(urn, row) != row:
                    clashes.add(urn)
        # As the enable copies them: a connection read twice under one id is one; one sharing
        # another's id gets one of its own; copies of one connection (same ends and type) that
        # differ are left out and listed, as identifiers several nodes share are — there is no
        # review here, the enable is where they are decided.
        by_id: Dict[str, dict] = {}
        versions: Dict[Tuple[str, str, str], Dict[str, List[str]]] = {}
        lo = 0
        while max_id is not None and lo <= max_id:
            width, _held = await self._fit_edge_window(client, lo, full)
            found, width = await self._scan(client, "edges", lo, width)
            lo += width
            for src_id, tgt_id, src_urn, tgt_urn, rel, props in found:
                if src_urn == tgt_urn and src_id != tgt_id:
                    continue                       # two copies of one urn joined: not lineage
                eid, payload = _edge_payload(src_urn, tgt_urn, rel, dict(props or {}), rules)
                payload, issues = storable(payload)
                unstorable.extend(f"the connection {eid}: {i['path'].removeprefix('properties.')} "
                                  f"({i['problem']})" for i in issues)
                row = {"kind": "edge", "edgeType": payload["edgeType"], "source": src_urn,
                       "target": tgt_urn}
                for k in ("confidence", "properties"):
                    if payload.get(k) is not None:
                        row[k] = payload[k]
                spellings["edges"].setdefault(row["edgeType"], set()).add(str(rel))
                key = (src_urn, row["edgeType"].upper(), tgt_urn)
                said = json.dumps(row, sort_keys=True, default=str)
                held = by_id.get(eid)
                if held is not None:
                    if {k: v for k, v in held.items() if k != "id"} == row:
                        continue                   # the same connection, read twice
                    eid = _own_id(eid, by_id)
                by_id[eid] = {"id": eid, **row}
                versions.setdefault(key, {}).setdefault(said, []).append(eid)
        differ = {eid for said in versions.values() if len(said) > 1
                  for eids in said.values() for eid in eids}
        clashes |= differ
        if unstorable:
            shown = "; ".join(unstorable[:5]) + (f" — and {len(unstorable) - 5:,} more"
                                                 if len(unstorable) > 5 else "")
            raise BootstrapFailure(
                f"The graph holds values version history can't store as they are ({shown}). "
                "Change or remove them in the graph, then try again.", "integrity")
        rows = [r for urn, r in nodes.items() if urn not in clashes]
        return rows + [r for eid, r in by_id.items() if eid not in differ], spellings, clashes

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
        now = _now()
        win = _Window(dicts=[], scanned={}, collapsed={}, meta={},
                      rejects={"duplicateUrns": 0, "byLabel": {}, "unaccountedProperties": 0,
                               "samples": []})
        seen: set = set()
        for fid, labels, props in rows:
            raw = dict(props or {})
            label = _label_of(labels)
            payload = _node_payload(raw, label, rules)
            if payload is None:
                continue                                   # filtered by the scan; belt-and-braces
            et = str(payload.get("entityType") or "unknown")
            _bump(win.scanned, et)
            if label:
                win.spellings.setdefault(et, set()).add(label)
            # A copy the decision collapsed is skipped — but only if it is STILL that copy: the
            # same internal id, urn AND label. FalkorDB re-uses a deleted node's id, so a copy
            # deleted while the job waited may have handed its id to a different node, which
            # must be copied like any other.
            if (int(fid), str(raw.get("urn")), label) in losers:
                _bump(win.collapsed, et)
                continue
            eid = str(payload["urn"])
            if eid in seen:
                win.rejects["duplicateUrns"] += 1
                _bump(win.rejects["byLabel"], et)
                _add_reject_sample(win.rejects, {"kind": "node", "id": eid,
                                                 "reason": "another item shares this identifier"})
                continue
            seen.add(eid)
            _count_unaccounted(win.rejects, "node", eid, _unaccounted(raw, payload, label=label))
            payload, issues = storable(payload)
            ch = content_hash(payload)
            win.meta[eid] = (label or "", int(fid))
            win.dicts.append(dict(
                graph_id=graph_id, id=_vid("nvb", ctx.commit_id, eid), entity_id=eid,
                commit_id=ctx.commit_id, commit_seq=ctx.commit_seq, branch_id=ctx.main_id,
                op="create", content_hash=ch, prev_content_hash=None, payload=payload,
                actor=ctx.actor, created_at=now, urn=payload.get("urn"),
                entity_type=payload.get("entityType"), display_name=payload.get("displayName"),
                qualified_name=payload.get("qualifiedName"),
                issues=issues, about={"entityKind": "node", "name": payload.get("displayName"),
                                      "entityType": et},
            ))
        return win

    def _edges_to_rows(self, rows, ctx, graph_id, rules, live: set) -> _Window:
        now = _now()
        win = _Window(dicts=[], scanned={}, collapsed={}, meta={},
                      rejects={"danglingEdges": 0, "unaccountedProperties": 0, "samples": []})
        # Each id the window gives a connection, with what it says: the same connection said twice
        # (same ends, type and content) is one; anything else under an id already given — another
        # connection that shares it, or another version of this one — gets an id of its own, so
        # nothing is dropped here. Versions of one connection are reconciled after the copy
        # (``connections``), with copies that share no id at all.
        seen: Dict[str, Tuple[str, Tuple[str, str, str]]] = {}
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
            raw = dict(props or {})
            # Canonical edge payload (confidence TOP-LEVEL, properties NESTED) via the shared
            # contract, every property the relationship holds kept. Endpoints are the scan's urns.
            eid, payload = _edge_payload(src_urn, tgt_urn, rel, raw, rules)
            lost = _unaccounted(raw, payload, rel=str(rel))
            payload, issues = storable(payload)
            et = payload["edgeType"]
            ch = content_hash(payload)
            said = (ch, (src_urn, et.upper(), tgt_urn))
            if eid in seen:
                if seen[eid] == said:
                    win.dupes += 1
                    continue
                eid = _own_id(eid, seen)
                win.reidentified += 1
            seen[eid] = said
            _count_unaccounted(win.rejects, "edge", eid, lost)
            _bump(win.scanned, et)
            win.spellings.setdefault(et, set()).add(str(rel))
            win.dicts.append(dict(
                graph_id=graph_id, id=_vid("evb", ctx.commit_id, eid), entity_id=eid,
                commit_id=ctx.commit_id, commit_seq=ctx.commit_seq, branch_id=ctx.main_id,
                op="create", content_hash=ch, prev_content_hash=None, payload=payload,
                actor=ctx.actor, created_at=now, source_entity_id=src_urn,
                target_entity_id=tgt_urn, edge_type=et, confidence=payload.get("confidence"),
                discriminator=payload.get("discriminator"),
                issues=issues, about={"entityKind": "edge", "edgeType": et,
                                      "source": src_urn, "target": tgt_urn},
                # Where the source holds it, for the edge sample validation re-reads.
                at=[int(src_id), int(tgt_id), src_urn, tgt_urn, str(rel)],
            ))
        return win

    async def _verify_edge_sample(self, graph_id: str, ctx, samples, rules
                                  ) -> Tuple[int, List[dict], int]:
        """Re-read sampled connections from the SOURCE, every property, and compare content
        hashes with what was stored — as :meth:`_verify_sample` does for items.

        SEEK, don't scan: each end is found by its label and urn (the per-label index), then
        checked against its internal id — the labels come from the pre-flight's own table — and
        the relationship is matched between the two, never by walking one end's relationships. A
        sampled connection that is no longer in the copy as it was read (a copy that folded into
        another, a version a review merged) is not checked: ``skipped``. Returns ``(matched,
        mismatched, skipped)``."""
        if not samples:
            return 0, [], 0
        client = await self._client(ctx)
        by_vid = {_vid("evb", ctx.commit_id, it[5]): it for it in samples}
        async with self._session() as s:
            stored = dict((await s.execute(select(EdgeVersionORM.id, EdgeVersionORM.content_hash)
                                           .where(EdgeVersionORM.graph_id == graph_id,
                                                  EdgeVersionORM.id.in_(list(by_vid))))).all())
            # A copy the review held: its connection is now what a person decided, not this copy.
            decided: Set[str] = set()
            for eid, ids in (await s.execute(text(
                    f"SELECT entity_id, detail->'ids' FROM {_t('bootstrap_review')} "
                    "WHERE graph_id = :g AND kind = 'copies' "
                    "AND (entity_id = ANY(:e) OR (detail->'ids') ?| CAST(:e AS text[]))"
            ).bindparams(g=graph_id, e=[it[5] for it in samples]))).all():
                decided.add(eid)
                decided.update(ids or [])
            stored = {v: h for v, h in stored.items() if by_vid[v][5] not in decided}
            labels = dict((await s.execute(select(BootstrapNodeORM.falkor_id, BootstrapNodeORM.label)
                                           .where(BootstrapNodeORM.graph_id == graph_id,
                                                  BootstrapNodeORM.falkor_id.in_(
                                                      {int(i) for it in samples for i in it[:2]}))
                                           )).all())
        groups: Dict[Tuple[str, str, str], List[dict]] = {}
        for vid, (sid, tid, s_urn, t_urn, rel, _eid) in by_vid.items():
            if vid in stored:
                groups.setdefault((labels.get(int(sid)) or "", str(rel), labels.get(int(tid)) or ""),
                                  []).append({"k": vid, "s": s_urn, "t": t_urn, "sid": int(sid),
                                              "tid": int(tid)})
        found: Dict[str, Set[str]] = {}
        for (sl, rel, tl), items in groups.items():
            cypher = (f"UNWIND $edges AS it MATCH {_copy('a', sl or None, 'it.s')} WHERE ID(a) = it.sid "
                      f"MATCH {_copy('b', tl or None, 'it.t')} WHERE ID(b) = it.tid "
                      f"WITH it, a, b MATCH (a)-[r:{_q_label(rel)}]->(b) RETURN it.k, properties(r)")
            for chunk in _chunks(items, _PROPS_ROWS_CAP):
                res = await _q(client, cypher, {"edges": list(chunk)},
                               timeout_ms=_READ_TIMEOUT_MS, read_only=True)
                for vid, props in getattr(res, "result_set", None) or []:
                    it = by_vid[vid]
                    _eid, payload = _edge_payload(it[2], it[3], it[4], dict(props or {}), rules)
                    found.setdefault(vid, set()).add(content_hash(storable(payload)[0]))
        matched, mismatched = 0, []
        for vid, it in by_vid.items():
            if vid not in stored:
                continue
            if stored[vid] in found.get(vid, set()):
                matched += 1
            else:
                mismatched.append({"kind": "edge", "id": it[5], "source": it[2], "target": it[3],
                                   "reason": "changed in the source" if vid in found
                                   else "no longer in the source"})
        return matched, mismatched, len(by_vid) - len(stored)

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
            payload = _node_payload(dict(props or {}), _label_of(labels), rules)
            if payload is None:
                continue
            digest = content_hash(storable(payload)[0])
            urn = str(payload["urn"])
            by_id[int(nid)] = (urn, digest)
            by_urn[urn] = digest
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
    provider_aliases: Sequence[str] = (),
    kind: str = "manual", base_ontology_id: Optional[str] = None,
    ontology_enforcement: Optional[str] = None, origin: str = "graph",
    payload_uri: Optional[str] = None, upload_id: Optional[str] = None,
    package: Optional[Dict[str, Any]] = None, coverage: Optional[Dict[str, Any]] = None,
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

    ``origin='package'`` seeds a NEW data source from the view package upload ``upload_id``
    instead (``package_seed``): its data is read from ``payload_uri`` (the upload's record) into
    a graph bound to ``base_ontology_id`` with ``ontology_enforcement``, projected into the new
    key ``falkor_graph_name`` — which the job claims only once it has found it empty, so the graph
    starts as not ours. ``package`` describes the package (``summary.package``, with
    ``uploadId``) and ``coverage`` how much of its types the ontology declares. Asking again for
    the same upload returns its job; a data source with any other job is
    :class:`BootstrapConflict` ``ds_has_other_job``. A FalkorDB graph another versioned graph
    already projects into — through ``falkor_provider`` or one of ``provider_aliases``, the other
    providers on its server — is :class:`BootstrapConflict` ``graph_key_in_use``.
    """
    args = dict(data_source_id=data_source_id, workspace_id=workspace_id, actor=actor,
                falkor_graph_name=falkor_graph_name, falkor_provider=falkor_provider,
                provider_aliases=provider_aliases, kind=kind,
                base_ontology_id=base_ontology_id, ontology_enforcement=ontology_enforcement,
                origin=origin, payload_uri=payload_uri, upload_id=upload_id, package=package,
                coverage=coverage)
    try:
        return await _enqueue_bootstrap(**args)
    except IntegrityError:
        # Lost a concurrent enable race (uq_graphs_data_source): the winner's graph and job are
        # committed by now, so a second look finds them and returns its job.
        return await _enqueue_bootstrap(**args)


async def _enqueue_bootstrap(*, data_source_id: str, workspace_id: str, actor: str,
                             falkor_graph_name: Optional[str], falkor_provider: Optional[str],
                             provider_aliases: Sequence[str],
                             kind: str, base_ontology_id: Optional[str],
                             ontology_enforcement: Optional[str], origin: str,
                             payload_uri: Optional[str], upload_id: Optional[str],
                             package: Optional[Dict[str, Any]],
                             coverage: Optional[Dict[str, Any]]) -> Dict[str, object]:
    seed = origin == "package"
    async with db.graphver_session() as s:
        graph = (await s.execute(select(GraphORM).where(
            GraphORM.data_source_id == data_source_id))).scalars().first()

        if graph is not None:
            if graph.deleted_at is not None:
                raise BootstrapConflict(
                    "cleanup_in_progress",
                    "The previous attempt is still being cleaned up. Try again in a few minutes.")
            if seed:
                # Only this package's own seed may be found here — asked for again.
                job = (await s.execute(select(JobORM).where(
                    JobORM.job_type == BOOTSTRAP_JOB_TYPE, JobORM.graph_id == graph.id,
                ).order_by(JobORM.created_at.desc()))).scalars().first()
                summary = (job.summary or {}) if job is not None else {}
                if summary.get("origin") != "package" or \
                        (summary.get("package") or {}).get("uploadId") != upload_id:
                    raise BootstrapConflict(
                        "ds_has_other_job",
                        "This data source already has a version history of its own.")
                return {"graph_id": graph.id, "job_id": job.id, "status": _api_status(job),
                        "failure": summary.get("failure") if job.status == "failed" else None}
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
            try:
                res = await GraphVersioningService().create_graph(
                    data_source_id=data_source_id, workspace_id=workspace_id, kind=kind,
                    actor=actor, falkor_graph_name=falkor_graph_name,
                    falkor_provider=falkor_provider, provider_aliases=provider_aliases,
                    base_ontology_id=base_ontology_id,
                    ontology_enforcement=ontology_enforcement, session=s)
            except ConcurrencyError as exc:
                # Another versioned graph already projects into this FalkorDB graph.
                raise BootstrapConflict("graph_key_in_use", str(exc))
            gid, main_id = res["graph_id"], res["main_branch_id"]

        await s.flush()                                   # create_graph's rows are still pending
        ps = await s.get(ProjectionStateORM, gid)
        if ps is not None:
            ps.projected_commit_seq = 1                   # see docstring — never project mid-bootstrap
            ps.target_commit_seq = 1
            ps.epoch = ProjectionStateORM.epoch + 1
        commit = await _ensure_import_commit(
            s, gid, main_id, actor,
            message="seed from view package" if seed else "enable version control")
        summary: Dict[str, Any] = {"actor": actor}
        if seed:
            summary.update(origin="package", package={**(package or {}), "uploadId": upload_id},
                           ontology={"id": base_ontology_id, "enforcement": ontology_enforcement,
                                     "coverage": coverage})
        job = JobORM(
            job_type=BOOTSTRAP_JOB_TYPE, graph_id=gid, workspace_id=workspace_id,
            data_source_id=data_source_id, branch_id=main_id, status="pending",
            # What the claim's per-provider cap counts by.
            provider_id=falkor_provider,
            current_phase="counting", idempotency_key=f"bootstrap:{gid}",
            batch_size=config.BOOTSTRAP_SCAN_WIDTH, target_commit_id=commit.id,
            payload_uri=payload_uri, summary=summary, provenance=provenance.snapshot(),
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
        review = summary.get("review")
        if review:
            policy = summary.get("reviewPolicy") or {}
            review = {**review, "decision": {
                k: policy.get(k) for k in ("copies", "values", "fingerprint", "decidedBy",
                                           "decidedAt")
            } if policy.get("fingerprint") == review.get("fingerprint") else None}
        return {
            "jobId": job.id, "graphId": job.graph_id, "status": _api_status(job),
            # What a paused job waits on: ``duplicates`` (the pre-flight) or ``review`` (the copy).
            "awaiting": (summary.get("awaiting") or "duplicates")
            if _api_status(job) == "needs_decision" else None,
            "review": review or None,
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
                         for k in ("duplicateUrns", "danglingEdges", "unaccountedProperties",
                                   "samples")}
            if rejected else None,
            "collapsed": summary.get("collapsed"),
            "rekeyedEdges": int(summary.get("rekeyedEdges") or 0),
            "sourceCollapse": summary.get("sourceCollapse"),
            "identityStamped": summary.get("identityStamped"),
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
        if _api_status(job) != "needs_decision" or summary.get("awaiting") == "review":
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


# ------------------------------------------------------------------------- review --
#: What a review lists: connections held in several versions, values stored as text.
REVIEW_KINDS = ("copies", "values")


async def _review_job(s, data_source_id: str, workspace_id: Optional[str], *,
                      lock: bool = False) -> JobORM:
    job = await _latest_job(s, data_source_id, workspace_id, lock=lock)
    if job is None or not (job.summary or {}).get("review"):
        raise LookupError("enabling version control held nothing for review here")
    return job


def _clashing(versions: List[dict]) -> List[str]:
    """The properties a connection's versions disagree on (one holds it, another doesn't, or
    they hold different values), and ``@confidence`` when its confidence differs."""
    payloads = [v["payload"] or {} for v in versions]
    keys = list(dict.fromkeys(k for p in payloads for k in (p.get("properties") or {})))
    out = [k for k in keys if len({json.dumps((p.get("properties") or {}).get(k, "\0absent"),
                                              sort_keys=True, default=str)
                                   for p in payloads}) > 1]
    if len({p.get("confidence") for p in payloads}) > 1:
        out.append(CONFIDENCE_PICK)
    return out


async def review_page(*, data_source_id: str, kind: str, after: Optional[str] = None,
                      limit: int = 50, q: Optional[str] = None,
                      workspace_id: Optional[str] = None) -> Dict[str, object]:
    """One page of what the copy held for review, keyset-paged: for ``copies`` one item per
    connection — its ends and type, each version (its properties, confidence, how many copies say
    it, their ids), the properties they disagree on (``clashing``) and the person's ``choice`` —
    and for ``values`` one per value stored as text. ``q`` narrows to the connections or items
    whose id, ends, property or value holds it (any case). :class:`LookupError` when nothing was
    held; :class:`ValueError` for an unknown kind."""
    if kind not in REVIEW_KINDS:
        raise ValueError(f"kind must be one of {', '.join(REVIEW_KINDS)}")
    limit = max(1, min(int(limit), 500))
    async with db.graphver_session() as s:
        job = await _review_job(s, data_source_id, workspace_id)
        like = f"%{q.strip().lower()}%" if q and q.strip() else None
        match = ("AND (lower(entity_id) LIKE :q OR lower(detail::text) LIKE :q) " if like else "")
        if kind == "copies":
            ids = (await s.execute(text(
                f'SELECT DISTINCT entity_id FROM {_t("bootstrap_review")} WHERE graph_id = :g '
                f"AND kind = 'copies' AND (CAST(:a AS text) IS NULL OR entity_id > :a) {match}"
                "ORDER BY entity_id LIMIT :n"
            ).bindparams(g=job.graph_id, a=after, n=limit + 1, **({"q": like} if like else {})))
            ).scalars().all()
            page = list(ids[:limit])
            rows = (await s.execute(select(
                BootstrapReviewORM.entity_id, BootstrapReviewORM.seq, BootstrapReviewORM.detail,
                BootstrapReviewORM.choice).where(
                BootstrapReviewORM.graph_id == job.graph_id, BootstrapReviewORM.kind == "copies",
                BootstrapReviewORM.entity_id.in_(page)).order_by(
                BootstrapReviewORM.entity_id, BootstrapReviewORM.seq))).all() if page else []
            items: Dict[str, dict] = {}
            for eid, seq, detail, choice in rows:
                item = items.setdefault(eid, {
                    "entityId": eid, "edgeType": detail.get("edgeType"),
                    "source": detail.get("source"), "target": detail.get("target"),
                    "versions": [], "choice": None})
                payload = detail.get("payload") or {}
                item["versions"].append({
                    "seq": seq, "count": int(detail.get("count") or 1), "ids": detail.get("ids") or [],
                    "confidence": payload.get("confidence"),
                    "properties": payload.get("properties") or {}, "payload": payload})
                if seq == 1:
                    item["choice"] = choice
            out = []
            for eid in page:
                item = items[eid]
                item["clashing"] = _clashing(item["versions"])
                for v in item["versions"]:
                    v.pop("payload")
                out.append(item)
            return {"items": out, "next": page[-1] if len(ids) > limit else None}
        cursor = None
        if after:
            eid, _, seq = after.rpartition("#")
            cursor = (eid, int(seq)) if seq.isdigit() else None
        rows = (await s.execute(text(
            f'SELECT entity_id, seq, detail FROM {_t("bootstrap_review")} WHERE graph_id = :g '
            "AND kind = 'values' AND (CAST(:a AS text) IS NULL OR (entity_id, seq) > (:a, :b)) "
            f"{match}ORDER BY entity_id, seq LIMIT :n"
        ).bindparams(g=job.graph_id, a=cursor[0] if cursor else None,
                     b=cursor[1] if cursor else 0, n=limit + 1,
                     **({"q": like} if like else {})))).all()
        items = [_value_item(eid, seq, detail) for eid, seq, detail in rows[:limit]]
        nxt = f"{rows[limit - 1][0]}#{rows[limit - 1][1]}" if len(rows) > limit else None
        return {"items": items, "next": nxt}


async def review_csv(*, data_source_id: str, kind: str,
                     workspace_id: Optional[str] = None) -> AsyncIterator[str]:
    """Everything held for review of ``kind``, as CSV, streamed in pages (as :func:`duplicates_csv`):
    one row per version of a connection (``copies``) or per value stored as text (``values``).
    :class:`LookupError` (before the first byte) when nothing was held."""
    if kind not in REVIEW_KINDS:
        raise ValueError(f"kind must be one of {', '.join(REVIEW_KINDS)}")
    async with db.graphver_session() as s:
        await _review_job(s, data_source_id, workspace_id)

    async def stream() -> AsyncIterator[str]:
        out = io.StringIO()
        writer = csv.writer(out)
        writer.writerow(["connection", "version", "copies", "source", "type", "target", "ids",
                         "confidence", "properties"] if kind == "copies" else
                        ["kind", "id", "name", "property", "problem", "stored_as"])
        after = None
        while True:
            page = await review_page(data_source_id=data_source_id, kind=kind, after=after,
                                     limit=500, workspace_id=workspace_id)
            for it in page["items"]:
                if kind == "copies":
                    for v in it["versions"]:
                        writer.writerow([_csv_text(it["entityId"]), v["seq"], v["count"],
                                         _csv_text(it["source"] or ""), _csv_text(it["edgeType"] or ""),
                                         _csv_text(it["target"] or ""),
                                         _csv_text(" ".join(v["ids"])),
                                         "" if v["confidence"] is None else v["confidence"],
                                         _csv_text(json.dumps(v["properties"], ensure_ascii=False,
                                                              sort_keys=True))])
                else:
                    name = it.get("name") or " → ".join(
                        x for x in (it.get("source"), it.get("target")) if x)
                    writer.writerow([it.get("entityKind") or "", _csv_text(it["entityId"]),
                                     _csv_text(name or ""), _csv_text(it.get("property") or ""),
                                     it.get("problem") or "", _csv_text(str(it.get("storedAs") or ""))])
            yield out.getvalue()
            out.seek(0)
            out.truncate()
            if not page["next"]:
                return
            after = page["next"]

    return stream()


def _check_choice(choice: dict, seqs: Set[int]) -> dict:
    """A person's choice for one connection, refused (:class:`ValueError`) unless it names only
    this connection's versions and leaves at least one in."""
    if not isinstance(choice, dict):
        raise ValueError("a choice is an object")
    rule = choice.get("rule")
    if rule not in REVIEW_RULES:
        raise ValueError(f"rule must be one of {', '.join(REVIEW_RULES)}")
    out: Dict[str, Any] = {"rule": rule}
    if rule == "keep":
        if not isinstance(choice.get("keep"), int) or choice["keep"] not in seqs:
            raise ValueError("keep must name one of this connection's versions")
        out["keep"] = choice["keep"]
    if rule == "merge":
        left_out = choice.get("excludeCopies") or []
        if (not isinstance(left_out, list) or not all(isinstance(x, int) and x in seqs
                                                       for x in left_out)):
            raise ValueError("excludeCopies must name this connection's versions")
        if set(left_out) >= seqs:
            raise ValueError("a merge must keep at least one version")
        picks = choice.get("values") or {}
        if not isinstance(picks, dict) or not all(isinstance(k, str) and isinstance(v, int)
                                                  and v in seqs for k, v in picks.items()):
            raise ValueError("values must pick one of this connection's versions per property")
        out["excludeCopies"] = sorted(set(left_out))
        out["values"] = picks
    left = choice.get("excludeProperties") or []
    if not isinstance(left, list) or not all(isinstance(k, str) for k in left):
        raise ValueError("excludeProperties must be a list of property names")
    out["excludeProperties"] = sorted(set(left))
    return out


async def save_review_choice(*, data_source_id: str, entity_id: str, choice: Optional[dict],
                             workspace_id: Optional[str] = None) -> Dict[str, object]:
    """Save (or, with ``choice`` None, clear) a person's choice for one connection held for
    review, while the job waits on the review. :class:`BootstrapConflict` ``not_awaiting_decision``
    once it doesn't; :class:`LookupError` for a connection that isn't held; :class:`ValueError` for
    a choice that names what this connection doesn't hold."""
    async with db.graphver_session() as s:
        job = await _review_job(s, data_source_id, workspace_id, lock=True)
        if _api_status(job) != "needs_decision" or (job.summary or {}).get("awaiting") != "review":
            raise BootstrapConflict("not_awaiting_decision",
                                    "This copy is not waiting for a review any more.")
        seqs = set((await s.execute(select(BootstrapReviewORM.seq).where(
            BootstrapReviewORM.graph_id == job.graph_id, BootstrapReviewORM.kind == "copies",
            BootstrapReviewORM.entity_id == entity_id))).scalars().all())
        if not seqs:
            raise LookupError("no connection by that id was held for review")
        saved = None if choice is None else _check_choice(choice, seqs)
        await s.execute(text(
            f'UPDATE {_t("bootstrap_review")} SET choice = CAST(:c AS jsonb) WHERE graph_id = :g '
            "AND kind = 'copies' AND entity_id = :e AND seq = 1"
        ).bindparams(g=job.graph_id, e=entity_id, c=None if saved is None else json.dumps(saved)))
        return {"entityId": entity_id, "choice": saved}


async def decide_review(*, data_source_id: str, fingerprint: str, actor: str,
                        copies: Optional[dict] = None, values: Optional[str] = None,
                        workspace_id: Optional[str] = None) -> Dict[str, object]:
    """Record the review of what the copy held, and queue the job to copy it as decided.

    As :func:`decide_duplicates`: one locked row, bound to the list shown (``fingerprint``,
    ``stale_decision`` otherwise), only while the job waits on the review
    (``not_awaiting_decision``), and recording it again changes nothing. Every kind held must be
    decided: ``copies`` — ``{rule: keep_first|merge, excludeProperties}``, the rule for every
    connection without a choice of its own — when connections were held, and ``values`` —
    ``as_text`` — when values were (``ValueError`` otherwise). The job then copies each held
    connection as decided (``resolve``) and checks the copy whole."""
    async with db.graphver_session() as s:
        job = await _latest_job(s, data_source_id, workspace_id, lock=True)
        if job is None:
            raise LookupError("no enablement job for this data source")
        summary = dict(job.summary or {})
        review = summary.get("review") or {}
        policy = summary.get("reviewPolicy") or {}
        if _api_status(job) != "needs_decision" or summary.get("awaiting") != "review":
            if review and policy.get("fingerprint") == fingerprint:
                return {"jobId": job.id, "already": True}
            raise BootstrapConflict("not_awaiting_decision",
                                    "This copy is not waiting for a review any more.")
        if fingerprint != review.get("fingerprint"):
            raise BootstrapConflict("stale_decision",
                                    "What the copy held changed since it was shown. Review it "
                                    "again.", fingerprint=review.get("fingerprint"))
        held_copies = int((review.get("copies") or {}).get("connections") or 0)
        held_values = int((review.get("values") or {}).get("count") or 0)
        decided: Dict[str, Any] = {}
        if held_copies:
            rule = (copies or {}).get("rule")
            if rule not in ("keep_first", "merge"):
                raise ValueError("say how to copy the connections held more than once: "
                                 "copies.rule is keep_first or merge")
            left = (copies or {}).get("excludeProperties") or []
            if not isinstance(left, list) or not all(isinstance(k, str) for k in left):
                raise ValueError("copies.excludeProperties must be a list of property names")
            decided["copies"] = {"rule": rule, "excludeProperties": sorted(set(left))}
        if held_values:
            if values != "as_text":
                raise ValueError("say how to store the values history can't hold: values is "
                                 "as_text")
            decided["values"] = "as_text"
        summary["reviewPolicy"] = {**decided, "fingerprint": fingerprint, "decidedBy": actor,
                                   "decidedAt": _now(), "connections": held_copies,
                                   "valuesAsText": held_values}
        summary.pop("awaiting", None)
        summary.pop("takeovers", None)          # a person chose to go on: a fresh poison count
        job.summary = summary
        _advance_phase(job, "resolve")
        job.updated_at = _now()
        logger.info("bootstrap %s: %s decided the review (%s connection(s), %s value(s); "
                    "fingerprint %s)", job.id, actor, held_copies, held_values, fingerprint)
        return {"jobId": job.id, "already": False}


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
    must never act on another tenant's data source id.

    A package seed's answer carries ``origin: 'package'``: its data source was made for the seed
    and goes with it (the API removes it)."""
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
        out = {"jobId": job.id, "status": "cancelled", "purgeJobId": purge_id}
        if (job.summary or {}).get("origin") == "package":
            out["origin"] = "package"           # the data source was made for it: the API drops it
        return out


async def _ensure_import_commit(s, graph_id: str, main_id: str, actor: str,
                                message: str = "enable version control") -> CommitORM:
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
        message=message, actor=actor, **commit_provenance(actor),
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
    """A job failed for a reason we can explain to the user in plain language. ``action`` is what
    the user can do about it, when its code alone doesn't say (``_FAILURE_ACTIONS``)."""

    def __init__(self, reason: str, code: str = "integrity", action: Optional[str] = None):
        super().__init__(reason)
        self.reason, self.code, self.action = reason, code, action


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


def _no_identifier(count: int, identity: str) -> str:
    """Why nodes with no identifier stop the enable, and what to do."""
    items = f"{count:,} item{'s' if count != 1 else ''} in the graph {'have' if count != 1 else 'has'}"
    if identity == "urn":
        return (f"{items} no urn. Version history can only keep items it can tell apart, so the "
                "copy would leave them out. Set urn on each of them, or set the data source's "
                "identity property to one they all have, then start over.")
    return (f"{items} no urn and no {identity} to take one from. Version history can only keep "
            f"items it can tell apart, so the copy would leave them out. Set {identity} on each "
            "of them, then start over.")


def _explain_failed_checks(failed: List[dict]) -> str:
    """Most specific, most actionable cause first. A data-quality problem in the source
    also trips the generic "didn't match" checks (a duplicate identifier, for instance,
    makes the re-read sample disagree too) — saying "the graph changed" there would send
    the user chasing the wrong thing."""
    keys = {c["key"] for c in failed}
    if "properties_kept" in keys:
        return ("Some properties of the source graph were not kept by the copy, so it was not "
                "applied: nothing is lost. This is a fault in the copy, not in your graph — "
                "report it, with the job's report.")
    if "review_decided" in keys:
        return ("What the copy held for review was not all decided — the review changed while it "
                "was applied. Start over to check it again.")
    if "one_spelling_per_type" in keys:
        return ("Some types are spelled more than one way in the graph (Table as table and TABLE, "
                "say). Version history keeps one spelling for each type, so later changes would "
                "reach only one of them. Give each type one spelling in the graph, then start "
                "over.")
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
    if {"nodes_seen", "edges_seen", "sample_matches", "edge_sample_matches",
            "source_stable"} & keys:
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
                        self_loops: int = 0, rekeyed: int = 0,
                        spellings: Optional[Dict[str, Set[str]]] = None) -> dict:
    """Add one window's tallies to the job's. ``tallies`` / ``written_tallies`` are per label
    (nodes) or per type (edges): what was scanned, and what landed; ``collapsed`` the copies a
    duplicate decision skipped, per label; ``self_loops`` the edges between two copies of one urn;
    ``rekeyed`` the edges whose id clashed with a node's; ``spellings`` how the graph spells each
    declared type (``physicalTypes``: every spelling seen, per declared type)."""
    sc = dict(summary.get("scanned") or {"nodes": 0, "edges": 0, "byLabel": {}, "byType": {}})
    wr = dict(summary.get("written") or {"nodes": 0, "edges": 0})
    rj = dict(summary.get("rejected") or {"duplicateUrns": 0, "danglingEdges": 0,
                                          "unaccountedProperties": 0, "samples": []})
    cl = dict(summary.get("collapsed") or {"nodes": 0, "byLabel": {}, "selfLoops": 0})
    sc[kind] = int(sc.get(kind, 0)) + scanned
    wr[kind] = int(wr.get(kind, 0)) + written
    bucket = "byLabel" if kind == "nodes" else "byType"
    sc[bucket] = _add_tally(sc.get(bucket), tallies)
    wr[bucket] = _add_tally(wr.get(bucket), written_tallies)
    for k in ("duplicateUrns", "danglingEdges", "unaccountedProperties"):
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
    if spellings:
        spelled = dict(summary.get("physicalTypes") or {})
        seen = {t: set(v) for t, v in (spelled.get(kind) or {}).items()}
        for t, v in spellings.items():
            seen.setdefault(t, set()).update(v)
        spelled[kind] = {t: sorted(v) for t, v in seen.items()}
        summary["physicalTypes"] = spelled
    return summary


def _spelled_two_ways(summary: dict) -> List[Tuple[str, List[str]]]:
    """Each declared type the graph spells more than one way, with its spellings: nodes, then
    edges."""
    seen = summary.get("physicalTypes") or {}
    return [(t, list(v)) for kind in ("nodes", "edges")
            for t, v in sorted((seen.get(kind) or {}).items()) if len(v) > 1]


def _physical_types(summary: dict) -> Optional[dict]:
    """``projection_state.physical_types``: the graph's own spelling of each declared type, which
    the projector writes and matches in it — also a type spelled as declared, so a spelling
    another writer adds later doesn't make the projector unsure which is the graph's. None when
    the job's scan predates the tally: the projector then reads it from the graph. (A type
    spelled two ways never gets here: validation refuses it.)"""
    seen = summary.get("physicalTypes")
    if seen is None:
        return None
    return {kind: {t: v[0] for t, v in (seen.get(kind) or {}).items() if len(v) == 1}
            for kind in ("nodes", "edges")}


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
    unaccounted = int(rejected.get("unaccountedProperties", 0))
    check("properties_kept", unaccounted == 0,
          f"{unaccounted:,} item(s) or connection(s) whose properties were not all kept"
          if unaccounted else "every property of every item and connection kept")
    # 3. What we wrote reconciles exactly with what we saw. A connection copied more than once is
    #    one connection: copies that said the same folded, the ones that differed were held and
    #    each connection put back as a person decided (``connections``, ``resolve``).
    cn = summary.get("connections") or {}
    exp_nodes = (int(scanned.get("nodes", 0)) - int(collapsed.get("nodes", 0))
                 - int(rejected.get("duplicateUrns", 0)))
    exp_edges = (int(scanned.get("edges", 0)) - int(rejected.get("danglingEdges", 0))
                 - int(summary.get("collapsedParallelEdges", 0))
                 - int(collapsed.get("selfLoops", 0))
                 - int(cn.get("folded", 0)) - int(cn.get("heldCopies", 0))
                 + int(cn.get("resolved", 0)))
    review = summary.get("review")
    if review:
        decided = (summary.get("reviewPolicy") or {}).get("fingerprint") == review.get("fingerprint")
        check("review_decided", decided and int(cn.get("resolved", 0)) == int(cn.get("held", 0)),
              f"{int(cn.get('resolved', 0)):,} of {int(cn.get('held', 0)):,} connection(s) held for "
              "review copied as decided" if decided else "what the copy held was not decided")
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


def _own_id(eid: str, taken) -> str:
    """An id of its own for a connection whose id ``eid`` is taken: ``edge:<id>``, as an edge that
    shares a node's id is re-keyed (:func:`_rekey`), once more each time that is taken too. The
    graph's own id is what follows the prefixes — what the projector matches the relationship by
    (``projection._graph_edge_id``)."""
    while eid in taken:
        eid = f"edge:{eid}"
    return eid


def _count_unaccounted(rejects: dict, kind: str, eid: str, lost: List[str]) -> None:
    """Count a row whose payload lost a source property (:func:`_unaccounted`), with a sample."""
    if lost:
        rejects["unaccountedProperties"] = int(rejects.get("unaccountedProperties", 0)) + 1
        _add_reject_sample(rejects, {"kind": kind, "id": eid, "properties": lost[:10],
                                     "reason": "properties the copy did not keep"})


def _rekey(dicts: List[dict], clash: Set[str], commit_id: str) -> int:
    """Re-key the edge rows whose id is in ``clash`` (a node's id) to ``edge:<id>`` — or, when the
    window gave that to another connection already, to an id of its own (:func:`_own_id`); how
    many."""
    taken = {d["entity_id"] for d in dicts} | set(clash)
    n = 0
    for d in dicts:
        if d["entity_id"] in clash:
            d["entity_id"] = _own_id(d["entity_id"], taken)
            taken.add(d["entity_id"])
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
        "rejected": {"duplicateUrns": 0, "danglingEdges": 0, "unaccountedProperties": 0,
                     "byLabel": {}, "samples": []},
        "collapsed": {"nodes": 0, "byLabel": {}, "selfLoops": 0},
        "collapsedParallelEdges": 0,
        "rekeyedEdges": 0,
        "sample": {"nodes": [], "nodesSeen": 0, "edges": [], "edgesSeen": 0},
    }


def _bootstrap_nodes_insert_sql():
    """A pre-flight window's ``bootstrap_nodes`` rows (:func:`_preflight_columns`), unnested."""
    return text(
        f'INSERT INTO {_t("bootstrap_nodes")} (graph_id, falkor_id, urn, label, last_synced_at) '
        "SELECT :g, v.falkor_id, v.urn, v.label, v.last_synced_at FROM unnest("
        "CAST(:falkor_id AS bigint[]), CAST(:urn AS text[]), CAST(:label AS text[]), "
        "CAST(:last_synced_at AS timestamptz[])) AS v(falkor_id, urn, label, last_synced_at)")


def _preflight_columns(rows, graph_id: str) -> Tuple[Dict[str, list], int, int]:
    """:func:`_preflight_rows` as the columns of one typed ``unnest`` INSERT (its rows' keys, one
    list each; empty when the window holds no visible node) — the pre-flight's one statement per
    window, compiled once instead of a multi-row VALUES per few thousand rows on the loop."""
    records, visible, invisible = _preflight_rows(rows, graph_id)
    columns = {c: [r[c] for r in records] for c in ("falkor_id", "urn", "label", "last_synced_at")}
    return (columns if records else {}), visible, invisible


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
    """Rank the copies of every urn the source holds more than once — and only those.

    One scan of the graph's rows with two windows over it, computed ONCE (``MATERIALIZED``), then
    the ranked copies updated by primary key. Not a join of the rows to their own duplicated urns:
    planned on statistics that had not seen the rows the pre-flight just wrote (an estimate of
    one row), that join became a nested loop re-running the ranking once per row — at 100k nodes it
    did not finish in five minutes, where this takes milliseconds."""
    t = _t("bootstrap_nodes")
    return text(
        "WITH r AS MATERIALIZED (SELECT falkor_id, rank FROM ("
        "  SELECT falkor_id, count(*) OVER (PARTITION BY urn) AS copies, "
        "         row_number() OVER (PARTITION BY urn "
        "                            ORDER BY last_synced_at DESC NULLS LAST, falkor_id) AS rank "
        f"  FROM {t} WHERE graph_id = :g) k WHERE copies > 1) "
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


# ------------------------------------------------- connections held more than once --
#: Groups (``connections``) or held connections (``resolve``) per window.
_CONNECTIONS_PAGE = 2000


def _prefixes(eid: str) -> int:
    """How many times ``eid`` was re-keyed (``edge:`` prefixes, :func:`_own_id`)."""
    n = 0
    while eid.startswith("edge:", n * 5):
        n += 1
    return n


async def _connection_groups(s, graph_id: str, commit_id: str, after: Optional[list],
                             limit: int) -> List[tuple]:
    """The import commit's connections copied more than once — the same source, type (case aside,
    as edge integrity compares it) and target — after the group key ``after``, in key order:
    ``(source, TYPE, target, [(entity id, version id, content hash, edge type), …])``, each group's
    copies first the one with the source's own id (fewest re-keys), then by id."""
    params = {"g": graph_id, "c": commit_id, "n": limit}
    cond = ""
    if after:
        cond = "AND (source_entity_id, upper(edge_type), target_entity_id) > (:s, :t, :o) "
        params.update(s=after[0], t=after[1], o=after[2])
    rows = (await s.execute(text(
        "SELECT source_entity_id, upper(edge_type), target_entity_id, array_agg(entity_id), "
        "array_agg(id), array_agg(content_hash), array_agg(edge_type) "
        f'FROM {_t("edge_versions")} WHERE graph_id = :g AND commit_id = :c {cond}'
        "GROUP BY 1, 2, 3 HAVING count(*) > 1 ORDER BY 1, 2, 3 LIMIT :n"), params)).all()
    return [(src, typ, tgt, sorted(zip(eids, vids, hashes, types),
                                   key=lambda c: (_prefixes(c[0]), c[0])))
            for src, typ, tgt, eids, vids, hashes, types in rows]


def _differ(group: tuple) -> bool:
    return len({c[2] for c in group[3]}) > 1


async def _payloads_of(s, graph_id: str, vids: List[str]) -> Dict[str, dict]:
    out: Dict[str, dict] = {}
    for chunk in _chunks(vids, 5000):
        out.update((await s.execute(select(EdgeVersionORM.id, EdgeVersionORM.payload).where(
            EdgeVersionORM.graph_id == graph_id, EdgeVersionORM.id.in_(list(chunk))))).all())
    return out


def _settle(graph_id: str, groups: List[tuple], payloads: Dict[str, dict]
            ) -> Tuple[List[dict], List[str], dict]:
    """What a window of groups becomes: the rows to hold (``bootstrap_review``), the version rows
    to take out of the copy, and the tally.

    A group whose copies all say the same thing loses nothing: a copy read twice under one source
    id (re-keyed ``edge:<id>`` as it landed) folds into the first; copies with ids of their own
    stay, each the source's relationship that history deletes and updates by its id, as they
    always have. A group whose copies differ is held whole — one row per version (what several
    copies say alike is one version, with their count and ids) under the id of its first copy —
    and taken out of the copy until a person decides."""
    held: List[dict] = []
    drop: List[str] = []
    tally: Dict[str, Any] = {"folded": 0, "heldCopies": 0, "held": 0, "byType": {}}
    for src, _typ, tgt, copies in groups:
        if not _differ((src, _typ, tgt, copies)):
            ids: Set[str] = set()
            gone = []
            for c in copies:
                if _graph_edge_id(c[0]) in ids:
                    gone.append(c)
                ids.add(_graph_edge_id(c[0]))
            tally["folded"] += len(gone)
        else:
            gone = copies
            tally["heldCopies"] += len(copies)
            tally["held"] += 1
            versions: Dict[str, List[tuple]] = {}
            for c in copies:
                versions.setdefault(c[2], []).append(c)
            for seq, (h, alike) in enumerate(versions.items(), start=1):
                held.append({"graph_id": graph_id, "kind": "copies", "entity_id": copies[0][0],
                             "seq": seq, "detail": {
                                 "payload": payloads.get(alike[0][1]), "hash": h,
                                 "count": len(alike), "ids": [c[0] for c in alike][:50],
                                 "source": src, "target": tgt, "edgeType": alike[0][3]}})
        for c in gone:
            drop.append(c[1])
            tally["byType"][c[3]] = tally["byType"].get(c[3], 0) - 1
    return held, drop, tally


def _merge_connections(summary: dict, tally: dict) -> dict:
    """Fold a window's connection tally into the job's: ``connections`` (folded copies, held
    copies and connections, connections resolved) and ``written`` (rows taken out, or put in)."""
    cn = dict(summary.get("connections") or {})
    for k in ("folded", "heldCopies", "held", "resolved"):
        cn[k] = int(cn.get(k, 0)) + int(tally.get(k, 0))
    summary["connections"] = cn
    wr = dict(summary.get("written") or {"nodes": 0, "edges": 0})
    delta = tally.get("byType") or {}
    wr["edges"] = int(wr.get("edges", 0)) + sum(int(v) for v in delta.values())
    wr["byType"] = {k: v for k, v in _add_tally(wr.get("byType"), delta).items() if v}
    summary["written"] = wr
    return summary


_REVIEW_SAMPLE = 20


async def _review_summary(s, graph_id: str) -> Optional[dict]:
    """What the copy holds for review, as the job's status shows it: per kind the counts and a
    sample, and the FINGERPRINT that names exactly this list (a decision must carry it). None
    when nothing is held."""
    stats = (await s.execute(text(
        "SELECT kind, count(DISTINCT entity_id), count(*), "
        "coalesce(sum((detail->>'count')::int), 0), md5(string_agg(entity_id || '|' || seq || '|' "
        "|| coalesce(detail->>'hash', detail->>'property', ''), ',' ORDER BY entity_id, seq)) "
        f'FROM {_t("bootstrap_review")} WHERE graph_id = :g GROUP BY kind'
    ).bindparams(g=graph_id))).all()
    if not stats:
        return None
    by = {k: (int(n), int(rows), int(copies), fp) for k, n, rows, copies, fp in stats}
    problems = dict((await s.execute(text(
        f"SELECT detail->>'problem', count(*) FROM {_t('bootstrap_review')} "
        "WHERE graph_id = :g AND kind = 'values' GROUP BY 1").bindparams(g=graph_id))).all())
    sample = (await s.execute(select(
        BootstrapReviewORM.kind, BootstrapReviewORM.entity_id, BootstrapReviewORM.seq,
        BootstrapReviewORM.detail).where(BootstrapReviewORM.graph_id == graph_id).order_by(
        BootstrapReviewORM.kind, BootstrapReviewORM.entity_id, BootstrapReviewORM.seq
    ).limit(4 * _REVIEW_SAMPLE))).all()
    connections: Dict[str, dict] = {}
    values: List[dict] = []
    for kind, eid, seq, detail in sample:
        if kind == "copies" and (eid in connections or len(connections) < _REVIEW_SAMPLE):
            c = connections.setdefault(eid, {
                "entityId": eid, "edgeType": detail.get("edgeType"),
                "source": detail.get("source"), "target": detail.get("target"), "versions": 0,
                "copies": 0})
            c["versions"] += 1
            c["copies"] += int(detail.get("count") or 1)
        elif kind == "values" and len(values) < _REVIEW_SAMPLE:
            values.append(_value_item(eid, seq, detail))
    copies = by.get("copies", (0, 0, 0, ""))
    vals = by.get("values", (0, 0, 0, ""))
    return {
        "fingerprint": hashlib.md5(f"{copies[3]}|{vals[3]}".encode()).hexdigest(),
        "copies": {"connections": copies[0], "versions": copies[1], "copies": copies[2],
                   "sample": list(connections.values())},
        "values": {"count": vals[1], "items": vals[0], "byProblem": {k: int(v) for k, v in
                                                                    problems.items()},
                   "sample": values},
    }


def _value_item(eid: str, seq: int, detail: dict) -> dict:
    return {"entityId": eid, "seq": seq, **{k: detail.get(k) for k in (
        "entityKind", "name", "entityType", "edgeType", "source", "target", "property",
        "problem", "storedAs")}}


#: What a connection held for review may be copied as: its first version, one version chosen, or
#: its versions merged.
REVIEW_RULES = ("keep_first", "keep", "merge")
#: In a merge's per-property picks, the connection's own ``confidence`` (not a property of it).
CONFIDENCE_PICK = "@confidence"


def _resolved(copies: List[dict], choice: Optional[dict], policy: dict) -> dict:
    """The payload a connection held for review is copied as, by its ``choice`` (a person's for
    this connection) over the review's ``policy`` (the rule for every other one).

    * ``keep_first`` — the first version as it is; ``keep`` — the version ``choice.keep``.
    * ``merge`` — the versions not left out (``choice.excludeCopies``), every property any of them
      holds: where they disagree, the version ``choice.values[<property>]`` picks, else the first
      that holds it. Its ``confidence`` likewise (:data:`CONFIDENCE_PICK`).

    The properties left out — the policy's ``excludeProperties`` and the choice's — are removed
    from whatever the rule gives."""
    choice = choice or {}
    by_seq = {int(c["seq"]): c["detail"]["payload"] for c in copies}
    rule = choice.get("rule") or policy.get("rule") or "keep_first"
    if rule == "keep" and int(choice.get("keep") or 0) in by_seq:
        out = copy.deepcopy(by_seq[int(choice["keep"])])
    elif rule == "merge":
        left_out = {int(x) for x in choice.get("excludeCopies") or []}
        merged = [q for q in sorted(by_seq) if q not in left_out] or sorted(by_seq)[:1]
        picks = {str(k): int(v) for k, v in (choice.get("values") or {}).items()}
        out = copy.deepcopy(by_seq[merged[0]])
        props: Dict[str, Any] = {}
        for q in merged:
            for k, v in (by_seq[q].get("properties") or {}).items():
                props.setdefault(k, v)
        for k, q in picks.items():
            if k != CONFIDENCE_PICK and q in merged and k in (by_seq[q].get("properties") or {}):
                props[k] = by_seq[q]["properties"][k]
        out["properties"] = copy.deepcopy(props)
        conf_from = picks.get(CONFIDENCE_PICK)
        confs = [by_seq[q].get("confidence") for q in ([conf_from] if conf_from in merged else [])
                 + merged if by_seq[q].get("confidence") is not None]
        out.pop("confidence", None)
        if confs:
            out["confidence"] = confs[0]
    else:
        out = copy.deepcopy(by_seq[min(by_seq)])
    excluded = set(policy.get("excludeProperties") or []) | set(choice.get("excludeProperties") or [])
    props = {k: v for k, v in (out.get("properties") or {}).items() if k not in excluded}
    out.pop("properties", None)
    if props:
        out["properties"] = props
    return out


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


def _next_phase(phase: str, origin: str = "graph") -> Optional[str]:
    phases = _PHASES_BY_ORIGIN.get(origin, PHASES)
    i = phases.index(phase)
    return phases[i + 1] if i + 1 < len(phases) else None


def _t(table: str) -> str:
    return f'"{config.graphver_schema()}"."{table}"'


def _now_minus(secs: int) -> str:
    from datetime import datetime, timedelta, timezone
    return (datetime.now(timezone.utc) - timedelta(seconds=secs)).isoformat()


async def _stamp_identity(job_id: str) -> Optional[dict]:
    """The job's data source's identity stamp (``node_identity.stamp_identity_for_enable``), or
    None without a data source."""
    async with db.graphver_session() as s:
        job = await s.get(JobORM, job_id)
        ds_id = job.data_source_id if job else None
    if not ds_id:
        return None
    from backend.app.services.node_identity import stamp_identity_for_enable
    return await stamp_identity_for_enable(ds_id)


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
