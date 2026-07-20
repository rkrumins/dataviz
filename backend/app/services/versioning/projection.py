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
from typing import Awaitable, Callable, Dict, List, Optional, Tuple

from sqlalchemy import func, literal, select

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
             *, timeout_ms: int = _WRITE_TIMEOUT_MS):
    """Run one query with a server-side kill budget AND a client-side hang
    net (belt over the pool-level socket timeouts, and the bound for client
    fakes without them). Falls back to the timeout-less call for client
    fakes/libs without the kwarg."""
    try:
        coro = client.query(cypher, params=params, timeout=timeout_ms)
    except TypeError:
        coro = client.query(cypher, params=params)
    return await asyncio.wait_for(coro, timeout=timeout_ms / 1000 + 10)


# --- Cypher (mirrors falkordb_provider.save_custom_graph; reader-compatible) --- #
def _node_merge_cypher(label: str) -> str:
    return (
        f"UNWIND $batch AS item MERGE (n:{label} {{urn: item.urn}}) "
        f"SET n.entityId = item.entityId, n.displayName = item.displayName, "
        f"n.qualifiedName = item.qualifiedName, n.description = item.description, "
        f"n.tags = item.tags, n.layerAssignment = item.layerAssignment, "
        f"n.childCount = item.childCount, n.sourceSystem = item.sourceSystem, "
        f"n.lastSyncedAt = item.lastSyncedAt, n.propertiesRaw = item.propertiesRaw, "
        f"n.level = coalesce(item.level, n.level), "
        f"n.searchableText = item.searchableText, n += item.nativeProps "
        f"REMOVE n.properties"
    )


