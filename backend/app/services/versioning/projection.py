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
import inspect
import json
import logging
import os
import time
from typing import Awaitable, Callable, Dict, List, Optional, Set, Tuple

from sqlalchemy import func, literal, or_, select

from . import config, db
from .merkle import content_hash
from .reconcile import (
    falkor_counts, pg_live_counts_projectable, reconcile_interrupted, rollup_health,
)
from .projection_reconcile import (
    ActualEdge, ActualNode, EdgeKey, ExpectedEdge, ExpectedNode,
    ROLLUP_EDGE_TYPE, _local_chain, diff_projection, fingerprint, plan_rollup_deltas,
    urn_triples,
)
from .models import (
    EdgeVersionORM,
    EntityHeadORM,
    GraphORM,
    NodeVersionORM,
    ProjectionStateORM,
    _now,
)
from .service import GraphVersioningService, _is_edge_payload
from backend.common.derived_artifacts import is_derived_label

# Reuse the existing reader's schema helpers verbatim so the projection is
# byte-for-byte reader-compatible (a reader schema change flows through here too).
from backend.app.providers.falkordb_provider import (  # noqa: E402
    _admit_native_keys,
    _compute_searchable_text,
    _native_property_budget,
    _sanitize_label,
    _split_user_properties,
    reserve_platform_property_names,
)

logger = logging.getLogger(__name__)

NodeUpsert = Tuple[str, str, dict]                     # (entity_id, urn, payload)
# (entity_id, src_urn, tgt_urn, payload, src_label, tgt_label) — endpoint
# labels resolved from committed entityTypes so every edge merge anchors on
# the per-label URN indexes instead of scanning all nodes per UNWIND row.
EdgeUpsert = Tuple[str, str, str, dict, str, str]

# Server-side query budgets (ms). FalkorDB now runs with TIMEOUT_DEFAULT /
# TIMEOUT_MAX set, so an un-budgeted projector write inherits the 30s
# default and dies mid-seed; every projector query passes an explicit
# budget below TIMEOUT_MAX (mirroring the aggregation pipeline's clamp).
_WRITE_TIMEOUT_MS = int(1000 * min(170.0, max(
    5.0, float(os.getenv("PROJECTION_FALKOR_WRITE_TIMEOUT_S", "60")))))
_READ_TIMEOUT_MS = int(1000 * min(170.0, max(
    2.0, float(os.getenv("PROJECTION_FALKOR_READ_TIMEOUT_S", "30")))))


async def _q(client, cypher: str, params: Optional[dict] = None,
             *, timeout_ms: int = _WRITE_TIMEOUT_MS, read_only: bool = False):
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
        if not read_only or "empty key" not in str(exc).lower():
            raise
        return await _send(False)


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
    """Every node property the platform writes itself — never a user's to remove. Empty
    (→ removal skipped) when the platform set cannot be resolved."""
    from backend.app.providers.falkordb_provider import platform_property_names
    platform = set(platform_property_names())
    if not platform:
        return set()
    return platform | {
        "urn", "entityId", "displayName", "qualifiedName", "description", "tags",
        "layerAssignment", "childCount", "sourceSystem", "lastSyncedAt", "propertiesRaw",
        "level", "searchableText", "gvHash", "properties",
    }


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


