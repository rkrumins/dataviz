"""FalkorDB projection worker — derives the read graph from the durable graphver store.

Postgres is the source of truth; FalkorDB is a **rebuildable read cache** of `main`.
The projector writes the **same schema the existing reader uses**
(`falkordb_provider`: urn-keyed nodes labelled by `entityType`, edges typed by
`edgeType`) into the data source's **real** FalkorDB graph, so the existing
ContextEngine/UI read versioned data natively (plan §5, §13).

Two invariants make it safe to run unattended:
* **Idempotent apply** — every write is a `MERGE` (upsert) or `DELETE`, so a
  crashed/retried projection converges.
* **Watermark after apply** — `projected_commit_seq` only advances *after* the
  batch lands in FalkorDB, in a separate transaction (bounded staleness, never
  corruption).

First pass (`projected==0`) seeds the full live state; later passes apply only the rows in
`(projected, target]`. A fork is never projected: it reads through its root's store.
"""
from __future__ import annotations

import asyncio
import inspect
import json
import logging
import os
import random
import time
from collections import Counter
from contextvars import ContextVar
from datetime import datetime, timedelta, timezone
from typing import Awaitable, Callable, Dict, Iterable, List, Optional, Sequence, Set, Tuple

from sqlalchemy import Text, any_, bindparam, case, func, literal, null, or_, select, update
from sqlalchemy.dialects.postgresql import ARRAY

from . import config, db, residency_policy
from .errors import AmbiguousSpelling
from .falkor_indexes import ensure_urn_indexes
from .merkle import content_hash
from .reconcile import (
    SPELLING,
    graph_spelling,
    spelled_label,
    spelled_type,
    spelling,
    falkor_counts, pg_live_counts_projectable, reconcile_interrupted, rollup_health,
)
from .projection_reconcile import (
    ActualEdge, ActualNode, EdgeKey, ExpectedEdge, ExpectedNode,
    ROLLUP_EDGE_TYPE, _local_chain, diff_projection, fingerprint, plan_rollup_deltas,
    urn_triples,
)
from .messaging import nudge_projection
from .models import (
    EdgeVersionORM,
    EntityHeadORM,
    GraphORM,
    NodeVersionORM,
    ProjectionQuarantineORM,
    ProjectionStateORM,
    _now,
)
from .service import (_HASH_EMPTY, _HASH_NONE, ConcurrencyError, GraphVersioningService,
                      _is_edge_payload, bootstrap_unfinished)
from backend.common.derived_artifacts import is_derived_label

# Reuse the existing reader's schema helpers verbatim so the projection is
# byte-for-byte reader-compatible (a reader schema change flows through here too).
from backend.app.providers.falkordb_provider import (  # noqa: E402
    _RESERVED_NODE_KEYS,
    _admit_native_keys,
    _compute_searchable_text,
    _index_ddl_deferred_reason,
    _is_missing_graph_error,
    _is_native_value,
    _pressure_kind,
    _text_properties,
    _native_property_budget,
    _sanitize_label,
    _split_user_properties,
    reserve_platform_property_names,
)

logger = logging.getLogger(__name__)


#: ``_finish``'s ``surplus`` when the pass did not count a customer's key (the key is the
#: platform's, or the counts were not taken): ``external_drift`` is left alone.
_UNCOUNTED = object()

NodeUpsert = Tuple[str, str, dict]                     # (entity_id, urn, payload)
# (entity_id, src_urn, tgt_urn, payload, src_label, tgt_label) — endpoint
# labels resolved from committed entityTypes so every edge merge anchors on
# the per-label URN indexes instead of scanning all nodes per UNWIND row.
EdgeUpsert = Tuple[str, str, str, dict, str, str]


class _Pending(dict):
    """A committed version standing in for its payload in an upsert: what its version row says
    (a node's urn and entityType; an edge's edgeType and ends) — all a window's planning reads —
    and ``ref``, ``(kind, graph_id, version_id)``, for :meth:`FalkorProjector._apply` to read the
    payload with the batch that writes it. So a window of any size holds one batch of payloads,
    not all of them (``_compute_changes``)."""
    __slots__ = ("ref",)

    def __init__(self, ref: Tuple[str, str, str], fields: Iterable[Tuple[str, Optional[str]]]):
        super().__init__((k, v) for k, v in fields if v)
        self.ref = ref


# (provider, graph name, label) this process has made the urn index of (``_ensure_urn_indexes``);
# a graph's entries go with its key (``drop_graph``), as its indexes do.
_URN_INDEXED: Set[Tuple[Optional[str], str, str]] = set()
# Ids per endpoint urn/label lookup (``_prefetch_endpoints``).
_ENDPOINT_CHUNK = 20000

# Server-side query budgets (ms). FalkorDB now runs with TIMEOUT_DEFAULT /
# TIMEOUT_MAX set, so an un-budgeted projector write inherits the 30s
# default and dies mid-seed; every projector query passes an explicit
# budget below TIMEOUT_MAX (mirroring the aggregation pipeline's clamp).
_WRITE_TIMEOUT_MS = int(1000 * min(170.0, max(
    5.0, float(os.getenv("PROJECTION_FALKOR_WRITE_TIMEOUT_S", "60")))))
_READ_TIMEOUT_MS = int(1000 * min(170.0, max(
    2.0, float(os.getenv("PROJECTION_FALKOR_READ_TIMEOUT_S", "30")))))


async def _q(client, cypher: str, params: Optional[dict] = None,
             *, timeout_ms: int = _WRITE_TIMEOUT_MS, read_only: bool = False,
             missing: str = "fallback"):
    """Run one query with a server-side kill budget AND a client-side hang
    net (belt over the pool-level socket timeouts, and the bound for client
    fakes without them). Falls back to the timeout-less call for client
    fakes/libs without the kwarg.

    ``read_only`` sends ``GRAPH.RO_QUERY`` instead of ``GRAPH.QUERY``, and is
    correct ONLY for a statement with no write clause — FalkorDB refuses a
    RO_QUERY that contains one.

    It does not change WHICH node answers. redis-py auto-routes only the
    commands in its own read table and no ``GRAPH.*`` command is in it (see
    the note on the cluster client in ``falkordb_connection``), so this still
    goes to the primary that owns the key; only ``FalkorDBProvider`` ever
    targets a replica deliberately, and it does that through its own routing,
    not through this helper. What the flag buys is that a master running with
    ``min-replicas-to-write`` will not REFUSE the query: it refuses every
    write-flagged command while it is short of in-sync replicas, and a
    read-shaped query sent as ``GRAPH.QUERY`` is write-flagged. A projection
    read, a reconcile count and a neighbours lookup have no business failing
    with ``-NOREPLICAS`` because a replica is behind.

    A client without ``ro_query`` (a test fake, an older library) falls back
    to ``query`` and behaves exactly as it did.

    The two commands differ on one thing besides the flag: ``GRAPH.QUERY``
    INSTANTIATES a graph key that does not exist and answers from the empty
    graph, while ``GRAPH.RO_QUERY`` raises ``Invalid graph operation on empty
    key`` (see ``_is_missing_graph_error`` in ``falkordb_provider``). A
    never-projected or just-evicted graph is a real state here — reconcile
    reports on one, and the projector's own verify counts one — so a
    read-only call that meets it runs the same statement again as
    ``GRAPH.QUERY``. That is the old behaviour exactly, including the shape
    of what an aggregate returns, rather than a guessed empty result: a
    ``count(n)`` answers ``[[0]]``, not ``[]``, and callers index it.
    ``missing="raise"`` re-raises that error instead, for a caller asking
    whether the key exists, which the fallback would answer by creating it.
    """
    # A WRITE here is bounded by the cluster's failure detector. This helper
    # talks to the graph client directly, so the provider's own boundary
    # clamp never sees it — and a 60s projector write against a 15s
    # ``cluster-node-timeout`` costs the shard its master exactly as a 60s
    # rebuild batch does.
    #
    # A READ is not, for the reason set out on ``cluster_write_ceiling_s``:
    # it takes no write lock and cannot vote its own master out, so the
    # ceiling protects nothing it could break, while cutting reconcile's
    # counts and the bootstrap copy's scans to the window's share would fail
    # them on the large graphs they exist to describe.
    from backend.app.providers.falkordb_provider import clamp_write_budget

    asked_s = timeout_ms / 1000.0
    budget_ms = int(1000 * (asked_s if read_only else clamp_write_budget(asked_s)))

    async def _send(read: bool):
        call = (getattr(client, "ro_query", None) if read else None) or client.query
        try:
            coro = call(cypher, params=params, timeout=budget_ms)
        except TypeError:
            coro = call(cypher, params=params)
        return await asyncio.wait_for(coro, timeout=budget_ms / 1000 + 10)

    try:
        return await _send(read_only)
    except Exception as exc:
        if not read_only or missing == "raise" or "empty key" not in str(exc).lower():
            raise
        return await _send(False)


# --- The statement ladder: every chunked projector statement fits its budget ------------------ #
#
# A FalkorDB write is clamped to a share of the cluster's failure detector (``clamp_write_budget``:
# 6 s at a 15 s ``cluster-node-timeout``), and one statement that runs past it fails the whole
# pass. A window that fails is replayed whole, growing as commits land, so a graph whose
# statements cannot fit 5,000 rows used to stay "projecting" for good. Every chunked statement now
# goes through :meth:`FalkorProjector._laddered`:
# - a timeout or memory refusal splits the chunk in half and sends the halves again;
# - at one row, it waits and retries (``PROJECTION_FLOOR_RETRIES``), then hands the row to the
#   caller's ``at_floor`` (a hub's relationships paged first, say), or fails the pass;
# - the width that worked is kept per graph and statement kind (:class:`_Width`).
# Sending again is safe: FalkorDB rolls back a statement it aborts, and every projector write is
# an idempotent MERGE / SET / DELETE (a rollup write sets the absolute weight it computed).

def _floor_backoff_s(attempt: int) -> float:
    """Before retry ``attempt`` (0-based) of a one-row statement: 2 s, 4 s, 8 s … capped at 60 s,
    plus up to 1 s of jitter, as the aggregation ladder waits (``falkordb_materialize._backoff_s``)."""
    return min(60.0, 2.0 ** (attempt + 1)) + random.uniform(0.0, 1.0)


#: What the ladder waits and times with (tests replace them).
_sleep = asyncio.sleep
_clock = time.monotonic


