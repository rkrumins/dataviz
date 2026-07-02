"""Projection reconciler — validate the FalkorDB read cache against Postgres (the SoR).

Postgres (`graphver`) is the source of truth; FalkorDB is a **rebuildable read cache** of
committed ``main`` maintained by :class:`FalkorProjector`.  This module answers the operational
question the projector's inline verify (``_verify_and_heal``) only answers by *count*: **is ALL
of committed ``main`` actually present in the cache, entity-for-entity?**  It never composes the
whole graph in memory — every level streams in bounded batches (O(batch) memory, cooperative
async iteration), so it stays safe on a million-node graph:

1. **Counts** — the same live node/edge counts the projector's verify uses (shared helpers below,
   so the count SQL/cypher lives in exactly one place).
2. **Id-set diff** (always) — FULL coverage of ids: a sorted-merge of Postgres' live ``main``
   ``entity_heads`` against a FalkorDB scan, reporting entities missing from the cache (present in
   the SoR) and extra in the cache (absent from the SoR).  ``sample_limit`` bounds only the
   *reported* samples per bucket (``truncated`` flags when drift ran past it) — never the scan.
3. **Deep field check** (``deep=True``) — FULL scan, not a sample: for each streamed Postgres batch,
   batch-fetch the same nodes from FalkorDB by urn and compare ``entityId`` / ``displayName`` /
   ``entityType`` (label), reading each entity's head payload straight from the version row the
   ``entity_heads`` pointer names (NOT ``materialize_state``, which composes the entire graph).

Only committed ``main`` is projected (drafts overlay Postgres and are never cached), so reconcile
is a ``main``-only, non-fork concern — matching the projector's own count semantics.
"""
from __future__ import annotations

import logging
import time
from dataclasses import dataclass
from datetime import datetime, timezone
from typing import Any, AsyncIterator, Callable, Dict, List, Optional, Tuple

from sqlalchemy import func, select

from .models import (
    BranchORM,
    EntityHeadORM,
    GraphORM,
    NodeVersionORM,
    ProjectionStateORM,
)

# Reuse the reader/projector's label sanitiser so the deep check compares against the SAME
# label the projector wrote (``_sanitize_label(entityType)``), not the raw ontology type.
from backend.app.providers.falkordb_provider import _sanitize_label

logger = logging.getLogger(__name__)


# --------------------------------------------------------------------------- #
# Shared count helpers — the single home of the count SQL/cypher.              #
# ``FalkorProjector._pg_live_counts`` / ``_falkor_counts`` delegate here, so   #
# the reconciler and the projector's inline verify can never drift apart.      #
# --------------------------------------------------------------------------- #
async def pg_live_counts(session, graph_id: str, branch_id: str) -> Tuple[int, int]:
    """Live (non-tombstone) node/edge counts on *branch_id* from ``entity_heads`` —
    O(1)-ish via ``ix_heads_kind``. Returns ``(nodes, edges)``."""
    pg_nodes = (await session.execute(
        select(func.count()).select_from(EntityHeadORM).where(
            EntityHeadORM.graph_id == graph_id, EntityHeadORM.branch_id == branch_id,
            EntityHeadORM.entity_kind == "node", EntityHeadORM.is_tombstone.is_(False),
        ))).scalar_one()
    pg_edges = (await session.execute(
        select(func.count()).select_from(EntityHeadORM).where(
            EntityHeadORM.graph_id == graph_id, EntityHeadORM.branch_id == branch_id,
            EntityHeadORM.entity_kind == "edge", EntityHeadORM.is_tombstone.is_(False),
        ))).scalar_one()
    return int(pg_nodes), int(pg_edges)