def _edge_merge_cypher(rel_type: str, src_label: str, tgt_label: str) -> str:
    return (
        f"UNWIND $batch AS item "
        f"MATCH (a:{src_label} {{urn: item.src}}) "
        f"MATCH (b:{tgt_label} {{urn: item.tgt}}) "
        f"MERGE (a)-[r:{rel_type}]->(b) "
        f"SET r.id = item.eid, r.confidence = item.conf, r.properties = item.props, "
        f"r.gvHash = item.gvHash"
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
    # the relationship match is bounded by the (a)->(b) adjacency.
    return (
        f"UNWIND $batch AS item "
        f"MATCH (a:{src_label} {{urn: item.src}})"
        f"-[r:{rel_type} {{id: item.eid}}]->"
        f"(b:{tgt_label} {{urn: item.tgt}}) DELETE r"
    )


# Legacy fallback for edge ids whose before-state cannot be resolved from
# the version rows (no payload survives): an untyped unindexed scan per id.
# Logged whenever used; bounded by the (rare) unresolvable-delete count.
_DELETE_EDGES_FALLBACK = "UNWIND $ids AS i MATCH ()-[r {id: i}]->() DELETE r"
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
            dn, qn, desc, native, tags=payload.get("tags"),
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
        # The next projection writes the graph again with a new id catalogue; every
        # long-lived reader must drop its old one (graph_generation).
        from backend.app.providers.graph_generation import bump_graph_generation
        await bump_graph_generation(name, reason="projection cache drop")

    async def project_graph(self, graph_id: str) -> Dict[str, object]:
        """Catch a graph's FalkorDB projection up to its target watermark.

        Single-flight per graph: publish/merge fan out one ``project_now`` each, so two
        near-simultaneous first merges on a blank graph could otherwise run overlapping
        full-seed DROP+reseed passes and corrupt the cache. The DROP+MERGE apply runs OUTSIDE
        any Postgres transaction, so a transaction-scoped lock cannot cover it — hold a
        SESSION-level advisory lock on a dedicated connection for the whole projection. A
        second concurrent projection finds the lock held and returns ``skipped: in-flight``
        without touching the cache; the lock is released (and the connection closed) in a
        finally so a later projection is never wedged. Different graphs use different keys.
        """
        lock_scope = self._session()
        lock_s = await lock_scope.__aenter__()
        lock_arg = func.hashtext(f"gvproj:{graph_id}")
        acquired = False
        try:
            acquired = bool(await lock_s.scalar(select(func.pg_try_advisory_lock(lock_arg))))
            if not acquired:
                return {"noop": True, "skipped": "in-flight"}
            return await self._project_graph_locked(graph_id)
        finally:
            try:
                if acquired:
                    await lock_s.execute(select(func.pg_advisory_unlock(lock_arg)))
            finally:
                await lock_scope.__aexit__(None, None, None)

    async def _project_graph_locked(self, graph_id: str) -> Dict[str, object]:
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
            from_seq, to_seq = ps.projected_commit_seq, ps.target_commit_seq
            name = ps.falkor_graph_name or self.default_graph_name(graph_id)
            provider_id = ps.falkor_provider    # pinned instance; None → env default
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
            # Honest lifecycle label: a full replay (explicit rebuild, first seed, repin)
            # reports "rebuilding"; an incremental window reports "projecting".
            ps.status = "rebuilding" if from_seq <= 0 else "projecting"
            main_id = await self._svc._main_branch_id(s, graph_id)
            is_fork = graph.fork_parent_graph_id is not None
            # A full replay (first seed, explicit rebuild, repin) is an in-place
            # reconcile against what the graph already holds — its writes are known
            # only once the diff runs, so it computes (and reports) them itself.
            changes = (await self._compute_changes(s, graph, main_id, from_seq, to_seq)
                       if from_seq > 0 else ([], [], [], []))
            total_items = sum(len(c) for c in changes)
            structural = (await self._window_is_structural(s, graph, main_id, from_seq, changes)
                          if from_seq > 0 else False)
            if from_seq <= 0:
                ps.progress_done = 0
                ps.progress_total = None
            # Incremental :AGGREGATED rollup maintenance for a publish window. A full
            # replay's rollups are moved by the reconcile's own diff instead.
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

        try:
            # Inside the try: the factory does a real Postgres provider lookup + FalkorDB handle
            # build (a genuine suspension point), so a cancellation here must ALSO reset the
            # already-committed "projecting" row rather than strand it.
            client = await self._graph_client(name, provider_id)
            # Ontology entity-type→level map so projected nodes carry n.level (parity with
            # save_custom_graph). Best-effort: {} when unavailable, leaving level unset.
            level_map = await self._resolve_level_map(graph_id)
            reconciled: Optional[Dict[str, object]] = None
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
                    client, graph_id, main_id, to_seq, is_fork, level_map, track_progress=True)
            else:
                await self._apply(client, *changes, level_map=level_map)
            window_rollups_applied = False
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
            verify_error, healed = (
                await self._verify_and_heal(client, graph_id, main_id, from_seq, to_seq, is_fork,
                                            level_map=level_map, heal_outcome=heal_outcome,
                                            rollups_moved=window_rollups_applied)
                if config.PROJECTION_VERIFY_ENABLED else (None, False)
            )

            published = verify_error is None
            async with self._session() as s:
                ps = await s.get(ProjectionStateORM, graph_id)
                ps.status = "idle"
                ps.falkor_graph_name = name
                ps.last_error = verify_error
                ps.progress_done = None                  # full-seed progress is over either way
                ps.progress_total = None
                if published:
                    # Verified faithful → publish: advance the watermark so reads flip to FalkorDB.
                    ps.projected_commit_seq = to_seq
                    ps.last_projected_at = _now()
                else:
                    # The reseed did NOT match committed main (a dropped/mistyped edge, a drifted
                    # field — the content-drift class the old count-only verify published blind).
                    # DO NOT advance: hold projected < committed so `fresh` stays false and reads
                    # keep falling back to Postgres (the SoR) instead of flipping onto a corrupt
                    # cache. Pin target down to the un-advanced seq so the RETRY is bounded and
                    # idempotent — each pass re-attempts this one seq rather than climbing.
                    # It does NOT stop the poll: `project_pending` re-selects on
                    # `projected < main_head_commit_seq` too, precisely because selecting on
                    # target alone left a held-back graph unreachable forever once BOTH sat at
                    # the un-advanced seq — that is the shape that wedged a projection for 14h
                    # and silently routed every main read back to Postgres.
                    ps.target_commit_seq = ps.projected_commit_seq
                    logger.error("projection for %s verified UNFAITHFUL at seq %d; holding watermark "
                                 "at %d so reads stay on Postgres — %s", graph_id, to_seq,
                                 ps.projected_commit_seq, verify_error)
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
            if cancelled:
                logger.warning("projection for %s cancelled; resetting status so it is not stranded",
                               graph_id)
            else:
                logger.exception("projection apply failed for %s: %s", graph_id, exc)

            async def _reset_status() -> None:
                async with self._session() as s:
                    ps = await s.get(ProjectionStateORM, graph_id)
                    if ps is not None:
                        ps.status = "idle"
                        ps.last_error = ("projection cancelled (timeout)" if cancelled
                                         else str(exc)[:500])
                        ps.progress_done = None          # don't strand a stale progress bar
                        ps.progress_total = None
                        # NB: do NOT pin target on a cancel here. The original "Rebuild fast read layer"
                        # wipe-loop was driven by the O(N²) verify blowing past the 900s rebuild budget
                        # and being cancelled — that root cause is fixed (the verify is now an O(N+E)
                        # single scan, size-gated), so a full seed completes well inside the budget and
                        # is not cancelled. A cancel now means a SHORT-budget caller gave up
                        # (project_now's 10s interactive ceiling — common for a first-import / post-
                        # eviction full seed) and DEFERS to the async worker, which re-runs with the
                        # 900s budget. Pinning target here would strand that graph un-projected (the
                        # nudge/worker could never rescue it) — the very regression an adversarial
                        # review caught. Leave projected<target so project_pending re-selects it.

            # Shield the reset so a SECOND cancellation (e.g. uvicorn shutdown mid-cleanup) can't
            # abort the write and re-strand the row; catch a Postgres error so it can't replace the
            # CancelledError we owe our caller. Then re-raise the original.
            try:
                await asyncio.shield(_reset_status())
            except Exception:                          # pragma: no cover - infra
                logger.warning("could not reset projection status for %s after failure/cancel",
                               graph_id, exc_info=True)
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

        applied = sum(len(c) for c in changes) + int((reconciled or {}).get("writes") or 0) \
            + int(heal_outcome.get("writes") or 0)
        # Report the seq actually PUBLISHED: to_seq when verified, else the held-back from_seq
        # (the watermark did not advance — reads stay on Postgres).
        return {"projected": to_seq if published else from_seq, "applied": applied,
                "noop": False, "verify_error": verify_error}

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
                select(ProjectionStateORM.graph_id).join(
                    GraphORM, GraphORM.id == ProjectionStateORM.graph_id,
                ).where(
                    # LAG IS MEASURED AGAINST THE COMMITTED HEAD, not against `target`.
                    #
                    # `target_commit_seq` is what a projection ATTEMPT aimed at, and the
                    # failure path holds BOTH counters at the last good seq. So a graph that
                    # fails to verify ends up `projected == target` below `main_head`: this
                    # retry can never select it again, while the read path's freshness check
                    # (`projected >= main_head`, service.py:2126) stays false forever and
                    # routes every main read to Postgres. That is a permanent wedge with no
                    # self-healing path — one cost a data source its entire aggregated
                    # lineage layer for 14 hours and needed a hand-written UPDATE to escape.
                    #
                    # Selecting on the head means a held-back graph is retried on the next
                    # poll. A genuinely unfixable graph therefore retries on a loop, which is
                    # the correct trade: it is visible and bounded by the poll interval,
                    # where silence was neither.
                    or_(
                        ProjectionStateORM.projected_commit_seq < ProjectionStateORM.target_commit_seq,
                        ProjectionStateORM.projected_commit_seq < GraphORM.main_head_commit_seq,
                    ),
                    # Unpinned graphs (no real FalkorDB target — falkor_graph_name NULL or the
                    # synthetic gv_<id> fallback) are never projected: nothing reads those keys.
                    # Filtered here in SQL so hundreds of test-created graphs can't crowd out
                    # (limit) or churn the poll loop; project_graph re-checks for direct nudges.
                    ProjectionStateORM.falkor_graph_name.isnot(None),
                    ProjectionStateORM.falkor_graph_name
                    != literal("gv_").concat(ProjectionStateORM.graph_id),
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
    ) -> Tuple[List[NodeUpsert], List[EdgeUpsert], List[Tuple[str, str]], List[object]]:
        node_upserts: List[NodeUpsert] = []
        edge_upserts: List[EdgeUpsert] = []
        node_deletes: List[Tuple[str, str]] = []   # (urn, label)
        edge_deletes: List[object] = []            # resolved dicts, else entity_id str
        urn_of: Dict[str, str] = {}
        label_of: Dict[str, str] = {}

        if from_seq <= 0:
            # Seed: the full live state (fork-aware copy-on-write composition).
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
                node_deletes.append(await self._urn_label_for(s, graph, main_id, eid))
            else:
                urn = _node_urn(eid, p)
                urn_of[eid] = urn
                label_of[eid] = str((p or {}).get("entityType") or "Entity")
                node_upserts.append((eid, urn, p))
        deleted_edge_ids: List[str] = []
        for (kind, eid), (_, op, p) in last.items():
            if kind != "edge":
                continue
            if op == "delete":
                deleted_edge_ids.append(eid)
            elif _is_derived_edge_payload(p):
                continue
            else:
                src, tgt = _edge_endpoints(p)
                su, slb = await self._endpoint(s, graph, main_id, src, urn_of, label_of)
                tu, tlb = await self._endpoint(s, graph, main_id, tgt, urn_of, label_of)
                edge_upserts.append((eid, su, tu, p, slb, tlb))
        # Deleted edges: resolve the BEFORE-window value so the delete can
        # run typed + endpoint-anchored (delete rows carry no payload).
        # Unresolvable ids keep the legacy scan-delete fallback.
        if deleted_edge_ids:
            before = await self._svc._values_at(
                s, graph.id, main_id, deleted_edge_ids, from_seq)
            for eid in deleted_edge_ids:
                p = before.get(eid)
                if p and _is_derived_edge_payload(p):
                    continue                             # the platform owns rollups, not the log
                if p and _is_edge_payload(p):
                    src, tgt = _edge_endpoints(p)
                    su, slb = await self._endpoint(s, graph, main_id, src, urn_of, label_of)
                    tu, tlb = await self._endpoint(s, graph, main_id, tgt, urn_of, label_of)
                    edge_deletes.append({
                        "eid": eid, "src": su, "tgt": tu,
                        "rel": str(p.get("edgeType") or "REL"),
                        "slb": slb, "tlb": tlb,
                    })
                else:
                    edge_deletes.append(eid)

        await self._merkle_augment_upserts(
            s, graph, main_id, from_seq, to_seq, last, urn_of, label_of,
            node_upserts, edge_upserts)
        return node_upserts, edge_upserts, node_deletes, edge_deletes

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

    # Largest rollup change maintained inline (lineage edges in a window, a moved container's
    # subtree, a reconcile's contributions); above it the on_rollups_stale hook queues the batch
    # job. See ``config.PROJECTION_ROLLUP_INLINE_CAP``.
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
        """Whether a publish window changes what a reader has CACHED about existing entities:
        retypes one (its urn→label entry would anchor lookups on the OLD label and find
        nothing), removes a containment link, or gives an EXISTING entity a containment parent
        (a move). Creating an entity inside a container is not structural — nothing has
        cached the new entity's ancestry yet — so the common edit does not flush every
        provider's caches. Unknown containment types count every edge change."""
        node_upserts, edge_upserts, _node_deletes, edge_deletes = changes
        if not (node_upserts or edge_upserts or edge_deletes):
            return False
        cont = await self._containment_types(graph.id)

        def containment(rel) -> bool:
            return cont is None or str(rel or "").upper() in cont

        if any(not isinstance(e, dict) or containment(e.get("rel")) for e in edge_deletes):
            return True
        new_children = [_edge_endpoints(p or {})[1] for _e, _su, _tu, p, _sl, _tl in edge_upserts
                        if containment((p or {}).get("edgeType"))]
        ids = [eid for eid, _u, _p in node_upserts] + [c for c in new_children if c]
        if not ids:
            return False
        before = await self._svc._values_at(s, graph.id, main_id, list(dict.fromkeys(ids)), from_seq)
        if any(before.get(c) is not None for c in new_children):
            return True                                  # an existing entity got a (new) parent
        for eid, _u, p in node_upserts:
            old = before.get(eid)
            if old and old.get("entityType") != (p or {}).get("entityType"):
                return True
        return False

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
            # Past the inline cap the aggregation JOB takes over — it too writes only the
            # difference. Below it the chains come from one batched climb (``prefetch``).
            return "stale"
        if not lineage_creates and not lineage_deletes and not moved:
            return None

        anc_cache: Dict[Tuple[str, Optional[int]], Tuple[List[str], Dict[str, List[str]]]] = {}
        lvl_cache: Dict[Tuple[str, Optional[int]], Optional[int]] = {}

        async def prefetch(ids, as_of: Optional[int]) -> None:
            """Every chain a window needs at one seq, in ONE batched climb — a query per
            containment LEVEL, not per node — so a 10,000-edge window costs what a 10-edge
            one does in round trips. (Per node, a deep hierarchy re-read the same top-level
            containers' edges for every distinct leaf.)"""
            need = {i for i in ids if i and (i, as_of) not in anc_cache}
            if not need:
                return
            _seen, edges = await self._svc._containment_ancestors(
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

        async def levels_of(ids, as_of: Optional[int]) -> Dict[str, Optional[int]]:
            need = [i for i in ids if (i, as_of) not in lvl_cache]
            if need:
                vals = await self._svc._values_at(s, graph.id, main_id, need, as_of)
                for i in need:
                    et_id = ((vals.get(i) or {}).get("entityType")) or None
                    lvl_cache[(i, as_of)] = level_map.get(et_id) if et_id else None
            return {i: lvl_cache[(i, as_of)] for i in ids}

        pairs: Dict[Tuple[str, str], Dict[str, object]] = {}

        async def contribute(p: dict, sign: int, as_of: Optional[int]) -> None:
            """Accumulate this raw edge's delta into BOTH pair sets via
            the shared ``pair_rules`` (the same rules the batch pipeline
            and the write hooks run): ``dw`` = the full ancestor-closure
            cross-product (what a CUBE-regime graph stores), ``dwc`` = the
            canonical depth-bridged subset (what a BOUNDARY-regime graph
            stores). The stored regime is only knowable from the graph
            itself, so _apply_rollups picks the matching delta at apply
            time. Closures have SET semantics — a diamond's shared
            grandparent gets each edge's delta exactly once — and every
            ancestry of a multi-parent node is linked."""
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
                    e = pairs.setdefault(
                        (sx, tx), {"dw": 0, "dwc": 0, "types": set()},
                    )
                    e["dw"] += sign
                    if (sx, tx) in canon:
                        e["dwc"] += sign
                    e["sd"], e["td"] = depths.get(sx), depths.get(tx)
                    if sign > 0 and et:
                        e["types"].add(et)
                return
            for sx in cs:
                for tx in ct:
                    if sx == tx:
                        continue
                    e = pairs.setdefault((sx, tx), {"dw": 0, "types": set()})
                    e["dw"] += sign
                    if sign > 0 and et:
                        e["types"].add(et)

        await prefetch({x for p in lineage_creates.values() for x in _edge_endpoints(p)}, to_seq)
        await prefetch({x for p in lineage_deletes.values() for x in _edge_endpoints(p)}, from_seq)
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
            ends = {x for p in moved_edges.values() for x in _edge_endpoints(p)}
            await prefetch(ends, from_seq)
            await prefetch(ends, to_seq)
            for eid, p in moved_edges.items():
                await contribute(p, -1, from_seq)
                await contribute(p, +1, to_seq)

        pairs = {
            k: v for k, v in pairs.items()
            if v["dw"] != 0 or v.get("dwc", 0) != 0
        }
        if not pairs:
            return None
        if use_canonical:
            # Level stamps for every surviving cell in one batched read: the node's type
            # level as of the window's end (as of its start for a node the window deleted).
            ids = {i for k in pairs for i in k}
            lv = await levels_of(ids, to_seq)
            gone = [i for i in ids if lv.get(i) is None]
            if gone:
                lv.update({i: v for i, v in (await levels_of(gone, from_seq)).items()
                           if v is not None})
            for (sx, tx), e in pairs.items():
                sl, tl = lv.get(sx), lv.get(tx)
                if sl is not None and tl is not None:
                    e["sl"], e["tl"] = sl, tl
        # FalkorDB keys nodes by urn; versioned entity ids usually ARE urns, but imported
        # entities may differ — resolve through the entities' payloads, with the SAME
        # gv:<id> fallback the raw projection uses (_node_urn) so the MATCH always hits.
        ids = {i for k in pairs for i in k}
        vals = await self._svc._values_at(s, graph.id, main_id, ids, to_seq)
        urn_of = {i: ((vals.get(i) or {}).get("urn") or f"gv:{i}") for i in ids}
        # entityType is what the node merge labeled the cache node with —
        # carried so _apply_rollups anchors every match on the per-label
        # URN index instead of an unlabeled full scan per row.
        lbl_of = {i: str(((vals.get(i) or {}).get("entityType")) or "Entity") for i in ids}
        digest = None
        if use_canonical and level_map:
            from backend.app.services.ontology_levels import compute_level_digest
            digest = compute_level_digest(level_map)
        out: Dict[Tuple[str, str], Dict[str, object]] = {}
        for (sx, tx), v in pairs.items():                # distinct ids can share a urn — SUM, don't overwrite
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
        out = {
            k: v for k, v in out.items()
            if v["dw"] != 0 or v.get("dwc", 0) != 0
        }
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
        res = await _q(client, "MATCH (m:_GVRollupMeta) RETURN m.seq",
                       timeout_ms=_READ_TIMEOUT_MS, read_only=True)
        marker = int(res.result_set[0][0]) if getattr(res, "result_set", None) else 0
        if marker >= to_seq:
            return True                                  # whole window already applied (retry no-op)
        if marker > from_seq:
            return False                                 # partial/foreign overlap — rebuild, don't guess

        if not await self._write_rollup_deltas(client, pairs, to_seq, guard_from_seq=from_seq):
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
            key = (
                _sanitize_label(str(v.get("slb") or "Entity")),
                _sanitize_label(str(v.get("tlb") or "Entity")),
            )
            items_by_labels.setdefault(key, []).append(
                {"s": s_, "t": t_, "dw": dw, "et": sorted(v["types"]),
                 "key": f"{s_}|{t_}", "seq": seq,
                 "sl": v.get("sl"), "tl": v.get("tl"),
                 "sd": v.get("sd"), "td": v.get("td"), "dg": v.get("dg")}
            )
        for (slb, tlb), items in items_by_labels.items():
            for chunk in _batches(items, self._batch):
                res = await _q(
                    client,
                    f"UNWIND $batch AS item "
                    f"MATCH (a:{slb} {{urn: item.s}})-[r:AGGREGATED]->(b:{tlb} {{urn: item.t}}) "
                    f"RETURN item.s, item.t, r.weight, r.sourceEdgeTypes, r.gvSeq",
                    params={"batch": chunk}, timeout_ms=_READ_TIMEOUT_MS, read_only=True)
                existing = {}
                for s_, t_, w, types, gv in (getattr(res, "result_set", None) or []):
                    existing[(s_, t_)] = (int(w or 0), list(types or []), int(gv or 0))
                upserts, deletes = [], []
                for item in chunk:
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
                if upserts:
                    # Level stamps coalesce so the legacy (level-less) mode
                    # never NULLs stamps a backfill wrote; canonical mode
                    # always provides them — and stamped rows keep the read
                    # path's storage-regime probe clean (a NULL sourceLevel
                    # row makes every reader fall back to stored-only answers
                    # for up to 5 minutes).
                    await _q(
                        client,
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
                        params={"batch": upserts})
                if deletes:
                    await _q(
                        client,
                        f"UNWIND $batch AS item "
                        f"MATCH (a:{slb} {{urn: item.s}})-[r:AGGREGATED]->(b:{tlb} {{urn: item.t}}) "
                        f"DELETE r",
                        params={"batch": deletes})
        return True

    async def _urn_label_for(
        self, s, graph: GraphORM, main_id: str, entity_id: str,
    ) -> Tuple[str, str]:
        """Latest committed (urn, entityType) for an entity on `main`
        (fork-aware); ``(gv:<eid>, "Entity")`` when nothing resolves. The
        entityType is exactly what the node merge labeled the cache node
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
        if graph.fork_parent_graph_id:
            parent = await s.get(GraphORM, graph.fork_parent_graph_id)
            if parent is not None:
                pmain = await self._svc._main_branch_id(s, parent.id)
                return await self._urn_label_for(s, parent, pmain, entity_id)
        logger.warning("projection: no urn for node entity %s on %s; keying as gv:<entity_id>",
                       entity_id, graph.id)
        return f"gv:{entity_id}", "Entity"

    async def _urn_for(self, s, graph: GraphORM, main_id: str, entity_id: str) -> str:
        """Latest non-null urn for an entity on `main` (fork-aware), else gv:<eid>."""
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

    async def _pg_live_counts(self, graph_id, main_id, to_seq, is_fork):
        """Node count + the count a FAITHFUL FalkorDB projection should hold, from ``entity_heads``,
        for a NON-fork main fully caught up (``main_head == to_seq``); ``None`` otherwise (a fork's
        composed count is O(graph); a lagging head verifies on catch-up).

        Edges are counted as DISTINCT ``(source, type, target)`` TRIPLES, not raw ids: the projector
        MERGEs edges id-lessly, so parallel edges (same triple, different ids) collapse to one
        relationship in FalkorDB. Comparing against the raw edge count would flag that legitimate
        collapse as a shortfall and hold every parallel-edge graph back forever."""
        if is_fork:
            return None
        async with self._session() as s:
            graph = await s.get(GraphORM, graph_id)
            if graph is None or graph.main_head_commit_seq != to_seq:
                return None
            # Collapse-correct count (reconcile.pg_live_counts_projectable): distinct edge triples ==
            # what falkor_counts sees after the id-less MERGE. Single source, shared semantics.
            return await pg_live_counts_projectable(s, graph_id, main_id)

    @staticmethod
    async def _falkor_counts(client):
        # Delegates to reconcile.falkor_counts (single source of the count cypher + its rollup
        # exclusion, shared with the reconciler). Kept as a thin method so the verify path and
        # its tests can monkeypatch it per-instance.
        return await falkor_counts(client)

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
        """What FalkorDB should hold at ``to_seq``, NARROW: the winners a full seed replays
        (fork-aware), keyed the way the projector writes them — (label, urn) per node, so
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
            label = _sanitize_label(etype)
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
            rel = _sanitize_label(etype or "REL")
            edges[(_sanitize_label(slb or "Entity"), su, rel, _sanitize_label(tlb or "Entity"), tu)] = \
                ExpectedEdge(entity_id=eid, ref=("edge", gid, vid), fp=_edge_fingerprint(rel, chash))
        del heads
        return nodes, edges, types_by_urn

    async def _rollups_trusted(self, client, actual_lineage: int) -> bool:
        """Whether the stored rollups are exactly what FalkorDB's raw edges imply — the
        precondition for correcting them by delta (``reconcile.RollupHealth``, the same
        reading "Check sync" reports)."""
        return (await rollup_health(client)).trusted(actual_lineage)

    async def _reconcile_in_place(self, client, graph_id, main_id, to_seq, is_fork,
                                  level_map, track_progress: bool = False,
                                  rollups_moved_this_pass: bool = False) -> Dict[str, object]:
        """Make FalkorDB hold exactly committed main at ``to_seq`` by writing only the
        difference, and move the rollups by that same difference — never dropping the graph.
        See ``projection_reconcile``.

        Returns ``{"writes", "rollups", "structural"}``; ``rollups`` is ``"none"`` (nothing
        rollup-relevant changed), ``"applied"``, or ``"stale"`` — the batch job must derive
        them: the change is too large to do inline, the stored rollups are not a trustworthy
        base, this pass already moved them from Postgres's window (``rollups_moved_this_pass``
        — a heal after a publish window; its deltas assumed raw writes that did not land, so a
        second delta would double-count), rollup cells went with a node that had to be deleted
        outright, or the graph is a fork (its chains span the parent's rows)."""
        async with self._session() as s:
            graph = await s.get(GraphORM, graph_id)
            nodes, edges, types_by_urn = await self._expected_projection(
                s, graph, main_id, to_seq, level_map)
        actual_nodes, copies, actual_edges, parallel, unkeyed = await self._scan_projection(client)

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

        rollups, plan, sets = "none", None, None
        cont_types: Set[str] = set()
        raw_edges_change = bool(diff.edge_upserts or diff.edge_deletes or parallel
                                or diff.node_deletes or duplicated or unkeyed)
        # Rollup cells on a node deleted outright (a true duplicate, a urn-less stray) go with
        # its DETACH; no delta can say what they held.
        cells_lost = bool(duplicated or unkeyed)
        if is_fork:
            rollups = "stale" if (raw_edges_change or diff.relabels) else "none"
        elif self._edge_types_resolver is not None:
            try:
                sets = await self._edge_types_resolver(self._svc, graph_id)
            except Exception:                            # pragma: no cover - app-layer resolution
                logger.warning("reconcile: edge-type resolution failed for %s — rollups "
                               "handed to the batch job", graph_id, exc_info=True)
                rollups = "stale"
        if sets:
            cont_types = {t.upper() for t in (sets[0] or [])}
            lineage_types = {t.upper() for t in (sets[1] or [])}
            if lineage_types:
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
                if (plan.stale or cells_lost or (rollups_moved_this_pass and plan.pairs)
                        or not await self._rollups_trusted(client, actual_lineage)):
                    rollups, plan = "stale", None
                elif plan.pairs:
                    rollups = "applied"
        elif rollups == "none" and not is_fork and raw_edges_change:
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
            for chunk in _batches(urns, self._batch):
                await _q(client, _delete_nodes_cypher(_sanitize_label(label)),
                         params={"urns": list(chunk)})
        for chunk in _batches(unkeyed, self._batch):
            await _q(client, "UNWIND $ids AS i MATCH (n) WHERE id(n) = i DETACH DELETE n",
                     params={"ids": list(chunk)})
        await self._delete_edges_by_key(client, list(parallel), progress)

        # Retypes IN PLACE: the node keeps its id, its edges and the rollup cells on it.
        by_relabel: Dict[Tuple[str, str], List[str]] = {}
        for urn, old, new in diff.relabels:
            by_relabel.setdefault((old, new), []).append(urn)
        for (old, new), urns in by_relabel.items():
            for chunk in _batches(urns, self._batch):
                await _q(client,
                         f"UNWIND $urns AS u MATCH (n:{_sanitize_label(old)} {{urn: u}}) "
                         f"SET n:{_sanitize_label(new)} REMOVE n:{_sanitize_label(old)}",
                         params={"urns": list(chunk)})
                if progress:
                    await progress(len(chunk))

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
                          progress=progress, level_map=level_map)
        await self._delete_edges_by_key(client, diff.edge_deletes, progress)

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

    async def _delete_edges_by_key(self, client, keys, progress=None) -> None:
        by: Dict[Tuple[str, str, str], list] = {}
        for sl, su, rel, tl, tu in keys:
            by.setdefault((rel, _sanitize_label(sl or "Entity"), _sanitize_label(tl or "Entity")),
                          []).append({"src": su, "tgt": tu})
        for (rel, sl, tl), items in by.items():
            for chunk in _batches(items, self._batch):
                await _q(client, _delete_edges_by_key_cypher(rel, sl, tl),
                         params={"batch": chunk})
                if progress:
                    await progress(len(chunk))

    async def _verify_and_heal(
        self, client, graph_id, main_id, from_seq, to_seq, is_fork, level_map=None,
        heal_outcome: Optional[Dict[str, object]] = None, rollups_moved: bool = False,
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
          DO NOT auto-delete it (that would wipe un-versioned data); record the
          discrepancy so enablement/bootstrap reconciles.

        Returns ``(error_or_None, healed)`` — ``healed`` is True when the heal reconcile
        ran; its outcome (writes, and whether the rollups were moved or must be handed
        to the aggregation batch job) is written into ``heal_outcome`` when given."""
        try:
            pg = await self._pg_live_counts(graph_id, main_id, to_seq, is_fork)
            if pg is None:
                return None, False                       # fork / lagging head — not applicable
            fk = await self._falkor_counts(client)
        except Exception:
            logger.debug("projection verify skipped for %s (count failed)", graph_id, exc_info=True)
            return None, False
        if pg == fk:
            # Counts match — but on a full seed that is NOT sufficient (content drift keeps the
            # counts). Run the content verify; None unless it finds drift (or not a full seed).
            # Pass the entity count so the deep pass can size-gate itself (fk = node + edge counts).
            return (await self._full_seed_content_error(
                client, graph_id, main_id, from_seq, fk[0] + fk[1])), False
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
                    client, graph_id, main_id, to_seq, is_fork, level_map,
                    rollups_moved_this_pass=rollups_moved)
                if heal_outcome is not None:
                    heal_outcome.update(healed)
                pg2 = await self._pg_live_counts(graph_id, main_id, to_seq, is_fork)
                fk2 = await self._falkor_counts(client)
                if pg2 is None or pg2 == fk2:
                    return None, True
            except Exception:
                logger.exception("projection heal reconcile failed for %s", graph_id)
                return f"projection heal reconcile failed at seq {to_seq}", True
        msg = f"projection verify mismatch at seq {to_seq} after heal (committed != FalkorDB)"
        logger.error("%s for %s", msg, graph_id)
        return msg, False

    async def _full_seed_content_error(
        self, client, graph_id, main_id, from_seq, entity_count=0
    ) -> Optional[str]:
        """Content verify for a FULL SEED whose COUNTS already matched: the reconciler's single-scan
        content diff (node displayName/label drift + edge type/confidence/properties drift) of the
        freshly-seeded cache vs committed main. Returns an error string on ANY field drift the count
        verify can't see, else None. No-op off the full-seed path, when disabled, or above the
        deep-verify entity ceiling (the ordered scan's SKIP/LIMIT paging degrades on a very large
        graph — count verify still ran; the on-demand reconcile can deep-diff any size). Best-effort:
        a diff-infra failure degrades to None (counts already passed), never raises."""
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
        if mn or xn or mm or em:
            msg = (f"content drift after full seed: {len(mn)} missing node(s), "
                   f"{len(xn)} extra node(s), {len(mm)} node field mismatch(es), "
                   f"{len(em)} edge attr mismatch(es) (bounded sample) — cache NOT published")
            logger.error("%s for %s", msg, graph_id)
            return msg
        return None

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
            # Resolve each tombstoned node's last committed (urn, label) — the delete row's
            # urn is null, so take the latest non-null — via the indexed urn column,
            # chunking the IN-list. The label anchors the delete on the per-label URN index.
            pairs_by_label: Dict[str, List[dict]] = {}
            for chunk in _batches(list(node_ids), self._batch):
                rows = (await s.execute(
                    select(NodeVersionORM.entity_id, NodeVersionORM.urn,
                           NodeVersionORM.payload).where(
                        NodeVersionORM.graph_id == graph_id, NodeVersionORM.branch_id == main_id,
                        NodeVersionORM.entity_id.in_(list(chunk)), NodeVersionORM.urn.is_not(None),
                    ).order_by(NodeVersionORM.commit_seq)
                )).all()
                latest: Dict[str, Tuple[str, str]] = {}
                for eid, urn, payload in rows:      # ascending commit_seq → last non-null wins
                    latest[eid] = (urn, str((payload or {}).get("entityType") or "Entity"))
                for e, (u, lbl) in latest.items():
                    pairs_by_label.setdefault(_sanitize_label(lbl), []).append(
                        {"urn": u, "eid": e})
            # Tombstoned edges: their delete rows carry no payload — fold the last
            # non-delete row per entity so the delete runs typed + endpoint-anchored;
            # anything unresolvable keeps the legacy per-id scan fallback.
            edge_deletes: List[object] = []
            if edge_ids:
                graph = await s.get(GraphORM, graph_id)
                urn_cache: Dict[str, str] = {}
                label_cache: Dict[str, str] = {}
                for chunk in _batches(list(edge_ids), self._batch):
                    rows = (await s.execute(
                        select(EdgeVersionORM.entity_id, EdgeVersionORM.op,
                               EdgeVersionORM.payload).where(
                            EdgeVersionORM.graph_id == graph_id,
                            EdgeVersionORM.branch_id == main_id,
                            EdgeVersionORM.entity_id.in_(list(chunk)),
                        ).order_by(EdgeVersionORM.commit_seq)
                    )).all()
                    last_payload: Dict[str, Optional[dict]] = {}
                    for eid, op, payload in rows:
                        if op != "delete" and payload:
                            last_payload[eid] = payload
                    for eid in chunk:
                        p = last_payload.get(eid)
                        if p and _is_edge_payload(p):
                            src, tgt = _edge_endpoints(p)
                            su, slb = await self._endpoint(
                                s, graph, main_id, src, urn_cache, label_cache)
                            tu, tlb = await self._endpoint(
                                s, graph, main_id, tgt, urn_cache, label_cache)
                            edge_deletes.append({
                                "eid": eid, "src": su, "tgt": tu,
                                "rel": str(p.get("edgeType") or "REL"),
                                "slb": slb, "tlb": tlb,
                            })
                        else:
                            edge_deletes.append(eid)
        # Reads no query stats — the FalkorDB asyncio client mis-parses them; removal is measured
        # by the caller's re-count (mirrors the incremental delete in ``_apply``).
        for label, pairs in pairs_by_label.items():
            for chunk in _batches(pairs, self._batch):
                await _q(client, _delete_nodes_by_pair_cypher(label),
                         params={"pairs": list(chunk)})
        await self._run_edge_deletes(client, edge_deletes)

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

    async def _apply(self, client, node_upserts, edge_upserts, node_deletes, edge_deletes,
                     progress=None, level_map: Optional[Dict[str, int]] = None) -> None:
        """Apply one pass: nodes in (grouped by label), edges in (grouped by
        type + endpoint labels — the per-label URN indexes drive every node
        match), edges out, nodes out.

        This writes through its own client and never touches a provider
        instance, so it stakes the platform's property names itself
        (``reserve_platform_property_names``) and spends the ENV-wide
        ``FALKORDB_NATIVE_PROPERTY_BUDGET``. The reserve is decided from the
        registered names this pass already reads, so it costs nothing on a
        graph that holds them and happens again by itself after a full seed
        DROPs the graph and takes every registered name with it."""
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
                [p.get("properties") for _, _, p in node_upserts],
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
        for eid, urn, p in node_upserts:
            label = _sanitize_label(p.get("entityType") or "Entity")
            item = _node_item(eid, urn, p, level_map, native_keys)
            # The fingerprint a later reconcile compares against, so it can
            # tell an up-to-date node from one it must rewrite.
            item["gvHash"] = _node_fingerprint(
                label, content_hash(p), (level_map or {}).get(p.get("entityType")))
            by_label.setdefault(label, []).append(item)
        keep = _projector_owned_property_names()
        for label, items in by_label.items():
            for chunk in _batches(items, self._batch):
                await self._mark_removed_properties(client, label, chunk, keep)
                await _q(client, _node_merge_cypher(label), params={"batch": chunk})
                if progress:
                    await progress(len(chunk))

        by_rel: Dict[Tuple[str, str, str], list] = {}
        for eid, su, tu, p, slb, tlb in edge_upserts:
            key = (
                _sanitize_label(p.get("edgeType") or "REL"),
                _sanitize_label(slb or "Entity"),
                _sanitize_label(tlb or "Entity"),
            )
            item = _edge_item(eid, su, tu, p)
            item["gvHash"] = _edge_fingerprint(key[0], content_hash(p))
            by_rel.setdefault(key, []).append(item)
        for (rel, sl, tl), items in by_rel.items():
            for chunk in _batches(items, self._batch):
                await _q(client, _edge_merge_cypher(rel, sl, tl), params={"batch": chunk})
                if progress:
                    await progress(len(chunk))

        await self._run_edge_deletes(client, edge_deletes, progress=progress)

        ndel_by: Dict[str, list] = {}
        for urn, label in node_deletes:
            ndel_by.setdefault(_sanitize_label(label or "Entity"), []).append(urn)
        for label, urns in ndel_by.items():
            for chunk in _batches(urns, self._batch):
                await _q(client, _delete_nodes_cypher(label), params={"urns": list(chunk)})
                if progress:
                    await progress(len(chunk))

    async def _mark_removed_properties(self, client, label: str, chunk: list, keep) -> None:
        """Give each item a ``gone`` map of the user properties its node still carries but
        the committed payload no longer has — ``n += nativeProps`` only ever adds, so a
        property removed from an entity used to stay on its node (in Properties, matching
        search filters) until a drop-and-replay wiped the graph, which no longer happens. A
        null in the map removes the property. Skipped when the platform's own property names
        are unknown, so nothing that might be the platform's is ever taken."""
        for item in chunk:
            item["gone"] = {}
        if not keep:
            return
        res = await _q(client, f"UNWIND $urns AS u MATCH (n:{label} {{urn: u}}) RETURN u, keys(n)",
                       params={"urns": [i["urn"] for i in chunk]},
                       timeout_ms=_READ_TIMEOUT_MS, read_only=True)
        held = {str(u): set(ks or []) for u, ks in (getattr(res, "result_set", None) or [])}
        for item in chunk:
            stale = held.get(item["urn"], set()) - keep - set(item["nativeProps"] or {})
            item["gone"] = {k: None for k in stale}

    async def _run_edge_deletes(self, client, edge_deletes, progress=None) -> None:
        """Typed + endpoint-anchored deletes for resolved entries (dicts);
        the legacy per-id scan only for ids whose before-state could not be
        resolved (shared by the incremental apply and the tombstone sweep)."""
        del_by: Dict[Tuple[str, str, str], list] = {}
        fallback: list = []
        for e in edge_deletes:
            if isinstance(e, dict):
                key = (
                    _sanitize_label(e.get("rel") or "REL"),
                    _sanitize_label(e.get("slb") or "Entity"),
                    _sanitize_label(e.get("tlb") or "Entity"),
                )
                del_by.setdefault(key, []).append(
                    {"eid": e["eid"], "src": e["src"], "tgt": e["tgt"]}
                )
            else:
                fallback.append(e)
        for (rel, sl, tl), items in del_by.items():
            for chunk in _batches(items, self._batch):
                await _q(client, _delete_edges_cypher(rel, sl, tl), params={"batch": chunk})
                if progress:
                    await progress(len(chunk))
        if fallback:
            logger.warning(
                "projection: %d edge delete(s) had no resolvable before-state — "
                "using the legacy per-id scan delete", len(fallback),
            )
            for chunk in _batches(fallback, self._batch):
                await _q(client, _DELETE_EDGES_FALLBACK, params={"ids": list(chunk)})
                if progress:
                    await progress(len(chunk))


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
