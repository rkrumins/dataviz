"""FalkorDB projection worker — derives the hot read graph from the durable
``graphver`` store (plan §5, §16.5 #9).

Postgres is the source of truth; FalkorDB is a **rebuildable** read cache.  The
worker advances each graph's ``projection_state`` watermark
(``projected_commit_seq`` → ``target_commit_seq``) by applying the committed
``main`` deltas to FalkorDB.

Two invariants make it safe to run unattended:

* **Idempotent apply.** Every write is a ``MERGE`` (upsert) or ``DELETE``, so a
  crashed/retried projection converges — re-applying a window is a no-op.
* **Watermark after apply.** ``projected_commit_seq`` only advances *after* the
  batch lands in FalkorDB, in a separate transaction.  A crash mid-apply leaves
  the watermark behind, and the next pass re-applies the same (idempotent) window
  — bounded staleness, never corruption.

Seeding vs incremental:

* First pass (``projected==0``) seeds the graph's **full** live state — which for
  a fork is its copy-on-write composition (parent@fork_base + divergence).
* Later passes apply only the rows in ``(projected, target]`` (a fork's own
  divergence; a fork's view is frozen against its parent until it merges).

The FalkorDB client is injected (``graph_client_factory(name) -> client`` with an
async ``query(cypher, params)``).  :func:`make_falkor_graph_factory` builds the
production one from the same async client the rest of the app uses
(``falkordb.asyncio``); tests inject a fake.
"""
from __future__ import annotations

import json
import logging
import os
from typing import Callable, Dict, List, Optional, Tuple

from sqlalchemy import select

from . import config, db
from .models import (
    EdgeVersionORM,
    GraphORM,
    NodeVersionORM,
    ProjectionStateORM,
    _now,
)
from .service import GraphVersioningService, _is_edge_payload

logger = logging.getLogger(__name__)

# Cypher (idempotent). One label/type keeps the projection generic; the stable
# entity_id lives in ``eid`` and every payload field becomes a property.
_UPSERT_NODES = "UNWIND $rows AS r MERGE (n:Entity {eid: r.eid}) SET n += r.props"
_UPSERT_EDGES = (
    "UNWIND $rows AS r MATCH (a:Entity {eid: r.src}), (b:Entity {eid: r.tgt}) "
    "MERGE (a)-[e:REL {eid: r.eid}]->(b) SET e += r.props"
)
_DELETE_EDGES = "UNWIND $ids AS x MATCH ()-[e:REL {eid: x}]->() DELETE e"
_DELETE_NODES = "UNWIND $ids AS x MATCH (n:Entity {eid: x}) DETACH DELETE n"

Upsert = Tuple[str, dict]            # (entity_id, payload)


def _batches(seq, n):
    for i in range(0, len(seq), n):
        yield seq[i:i + n]


def _falkor_props(payload: Optional[dict], *, drop: Tuple[str, ...] = ()) -> dict:
    """Coerce a payload into FalkorDB-safe properties.

    FalkorDB properties must be primitives or arrays of primitives; nested
    objects/arrays are JSON-encoded (the full doc still lives in Postgres)."""
    out: dict = {}
    for k, v in (payload or {}).items():
        if k in drop:
            continue
        if v is None or isinstance(v, (str, int, float, bool)):
            out[k] = v
        elif isinstance(v, list) and all(isinstance(x, (str, int, float, bool)) for x in v):
            out[k] = list(v)
        else:
            out[k] = json.dumps(v, sort_keys=True)
    return out


def _edge_endpoints(payload: dict) -> Tuple[str, str]:
    src = payload.get("sourceEntityId") or payload.get("source_entity_id") or ""
    tgt = payload.get("targetEntityId") or payload.get("target_entity_id") or ""
    return src, tgt