def _edge_merge_cypher(rel_type: str, src_label: str, tgt_label: str) -> str:
    return (
        f"UNWIND $batch AS item "
        f"MATCH (a:{src_label} {{urn: item.src}}) "
        f"MATCH (b:{tgt_label} {{urn: item.tgt}}) "
        f"MERGE (a)-[r:{rel_type}]->(b) "
        f"SET r.id = item.eid, r.confidence = item.conf, r.properties = item.props"
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
               level_map: Optional[Dict[str, int]] = None) -> dict:
    native, residual = _split_user_properties(payload.get("properties"))
    dn = payload.get("displayName") or ""
    qn = payload.get("qualifiedName") or ""
    desc = payload.get("description") or ""
    # The node's hierarchy depth. `save_custom_graph` stamps this (from the ontology
    # entity-type→level map) and the trace level-pair filter reads it; the projector must
    # stamp the SAME value or a rebuild would drop it (COALESCE leaves it unset only when the
    # type has no mapped level — e.g. dedicated mode / no ontology — matching save_custom_graph).
    lvl = (level_map or {}).get(payload.get("entityType"))
    if lvl is None:
        lvl = payload.get("level")
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
            changes = await self._compute_changes(s, graph, main_id, from_seq, to_seq)
            total_items = sum(len(c) for c in changes)
            if from_seq <= 0:
                # Live rebuild progress: the total is known upfront (all items are computed
                # before the apply); per-chunk writes are throttled by _progress_writer.
                ps.progress_done = 0
                ps.progress_total = total_items
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

        try:
            # Inside the try: the factory does a real Postgres provider lookup + FalkorDB handle
            # build (a genuine suspension point), so a cancellation here must ALSO reset the
            # already-committed "projecting" row rather than strand it.
            client = await self._graph_client(name, provider_id)
            # Ontology entity-type→level map so projected nodes carry n.level (parity with
            # save_custom_graph). Best-effort: {} when unavailable, leaving level unset.
            level_map = await self._resolve_level_map(graph_id)
            progress = (self._progress_writer(graph_id, total_items)
                        if from_seq <= 0 and total_items else None)
            if from_seq <= 0:
                # NON-DESTRUCTIVE REBUILD — probe connectivity BEFORE the drop. A full seed DROPs the
                # graph key and can only re-seed it by MERGEing from Postgres, so dropping against an
                # unreachable/misrouted instance would WIPE the read cache with no way to repair it
                # ("rebuild wiped all data"). A trivial read (never touches the graph) proves the
                # resolved client is reachable; if it is not, the error propagates to the outer handler
                # (records last_error, resets status, re-raises) with NOTHING dropped — reads keep
                # falling back to Postgres and the existing cache is left intact.
                await _q(client, "RETURN 1", timeout_ms=_READ_TIMEOUT_MS)
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
                    # wipe genuinely FAILED: proceeding to the MERGE-only apply would run on top of
                    # stale contents (a merged draft's DELETES would survive — "merge reverts to old
                    # state") and cannot repair the wipe. RAISE so the outer handler records the error,
                    # leaves the watermark unmoved, and reads fall back to Postgres — never a MERGE
                    # over a broken drop. Keep the fresh-key case distinct so it still proceeds.
                    if "empty key" in str(exc).lower():
                        logger.debug("full-seed wipe: FalkorDB graph %r for %s did not exist yet "
                                     "(fresh); MERGE will create it", name, graph_id)
                    else:
                        raise
            await self._apply(client, *changes, progress=progress, level_map=level_map)
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

            # Reconcile PG (SoR) vs FalkorDB (cache) and bounded-heal a dropped delta before
            # the watermark advances, so the cache can't silently diverge from committed main.
            verify_error, heal_reseeded = (
                await self._verify_and_heal(client, graph_id, main_id, from_seq, to_seq, is_fork,
                                            level_map=level_map)
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
                    # cache. Pin target down to the un-advanced seq so the poll loop
                    # (project_pending: projected < target) stops re-running a deterministic-fail
                    # seed; a manual rebuild (request_projection_rebuild re-arms target=head) or a
                    # new commit retries it.
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

        # Rollups can't be maintained incrementally past this projection: a full seed (or the
        # verify-heal reseed) WIPED them with the graph, or a containment move / bulk window /
        # overlapping application exceeded what incremental maintenance can reconcile. Hand
        # off to the app layer to queue a scoped aggregation rebuild (fires after the
        # watermark is durable, so the rebuild sees the projected raw edges).
        # Gated on `published`: aggregating over — or nudging insights for — an unfaithful seed
        # that was NOT published (reads still serve Postgres) would build rollups on top of a
        # known-bad raw layer. A later successful rebuild re-fires this (full seed ⇒ from_seq<=0).
        if published and self._on_rollups_stale is not None and (
                from_seq <= 0 or rollup_pairs == "stale" or heal_reseeded):
            try:
                await self._on_rollups_stale(graph_id)
            except Exception as exc:                   # pragma: no cover - infra
                logger.warning("rollup-rebuild hook failed for %s: %s", graph_id, exc)

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
        if published and (from_seq <= 0 or heal_reseeded) and workspace_id and data_source_id:
            try:
                from backend.app.services.resolved_ontology_cache import bump_ontology_generation
                await bump_ontology_generation(workspace_id, data_source_id)
            except Exception as exc:                   # pragma: no cover - infra
                logger.warning("ontology-generation bump after rebuild failed for %s: %s",
                               graph_id, exc)

        applied = sum(len(c) for c in changes)
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
                if p is None or not _is_edge_payload(p):
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
                    if p is None:
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
            # A bulk-sized window (import/sync commit) is the aggregation JOB's territory —
            # doing the pair math inline would stall the projector. Hand off to the rebuild.
            return "stale"
        if not lineage_creates and not lineage_deletes and not moved:
            return None

        anc_cache: Dict[Tuple[str, Optional[int]], Tuple[List[str], Dict[str, List[str]]]] = {}
        lvl_cache: Dict[Tuple[str, Optional[int]], Optional[int]] = {}

        async def chain(node_id: str, as_of: Optional[int]) -> Tuple[List[str], Dict[str, List[str]]]:
            """(ancestors-or-self ids, child→ALL-parents multimap) — the
            parent DAG the shared pair rules rank on. Multi-parent nodes
            keep every ancestry (the old single-slot map silently dropped
            all but the last-seen parent)."""
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
                ids = {i for pair in cube for i in pair}
                lv = await levels_of(ids, as_of) if ids else {}
                depths = {**t_cl, **s_cl}
                for sx, tx in cube:
                    e = pairs.setdefault(
                        (sx, tx), {"dw": 0, "dwc": 0, "types": set()},
                    )
                    e["dw"] += sign
                    if (sx, tx) in canon:
                        e["dwc"] += sign
                    sl, tl = lv.get(sx), lv.get(tx)
                    if sl is not None and tl is not None:
                        e["sl"], e["tl"] = sl, tl
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

        pairs = {
            k: v for k, v in pairs.items()
            if v["dw"] != 0 or v.get("dwc", 0) != 0
        }
        if not pairs:
            return None
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
                       timeout_ms=_READ_TIMEOUT_MS)
        marker = int(res.result_set[0][0]) if getattr(res, "result_set", None) else 0
        if marker >= to_seq:
            return True                                  # whole window already applied (retry no-op)
        if marker > from_seq:
            return False                                 # partial/foreign overlap — rebuild, don't guess

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
                           timeout_ms=_READ_TIMEOUT_MS)
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
                 "key": f"{s_}|{t_}", "seq": to_seq,
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
                    params={"batch": chunk}, timeout_ms=_READ_TIMEOUT_MS)
                existing = {}
                for s_, t_, w, types, gv in (getattr(res, "result_set", None) or []):
                    existing[(s_, t_)] = (int(w or 0), list(types or []), int(gv or 0))
                upserts, deletes = [], []
                for item in chunk:
                    k = (item["s"], item["t"])
                    w0, types0, gv = existing.get(k, (0, [], 0))
                    if gv >= item["seq"]:
                        continue                         # already applied (same-window retry)
                    if gv > from_seq:
                        return False                     # partial overlap — rebuild, don't guess
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
        # Marker written only after EVERY chunk landed — a mid-apply crash leaves it behind
        # the watermark, so the retry re-applies with per-pair gvSeq stamps de-duplicating.
        await _q(client,
                 "MERGE (m:_GVRollupMeta {id: 'meta'}) SET m.seq = $seq",
                 params={"seq": to_seq})
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
        self, client, graph_id, main_id, from_seq, to_seq, is_fork, level_map=None
    ) -> Tuple[Optional[str], bool]:
        """Reconcile live node/edge COUNTS between Postgres (SoR) and FalkorDB after an
        apply, and — on a FULL SEED — additionally CONTENT-verify (id-set + deep fields), since
        counts alone are blind to a dropped/mistyped edge or a node reseeded with a wrong label /
        empty displayName. Best-effort (any count failure → skip). Two mismatch directions:

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
            # Counts match — but on a full seed that is NOT sufficient (content drift keeps the
            # counts). Run the content verify; None unless it finds drift (or not a full seed).
            return (await self._full_seed_content_error(client, graph_id, main_id, from_seq)), False
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
            # Incremental window that dropped a committed delta: reseed the FULL live state once,
            # idempotently, then re-verify. A FULL seed (from_seq==0) is NOT reseeded here — it just
            # DID the full DROP+reseed, so a shortfall is deterministic and re-running reproduces it;
            # it falls through to the mismatch error below and the caller HOLDS THE WATERMARK BACK
            # (reads stay on Postgres) rather than looping. A count-clean full seed still gets the
            # content verify at the `pg == fk` branch above.
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
                await self._apply(client, *seed, level_map=level_map)
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

    async def _full_seed_content_error(
        self, client, graph_id, main_id, from_seq
    ) -> Optional[str]:
        """Content verify for a FULL SEED whose COUNTS already matched: id-set + deep-field diff of
        the freshly-seeded cache vs committed main, via the reconciler's guard-free primitives
        against the open client. Returns an error string on ANY drift (a dropped/mistyped edge, a
        node reseeded with a wrong label or empty displayName — the class counts can't see), else
        None. No-op off the full-seed path or when disabled. Best-effort: a diff-infra failure
        degrades to None (counts already passed), never raises."""
        if from_seq > 0 or not config.PROJECTION_VERIFY_DEEP:
            return None
        try:
            from .reconcile import ProjectionReconciler
            rec = ProjectionReconciler(self._session, lambda name, provider_id=None: client)
            mn, xn, me, xe, mm = await rec.content_drift(client, graph_id, main_id)
        except Exception:                                # pragma: no cover - infra
            logger.debug("full-seed content verify skipped for %s (diff failed)",
                         graph_id, exc_info=True)
            return None
        if mn or xn or me or xe or mm:
            msg = (f"content drift after full seed: {len(mn)} missing node(s), "
                   f"{len(xn)} extra node(s), {len(me)} missing edge(s), {len(xe)} extra edge(s), "
                   f"{len(mm)} field mismatch(es) (bounded sample) — cache NOT published")
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
        # Nodes in (grouped by label), edges in (grouped by type + endpoint
        # labels — the per-label URN indexes drive every node match), edges
        # out, nodes out.
        by_label: Dict[str, list] = {}
        for eid, urn, p in node_upserts:
            by_label.setdefault(_sanitize_label(p.get("entityType") or "Entity"), []).append(
                _node_item(eid, urn, p, level_map)
            )
        for label, items in by_label.items():
            for chunk in _batches(items, self._batch):
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
            by_rel.setdefault(key, []).append(_edge_item(eid, su, tu, p))
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