class _Width:
    """One statement kind's chunk width on one graph, sized as TCP sizes its window (AIMD).

    - A chunk that failed, or used more than half its budget, halves the width.
    - Eight quick chunks in a row grow it by a quarter, never past ``ceiling``.
    - It never grows back to a size that failed until 64 quick chunks in a row, as the aggregation
      ladder's scan width (``falkordb_materialize._next_scan_width``): a bounded probe, not a
      sawtooth that fails every ninth statement.

    So a graph whose statements fit 700 rows settles just under 700, instead of failing at 5,000
    on every pass."""

    __slots__ = ("value", "ceiling", "streak", "failed")

    def __init__(self, ceiling: int) -> None:
        self.value = self.ceiling = max(1, int(ceiling))
        self.streak = 0
        self.failed: Optional[int] = None

    def halve(self, size: int, *, failed: bool = True) -> None:
        if failed:
            self.failed = size if self.failed is None else min(self.failed, size)
        self.value = max(1, min(self.value, size // 2))
        self.streak = 0

    def note(self, size: int, *, slow: bool) -> None:
        if slow:
            self.halve(size, failed=False)
            return
        self.streak += 1
        if self.streak < 8 or self.value >= self.ceiling:
            return
        grown = min(self.ceiling, self.value + max(1, self.value // 4))
        if self.failed is not None and grown >= self.failed:
            if self.streak < 64:
                self.value = max(self.value, self.failed - 1)
                return
            self.failed = None                  # 64 quick in a row: probe past it again
        self.value = grown
        self.streak = 0


#: ``(graph name, statement kind) -> its width``, for the life of the process.
_WIDTHS: Dict[Tuple[str, str], _Width] = {}

#: Relationships per statement when a hub node is deleted after them (``_hub_safe_delete``).
_HUB_PAGE = 10000


class _PassStats:
    """What one pass's statements took, for its log line and its result's ``stats``."""

    __slots__ = ("statements", "rows", "max_ms", "shrinks", "min_width")

    def __init__(self) -> None:
        self.statements = self.rows = self.shrinks = 0
        self.max_ms = 0.0
        self.min_width: Optional[int] = None

    def note(self, size: int, elapsed_s: float) -> None:
        self.statements += 1
        self.rows += size
        self.max_ms = max(self.max_ms, elapsed_s * 1000.0)

    def shrank(self, width: int) -> None:
        self.shrinks += 1
        self.min_width = width if self.min_width is None else min(self.min_width, width)

    def as_dict(self) -> Dict[str, object]:
        return {"statements": self.statements, "rows": self.rows,
                "maxMs": round(self.max_ms, 1), "shrinks": self.shrinks,
                "minWidth": self.min_width}


#: The pass running in this task (set by :meth:`FalkorProjector.project_graph`).
_PASS_STATS: ContextVar[Optional[_PassStats]] = ContextVar("projection_pass_stats", default=None)

#: The statements a single entity's failure is quarantined for (``projection_quarantine``): kind →
#: (entity kind, the key its row names the entity by). Not a read, whose answer the pass needs; not a
#: rollup cell, whose weight is derived and re-derived; not a delete by internal id, which could name
#: another node once FalkorDB reuses the id. Those still fail the pass.
_QUARANTINABLE: Dict[str, Tuple[str, Callable[[object], str]]] = {
    "node_merge": ("node", lambda row: str(row["urn"])),
    "node_delete": ("node", lambda row: str(row)),
    "node_delete_pair": ("node", lambda row: str(row["urn"])),
    "relabel": ("node", lambda row: str(row)),
    "rekey": ("node", lambda row: str(row["old"])),
    "edge_merge": ("edge", lambda row: str(row["eid"])),
    "edge_delete": ("edge", lambda row: str(row["eid"])),
}


class _Held:
    """A pass's quarantine: the graph, and the ``(entity kind, key)`` of each entity it holds."""

    __slots__ = ("graph_id", "keys", "added")

    def __init__(self, graph_id: str) -> None:
        self.graph_id = graph_id
        self.keys: Set[Tuple[str, str]] = set()
        self.added = 0


_PASS_HELD: ContextVar[Optional[_Held]] = ContextVar("projection_pass_held", default=None)


#: The pass marker, the last FalkorDB write of every publishing pass (``_write_marker``). Its
#: label is derived, so no count, scan or search sees it. ``epoch`` changes with every claim, so
#: the SET always mutates and a WAIT always has a fresh write to wait for.
_MARKER_WRITE = "MERGE (m:_GVProjMeta {id: 'meta'}) SET m.seq = $seq, m.epoch = $epoch"


async def _write_marker(client, seq: int, epoch: int) -> Optional[str]:
    """Write a publishing pass's marker. With ``PROJECTION_WAIT_REPLICAS`` set, WAIT for it on
    the owning node: returns why the pass must not publish when fewer replicas confirmed it (or
    that cannot be told), else None."""
    want = config.PROJECTION_WAIT_REPLICAS
    write_and_wait = getattr(client, "write_and_wait", None) if want > 0 else None
    if write_and_wait is None:                  # WAIT off, or a client without it (a test fake)
        await _q(client, _MARKER_WRITE, {"seq": seq, "epoch": epoch})
        return None
    from backend.app.providers.falkordb_provider import clamp_write_budget

    budget_ms = int(1000 * clamp_write_budget(_WRITE_TIMEOUT_MS / 1000.0))
    acked = await asyncio.wait_for(
        write_and_wait(f"CYPHER seq={int(seq)} epoch={int(epoch)} {_MARKER_WRITE}",
                       timeout_ms=budget_ms, min_replicas=want,
                       wait_ms=config.PROJECTION_WAIT_MS),
        timeout=(budget_ms + config.PROJECTION_WAIT_MS) / 1000 + 10)
    if acked is None or acked < want:
        return (f"replica_unconfirmed: {'unknown' if acked is None else acked}/{want} "
                f"replica(s) acknowledged seq {seq}")
    return None


#: Reads a key's pass marker (:func:`read_projection_marker`).
_MARKER_READ = "MATCH (m:_GVProjMeta) RETURN m.seq"

#: A long pass's resume point on the pass marker, written after each page lands (so a key that lost a
#: page lost the cursor with it): the window ``(pFrom, pTo]`` the pass is projecting, the step it is on
#: (``pStep``: a paged window's ``node`` / ``edge``, a streamed rebuild's ``fk_node`` / ``fk_edge`` /
#: ``node`` / ``edge``) and its position there (``pAfter``). A pass from the same ``pFrom`` resumes it.
_CURSOR_READ = "MATCH (m:_GVProjMeta) RETURN m.pFrom, m.pTo, m.pStep, m.pAfter"
_CURSOR_WRITE = ("MERGE (m:_GVProjMeta {id: 'meta'}) "
                 "SET m.pFrom = $from, m.pTo = $to, m.pStep = $step, m.pAfter = $after")
_CURSOR_CLEAR = "MATCH (m:_GVProjMeta) REMOVE m.pFrom, m.pTo, m.pStep, m.pAfter"


class _PassPartial(Exception):
    """A pass past ``PROJECTION_PASS_MAX_SECS`` stopped at a page boundary, its cursor written."""

    def __init__(self, written: int) -> None:
        super().__init__(f"stopped at a page boundary after {written} write(s)")
        self.written = written


class _Cursor:
    """Where a long pass is, and when it must stop: it writes itself after each page."""

    __slots__ = ("client", "from_seq", "to_seq", "resume", "deadline", "used")

    def __init__(self, client, from_seq: int, to_seq: int, resume: Optional[Tuple[str, str]],
                 deadline: Optional[float]) -> None:
        self.client, self.from_seq, self.to_seq = client, from_seq, to_seq
        self.resume, self.deadline, self.used = resume, deadline, False

    def start(self, step: str, steps: Sequence[str]) -> Optional[str]:
        """Where ``step`` starts: after the resumed position on the resumed step, from the start
        on a later one, and None (skip it) on one the resumed pass had finished."""
        if self.resume is None:
            return ""
        at, after = self.resume
        if at == step:
            return after
        return "" if steps.index(step) > steps.index(at) else None

    async def page_done(self, step: str, after: str, written: int) -> None:
        """After a page has landed: write where the pass is, and stop it past its time."""
        await _q(self.client, _CURSOR_WRITE, params={"from": self.from_seq, "to": self.to_seq,
                                                     "step": step, "after": str(after)})
        self.used = True
        if self.deadline is not None and time.monotonic() > self.deadline:
            raise _PassPartial(written)


async def _read_cursor(client) -> Optional[Tuple[int, int, str, str]]:
    try:
        res = await _q(client, _CURSOR_READ, read_only=True, timeout_ms=5000)
    except Exception:                                    # unreadable: start over
        return None
    rows = getattr(res, "result_set", None) or []
    if not rows or not rows[0] or rows[0][0] is None or rows[0][1] is None:
        return None
    return int(rows[0][0]), int(rows[0][1]), str(rows[0][2] or ""), str(rows[0][3] or "")


#: The tombstone sweep's own watermark on the pass marker (``_sweep_tombstoned``): every delete at or
#: below it is already swept. A marker created by this write alone has no ``seq``, which liveness
#: reads as "never marked" and leaves alone.
_SWEPT_READ = "MATCH (m:_GVProjMeta) RETURN m.sweptSeq"
_SWEPT_WRITE = "MERGE (m:_GVProjMeta {id: 'meta'}) SET m.sweptSeq = $seq"
#: Whether a summaries build stamped the key: the aggregation run's singleton, which readers need
#: before they serve the ``:AGGREGATED`` layer as built.
_SUMMARIES_BUILT = "MATCH (m:_AggMeta {id: 'singleton'}) RETURN count(m)"


async def read_projection_marker(client) -> Tuple[Optional[bool], Optional[int]]:
    """``(key exists, marker seq)`` for a projection key, read with ``GRAPH.RO_QUERY`` only:
    ``GRAPH.QUERY`` would create a missing key. A key no publishing pass has marked answers
    ``(True, None)``; a client without ``ro_query`` cannot tell, ``(None, None)``. Any error but
    the missing key propagates: unreachable is not lost."""
    if getattr(client, "ro_query", None) is None:
        return None, None
    try:
        res = await _q(client, _MARKER_READ, read_only=True, missing="raise", timeout_ms=5000)
    except Exception as exc:
        if _is_missing_graph_error(exc):
            return False, None
        raise
    rows = getattr(res, "result_set", None) or []
    return True, (int(rows[0][0]) if rows and rows[0][0] is not None else None)


def liveness_reset_to(exists: bool, marker_seq: Optional[int], projected: int) -> Optional[int]:
    """Where liveness lowers an idle graph's watermark, or None to leave it: to 0 when the key is
    gone, to the marker's seq when the key lost the passes after it (a restore, a lost AOF tail;
    the marker is written last, so the key holds everything up to it). A key without a marker
    (projected before markers, bootstrapped, seeded from a package) is judged only by whether it
    exists — the operator's watermark reset covers a restore of one."""
    if not exists:
        return 0
    if marker_seq is not None and marker_seq < projected:
        return marker_seq
    return None


#: Names the read path checks natively for a node's label before it merges
#: the blob back. The projector keys every node by ``urn`` itself, so the
#: source's identity property needs no place here.
_NAME_FALLBACK_KEYS = ("name", "title", "label")


async def _registered_property_names(client) -> Set[str]:
    """Every attribute name the graph has registered — what the native
    property budget counts against (``_admit_native_keys``). Read on the
    write node, so the previous pass's names are in it; a graph a full seed
    just dropped has none."""
    res = await _q(client, "CALL db.propertyKeys() YIELD propertyKey RETURN propertyKey")
    return {str(r[0]) for r in (getattr(res, "result_set", None) or []) if r and r[0] is not None}


def _projected_level(payload: dict, level_map: Optional[Dict[str, int]]) -> Optional[int]:
    """The ``n.level`` the projector stamps: the ontology's level for the
    entity type, else whatever the payload carries."""
    lvl = (level_map or {}).get(payload.get("entityType"))
    return payload.get("level") if lvl is None else lvl


def _projector_owned_property_names() -> Set[str]:
    """Every property the platform writes on an ENTITY node — never a user's to remove: the
    node's reserved keys (what the projector SETs, the conformance stamp's provenance, the
    legacy blob). The rollup and ``_AggMeta`` names are written on edges and meta nodes, not
    here — so a user property that happens to be called ``weight``, ``id`` or ``confidence``
    is the user's, and removing it removes it. (Taking the whole platform set left exactly
    those behind on the node, still in Properties and still matching search filters.)"""
    return set(_RESERVED_NODE_KEYS)


def _node_fingerprint(label: str, chash: str, ontology_level: Optional[int]) -> int:
    """What a projected node IS, as ``n.gvHash``: its label, Postgres's content hash of its
    committed payload, and the level the ONTOLOGY gives its type (a payload's own level is
    inside the content hash). Never the written item — which keys land native vs in
    ``propertiesRaw`` depends on each pass's property budget. The reconcile builds the same
    value from a version row alone, without reading the payload."""
    return fingerprint("n", label, chash, ontology_level)


def _edge_fingerprint(rel_type: str, chash: str) -> int:
    return fingerprint("e", rel_type, chash)


# --- Cypher (mirrors falkordb_provider.save_custom_graph; reader-compatible) --- #
def _node_merge_cypher(label: str) -> str:
    return (
        f"UNWIND $batch AS item MERGE (n:{label} {{urn: item.urn}}) "
        f"SET n += item.gone "
        f"SET n.entityId = item.entityId, n.displayName = item.displayName, "
        f"n.qualifiedName = item.qualifiedName, n.description = item.description, "
        f"n.tags = item.tags, n.layerAssignment = item.layerAssignment, "
        f"n.childCount = item.childCount, n.sourceSystem = item.sourceSystem, "
        f"n.lastSyncedAt = item.lastSyncedAt, n.propertiesRaw = item.propertiesRaw, "
        f"n.level = coalesce(item.level, n.level), "
        f"n.searchableText = item.searchableText, n.gvHash = item.gvHash, "
        f"n += item.nativeProps "
        f"REMOVE n.properties"
    )


def _edge_merge_cypher(rel_type: str, src_label: str, tgt_label: str, *,
                       keep_id: bool = False) -> str:
    """``keep_id``: a customer's graph keeps the id its relationship already has. An edge whose id
    was also a node's is ``edge:<id>`` in history (``bootstrap_worker._rekey``) and still ``<id>``
    there, and nothing may rename it under whatever else keys on it."""
    rid = "coalesce(r.id, item.eid)" if keep_id else "item.eid"
    # How many items landed: one whose endpoint is not there matches nothing, silently.
    return (
        f"UNWIND $batch AS item "
        f"MATCH (a:{src_label} {{urn: item.src}}) "
        f"MATCH (b:{tgt_label} {{urn: item.tgt}}) "
        f"MERGE (a)-[r:{rel_type}]->(b) "
        f"SET r.id = {rid}, r.confidence = item.conf, r.properties = item.props, "
        f"r.gvHash = item.gvHash "
        f"RETURN count(DISTINCT item.eid)"
    )


def _delete_edges_by_key_cypher(rel_type: str, src_label: str, tgt_label: str) -> str:
    """Remove the relationship(s) of one type between two nodes — the
    projector's own edge identity (it MERGEs one per triple), so it needs no
    entity id and also clears legacy parallel copies."""
    return (
        f"UNWIND $batch AS item "
        f"MATCH (a:{src_label} {{urn: item.src}})-[r:{rel_type}]->(b:{tgt_label} {{urn: item.tgt}}) "
        f"DELETE r"
    )


def _delete_nodes_cypher(label: str) -> str:
    return f"UNWIND $urns AS u MATCH (n:{label} {{urn: u}}) DETACH DELETE n"


def _delete_edges_cypher(rel_type: str, src_label: str, tgt_label: str) -> str:
    # Anchored + typed: both endpoints seek their per-label URN index and
    # the relationship match is bounded by the (a)->(b) adjacency. ``item.pid`` is the id a
    # customer's graph knows an edge re-keyed ``edge:<id>`` by (``_edge_merge_cypher``).
    return (
        f"UNWIND $batch AS item "
        f"MATCH (a:{src_label} {{urn: item.src}})"
        f"-[r:{rel_type}]->"
        f"(b:{tgt_label} {{urn: item.tgt}}) WHERE r.id IN [item.eid, item.pid] DELETE r"
    )


# Heal-path sweep: match the deleted node by (label, committed urn) — the
# per-label URN index — and confirm entityId, so a live entity that reused
# the urn is never deleted by mistake.
def _delete_nodes_by_pair_cypher(label: str) -> str:
    return (
        f"UNWIND $pairs AS p MATCH (n:{label} {{urn: p.urn}}) "
        f"WHERE n.entityId = p.eid DETACH DELETE n"
    )


def _group(pairs) -> Dict[str, List[str]]:
    """(urn, label) pairs → urns by label, for label-anchored deletes."""
    out: Dict[str, List[str]] = {}
    for urn, label in pairs:
        out.setdefault(label, []).append(urn)
    return out


def _batches(seq, n):
    for i in range(0, len(seq), n):
        yield seq[i:i + n]


def _node_urn(entity_id: str, payload: Optional[dict]) -> str:
    """The node's FalkorDB key — its `urn`, or a stable `gv:<entity_id>` fallback
    when the manual node has no urn (so the node always has a key).

    A `gv:` fallback for a node that *should* have a urn is a smell: it can mint a
    duplicate of an existing urn-keyed node (the partial-update-against-an-unbacked-
    entity phantom). We WARN so the FalkorDB<->Postgres reconciliation has a signal."""
    if payload:
        u = payload.get("urn")
        if u:
            return str(u)
    logger.warning("projection: node %s has no urn in payload; keying as gv:<entity_id> "
                   "(possible phantom / FalkorDB-not-subset-of-Postgres)", entity_id)
    return f"gv:{entity_id}"


def _node_item(entity_id: str, urn: str, payload: dict,
               level_map: Optional[Dict[str, int]] = None,
               native_keys: Optional[Set[str]] = None) -> dict:
    native, residual = _split_user_properties(payload.get("properties"), native_keys)
    dn = payload.get("displayName") or ""
    qn = payload.get("qualifiedName") or ""
    desc = payload.get("description") or ""
    # The node's hierarchy depth. `save_custom_graph` stamps this (from the ontology
    # entity-type→level map) and the trace level-pair filter reads it; the projector must
    # stamp the SAME value or a rebuild would drop it (COALESCE leaves it unset only when the
    # type has no mapped level — e.g. dedicated mode / no ontology — matching save_custom_graph).
    lvl = _projected_level(payload, level_map)
    return {
        "urn": urn,
        "entityId": entity_id,
        "displayName": dn,
        "qualifiedName": qn,
        "description": desc,
        "nativeProps": native,
        "propertiesRaw": residual,
        "tags": json.dumps(payload.get("tags") or []),
        "layerAssignment": payload.get("layerAssignment") or "",
        "childCount": payload.get("childCount") or 0,
        "sourceSystem": payload.get("sourceSystem") or "",
        "lastSyncedAt": payload.get("lastSyncedAt") or "",
        "level": lvl,
        "searchableText": _compute_searchable_text(
            dn, qn, desc, _text_properties(payload.get("properties")), tags=payload.get("tags"),
        ),
    }


def _edge_item(entity_id: str, src_urn: str, tgt_urn: str, payload: dict) -> dict:
    return {
        "src": src_urn,
        "tgt": tgt_urn,
        "eid": entity_id,
        "conf": payload.get("confidence"),
        "props": json.dumps(payload.get("properties") or {}),
    }


def _is_derived_edge_payload(payload: Optional[dict]) -> bool:
    """A committed edge row for a relationship the PLATFORM derives
    (``AGGREGATED``). Rollups are maintained by the projector's deltas and the
    aggregation pipeline, never replayed from the version log: a graph whose
    rollups were imported as ordinary edges (the July "enable versioning"
    imports, before bootstrap excluded them) otherwise re-created every one of
    them as an empty stub on each full seed — no weight, no aggKey — which
    readers then served as real rollup cells."""
    return bool(payload) and str(payload.get("edgeType") or "") == ROLLUP_EDGE_TYPE


def _edge_endpoints(payload: dict) -> Tuple[str, str]:
    src = payload.get("sourceEntityId") or payload.get("source_entity_id") or ""
    tgt = payload.get("targetEntityId") or payload.get("target_entity_id") or ""
    return src, tgt


def _retry_at(attempts: int) -> str:
    """When the poll may retry after ``attempts`` consecutive failed passes: the base delay,
    doubled per failure, capped (ISO-8601 UTC, comparable with ``_now()``)."""
    delay = min(config.PROJECTION_RETRY_BASE_SECS * 2 ** (attempts - 1),
                config.PROJECTION_RETRY_MAX_SECS)
    return (datetime.now(timezone.utc) + timedelta(seconds=delay)).isoformat()


def _unless_loading(status: str):
    """``status`` for a pass to write, except over a load in flight: a ``rehydrating`` graph stays so
    until the capacity loop finds its key ready to serve reads (``residency.CapacityLoop``) — with
    the Graph residency switch on, or off, when the loop brings evicted graphs back."""
    return case((ProjectionStateORM.status == "rehydrating", "rehydrating"), else_=status)


class _Unresolved(tuple):
    """An edge-type resolver's answer when the ontology could not be read (an outage), as against
    ``None`` for one with no lineage: falsy, so every caller that skips rollup maintenance for
    "no lineage" skips it alike, and :meth:`FalkorProjector.summaries_built` tells them apart."""

    __slots__ = ()

    def __repr__(self) -> str:
        return "UNRESOLVED"


UNRESOLVED = _Unresolved()



#: Chains a rollup delta keeps cached across its pages, at most (``_compute_rollup_deltas``).
_CHAIN_CACHE_MAX = 200000
#: What a staged cell carries besides its weights and types: the ends' depths, levels and labels,
#: and the level digest (``_CellsOut.convert``).
_STAMPS = ("sd", "td", "sl", "tl", "slb", "tlb", "dg")


class _CellsOut:
    """Netted cells keyed by entity ids → the pairs the apply writes, keyed by urn: the level
    stamps, the urns and labels FalkorDB keys the ends by, and the level digest."""

    def __init__(self, svc, graph, main_id: str, from_seq: int, to_seq: int,
                 use_canonical: bool, level_map: Dict[str, int]) -> None:
        self.svc, self.graph, self.main_id = svc, graph, main_id
        self.from_seq, self.to_seq = from_seq, to_seq
        self.use_canonical, self.level_map = use_canonical, level_map

    async def convert(self, s, pairs: Dict[Tuple[str, str], Dict[str, object]]
                      ) -> Dict[Tuple[str, str], Dict[str, object]]:
        if not pairs:
            return {}
        ids = {i for k in pairs for i in k}
        # FalkorDB keys nodes by urn; versioned entity ids usually ARE urns, but imported
        # entities may differ — resolve through the entities' rows, with the SAME gv:<id>
        # fallback the raw projection uses (_node_urn) so the MATCH always hits. entityType is
        # what the node merge labeled the cache node with — carried so _apply_rollups anchors
        # every match on the per-label URN index instead of an unlabeled full scan per row.
        vals = await self.svc._skeletons_at(s, self.graph.id, self.main_id, ids, self.to_seq)
        urn_of = {i: ((vals.get(i) or {}).get("urn") or f"gv:{i}") for i in ids}
        lbl_of = {i: str(((vals.get(i) or {}).get("entityType")) or "Entity") for i in ids}
        digest = None
        if self.use_canonical:
            # Level stamps for every surviving cell: the node's type level as of the window's
            # end (as of its start for a node the window deleted).
            def level(v) -> Optional[int]:
                et_id = (v or {}).get("entityType") or None
                return self.level_map.get(et_id) if et_id else None

            lv = {i: level(vals.get(i)) for i in ids}
            gone = [i for i in ids if lv[i] is None]
            if gone:
                was = await self.svc._skeletons_at(s, self.graph.id, self.main_id, gone,
                                                   self.from_seq)
                lv.update({i: level(was.get(i)) for i in gone if level(was.get(i)) is not None})
            for (sx, tx), e in pairs.items():
                sl, tl = lv.get(sx), lv.get(tx)
                if sl is not None and tl is not None:
                    e["sl"], e["tl"] = sl, tl
            if self.level_map:
                from backend.app.services.ontology_levels import compute_level_digest
                digest = compute_level_digest(self.level_map)
        out: Dict[Tuple[str, str], Dict[str, object]] = {}
        for (sx, tx), v in pairs.items():                # distinct ids can share a urn — SUM
            e = out.setdefault((urn_of[sx], urn_of[tx]), {"dw": 0, "types": set()})
            e["dw"] += v["dw"]
            if "dwc" in v:
                e["dwc"] = e.get("dwc", 0) + v["dwc"]
            e["types"] |= v["types"]
            e.setdefault("slb", lbl_of[sx])
            e.setdefault("tlb", lbl_of[tx])
            if "sl" in v:
                e["sl"], e["tl"] = v["sl"], v["tl"]
            if "sd" in v:
                e["sd"], e["td"] = v["sd"], v["td"]
            if digest is not None:
                e["dg"] = digest
        return {k: v for k, v in out.items() if v["dw"] != 0 or v.get("dwc", 0) != 0}


class _CellNet:
    """A window's net lineage-summary deltas by cell: ``dw`` (the cube regime's), ``dwc`` (the
    canonical one's; None outside canonical mode), the raw types, and the two ends' depths.

    Held in memory by ``(source id, target id)`` up to ``cap`` cells. Past it, the cells are
    converted to the pairs the apply writes (``conversion``) and added to ``rollup_deltas`` by urn
    pair, and the memory let go: a window of any size nets in bounded memory, and each pair is one
    row, applied once (:meth:`pages`)."""

    def __init__(self, session_factory, graph_id: str, to_seq: int, cap: int,
                 conversion: _CellsOut) -> None:
        self._session, self.graph_id, self.to_seq, self.cap = session_factory, graph_id, to_seq, cap
        self.conversion = conversion
        self.cells: Dict[Tuple[str, str], list] = {}
        self.staged = False                          # Postgres is touched only once it stages

    def add(self, s_: str, t_: str, dw: int, dwc: Optional[int], typ: Optional[str],
            sd: Optional[int], td: Optional[int]) -> None:
        cell = self.cells.get((s_, t_))
        if cell is None:
            cell = self.cells[(s_, t_)] = [0, None if dwc is None else 0, set(), sd, td]
        cell[0] += dw
        if dwc is not None:
            cell[1] = (cell[1] or 0) + dwc
        if typ:
            cell[2].add(typ)
        if sd is not None:
            cell[3], cell[4] = sd, td

    async def page_done(self, s) -> None:
        if len(self.cells) > self.cap:
            await self.flush(s)

    async def flush(self, s) -> None:
        """Add the cells held in memory to ``rollup_deltas`` as the pairs the apply writes, summing
        a pair already there, and let them go. The first deletes what a pass that stopped left."""
        from sqlalchemy.dialects.postgresql import insert as pg_insert
        from .models import RollupDeltaORM as R
        pairs = await self.conversion.convert(s, self.netted())
        self.cells.clear()
        if not self.staged:
            async with self._session() as w:
                await w.execute(R.__table__.delete().where(R.graph_id == self.graph_id))
            self.staged = True
        rows = [{"graph_id": self.graph_id, "to_seq": self.to_seq, "s": s_, "t": t_,
                 "dw": v["dw"], "dwc": v.get("dwc"), "types": sorted(v["types"]),
                 **{k: v.get(k) for k in _STAMPS}} for (s_, t_), v in pairs.items()]
        for chunk in _batches(rows, 2000):           # 14 binds a row, under asyncpg's 32,767
            stmt = pg_insert(R).values(chunk)
            new = stmt.excluded
            stmt = stmt.on_conflict_do_update(
                index_elements=["graph_id", "to_seq", "s", "t"],
                set_={"dw": R.dw + new.dw, "dwc": R.dwc + new.dwc,
                      "types": R.types.op("||")(new.types),
                      **{k: func.coalesce(getattr(new, k), getattr(R, k)) for k in _STAMPS}})
            async with self._session() as w:
                await w.execute(stmt)

    async def clear(self) -> None:
        """Forget the cells: those in memory, and once it has staged, the graph's rows."""
        from .models import RollupDeltaORM as R
        self.cells.clear()
        if self.staged:
            async with self._session() as w:
                await w.execute(R.__table__.delete().where(R.graph_id == self.graph_id))

    def netted(self) -> Dict[Tuple[str, str], Dict[str, object]]:
        """The cells held in memory as the pair dicts the conversion takes, the zeros dropped."""
        out: Dict[Tuple[str, str], Dict[str, object]] = {}
        for key, (dw, dwc, types, sd, td) in self.cells.items():
            if dw == 0 and not dwc:
                continue
            e: Dict[str, object] = {"dw": dw, "types": set(types)}
            if dwc is not None:
                e["dwc"] = dwc
            if sd is not None:
                e["sd"], e["td"] = sd, td
            out[key] = e
        return out

    async def pages(self, size: int):
        """The staged pairs a page at a time, in ``(s, t)`` order, as the apply writes them; those
        that netted to nothing dropped."""
        from sqlalchemy import tuple_
        from .models import RollupDeltaORM as R
        cols = [R.s, R.t, R.dw, R.dwc, R.types, *(getattr(R, k) for k in _STAMPS)]
        after: Tuple[str, str] = ("", "")
        while True:
            async with self._session() as w:
                rows = (await w.execute(
                    select(*cols).where(R.graph_id == self.graph_id, R.to_seq == self.to_seq,
                                        tuple_(R.s, R.t) > tuple_(*after))
                    .order_by(R.s, R.t).limit(size))).all()
            page: Dict[Tuple[str, str], Dict[str, object]] = {}
            for s_, t_, dw, dwc, types, *stamps in rows:
                if dw == 0 and not dwc:
                    continue
                e: Dict[str, object] = {"dw": int(dw), "types": set(types or [])}
                if dwc is not None:
                    e["dwc"] = int(dwc)
                e.update((k, v) for k, v in zip(_STAMPS, stamps) if v is not None)
                page[(s_, t_)] = e
            if page:
                yield page
            if len(rows) < size:
                return
            after = (rows[-1][0], rows[-1][1])


class FalkorProjector:
    """Projects committed `main` state of a graph into its FalkorDB graph."""

    def __init__(
        self,
        graph_client_factory: Callable[..., object],   # (name, provider_id=None) -> graph | awaitable
        session_factory=db.graphver_session,
        batch_size: Optional[int] = None,
        target_resolver: Optional[
            Callable[[GraphVersioningService, str], Awaitable[Optional[str]]]
        ] = None,
        edge_types_resolver: Optional[
            Callable[[GraphVersioningService, str], Awaitable[Optional[Tuple[List[str], List[str]]]]]
        ] = None,
        on_rollups_stale: Optional[Callable[[str], Awaitable[None]]] = None,
        on_projected: Optional[Callable[[str], Awaitable[None]]] = None,
    ):
        self._client = graph_client_factory
        self._session = session_factory
        self._svc = GraphVersioningService(session_factory)
        self._batch = batch_size or config.PROJECTION_BATCH_SIZE
        # When each graph's whole-graph verify last found the stores agree (monotonic): what spaces
        # the verify out on a busy graph (PROJECTION_VERIFY_INTERVAL_SECS).
        self._verified_at: Dict[str, float] = {}
        # Ontology (containment, lineage) edge-type sets for incremental :AGGREGATED rollup
        # maintenance — injected from the app layer (like target_resolver) so this package
        # stays decoupled from the management DB. None ⇒ rollups are not maintained here.
        self._edge_types_resolver = edge_types_resolver
        # Fired when rollups can no longer be maintained incrementally (a full-seed wipe
        # destroyed them, or a containment move exceeded the bounded-recount cap) — the app
        # layer queues a scoped aggregation job. None ⇒ rollups stay stale until manual rebuild.
        self._on_rollups_stale = on_rollups_stale
        # Fired with the graph's data_source_id after a non-noop projection advanced the
        # watermark — the app layer nudges the insights counts poll so stats reflect
        # published/merged changes within seconds. Injected (like target_resolver) so this
        # package stays decoupled from the insights service. None ⇒ no nudge.
        self._on_projected = on_projected
        # Pins the projection to the data source's REAL graph (the one the canvas reads) on every
        # projection, so the async worker self-heals the same way the interactive `project_now` path
        # does — without it, a worker-driven projection can land in an orphan `gv_<id>` nothing reads
        # and merged main never surfaces. Injected (not imported) so this package stays decoupled from
        # the management DB. None ⇒ no repair (the app path repairs explicitly before projecting).
        self._target_resolver = target_resolver
        # graph_id → the watermark liveness last read the key's summaries stamp at: once per commit.
        self._summaries_checked: Dict[str, int] = {}

    @staticmethod
    def default_graph_name(graph_id: str) -> str:
        # Fallback only — real graphs carry the data source's graph_name on
        # projection_state.falkor_graph_name (set at create time).
        return f"gv_{graph_id}"

    async def _graph_client(self, name: str, provider_id: Optional[str] = None):
        """Acquire the graph handle from the injected factory. The factory contract is
        ``(name, provider_id=None)``; a registry-backed factory may resolve the provider
        row asynchronously, so an awaitable result is awaited here."""
        client = self._client(name, provider_id)
        if inspect.isawaitable(client):
            client = await client
        return client

    async def drop_graph(self, name: str, provider_id: Optional[str] = None) -> None:
        """``GRAPH.DELETE`` a cache graph's FalkorDB key (on its pinned provider
        instance), freeing its RAM; the next projection re-creates it from Postgres
        (plan §16.5 #9-10)."""
        await (await self._graph_client(name, provider_id)).delete()
        # GRAPH.DELETE took the key's indexes with it: the next seed into it must make them again.
        _URN_INDEXED.difference_update(
            {k for k in _URN_INDEXED if k[0] == provider_id and k[1] == name})
        # The next projection writes the graph again with a new id catalogue; every
        # long-lived reader must drop its old one (graph_generation).
        from backend.app.providers.graph_generation import bump_graph_generation
        await bump_graph_generation(name, reason="projection cache drop")

    def _width(self, client, kind: str) -> _Width:
        """The sticky width of statement ``kind`` on ``client``'s graph."""
        key = (str(getattr(client, "name", "") or id(client)), kind)
        ceiling = max(1, getattr(self, "_batch", None) or config.PROJECTION_BATCH_SIZE)
        width = _WIDTHS.get(key)
        if width is None or width.ceiling != ceiling:
            width = _WIDTHS[key] = _Width(ceiling)
        return width

    async def _laddered(self, client, kind: str, cypher: str, rows, *, param: str = "batch",
                        params: Optional[dict] = None, read_only: bool = False,
                        timeout_ms: int = _WRITE_TIMEOUT_MS, on_result=None, progress=None,
                        at_floor=None) -> None:
        """Run ``cypher`` over ``rows``, ``$<param>`` a chunk at a time, inside its budget (see the
        statement ladder above).
        - ``params``: the statement's other parameters.
        - ``on_result(chunk, result)``: called for each chunk that landed, halves included.
        - ``progress(n)``: awaited for each chunk that landed.
        - ``at_floor(row, exc)``: awaited for a single row that still fails after its retries;
          it returns True when it dealt with the row, else the pass fails.
        A connection failure, or any other error, is raised at once, so the pass backs off."""
        rows = list(rows)
        if not rows:
            return
        from backend.app.jobs.metrics import increment, observe
        width = self._width(client, kind)
        stats = _PASS_STATS.get() or _PassStats()
        budget_s = timeout_ms / 1000.0
        if not read_only:
            from backend.app.providers.falkordb_provider import clamp_write_budget
            budget_s = clamp_write_budget(budget_s)

        async def send(chunk: list) -> None:
            attempt = 0
            while True:
                started = _clock()
                try:
                    res = await _q(client, cypher, params={**(params or {}), param: chunk},
                                   timeout_ms=timeout_ms, read_only=read_only)
                except Exception as exc:
                    pressure = _pressure_kind(exc)
                    if pressure not in ("timeout", "memory"):
                        raise
                    if len(chunk) > 1:
                        width.halve(len(chunk))
                        stats.shrank(width.value)
                        increment("graphver_projection_splits_total", kind=kind, cause=pressure)
                        logger.warning("projection: %s of %d rows on %s %s; sending it in halves",
                                       kind, len(chunk), getattr(client, "name", "the graph"),
                                       "met the memory ceiling" if pressure == "memory"
                                       else "timed out")
                        mid = len(chunk) // 2
                        await send(chunk[:mid])
                        await send(chunk[mid:])
                        return
                    if attempt < config.PROJECTION_FLOOR_RETRIES:
                        await _sleep(_floor_backoff_s(attempt))
                        attempt += 1
                        continue
                    failure: BaseException = exc
                    if at_floor is not None:
                        try:
                            if await at_floor(chunk[0], exc):
                                return
                        except Exception as floor_exc:      # it too ran out of budget
                            if _pressure_kind(floor_exc) not in ("timeout", "memory"):
                                raise
                            failure = floor_exc
                    if await self._quarantine(kind, cypher, {**(params or {}), param: chunk},
                                              failure):
                        return
                    raise failure
                elapsed = _clock() - started
                width.note(len(chunk), slow=elapsed > budget_s / 2)
                stats.note(len(chunk), elapsed)
                observe("graphver_projection_statement_seconds", elapsed, kind=kind)
                await self._release(kind, chunk)
                if on_result is not None:
                    on_result(chunk, res)
                if progress:
                    await progress(len(chunk))
                return

        at = 0
        while at < len(rows):
            chunk = rows[at:at + width.value]
            await send(chunk)
            at += len(chunk)

    async def _quarantine(self, kind: str, cypher: str, params: dict, exc: BaseException) -> bool:
        """Hold a single row's statement that still fails in ``projection_quarantine``, so the rest
        of the window lands (``GRAPHVER_PROJECTION_QUARANTINE``). False — the pass fails, as
        before — when it is off, outside a pass, or for a statement it does not hold."""
        held = _PASS_HELD.get()
        spec = _QUARANTINABLE.get(kind)
        if not config.PROJECTION_QUARANTINE or held is None or spec is None:
            return False
        entity_kind, key_of = spec
        row = next(v for v in params.values() if isinstance(v, list))[0]
        key = key_of(row)
        from sqlalchemy.dialects.postgresql import insert as pg_insert
        stmt = pg_insert(ProjectionQuarantineORM).values(
            graph_id=held.graph_id, statement=kind, entity_key=key, entity_kind=entity_kind,
            cypher=cypher, params=json.loads(json.dumps(params, default=str)),
            error=str(exc)[:500], attempts=1, first_at=_now(), last_at=_now())
        stmt = stmt.on_conflict_do_update(
            index_elements=["graph_id", "statement", "entity_key"],
            set_={"cypher": stmt.excluded.cypher, "params": stmt.excluded.params,
                  "error": stmt.excluded.error, "last_at": stmt.excluded.last_at,
                  "attempts": ProjectionQuarantineORM.attempts + 1})
        async with self._session() as s:
            await s.execute(stmt)
            await self._mark_held(s, held.graph_id)
        held.keys.add((entity_kind, key))
        held.added += 1
        logger.error("projection of %s: %s for %s %s still failed on its own after %d retries (%s); "
                     "quarantined, and the rest of the window goes on", held.graph_id, kind,
                     entity_kind, key, config.PROJECTION_FLOOR_RETRIES, exc)
        return True

    async def _release(self, kind: str, chunk: list) -> None:
        """A chunk that landed wrote its entities as they are now: any of them the graph holds in
        quarantine, under any statement, is released — a newer write superseded it."""
        held = _PASS_HELD.get()
        spec = _QUARANTINABLE.get(kind)
        if held is None or not held.keys or spec is None:
            return
        entity_kind, key_of = spec
        landed = {key_of(row) for row in chunk} & {k for ek, k in held.keys if ek == entity_kind}
        if not landed:
            return
        async with self._session() as s:
            await s.execute(ProjectionQuarantineORM.__table__.delete().where(
                ProjectionQuarantineORM.graph_id == held.graph_id,
                ProjectionQuarantineORM.entity_kind == entity_kind,
                ProjectionQuarantineORM.entity_key.in_(sorted(landed))))
            await self._mark_held(s, held.graph_id)
        held.keys -= {(entity_kind, k) for k in landed}

    async def _mark_held(self, s, graph_id: str) -> None:
        """Keep ``projection_state.quarantine_next_at`` true to the table: when the graph's rows
        are next retried (``PROJECTION_QUARANTINE_RETRY_SECS`` from now), or NULL with none left."""
        left = (await s.execute(select(literal(1)).where(
            ProjectionQuarantineORM.graph_id == graph_id).limit(1))).first() is not None
        retry_at = (datetime.now(timezone.utc)
                    + timedelta(seconds=config.PROJECTION_QUARANTINE_RETRY_SECS)).isoformat()
        await s.execute(update(ProjectionStateORM)
                        .where(ProjectionStateORM.graph_id == graph_id)
                        .values(quarantine_next_at=retry_at if left else None)
                        .execution_options(synchronize_session=False))

    async def _retry_quarantined(self, client, graph_id: str, *, full_seed: bool) -> bool:
        """Before a pass writes: retry the graph's quarantined statements, oldest first, so its
        own writes land after them. One that lands leaves the table; one that still times out
        stays, counted. A full seed rewrites every entity itself, so its graph's rows are cleared
        instead: True when there were any. What is still held is the pass's (``_PASS_HELD``)."""
        held = _PASS_HELD.get()
        async with self._session() as s:
            if full_seed:
                cleared = (await s.execute(ProjectionQuarantineORM.__table__.delete().where(
                    ProjectionQuarantineORM.graph_id == graph_id))).rowcount
                await self._mark_held(s, graph_id)
                return bool(cleared)
            rows = (await s.execute(select(ProjectionQuarantineORM)
                                    .where(ProjectionQuarantineORM.graph_id == graph_id)
                                    .order_by(ProjectionQuarantineORM.first_at))).scalars().all()
        for row in rows:
            try:
                await _q(client, row.cypher, params=row.params)
            except Exception as exc:
                if _pressure_kind(exc) not in ("timeout", "memory"):
                    raise
                async with self._session() as s:
                    await s.execute(update(ProjectionQuarantineORM).where(
                        ProjectionQuarantineORM.graph_id == graph_id,
                        ProjectionQuarantineORM.statement == row.statement,
                        ProjectionQuarantineORM.entity_key == row.entity_key,
                    ).values(attempts=ProjectionQuarantineORM.attempts + 1, last_at=_now(),
                             error=str(exc)[:500]))
                if held is not None:
                    held.keys.add((row.entity_kind, row.entity_key))
                continue
            async with self._session() as s:
                await s.execute(ProjectionQuarantineORM.__table__.delete().where(
                    ProjectionQuarantineORM.graph_id == graph_id,
                    ProjectionQuarantineORM.statement == row.statement,
                    ProjectionQuarantineORM.entity_key == row.entity_key))
            logger.info("projection of %s: quarantined %s for %s landed on retry %d", graph_id,
                        row.statement, row.entity_key, row.attempts + 1)
        async with self._session() as s:
            await self._mark_held(s, graph_id)
        return False

    def _hub_safe_delete(self, client, label: str):
        """``at_floor`` for a node delete that still times out on its own: a hub, whose
        ``DETACH DELETE`` must drop every relationship on it in one statement. Its relationships are
        deleted a page at a time first (``_HUB_PAGE``, halved on a timeout), then the node."""
        async def delete(urn, _exc) -> bool:
            page = _HUB_PAGE
            while True:
                try:
                    await _q(client, f"MATCH (n:{label} {{urn: $u}})-[r]-() WITH DISTINCT r "
                                     "LIMIT $k DELETE r", params={"u": urn, "k": page})
                except Exception as exc:
                    if _pressure_kind(exc) in ("timeout", "memory") and page > 1:
                        page = max(1, page // 2)
                        continue
                    raise
                res = await _q(client, f"MATCH (n:{label} {{urn: $u}})-[r]-() RETURN 1 LIMIT 1",
                               params={"u": urn}, timeout_ms=_READ_TIMEOUT_MS, read_only=True)
                if not (getattr(res, "result_set", None) or []):
                    break
            await _q(client, _delete_nodes_cypher(label), params={"urns": [urn]})
            logger.warning("projection: node %s on %s deleted after its relationships, a page at "
                           "a time", urn, getattr(client, "name", "the graph"))
            return True
        return delete

    async def project_graph(self, graph_id: str, *, respect_backoff: bool = False) -> Dict[str, object]:
        """Catch a graph's FalkorDB projection up to its target watermark.

        ``respect_backoff``: a graph whose last pass failed waits out its backoff
        (``next_retry_at``) and answers ``skipped: backoff``, rather than replaying the window
        against a store that just failed it. A nudge (the worker) and ``project_now`` pass True; the
        poll already selects only graphs past their backoff; a rebuild and a load go at once.

        Single-flight per graph: publish/merge fan out one ``project_now`` each, so two
        near-simultaneous first merges on a blank graph could otherwise run overlapping
        full-seed DROP+reseed passes and corrupt the cache. The DROP+MERGE apply runs OUTSIDE
        any Postgres transaction, so a transaction-scoped lock cannot cover it — hold a
        SESSION-level advisory lock on a dedicated connection for the whole projection. A
        second concurrent projection finds the lock held and returns ``skipped: in-flight``
        without touching the cache; the lock is released (and the connection closed) in a
        finally so a later projection is never wedged. Different graphs use different keys.

        The lock's connection is a NullPool one of its own (``db.graphver_lock_session``), not one
        of the store pool's: it is held for the whole projection, and PROJECTION_CONCURRENCY of
        them out of the shared pool would leave the poll loop and the worker's jobs waiting.
        """
        lock_scope = (db.graphver_lock_session() if self._session is db.graphver_session
                      else self._session())
        lock_s = await lock_scope.__aenter__()
        lock_arg = func.hashtext(f"gvproj:{graph_id}")
        acquired = False
        spelling = SPELLING.set(None)       # the pass sets the graph's own; it ends with the pass
        try:
            acquired = bool(await lock_s.scalar(select(func.pg_try_advisory_lock(lock_arg))))
            if not acquired:
                return {"noop": True, "skipped": "in-flight"}
            stats = _PASS_STATS.set(_PassStats())
            held = _PASS_HELD.set(_Held(graph_id))
            try:
                return await self._project_graph_locked(graph_id, respect_backoff=respect_backoff)
            finally:
                _PASS_HELD.reset(held)
                _PASS_STATS.reset(stats)
        finally:
            SPELLING.reset(spelling)
            try:
                if acquired:
                    await lock_s.execute(select(func.pg_advisory_unlock(lock_arg)))
            finally:
                await lock_scope.__aexit__(None, None, None)

    async def fits_inline(self, graph_id: str, limit: Optional[int] = None) -> bool:
        """Whether the graph's next pass is small enough to run inside an interactive request
        (``project_now``): at most ``limit`` (``PROJECTION_INLINE_MAX_ROWS``) version rows to
        project, counted no further than that. A first seed or a rebuild never is. A graph this
        cannot read is left to the pass to judge."""
        limit = config.PROJECTION_INLINE_MAX_ROWS if limit is None else limit
        async with self._session() as s:
            ps = await s.get(ProjectionStateORM, graph_id)
            graph = await s.get(GraphORM, graph_id)
            if ps is None or graph is None:
                return True
            from_seq = ps.projected_commit_seq
            to_seq = max(ps.target_commit_seq, graph.main_head_commit_seq)
            if from_seq >= to_seq:
                return True
            if from_seq <= 0:
                return False
            main_id = await self._svc._main_branch_id(s, graph_id)
            rows = 0
            for model in (NodeVersionORM, EdgeVersionORM):
                rows += (await s.execute(select(func.count()).select_from(
                    select(model.id).where(
                        model.graph_id == graph_id, model.branch_id == main_id,
                        model.commit_seq > from_seq, model.commit_seq <= to_seq)
                    .limit(limit + 1).subquery()))).scalar_one()
                if rows > limit:
                    return False
        return True

    async def _queue_first_seed(self, graph_id: str, seen_epoch: int) -> bool:
        """Put a graph whose key holds nothing yet in the load queue (``waiting_capacity``),
        fenced on ``seen_epoch``; False when something moved its row first."""
        from .residency import request_load

        async with self._session() as s:
            row = (await s.execute(
                update(ProjectionStateORM)
                .where(ProjectionStateORM.graph_id == graph_id,
                       ProjectionStateORM.epoch == seen_epoch,
                       ProjectionStateORM.projected_commit_seq == 0,
                       ProjectionStateORM.status == "idle")
                .values(status="waiting_capacity", epoch=ProjectionStateORM.epoch + 1,
                        updated_at=_now())
                .returning(ProjectionStateORM.graph_id)
                .execution_options(synchronize_session=False))).first()
        if row is None:
            return False
        await request_load(graph_id)
        return True

    # The fenced writes to ``projection_state``. Each is its own short transaction on the store
    # pool — the lock connection stays write-free — and a CAS on ``epoch``: whatever reset the
    # watermark under a pass (evict, rebuild, repin, the bootstrap head flip) bumped it.
    async def _claim(self, graph_id: str, seen_epoch: int,
                     from_seq: int) -> Optional[Tuple[int, int]]:
        """Take the row for a pass from ``from_seq``: bump the epoch and set the status, only if
        neither the epoch nor the watermark moved since they were read. Returns ``(epoch,
        failed_attempts)``, or None when something else got there first."""
        # Honest lifecycle label: a full replay (explicit rebuild, first seed, repin)
        # reports "rebuilding"; an incremental window reports "projecting". A load (residency,
        # doc 17) stays "rehydrating" through its passes.
        status = "rebuilding" if from_seq <= 0 else "projecting"
        values = {"epoch": ProjectionStateORM.epoch + 1, "status": _unless_loading(status)}
        if from_seq <= 0:
            values.update(progress_done=0, progress_total=None)
        async with self._session() as s:
            row = (await s.execute(
                update(ProjectionStateORM)
                .where(ProjectionStateORM.graph_id == graph_id,
                       ProjectionStateORM.epoch == seen_epoch,
                       ProjectionStateORM.projected_commit_seq == from_seq)
                .values(**values)
                .returning(ProjectionStateORM.epoch, ProjectionStateORM.failed_attempts)
                .execution_options(synchronize_session=False)
            )).first()
        return tuple(row) if row is not None else None

    async def _finish(self, graph_id: str, mine: int, *, published: bool, to_seq: int,
                      error: Optional[str], attempts: Optional[int],
                      surplus: object = _UNCOUNTED) -> bool:
        """End a pass while the row is still its own (epoch ``mine``): publish ``to_seq``, or
        record the error and, unless ``attempts`` is None (a cancel), back off. Never writes the
        target or the key, which belong to the publishers and the repin. Returns False when the
        pass was superseded.

        On a customer's key a published pass also says what it found there that history doesn't
        hold: ``surplus`` (nodes, edges) becomes ``external_drift``, and none clears the count it
        recorded before. A flag a change notification raised stays (its ``via`` says so) until
        the changes are brought into history."""
        values = {"status": _unless_loading("idle"), "last_error": error,
                  "progress_done": None, "progress_total": None}      # progress is over either way
        if published:
            values.update(projected_commit_seq=to_seq, last_projected_at=_now(),
                          failed_attempts=0, next_retry_at=None)
            if surplus is not _UNCOUNTED:
                drift = ProjectionStateORM.external_drift
                notified = drift["via"].astext == "notification"
                values["external_drift"] = (
                    func.jsonb_build_object("at", _now(), "nodes", surplus[0], "edges", surplus[1],
                                            "via", case((notified, "notification"), else_="verify"))
                    if surplus else case((notified, drift), else_=null()))
        elif attempts is not None:
            values.update(failed_attempts=attempts + 1, next_retry_at=_retry_at(attempts + 1))
        async with self._session() as s:
            row = (await s.execute(
                update(ProjectionStateORM)
                .where(ProjectionStateORM.graph_id == graph_id, ProjectionStateORM.epoch == mine)
                .values(**values)
                .returning(ProjectionStateORM.graph_id)
                .execution_options(synchronize_session=False)
            )).first()
        return row is not None

    async def _escalate(self, graph_id: str, mine: int, reason: str, cause: str) -> bool:
        """Rebuild a graph its windows cannot bring up to date, on its own (``PROJECTION_ESCALATE``):
        the reset an operator's rebuild makes (``request_projection_rebuild``), fenced on this pass's
        epoch, so the next pass reconciles the key in place with committed main (streamed and
        resumable on a large graph) and publishes. Its last error says why, until then. False when
        something moved the row first."""
        from backend.app.jobs.metrics import increment
        head = select(GraphORM.main_head_commit_seq).where(GraphORM.id == graph_id).scalar_subquery()
        async with self._session() as s:
            row = (await s.execute(
                update(ProjectionStateORM)
                .where(ProjectionStateORM.graph_id == graph_id, ProjectionStateORM.epoch == mine)
                .values(projected_commit_seq=0, target_commit_seq=head,
                        status=_unless_loading("rebuilding"), epoch=ProjectionStateORM.epoch + 1,
                        failed_attempts=0, next_retry_at=None,
                        last_error=f"rebuilding on its own: {reason}"[:500])
                .returning(ProjectionStateORM.graph_id)
                .execution_options(synchronize_session=False))).first()
        if row is None:
            return False
        increment("graphver_projection_escalations_total", cause=cause)
        logger.warning("projection of %s is rebuilt in place on its own: %s", graph_id, reason)
        await nudge_projection(graph_id)
        return True

    async def _yield_superseded(self, graph_id: str, from_seq: int) -> None:
        """A superseded pass may have written after the pass that overtook it: lower the
        watermark to where it began (a no-op after an evict, rebuild or repin, which lowered it
        further) and bump the epoch, so the next pass re-applies over those writes."""
        async with self._session() as s:
            await s.execute(
                update(ProjectionStateORM)
                .where(ProjectionStateORM.graph_id == graph_id)
                .values(projected_commit_seq=func.least(ProjectionStateORM.projected_commit_seq,
                                                        from_seq),
                        epoch=ProjectionStateORM.epoch + 1, next_retry_at=None)
                .execution_options(synchronize_session=False))

    async def _project_graph_locked(self, graph_id: str, *,
                                    respect_backoff: bool = False) -> Dict[str, object]:
        """Projection body — runs under the single-flight lock held by :meth:`project_graph`."""
        # Self-heal the target FIRST (re-points an orphaned graph to the data source's real graph and
        # resets the watermark to replay full main into it). Returns the now-unread orphan to reclaim.
        orphan = await self._target_resolver(self._svc, graph_id) if self._target_resolver else None
        async with self._session() as s:
            ps = await s.get(ProjectionStateORM, graph_id)
            if ps is None:
                raise ValueError(f"no projection_state for graph {graph_id}")
            graph = await s.get(GraphORM, graph_id)
            if graph is None:
                raise ValueError(f"unknown graph {graph_id}")
            data_source_id = graph.data_source_id
            workspace_id = graph.workspace_id
            # Up to the committed head, not only the target: a pass that failed leaves the target
            # where it was, and a target behind the head must never park the graph below it.
            from_seq = ps.projected_commit_seq
            to_seq = max(ps.target_commit_seq, graph.main_head_commit_seq)
            seen_epoch = ps.epoch
            name = ps.falkor_graph_name or self.default_graph_name(graph_id)
            provider_id = ps.falkor_provider    # pinned instance; None → env default
            owned = bool(ps.owns_falkor_graph)  # how the verify counts it (falkor_counts)
            # What this pass may find in a customer's key that history doesn't hold, as last counted.
            drift = None if owned else ps.external_drift
            # Every label and type the pass writes or matches, in the graph's own spelling (reset
            # by ``project_graph``); a customer's graph that recorded none is read for it below.
            SPELLING.set(None if owned else spelling(ps.physical_types))
            unspelled = not owned and ps.physical_types is None
            if graph.fork_parent_graph_id is not None:
                # A fork has no FalkorDB copy: it reads through its root's store. A key an earlier
                # release pinned for one is never written again (the reaper drops it, when asked).
                return {"projected": from_seq, "applied": 0, "noop": True, "skipped": "fork"}
            if ps.status in ("evicted", "waiting_capacity"):
                # Residency (doc 17): an evicted graph stays evicted, its reads on Postgres, until
                # the capacity loop admits its load — whatever the Graph residency switch says:
                # off, the loop brings it back through admission, never a pass on its own. Fenced:
                # an eviction after this read bumped the epoch the claim below compares. (A fork
                # never reaches this: above.)
                return {"projected": from_seq, "applied": 0, "noop": True, "skipped": ps.status}
            # A caught-up graph whose quarantined entities are due goes on, with an empty window:
            # the pass retries them, and publishes where it is.
            quarantine_next_at = getattr(ps, "quarantine_next_at", None)
            if from_seq >= to_seq and not (from_seq > 0 and quarantine_next_at
                                           and quarantine_next_at <= _now()):
                return {"projected": from_seq, "applied": 0, "noop": True}
            if respect_backoff and ps.next_retry_at and ps.next_retry_at > _now():
                return {"projected": from_seq, "applied": 0, "noop": True, "skipped": "backoff",
                        "retryAt": ps.next_retry_at}
            if name == self.default_graph_name(graph_id):
                # No REAL FalkorDB target (a test-created graph, or one whose data source the
                # resolver couldn't heal): nothing ever reads a synthetic ``gv_<id>`` key, and even
                # an empty GRAPH.QUERY would instantiate it — so projecting only leaks orphan
                # FalkorDB graphs. Skip without advancing the watermark: reads keep falling back to
                # Postgres (the SoR), and a later repin (``ensure_projection_target``) re-enters the
                # normal path. ``project_pending`` applies the same filter in SQL so the poll loop
                # doesn't churn on these rows; this guard covers direct nudges.
                return {"projected": from_seq, "applied": 0, "noop": True, "skipped": "unpinned"}
            if graph.deleted_at is not None:
                # A tombstoned graph keeps its pin for the undo window; nothing may reseed it.
                return {"projected": from_seq, "applied": 0, "noop": True, "skipped": "deleted"}
            try:
                # Nothing projects while version control is being enabled: the key is the data
                # source's own graph, mid-copy, and main is parked at genesis.
                await self._svc._assert_not_bootstrapping(s, graph_id)
            except ConcurrencyError:
                return {"projected": from_seq, "applied": 0, "noop": True, "skipped": "bootstrapping"}
        if (from_seq == 0 and to_seq > 1 and owned and ps.status == "idle"
                and await residency_policy.switch_state() is not False
                and await self._queue_first_seed(graph_id, seen_epoch)):
            # Residency (doc 17): the first seed of a key the platform owns — a new graph's whole
            # main, in one go — is a full write, admitted as a load is: it takes its turn in the
            # load queue, and the capacity loop seeds it on a master with room for it. Also while
            # the switch cannot be read: nothing is written unadmitted on a guess.
            return {"projected": 0, "applied": 0, "noop": True, "skipped": "waiting_capacity"}

        # Claim the row before touching FalkorDB. Losing the claim means something reset the
        # watermark since the read (an evict, a rebuild, a repin): leave the key alone and let the
        # worker run a pass over the new state.
        claimed = await self._claim(graph_id, seen_epoch, from_seq)
        if claimed is None:
            await nudge_projection(graph_id)
            return {"projected": from_seq, "applied": 0, "noop": True, "skipped": "superseded"}
        mine, attempts = claimed
        pass_started = time.monotonic()
        cursor: Optional[_Cursor] = None
        changes, structural, retypes, rekeys, rollup_pairs = ([], [], [], []), False, [], [], None
        superseded = False
        try:
            # Inside the try: the factory does a real Postgres provider lookup + FalkorDB handle
            # build (a genuine suspension point), so a cancellation here must ALSO reset the
            # already-claimed "projecting" row rather than strand it.
            client = await self._graph_client(name, provider_id)
            if unspelled:
                await self._learn_spelling(client, graph_id)
            # What earlier passes quarantined goes first, so this pass's own writes land after it.
            cleared = False
            if quarantine_next_at is not None:
                cleared = await self._retry_quarantined(client, graph_id, full_seed=from_seq <= 0)
            async with self._session() as s:
                graph = await s.get(GraphORM, graph_id)
                main_id = await self._svc._main_branch_id(s, graph_id)
                # A full replay (first seed, explicit rebuild, repin) is an in-place
                # reconcile against what the graph already holds — its writes are known
                # only once the diff runs, so it computes (and reports) them itself. A window
                # too large to hold is computed a page at a time as it is written (_apply_paged).
                paged = False
                if from_seq > 0:
                    changes = await self._compute_changes(s, graph, main_id, from_seq, to_seq)
                    paged = changes is None
                    changes = changes or ([], [], [], [])
                if paged or from_seq <= 0:
                    # Only these write a cursor (a long pass's resume point): one that stopped at
                    # a page boundary is finished first, from the same watermark, to its own
                    # ``pTo``, where it stopped. The window after it is the next pass's.
                    found = await _read_cursor(client)
                    resume = None
                    if found is not None and found[0] == from_seq and from_seq < found[1] <= to_seq:
                        to_seq, resume = found[1], (found[2], found[3])
                        logger.info("projection of %s resumes (%d, %d] at %s after %s", graph_id,
                                    from_seq, to_seq, found[2], found[3] or "the start")
                    cursor = _Cursor(client, from_seq, to_seq, resume,
                                     (pass_started + config.PROJECTION_PASS_MAX_SECS)
                                     if config.PROJECTION_PASS_MAX_SECS > 0 else None)
                total_items = sum(len(c) for c in changes)
                prior = None
                if from_seq > 0 and not paged:
                    structural, retypes, rekeys = await self._window_meta(
                        s, graph, main_id, from_seq, changes)
                    if not owned:
                        prior = await self._properties_before(s, graph, main_id, from_seq,
                                                              changes[0])

            # Ontology entity-type→level map so projected nodes carry n.level (parity with
            # save_custom_graph). Best-effort: {} when unavailable, leaving level unset.
            level_map = await self._resolve_level_map(graph_id)
            reconciled: Optional[Dict[str, object]] = None
            dropped = paged_writes = 0
            if from_seq <= 0:
                # Probe BEFORE writing anything. Deliberately NOT ``read_only``: it is a proof
                # that this node takes the writes below — under ``min-replicas-to-write`` a read
                # is answered while a write is refused — and ``GRAPH.RO_QUERY`` raises on a key
                # that does not exist yet, which is exactly a first seed. Unreachable → the outer
                # handler records the error and leaves the cache as it was.
                await _q(client, "RETURN 1", timeout_ms=_READ_TIMEOUT_MS)
                # A full replay RECONCILES IN PLACE: it writes only what differs from committed
                # main (so a delete a merged draft made still leaves the cache) and never drops
                # the graph — dropping renumbered every label / type / property id under every
                # long-lived reader (Domain rendered as "Schema Field"), took the indexes, and
                # took every :AGGREGATED rollup with it. On a fresh key the diff is simply
                # "everything", so a first seed is the same code path.
                reconciled = await self._reconcile_in_place(
                    client, graph_id, main_id, to_seq, level_map, track_progress=True,
                    provider_id=provider_id, owned=owned, cursor=cursor)
                if cleared:
                    # What was held back was missing from the key when its window's rollups
                    # moved, so they already count what the reconcile has just written: moving
                    # them by its difference would count it twice. The job rebuilds them.
                    reconciled = {**reconciled, "rollups": "stale"}
            elif paged:
                dropped, structural, paged_writes = await self._apply_paged(
                    client, graph_id, main_id, from_seq, to_seq, level_map=level_map,
                    provider_id=provider_id, owned=owned, cursor=cursor)
            else:
                await self._rekey_in_place(client, rekeys)
                await self._relabel_in_place(client, retypes)
                dropped = await self._apply(client, *changes, level_map=level_map,
                                            provider_id=provider_id, owned=owned,
                                            prior=prior) or 0
            window_rollups_applied = False
            # Incremental :AGGREGATED rollup maintenance for a publish window, once its raw writes
            # have landed: a pass that stops part-way computes none. A full replay's rollups are
            # moved by the reconcile's own diff instead. A failure here must NEVER wedge raw-edge
            # projection — degrade to the rebuild.
            if from_seq > 0 and self._edge_types_resolver is not None:
                try:
                    async with self._session() as s:
                        rollup_pairs = await self._compute_rollup_deltas(
                            s, graph, main_id, from_seq, to_seq)
                except Exception:                        # pragma: no cover - defensive
                    logger.exception("rollup delta computation failed for %s — queuing rebuild",
                                     graph_id)
                    rollup_pairs = "stale"
            if rollup_pairs and rollup_pairs != "stale":
                window_rollups_applied = True
                # After the raw upserts, so pair endpoints exist. Idempotent per window
                # (gvSeq guard), so a retried window can't double-count weights. A rollup
                # failure must NEVER hold back raw-edge projection (rollups are a derived
                # convenience layer) — degrade to the rebuild hook instead of raising.
                try:
                    if not await self._apply_rollups(client, rollup_pairs, from_seq, to_seq):
                        rollup_pairs = "stale"           # window overlapped a prior application
                except Exception:                       # pragma: no cover - infra
                    logger.exception("rollup apply failed for %s — queuing rebuild", graph_id)
                    rollup_pairs = "stale"

            # Reconcile PG (SoR) vs FalkorDB (cache) and bounded-heal a dropped delta before
            # the watermark advances, so the cache can't silently diverge from committed main.
            # A reconcile that died between its raw and rollup writes (its heal's retry is an
            # ordinary window that would otherwise publish over it) leaves rollups no delta can
            # repair: every pass checks, and hands them to the batch job.
            interrupted = False
            try:
                interrupted = await reconcile_interrupted(client)
            except Exception:                            # pragma: no cover - infra
                logger.debug("rollup health unreadable for %s", graph_id, exc_info=True)
            heal_outcome: Dict[str, object] = {}
            held = _PASS_HELD.get()
            quarantined = len(held.keys) if held is not None else 0
            # While the graph holds quarantined entities its counts cannot match: it publishes
            # unverified (and Data health says why), and verifies again once they have landed.
            verify = (config.PROJECTION_VERIFY_ENABLED and not quarantined
                      and self._verify_due(graph_id, from_seq, dropped, drift))
            if quarantined:
                heal_outcome["unverified"] = True
            verify_error, healed = (
                await self._verify_and_heal(client, graph_id, main_id, from_seq, to_seq,
                                            level_map=level_map, heal_outcome=heal_outcome,
                                            rollups_moved=window_rollups_applied, owned=owned,
                                            provider_id=provider_id, dropped=dropped, drift=drift)
                if verify else (None, False)
            )
            if verify:                  # a clean verify spaces out the next; any other asks for one
                if verify_error is None and not healed and not heal_outcome.get("unverified"):
                    self._verified_at[graph_id] = time.monotonic()
                else:
                    self._verified_at.pop(graph_id, None)

            # Verified faithful → publish: advance the watermark so reads flip to FalkorDB. A reseed
            # that did NOT match committed main (a dropped/mistyped edge, a drifted field — the
            # content-drift class the old count-only verify published blind) is held back:
            # projected stays below committed so `fresh` stays false and reads keep falling back
            # to Postgres (the SoR) instead of flipping onto a corrupt cache, and the poll retries
            # it after a backoff.
            published = verify_error is None
            if published and cursor is not None and (cursor.used or cursor.resume is not None):
                await _q(client, _CURSOR_CLEAR)          # its window is done: nothing to resume
            if published:
                # The marker is the pass's LAST FalkorDB write, after the verify and before the
                # watermark: a replica that confirmed it holds everything the pass wrote.
                verify_error = await _write_marker(client, to_seq, mine)
                published = verify_error is None
            if not await self._finish(graph_id, mine, published=published, to_seq=to_seq,
                                      error=verify_error, attempts=attempts,
                                      surplus=heal_outcome.get("surplus", _UNCOUNTED)):
                # Something reset the watermark while this pass wrote (an evict, a rebuild, a
                # repin, another pass): it wins. This pass's writes may have landed after the
                # winner's, so lower the watermark to where it began; the next pass re-applies.
                superseded, published = True, False
                await self._yield_superseded(graph_id, from_seq)
            elif not published and heal_outcome.get("escalate"):
                await self._escalate(graph_id, mine, str(heal_outcome["escalate"]), "drift")
            elif not published:
                logger.error("projection for %s held back at seq %d; holding watermark "
                             "at %d so reads stay on Postgres; retry after backoff — %s", graph_id,
                             to_seq, from_seq, verify_error)
        except _PassPartial as stop:
            # Out of its time at a page boundary, its cursor written: not a failure. It publishes
            # nothing, records no error and no backoff, and asks for the next pass at once, which
            # resumes where it stopped. Other graphs get their turn meanwhile.
            logger.info("projection of %s over (%d, %d] %s; the next pass resumes there",
                        graph_id, from_seq, to_seq, stop)
            from backend.app.jobs.metrics import increment
            increment("graphver_projection_passes_total", outcome="partial")
            if not await asyncio.shield(self._finish(graph_id, mine, published=False, to_seq=to_seq,
                                                     error=None, attempts=None)):
                await self._yield_superseded(graph_id, from_seq)
            await nudge_projection(graph_id)
            return {"projected": from_seq, "applied": stop.written, "noop": False,
                    "partial": True, "target": to_seq}
        except (Exception, asyncio.CancelledError) as exc:
            # Reset the "projecting" row committed above so it is not stranded — a stranded row
            # spins the UI's "Refreshing…" badge forever AND blocks the manual rebuild escape
            # hatch (request_projection_rebuild skips a graph still in {projecting, rebuilding}).
            # `except Exception` alone does NOT catch asyncio.CancelledError (a BaseException
            # since Python 3.8), so a caller-side timeout (asyncio.wait_for in project_now) — or
            # any other cancellation once "projecting" is committed — used to strand it. A cancel
            # BEFORE that commit never reaches this handler and correctly leaves the prior status
            # untouched. CancelledError is re-raised below per the asyncio contract — never swallowed.
            cancelled = isinstance(exc, asyncio.CancelledError)
            # Not a fault of the pass: the graph spells a type two ways, until someone fixes it.
            ambiguous = isinstance(exc, AmbiguousSpelling)
            from backend.app.jobs.metrics import increment
            increment("graphver_projection_passes_total",
                      outcome="cancelled" if cancelled else "failed")
            if cancelled:
                logger.warning("projection for %s cancelled; resetting status so it is not stranded",
                               graph_id)
            elif ambiguous:
                logger.warning("projection for %s held back: %s", graph_id, exc)
            else:
                logger.exception("projection apply failed for %s: %s", graph_id, exc)

            async def _reset_status() -> None:
                # NB: a cancel does not back off. It means a SHORT-budget caller gave up
                # (project_now's 10s interactive ceiling — common for a first-import / post-
                # eviction full seed) and DEFERS to the async worker, which re-runs with the
                # 900s budget at once.
                error = "projection cancelled (timeout)" if cancelled else str(exc)[:500]
                if not await self._finish(graph_id, mine, published=False, to_seq=to_seq,
                                          error=error, attempts=None if cancelled else attempts):
                    await self._yield_superseded(graph_id, from_seq)

            # Shield the reset so a SECOND cancellation (e.g. uvicorn shutdown mid-cleanup) can't
            # abort the write and re-strand the row; catch a Postgres error so it can't replace the
            # CancelledError we owe our caller. Then re-raise the original.
            try:
                await asyncio.shield(_reset_status())
            except Exception:                          # pragma: no cover - infra
                logger.warning("could not reset projection status for %s after failure/cancel",
                               graph_id, exc_info=True)
            # The same window failed under pressure the ladder could not absorb, pass after pass:
            # rebuild in place instead of retrying it for good.
            if (not cancelled and not ambiguous and config.PROJECTION_ESCALATE and from_seq > 0
                    and attempts + 1 >= config.PROJECTION_ESCALATE_AFTER
                    and _pressure_kind(exc) in ("timeout", "memory")):
                try:
                    await asyncio.shield(self._escalate(
                        graph_id, mine, f"{attempts + 1} passes in a row failed: {exc}"[:300],
                        "failures"))
                except Exception:                      # pragma: no cover - infra
                    logger.warning("could not start a rebuild of %s", graph_id, exc_info=True)
            if ambiguous:
                return {"projected": from_seq, "applied": 0, "noop": False,
                        "verify_error": str(exc)}
            raise

        if orphan:                                     # the old gv_* graph is now unread — reclaim its RAM
            try:
                await self.drop_graph(orphan, provider_id)
            except Exception as exc:                   # pragma: no cover - infra
                logger.warning("could not drop orphan projection graph %s: %s", orphan, exc)

        # Everything below runs AFTER the watermark is durable and must run exactly then: the
        # rollup hand-off, the structural bump, the read-cache invalidation, the ontology bump.
        # A caller's budget (project_now's 10s, then the worker takes over) must not cancel it
        # half-way — the worker finds nothing left to project and would never re-run it — so it
        # is shielded: a cancel still reaches the caller, and these finish on their own.
        async def _after_publish() -> None:
            # Rollups the projector could not move by delta itself: a reconcile whose difference
            # was too large to do inline or which found the stored rollups untrustworthy (stubs,
            # a crashed reconcile, never aggregated), or a publish window with a containment move /
            # bulk change / overlapping application. Hand off to the app layer to queue the
            # aggregation batch job, which derives them from the raw graph and writes only the
            # difference (fires after the watermark is durable, so it sees the projected raw edges).
            # Gated on `published`: aggregating over — or nudging insights for — an unfaithful seed
            # that was NOT published (reads still serve Postgres) would build rollups on top of a
            # known-bad raw layer. The next pass that publishes re-evaluates it.
            rollups_stale = (rollup_pairs == "stale" or interrupted
                             or (reconciled or {}).get("rollups") == "stale"
                             or heal_outcome.get("rollups") == "stale")
            if published and self._on_rollups_stale is not None and rollups_stale:
                try:
                    await self._on_rollups_stale(graph_id)
                except Exception as exc:                   # pragma: no cover - infra
                    logger.warning("rollup-rebuild hook failed for %s: %s", graph_id, exc)

            # A retype or a containment change leaves every reader's urn→label and ancestor
            # caches describing the old shape; the graph's generation tells every process to
            # drop them (graph_generation — pulled by each provider within seconds).
            if published and (structural or (reconciled or {}).get("structural")
                              or heal_outcome.get("structural")):
                from backend.app.providers.graph_generation import bump_graph_generation
                await bump_graph_generation(name, reason="structural change published")

            # Committed main just landed in the real FalkorDB graph — let the
            # app layer nudge the insights counts poll (after the watermark is
            # durable, so the poll observes the projected state).
            if published and self._on_projected is not None and data_source_id:
                try:
                    await self._on_projected(data_source_id)
                except Exception as exc:                   # pragma: no cover - infra
                    logger.warning("on_projected hook failed for %s: %s", graph_id, exc)

            # A full-seed / heal reseed can change the graph's stored relationship-type spelling, but the
            # reader's ontology→observed alias map is cached (resolved_ontology_cache) and is NOT
            # invalidated by a projection rebuild — so reads keep matching the PRE-rebuild spelling and
            # raw lineage edges (whose declared types are often mixed-case) silently stop rendering until
            # the TTL lapses. Bump the ontology generation so every pod re-introspects the reseeded graph
            # and rebuilds a correct alias (and drop this pod's L1 entry immediately). Best-effort;
            # scoped to full-seed/heal so incremental publishes don't re-incur the resolve/DDL tax.
            if published and (from_seq <= 0 or healed) and workspace_id and data_source_id:
                try:
                    from backend.app.services.resolved_ontology_cache import bump_ontology_generation
                    await bump_ontology_generation(workspace_id, data_source_id)
                except Exception as exc:                   # pragma: no cover - infra
                    logger.warning("ontology-generation bump after rebuild failed for %s: %s",
                                   graph_id, exc)


        await asyncio.shield(asyncio.ensure_future(_after_publish()))

        applied = sum(len(c) for c in changes) + paged_writes \
            + int((reconciled or {}).get("writes") or 0) + int(heal_outcome.get("writes") or 0)
        # Report the seq actually PUBLISHED: to_seq when verified, else the held-back from_seq
        # (the watermark did not advance — reads stay on Postgres).
        result = {"projected": to_seq if published else from_seq, "applied": applied,
                  "noop": False, "verify_error": verify_error}
        if heal_outcome.get("unverified"):
            result["unverified"] = True
        if quarantined:
            result["quarantined"] = quarantined
        from backend.app.jobs.metrics import increment
        increment("graphver_projection_passes_total",
                  outcome=("superseded" if superseded else "held_back" if not published
                           else "unverified" if heal_outcome.get("unverified") else "published"))
        stats = _PASS_STATS.get()
        if stats is not None:
            result["stats"] = stats.as_dict()
            logger.info("projection pass for %s over (%d, %d]: %s; %d statement(s), %d row(s), "
                        "slowest %.0f ms, %d split(s)%s", graph_id, from_seq, to_seq,
                        "published" if published else "held back", stats.statements, stats.rows,
                        stats.max_ms, stats.shrinks,
                        f", down to {stats.min_width} row(s)" if stats.min_width else "")
        if superseded:
            await nudge_projection(graph_id)
            result["skipped"] = "superseded"
        return result

    async def check_liveness(self) -> List[Dict[str, object]]:
        """Lower the watermark of every idle graph whose FalkorDB key lost what the watermark says
        it holds (:func:`liveness_reset_to`), so the poll reseeds it or re-applies the lost window
        instead of reads being served from it. Graphs at genesis, tombstoned or still being
        enabled for version control are not checked, nor forks, which are never projected (a copy
        an earlier release made of one is no store of theirs); a key that cannot be read is left
        alone.
        Each reset is fenced like a pass: it lands only while the row's epoch and watermark are
        still the ones read. A key that holds what it should is also checked for a summaries
        build (:meth:`_ask_for_first_summaries`). Returns the resets."""
        async with self._session() as s:
            rows = (await s.execute(
                select(ProjectionStateORM.graph_id, ProjectionStateORM.falkor_graph_name,
                       ProjectionStateORM.falkor_provider, ProjectionStateORM.projected_commit_seq,
                       ProjectionStateORM.epoch, ProjectionStateORM.owns_falkor_graph)
                .join(GraphORM, GraphORM.id == ProjectionStateORM.graph_id)
                .where(
                    ProjectionStateORM.status == "idle",
                    GraphORM.fork_parent_graph_id.is_(None),
                    # Past genesis (main's eviction rule): a key at genesis may be the data
                    # source's own graph, and a reseed from genesis would empty it.
                    ProjectionStateORM.projected_commit_seq > 1,
                    ProjectionStateORM.falkor_graph_name.isnot(None),
                    ProjectionStateORM.falkor_graph_name
                    != literal("gv_").concat(ProjectionStateORM.graph_id),
                    GraphORM.deleted_at.is_(None),
                    ~select(1).where(*bootstrap_unfinished(ProjectionStateORM.graph_id))
                    .correlate(ProjectionStateORM).exists(),
                )
            )).all()
        sem = asyncio.Semaphore(config.PROJECTION_CONCURRENCY)
        residency_on = await residency_policy.switch_state() is not False

        async def _one(gid, name, provider_id, projected, epoch,
                       owned) -> Optional[Dict[str, object]]:
            async with sem:
                try:
                    client = await self._graph_client(name, provider_id)
                    exists, seq = await read_projection_marker(client)
                except Exception as exc:
                    logger.warning("liveness: cannot read the projection of %s (%s): %s",
                                   gid, name, exc)
                    return None
                to_seq = liveness_reset_to(exists, seq, projected) if exists is not None else None
                if exists and to_seq is None:
                    await self._ask_for_first_summaries(gid, client, projected)
            if exists is None:
                return None
            if to_seq is None:
                return None
            reason = ("liveness: projection key missing" if not exists
                      else f"liveness: marker seq {seq} < projected {projected}")
            # Residency (doc 17): a key the master lost, of a graph whose key the platform owns, is
            # evicted (lost) rather than reseeded at once and unadmitted: its load is admitted
            # like any other — on its next read, or by the next pass for an Always graph. Also
            # while the switch cannot be read; off, it is reseeded at once, as before residency.
            lost = residency_on and to_seq == 0 and owned
            async with self._session() as s:
                row = (await s.execute(
                    update(ProjectionStateORM)
                    .where(ProjectionStateORM.graph_id == gid,
                           ProjectionStateORM.epoch == epoch,
                           ProjectionStateORM.projected_commit_seq == projected,
                           ProjectionStateORM.status == "idle")
                    .values(projected_commit_seq=to_seq, epoch=ProjectionStateORM.epoch + 1,
                            last_error=reason, failed_attempts=0, next_retry_at=None,
                            updated_at=_now(),
                            **({"status": "evicted", "evicted_reason": "lost"} if lost else {}))
                    .returning(ProjectionStateORM.graph_id)
                    .execution_options(synchronize_session=False)
                )).first()
            if row is None:
                return None                     # a pass or a reset got there first
            logger.error("%s for graph %s (%s): watermark %s -> %s%s",
                         reason, gid, name, projected, to_seq, " (evicted, lost)" if lost else "")
            if not lost:
                await nudge_projection(gid)
            return {"graph_id": gid, "projected": projected, "reset_to": to_seq, "reason": reason}

        done = await asyncio.gather(*[_one(*r) for r in rows])
        await self._ask_again_for_summaries()
        return [d for d in done if d is not None]

    async def _ask_again_for_summaries(self) -> None:
        """Ask again for the lineage-summaries builds owed (``projection_state.rollup_state``): a
        build asked for while a job was already running, which may have read the graph before the
        change that asked, or while the service was out of reach. Each graph's at most every
        ``GRAPHVER_ROLLUP_REASK_SECS``; the hook records how each ask went, so one that is
        queued is owed no more. Never raises."""
        if self._on_rollups_stale is None or config.ROLLUP_REASK_SECS <= 0:
            return
        due = (datetime.now(timezone.utc)
               - timedelta(seconds=config.ROLLUP_REASK_SECS)).isoformat()
        try:
            async with self._session() as s:
                owed = (await s.execute(
                    select(ProjectionStateORM.graph_id)
                    .where(ProjectionStateORM.rollup_state["asked"].astext < due)
                )).scalars().all()
        except Exception as exc:                         # pragma: no cover - infra
            logger.warning("liveness: cannot read which summaries builds are owed: %s", exc)
            return
        for gid in owed:
            logger.info("liveness: asking again for the summaries build of %s", gid)
            try:
                await self._on_rollups_stale(gid)
            except Exception as exc:                     # pragma: no cover - app-layer hooks
                logger.warning("liveness: the summaries build of %s was not asked for again: %s",
                               gid, exc)

    async def _ask_for_first_summaries(self, graph_id: str, client, projected: int) -> None:
        """Hand the summaries of a key no summaries build ever stamped to the batch job
        (``on_rollups_stale``). Readers serve the ``:AGGREGATED`` layer only once a build has
        stamped it, so until then every canvas says its connections between collapsed items
        haven't been summarised; and this projector only moves summaries by delta, which never
        builds them, so nothing else ever would — a graph enabled before any build, a blank model
        made where the web tier hands summaries to the control plane, a hand-off that failed.
        Not for a source whose summaries live in a dedicated key (this key never holds the stamp:
        publishes hand those over) or whose ontology has no lineage (readers need none). Once per
        commit: a key read at this watermark is not read again until a later commit lands. Never
        raises."""
        if self._on_rollups_stale is None or self._edge_types_resolver is None:
            return
        if self._summaries_checked.get(graph_id) == projected:
            return
        try:
            res = await _q(client, _SUMMARIES_BUILT, read_only=True, timeout_ms=5000)
        except Exception as exc:
            logger.warning("liveness: cannot read whether %s was summarised: %s", graph_id, exc)
            return
        self._summaries_checked[graph_id] = projected
        rows = getattr(res, "result_set", None) or []
        if rows and rows[0] and int(rows[0][0] or 0) > 0:
            return
        try:
            sets = await self._edge_types_resolver(self._svc, graph_id)
            if sets and sets[1] and "dedicated" not in sets[3:]:
                logger.info("liveness: %s has no summaries build — asking for its first", graph_id)
                await self._on_rollups_stale(graph_id)
        except Exception as exc:                          # pragma: no cover - app-layer hooks
            logger.warning("liveness: the first summaries build of %s was not asked for: %s",
                           graph_id, exc)

    async def summaries_built(self, graph_id: str, name: str, provider_id: Optional[str],
                              projected: int, *, ask: Optional[str] = None) -> Optional[bool]:
        """Whether a graph's key holds the summaries its readers need: a summaries build stamped
        it, or it needs none here (no lineage in its ontology, its summaries kept in a dedicated
        key, or no aggregation wired into this projector). A key still without them has the build
        asked for, once per watermark — and per ``ask``, which names the ask under its own
        idempotency key (a load's epoch and attempt: the aggregation service answers a key it has
        seen within the hour with the job it already ran). A key that cannot be read has not got
        them. None — falsy, but not "not yet" — when its ontology could not be read
        (:data:`UNRESOLVED`): it may need them, and nothing can tell."""
        if self._on_rollups_stale is None or self._edge_types_resolver is None:
            return True
        sets = await self._edge_types_resolver(self._svc, graph_id)
        if sets is UNRESOLVED:
            return None
        if not (sets and sets[1]) or "dedicated" in sets[3:]:
            return True
        try:
            res = await _q(await self._graph_client(name, provider_id), _SUMMARIES_BUILT,
                           read_only=True, timeout_ms=5000)
        except Exception as exc:
            logger.warning("cannot read whether %s was summarised: %s", graph_id, exc)
            return False
        rows = getattr(res, "result_set", None) or []
        if rows and rows[0] and int(rows[0][0] or 0) > 0:
            return True
        if self._summaries_checked.get(graph_id) != (projected, ask):
            self._summaries_checked[graph_id] = (projected, ask)
            if ask is None:
                await self._on_rollups_stale(graph_id)
            else:
                await self._on_rollups_stale(
                    graph_id, idempotency_key=f"gv-rollup-rebuild:{graph_id}:{projected}:{ask}")
        return False

    async def run_publish_hooks(self, graph_id: str, *, full_seed: bool = False,
                                rollups_stale: bool = False) -> None:
        """What a projection runs once a graph's raw layer is published, for a graph whose raw
        layer a job wrote itself (a new data source seeded from a view package writes its own key,
        then flips the head): the rollup rebuild (``rollups_stale``), the read caches and the
        ontology alias map (``full_seed``: the graph was written whole), and the insights nudge.
        The same hooks, in the same order, as the publish tail of :meth:`project_graph`. Best
        effort: a hook that fails is logged; the graph is already live."""
        async with self._session() as s:
            graph = await s.get(GraphORM, graph_id)
            ps = await s.get(ProjectionStateORM, graph_id)
        if graph is None:
            return
        name = (ps.falkor_graph_name if ps else None) or self.default_graph_name(graph_id)
        if rollups_stale and self._on_rollups_stale is not None:
            try:
                await self._on_rollups_stale(graph_id)
            except Exception as exc:                       # pragma: no cover - infra
                logger.warning("rollup-rebuild hook failed for %s: %s", graph_id, exc)
        if full_seed:
            try:
                from backend.app.providers.graph_generation import bump_graph_generation
                await bump_graph_generation(name, reason="graph written whole")
            except Exception as exc:                       # pragma: no cover - infra
                logger.warning("graph-generation bump failed for %s: %s", graph_id, exc)
        if self._on_projected is not None and graph.data_source_id:
            try:
                await self._on_projected(graph.data_source_id)
            except Exception as exc:                       # pragma: no cover - infra
                logger.warning("on_projected hook failed for %s: %s", graph_id, exc)
        if full_seed and graph.workspace_id and graph.data_source_id:
            try:
                from backend.app.services.resolved_ontology_cache import bump_ontology_generation
                await bump_ontology_generation(graph.workspace_id, graph.data_source_id)
            except Exception as exc:                       # pragma: no cover - infra
                logger.warning("ontology-generation bump after a full write failed for %s: %s",
                               graph_id, exc)

    async def _report_lag(self) -> None:
        """Every poll, the fleet's lag as gauges, one series each (never one per graph):
        - ``graphver_projection_lagging_graphs``: graphs projected below their head;
        - ``graphver_projection_lag_commits_max``: the most commits one of them is behind;
        - ``graphver_projection_lag_seconds_max``: the longest since one of them last published;
        - ``graphver_projection_quarantined``: entities held in quarantine, across graphs.
        Best effort: a failure is logged, and the poll goes on."""
        from backend.app.jobs.metrics import gauge_set
        head = func.greatest(ProjectionStateORM.target_commit_seq, GraphORM.main_head_commit_seq)
        behind = ProjectionStateORM.projected_commit_seq < head
        try:
            async with self._session() as s:
                lagging, commits, since = (await s.execute(
                    select(func.count(), func.max(head - ProjectionStateORM.projected_commit_seq),
                           func.min(ProjectionStateORM.last_projected_at))
                    .select_from(ProjectionStateORM)
                    .join(GraphORM, GraphORM.id == ProjectionStateORM.graph_id)
                    .where(behind, GraphORM.deleted_at.is_(None),
                           GraphORM.fork_parent_graph_id.is_(None),
                           ProjectionStateORM.status.notin_(("evicted", "waiting_capacity"))))).one()
                held = (await s.execute(select(func.count()).select_from(
                    ProjectionQuarantineORM))).scalar_one()
        except Exception:                                    # pragma: no cover - infra
            logger.debug("projection lag gauges not read", exc_info=True)
            return
        seconds = 0.0
        if lagging and since:
            try:
                seconds = max(0.0, (datetime.now(timezone.utc)
                                    - datetime.fromisoformat(str(since))).total_seconds())
            except ValueError:
                seconds = 0.0
        gauge_set("graphver_projection_lagging_graphs", float(lagging or 0))
        gauge_set("graphver_projection_lag_commits_max", float(commits or 0))
        gauge_set("graphver_projection_lag_seconds_max", seconds)
        gauge_set("graphver_projection_quarantined", float(held or 0))

    async def project_pending(
        self, limit: int = 100, concurrency: Optional[int] = None
    ) -> List[Dict[str, object]]:
        """Catch up every graph whose projection lags (`projected < target`), STALEST first,
        with bounded concurrency so the reconciling loop keeps up across 100s of graphs
        (the serial version made a full pass cost the SUM of per-graph times). The select is
        keyed by ``graph_id`` (PK) so each id appears once per pass — no same-graph race; a
        per-graph failure is logged and does not abort the batch."""
        await self._report_lag()
        async with self._session() as s:
            ids = (await s.execute(
                select(ProjectionStateORM.graph_id).join(
                    GraphORM, GraphORM.id == ProjectionStateORM.graph_id,
                ).where(
                    # LAG IS MEASURED AGAINST THE COMMITTED HEAD as well as `target`, and a
                    # pass projects up to `max(target, head)`. A graph left below `main_head`
                    # is otherwise never caught up, while the read path's freshness check
                    # (`projected >= main_head`) stays false forever and routes every main
                    # read to Postgres — a wedge that once cost a data source its entire
                    # aggregated lineage layer for 14 hours and needed a hand-written UPDATE.
                    or_(
                        ProjectionStateORM.projected_commit_seq < ProjectionStateORM.target_commit_seq,
                        ProjectionStateORM.projected_commit_seq < GraphORM.main_head_commit_seq,
                        # Caught up, but holding quarantined entities due another try.
                        ProjectionStateORM.quarantine_next_at <= _now(),
                    ),
                    # A pass that failed is retried after its backoff (`_retry_at`), so a
                    # genuinely unfixable graph retries visibly but without churning the loop.
                    # A nudge (a publish) and project_now retry at once regardless.
                    or_(ProjectionStateORM.next_retry_at.is_(None),
                        ProjectionStateORM.next_retry_at <= _now()),
                    # Unpinned graphs (no real FalkorDB target — falkor_graph_name NULL or the
                    # synthetic gv_<id> fallback) are never projected: nothing reads those keys.
                    # Filtered here in SQL so hundreds of test-created graphs can't crowd out
                    # (limit) or churn the poll loop; project_graph re-checks for direct nudges.
                    ProjectionStateORM.falkor_graph_name.isnot(None),
                    ProjectionStateORM.falkor_graph_name
                    != literal("gv_").concat(ProjectionStateORM.graph_id),
                    # A tombstoned graph keeps its pin for the undo window and must not reseed it.
                    GraphORM.deleted_at.is_(None),
                    # A fork has no FalkorDB copy (project_graph skips one whatever its row says).
                    GraphORM.fork_parent_graph_id.is_(None),
                    # An evicted graph waits for its load, whatever the switch says
                    # (project_graph's gate).
                    ProjectionStateORM.status.notin_(("evicted", "waiting_capacity")),
                ).order_by(
                    (func.greatest(ProjectionStateORM.target_commit_seq,
                                   GraphORM.main_head_commit_seq)
                     - ProjectionStateORM.projected_commit_seq).desc()
                ).limit(limit)
            )).scalars().all()
        if not ids:
            return []
        sem = asyncio.Semaphore(concurrency or config.PROJECTION_CONCURRENCY)

        async def _one(gid: str) -> Dict[str, object]:
            async with sem:
                try:
                    return await self.project_graph(gid)
                except Exception as exc:                       # pragma: no cover - infra
                    logger.exception("project_pending: %s failed", gid)
                    return {"graph_id": gid, "error": str(exc)[:200]}

        return list(await asyncio.gather(*[_one(g) for g in ids]))

    async def _resolve_level_map(self, graph_id: str) -> Dict[str, int]:
        """Best-effort ontology entity-type→level map for stamping ``n.level`` on projected
        nodes (parity with ``save_custom_graph``). Reuses the aggregation edge-type resolver,
        whose 3rd tuple element is the level map. Returns ``{}`` when unavailable — no resolver
        (unit tests), dedicated mode / no lineage vocabulary, or a resolution error — in which
        case the node MERGE's ``coalesce(item.level, n.level)`` simply leaves level unset,
        exactly as ``save_custom_graph`` does before the ontology map is injected. Never raises."""
        if self._edge_types_resolver is None:
            return {}
        try:
            sets = await self._edge_types_resolver(self._svc, graph_id)
        except Exception:                                # pragma: no cover - app-layer resolution
            logger.debug("level-map resolution failed for %s; projecting without n.level",
                         graph_id, exc_info=True)
            return {}
        if not sets or len(sets) <= 2 or not sets[2]:
            return {}
        return dict(sets[2])

    async def _compute_changes(
        self, s, graph: GraphORM, main_id: str, from_seq: int, to_seq: int
    ) -> Optional[Tuple[List[NodeUpsert], List[EdgeUpsert], List[Tuple[str, str]], List[object]]]:
        """The window ``(from_seq, to_seq]``'s ``(node upserts, edge upserts, node deletes, edge
        deletes)``; None for a window of more than ``PROJECTION_PAGED_ABOVE`` version rows, which
        is too large to hold and is written a page at a time instead (:meth:`_apply_paged`)."""
        node_upserts: List[NodeUpsert] = []
        edge_upserts: List[EdgeUpsert] = []
        node_deletes: List[Tuple[str, str]] = []   # (urn, label)
        edge_deletes: List[object] = []            # resolved dicts, else entity_id str
        urn_of: Dict[str, str] = {}
        label_of: Dict[str, str] = {}

        if from_seq <= 0:
            # Seed: the full live state.
            state = await self._svc._state_as_of(s, graph.id, main_id, to_seq)
            for eid, p in state.items():
                if p is None or _is_edge_payload(p):
                    continue
                urn = _node_urn(eid, p)
                urn_of[eid] = urn
                label_of[eid] = str(p.get("entityType") or "Entity")
                node_upserts.append((eid, urn, p))
            for eid, p in state.items():
                if p is None or not _is_edge_payload(p) or _is_derived_edge_payload(p):
                    continue
                src, tgt = _edge_endpoints(p)
                su, slb = await self._endpoint(s, graph, main_id, src, urn_of, label_of)
                tu, tlb = await self._endpoint(s, graph, main_id, tgt, urn_of, label_of)
                edge_upserts.append((eid, su, tu, p, slb, tlb))
            return node_upserts, edge_upserts, node_deletes, edge_deletes

        if await self._window_rows(s, graph, main_id, from_seq, to_seq) > config.PROJECTION_PAGED_ABOVE:
            return None
        # Incremental: net of each entity's rows in (from_seq, to_seq]. Key the fold by
        # (kind, entity_id) — NOT entity_id alone — so a node and an edge that ever share
        # an entity_id can never overwrite each other (which would silently drop a node
        # delete/upsert by mis-handling it as an edge). The fold reads the rows' identity columns,
        # never their payloads: every superseded row of the window was read whole before, and every
        # winner's payload held at once; ``_apply`` now reads the winners' a batch at a time.
        last: Dict[Tuple[str, str], Tuple[str, str, Optional[dict]]] = {}
        for model, kind in ((NodeVersionORM, "node"), (EdgeVersionORM, "edge")):
            named = ((model.urn, model.entity_type, null(), null()) if kind == "node" else
                     (null(), model.edge_type, model.source_entity_id, model.target_entity_id))
            rows = (await s.execute(
                select(model.entity_id, model.id, model.op, *named).where(
                    model.graph_id == graph.id, model.branch_id == main_id,
                    model.commit_seq > from_seq, model.commit_seq <= to_seq,
                ).order_by(model.commit_seq, model.created_at)
            )).all()
            type_key = "entityType" if kind == "node" else "edgeType"
            for eid, vid, op, urn, typ, src, tgt in rows:
                last[(kind, eid)] = (kind, op, None if op == "delete" else _Pending(
                    (kind, graph.id, vid),
                    (("urn", urn), (type_key, typ), ("sourceEntityId", src), ("targetEntityId", tgt))))
        node_upserts, edge_upserts, node_deletes, edge_deletes = await self._changes_of(
            s, graph, main_id, from_seq, last, urn_of, label_of, to_seq=to_seq)
        await self._merkle_augment_upserts(
            s, graph, main_id, from_seq, to_seq, last, urn_of, label_of,
            node_upserts, edge_upserts)
        return node_upserts, edge_upserts, node_deletes, edge_deletes

    async def _changes_of(self, s, graph, main_id, from_seq, last, urn_of, label_of, *,
                          to_seq: int):
        """The window's four lists (:meth:`_compute_changes`) from ``last`` — each entity's final
        row in it, ``(kind, op, _Pending | None)`` by ``(kind, entity_id)`` — with the urns and
        labels of the deleted entities and of the edges' ends resolved (``urn_of``/``label_of``
        filled in on the way). An edge the window re-points or retypes is written where it now
        points, and deleted where it was, as a deleted edge is: the write MERGEs by its type and
        ends, and would leave its old relationship there beside it.

        A deleted edge is deleted, anchored on its ends, wherever it may be in FalkorDB: where it
        was before the window, and wherever the window put it before deleting it (an earlier,
        failed attempt at the window may have written it there). An id with no position at all was
        never written, so nothing is deleted for it: never a scan of every relationship."""
        node_upserts: List[NodeUpsert] = []
        edge_upserts: List[EdgeUpsert] = []
        node_deletes: List[Tuple[str, str]] = []
        edge_deletes: List[object] = []
        deleted_nodes: List[str] = []
        for (kind, eid), (_, op, p) in last.items():
            if kind != "node":
                continue
            if op == "delete":
                deleted_nodes.append(eid)
            else:
                urn = _node_urn(eid, p)
                urn_of[eid] = urn
                label_of[eid] = str((p or {}).get("entityType") or "Entity")
                node_upserts.append((eid, urn, p))
        deleted_edge_ids: List[str] = []
        live_edges: List[Tuple[str, dict]] = []
        for (kind, eid), (_, op, p) in last.items():
            if kind != "edge":
                continue
            if op == "delete":
                deleted_edge_ids.append(eid)
            elif not _is_derived_edge_payload(p):
                live_edges.append((eid, p))
        # Deleted edges: resolve the BEFORE-window value so the delete can
        # run typed + endpoint-anchored (delete rows carry no payload).
        # Unresolvable ids keep the legacy scan-delete fallback.
        before = (await self._svc._values_at(s, graph.id, main_id, deleted_edge_ids, from_seq)
                  if deleted_edge_ids else {})
        held_in_window = (await self._edge_positions(s, graph.id, main_id, deleted_edge_ids,
                                                     from_seq, to_seq)
                          if deleted_edge_ids else {})
        # Where each written edge pointed before the window (its type and ends, no payload).
        was = (await self._svc._skeletons_at(s, graph.id, main_id, [e for e, _p in live_edges],
                                             from_seq) if live_edges else {})
        moved = [(eid, was[eid]) for eid, p in live_edges
                 if was.get(eid) and _is_edge_payload(was[eid])
                 and not _is_derived_edge_payload(was[eid])
                 and (_edge_endpoints(was[eid]) != _edge_endpoints(p)
                      or spelled_type(was[eid].get("edgeType")) != spelled_type(p.get("edgeType")))]
        # Every urn/label the window's deletes and edge ends need that it does not itself say, in
        # a few batched reads rather than one per endpoint (``_endpoint`` remains the fallback).
        await self._prefetch_endpoints(
            s, graph, main_id,
            [*deleted_nodes, *(e for _eid, p in live_edges for e in _edge_endpoints(p)),
             *(e for p in before.values() if p and _is_edge_payload(p) for e in _edge_endpoints(p)),
             *(e for spots in held_in_window.values() for _t, src, tgt in spots for e in (src, tgt)),
             *(e for _eid, p in moved for e in _edge_endpoints(p))],
            urn_of, label_of)
        for eid in deleted_nodes:
            node_deletes.append(await self._endpoint(s, graph, main_id, eid, urn_of, label_of))
        for eid, p in live_edges:
            src, tgt = _edge_endpoints(p)
            su, slb = await self._endpoint(s, graph, main_id, src, urn_of, label_of)
            tu, tlb = await self._endpoint(s, graph, main_id, tgt, urn_of, label_of)
            edge_upserts.append((eid, su, tu, p, slb, tlb))
        if deleted_edge_ids:
            unplaced = 0
            for eid in deleted_edge_ids:
                p = before.get(eid)
                if p and _is_derived_edge_payload(p):
                    continue                             # the platform owns rollups, not the log
                spots = set(held_in_window.get(eid, ()))
                if p and _is_edge_payload(p):
                    spots.add((str(p.get("edgeType") or "REL"), *_edge_endpoints(p)))
                if not spots:
                    unplaced += 1
                for rel, src, tgt in sorted(spots):
                    su, slb = await self._endpoint(s, graph, main_id, src, urn_of, label_of)
                    tu, tlb = await self._endpoint(s, graph, main_id, tgt, urn_of, label_of)
                    edge_deletes.append({"eid": eid, "src": su, "tgt": tu, "rel": rel,
                                         "slb": slb, "tlb": tlb})
            if unplaced:
                logger.info("projection of %s: %d deleted edge(s) were never written anywhere; "
                            "nothing to delete for them", graph.id, unplaced)
        for eid, p in moved:
            src, tgt = _edge_endpoints(p)
            su, slb = await self._endpoint(s, graph, main_id, src, urn_of, label_of)
            tu, tlb = await self._endpoint(s, graph, main_id, tgt, urn_of, label_of)
            edge_deletes.append({"eid": eid, "src": su, "tgt": tu,
                                 "rel": str(p.get("edgeType") or "REL"), "slb": slb, "tlb": tlb})
        return node_upserts, edge_upserts, node_deletes, edge_deletes

    async def _edge_positions(self, s, graph_id, main_id, eids, from_seq,
                              to_seq) -> Dict[str, Set[Tuple[str, str, str]]]:
        """For each of ``eids``, every ``(type, source, target)`` a version row inside the window
        ``(from_seq, to_seq]`` gave it, but not a delete: where a pass over the window may have
        written it. Version columns only, never a payload (``ix_ev_entity_hist``)."""
        out: Dict[str, Set[Tuple[str, str, str]]] = {}
        for chunk in _batches(sorted(set(eids)), _ENDPOINT_CHUNK):
            rows = (await s.execute(
                select(EdgeVersionORM.entity_id, EdgeVersionORM.edge_type,
                       EdgeVersionORM.source_entity_id, EdgeVersionORM.target_entity_id)
                .where(EdgeVersionORM.graph_id == graph_id, EdgeVersionORM.branch_id == main_id,
                       EdgeVersionORM.entity_id.in_(list(chunk)),
                       EdgeVersionORM.commit_seq > from_seq, EdgeVersionORM.commit_seq <= to_seq,
                       EdgeVersionORM.op != "delete")
                .distinct())).all()
            for eid, etype, src, tgt in rows:
                if src and tgt and str(etype or "") != ROLLUP_EDGE_TYPE:
                    out.setdefault(eid, set()).add((str(etype or "REL"), src, tgt))
        return out

    async def _window_rows(self, s, graph, main_id, from_seq, to_seq) -> int:
        """How many version rows the window ``(from_seq, to_seq]`` holds, nodes and edges."""
        n = 0
        for model in (NodeVersionORM, EdgeVersionORM):
            n += (await s.execute(select(func.count()).select_from(model).where(
                model.graph_id == graph.id, model.branch_id == main_id,
                model.commit_seq > from_seq, model.commit_seq <= to_seq))).scalar_one()
        return n

    async def _window_pages(self, s, graph, main_id, from_seq, to_seq, kind: str, after: str = ""):
        """:meth:`_compute_changes` of the window's ``kind`` entities (``node`` or ``edge``), a page
        of ``PROJECTION_PAGE`` version rows at a time (a keyset on their ids, from after ``after``):
        each page's entities at their final row in the window, with the page's last version id.
        An entity with rows on two pages comes up on both, at the same final value — written
        twice, never stale."""
        model = NodeVersionORM if kind == "node" else EdgeVersionORM
        named = ((model.urn, model.entity_type, null(), null()) if kind == "node" else
                 (null(), model.edge_type, model.source_entity_id, model.target_entity_id))
        type_key = "entityType" if kind == "node" else "edgeType"
        window = (model.graph_id == graph.id, model.branch_id == main_id,
                  model.commit_seq > from_seq, model.commit_seq <= to_seq)
        final = (select(model.entity_id, model.id, model.op, *named)
                 .where(*window, model.entity_id == any_(bindparam("ids", type_=ARRAY(Text))))
                 .order_by(model.entity_id, model.commit_seq.desc(), model.created_at.desc())
                 .distinct(model.entity_id))
        while True:
            page = (await s.execute(select(model.id, model.entity_id).where(*window, model.id > after)
                                    .order_by(model.id).limit(config.PROJECTION_PAGE))).all()
            if not page:
                return
            last: Dict[Tuple[str, str], Tuple[str, str, Optional[dict]]] = {}
            for eid, vid, op, urn, typ, src, tgt in (await s.execute(
                    final, {"ids": sorted({e for _v, e in page})})).all():
                last[(kind, eid)] = (kind, op, None if op == "delete" else _Pending(
                    (kind, graph.id, vid),
                    (("urn", urn), (type_key, typ), ("sourceEntityId", src), ("targetEntityId", tgt))))
            yield (await self._changes_of(s, graph, main_id, from_seq, last, {}, {}, to_seq=to_seq),
                   page[-1][0])
            if len(page) < config.PROJECTION_PAGE:
                return
            after = page[-1][0]

    async def _merkle_augment_upserts(
        self, s, graph, main_id, from_seq, to_seq, last, urn_of, label_of,
        node_upserts, edge_upserts,
    ) -> None:
        """Union the raw commit-row delta with the AUTHORITATIVE Merkle diff.

        The row scan above can rarely MISS an entity a merge changed (content drift the count-based
        verify/heal can't see — same node count, changed properties). The Merkle diff between the
        projected seq and the target is authoritative: the tree's hash changes on ANY content change,
        and the walk prunes equal subtrees so it costs O(diff), not O(graph). We add any entity it
        flags that the row scan didn't already cover — UNION ONLY, so this never drops what the scan
        found and is strictly safer than the prior behaviour. Best-effort: a diff failure never fails
        the pass (the scan result still applies)."""
        covered = {eid for (_k, eid) in last}
        try:
            mdiff = await self._svc._merkle.diff(s, graph.id, main_id, from_seq, to_seq)
        except Exception:                                # pragma: no cover - best-effort safety net
            logger.debug("merkle-diff augmentation skipped for %s", graph.id, exc_info=True)
            return
        # Upserts the scan missed (present at target: hash_to is not None). Deletes it missed are
        # handled by the tombstone sweep in _verify_and_heal.
        extra = {eid: hn for eid, (_hf, hn) in mdiff.items() if hn is not None and eid not in covered}
        if not extra:
            return
        recovered = 0
        for batch in _batches(list(extra.items()), 10000):
            eids = [e for e, _ in batch]
            hashes = list({h for _, h in batch})
            for model in (NodeVersionORM, EdgeVersionORM):
                rows = (await s.execute(
                    select(model.entity_id, model.content_hash, model.payload).where(
                        model.graph_id == graph.id, model.branch_id == main_id,
                        model.entity_id.in_(eids), model.content_hash.in_(hashes))
                )).all()
                by = {(e, h): p for e, h, p in rows}
                for eid, hn in batch:
                    p = by.get((eid, hn))
                    if p is None or _is_derived_edge_payload(p):
                        continue
                    if _is_edge_payload(p):
                        src, tgt = _edge_endpoints(p)
                        su, slb = await self._endpoint(s, graph, main_id, src, urn_of, label_of)
                        tu, tlb = await self._endpoint(s, graph, main_id, tgt, urn_of, label_of)
                        edge_upserts.append((eid, su, tu, p, slb, tlb))
                    else:
                        urn = _node_urn(eid, p)
                        urn_of[eid] = urn
                        label_of[eid] = str(p.get("entityType") or "Entity")
                        node_upserts.append((eid, urn, p))
                    recovered += 1
        if recovered:
            logger.warning("merkle-diff recovered %d entity upsert(s) the incremental scan MISSED "
                           "for %s (from_seq=%d to_seq=%d) — content drift repaired", recovered,
                           graph.id, from_seq, to_seq)

    # Largest restructure whose rollups are maintained inline (a moved container's subtree, a
    # reconcile's contributions); above it the on_rollups_stale hook queues the batch job. A
    # window's own lineage edges have no cap. See ``config.PROJECTION_ROLLUP_INLINE_CAP``.
    _MOVE_EDGE_CAP = config.PROJECTION_ROLLUP_INLINE_CAP

    async def _containment_types(self, graph_id: str) -> Optional[Set[str]]:
        """The ontology's containment edge types, upper-cased; None when unknown."""
        if self._edge_types_resolver is None:
            return None
        try:
            sets = await self._edge_types_resolver(self._svc, graph_id)
        except Exception:                                # pragma: no cover - app-layer resolution
            return None
        return {t.upper() for t in (sets[0] or [])} if sets else None

    async def _window_is_structural(self, s, graph, main_id, from_seq, changes) -> bool:
        return (await self._window_meta(s, graph, main_id, from_seq, changes))[0]

    async def _window_meta(self, s, graph, main_id, from_seq, changes):
        """``(structural, retypes)`` for a publish window, from one read of the touched
        entities' values before it.

        ``structural``: the window changes what a reader has CACHED about existing entities —
        retypes one (its urn→label entry would anchor lookups on the OLD label and find
        nothing), removes a containment link, or gives an EXISTING entity a containment parent
        (a move). Creating an entity inside a container is not structural — nothing has
        cached the new entity's ancestry yet. Unknown containment types count every edge
        change.

        ``retypes``: ``(urn, old label, new label)`` per entity whose type changed — the node
        is relabelled in place before the window's merge, which would otherwise create a
        second node under the new label and leave the old one behind.

        ``rekeys``: ``(old urn, new urn, old label)`` per entity whose urn changed — the node is
        moved to its new urn in place first, for the same reason (:meth:`_rekey_in_place`)."""
        node_upserts, edge_upserts, _node_deletes, edge_deletes = changes
        if not (node_upserts or edge_upserts or edge_deletes):
            return False, [], []
        cont = await self._containment_types(graph.id)

        def containment(rel) -> bool:
            return cont is None or str(rel or "").upper() in cont

        structural = any(not isinstance(e, dict) or containment(e.get("rel")) for e in edge_deletes)
        new_children = [_edge_endpoints(p or {})[1] for _e, _su, _tu, p, _sl, _tl in edge_upserts
                        if containment((p or {}).get("edgeType"))]
        ids = [eid for eid, _u, _p in node_upserts] + [c for c in new_children if c]
        if not ids:
            return structural, [], []
        before = await self._svc._values_at(s, graph.id, main_id, list(dict.fromkeys(ids)), from_seq)
        if any(before.get(c) is not None for c in new_children):
            structural = True                            # an existing entity got a (new) parent
        retypes, rekeys = [], []
        for eid, urn, p in node_upserts:
            old = before.get(eid)
            new_type = (p or {}).get("entityType")
            if old and old.get("entityType") != new_type:
                structural = True
                retypes.append((urn, spelled_label(old.get("entityType")), spelled_label(new_type)))
            old_urn = (str(old.get("urn")) if old.get("urn") else f"gv:{eid}") if old else None
            if old_urn is not None and old_urn != urn:
                structural = True                        # readers cache urn -> label
                rekeys.append((old_urn, urn, spelled_label(old.get("entityType"))))
        return structural, retypes, rekeys

    async def _learn_spelling(self, client, graph_id: str) -> None:
        """A customer's graph whose enable recorded no spelling (it predates the record) says it
        itself (:func:`graph_spelling`). Recorded once nothing in it is ambiguous, so a spelling
        another writer adds later doesn't change what the projector writes."""
        types, ambiguous = await graph_spelling(client)
        SPELLING.set(spelling(types, ambiguous))
        if not (ambiguous["nodes"] or ambiguous["edges"]):
            async with self._session() as s:
                await s.execute(update(ProjectionStateORM)
                                .where(ProjectionStateORM.graph_id == graph_id,
                                       # SQL NULL, or a JSON null an enable wrote for "none"
                                       func.coalesce(func.jsonb_typeof(
                                           ProjectionStateORM.physical_types), "null") == "null")
                                .values(physical_types=types)
                                .execution_options(synchronize_session=False))

    async def _properties_before(self, s, graph, main_id, seq: int,
                                 node_upserts) -> Dict[str, Set[str]]:
        """Each upserted node's property names as of ``seq``: on a customer's key, the only
        properties a pass may strip from it."""
        ids = [eid for eid, _urn, _p in node_upserts]
        vals = await self._svc._values_at(s, graph.id, main_id, ids, seq) if ids else {}
        return {eid: set(((p or {}).get("properties") or {})) for eid, p in vals.items()}

    async def _compute_rollup_deltas(self, s, graph, main_id, from_seq, to_seq):
        """Net ``:AGGREGATED`` rollup adjustments implied by this window's committed changes:
        +1 over the ancestor-pair product for each created lineage edge (post-window chains),
        -1 for each deleted one (pre-window chains), and a bounded recount for lineage edges
        under containers that were MOVED in the window. O(window delta × chain depth²), in any
        size of window: its edges are read a page of ids at a time, and netted in bounded memory.

        Returns ``{(src_urn, tgt_urn): {"dw": int, "types": set}}``; past
        ``GRAPHVER_ROLLUP_NET_MAX_CELLS`` cells, the :class:`_CellNet` holding them in
        ``rollup_deltas`` instead; ``None`` when nothing rollup-affecting changed; or the sentinel
        ``"stale"`` when a move exceeded the cap — and, for a data source whose rollups live in a
        dedicated key (the resolver's ``"dedicated"``), whenever lineage or containment changed:
        none is written here."""
        try:
            sets = await self._edge_types_resolver(self._svc, graph.id)
        except Exception:                                # pragma: no cover - app-layer resolution
            logger.warning("rollup maintenance skipped for %s: edge-type resolution failed",
                           graph.id, exc_info=True)
            return None
        if not sets:
            return None
        cont_types = {t.upper() for t in (sets[0] or [])}
        lineage_types = {t.upper() for t in (sets[1] or [])}
        if not lineage_types:
            return None
        level_map: Dict[str, int] = dict(sets[2]) if len(sets) > 2 and sets[2] else {}
        # Canonical mode: the aggregation worker materializes only the
        # canonical STRUCTURAL selection (containment ancestors ranked by
        # depth from the root — independent of ontology type levels, so
        # self-nesting types like Node ⊃ Node roll up too). The projector
        # must emit the SAME selection — its old full ancestor
        # cross-product wrote leaf/mixed cells the boundary excludes,
        # which the on-demand reader then double-counts until the next
        # batch run. Type levels survive only as the sourceLevel/
        # targetLevel STAMPS (omitted when a label has no mapped level).
        use_canonical = bool(cont_types)

        def _etype(p) -> str:
            return str((p or {}).get("edgeType") or "").upper()

        def _sig(p: Optional[dict]):
            return None if not p else (*_edge_endpoints(p), _etype(p))

        anc_cache: Dict[Tuple[str, Optional[int]], Tuple[List[str], Dict[str, List[str]]]] = {}

        async def prefetch(ids, as_of: Optional[int]) -> None:
            """Every chain a page needs at one seq, in ONE batched climb — a query per
            containment LEVEL, not per node — so a 10,000-edge page costs what a 10-edge
            one does in round trips. (Per node, a deep hierarchy re-read the same top-level
            containers' edges for every distinct leaf.)"""
            need = {i for i in ids if i and (i, as_of) not in anc_cache}
            if not need:
                return
            _seen, edges = await self._svc._containment_parents_climb(
                s, graph.id, main_id, need, cont_types, as_of)
            parents: Dict[str, List[str]] = {}
            for payload in edges.values():
                a, b = _edge_endpoints(payload)          # a = parent, b = child
                if a and b and a not in parents.setdefault(b, []):
                    parents[b].append(a)
            for i in need:
                local = _local_chain(parents, i)
                anc = {i} | set(local) | {pp for ps in local.values() for pp in ps}
                anc_cache[(i, as_of)] = (list(anc), local)

        async def chain(node_id: str, as_of: Optional[int]) -> Tuple[List[str], Dict[str, List[str]]]:
            """(ancestors-or-self ids, child→ALL-parents multimap) — the
            parent DAG the shared pair rules rank on. Multi-parent nodes
            keep every ancestry (the old single-slot map silently dropped
            all but the last-seen parent). Normally served by ``prefetch``."""
            key = (node_id, as_of)
            if key not in anc_cache:
                seen, edges = await self._svc._containment_ancestors(
                    s, graph.id, main_id, {node_id}, cont_types, as_of)
                child_parent: Dict[str, List[str]] = {}
                for payload in edges.values():
                    a, b = _edge_endpoints(payload)      # a = parent, b = child
                    if a and b and a not in child_parent.setdefault(b, []):
                        child_parent[b].append(a)
                anc_cache[key] = (list(seen), child_parent)
            return anc_cache[key]

        conversion = _CellsOut(self._svc, graph, main_id, from_seq, to_seq, use_canonical, level_map)
        net = _CellNet(self._session, graph.id, to_seq, config.ROLLUP_NET_MAX_CELLS, conversion)

        async def contribute(p: dict, sign: int, as_of: Optional[int]) -> None:
            """Net this raw edge's delta into BOTH pair sets via the shared ``pair_rules`` (the
            same rules the batch pipeline and the write hooks run): ``dw`` = the full
            ancestor-closure cross-product (what a CUBE-regime graph stores), ``dwc`` = the
            canonical depth-bridged subset (what a BOUNDARY-regime graph stores). The stored
            regime is only knowable from the graph itself, so _apply_rollups picks the matching
            delta at apply time. Closures have SET semantics — a diamond's shared grandparent gets
            each edge's delta exactly once — and every ancestry of a multi-parent node is linked."""
            from backend.common.providers.pair_rules import (
                ancestor_closure, boundary_pairs, cube_pairs,
            )
            src, tgt = _edge_endpoints(p)
            if not src or not tgt:
                return
            et = _etype(p)
            (cs, cp_s), (ct, cp_t) = await chain(src, as_of), await chain(tgt, as_of)
            if use_canonical:
                s_cl = ancestor_closure(cp_s, src)
                t_cl = ancestor_closure(cp_t, tgt)
                s_parents = {pp for ps in cp_s.values() for pp in ps}
                t_parents = {pp for ps in cp_t.values() for pp in ps}
                canon = boundary_pairs(
                    {a: d for a, d in s_cl.items() if a in s_parents},
                    {a: d for a, d in t_cl.items() if a in t_parents},
                )
                cube = set(cube_pairs(
                    s_cl, t_cl, include_leaf_mirror=False, s=src, t=tgt,
                ))
                depths = {**t_cl, **s_cl}
                for sx, tx in cube:
                    net.add(sx, tx, sign, sign if (sx, tx) in canon else 0,
                            et if sign > 0 and et else None, depths.get(sx), depths.get(tx))
                return
            for sx in cs:
                for tx in ct:
                    if sx != tx:
                        net.add(sx, tx, sign, None, et if sign > 0 and et else None, None, None)

        # The window's edges a page of distinct ids at a time, each at its value BEFORE the window
        # against AFTER it, from the version rows' identity columns (never a payload). Op labels
        # alone lose real cases the worker batches into one window: create+update (last op
        # 'update' would hide the +1), delete+revert-recreate (spurious +1 for an edge that never
        # stopped being live), and endpoint/type rewrites via update.
        window = (EdgeVersionORM.graph_id == graph.id, EdgeVersionORM.branch_id == main_id,
                  EdgeVersionORM.commit_seq > from_seq, EdgeVersionORM.commit_seq <= to_seq)
        moved: set = set()
        changed = False
        after = ""
        while True:
            ids = list((await s.execute(
                select(EdgeVersionORM.entity_id).where(*window, EdgeVersionORM.entity_id > after)
                .distinct().order_by(EdgeVersionORM.entity_id).limit(config.PROJECTION_PAGE)
            )).scalars().all())
            if not ids:
                break
            before = await self._svc._skeletons_at(s, graph.id, main_id, ids, from_seq)
            now = await self._svc._skeletons_at(s, graph.id, main_id, ids, to_seq)
            creates: Dict[str, dict] = {}
            deletes: Dict[str, dict] = {}
            children: set = set()
            for eid in ids:
                old, new = before.get(eid), now.get(eid)
                if _sig(old) == _sig(new):
                    continue                             # payload-only change — no rollup impact
                if old is not None:
                    et = _etype(old)
                    if et in lineage_types:
                        deletes[eid] = old
                    elif et in cont_types:
                        children.add(_edge_endpoints(old)[1])
                if new is not None:
                    et = _etype(new)
                    if et in lineage_types:
                        creates[eid] = new
                    elif et in cont_types:
                        children.add(_edge_endpoints(new)[1])
            children.discard("")
            if "dedicated" in sets[3:] and (creates or deletes or children):
                # The aggregation job builds these rollups in a key of their own: this key gets
                # none, and a window that changes lineage or containment hands them to the job.
                await net.clear()
                return "stale"
            if children:
                # A child that gained or lost a parent MOVED if it is there on both sides of the
                # window. One the window created or deleted has no lineage on the other side to
                # move: a node's edges are created after it and deleted with it, so its own are
                # among the window's lineage changes, counted below. (So a large import of new,
                # contained nodes is no move.)
                was = await self._svc._skeletons_at(s, graph.id, main_id, children, from_seq)
                still = await self._svc._skeletons_at(s, graph.id, main_id, children, to_seq)
                moved.update(c for c in children
                             if was.get(c) is not None and still.get(c) is not None)
                if len(moved) > self._MOVE_EDGE_CAP:
                    await net.clear()                    # a restructure: the aggregation job's
                    return "stale"
            changed = changed or bool(creates or deletes)
            await prefetch({x for p in creates.values() for x in _edge_endpoints(p)}, to_seq)
            await prefetch({x for p in deletes.values() for x in _edge_endpoints(p)}, from_seq)
            for p in creates.values():
                await contribute(p, +1, to_seq)
            for p in deletes.values():
                await contribute(p, -1, from_seq)
            await net.page_done(s)
            if len(anc_cache) > _CHAIN_CACHE_MAX:
                anc_cache.clear()                        # bounded, whatever the window's size
            if len(ids) < config.PROJECTION_PAGE:
                break
            after = ids[-1]
        if not changed and not moved:
            await net.clear()
            return None

        if moved:
            # Moved subtrees: every lineage edge under them changes rollup pairs. Remove the
            # pre-window contribution, add the post-window one — bounded by _MOVE_EDGE_CAP: a
            # bigger move is a restructure, which the aggregation job takes.
            subtree = await self._svc._containment_descendants(
                s, graph.id, main_id, set(moved), cont_types, to_seq, cap=self._MOVE_EDGE_CAP + 1)
            if len(subtree) > self._MOVE_EDGE_CAP:
                await net.clear()
                return "stale"
            # as-of to_seq (not head): a commit landing after this window must not leak in.
            inc = await self._svc._incident_live_edges(s, graph.id, main_id, subtree, to_seq)
            lineage = {eid: p for eid, p in inc.items() if _etype(p) in lineage_types}
            if len(lineage) > self._MOVE_EDGE_CAP:
                await net.clear()
                return "stale"
            # Those the window itself changed are counted above, each on its own side's chains.
            was = await self._svc._skeletons_at(s, graph.id, main_id, list(lineage), from_seq)
            moved_edges = {eid: p for eid, p in lineage.items() if _sig(was.get(eid)) == _sig(p)}
            ends = {x for p in moved_edges.values() for x in _edge_endpoints(p)}
            await prefetch(ends, from_seq)
            await prefetch(ends, to_seq)
            for eid, p in moved_edges.items():
                await contribute(p, -1, from_seq)
                await contribute(p, +1, to_seq)
            await net.page_done(s)

        if net.staged:
            await net.flush(s)
            return net
        out = await conversion.convert(s, net.netted())
        return out or None

    async def _apply_rollups(self, client, pairs: Dict, from_seq: int, to_seq: int) -> bool:
        """Apply net rollup deltas to the FalkorDB ``:AGGREGATED`` layer, idempotently per
        window: each pair is stamped with ``gvSeq``; a retried window skips already-stamped
        pairs so weights never double-count. A pair stamped INSIDE this window's range
        (from_seq < gvSeq < to_seq — e.g. a crash-retry whose window grew, or a concurrent
        projector on a different window) can't be reconciled incrementally: returns False so
        the caller queues a rebuild instead of guessing. Weight ≤ 0 deletes the rollup.
        Property shape mirrors the aggregation worker (weight / sourceEdgeTypes / aggKey /
        latestUpdate), so a later full rebuild MERGEs onto the same relationships.

        Cells netted in ``rollup_deltas`` (a :class:`_CellNet`) are applied a page at a time,
        and their rows deleted however this returns."""
        try:
            return await self._apply_rollups_once(client, pairs, from_seq, to_seq)
        finally:
            if isinstance(pairs, _CellNet):
                await pairs.clear()

    async def _apply_rollups_once(self, client, pairs, from_seq: int, to_seq: int) -> bool:
        # Graph-level high-water mark for rollup application (a meta node, wiped with the
        # graph on full seeds). Catches what per-pair stamps can't: a prior application
        # whose pairs don't recur in this (grown/concurrent) window.
        res = await _q(client, "MATCH (m:_GVRollupMeta) RETURN m.seq",
                       timeout_ms=_READ_TIMEOUT_MS, read_only=True)
        marker = int(res.result_set[0][0]) if getattr(res, "result_set", None) else 0
        if marker >= to_seq:
            return True                                  # whole window already applied (retry no-op)
        if marker > from_seq:
            return False                                 # partial/foreign overlap — rebuild, don't guess

        if isinstance(pairs, _CellNet):
            async for page in pairs.pages(config.PROJECTION_PAGE):
                if not await self._write_rollup_deltas(client, page, to_seq,
                                                       guard_from_seq=from_seq):
                    return False
        elif not await self._write_rollup_deltas(client, pairs, to_seq, guard_from_seq=from_seq):
            return False
        # Marker written only after EVERY chunk landed — a mid-apply crash leaves it behind
        # the watermark, so the retry re-applies with per-pair gvSeq stamps de-duplicating.
        await _q(client,
                 "MERGE (m:_GVRollupMeta {id: 'meta'}) SET m.seq = $seq",
                 params={"seq": to_seq})
        return True

    async def _write_rollup_deltas(self, client, pairs: Dict, seq: int, *,
                                   guard_from_seq: Optional[int]) -> bool:
        """Add each pair's delta to the stored ``:AGGREGATED`` weight (delete at
        weight <= 0), matching the graph's storage regime, stamping ``gvSeq``.

        ``guard_from_seq`` is a publish window's lower bound: a pair already
        stamped at ``seq`` is skipped (a retried window) and one stamped inside
        the window is an overlap the caller must hand to a rebuild (False). A
        reconcile passes None — its deltas come from a fresh diff of the graph
        itself, not from a window that could have been applied before."""
        # Storage regime of THIS graph's :AGGREGATED set (stamped by the
        # aggregation pipeline's _AggMeta node): a cube graph stores the
        # full ancestor cross-product, a boundary graph only the
        # canonical depth-bridged cells — the deltas computed upstream
        # carry both (dw = cube, dwc = canonical) so the apply can match
        # what is actually stored. Unknown/absent meta defaults to the
        # canonical subset (never writes cells a boundary set excludes).
        regime = "boundary"
        try:
            res = await _q(client,
                           "MATCH (m:_AggMeta {id: 'singleton'}) RETURN m.regime",
                           timeout_ms=_READ_TIMEOUT_MS, read_only=True)
            rows = getattr(res, "result_set", None) or []
            if rows and rows[0] and rows[0][0] in ("cube", "boundary"):
                regime = str(rows[0][0])
        except Exception:
            pass

        # Grouped by the endpoints' labels so every node match below is a
        # per-label URN index seek (an unlabeled ``(a {urn: …})`` scans all
        # nodes per UNWIND row).
        items_by_labels: Dict[Tuple[str, str], list] = {}
        for (s_, t_), v in pairs.items():
            dw = int(v["dw"] if (regime == "cube" or "dwc" not in v) else v["dwc"])
            if dw == 0:
                continue
            key = (spelled_label(v.get("slb")), spelled_label(v.get("tlb")))
            items_by_labels.setdefault(key, []).append(
                {"s": s_, "t": t_, "dw": dw, "et": sorted(v["types"]),
                 "key": f"{s_}|{t_}", "seq": seq,
                 "sl": v.get("sl"), "tl": v.get("tl"),
                 "sd": v.get("sd"), "td": v.get("td"), "dg": v.get("dg")}
            )
        for (slb, tlb), items in items_by_labels.items():
            existing: Dict[Tuple[str, str], Tuple[int, list, int]] = {}

            def held(_part, res) -> None:
                for s_, t_, w, types, gv in (getattr(res, "result_set", None) or []):
                    existing[(s_, t_)] = (int(w or 0), list(types or []), int(gv or 0))

            await self._laddered(
                client, "rollup_read",
                f"UNWIND $batch AS item "
                f"MATCH (a:{slb} {{urn: item.s}})-[r:AGGREGATED]->(b:{tlb} {{urn: item.t}}) "
                f"RETURN item.s, item.t, r.weight, r.sourceEdgeTypes, r.gvSeq",
                items, timeout_ms=_READ_TIMEOUT_MS, read_only=True, on_result=held)
            upserts, deletes = [], []
            for item in items:
                k = (item["s"], item["t"])
                w0, types0, gv = existing.get(k, (0, [], 0))
                if guard_from_seq is not None:
                    if gv >= item["seq"]:
                        continue                     # already applied (same-window retry)
                    if gv > guard_from_seq:
                        return False                 # partial overlap — rebuild, don't guess
                w1 = w0 + item["dw"]
                if w1 <= 0:
                    if k in existing:
                        deletes.append({"s": item["s"], "t": item["t"]})
                    continue
                upserts.append({"s": item["s"], "t": item["t"], "w": w1, "key": item["key"],
                                "et": sorted(set(types0) | set(item["et"])), "seq": item["seq"],
                                "sl": item.get("sl"), "tl": item.get("tl"),
                                "sd": item.get("sd"), "td": item.get("td"),
                                "dg": item.get("dg")})
            # Level stamps coalesce so the legacy (level-less) mode never NULLs stamps a backfill
            # wrote; canonical mode always provides them — and stamped rows keep the read path's
            # storage-regime probe clean (a NULL sourceLevel row makes every reader fall back to
            # stored-only answers for up to 5 minutes). Each cell's weight is the absolute value
            # computed above, so a chunk sent again in halves writes the same.
            await self._laddered(
                client, "rollup_write",
                f"UNWIND $batch AS item "
                f"MATCH (a:{slb} {{urn: item.s}}) MATCH (b:{tlb} {{urn: item.t}}) "
                f"MERGE (a)-[r:AGGREGATED]->(b) "
                f"SET r.weight = item.w, r.sourceEdgeTypes = item.et, r.aggKey = item.key, "
                f"    r.sourceLevel = coalesce(item.sl, r.sourceLevel), "
                f"    r.targetLevel = coalesce(item.tl, r.targetLevel), "
                f"    r.sourceDepth = coalesce(item.sd, r.sourceDepth), "
                f"    r.targetDepth = coalesce(item.td, r.targetDepth), "
                f"    r.levelDigest = coalesce(item.dg, r.levelDigest), "
                f"    r.gvSeq = item.seq, r.latestUpdate = timestamp()",
                upserts)
            await self._laddered(
                client, "rollup_delete",
                f"UNWIND $batch AS item "
                f"MATCH (a:{slb} {{urn: item.s}})-[r:AGGREGATED]->(b:{tlb} {{urn: item.t}}) "
                f"DELETE r",
                deletes)
        return True

    async def _urn_label_for(
        self, s, graph: GraphORM, main_id: str, entity_id: str,
    ) -> Tuple[str, str]:
        """Latest committed (urn, entityType) for an entity on `main`;
        ``(gv:<eid>, <its latest entityType>)`` for a node that
        never had a urn, and ``(gv:<eid>, "Entity")`` when nothing resolves.
        The entityType is exactly what the node merge labeled the cache node
        with, so labeled anchors built from it always hit."""
        row = (await s.execute(
            select(NodeVersionORM.urn, NodeVersionORM.payload).where(
                NodeVersionORM.graph_id == graph.id, NodeVersionORM.branch_id == main_id,
                NodeVersionORM.entity_id == entity_id, NodeVersionORM.urn.is_not(None),
            ).order_by(NodeVersionORM.commit_seq.desc()).limit(1)
        )).first()
        if row and row[0]:
            label = ((row[1] or {}).get("entityType")) or "Entity"
            return str(row[0]), str(label)
        # No urn on any row: the merge keyed it gv:<eid> under its entityType.
        row = (await s.execute(
            select(NodeVersionORM.entity_type).where(
                NodeVersionORM.graph_id == graph.id, NodeVersionORM.branch_id == main_id,
                NodeVersionORM.entity_id == entity_id, NodeVersionORM.op != "delete",
            ).order_by(NodeVersionORM.commit_seq.desc()).limit(1)
        )).first()
        if row:
            return f"gv:{entity_id}", str(row[0] or "Entity")
        logger.warning("projection: no urn for node entity %s on %s; keying as gv:<entity_id>",
                       entity_id, graph.id)
        return f"gv:{entity_id}", "Entity"

    async def _urn_for(self, s, graph: GraphORM, main_id: str, entity_id: str) -> str:
        """Latest non-null urn for an entity on `main`, else gv:<eid>."""
        return (await self._urn_label_for(s, graph, main_id, entity_id))[0]

    async def _endpoint(
        self, s, graph: GraphORM, main_id: str, entity_id: str,
        urn_of: Dict[str, str], label_of: Dict[str, str],
    ) -> Tuple[str, str]:
        """(urn, label) for an edge endpoint via the window caches, falling
        back to the committed rows for endpoints outside the window."""
        urn = urn_of.get(entity_id)
        label = label_of.get(entity_id)
        if urn is None or label is None:
            r_urn, r_label = await self._urn_label_for(s, graph, main_id, entity_id)
            urn = urn if urn is not None else r_urn
            label = label if label is not None else r_label
            urn_of[entity_id], label_of[entity_id] = urn, label
        return urn, label

    async def _prefetch_endpoints(
        self, s, graph: GraphORM, main_id: str, entity_ids: Iterable[str],
        urn_of: Dict[str, str], label_of: Dict[str, str],
    ) -> None:
        """Fill the window caches with the (urn, label) :meth:`_urn_label_for` gives each of
        ``entity_ids`` not in them yet: the latest urn-bearing version row on ``main``, read for
        ``_ENDPOINT_CHUNK`` ids per statement instead of one statement per id — the per-endpoint
        reads were a 100k-edge window's 100k round trips. An id this does not resolve (no urn at
        all) is left to :meth:`_endpoint`'s own fallback."""
        want = [e for e in dict.fromkeys(entity_ids) if e and (e not in urn_of or e not in label_of)]
        for chunk in _batches(want, _ENDPOINT_CHUNK):
            rows = (await s.execute(
                select(NodeVersionORM.entity_id, NodeVersionORM.urn, NodeVersionORM.entity_type)
                .where(NodeVersionORM.graph_id == graph.id, NodeVersionORM.branch_id == main_id,
                       NodeVersionORM.entity_id.in_(chunk), NodeVersionORM.urn.is_not(None))
                .order_by(NodeVersionORM.entity_id, NodeVersionORM.commit_seq.desc(),
                          NodeVersionORM.created_at.desc())
                .distinct(NodeVersionORM.entity_id))).all()
            for eid, urn, etype in rows:
                if urn:                                  # an empty one: _endpoint says what it is
                    urn_of.setdefault(eid, str(urn))
                    label_of.setdefault(eid, str(etype or "Entity"))

    async def _pg_live_counts(self, graph_id, main_id, to_seq):
        """Node count + the count a FAITHFUL FalkorDB projection should hold, from ``entity_heads``,
        for a main fully caught up (``main_head == to_seq``); ``None`` otherwise (a lagging head
        verifies on catch-up).

        Edges are counted as DISTINCT ``(source, type, target)`` TRIPLES, not raw ids: the projector
        MERGEs edges id-lessly, so parallel edges (same triple, different ids) collapse to one
        relationship in FalkorDB. Comparing against the raw edge count would flag that legitimate
        collapse as a shortfall and hold every parallel-edge graph back forever."""
        async with self._session() as s:
            graph = await s.get(GraphORM, graph_id)
            if graph is None or graph.main_head_commit_seq != to_seq:
                return None
            # Collapse-correct count (reconcile.pg_live_counts_projectable): distinct edge triples ==
            # what falkor_counts sees after the id-less MERGE. Single source, shared semantics.
            return await pg_live_counts_projectable(s, graph_id, main_id)

    @staticmethod
    async def _falkor_counts(client, owned: bool = True):
        # Delegates to reconcile.falkor_counts (single source of the count cypher + its rollup
        # exclusion, shared with the reconciler). Kept as a thin method so the verify path and
        # its tests can monkeypatch it per-instance. ``owned`` is the graph's
        # ``owns_falkor_graph``: a pinned customer graph is counted as the reconciler counts it
        # (urn-bearing nodes, DISTINCT edge triples), or a bootstrapped graph's urn-less nodes
        # and parallel relationships read as "extra entities" on every verify.
        return await falkor_counts(client, owned=owned)

    # Internal-id page for the reconcile's scan: ``id(n)`` ranges compile to a
    # NodeByIdSeek, so each page costs its own size, never a full scan.
    _SCAN_PAGE = 20000

    async def _scan_projection(self, client):
        """What FalkorDB holds, as the reconcile compares it: projected nodes by (label, urn)
        — every copy, so a true duplicate is seen — projected edges by (source label, source
        urn, type, target label, target urn), the edge keys holding more than one relationship,
        and the internal ids of nodes carrying no urn (never the projector's). The platform's
        own bookkeeping labels and rollup edges are skipped."""
        res = await _q(client, "MATCH (n) RETURN max(id(n))",
                       timeout_ms=_READ_TIMEOUT_MS, read_only=True)
        rows = getattr(res, "result_set", None) or []
        top = rows[0][0] if rows and rows[0] else None
        copies: Dict[Tuple[str, str], int] = {}
        nodes: Dict[Tuple[str, str], ActualNode] = {}
        key_of: Dict[int, Tuple[str, str]] = {}          # internal id -> (label, urn)
        edges: Dict[EdgeKey, ActualEdge] = {}
        parallel: Set[EdgeKey] = set()
        unkeyed: List[int] = []
        if top is None:
            return nodes, copies, edges, parallel, unkeyed
        for lo in range(0, int(top) + 1, self._SCAN_PAGE):
            page = {"lo": lo, "hi": lo + self._SCAN_PAGE}
            res = await _q(client,
                           "MATCH (n) WHERE id(n) >= $lo AND id(n) < $hi "
                           "RETURN id(n), labels(n), n.urn, n.gvHash",
                           params=page, timeout_ms=_READ_TIMEOUT_MS, read_only=True)
            for nid, labels, urn, fp in (getattr(res, "result_set", None) or []):
                labels = [str(x) for x in (labels or [])]
                if any(is_derived_label(x) for x in labels):
                    continue
                if not urn:
                    unkeyed.append(int(nid))
                    continue
                key = (labels[0] if labels else "", str(urn))
                copies[key] = copies.get(key, 0) + 1
                nodes[key] = ActualNode(fp=fp)
                key_of[int(nid)] = key
        # Edges after every node page, joined on internal ids: each row carries two ints
        # instead of two label lists and two urns, and the platform's rollups — often the
        # bulk of a large graph's relationships — are filtered by the server.
        for lo in range(0, int(top) + 1, self._SCAN_PAGE):
            page = {"lo": lo, "hi": lo + self._SCAN_PAGE}
            res = await _q(client,
                           "MATCH (a)-[r]->(b) WHERE id(a) >= $lo AND id(a) < $hi "
                           f"AND type(r) <> '{ROLLUP_EDGE_TYPE}' "
                           "RETURN id(a), type(r), id(b), r.gvHash",
                           params=page, timeout_ms=_READ_TIMEOUT_MS, read_only=True)
            for ia, rel, ib, fp in (getattr(res, "result_set", None) or []):
                a, b = key_of.get(int(ia)), key_of.get(int(ib))
                if a is None or b is None:
                    continue                             # bookkeeping or urn-less endpoint
                key = (a[0], a[1], str(rel), b[0], b[1])
                if key in edges:
                    parallel.add(key)                    # legacy duplicate of one relationship
                edges[key] = ActualEdge(fp=fp)
        return nodes, copies, edges, parallel, unkeyed

    async def _expected_projection(self, s, graph, main_id, to_seq, level_map):
        """What FalkorDB should hold at ``to_seq``, NARROW: the winners a full seed replays,
        keyed the way the projector writes them — (label, urn) per node, so
        entities sharing a urn under different types are the separate nodes they have always
        been — each with its fingerprint and a reference to fetch its payload IF it must be
        written. No payload is read here. Where several entities share one key, entity id
        order makes the winner stable, as the write order does in ``_apply``.

        Returns ``(nodes, edges, types_by_urn)``."""
        heads = await self._svc._heads_as_of(s, graph.id, main_id, to_seq)
        nodes: Dict[Tuple[str, str], ExpectedNode] = {}
        urn_of: Dict[str, str] = {}
        label_of: Dict[str, str] = {}
        types_by_urn: Dict[str, str] = {}
        lm = level_map or {}
        for eid in sorted(e for e, h in heads.items() if h is not None and h[0] == "node"):
            _kind, gid, vid, chash, urn, etype = heads[eid]
            urn = urn or f"gv:{eid}"
            etype = etype or "Entity"
            urn_of[eid], label_of[eid] = urn, etype
            types_by_urn[urn] = etype
            label = spelled_label(etype)
            nodes[(label, urn)] = ExpectedNode(
                entity_id=eid, ref=("node", gid, vid),
                fp=_node_fingerprint(label, chash, lm.get(etype)))
        edges: Dict[EdgeKey, ExpectedEdge] = {}
        for eid in sorted(e for e, h in heads.items() if h is not None and h[0] == "edge"):
            _kind, gid, vid, chash, etype, src, tgt = heads[eid]
            if (etype or "") == ROLLUP_EDGE_TYPE:
                continue                                 # the platform's, never the log's
            su, slb = await self._endpoint(s, graph, main_id, src, urn_of, label_of)
            tu, tlb = await self._endpoint(s, graph, main_id, tgt, urn_of, label_of)
            rel = spelled_type(etype)
            edges[(spelled_label(slb), su, rel, spelled_label(tlb), tu)] = \
                ExpectedEdge(entity_id=eid, ref=("edge", gid, vid), fp=_edge_fingerprint(rel, chash))
        del heads
        return nodes, edges, types_by_urn

    async def _rollups_trusted(self, client, actual_lineage: int) -> bool:
        """Whether the stored rollups are exactly what FalkorDB's raw edges imply — the
        precondition for correcting them by delta (``reconcile.RollupHealth``, the same
        reading "Check sync" reports)."""
        return (await rollup_health(client)).trusted(actual_lineage)

    async def _reconcile_in_place(self, client, graph_id, main_id, to_seq,
                                  level_map, track_progress: bool = False,
                                  rollups_moved_this_pass: bool = False,
                                  provider_id: Optional[str] = None,
                                  owned: bool = True,
                                  cursor: Optional[_Cursor] = None) -> Dict[str, object]:
        """Make FalkorDB hold exactly committed main at ``to_seq`` by writing only the
        difference, and move the rollups by that same difference — never dropping the graph.
        See ``projection_reconcile``.

        Returns ``{"writes", "rollups", "structural"}``; ``rollups`` is ``"none"`` (nothing
        rollup-relevant changed), ``"applied"``, or ``"stale"`` — the batch job must derive
        them: the change is too large to do inline, the stored rollups are not a trustworthy
        base, this pass already moved them from Postgres's window (``rollups_moved_this_pass``
        — a heal after a publish window; its deltas assumed raw writes that did not land, so a
        second delta would double-count), or rollup cells went with a node that had to be deleted
        outright. For a data source
        whose rollups live in a dedicated key none is read or written here: ``"stale"`` when
        lineage or containment changed, else ``"none"``.

        ``owned`` is the graph's ``owns_falkor_graph``. In a key the platform did not mint, what
        the log does not hold is never deleted — urn-less nodes, entities and relationships its
        other writers put there, extra copies of one — and no property history never held is
        stripped. Only what history tombstoned goes (:meth:`_sweep_tombstoned`). The rollups are
        then the batch job's whenever something was kept, since moving them by the difference
        would take out what stays.

        A graph of more than ``PROJECTION_RECONCILE_STREAMED_ABOVE`` live entities is reconciled a
        page at a time instead (:meth:`_reconcile_streamed`)."""
        async with self._session() as s:
            large = await self._live_count(s, graph_id, main_id) \
                > config.PROJECTION_RECONCILE_STREAMED_ABOVE
        if large:
            return await self._reconcile_streamed(
                client, graph_id, main_id, to_seq, level_map, track_progress=track_progress,
                provider_id=provider_id, owned=owned, cursor=cursor)
        async with self._session() as s:
            graph = await s.get(GraphORM, graph_id)
            nodes, edges, types_by_urn = await self._expected_projection(
                s, graph, main_id, to_seq, level_map)
        actual_nodes, copies, actual_edges, parallel, unkeyed = await self._scan_projection(client)
        if not owned:
            if unkeyed or parallel:
                logger.info("reconcile for %s keeps %d urn-less node(s) and %d parallel edge "
                            "group(s): the key is not the platform's", graph_id, len(unkeyed),
                            len(parallel))
            unkeyed, parallel = [], set()

        # A (label, urn) held by more than one node, or a relationship key held by more than
        # one relationship, is legacy duplication: every copy is removed and the one that
        # should exist written once. The diff sees them as absent (so they ARE written back);
        # the rollup plan sees them as present, which they are.
        duplicated = {k for k, n in copies.items() if n > 1}
        comparable_nodes = {k: v for k, v in actual_nodes.items() if k not in duplicated}
        comparable_edges = {
            k: v for k, v in actual_edges.items()
            if k not in parallel and (k[0], k[1]) not in duplicated and (k[3], k[4]) not in duplicated}
        # Pure CPU over every entity of the graph: off the event loop, so a reconcile of a
        # multi-million-entity graph never stalls the requests sharing this process.
        diff = await asyncio.to_thread(
            diff_projection, nodes, edges, comparable_nodes, comparable_edges)
        # What the log doesn't hold, in a key the platform did not mint, is someone else's.
        kept = not owned and bool(diff.node_deletes or diff.edge_deletes or duplicated)
        if not owned:
            diff.node_deletes, diff.edge_deletes, duplicated = [], [], set()

        rollups, plan, sets = "none", None, None
        cont_types: Set[str] = set()
        raw_edges_change = bool(diff.edge_upserts or diff.edge_deletes or parallel
                                or diff.node_deletes or duplicated or unkeyed)
        # Rollup cells on a node deleted outright (a true duplicate, a urn-less stray) go with
        # its DETACH; no delta can say what they held.
        cells_lost = bool(duplicated or unkeyed)
        if self._edge_types_resolver is not None:
            try:
                sets = await self._edge_types_resolver(self._svc, graph_id)
            except Exception:                            # pragma: no cover - app-layer resolution
                logger.warning("reconcile: edge-type resolution failed for %s — rollups "
                               "handed to the batch job", graph_id, exc_info=True)
                rollups = "stale"
        if sets:
            cont_types = {t.upper() for t in (sets[0] or [])}
            lineage_types = {t.upper() for t in (sets[1] or [])}
            if lineage_types and "dedicated" in sets[3:]:
                # The aggregation job builds these rollups in a key of their own: this key's are
                # neither read nor written, and a change to lineage or containment is the job's.
                relevant = lineage_types | cont_types
                changed = urn_triples(edges.keys()) ^ urn_triples(actual_edges.keys())
                rollups = "stale" if any(k[1].upper() in relevant for k in changed) else "none"
            elif lineage_types:
                expected_triples = urn_triples(edges.keys())
                actual_triples = urn_triples(actual_edges.keys())
                plan = await asyncio.to_thread(
                    plan_rollup_deltas, expected_triples, actual_triples,
                    lineage_types=lineage_types, cont_types=cont_types,
                    canonical=bool(cont_types), cap=self._MOVE_EDGE_CAP,
                    level_of=lambda u: level_map.get(types_by_urn.get(u) or "")
                    if level_map else None,
                )
                actual_lineage = sum(1 for k in actual_triples if k[1].upper() in lineage_types)
                if (plan.stale or cells_lost or kept or (rollups_moved_this_pass and plan.pairs)
                        or not await self._rollups_trusted(client, actual_lineage)):
                    rollups, plan = "stale", None
                elif plan.pairs:
                    rollups = "applied"
        elif rollups == "none" and raw_edges_change:
            # Edges changed but this projector cannot say which are lineage (no resolver, or
            # it resolved nothing): the batch job re-derives the rollups.
            rollups = "stale"

        if plan is not None and plan.pairs:
            # Set BEFORE the raw writes: once they land, a fresh diff can no longer see what
            # these deltas were for, so a crash in between must be visible to every later
            # pass (rollup_health → reconcile_interrupted).
            await _q(client, "MERGE (m:_GVRollupMeta {id: 'meta'}) SET m.reconciling = $ts",
                     params={"ts": int(time.time() * 1000)})

        total = diff.writes + sum(copies[k] for k in duplicated) + len(unkeyed) + len(parallel)
        progress = self._progress_writer(graph_id, total) if track_progress and total else None
        stored_label = {u: l for (l, u) in comparable_nodes}

        # Duplicates first, so the writes below land on the single node / relationship each
        # key should have.
        for label, urns in _group([(u, l) for (l, u) in duplicated]).items():
            await self._laddered(client, "node_delete", _delete_nodes_cypher(_sanitize_label(label)),
                                 urns, param="urns")
        await self._laddered(client, "node_delete_id",
                             "UNWIND $ids AS i MATCH (n) WHERE id(n) = i DETACH DELETE n",
                             unkeyed, param="ids")
        await self._delete_edges_by_key(client, list(parallel), progress)

        await self._relabel_in_place(client, diff.relabels, progress)

        # Phase two: payloads for exactly what is written — nothing else is ever read.
        node_keys = list(dict.fromkeys([*diff.node_upserts, *(k for k in nodes if k in duplicated)]))
        edge_keys = list(dict.fromkeys([*diff.edge_upserts, *(
            k for k in edges if k in parallel
            or (k[0], k[1]) in duplicated or (k[3], k[4]) in duplicated)]))
        async with self._session() as s:
            payload_of = await self._svc._payloads_by_version(
                s, [nodes[k].ref for k in node_keys] + [edges[k].ref for k in edge_keys])
        node_upserts = [(nodes[k].entity_id, k[1], payload_of[nodes[k].ref[2]]) for k in node_keys]
        edge_upserts = [(edges[k].entity_id, k[1], k[4], payload_of[edges[k].ref[2]], k[0], k[3])
                        for k in edge_keys]
        await self._apply(client, node_upserts, edge_upserts,
                          [(u, l) for (l, u) in diff.node_deletes], [],
                          progress=progress, level_map=level_map, provider_id=provider_id,
                          owned=owned, prior=None if owned else {})
        await self._delete_edges_by_key(client, diff.edge_deletes, progress)
        if kept:
            await self._sweep_tombstoned(client, graph_id, main_id, to_seq)

        if plan is not None and plan.pairs:
            label_by_urn = {**stored_label, **{u: l for (l, u) in nodes}}
            digest = None
            if level_map and cont_types:
                from backend.app.services.ontology_levels import compute_level_digest
                digest = compute_level_digest(level_map)
            pairs = {}
            for (su, tu), v in plan.pairs.items():
                pairs[(su, tu)] = {**v, "slb": label_by_urn.get(su) or "Entity",
                                   "tlb": label_by_urn.get(tu) or "Entity",
                                   **({"dg": digest} if digest is not None else {})}
            await self._write_rollup_deltas(client, pairs, to_seq, guard_from_seq=None)
        if plan is not None and not plan.stale and rollups != "stale":
            # The rollups now describe main at to_seq: the next publish window continues
            # from here.
            await _q(client,
                     "MERGE (m:_GVRollupMeta {id: 'meta'}) SET m.seq = $seq REMOVE m.reconciling",
                     params={"seq": to_seq})
        known_cont = cont_types if sets else None
        structural = bool(diff.relabels or duplicated or unkeyed) or any(
            known_cont is None or k[2].upper() in known_cont
            for k in [*diff.edge_upserts, *diff.edge_deletes, *parallel])
        logger.info("reconcile for %s at seq %d: %d write(s) (%d node upsert(s), %d relabel(s), "
                    "%d node delete(s), %d edge upsert(s), %d edge delete(s)); rollups %s",
                    graph_id, to_seq, total, len(node_upserts), len(diff.relabels),
                    len(diff.node_deletes), len(edge_upserts), len(diff.edge_deletes), rollups)
        return {"writes": total, "rollups": rollups, "structural": structural}

    async def _reconcile_streamed(self, client, graph_id, main_id, to_seq, level_map, *,
                                  track_progress: bool, provider_id: Optional[str],
                                  owned: bool, cursor: Optional[_Cursor] = None) -> Dict[str, object]:
        """:meth:`_reconcile_in_place` for a graph too large to hold: the same end — FalkorDB
        holding exactly committed main at ``to_seq``, written by the difference, never dropped —
        reached a page of each side at a time, so the projector holds a page, never the graph.

        First what FalkorDB holds that main does not: a page of its nodes at a time (``_SCAN_PAGE``
        internal ids), their urns looked up in Postgres. A node main no longer has is deleted —
        or relabelled in place when main has its urn under exactly one other label FalkorDB does
        not hold yet (a retype; another stale copy is then deleted) — and so is a node with no urn.
        Then its relationships, a page of source nodes at a time: one main no longer has, or one of
        several on one key, is deleted. Then what main holds: a page of its live heads at a time
        (``PROJECTION_PAGE``), their keys looked up in FalkorDB through the urn indexes, and what is
        missing, differs or is held twice written (the copies of a node held twice deleted first).
        In a key the platform did not mint nothing is deleted, as in place. The rollups are the
        batch job's whenever anything changed.

        ``cursor``: after each page the pass writes where it is (step, and position in it), and
        stops there past its time (:class:`_PassPartial`). A pass that resumes starts after the
        last page that landed; what the passes before it wrote is not known to it, so it hands the
        rollups to the batch job, and a customer's key is swept, as if they had written."""
        async with self._session() as s:
            total = await self._live_count(s, graph_id, main_id)
        progress = self._progress_writer(graph_id, total) if track_progress and total else None
        steps = ("fk_node", "fk_edge", "node", "edge")
        resumed = cursor is not None and cursor.resume is not None
        done = {"writes": 0, "structural": resumed, "kept": resumed and not owned}

        def begin(step: str, end: int) -> int:
            """Where an internal-id step starts: its end when a resumed pass had finished it."""
            at = cursor.start(step, steps) if cursor else ""
            return end if at is None else int(at or 0)

        # ── What FalkorDB holds that main does not: nodes ──
        res = await _q(client, "MATCH (n) RETURN max(id(n))", timeout_ms=_READ_TIMEOUT_MS,
                       read_only=True)
        rows = getattr(res, "result_set", None) or []
        top = rows[0][0] if rows and rows[0] else None
        end = (int(top) + 1) if top is not None else 0
        for lo in range(begin("fk_node", end), end, self._SCAN_PAGE):
            res = await _q(client, "MATCH (n) WHERE id(n) >= $lo AND id(n) < $hi "
                           "RETURN id(n), labels(n), n.urn, n.gvHash",
                           params={"lo": lo, "hi": lo + self._SCAN_PAGE},
                           timeout_ms=_READ_TIMEOUT_MS, read_only=True)
            stored, unkeyed = [], []
            for nid, labels, urn, _fp in (getattr(res, "result_set", None) or []):
                labels = [str(x) for x in (labels or [])]
                if any(is_derived_label(x) for x in labels):
                    continue
                if urn:
                    stored.append((int(nid), labels[0] if labels else "", str(urn)))
                else:
                    unkeyed.append(int(nid))
            async with self._session() as s:
                expected = await self._live_labels(s, graph_id, main_id, to_seq,
                                                   {u for _n, _l, u in stored})
            gone, retype = [], []
            for nid, label, urn in stored:
                labels = expected.get(urn, set())
                if label in labels:
                    continue
                (retype if len(labels) == 1 else gone).append((nid, label, urn))
            relabels = []
            for new, items in _group([((nid, old, urn), next(iter(expected[urn])))
                                      for nid, old, urn in retype]).items():
                held = await self._held_urns(client, new, [urn for _n, _o, urn in items])
                for nid, old, urn in items:
                    if urn in held:
                        gone.append((nid, old, urn))
                    else:
                        relabels.append((urn, old, new))
                        held.add(urn)                    # a second stale copy is then gone
            await self._relabel_in_place(client, relabels)
            done["writes"] += len(relabels)
            done["structural"] |= bool(relabels)
            doomed = [nid for nid, _l, _u in gone] + unkeyed
            if doomed and not owned:
                done["kept"] = True
            elif doomed:
                await self._laddered(client, "node_delete_id",
                                     "UNWIND $ids AS i MATCH (n) WHERE id(n) = i DETACH DELETE n",
                                     doomed, param="ids")
                done["writes"] += len(doomed)
                done["structural"] = True
            if cursor is not None:
                await cursor.page_done("fk_node", lo + self._SCAN_PAGE, done["writes"])

        # ── What FalkorDB holds that main does not: relationships (an owned key's alone) ──
        if owned and top is not None:
            for lo in range(begin("fk_edge", end), end, self._SCAN_PAGE):
                res = await _q(client,
                               "MATCH (a)-[r]->(b) WHERE id(a) >= $lo AND id(a) < $hi "
                               f"AND type(r) <> '{ROLLUP_EDGE_TYPE}' "
                               "RETURN id(r), labels(a), a.urn, type(r), labels(b), b.urn, r.id",
                               params={"lo": lo, "hi": lo + self._SCAN_PAGE},
                               timeout_ms=_READ_TIMEOUT_MS, read_only=True)
                held: Dict[EdgeKey, List[Tuple[int, Optional[str]]]] = {}
                for rid, la, su, rel, lb, tu, eid in (getattr(res, "result_set", None) or []):
                    la, lb = [str(x) for x in (la or [])], [str(x) for x in (lb or [])]
                    if not su or not tu or any(is_derived_label(x) for x in la + lb):
                        continue
                    key = (la[0] if la else "", str(su), str(rel), lb[0] if lb else "", str(tu))
                    held.setdefault(key, []).append((int(rid), eid))
                async with self._session() as s:
                    graph = await s.get(GraphORM, graph_id)
                    want = await self._edge_keys_at(
                        s, graph, main_id, to_seq,
                        [str(e) for rels in held.values() for _r, e in rels if e])
                doomed = [(key, rid) for key, rels in held.items() for rid, eid in rels
                          if len(rels) > 1 or want.get(str(eid)) != key]
                # Each matched from its source by urn, so a delete expands one node's
                # relationships of one type instead of scanning every relationship for an id.
                anchored: Dict[Tuple[str, str, str], list] = {}
                loose: List[int] = []
                for (la, su, rel, lb, tu), rid in doomed:
                    if la and lb:
                        anchored.setdefault((la, rel, lb), []).append(
                            {"src": su, "tgt": tu, "rid": rid})
                    else:
                        loose.append(rid)
                for (la, rel, lb), items in anchored.items():
                    await self._laddered(
                        client, "edge_delete_id",
                        f"UNWIND $batch AS it MATCH (a:{_sanitize_label(la)} {{urn: it.src}})"
                        f"-[r:`{rel}`]->(b:{_sanitize_label(lb)} {{urn: it.tgt}}) "
                        "WHERE id(r) = it.rid DELETE r", items)
                await self._laddered(client, "edge_delete_id",
                                     "UNWIND $ids AS i MATCH ()-[r]->() WHERE id(r) = i DELETE r",
                                     loose, param="ids")
                done["writes"] += len(doomed)
                done["structural"] |= bool(doomed)
                if cursor is not None:
                    await cursor.page_done("fk_edge", lo + self._SCAN_PAGE, done["writes"])

        # ── What main holds: nodes, then relationships ──
        twice: Set[Tuple[str, str]] = set()             # nodes held twice: their edges rewritten
        async with self._session() as s:
            graph = await s.get(GraphORM, graph_id)
            for kind in ("node", "edge"):
                after = cursor.start(kind, steps) if cursor else ""
                if after is None:
                    continue                             # a resumed pass had finished these
                async for page in self._live_head_pages(s, graph, main_id, to_seq, kind,
                                                        after=after):
                    written = await self._write_missing(client, s, graph, main_id, kind, page,
                                                        level_map, provider_id, owned, twice)
                    done["writes"] += written
                    done["structural"] |= kind == "edge" and bool(written)
                    if progress:
                        await progress(len(page))
                    if cursor is not None:
                        await cursor.page_done(kind, page[-1][0], done["writes"])
        if done["kept"]:
            await self._sweep_tombstoned(client, graph_id, main_id, to_seq)
        logger.info("reconcile for %s at seq %d, a page at a time: %d write(s)", graph_id, to_seq,
                    done["writes"])
        return {"writes": done["writes"], "structural": done["structural"],
                "rollups": "stale" if done["writes"] or done["kept"] or resumed else "none"}

    async def _live_count(self, s, graph_id: str, main_id: str) -> int:
        """How many live entities ``main``'s heads hold — what a full reconcile compares."""
        return (await s.execute(select(func.count()).select_from(EntityHeadORM).where(
            EntityHeadORM.graph_id == graph_id, EntityHeadORM.branch_id == main_id,
            EntityHeadORM.is_tombstone.is_(False)))).scalar_one()

    async def _live_head_pages(self, s, graph, main_id, to_seq, kind: str, after: str = ""):
        """``main``'s live ``kind`` entities at ``to_seq``, ``PROJECTION_PAGE`` at a time in id order
        from after ``after`` (each entity's last row at the seq): ``[(entity_id, version_id,
        content_hash, urn or source, type, target)]``. The platform's rollups are left out.

        At main's head its ``entity_heads`` ARE its state, so they are paged by their primary key,
        each joined to its version by the version's: a page costs its own size. Behind the head, a
        page is the last version row of each entity at the seq (``DISTINCT ON``), which reads every
        later version row of the graph again for each page."""
        model = NodeVersionORM if kind == "node" else EdgeVersionORM
        named = ((model.urn, model.entity_type, null()) if kind == "node" else
                 (model.source_entity_id, model.edge_type, model.target_entity_id))
        at_head = graph.main_head_commit_seq == to_seq
        while True:
            if at_head:
                rows = (await s.execute(
                    select(EntityHeadORM.entity_id, EntityHeadORM.head_version_id,
                           case((EntityHeadORM.is_tombstone, "delete"), else_="update"),
                           EntityHeadORM.content_hash, *named)
                    .join(model, (model.graph_id == EntityHeadORM.graph_id)
                          & (model.id == EntityHeadORM.head_version_id))
                    .where(EntityHeadORM.graph_id == graph.id, EntityHeadORM.branch_id == main_id,
                           EntityHeadORM.entity_kind == kind, EntityHeadORM.entity_id > after)
                    .order_by(EntityHeadORM.entity_id).limit(config.PROJECTION_PAGE))).all()
            else:
                rows = (await s.execute(
                    select(model.entity_id, model.id, model.op, model.content_hash, *named)
                    .where(model.graph_id == graph.id, model.branch_id == main_id,
                           model.commit_seq <= to_seq, model.entity_id > after)
                    .order_by(model.entity_id, model.commit_seq.desc(), model.created_at.desc())
                    .distinct(model.entity_id).limit(config.PROJECTION_PAGE))).all()
            if not rows:
                return
            page = [(eid, vid, chash, a, typ, b) for eid, vid, op, chash, a, typ, b in rows
                    if op != "delete" and chash not in (_HASH_EMPTY, _HASH_NONE)
                    and (kind == "node" or (typ or "") != ROLLUP_EDGE_TYPE)]
            if page:
                yield page
            if len(rows) < config.PROJECTION_PAGE:
                return
            after = rows[-1][0]

    async def _write_missing(self, client, s, graph, main_id, kind, page, level_map,
                             provider_id, owned, twice_nodes: Set[Tuple[str, str]]) -> int:
        """Write what of ``page`` (:meth:`_live_head_pages`) FalkorDB lacks or holds differently;
        returns how many writes it took. As in place: a key held twice is rewritten (its copies
        deleted first, on an owned key) — but a customer's relationship held twice, one copy as
        main says, is left as it is — and so is every relationship on a node held twice
        (``twice_nodes``, filled in by the node pages)."""
        lm, wanted = level_map or {}, {}
        if kind == "node":
            for eid, vid, chash, urn, etype, _x in page:
                etype = etype or "Entity"
                label = spelled_label(etype)
                wanted[(label, urn or f"gv:{eid}")] = (
                    eid, ("node", graph.id, vid), _node_fingerprint(label, chash, lm.get(etype)))
        else:
            urn_of: Dict[str, str] = {}
            label_of: Dict[str, str] = {}
            await self._prefetch_endpoints(s, graph, main_id,
                                           [e for row in page for e in (row[3], row[5])],
                                           urn_of, label_of)
            for eid, vid, chash, src, etype, tgt in page:
                su, slb = await self._endpoint(s, graph, main_id, src, urn_of, label_of)
                tu, tlb = await self._endpoint(s, graph, main_id, tgt, urn_of, label_of)
                rel = spelled_type(etype)
                wanted[(spelled_label(slb), su, rel, spelled_label(tlb), tu)] = (
                    eid, ("edge", graph.id, vid), _edge_fingerprint(rel, chash))
        held = await self._held_fingerprints(client, kind, list(wanted))

        def right(k) -> bool:      # held once, as main says; a customer's relationship: any copy
            fps = held.get(k, ())
            return fps == [wanted[k][2]] or (
                kind == "edge" and not owned and len(fps) > 1 and wanted[k][2] in fps)

        twice = [k for k in wanted if len(held.get(k, ())) > 1 and not right(k)]
        todo = [k for k in wanted if not right(k) or (kind == "edge" and (
            (k[0], k[1]) in twice_nodes or (k[3], k[4]) in twice_nodes))]
        if kind == "node":
            twice_nodes.update(k for k in wanted if len(held.get(k, ())) > 1)
        writes = len(todo)
        if twice and owned:
            if kind == "node":
                for label, urns in _group([(u, lb) for lb, u in twice]).items():
                    await self._laddered(client, "node_delete",
                                         _delete_nodes_cypher(_sanitize_label(label)), urns,
                                         param="urns")
            else:
                await self._delete_edges_by_key(client, twice)
            writes += len(twice)
        if not todo:
            return 0
        payload_of = await self._svc._payloads_by_version(s, [wanted[k][1] for k in todo])
        if kind == "node":
            await self._apply(client, [(wanted[k][0], k[1], payload_of[wanted[k][1][2]]) for k in todo],
                              [], [], [], level_map=level_map, provider_id=provider_id,
                              owned=owned, prior=None if owned else {})
        else:
            await self._apply(client, [], [(wanted[k][0], k[1], k[4], payload_of[wanted[k][1][2]],
                                             k[0], k[3]) for k in todo], [], [],
                              level_map=level_map, provider_id=provider_id, owned=owned,
                              prior=None if owned else {})
        return writes

    async def _held_fingerprints(self, client, kind: str, keys) -> Dict[tuple, List[object]]:
        """What FalkorDB holds under each key — every copy's fingerprint — looked up through the
        urn indexes: a node key ``(label, urn)``, a relationship's ``(source label, source urn,
        type, target label, target urn)``."""
        out: Dict[tuple, List[object]] = {}
        if kind == "node":
            for label, urns in _group([(u, lb) for lb, u in keys]).items():
                def nodes(_part, res, label=label) -> None:
                    for u, fp in (getattr(res, "result_set", None) or []):
                        out.setdefault((label, str(u)), []).append(fp)

                await self._laddered(client, "node_fingerprints",
                                     f"UNWIND $urns AS u MATCH (n:{_sanitize_label(label)} "
                                     "{urn: u}) RETURN u, n.gvHash", urns, param="urns",
                                     timeout_ms=_READ_TIMEOUT_MS, read_only=True, on_result=nodes)
            return out
        by: Dict[Tuple[str, str, str], list] = {}
        for sl, su, rel, tl, tu in keys:
            by.setdefault((rel, sl, tl), []).append({"src": su, "tgt": tu})
        for (rel, sl, tl), items in by.items():
            def edges(_part, res, rel=rel, sl=sl, tl=tl) -> None:
                for su, tu, fp in (getattr(res, "result_set", None) or []):
                    out.setdefault((sl, str(su), rel, tl, str(tu)), []).append(fp)

            await self._laddered(client, "edge_fingerprints",
                                 f"UNWIND $batch AS it MATCH (a:{_sanitize_label(sl or 'Entity')} "
                                 f"{{urn: it.src}})-[r:{rel}]->"
                                 f"(b:{_sanitize_label(tl or 'Entity')} {{urn: it.tgt}}) "
                                 "RETURN it.src, it.tgt, r.gvHash", items,
                                 timeout_ms=_READ_TIMEOUT_MS, read_only=True, on_result=edges)
        return out

    async def _held_urns(self, client, label: str, urns) -> Set[str]:
        """Those of ``urns`` FalkorDB holds a node of under ``label``."""
        return {k[1] for k in await self._held_fingerprints(client, "node", [(label, u) for u in urns])}

    async def _live_labels(self, s, graph_id, main_id, to_seq, urns) -> Dict[str, Set[str]]:
        """For each of ``urns``, the labels ``main`` holds a live node of it under at ``to_seq``
        (a node with no urn of its own is ``gv:<entity id>``)."""
        urns = list(urns)
        if not urns:
            return {}
        eids = {u[3:] for u in urns if u.startswith("gv:")}
        for chunk in _batches([u for u in urns if not u.startswith("gv:")], _ENDPOINT_CHUNK):
            eids.update((await s.execute(
                select(NodeVersionORM.entity_id).where(
                    NodeVersionORM.graph_id == graph_id, NodeVersionORM.branch_id == main_id,
                    NodeVersionORM.urn.in_(list(chunk)), NodeVersionORM.commit_seq <= to_seq)
                .distinct())).scalars().all())
        out: Dict[str, Set[str]] = {}
        for chunk in _batches(sorted(eids), _ENDPOINT_CHUNK):
            for eid, op, chash, urn, etype in (await s.execute(
                    select(NodeVersionORM.entity_id, NodeVersionORM.op, NodeVersionORM.content_hash,
                           NodeVersionORM.urn, NodeVersionORM.entity_type)
                    .where(NodeVersionORM.graph_id == graph_id, NodeVersionORM.branch_id == main_id,
                           NodeVersionORM.entity_id.in_(list(chunk)),
                           NodeVersionORM.commit_seq <= to_seq)
                    .order_by(NodeVersionORM.entity_id, NodeVersionORM.commit_seq.desc(),
                              NodeVersionORM.created_at.desc())
                    .distinct(NodeVersionORM.entity_id))).all():
                if op != "delete" and chash not in (_HASH_EMPTY, _HASH_NONE):
                    out.setdefault(urn or f"gv:{eid}", set()).add(spelled_label(etype or "Entity"))
        return out

    async def _edge_keys_at(self, s, graph, main_id, to_seq, eids) -> Dict[str, EdgeKey]:
        """For each of the relationship ids ``eids`` live on ``main`` at ``to_seq``, the key the
        projector writes it under."""
        out: Dict[str, EdgeKey] = {}
        rows = []
        for chunk in _batches(sorted(set(eids)), _ENDPOINT_CHUNK):
            rows += (await s.execute(
                select(EdgeVersionORM.entity_id, EdgeVersionORM.op, EdgeVersionORM.content_hash,
                       EdgeVersionORM.source_entity_id, EdgeVersionORM.edge_type,
                       EdgeVersionORM.target_entity_id)
                .where(EdgeVersionORM.graph_id == graph.id, EdgeVersionORM.branch_id == main_id,
                       EdgeVersionORM.entity_id.in_(list(chunk)),
                       EdgeVersionORM.commit_seq <= to_seq)
                .order_by(EdgeVersionORM.entity_id, EdgeVersionORM.commit_seq.desc(),
                          EdgeVersionORM.created_at.desc())
                .distinct(EdgeVersionORM.entity_id))).all()
        live = [r for r in rows if r[1] != "delete" and r[2] not in (_HASH_EMPTY, _HASH_NONE)]
        urn_of: Dict[str, str] = {}
        label_of: Dict[str, str] = {}
        await self._prefetch_endpoints(s, graph, main_id, [e for r in live for e in (r[3], r[5])],
                                       urn_of, label_of)
        for eid, _op, _h, src, etype, tgt in live:
            su, slb = await self._endpoint(s, graph, main_id, src, urn_of, label_of)
            tu, tlb = await self._endpoint(s, graph, main_id, tgt, urn_of, label_of)
            out[eid] = (spelled_label(slb), su, spelled_type(etype), spelled_label(tlb), tu)
        return out

    async def _rekey_in_place(self, client, rekeys, progress=None) -> None:
        """Move each node whose urn changed to its new urn IN PLACE (``SET n.urn``): it keeps its
        internal id, its relationships and the rollup cells on it, and the window's merge, keyed
        by the new urn, finds it. A MERGE alone created a second node under the new urn and left
        the old one, with every edge, behind: an extra node, for which the verify held every pass
        back until a rebuild. A node FalkorDB already holds under the new urn is left as it is."""
        by: Dict[str, list] = {}
        for old, new, label in rekeys:
            if old != new:
                by.setdefault(label, []).append({"old": old, "new": new})
        for label, items in by.items():
            lbl = _sanitize_label(label)
            await self._laddered(client, "rekey",
                                 f"UNWIND $batch AS it MATCH (n:{lbl} {{urn: it.old}}) "
                                 f"OPTIONAL MATCH (m:{lbl} {{urn: it.new}}) "
                                 "WITH n, it, m WHERE m IS NULL SET n.urn = it.new",
                                 items, progress=progress)

    async def _relabel_in_place(self, client, relabels, progress=None) -> None:
        """Retype nodes IN PLACE (``SET n:new REMOVE n:old``): the node keeps its id, its
        edges and the rollup cells on it. A MERGE under the new label would create a second
        node and leave the old one; a delete-and-recreate would take its edges and rollups."""
        by: Dict[Tuple[str, str], List[str]] = {}
        for urn, old, new in relabels:
            if old != new:
                by.setdefault((old, new), []).append(urn)
        for (old, new), urns in by.items():
            await self._laddered(client, "relabel",
                                 f"UNWIND $urns AS u MATCH (n:{_sanitize_label(old)} {{urn: u}}) "
                                 f"SET n:{_sanitize_label(new)} REMOVE n:{_sanitize_label(old)}",
                                 urns, param="urns", progress=progress)

    async def _delete_edges_by_key(self, client, keys, progress=None) -> None:
        by: Dict[Tuple[str, str, str], list] = {}
        for sl, su, rel, tl, tu in keys:
            by.setdefault((rel, _sanitize_label(sl or "Entity"), _sanitize_label(tl or "Entity")),
                          []).append({"src": su, "tgt": tu})
        for (rel, sl, tl), items in by.items():
            await self._laddered(client, "edge_delete_key", _delete_edges_by_key_cypher(rel, sl, tl),
                                 items, progress=progress)

    def _verify_due(self, graph_id: str, from_seq: int, dropped: int, drift) -> bool:
        """Whether this pass counts the whole graph in both stores (``PROJECTION_VERIFY_INTERVAL_SECS``):
        always for a full seed, a pass that dropped a write, a key with drift on record, and a graph
        not verified clean within the interval."""
        if from_seq <= 0 or dropped or drift or config.PROJECTION_VERIFY_INTERVAL_SECS <= 0:
            return True
        last = self._verified_at.get(graph_id)
        return last is None or time.monotonic() - last >= config.PROJECTION_VERIFY_INTERVAL_SECS

    async def _verify_and_heal(
        self, client, graph_id, main_id, from_seq, to_seq, level_map=None,
        heal_outcome: Optional[Dict[str, object]] = None, rollups_moved: bool = False,
        owned: bool = True, provider_id: Optional[str] = None, dropped: int = 0,
        drift: Optional[dict] = None,
    ) -> Tuple[Optional[str], bool]:
        """Reconcile live node/edge COUNTS between Postgres (SoR) and FalkorDB after an
        apply, and — on a FULL SEED — additionally CONTENT-verify (id-set + deep fields), since
        counts alone are blind to a dropped/mistyped edge or a node reseeded with a wrong label /
        empty displayName. Best-effort (any count failure → skip). Two mismatch directions:

        * FalkorDB has FEWER than committed main (a dropped delta): bounded-heal ONCE by
          reconciling in place — only the missing / changed / extra items are written,
          and the rollups are moved by that same difference.
        * FalkorDB has MORE than committed main: first sweep anything ``main`` has
          TOMBSTONED that the incremental pass missed (an explicit delete the cache
          stranded — urn drift, a re-point reset, or a pre-versioning seed); a tombstone
          is main's authoritative "this is deleted" and must always clear the cache.
          Whatever extra remains is un-imported legacy/aggregation data (no tombstone):
          DO NOT auto-delete it (that would wipe un-versioned data). In a key the platform
          minted it is an error, held back until it is brought into history or rebuilt away.
          In a customer's key (``owned`` false) it is what the key's other writers put there
          (an ETL that kept writing): tolerated, and handed back in ``heal_outcome["surplus"]``
          as (nodes, edges) to be flagged (None: counted, and none; absent: not counted) — so long as the pass's own writes landed
          (``dropped`` edges whose endpoint was not there are a shortfall, healed). A surplus
          equal to the one last recorded (``drift``) has nothing new to sweep for.

        Returns ``(error_or_None, healed)`` — ``healed`` is True when the heal reconcile
        ran; its outcome (writes, and whether the rollups were moved or must be handed
        to the aggregation batch job) is written into ``heal_outcome`` when given."""
        try:
            pg = await self._pg_live_counts(graph_id, main_id, to_seq)
            if pg is None:
                return None, False                       # a lagging head — not applicable
            fk = await self._falkor_counts(client, owned)
        except Exception as exc:
            # Not a clean verify: the pass publishes what it wrote, but is not counted as checked,
            # so the next pass verifies again rather than waiting out the interval.
            logger.warning("projection verify for %s could not count (%s); published unverified, "
                           "to be verified by the next pass", graph_id, exc)
            if heal_outcome is not None:
                heal_outcome["unverified"] = True
            return None, False
        if heal_outcome is not None and not owned:
            heal_outcome["surplus"] = None               # counted: none, unless found below
        lost = bool(dropped) and not owned             # a write of this pass's that did not land
        if pg == fk and not lost:
            # Counts match — but on a full seed that is NOT sufficient (content drift keeps the
            # counts). Run the content verify; None unless it finds drift (or not a full seed).
            # Pass the entity count so the deep pass can size-gate itself (fk = node + edge counts).
            return (await self._full_seed_content_error(
                client, graph_id, main_id, from_seq, fk[0] + fk[1], owned=owned)), False
        pg_n, pg_e = pg
        f_n, f_e = fk
        seen = (drift or {}).get("nodes"), (drift or {}).get("edges")
        if (f_n > pg_n or f_e > pg_e) and (owned or lost or (f_n - pg_n, f_e - pg_e) != seen):
            # Remove deleted-on-main entities the cache stranded, then re-count. Legacy
            # (never-versioned) entities carry no tombstone, so they survive the sweep.
            try:
                await self._sweep_tombstoned(client, graph_id, main_id, to_seq)
                fk = await self._falkor_counts(client, owned)
            except Exception:
                logger.exception("projection tombstone sweep failed for %s", graph_id)
            else:
                if f_n - fk[0] or f_e - fk[1]:
                    logger.warning("projection: swept %d node(s) + %d edge(s) tombstoned-but-"
                                   "lingering from FalkorDB for %s (deletes the incremental pass "
                                   "missed)", f_n - fk[0], f_e - fk[1], graph_id)
                if pg == fk and not lost:
                    return None, False
                f_n, f_e = fk
        if not owned and f_n >= pg_n and f_e >= pg_e and not lost:
            # A customer's key: kept, and flagged with how much history doesn't hold.
            if heal_outcome is not None:
                heal_outcome["surplus"] = (f_n - pg_n, f_e - pg_e)
            return (await self._full_seed_content_error(
                client, graph_id, main_id, from_seq, f_n + f_e, owned=False)), False
        if owned and (f_n > pg_n or f_e > pg_e):
            msg = (f"FalkorDB holds entities version history does not "
                   f"(PG n={pg_n},e={pg_e}; Falkor n={f_n},e={f_e}): something wrote to this graph "
                   f"outside version control. Rebuild replaces it with what history holds")
            logger.error("%s for %s", msg, graph_id)
            if config.PROJECTION_ESCALATE and from_seq > 0 and heal_outcome is not None:
                heal_outcome["escalate"] = "it holds more than history after the sweep"
            return msg, False
        if from_seq > 0 and config.PROJECTION_ESCALATE and heal_outcome is not None:
            # Missing committed data: not healed inside this window's pass, whose budget is for
            # the window. It ends unpublished, and the graph is rebuilt in place by a pass of its
            # own (streamed, resumable, with progress), as an operator's rebuild would be.
            msg = (f"projection verify found FalkorDB short of committed main at seq {to_seq} "
                   f"(PG n={pg_n},e={pg_e} > Falkor n={f_n},e={f_e}); rebuilding in place")
            logger.warning("%s for %s", msg, graph_id)
            heal_outcome["escalate"] = "it holds less than history"
            return msg, False
        if from_seq > 0:                                 # missing committed data → reconcile once
            # Incremental window that dropped a committed delta: reconcile the FULL live state in
            # place once, then re-verify. A FULL seed (from_seq==0) is NOT healed here — it just
            # DID the full reconcile, so a shortfall is deterministic and re-running reproduces it;
            # it falls through to the mismatch error below and the caller HOLDS THE WATERMARK BACK
            # (reads stay on Postgres) rather than looping. A count-clean full seed still gets the
            # content verify at the `pg == fk` branch above.
            logger.warning("projection verify mismatch for %s (PG n=%d,e=%d > Falkor n=%d,e=%d); "
                           "reconciling in place from Postgres (bounded heal)", graph_id, pg_n, pg_e, f_n, f_e)
            try:
                # In place, like a full replay: write back only what is missing
                # and move the rollups by the same difference.
                healed = await self._reconcile_in_place(
                    client, graph_id, main_id, to_seq, level_map,
                    rollups_moved_this_pass=rollups_moved, provider_id=provider_id, owned=owned)
                if heal_outcome is not None:
                    heal_outcome.update(healed)
                pg2 = await self._pg_live_counts(graph_id, main_id, to_seq)
                fk2 = await self._falkor_counts(client, owned)
                if pg2 is None and heal_outcome is not None:
                    heal_outcome.pop("surplus", None)    # not re-counted: the flag stays as is
                if pg2 is None or pg2 == fk2:
                    return None, True
                if not owned and fk2[0] >= pg2[0] and fk2[1] >= pg2[1]:
                    if heal_outcome is not None:
                        heal_outcome["surplus"] = (fk2[0] - pg2[0], fk2[1] - pg2[1])
                    return None, True
            except Exception:
                logger.exception("projection heal reconcile failed for %s", graph_id)
                return f"projection heal reconcile failed at seq {to_seq}", True
        msg = f"projection verify mismatch at seq {to_seq} after heal (committed != FalkorDB)"
        logger.error("%s for %s", msg, graph_id)
        return msg, False

    async def _full_seed_content_error(
        self, client, graph_id, main_id, from_seq, entity_count=0, owned: bool = True,
    ) -> Optional[str]:
        """Content verify for a FULL SEED whose COUNTS already matched: the reconciler's single-scan
        content diff (node displayName/label drift + edge type/confidence/properties drift) of the
        freshly-seeded cache vs committed main. Returns an error string on ANY field drift the count
        verify can't see, else None. No-op off the full-seed path, when disabled, or above the
        deep-verify entity ceiling (the ordered scan's SKIP/LIMIT paging degrades on a very large
        graph — count verify still ran; the on-demand reconcile can deep-diff any size). Best-effort:
        a diff-infra failure degrades to None (counts already passed), never raises. In a customer's
        key (``owned`` false) an entity history doesn't hold is someone else's, not drift."""
        if from_seq > 0 or not config.PROJECTION_VERIFY_DEEP:
            return None
        cap = config.PROJECTION_VERIFY_DEEP_MAX_ENTITIES
        if cap > 0 and entity_count > cap:
            logger.info("full-seed deep verify skipped for %s (%d entities > %d cap); count verify "
                        "already applied, on-demand reconcile can deep-diff", graph_id, entity_count, cap)
            return None
        try:
            from .reconcile import ProjectionReconciler
            rec = ProjectionReconciler(self._session, lambda name, provider_id=None: client)
            # Edge missing/extra are owned by the DISTINCT-triple count verify (collapse-noisy by id),
            # so content_drift returns them empty; node coverage + node/edge field drift remain.
            mn, xn, _me, _xe, mm, em = await rec.content_drift(client, graph_id, main_id)
        except Exception:                                # pragma: no cover - infra
            logger.debug("full-seed content verify skipped for %s (diff failed)",
                         graph_id, exc_info=True)
            return None
        if mn or (xn and owned) or mm or em:
            msg = (f"content drift after full seed: {len(mn)} missing node(s), "
                   f"{len(xn)} extra node(s), {len(mm)} node field mismatch(es), "
                   f"{len(em)} edge attr mismatch(es) (bounded sample) — cache NOT published")
            logger.error("%s for %s", msg, graph_id)
            return msg
        return None

    async def _sweep_tombstoned(self, client, graph_id, main_id, to_seq: int) -> None:
        """DETACH DELETE from the cache every node/edge ``main`` has TOMBSTONED that the
        incremental pass stranded (a re-point reset, a partial delete, or a pre-versioning seed).
        A tombstone is main's authoritative "this is deleted", so it must always clear the cache;
        never-versioned entities carry no tombstone and are never deleted here (on a customer's
        key they are counted in ``external_drift``).

        Only the deletes committed since the last sweep are read (``_GVProjMeta.sweptSeq``, set to
        ``to_seq`` once this one's deletes have landed): an earlier sweep cleared every tombstone
        at or below it. A key that lost the marker lost what was swept with it, and is swept from
        the start. Nodes are matched by their last committed ``urn`` (the indexed key) with the
        entityId confirmed, so a live entity that later reused the urn is never deleted; edges are
        typed and anchored on the ends their last row gave them. Version columns only: no
        payload is read. A stranded node whose cache urn DIFFERS from its committed urn is not
        caught here; the count check still flags it.

        Reached on the heal path (a count mismatch on a caught-up, non-fork main) and after a
        reconcile of a customer's key that kept what history doesn't hold, so the work is bounded
        by the deletes since the last sweep, not by the graph's history."""
        since = 0
        try:
            res = await _q(client, _SWEPT_READ, read_only=True, timeout_ms=5000)
            rows = getattr(res, "result_set", None) or []
            if rows and rows[0] and rows[0][0] is not None:
                since = min(int(rows[0][0]), to_seq)
        except Exception:                                # unreadable: sweep from the start
            since = 0
        pairs_by_label: Dict[str, List[dict]] = {}
        edge_deletes: List[dict] = []
        async with self._session() as s:
            graph = await s.get(GraphORM, graph_id)

            async def tombstoned(model, kind: str) -> List[str]:
                deleted = (select(model.entity_id).where(
                    model.graph_id == graph_id, model.branch_id == main_id, model.op == "delete",
                    model.commit_seq > since, model.commit_seq <= to_seq).distinct())
                return list((await s.execute(select(EntityHeadORM.entity_id).where(
                    EntityHeadORM.graph_id == graph_id, EntityHeadORM.branch_id == main_id,
                    EntityHeadORM.entity_kind == kind, EntityHeadORM.is_tombstone.is_(True),
                    EntityHeadORM.entity_id.in_(deleted)))).scalars().all())

            node_ids = await tombstoned(NodeVersionORM, "node")
            edge_ids = await tombstoned(EdgeVersionORM, "edge")
            for chunk in _batches(node_ids, _ENDPOINT_CHUNK):
                for eid, urn, etype in (await s.execute(
                        select(NodeVersionORM.entity_id, NodeVersionORM.urn, NodeVersionORM.entity_type)
                        .where(NodeVersionORM.graph_id == graph_id,
                               NodeVersionORM.branch_id == main_id,
                               NodeVersionORM.entity_id.in_(list(chunk)),
                               NodeVersionORM.urn.is_not(None))
                        .order_by(NodeVersionORM.entity_id, NodeVersionORM.commit_seq.desc(),
                                  NodeVersionORM.created_at.desc())
                        .distinct(NodeVersionORM.entity_id))).all():
                    pairs_by_label.setdefault(spelled_label(etype or "Entity"), []).append(
                        {"urn": urn, "eid": eid})
            urn_cache: Dict[str, str] = {}
            label_cache: Dict[str, str] = {}
            for chunk in _batches(edge_ids, _ENDPOINT_CHUNK):
                last = (await s.execute(
                    select(EdgeVersionORM.entity_id, EdgeVersionORM.edge_type,
                           EdgeVersionORM.source_entity_id, EdgeVersionORM.target_entity_id)
                    .where(EdgeVersionORM.graph_id == graph_id,
                           EdgeVersionORM.branch_id == main_id,
                           EdgeVersionORM.entity_id.in_(list(chunk)), EdgeVersionORM.op != "delete")
                    .order_by(EdgeVersionORM.entity_id, EdgeVersionORM.commit_seq.desc(),
                              EdgeVersionORM.created_at.desc())
                    .distinct(EdgeVersionORM.entity_id))).all()
                await self._prefetch_endpoints(s, graph, main_id,
                                               [e for row in last for e in (row[2], row[3])],
                                               urn_cache, label_cache)
                for eid, etype, src, tgt in last:
                    if str(etype or "") == ROLLUP_EDGE_TYPE or not (src and tgt):
                        continue
                    su, slb = await self._endpoint(s, graph, main_id, src, urn_cache, label_cache)
                    tu, tlb = await self._endpoint(s, graph, main_id, tgt, urn_cache, label_cache)
                    edge_deletes.append({"eid": eid, "src": su, "tgt": tu,
                                         "rel": str(etype or "REL"), "slb": slb, "tlb": tlb})
        # Reads no query stats — the FalkorDB asyncio client mis-parses them; removal is measured
        # by the caller's re-count (mirrors the incremental delete in ``_apply``).
        for label, pairs in pairs_by_label.items():
            await self._laddered(client, "node_delete_pair", _delete_nodes_by_pair_cypher(label),
                                 pairs, param="pairs")
        await self._run_edge_deletes(client, edge_deletes)
        await _q(client, _SWEPT_WRITE, params={"seq": to_seq})

    def _progress_writer(self, graph_id: str, total: int):
        """Throttled full-seed progress: accumulates per-chunk counts and persists to
        ``projection_state.progress_done/total`` at most ~1/s (always on the final item),
        so the Data health poll sees live movement without a DB write per chunk.
        Best-effort by design — a progress write must never fail the projection."""
        state = {"done": 0, "last": 0.0}

        async def _on_chunk(n: int) -> None:
            state["done"] += n
            now = time.monotonic()
            if now - state["last"] < 1.0 and state["done"] < total:
                return
            state["last"] = now
            try:
                async with self._session() as s:
                    ps = await s.get(ProjectionStateORM, graph_id)
                    if ps is not None:
                        ps.progress_done = state["done"]
                        ps.progress_total = total
            except Exception:                            # pragma: no cover - infra
                logger.debug("progress write failed for %s", graph_id, exc_info=True)

        return _on_chunk

    async def _apply_paged(self, client, graph_id, main_id, from_seq, to_seq, *, level_map,
                           provider_id, owned, cursor: Optional[_Cursor] = None) -> Tuple[int, bool, int]:
        """:meth:`_apply` of a window too large to hold (more than ``PROJECTION_PAGED_ABOVE``
        version rows), computed and written a page at a time (:meth:`_window_pages`): every page
        of its nodes, each relabelled first as one window's are, then every page of its edges, so
        an edge's ends are there when it is written. Its Merkle cross-check is left out (the
        verify that follows counts what landed). Returns ``(dropped, structural, written)``:
        the first two as the one-batch pass has them, and how many changes it wrote.

        ``cursor``: after each page lands the pass writes where it is, and a pass past its time
        stops there (:class:`_PassPartial`); one that resumes starts after the last page that
        landed. Its progress is the window's version rows."""
        dropped, structural, written = 0, False, 0
        async with self._session() as s:
            graph = await s.get(GraphORM, graph_id)
            total = await self._window_rows(s, graph, main_id, from_seq, to_seq)
        progress = self._progress_writer(graph_id, total) if total else None
        async with self._session() as s:
            graph = await s.get(GraphORM, graph_id)
            for kind in ("node", "edge"):
                after = cursor.start(kind, ("node", "edge")) if cursor else ""
                if after is None:
                    continue                             # a resumed pass had finished these
                async for changes, last_id in self._window_pages(s, graph, main_id, from_seq,
                                                                 to_seq, kind, after=after):
                    moved, retypes, rekeys = await self._window_meta(s, graph, main_id, from_seq,
                                                                     changes)
                    structural = structural or moved
                    prior = None if owned else await self._properties_before(
                        s, graph, main_id, from_seq, changes[0])
                    await self._rekey_in_place(client, rekeys)
                    await self._relabel_in_place(client, retypes)
                    dropped += await self._apply(client, *changes, level_map=level_map,
                                                 provider_id=provider_id, owned=owned,
                                                 prior=prior) or 0
                    written += sum(len(c) for c in changes)
                    if progress:
                        await progress(sum(len(c) for c in changes))
                    if cursor is not None:
                        await cursor.page_done(kind, last_id, written)
        return dropped, structural, written

    async def _apply(self, client, node_upserts, edge_upserts, node_deletes, edge_deletes,
                     progress=None, level_map: Optional[Dict[str, int]] = None,
                     provider_id: Optional[str] = None, known_empty: bool = False,
                     owned: bool = True, prior: Optional[Dict[str, Set[str]]] = None) -> int:
        """Apply one pass: nodes in (grouped by label), edges in (grouped by
        type + endpoint labels — the per-label URN indexes drive every node
        match), edges out, nodes out.

        This writes through its own client and never touches a provider
        instance, so it stakes the platform's property names itself
        (``reserve_platform_property_names``) and spends the ENV-wide
        ``FALKORDB_NATIVE_PROPERTY_BUDGET``. The reserve is decided from the
        registered names this pass already reads, so it costs nothing on a
        graph that holds them and happens again by itself after a full seed
        DROPs the graph and takes every registered name with it.

        An upsert's payload may be a :class:`_Pending`; it is read with the batch that writes it.
        ``provider_id`` is the instance ``client`` writes to (None: the default one).
        ``known_empty``: no node being written exists yet (a package seed's own fresh key), so no
        node can carry a property its payload lost — the read for them is skipped. ``owned`` is the
        key's ``owns_falkor_graph``: a customer's graph keeps its relationships' ids. ``prior``
        (a customer's key): each node's property names before this pass, the only ones it may
        strip (:meth:`_mark_removed_properties`). Returns how many edges did not land: an
        endpoint that isn't there matches nothing."""
        await self._ensure_urn_indexes(client, provider_id, [
            *(p.get("entityType") or "Entity" for _e, _u, p in node_upserts),
            *(lbl for *_rest, slb, tlb in edge_upserts for lbl in (slb, tlb)),
            *(lbl for _u, lbl in node_deletes),
            *(e.get(k) for e in edge_deletes if isinstance(e, dict) for k in ("slb", "tlb"))])
        # Which user property keys this pass writes natively — the same
        # budget the provider's own writers apply, so a versioned graph and
        # a direct-load graph spend their attribute ids the same way.
        native_keys: Optional[Set[str]] = None
        if node_upserts:
            registered = await _registered_property_names(client)
            registered |= await reserve_platform_property_names(
                lambda cypher, params: _q(client, cypher, params=params),
                str(getattr(client, "name", "") or "the graph"),
                registered,
            )
            budget = _native_property_budget()
            native_keys, demoted = _admit_native_keys(
                await self._native_key_counts(node_upserts),
                registered=registered,
                budget=budget, reserve=_NAME_FALLBACK_KEYS,
            )
            if demoted:
                logger.warning(
                    "projection: %d property key(s) stored as values in "
                    "propertiesRaw rather than as node properties — shown in "
                    "the Properties panel, not reachable by search predicates. "
                    "The graph holds %d of the %d native property names "
                    "FALKORDB_NATIVE_PROPERTY_BUDGET allows. Most common first: %s",
                    len(demoted), len(native_keys), budget, demoted[:5],
                )
        by_label: Dict[str, list] = {}
        for up in node_upserts:
            by_label.setdefault(spelled_label(up[2].get("entityType")), []).append(up)
        keep = _projector_owned_property_names()
        for label, ups in by_label.items():
            for batch in _batches(ups, self._batch):
                chunk = []
                for eid, urn, p in await self._loaded(batch, 2):
                    item = _node_item(eid, urn, p, level_map, native_keys)
                    # The fingerprint a later reconcile compares against, so it can
                    # tell an up-to-date node from one it must rewrite.
                    item["gvHash"] = _node_fingerprint(
                        label, content_hash(p), (level_map or {}).get(p.get("entityType")))
                    chunk.append(item)
                if known_empty:
                    for item in chunk:
                        item["gone"] = {}
                else:
                    await self._mark_removed_properties(client, label, chunk, keep, prior)
                await self._laddered(client, "node_merge", _node_merge_cypher(label), chunk,
                                     progress=progress)

        by_rel: Dict[Tuple[str, str, str], list] = {}
        for up in edge_upserts:
            _eid, _su, _tu, p, slb, tlb = up
            key = (spelled_type(p.get("edgeType")), spelled_label(slb), spelled_label(tlb))
            by_rel.setdefault(key, []).append(up)
        dropped = 0

        def count_landed(part, res) -> None:
            nonlocal dropped
            landed = getattr(res, "result_set", None) or []
            if landed and landed[0]:
                dropped += len(part) - int(landed[0][0] or 0)

        for (rel, sl, tl), ups in by_rel.items():
            for batch in _batches(ups, self._batch):
                chunk = []
                for eid, su, tu, p, _slb, _tlb in await self._loaded(batch, 3):
                    item = _edge_item(eid, su, tu, p)
                    item["gvHash"] = _edge_fingerprint(rel, content_hash(p))
                    chunk.append(item)
                await self._laddered(client, "edge_merge",
                                     _edge_merge_cypher(rel, sl, tl, keep_id=not owned), chunk,
                                     on_result=count_landed, progress=progress)

        await self._run_edge_deletes(client, edge_deletes, progress=progress)

        ndel_by: Dict[str, list] = {}
        for urn, label in node_deletes:
            ndel_by.setdefault(spelled_label(label), []).append(urn)
        for label, urns in ndel_by.items():
            await self._laddered(client, "node_delete", _delete_nodes_cypher(label), urns,
                                 param="urns", progress=progress,
                                 at_floor=self._hub_safe_delete(client, label))
        return dropped

    async def _ensure_urn_indexes(self, client, provider_id: Optional[str],
                                  labels: Iterable[Optional[str]]) -> None:
        """Best effort, before a pass writes: the urn index of every label it merges or anchors on,
        so each MERGE / MATCH seeks instead of scanning the label per UNWIND row — a key nothing
        else indexed (one the versioning layer fills itself) had none.

        Once per (instance, graph, label) in a process — but only once it is made (or found made):
        a refused statement is logged and asked again by the next pass, and the pass goes on
        unindexed (slower, never wrong). A refusal about the NODE rather than the statement (no
        in-sync replica, still loading, not answering — ``_index_ddl_deferred_reason``) stops the
        set: every other statement would fail the same way. ``drop_graph`` forgets a graph's
        entries, since GRAPH.DELETE takes its indexes."""
        name = str(getattr(client, "name", "") or "")
        want = [lbl for lbl in dict.fromkeys(spelled_label(lbl) for lbl in labels)
                if (provider_id, name, lbl) not in _URN_INDEXED]
        for lbl in want:
            try:
                await ensure_urn_indexes(client, [lbl], strict=True)
            except Exception as exc:
                reason = _index_ddl_deferred_reason(exc)
                if reason is not None:
                    logger.warning("projection: urn indexes on %s deferred — the node %s",
                                   name or "the graph", reason)
                    return
                logger.warning("projection: urn index on %s(:%s) not created: %s",
                               name or "the graph", lbl, exc)
                continue
            if name:
                _URN_INDEXED.add((provider_id, name, lbl))

    async def _native_key_counts(self, node_upserts) -> Iterable[dict]:
        """What ``_admit_native_keys`` counts over ``node_upserts`` — each property key once per
        node whose value for it could be stored natively — with a pending payload read a batch at a
        time and let go, so the admission sees every node without holding every payload."""
        counts: Counter = Counter()
        pending = []
        for _eid, _urn, p in node_upserts:
            if isinstance(p, _Pending):
                pending.append(p.ref)
            else:
                counts.update(k for k, v in (p.get("properties") or {}).items()
                              if v is not None and _is_native_value(v))
        for refs in _batches(pending, self._batch):
            async with self._session() as s:
                payload_of = await self._svc._payloads_by_version(s, refs)
            for p in payload_of.values():
                counts.update(k for k, v in ((p or {}).get("properties") or {}).items()
                              if v is not None and _is_native_value(v))
        return ({k: True} for k in counts.elements())

    async def _loaded(self, batch: list, at: int) -> list:
        """``batch``'s upserts with each pending payload (slot ``at``) read, in one statement."""
        refs = [up[at].ref for up in batch if isinstance(up[at], _Pending)]
        if not refs:
            return batch
        async with self._session() as s:
            payload_of = await self._svc._payloads_by_version(s, refs)
        return [(*up[:at], payload_of.get(up[at].ref[2]), *up[at + 1:])
                if isinstance(up[at], _Pending) else up for up in batch]

    async def _mark_removed_properties(self, client, label: str, chunk: list, keep,
                                       prior: Optional[Dict[str, Set[str]]] = None) -> None:
        """Give each item a ``gone`` map of the user properties its node still carries but
        the committed payload no longer has — ``n += nativeProps`` only ever adds, so a
        property removed from an entity used to stay on its node (in Properties, matching
        search filters) until a drop-and-replay wiped the graph, which no longer happens. A
        null in the map removes the property.

        ``keep`` is never removed, and neither is a node's own identity property — the source
        property its ``urnSource`` / ``nameSource`` stamp says its urn / name was filled from
        (a source whose identity column is ``id`` keeps its ``id``). With ``prior`` (a customer's
        key), only a property the node's payload had before is removed: what history never held,
        something else wrote, and it stays."""
        for item in chunk:
            item["gone"] = {}
        held: Dict[str, Set[str]] = {}

        def collect(_part, res) -> None:
            for u, ks, *identity in (getattr(res, "result_set", None) or []):
                held[str(u)] = set(ks or []) - {k for k in identity if isinstance(k, str) and k}

        async def unread(urn, exc) -> bool:
            # The read only finds properties to remove: a node it cannot read keeps them this pass.
            logger.warning("projection: could not read the properties of %s (%s); any it lost "
                           "stay on it until it is written again", urn, exc)
            return True

        await self._laddered(client, "node_keys",
                             f"UNWIND $urns AS u MATCH (n:{label} {{urn: u}}) "
                             f"RETURN u, keys(n), n.urnSource, n.nameSource",
                             [i["urn"] for i in chunk], param="urns",
                             timeout_ms=_READ_TIMEOUT_MS, read_only=True, on_result=collect,
                             at_floor=unread)
        for item in chunk:
            stale = held.get(item["urn"], set()) - keep - set(item["nativeProps"] or {})
            if prior is not None:
                stale &= prior.get(item["entityId"], set())
            item["gone"] = {k: None for k in stale}

    async def _run_edge_deletes(self, client, edge_deletes, progress=None) -> None:
        """Typed + endpoint-anchored deletes, each ``{eid, src, tgt, rel, slb, tlb}``: both ends
        seek their label's urn index, so no delete scans the graph's relationships (shared by
        the incremental apply and the tombstone sweep)."""
        del_by: Dict[Tuple[str, str, str], list] = {}
        for e in edge_deletes:
            key = (spelled_type(e.get("rel")), spelled_label(e.get("slb")),
                   spelled_label(e.get("tlb")))
            del_by.setdefault(key, []).append(
                {"eid": e["eid"], "pid": e["eid"].removeprefix("edge:"),
                 "src": e["src"], "tgt": e["tgt"]}
            )
        for (rel, sl, tl), items in del_by.items():
            await self._laddered(client, "edge_delete", _delete_edges_cypher(rel, sl, tl), items,
                                 progress=progress)


def make_falkor_graph_factory() -> Callable[..., object]:
    """Production ENV-instance client factory. ``provider_id`` is accepted (the factory
    contract is ``(name, provider_id=None)``) but ignored: every graph lands on the
    env-configured instance. For per-provider routing inject
    ``backend.app.providers.falkor_graph_registry.make_registry_graph_factory`` instead.

    Topology comes from the env instance's OWN config (``FALKORDB_MODE`` +
    ``FALKORDB_HOST`` / ``FALKORDB_PORT`` / ``FALKORDB_SENTINEL_*`` /
    ``FALKORDB_CLUSTER_NODES``), resolved through the shared topology-aware client
    cache — so an env-default graph on a Sentinel or Cluster instance is reached
    correctly (and re-resolves after a node rotation) instead of being hard-wired to a
    standalone pool.
    """
    from backend.app.providers.falkordb_connection import make_env_graph_factory

    return make_env_graph_factory()