async def falkor_counts(client) -> Tuple[int, int]:
    """Node/edge counts in a FalkorDB cache graph, excluding derived-cache artifacts.

    The ``:AGGREGATED`` rollup layer and its ``_GVRollupMeta`` marker are derived (aggregation
    worker + projector's incremental maintenance), NOT committed-main entities — exclude them or
    every graph with rollups reads as "extra entities vs committed main"."""
    fn = await client.query(
        "MATCH (n) WHERE NOT '_GVRollupMeta' IN labels(n) RETURN count(n) AS c")
    fe = await client.query(
        "MATCH ()-[r]->() WHERE type(r) <> 'AGGREGATED' RETURN count(r) AS c")
    return int(fn.result_set[0][0]), int(fe.result_set[0][0])


# --- Scan cypher (streamed via SKIP/LIMIT; see docstring on the pagination cost) --- #
# Ordered by the stable ``entityId`` / ``r.id`` so the Postgres keyset stream (also ordered by
# entity_id) and this scan sorted-merge without either side materialising. SKIP/LIMIT re-scans per
# page (O(n²/batch) total) — acceptable at current scale; upgrade to keyset if a graph outgrows it.
# The sorted-merge ASSUMES FalkorDB's string ``ORDER BY`` matches Postgres' ``COLLATE "C"`` (byte /
# code-point) order — true for the ASCII entity ids used in practice; non-ASCII ids whose two orders
# disagree could mis-align the merge and surface false missing/extra (re-run resolves nothing here —
# it needs a keyset upgrade with a shared collation if such ids are ever introduced).
_SCAN_NODES = ("MATCH (n) WHERE NOT '_GVRollupMeta' IN labels(n) "
               "RETURN n.entityId, n.urn ORDER BY n.entityId SKIP $s LIMIT $l")
_SCAN_EDGES = ("MATCH ()-[r]->() WHERE type(r) <> 'AGGREGATED' "
               "RETURN r.id ORDER BY r.id SKIP $s LIMIT $l")
_DEEP_FETCH = ("UNWIND $urns AS u MATCH (n {urn: u}) "
               "RETURN n.urn, n.entityId, n.displayName, labels(n)")

_PG_BATCH = 5000      # keyset page size for the Postgres entity_heads stream
_DEEP_BATCH = 500     # UNWIND fan-in per deep FalkorDB fetch


@dataclass
class DriftReport:
    graph_id: str
    falkor_graph_name: Optional[str]
    committed_seq: int
    projected_seq: int
    status: str
    fresh: bool
    pg_nodes: int
    pg_edges: int
    falkor_nodes: int
    falkor_edges: int
    missing_nodes: List[dict]                             # bounded samples {entityId, urn, displayName}
    extra_nodes: List[dict]                               # bounded samples {entityId, urn}
    missing_edges: List[str]                              # bounded entity-id samples
    extra_edges: List[str]                                # bounded entity-id samples
    mismatched: List[dict]                                # deep only: {entityId, field, pg, falkor}
    truncated: bool                                       # drift exceeded sample_limit somewhere
    in_sync: bool
    checked_at: str
    duration_ms: int
    skipped_reason: Optional[str] = None                 # "no projection target" | "projection in flight"


_SENTINEL = object()


async def _anext(aiter: AsyncIterator) -> Any:
    """``anext`` with a sentinel instead of ``StopAsyncIteration`` (3.9-safe)."""
    try:
        return await aiter.__anext__()
    except StopAsyncIteration:
        return _SENTINEL


async def _merge(pg_iter, fk_iter, pg_key, fk_key):
    """Sorted-merge two ascending streams keyed by the same (byte-ordered) id. Yields
    ``("missing", pg_item)`` for ids only in Postgres (present in the SoR, absent from the
    cache) and ``("extra", fk_item)`` for ids only in FalkorDB. O(1) state beyond the two
    look-ahead rows — the whole point is to never hold either side's id-set in memory."""
    pg = await _anext(pg_iter)
    fk = await _anext(fk_iter)
    while pg is not _SENTINEL and fk is not _SENTINEL:
        pk, fkk = pg_key(pg), fk_key(fk)
        if pk == fkk:
            pg = await _anext(pg_iter)
            fk = await _anext(fk_iter)
        elif pk < fkk:
            yield "missing", pg
            pg = await _anext(pg_iter)
        else:
            yield "extra", fk
            fk = await _anext(fk_iter)
    while pg is not _SENTINEL:
        yield "missing", pg
        pg = await _anext(pg_iter)
    while fk is not _SENTINEL:
        yield "extra", fk
        fk = await _anext(fk_iter)