class FalkorProjector:
    """Projects committed ``main`` state of a graph into its FalkorDB graph."""

    def __init__(
        self,
        graph_client_factory: Callable[[str], object],
        session_factory=db.graphver_session,
        batch_size: Optional[int] = None,
    ):
        self._client = graph_client_factory
        self._session = session_factory
        self._svc = GraphVersioningService(session_factory)
        self._batch = batch_size or config.PROJECTION_BATCH_SIZE

    @staticmethod
    def default_graph_name(graph_id: str) -> str:
        return f"gv_{graph_id}"

    async def project_graph(self, graph_id: str) -> Dict[str, object]:
        """Catch a graph's FalkorDB projection up to its target watermark.

        Returns ``{projected, applied, noop}``.  Idempotent; safe to call
        repeatedly (e.g. from a poll loop or a commit/publish hook)."""
        # 1. Read the watermark + compute the delta window (one read txn).
        async with self._session() as s:
            ps = await s.get(ProjectionStateORM, graph_id)
            if ps is None:
                raise ValueError(f"no projection_state for graph {graph_id}")
            graph = await s.get(GraphORM, graph_id)
            if graph is None:
                raise ValueError(f"unknown graph {graph_id}")
            from_seq, to_seq = ps.projected_commit_seq, ps.target_commit_seq
            name = ps.falkor_graph_name or self.default_graph_name(graph_id)
            if from_seq >= to_seq:
                return {"projected": from_seq, "applied": 0, "noop": True}
            main_id = await self._svc._main_branch_id(s, graph_id)
            up_nodes, up_edges, del_nodes, del_edges = await self._compute_changes(
                s, graph, main_id, from_seq, to_seq
            )

        # 2. Apply to FalkorDB outside the txn (network); idempotent.
        client = self._client(name)
        try:
            await self._apply(client, up_nodes, up_edges, del_nodes, del_edges)
        except Exception as exc:                       # pragma: no cover - infra
            logger.exception("projection apply failed for %s: %s", graph_id, exc)
            async with self._session() as s:
                ps = await s.get(ProjectionStateORM, graph_id)
                if ps is not None:
                    ps.status = "idle"
                    ps.last_error = str(exc)[:500]
            raise

        # 3. Advance the watermark only after the batch landed (separate txn).
        async with self._session() as s:
            ps = await s.get(ProjectionStateORM, graph_id)
            ps.projected_commit_seq = to_seq
            ps.status = "idle"
            ps.falkor_graph_name = name
            ps.last_projected_at = _now()
            ps.last_error = None

        applied = len(up_nodes) + len(up_edges) + len(del_nodes) + len(del_edges)
        return {"projected": to_seq, "applied": applied, "noop": False}

    async def project_pending(self, limit: int = 100) -> List[Dict[str, object]]:
        """Catch up every graph whose projection lags (``projected < target``)."""
        async with self._session() as s:
            ids = (await s.execute(
                select(ProjectionStateORM.graph_id).where(
                    ProjectionStateORM.projected_commit_seq < ProjectionStateORM.target_commit_seq
                ).limit(limit)
            )).scalars().all()
        return [await self.project_graph(gid) for gid in ids]

    async def _compute_changes(
        self, s, graph: GraphORM, main_id: str, from_seq: int, to_seq: int
    ) -> Tuple[List[Upsert], List[Upsert], List[str], List[str]]:
        up_nodes: List[Upsert] = []
        up_edges: List[Upsert] = []
        del_nodes: List[str] = []
        del_edges: List[str] = []

        if from_seq <= 0:
            # Seed: the full live state (fork-aware copy-on-write composition).
            state = await self._svc._state_as_of(s, graph.id, main_id, to_seq)
            for eid, payload in state.items():
                if payload is None:
                    continue
                (up_edges if _is_edge_payload(payload) else up_nodes).append((eid, payload))
            return up_nodes, up_edges, del_nodes, del_edges

        # Incremental: net of each entity's rows in (from_seq, to_seq], kind from table.
        last: Dict[str, Tuple[str, str, Optional[dict]]] = {}
        for model, kind in ((NodeVersionORM, "node"), (EdgeVersionORM, "edge")):
            rows = (await s.execute(
                select(model).where(
                    model.graph_id == graph.id, model.branch_id == main_id,
                    model.commit_seq > from_seq, model.commit_seq <= to_seq,
                ).order_by(model.commit_seq, model.created_at)
            )).scalars().all()
            for r in rows:
                last[r.entity_id] = (kind, r.op, r.payload)
        for eid, (kind, op, payload) in last.items():
            if op == "delete":
                (del_edges if kind == "edge" else del_nodes).append(eid)
            else:
                (up_edges if kind == "edge" else up_nodes).append((eid, payload))
        return up_nodes, up_edges, del_nodes, del_edges

    async def _apply(self, client, up_nodes, up_edges, del_nodes, del_edges) -> None:
        # Order matters for convergence: nodes in, edges in, edges out, nodes out.
        for chunk in _batches(up_nodes, self._batch):
            await client.query(_UPSERT_NODES, params={
                "rows": [{"eid": eid, "props": _falkor_props(p)} for eid, p in chunk],
            })
        for chunk in _batches(up_edges, self._batch):
            rows = []
            for eid, p in chunk:
                src, tgt = _edge_endpoints(p)
                rows.append({"eid": eid, "src": src, "tgt": tgt,
                             "props": _falkor_props(p, drop=(
                                 "sourceEntityId", "source_entity_id",
                                 "targetEntityId", "target_entity_id"))})
            await client.query(_UPSERT_EDGES, params={"rows": rows})
        for chunk in _batches(del_edges, self._batch):
            await client.query(_DELETE_EDGES, params={"ids": list(chunk)})
        for chunk in _batches(del_nodes, self._batch):
            await client.query(_DELETE_NODES, params={"ids": list(chunk)})


def make_falkor_graph_factory() -> Callable[[str], object]:
    """Production client factory — one async FalkorDB handle, a graph per name.

    Mirrors the app's FalkorDB access (``falkordb.asyncio`` over a redis pool).
    Config: ``FALKORDB_HOST`` / ``FALKORDB_PORT`` / ``FALKORDB_POOL_SIZE``.
    """
    from redis.asyncio import ConnectionPool          # pragma: no cover - infra
    from falkordb.asyncio import FalkorDB              # pragma: no cover - infra

    pool = ConnectionPool(
        host=os.getenv("FALKORDB_HOST", "localhost"),
        port=int(os.getenv("FALKORDB_PORT", "6379")),
        max_connections=int(os.getenv("FALKORDB_POOL_SIZE", "10")),
    )
    handle = FalkorDB(connection_pool=pool)
    return lambda name: handle.select_graph(name)
