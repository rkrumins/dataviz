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

First pass (`projected==0`) seeds the full live state (fork-aware copy-on-write
composition); later passes apply only the rows in `(projected, target]`.
"""
from __future__ import annotations

import asyncio
import json
import logging
from typing import Callable, Dict, List, Optional, Tuple

from sqlalchemy import func, select

from . import config, db
from .models import (
    EdgeVersionORM,
    EntityHeadORM,
    GraphORM,
    NodeVersionORM,
    ProjectionStateORM,
    _now,
)
from .service import GraphVersioningService, _is_edge_payload

# Reuse the existing reader's schema helpers verbatim so the projection is
# byte-for-byte reader-compatible (a reader schema change flows through here too).
from backend.app.providers.falkordb_provider import (  # noqa: E402
    _compute_searchable_text,
    _sanitize_label,
    _split_user_properties,
)

logger = logging.getLogger(__name__)

NodeUpsert = Tuple[str, str, dict]          # (entity_id, urn, payload)
EdgeUpsert = Tuple[str, str, str, dict]     # (entity_id, src_urn, tgt_urn, payload)


# --- Cypher (mirrors falkordb_provider.save_custom_graph; reader-compatible) --- #
def _node_merge_cypher(label: str) -> str:
    return (
        f"UNWIND $batch AS item MERGE (n:{label} {{urn: item.urn}}) "
        f"SET n.entityId = item.entityId, n.displayName = item.displayName, "
        f"n.qualifiedName = item.qualifiedName, n.description = item.description, "
        f"n.tags = item.tags, n.layerAssignment = item.layerAssignment, "
        f"n.childCount = item.childCount, n.sourceSystem = item.sourceSystem, "
        f"n.lastSyncedAt = item.lastSyncedAt, n.propertiesRaw = item.propertiesRaw, "
        f"n.searchableText = item.searchableText, n += item.nativeProps "
        f"REMOVE n.properties"
    )


def _edge_merge_cypher(rel_type: str) -> str:
    return (
        f"UNWIND $batch AS item MATCH (a {{urn: item.src}}) MATCH (b {{urn: item.tgt}}) "
        f"MERGE (a)-[r:{rel_type}]->(b) "
        f"SET r.id = item.eid, r.confidence = item.conf, r.properties = item.props"
    )


_DELETE_NODES = "UNWIND $urns AS u MATCH (n {urn: u}) DETACH DELETE n"
_DELETE_EDGES = "UNWIND $ids AS i MATCH ()-[r {id: i}]->() DELETE r"


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


def _node_item(entity_id: str, urn: str, payload: dict) -> dict:
    native, residual = _split_user_properties(payload.get("properties"))
    dn = payload.get("displayName") or ""
    qn = payload.get("qualifiedName") or ""
    desc = payload.get("description") or ""
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
        "searchableText": _compute_searchable_text(dn, qn, desc, native),
    }


def _edge_item(entity_id: str, src_urn: str, tgt_urn: str, payload: dict) -> dict:
    return {
        "src": src_urn,
        "tgt": tgt_urn,
        "eid": entity_id,
        "conf": payload.get("confidence"),
        "props": json.dumps(payload.get("properties") or {}),
    }


def _edge_endpoints(payload: dict) -> Tuple[str, str]:
    src = payload.get("sourceEntityId") or payload.get("source_entity_id") or ""
    tgt = payload.get("targetEntityId") or payload.get("target_entity_id") or ""
    return src, tgt


class FalkorProjector:
    """Projects committed `main` state of a graph into its FalkorDB graph."""

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
        # Fallback only — real graphs carry the data source's graph_name on
        # projection_state.falkor_graph_name (set at create time).
        return f"gv_{graph_id}"

    async def drop_graph(self, name: str) -> None:
        """``GRAPH.DELETE`` a cache graph's FalkorDB key, freeing its RAM; the next
        projection re-creates it from Postgres (plan §16.5 #9-10)."""
        await self._client(name).delete()

    async def project_graph(self, graph_id: str) -> Dict[str, object]:
        """Catch a graph's FalkorDB projection up to its target watermark."""
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
            ps.status = "projecting"
            main_id = await self._svc._main_branch_id(s, graph_id)
            is_fork = graph.fork_parent_graph_id is not None
            changes = await self._compute_changes(s, graph, main_id, from_seq, to_seq)

        client = self._client(name)
        try:
            if from_seq <= 0:
                # A full seed is a CLEAN REBUILD: drop any prior contents so the projected graph equals
                # committed main exactly. The seed only MERGEs the live state, so without this an entity
                # a merged draft DELETED (or stale rows on a just-re-pointed graph) would survive — the
                # reported "deletes still show on Main". FalkorDB is a rebuildable cache and reads fall
                # back to Postgres while projected < committed, so the brief empty window is never served.
                try:
                    await client.delete()
                except Exception:
                    pass                               # nonexistent graph (fresh) → MERGE will create it
            await self._apply(client, *changes)
        except Exception as exc:                       # pragma: no cover - infra
            logger.exception("projection apply failed for %s: %s", graph_id, exc)
            async with self._session() as s:
                ps = await s.get(ProjectionStateORM, graph_id)
                if ps is not None:
                    ps.status = "idle"
                    ps.last_error = str(exc)[:500]
            raise

        # Reconcile PG (SoR) vs FalkorDB (cache) and bounded-heal a dropped delta before
        # the watermark advances, so the cache can't silently diverge from committed main.
        verify_error = (
            await self._verify_and_heal(client, graph_id, main_id, from_seq, to_seq, is_fork)
            if config.PROJECTION_VERIFY_ENABLED else None
        )

        async with self._session() as s:
            ps = await s.get(ProjectionStateORM, graph_id)
            ps.projected_commit_seq = to_seq
            ps.status = "idle"
            ps.falkor_graph_name = name
            ps.last_projected_at = _now()
            ps.last_error = verify_error

        applied = sum(len(c) for c in changes)
        return {"projected": to_seq, "applied": applied, "noop": False, "verify_error": verify_error}

    async def project_pending(
        self, limit: int = 100, concurrency: Optional[int] = None
    ) -> List[Dict[str, object]]:
        """Catch up every graph whose projection lags (`projected < target`), STALEST first,
        with bounded concurrency so the reconciling loop keeps up across 100s of graphs
        (the serial version made a full pass cost the SUM of per-graph times). The select is
        keyed by ``graph_id`` (PK) so each id appears once per pass — no same-graph race; a
        per-graph failure is logged and does not abort the batch."""
        async with self._session() as s:
            ids = (await s.execute(
                select(ProjectionStateORM.graph_id).where(
                    ProjectionStateORM.projected_commit_seq < ProjectionStateORM.target_commit_seq
                ).order_by(
                    (ProjectionStateORM.target_commit_seq
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

    async def _compute_changes(
        self, s, graph: GraphORM, main_id: str, from_seq: int, to_seq: int
    ) -> Tuple[List[NodeUpsert], List[EdgeUpsert], List[str], List[str]]:
        node_upserts: List[NodeUpsert] = []
        edge_upserts: List[EdgeUpsert] = []
        node_deletes: List[str] = []      # urns
        edge_deletes: List[str] = []      # entity_ids
        urn_of: Dict[str, str] = {}

        if from_seq <= 0:
            # Seed: the full live state (fork-aware copy-on-write composition).
            state = await self._svc._state_as_of(s, graph.id, main_id, to_seq)
            for eid, p in state.items():
                if p is None or _is_edge_payload(p):
                    continue
                urn = _node_urn(eid, p)
                urn_of[eid] = urn
                node_upserts.append((eid, urn, p))
            for eid, p in state.items():
                if p is None or not _is_edge_payload(p):
                    continue
                src, tgt = _edge_endpoints(p)
                su = urn_of.get(src) or await self._urn_for(s, graph, main_id, src)
                tu = urn_of.get(tgt) or await self._urn_for(s, graph, main_id, tgt)
                edge_upserts.append((eid, su, tu, p))
            return node_upserts, edge_upserts, node_deletes, edge_deletes

        # Incremental: net of each entity's rows in (from_seq, to_seq]. Key the fold by
        # (kind, entity_id) — NOT entity_id alone — so a node and an edge that ever share
        # an entity_id can never overwrite each other (which would silently drop a node
        # delete/upsert by mis-handling it as an edge).
        last: Dict[Tuple[str, str], Tuple[str, str, Optional[dict]]] = {}
        for model, kind in ((NodeVersionORM, "node"), (EdgeVersionORM, "edge")):
            rows = (await s.execute(
                select(model).where(
                    model.graph_id == graph.id, model.branch_id == main_id,
                    model.commit_seq > from_seq, model.commit_seq <= to_seq,
                ).order_by(model.commit_seq, model.created_at)
            )).scalars().all()
            for r in rows:
                last[(kind, r.entity_id)] = (kind, r.op, r.payload)
        for (kind, eid), (_, op, p) in last.items():
            if kind != "node":
                continue
            if op == "delete":
                node_deletes.append(await self._urn_for(s, graph, main_id, eid))
            else:
                urn = _node_urn(eid, p)
                urn_of[eid] = urn
                node_upserts.append((eid, urn, p))
        for (kind, eid), (_, op, p) in last.items():
            if kind != "edge":
                continue
            if op == "delete":
                edge_deletes.append(eid)
            else:
                src, tgt = _edge_endpoints(p)
                su = urn_of.get(src) or await self._urn_for(s, graph, main_id, src)
                tu = urn_of.get(tgt) or await self._urn_for(s, graph, main_id, tgt)
                edge_upserts.append((eid, su, tu, p))
        return node_upserts, edge_upserts, node_deletes, edge_deletes

    async def _urn_for(self, s, graph: GraphORM, main_id: str, entity_id: str) -> str:
        """Latest non-null urn for an entity on `main` (fork-aware), else gv:<eid>."""
        row = (await s.execute(
            select(NodeVersionORM.urn).where(
                NodeVersionORM.graph_id == graph.id, NodeVersionORM.branch_id == main_id,
                NodeVersionORM.entity_id == entity_id, NodeVersionORM.urn.is_not(None),
            ).order_by(NodeVersionORM.commit_seq.desc()).limit(1)
        )).scalar_one_or_none()
        if row:
            return str(row)
        if graph.fork_parent_graph_id:
            parent = await s.get(GraphORM, graph.fork_parent_graph_id)
            if parent is not None:
                pmain = await self._svc._main_branch_id(s, parent.id)
                return await self._urn_for(s, parent, pmain, entity_id)
        logger.warning("projection: no urn for node entity %s on %s; keying as gv:<entity_id>",
                       entity_id, graph.id)
        return f"gv:{entity_id}"

    async def _pg_live_counts(self, graph_id, main_id, to_seq, is_fork):
        """Live (non-tombstone) node/edge counts on ``main`` from ``entity_heads`` —
        O(1)-ish via ``ix_heads_kind``. Returns ``(nodes, edges)`` only for a NON-fork
        main that is fully caught up (``main_head == to_seq``); ``None`` otherwise
        (a fork's composed count is O(graph); a lagging head verifies on catch-up)."""
        if is_fork:
            return None
        async with self._session() as s:
            graph = await s.get(GraphORM, graph_id)
            if graph is None or graph.main_head_commit_seq != to_seq:
                return None
            pg_nodes = (await s.execute(
                select(func.count()).select_from(EntityHeadORM).where(
                    EntityHeadORM.graph_id == graph_id, EntityHeadORM.branch_id == main_id,
                    EntityHeadORM.entity_kind == "node", EntityHeadORM.is_tombstone.is_(False),
                ))).scalar_one()
            pg_edges = (await s.execute(
                select(func.count()).select_from(EntityHeadORM).where(
                    EntityHeadORM.graph_id == graph_id, EntityHeadORM.branch_id == main_id,
                    EntityHeadORM.entity_kind == "edge", EntityHeadORM.is_tombstone.is_(False),
                ))).scalar_one()
        return int(pg_nodes), int(pg_edges)

    @staticmethod
    async def _falkor_counts(client):
        fn = await client.query("MATCH (n) RETURN count(n) AS c")
        fe = await client.query("MATCH ()-[r]->() RETURN count(r) AS c")
        return int(fn.result_set[0][0]), int(fe.result_set[0][0])

    async def _verify_and_heal(
        self, client, graph_id, main_id, from_seq, to_seq, is_fork
    ) -> Optional[str]:
        """Reconcile live node/edge COUNTS between Postgres (SoR) and FalkorDB after an
        apply. Best-effort (any count failure → skip). Two mismatch directions:

        * FalkorDB has FEWER than committed main (a dropped delta): bounded-heal by
          reseeding the graph from Postgres ONCE (idempotent MERGE/DELETE).
        * FalkorDB has MORE than committed main (un-imported legacy/aggregation nodes —
          the subset invariant is broken): DO NOT auto-delete (that would wipe
          un-versioned data); record the discrepancy so enablement/bootstrap reconciles.

        Returns an error string (recorded on ``projection_state.last_error``) or ``None``."""
        try:
            pg = await self._pg_live_counts(graph_id, main_id, to_seq, is_fork)
            if pg is None:
                return None                              # fork / lagging head — not applicable
            fk = await self._falkor_counts(client)
        except Exception:
            logger.debug("projection verify skipped for %s (count failed)", graph_id, exc_info=True)
            return None
        if pg == fk:
            return None
        pg_n, pg_e = pg
        f_n, f_e = fk
        if f_n > pg_n or f_e > pg_e:
            msg = (f"FalkorDB has extra entities vs committed main "
                   f"(PG n={pg_n},e={pg_e}; Falkor n={f_n},e={f_e}) — "
                   f"run versioning enablement/bootstrap to import them")
            logger.error("%s for %s", msg, graph_id)
            return msg
        if from_seq > 0:                                 # missing committed data → reseed once
            logger.warning("projection verify mismatch for %s (PG n=%d,e=%d > Falkor n=%d,e=%d); "
                           "reseeding from Postgres (bounded heal)", graph_id, pg_n, pg_e, f_n, f_e)
            try:
                async with self._session() as s:
                    graph = await s.get(GraphORM, graph_id)
                    seed = await self._compute_changes(s, graph, main_id, 0, to_seq)
                try:
                    await client.delete()
                except Exception:
                    pass
                await self._apply(client, *seed)
                pg2 = await self._pg_live_counts(graph_id, main_id, to_seq, is_fork)
                fk2 = await self._falkor_counts(client)
                if pg2 is None or pg2 == fk2:
                    return None
            except Exception:
                logger.exception("projection heal reseed failed for %s", graph_id)
                return f"projection heal reseed failed at seq {to_seq}"
        msg = f"projection verify mismatch at seq {to_seq} after heal (committed != FalkorDB)"
        logger.error("%s for %s", msg, graph_id)
        return msg

    async def _apply(self, client, node_upserts, edge_upserts, node_deletes, edge_deletes) -> None:
        # Nodes in (grouped by label), edges in (grouped by type), edges out, nodes out.
        by_label: Dict[str, list] = {}
        for eid, urn, p in node_upserts:
            by_label.setdefault(_sanitize_label(p.get("entityType") or "Entity"), []).append(
                _node_item(eid, urn, p)
            )
        for label, items in by_label.items():
            for chunk in _batches(items, self._batch):
                await client.query(_node_merge_cypher(label), params={"batch": chunk})

        by_rel: Dict[str, list] = {}
        for eid, su, tu, p in edge_upserts:
            by_rel.setdefault(_sanitize_label(p.get("edgeType") or "REL"), []).append(
                _edge_item(eid, su, tu, p)
            )
        for rel, items in by_rel.items():
            for chunk in _batches(items, self._batch):
                await client.query(_edge_merge_cypher(rel), params={"batch": chunk})

        for chunk in _batches(edge_deletes, self._batch):
            await client.query(_DELETE_EDGES, params={"ids": list(chunk)})
        for chunk in _batches(node_deletes, self._batch):
            await client.query(_DELETE_NODES, params={"urns": list(chunk)})


def make_falkor_graph_factory() -> Callable[[str], object]:
    """Production client factory — one async FalkorDB handle, a graph per name.

    Config: ``FALKORDB_HOST`` / ``FALKORDB_PORT`` / ``FALKORDB_POOL_SIZE``.
    """
    from redis.asyncio import ConnectionPool          # pragma: no cover - infra
    from falkordb.asyncio import FalkorDB              # pragma: no cover - infra
    import os

    pool = ConnectionPool(
        host=os.getenv("FALKORDB_HOST", "localhost"),
        port=int(os.getenv("FALKORDB_PORT", "6379")),
        max_connections=int(os.getenv("FALKORDB_POOL_SIZE", "10")),
    )
    handle = FalkorDB(connection_pool=pool)
    return lambda name: handle.select_graph(name)