class ProjectionReconciler:
    """Streams a full-coverage drift report of a graph's FalkorDB cache against Postgres.

    ``session_factory`` is the graphver session scope (``db.graphver_session``); ``client_factory``
    maps a FalkorDB graph name to a query client — the SAME factories the projector/read path use,
    so the reconciler reads exactly what the reader reads.
    """

    def __init__(self, session_factory, client_factory: Callable[[str], object]):
        self._session = session_factory
        self._client = client_factory

    async def reconcile(
        self, graph_id: str, *, deep: bool = False, sample_limit: int = 50
    ) -> DriftReport:
        started = time.monotonic()
        checked_at = datetime.now(timezone.utc).isoformat()

        # Watermark + PG-only counts first — cheap, and the guards below skip the FalkorDB scan
        # entirely when there is nothing to compare against.
        async with self._session() as s:
            graph = await s.get(GraphORM, graph_id)
            ps = await s.get(ProjectionStateORM, graph_id)
            main_id = await self._main_branch_id(s, graph_id) if graph is not None else None
            committed = graph.main_head_commit_seq if graph is not None else 0
            projected = ps.projected_commit_seq if ps is not None else 0
            status = ps.status if ps is not None else "idle"
            name = ps.falkor_graph_name if ps is not None else None
            pg_nodes, pg_edges = (
                await pg_live_counts(s, graph_id, main_id) if main_id is not None else (0, 0)
            )
        fresh = projected >= committed

        def _report(**kw) -> DriftReport:
            base = dict(
                graph_id=graph_id, falkor_graph_name=name, committed_seq=committed,
                projected_seq=projected, status=status, fresh=fresh,
                pg_nodes=pg_nodes, pg_edges=pg_edges,
                falkor_nodes=0, falkor_edges=0,
                missing_nodes=[], extra_nodes=[], missing_edges=[], extra_edges=[],
                mismatched=[], truncated=False, in_sync=False,
                checked_at=checked_at, duration_ms=int((time.monotonic() - started) * 1000),
                skipped_reason=None,
            )
            base.update(kw)
            return DriftReport(**base)

        # No REAL FalkorDB target (unpinned: NULL or the synthetic ``gv_<id>`` placeholder nothing
        # reads) — nothing is cached; reads fall back to Postgres. Report PG counts, skip the scan.
        if not name or name == f"gv_{graph_id}":
            return _report(skipped_reason="no projection target")
        # A projection/rebuild is actively catching the cache up — a scan now would flag transient
        # drift that the in-flight pass is about to resolve. Skip until it settles. This guard is
        # evaluated ONCE here, at reconcile start: a projection that begins mid-scan can still shift
        # the SKIP/LIMIT pages under us and surface transient false missing/extra — this is a
        # best-effort operator tool, so re-running the reconcile once the cache is fresh resolves it.
        if status in ("projecting", "rebuilding") and not fresh:
            return _report(skipped_reason="projection in flight")

        client = self._client(name)
        falkor_nodes, falkor_edges = await falkor_counts(client)

        missing_nodes, extra_nodes, trunc_n = await self._diff_nodes(
            client, graph_id, main_id, sample_limit)
        missing_edges, extra_edges, trunc_e = await self._diff_edges(
            client, graph_id, main_id, sample_limit)
        truncated = trunc_n or trunc_e

        mismatched: List[dict] = []
        if deep:
            mismatched, trunc_d = await self._deep_check(client, graph_id, main_id, sample_limit)
            truncated = truncated or trunc_d

        in_sync = (
            not missing_nodes and not extra_nodes and not missing_edges and not extra_edges
            and not mismatched and pg_nodes == falkor_nodes and pg_edges == falkor_edges
        )
        return _report(
            falkor_nodes=falkor_nodes, falkor_edges=falkor_edges,
            missing_nodes=missing_nodes, extra_nodes=extra_nodes,
            missing_edges=missing_edges, extra_edges=extra_edges,
            mismatched=mismatched, truncated=truncated, in_sync=in_sync,
        )

    # ------------------------------------------------------------------ #
    # Streams                                                            #
    # ------------------------------------------------------------------ #
    async def _main_branch_id(self, s, graph_id: str) -> Optional[str]:
        return (await s.execute(
            select(BranchORM.id).where(
                BranchORM.graph_id == graph_id, BranchORM.kind == "main")
        )).scalar_one_or_none()

    async def _stream_pg_nodes(self, graph_id: str, branch_id: str):
        """Ascending stream of live ``main`` nodes as ``{entityId, urn, entityType, displayName}``.

        Keyset-paginated on ``entity_id`` under ``COLLATE "C"`` (byte order) so the ordering
        matches FalkorDB's lexicographic scan for the sorted-merge. ``urn`` is the FalkorDB KEY:
        the committed urn, or the ``gv:<entity_id>`` fallback the projector keys manual nodes by.
        The head payload comes from the version row the ``entity_heads`` pointer names (join on
        ``head_version_id``) — never ``materialize_state``. O(batch) memory, short session per page."""
        cursor = ""
        while True:
            async with self._session() as s:
                rows = (await s.execute(
                    select(
                        EntityHeadORM.entity_id, NodeVersionORM.urn,
                        NodeVersionORM.entity_type, NodeVersionORM.display_name,
                    ).join(
                        NodeVersionORM,
                        (NodeVersionORM.graph_id == EntityHeadORM.graph_id)
                        & (NodeVersionORM.id == EntityHeadORM.head_version_id),
                    ).where(
                        EntityHeadORM.graph_id == graph_id,
                        EntityHeadORM.branch_id == branch_id,
                        EntityHeadORM.entity_kind == "node",
                        EntityHeadORM.is_tombstone.is_(False),
                        EntityHeadORM.entity_id.collate("C") > cursor,
                    ).order_by(EntityHeadORM.entity_id.collate("C")).limit(_PG_BATCH)
                )).all()
            for eid, urn, etype, dname in rows:
                yield {"entityId": eid, "urn": urn or f"gv:{eid}",
                       "entityType": etype, "displayName": dname}
            if len(rows) < _PG_BATCH:
                return
            cursor = rows[-1][0]

    async def _stream_pg_edge_ids(self, graph_id: str, branch_id: str):
        """Ascending (``COLLATE "C"``) stream of live ``main`` edge entity-ids — the FalkorDB
        edge key is ``r.id == entity_id``, so ids alone diff edges (no payload join needed)."""
        cursor = ""
        while True:
            async with self._session() as s:
                rows = (await s.execute(
                    select(EntityHeadORM.entity_id).where(
                        EntityHeadORM.graph_id == graph_id,
                        EntityHeadORM.branch_id == branch_id,
                        EntityHeadORM.entity_kind == "edge",
                        EntityHeadORM.is_tombstone.is_(False),
                        EntityHeadORM.entity_id.collate("C") > cursor,
                    ).order_by(EntityHeadORM.entity_id.collate("C")).limit(_PG_BATCH)
                )).scalars().all()
            for eid in rows:
                yield eid
            if len(rows) < _PG_BATCH:
                return
            cursor = rows[-1]

    async def _scan_falkor(self, client, cypher: str):
        """Ascending stream of a FalkorDB scan's rows via SKIP/LIMIT paging (O(batch) memory)."""
        skip = 0
        while True:
            res = await client.query(cypher, params={"s": skip, "l": _PG_BATCH})
            rows = getattr(res, "result_set", None) or []
            for row in rows:
                yield row
            if len(rows) < _PG_BATCH:
                return
            skip += _PG_BATCH

    # ------------------------------------------------------------------ #
    # Diff levels                                                        #
    # ------------------------------------------------------------------ #
    async def _diff_nodes(self, client, graph_id, branch_id, sample_limit):
        missing, extra = [], []
        truncated = False
        merge = _merge(
            self._stream_pg_nodes(graph_id, branch_id),
            self._scan_falkor(client, _SCAN_NODES),
            pg_key=lambda n: n["entityId"], fk_key=lambda r: r[0],
        )
        async for kind, item in merge:
            if kind == "missing":
                if len(missing) < sample_limit:
                    missing.append({"entityId": item["entityId"], "urn": item["urn"],
                                    "displayName": item["displayName"]})
                else:
                    truncated = True
            else:
                if len(extra) < sample_limit:
                    extra.append({"entityId": item[0], "urn": item[1]})
                else:
                    truncated = True
        return missing, extra, truncated

    async def _diff_edges(self, client, graph_id, branch_id, sample_limit):
        missing, extra = [], []
        truncated = False
        merge = _merge(
            self._stream_pg_edge_ids(graph_id, branch_id),
            self._scan_falkor(client, _SCAN_EDGES),
            pg_key=lambda e: e, fk_key=lambda r: r[0],
        )
        async for kind, item in merge:
            bucket = missing if kind == "missing" else extra
            eid = item if kind == "missing" else item[0]
            if len(bucket) < sample_limit:
                bucket.append(eid)
            else:
                truncated = True
        return missing, extra, truncated

    async def _deep_check(self, client, graph_id, branch_id, sample_limit):
        """Full field scan: ride the node stream, batch-fetch each batch's nodes from FalkorDB by
        urn, and compare ``entityId`` / ``displayName`` / ``entityType`` (label). A node absent from
        the cache is a *missing* (the id-diff owns it), not a mismatch, so it is skipped here."""
        mismatched: List[dict] = []
        truncated = False
        batch: List[dict] = []

        async def flush() -> bool:
            nonlocal truncated
            if not batch:
                return truncated
            res = await client.query(_DEEP_FETCH, params={"urns": [n["urn"] for n in batch]})
            fk_by_urn: Dict[str, tuple] = {}
            for urn, eid, dname, labels in (getattr(res, "result_set", None) or []):
                fk_by_urn[urn] = (eid, dname, list(labels or []))
            for n in batch:
                got = fk_by_urn.get(n["urn"])
                if got is None:
                    continue
                for fname, pg_val, fk_val in _field_mismatches(n, *got):
                    if len(mismatched) < sample_limit:
                        mismatched.append({"entityId": n["entityId"], "field": fname,
                                           "pg": pg_val, "falkor": fk_val})
                    else:
                        truncated = True
            batch.clear()
            return truncated

        async for node in self._stream_pg_nodes(graph_id, branch_id):
            batch.append(node)
            if len(batch) >= _DEEP_BATCH:
                await flush()
        await flush()
        return mismatched, truncated


def _field_mismatches(pg_node: dict, f_eid, f_dname, f_labels) -> List[tuple]:
    """The ``(field, pg_value, falkor_value)`` triples where a cached node disagrees with its
    Postgres head payload — comparing the SAME derivations the projector wrote (empty-string
    normalised ``displayName``; sanitised ``entityType`` label)."""
    out: List[tuple] = []
    if pg_node["entityId"] != f_eid:
        out.append(("entityId", pg_node["entityId"], f_eid))
    if (pg_node["displayName"] or "") != (f_dname or ""):
        out.append(("displayName", pg_node["displayName"], f_dname))
    pg_label = _sanitize_label(pg_node["entityType"] or "Entity")
    if pg_label not in f_labels:
        out.append(("entityType", pg_label, f_labels))
    return out
