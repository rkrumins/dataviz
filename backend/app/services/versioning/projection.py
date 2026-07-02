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
from typing import Awaitable, Callable, Dict, List, Optional, Tuple

from sqlalchemy import literal, select

from . import config, db
from .reconcile import falkor_counts, pg_live_counts
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
# Heal-path sweep: match the deleted node by its committed urn (the indexed key, so this stays
# fast on a million-node graph) and confirm entityId, so a live entity that reused the urn is
# never deleted by mistake.
_DELETE_NODES_BY_PAIR = (
    "UNWIND $pairs AS p MATCH (n {urn: p.urn}) WHERE n.entityId = p.eid DETACH DELETE n"
)


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
            from_seq, to_seq = ps.projected_commit_seq, ps.target_commit_seq
            name = ps.falkor_graph_name or self.default_graph_name(graph_id)
            if from_seq >= to_seq:
                return {"projected": from_seq, "applied": 0, "noop": True}
            if name == self.default_graph_name(graph_id):
                # No REAL FalkorDB target (a test-created graph, or one whose data source the
                # resolver couldn't heal): nothing ever reads a synthetic ``gv_<id>`` key, and even
                # an empty GRAPH.QUERY would instantiate it — so projecting only leaks orphan
                # FalkorDB graphs. Skip without advancing the watermark: reads keep falling back to
                # Postgres (the SoR), and a later repin (``ensure_projection_target``) re-enters the
                # normal path. ``project_pending`` applies the same filter in SQL so the poll loop
                # doesn't churn on these rows; this guard covers direct nudges.
                return {"projected": from_seq, "applied": 0, "noop": True, "skipped": "unpinned"}
            ps.status = "projecting"
            main_id = await self._svc._main_branch_id(s, graph_id)
            is_fork = graph.fork_parent_graph_id is not None
            changes = await self._compute_changes(s, graph, main_id, from_seq, to_seq)
            # Incremental :AGGREGATED rollup maintenance (windows only — a full seed wipes
            # rollups with the graph and is healed by the on_rollups_stale hook instead).
            # Skipped for forks: their containment chains span the parent graph's rows, so
            # incremental chains would under-roll; a fork's rollups come from full rebuilds.
            # A failure here must NEVER wedge raw-edge projection — degrade to the rebuild.
            rollup_pairs = None
            if from_seq > 0 and not is_fork and self._edge_types_resolver is not None:
                try:
                    rollup_pairs = await self._compute_rollup_deltas(
                        s, graph, main_id, from_seq, to_seq)
                except Exception:                        # pragma: no cover - defensive
                    logger.exception("rollup delta computation failed for %s — queuing rebuild",
                                     graph_id)
                    rollup_pairs = "stale"

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
                except Exception as exc:
                    # FalkorDB raises "Invalid graph operation on empty key" when the graph key does
                    # not exist yet — the expected, benign case for a fresh graph's first projection
                    # (the MERGE below creates it). Anything ELSE means the graph DID exist and the
                    # wipe genuinely failed, so the MERGE-only apply runs on top of stale contents and
                    # a merged draft's DELETES would survive ("merge reverts to old state"). Keep those
                    # two distinct so a real wipe failure isn't lost in fresh-graph noise.
                    if "empty key" in str(exc).lower():
                        logger.debug("full-seed wipe: FalkorDB graph %r for %s did not exist yet "
                                     "(fresh); MERGE will create it", name, graph_id)
                    else:
                        logger.warning(
                            "full-seed wipe of FalkorDB graph %r for %s FAILED on an existing graph; "
                            "proceeding to MERGE — prior deletions may not have cleared: %s",
                            name, graph_id, exc,
                        )
            await self._apply(client, *changes)
            if rollup_pairs and rollup_pairs != "stale":
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
        verify_error, heal_reseeded = (
            await self._verify_and_heal(client, graph_id, main_id, from_seq, to_seq, is_fork)
            if config.PROJECTION_VERIFY_ENABLED else (None, False)
        )

        async with self._session() as s:
            ps = await s.get(ProjectionStateORM, graph_id)
            ps.projected_commit_seq = to_seq
            ps.status = "idle"
            ps.falkor_graph_name = name
            ps.last_projected_at = _now()
            ps.last_error = verify_error

        if orphan:                                     # the old gv_* graph is now unread — reclaim its RAM
            try:
                await self.drop_graph(orphan)
            except Exception as exc:                   # pragma: no cover - infra
                logger.warning("could not drop orphan projection graph %s: %s", orphan, exc)

        # Rollups can't be maintained incrementally past this projection: a full seed (or the
        # verify-heal reseed) WIPED them with the graph, or a containment move / bulk window /
        # overlapping application exceeded what incremental maintenance can reconcile. Hand
        # off to the app layer to queue a scoped aggregation rebuild (fires after the
        # watermark is durable, so the rebuild sees the projected raw edges).
        if self._on_rollups_stale is not None and (
                from_seq <= 0 or rollup_pairs == "stale" or heal_reseeded):
            try:
                await self._on_rollups_stale(graph_id)
            except Exception as exc:                   # pragma: no cover - infra
                logger.warning("rollup-rebuild hook failed for %s: %s", graph_id, exc)

        # Committed main just landed in the real FalkorDB graph — let the
        # app layer nudge the insights counts poll (after the watermark is
        # durable, so the poll observes the projected state).
        if self._on_projected is not None and data_source_id:
            try:
                await self._on_projected(data_source_id)
            except Exception as exc:                   # pragma: no cover - infra
                logger.warning("on_projected hook failed for %s: %s", graph_id, exc)

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
                    ProjectionStateORM.projected_commit_seq < ProjectionStateORM.target_commit_seq,
                    # Unpinned graphs (no real FalkorDB target — falkor_graph_name NULL or the
                    # synthetic gv_<id> fallback) are never projected: nothing reads those keys.
                    # Filtered here in SQL so hundreds of test-created graphs can't crowd out
                    # (limit) or churn the poll loop; project_graph re-checks for direct nudges.
                    ProjectionStateORM.falkor_graph_name.isnot(None),
                    ProjectionStateORM.falkor_graph_name
                    != literal("gv_").concat(ProjectionStateORM.graph_id),
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

    # Bounded-recount cap for containment moves: above this many affected entities/edges the
    # move can't be maintained incrementally — the on_rollups_stale hook queues a rebuild.
    _MOVE_EDGE_CAP = 1000

    async def _compute_rollup_deltas(self, s, graph, main_id, from_seq, to_seq):
        """Net ``:AGGREGATED`` rollup adjustments implied by this window's committed changes:
        +1 over the ancestor-pair product for each created lineage edge (post-window chains),
        -1 for each deleted one (pre-window chains), and a bounded recount for lineage edges
        under containers that were MOVED in the window. O(window delta × chain depth²).

        Returns ``{(src_urn, tgt_urn): {"dw": int, "types": set}}``, ``None`` when nothing
        rollup-affecting changed, or the sentinel ``"stale"`` when a move exceeded the cap."""
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

        def _etype(p) -> str:
            return str((p or {}).get("edgeType") or "").upper()

        rows = (await s.execute(
            select(EdgeVersionORM.entity_id, EdgeVersionORM.op, EdgeVersionORM.payload)
            .where(EdgeVersionORM.graph_id == graph.id, EdgeVersionORM.branch_id == main_id,
                   EdgeVersionORM.commit_seq > from_seq, EdgeVersionORM.commit_seq <= to_seq)
            .order_by(EdgeVersionORM.commit_seq)
        )).all()
        if not rows:
            return None
        final: Dict[str, Optional[dict]] = {}
        for eid, op, payload in rows:                    # last row in window wins
            final[eid] = None if op == "delete" else payload
        # Net contribution per touched edge = its value BEFORE the window vs AFTER it.
        # Op labels alone lose real cases the worker batches into one window: create+update
        # (last op 'update' would hide the +1), delete+revert-recreate (spurious +1 for an
        # edge that never stopped being live), and endpoint/type rewrites via update.
        before = await self._svc._values_at(s, graph.id, main_id, list(final), from_seq)

        def _sig(p: Optional[dict]):
            return None if not p else (*_edge_endpoints(p), _etype(p))

        lineage_creates: Dict[str, dict] = {}
        lineage_deletes: Dict[str, dict] = {}
        moved: set = set()
        for eid, new in final.items():
            old = before.get(eid)
            if _sig(old) == _sig(new):
                continue                                 # payload-only change — no rollup impact
            if old is not None:
                et = _etype(old)
                if et in lineage_types:
                    lineage_deletes[eid] = old
                elif et in cont_types:
                    moved.add(_edge_endpoints(old)[1])
            if new is not None:
                et = _etype(new)
                if et in lineage_types:
                    lineage_creates[eid] = new
                elif et in cont_types:
                    moved.add(_edge_endpoints(new)[1])
        moved.discard("")
        if len(lineage_creates) + len(lineage_deletes) > self._MOVE_EDGE_CAP:
            # A bulk-sized window (import/sync commit) is the aggregation JOB's territory —
            # doing the pair math inline would stall the projector. Hand off to the rebuild.
            return "stale"
        if not lineage_creates and not lineage_deletes and not moved:
            return None

        anc_cache: Dict[Tuple[str, Optional[int]], List[str]] = {}

        async def chain(node_id: str, as_of: Optional[int]) -> List[str]:
            key = (node_id, as_of)
            if key not in anc_cache:
                seen, _e = await self._svc._containment_ancestors(
                    s, graph.id, main_id, {node_id}, cont_types, as_of)
                anc_cache[key] = list(seen)              # ancestors-or-self
            return anc_cache[key]

        pairs: Dict[Tuple[str, str], Dict[str, object]] = {}

        async def contribute(p: dict, sign: int, as_of: Optional[int]) -> None:
            src, tgt = _edge_endpoints(p)
            if not src or not tgt:
                return
            et = _etype(p)
            for sx in await chain(src, as_of):
                for tx in await chain(tgt, as_of):
                    if sx == tx:
                        continue
                    e = pairs.setdefault((sx, tx), {"dw": 0, "types": set()})
                    e["dw"] += sign
                    if sign > 0 and et:
                        e["types"].add(et)

        handled = set()
        for eid, p in lineage_creates.items():
            await contribute(p, +1, to_seq)
            handled.add(eid)
        for eid, p in lineage_deletes.items():
            await contribute(p, -1, from_seq)
            handled.add(eid)

        if moved:
            # Moved subtrees: every lineage edge under them changes rollup pairs. Remove the
            # pre-window contribution, add the post-window one — bounded by _MOVE_EDGE_CAP.
            subtree = await self._svc._containment_descendants(
                s, graph.id, main_id, set(moved), cont_types, to_seq, cap=self._MOVE_EDGE_CAP + 1)
            if len(subtree) > self._MOVE_EDGE_CAP:
                return "stale"
            # as-of to_seq (not head): a commit landing after this window must not leak in.
            inc = await self._svc._incident_live_edges(s, graph.id, main_id, subtree, to_seq)
            moved_edges = {eid: p for eid, p in inc.items()
                           if eid not in handled and _etype(p) in lineage_types}
            if len(moved_edges) > self._MOVE_EDGE_CAP:
                return "stale"
            for eid, p in moved_edges.items():
                await contribute(p, -1, from_seq)
                await contribute(p, +1, to_seq)

        pairs = {k: v for k, v in pairs.items() if v["dw"] != 0}
        if not pairs:
            return None
        # FalkorDB keys nodes by urn; versioned entity ids usually ARE urns, but imported
        # entities may differ — resolve through the entities' payloads, with the SAME
        # gv:<id> fallback the raw projection uses (_node_urn) so the MATCH always hits.
        ids = {i for k in pairs for i in k}
        vals = await self._svc._values_at(s, graph.id, main_id, ids, to_seq)
        urn_of = {i: ((vals.get(i) or {}).get("urn") or f"gv:{i}") for i in ids}
        out: Dict[Tuple[str, str], Dict[str, object]] = {}
        for (sx, tx), v in pairs.items():                # distinct ids can share a urn — SUM, don't overwrite
            e = out.setdefault((urn_of[sx], urn_of[tx]), {"dw": 0, "types": set()})
            e["dw"] += v["dw"]
            e["types"] |= v["types"]
        out = {k: v for k, v in out.items() if v["dw"] != 0}
        return out or None

    async def _apply_rollups(self, client, pairs: Dict, from_seq: int, to_seq: int) -> bool:
        """Apply net rollup deltas to the FalkorDB ``:AGGREGATED`` layer, idempotently per
        window: each pair is stamped with ``gvSeq``; a retried window skips already-stamped
        pairs so weights never double-count. A pair stamped INSIDE this window's range
        (from_seq < gvSeq < to_seq — e.g. a crash-retry whose window grew, or a concurrent
        projector on a different window) can't be reconciled incrementally: returns False so
        the caller queues a rebuild instead of guessing. Weight ≤ 0 deletes the rollup.
        Property shape mirrors the aggregation worker (weight / sourceEdgeTypes / aggKey /
        latestUpdate), so a later full rebuild MERGEs onto the same relationships."""
        # Graph-level high-water mark for rollup application (a meta node, wiped with the
        # graph on full seeds). Catches what per-pair stamps can't: a prior application
        # whose pairs don't recur in this (grown/concurrent) window.
        res = await client.query("MATCH (m:_GVRollupMeta) RETURN m.seq")
        marker = int(res.result_set[0][0]) if getattr(res, "result_set", None) else 0
        if marker >= to_seq:
            return True                                  # whole window already applied (retry no-op)
        if marker > from_seq:
            return False                                 # partial/foreign overlap — rebuild, don't guess

        items = [{"s": s_, "t": t_, "dw": int(v["dw"]), "et": sorted(v["types"]),
                  "key": f"{s_}|{t_}", "seq": to_seq} for (s_, t_), v in pairs.items()]
        for chunk in _batches(items, self._batch):
            res = await client.query(
                "UNWIND $batch AS item "
                "MATCH (a {urn: item.s})-[r:AGGREGATED]->(b {urn: item.t}) "
                "RETURN item.s, item.t, r.weight, r.sourceEdgeTypes, r.gvSeq",
                params={"batch": chunk})
            existing = {}
            for s_, t_, w, types, gv in (getattr(res, "result_set", None) or []):
                existing[(s_, t_)] = (int(w or 0), list(types or []), int(gv or 0))
            upserts, deletes = [], []
            for item in chunk:
                k = (item["s"], item["t"])
                w0, types0, gv = existing.get(k, (0, [], 0))
                if gv >= item["seq"]:
                    continue                             # already applied (same-window retry)
                if gv > from_seq:
                    return False                         # partial overlap — rebuild, don't guess
                w1 = w0 + item["dw"]
                if w1 <= 0:
                    if k in existing:
                        deletes.append({"s": item["s"], "t": item["t"]})
                    continue
                upserts.append({"s": item["s"], "t": item["t"], "w": w1, "key": item["key"],
                                "et": sorted(set(types0) | set(item["et"])), "seq": item["seq"]})
            if upserts:
                await client.query(
                    "UNWIND $batch AS item MATCH (a {urn: item.s}) MATCH (b {urn: item.t}) "
                    "MERGE (a)-[r:AGGREGATED]->(b) "
                    "SET r.weight = item.w, r.sourceEdgeTypes = item.et, r.aggKey = item.key, "
                    "    r.gvSeq = item.seq, r.latestUpdate = timestamp()",
                    params={"batch": upserts})
            if deletes:
                await client.query(
                    "UNWIND $batch AS item "
                    "MATCH (a {urn: item.s})-[r:AGGREGATED]->(b {urn: item.t}) DELETE r",
                    params={"batch": deletes})
        # Marker written only after EVERY chunk landed — a mid-apply crash leaves it behind
        # the watermark, so the retry re-applies with per-pair gvSeq stamps de-duplicating.
        await client.query(
            "MERGE (m:_GVRollupMeta {id: 'meta'}) SET m.seq = $seq", params={"seq": to_seq})
        return True

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
            # The count SQL lives in reconcile.pg_live_counts (single source, shared with the
            # reconciler); the fork / lagging-head gate above is this verify path's own concern.
            return await pg_live_counts(s, graph_id, main_id)

    @staticmethod
    async def _falkor_counts(client):
        # Delegates to reconcile.falkor_counts (single source of the count cypher + its rollup
        # exclusion, shared with the reconciler). Kept as a thin method so the verify path and
        # its tests can monkeypatch it per-instance.
        return await falkor_counts(client)

    async def _verify_and_heal(
        self, client, graph_id, main_id, from_seq, to_seq, is_fork
    ) -> Tuple[Optional[str], bool]:
        """Reconcile live node/edge COUNTS between Postgres (SoR) and FalkorDB after an
        apply. Best-effort (any count failure → skip). Two mismatch directions:

        * FalkorDB has FEWER than committed main (a dropped delta): bounded-heal by
          reseeding the graph from Postgres ONCE (idempotent MERGE/DELETE).
        * FalkorDB has MORE than committed main: first sweep anything ``main`` has
          TOMBSTONED that the incremental pass missed (an explicit delete the cache
          stranded — urn drift, a re-point reset, or a pre-versioning seed); a tombstone
          is main's authoritative "this is deleted" and must always clear the cache.
          Whatever extra remains is un-imported legacy/aggregation data (no tombstone):
          DO NOT auto-delete it (that would wipe un-versioned data); record the
          discrepancy so enablement/bootstrap reconciles.

        Returns ``(error_or_None, reseeded)`` — ``reseeded`` is True when the heal WIPED
        and re-applied the graph (which destroys :AGGREGATED rollups; the caller must
        queue a rollup rebuild)."""
        try:
            pg = await self._pg_live_counts(graph_id, main_id, to_seq, is_fork)
            if pg is None:
                return None, False                       # fork / lagging head — not applicable
            fk = await self._falkor_counts(client)
        except Exception:
            logger.debug("projection verify skipped for %s (count failed)", graph_id, exc_info=True)
            return None, False
        if pg == fk:
            return None, False
        pg_n, pg_e = pg
        f_n, f_e = fk
        if f_n > pg_n or f_e > pg_e:
            # Remove deleted-on-main entities the cache stranded, then re-count. Legacy
            # (never-versioned) entities carry no tombstone, so they survive the sweep.
            try:
                await self._sweep_tombstoned(client, graph_id, main_id)
                fk = await self._falkor_counts(client)
            except Exception:
                logger.exception("projection tombstone sweep failed for %s", graph_id)
            else:
                if f_n - fk[0] or f_e - fk[1]:
                    logger.warning("projection: swept %d node(s) + %d edge(s) tombstoned-but-"
                                   "lingering from FalkorDB for %s (deletes the incremental pass "
                                   "missed)", f_n - fk[0], f_e - fk[1], graph_id)
                if pg == fk:
                    return None, False
                f_n, f_e = fk
        if f_n > pg_n or f_e > pg_e:
            msg = (f"FalkorDB has extra entities vs committed main "
                   f"(PG n={pg_n},e={pg_e}; Falkor n={f_n},e={f_e}) — "
                   f"run versioning enablement/bootstrap to import them")
            logger.error("%s for %s", msg, graph_id)
            return msg, False
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
                    return None, True
            except Exception:
                logger.exception("projection heal reseed failed for %s", graph_id)
                return f"projection heal reseed failed at seq {to_seq}", True
        msg = f"projection verify mismatch at seq {to_seq} after heal (committed != FalkorDB)"
        logger.error("%s for %s", msg, graph_id)
        return msg, False

    async def _sweep_tombstoned(self, client, graph_id, main_id) -> None:
        """DETACH DELETE from the cache every node/edge ``main`` has TOMBSTONED that the
        incremental pass stranded (a re-point reset, a partial delete, or a pre-versioning seed).
        A tombstone is main's authoritative "this is deleted", so it must always clear the cache;
        never-versioned legacy entities carry no tombstone and are left for enablement/bootstrap.

        Nodes are matched by their committed ``urn`` (the indexed key — fast on a large graph) with
        the entityId confirmed, so a live entity that later reused the urn is never deleted. The
        rare case where a stranded node's cache urn DIFFERS from its committed urn is not caught
        here (it needs a full reseed/resync); the count check still flags it.

        Reached only on the heal path (a count mismatch on a caught-up, non-fork main), so the
        work is bounded by the number of deletes on the graph, not by the graph size."""
        async with self._session() as s:
            node_ids = (await s.execute(
                select(EntityHeadORM.entity_id).where(
                    EntityHeadORM.graph_id == graph_id, EntityHeadORM.branch_id == main_id,
                    EntityHeadORM.entity_kind == "node", EntityHeadORM.is_tombstone.is_(True),
                ))).scalars().all()
            edge_ids = (await s.execute(
                select(EntityHeadORM.entity_id).where(
                    EntityHeadORM.graph_id == graph_id, EntityHeadORM.branch_id == main_id,
                    EntityHeadORM.entity_kind == "edge", EntityHeadORM.is_tombstone.is_(True),
                ))).scalars().all()
            # Resolve each tombstoned node's last committed urn (the delete row's urn is null, so
            # take the latest non-null) via the indexed urn column, chunking the IN-list.
            pairs: List[dict] = []
            for chunk in _batches(list(node_ids), self._batch):
                rows = (await s.execute(
                    select(NodeVersionORM.entity_id, NodeVersionORM.urn).where(
                        NodeVersionORM.graph_id == graph_id, NodeVersionORM.branch_id == main_id,
                        NodeVersionORM.entity_id.in_(list(chunk)), NodeVersionORM.urn.is_not(None),
                    ).order_by(NodeVersionORM.commit_seq)
                )).all()
                latest: Dict[str, str] = {}
                for eid, urn in rows:
                    latest[eid] = urn               # ascending commit_seq → last non-null wins
                pairs.extend({"urn": u, "eid": e} for e, u in latest.items())
        # Reads no query stats — the FalkorDB asyncio client mis-parses them; removal is measured
        # by the caller's re-count (mirrors the incremental delete in ``_apply``).
        for chunk in _batches(pairs, self._batch):
            await client.query(_DELETE_NODES_BY_PAIR, params={"pairs": list(chunk)})
        for chunk in _batches(list(edge_ids), self._batch):
            await client.query(_DELETE_EDGES, params={"ids": list(chunk)})

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
