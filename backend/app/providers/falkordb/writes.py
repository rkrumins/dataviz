"""FalkorDB casing consistency and the write/mutation surface — ``WriteMixin``.

Carved from ``backend/app/providers/falkordb/provider.py``'s
``FalkorDBProvider`` class body as it stood before this split: the "TTL
for the observed-casing maps below..." comment header through
``delete_edge`` (lines 10806-11233), a single contiguous block — the
``_TYPE_CASING_TTL_S`` doc-comment moved with the constant it heads.

This mixin holds the provider's write path: the TTL-cached observed-casing
maps and ``_consistent_casing`` that keep a bulk load's labels/relationship
types spelled consistently, ``_bulk_write_batch`` (polls and retries a
batch through a FalkorDB reload window rather than logging "batch failed"
and silently dropping it while reporting success), ``save_custom_graph``,
and the single-node/edge ``create_node`` / ``create_edge`` / ``update_edge``
/ ``delete_edge`` mutations. ``list_graphs`` and ``close`` are not here —
they moved with ``ConnectionMixin`` in an earlier task. See
``docs/superpowers/plans/2026-08-30-pr1-falkordb-decoupling.md`` §2.2
for why this has to be a mixin rather than a delegate/helper object.
"""
import asyncio
import json
import os
import time
from collections import defaultdict
from typing import Any, Dict, List, Optional, Tuple

from backend.app.models.graph import GraphEdge, GraphNode
from backend.app.providers.falkordb._log import logger
from backend.app.providers.falkordb.errors import (
    _is_loading_error,
    _is_transient_connection_error,
)
from backend.app.providers.falkordb.rowmap import (
    _compute_searchable_text,
    _edge_from_row,
    _sanitize_label,
    _split_user_properties,
)


class WriteMixin:
    """Casing-consistency helpers plus the bulk and single-item write
    path: batch creation, custom-graph save, and node/edge CRUD."""

    # TTL for the observed-casing maps below. Long enough to amortize the
    # vocabulary probe across a bulk load's many calls; short enough that
    # an out-of-band writer's new spelling is picked up quickly.
    _TYPE_CASING_TTL_S = 60.0

    async def _type_casing_maps(self) -> Tuple[Dict[str, str], Dict[str, str]]:
        """``casefold(name) → observed spelling`` for relationship types and
        labels, TTL-cached per provider instance. Newly-written spellings are
        added to the cached maps by ``_consistent_casing`` so consistency
        holds across calls inside the TTL window. Probe failure ⇒ empty maps
        (write-as-given) — casing consistency must never block a write."""
        now = time.monotonic()
        cached = getattr(self, "_casing_maps_cache", None)
        if cached is not None and now - cached[0] < self._TYPE_CASING_TTL_S:
            return cached[1], cached[2]
        rels: Dict[str, str] = {}
        labels: Dict[str, str] = {}
        try:
            # Bare form deliberate (not the dialect's YIELD/RETURN form) --
            # both are pinned separately in the golden; see falkordb/dialect.py.
            res = await self._ro_query("CALL db.relationshipTypes()")
            for row in (res.result_set or []):
                if row and row[0]:
                    rels.setdefault(str(row[0]).casefold(), str(row[0]))
            # Bare form deliberate here too -- see the comment above.
            res = await self._ro_query("CALL db.labels()")
            for row in (res.result_set or []):
                if row and row[0]:
                    labels.setdefault(str(row[0]).casefold(), str(row[0]))
        except Exception as exc:
            logger.debug(
                "type-casing vocabulary probe failed (%s) — writing types "
                "as given this window", exc,
            )
        self._casing_maps_cache = (now, rels, labels)
        return rels, labels

    @staticmethod
    def _consistent_casing(name: str, fold_map: Dict[str, str]) -> str:
        """The graph's canonical spelling for ``name``: an already-observed
        case-fold variant wins (FalkorDB matches types/labels case-
        sensitively — a second casing fragments one logical type across two
        relation matrices, and a differently-cased label makes MERGE mint a
        DUPLICATE of an existing urn node); a genuinely new spelling is
        recorded and becomes canonical for subsequent writes."""
        got = fold_map.get(name.casefold())
        if got is not None:
            return got
        fold_map[name.casefold()] = name
        return name

    async def _bulk_write_batch(self, cypher: str, params: dict, *, what: str) -> None:
        """Execute ONE bulk-load write batch, waiting out a FalkorDB restart/loading instead
        of dropping it.

        This is the line between a resumable multi-million-row load and silently losing data.
        A large load can OOM-restart the server (or trip an AOF rewrite); it comes back in a
        LOADING state that rejects writes for many seconds while it replays its dataset into
        memory. The old code caught that error, logged "batch failed", and moved on — so every
        batch during the reload window was dropped while the caller still saw success. Here we
        instead POLL until the server is ready and retry the SAME batch, and RAISE once the wait
        budget is spent so the caller fails loudly with an accurate progress count. Real errors
        (bad cypher, constraint) are never retried — they raise immediately."""
        try:
            max_wait = float(os.getenv("FALKORDB_LOAD_MAX_WAIT_S", "900"))   # a big graph can take minutes to reload
        except ValueError:
            max_wait = 900.0
        try:
            delay = float(os.getenv("FALKORDB_LOAD_RETRY_BASE_S", "0.5"))
        except ValueError:
            delay = 0.5
        waited = 0.0
        attempt = 0
        while True:
            attempt += 1
            try:
                await self._query(cypher, params=params)
                if attempt > 1:
                    logger.info(
                        "FalkorDB %s: %s written after waiting %.0fs for the server to come back.",
                        self._graph_name, what, waited,
                    )
                return
            except Exception as exc:
                # ProviderUnavailable covers ProviderLoading (its subclass). Anything else that
                # is a transient connection / redis-loading error is also worth waiting out.
                from backend.common.adapters import ProviderUnavailable
                recoverable = (
                    isinstance(exc, ProviderUnavailable)
                    or _is_loading_error(exc)
                    or _is_transient_connection_error(exc)
                )
                if not recoverable or waited >= max_wait:
                    logger.error(
                        "FalkorDB %s: %s could not be written (%s) after %.0fs — aborting the "
                        "load instead of dropping the batch.",
                        self._graph_name, what, type(exc).__name__, waited,
                    )
                    raise
                await asyncio.sleep(delay)
                waited += delay
                delay = min(delay * 1.5, 5.0)
                try:
                    await self._ensure_connected()   # rebuild the handle a restart invalidated
                except Exception:
                    pass                             # the next _query re-attempts the connection

    async def save_custom_graph(
        self, nodes: List[GraphNode], edges: List[GraphEdge],
        endpoint_labels: Optional[Dict[str, str]] = None,
    ) -> bool:
        """Batch-save nodes and edges using UNWIND for bulk writes.

        Groups nodes by label (entity type) so each UNWIND+MERGE targets
        a single label — enabling index-assisted lookups. Turns N individual
        queries into ceil(N/batch_size) queries per label.

        Edges are likewise grouped by (relationship type, source label, target
        label) so the endpoint MATCH carries a label and hits the per-label urn
        index (``Node By Index Scan``) instead of an ``All Node Scan`` — the
        difference between ~180k and ~90 edges/s on a large graph. Endpoint
        labels are resolved from the nodes saved in THIS call plus the optional
        ``endpoint_labels`` (urn→entityType) the caller supplies for edges whose
        endpoints were saved in a previous call (the importer's separate node/
        edge passes). An endpoint with no known label falls back to a label-less
        MATCH (correct, just unindexed) — never a dropped edge.

        ``FALKORDB_SAVE_BATCH_SIZE`` tunes the UNWIND batch size (default
        2000, clamped 100-10000): larger batches amortize parse/plan
        overhead on multi-million-row initial loads; smaller ones bound
        single-query time on constrained instances.
        """
        await self._ensure_connected()
        try:
            batch_size = max(100, min(10000, int(os.getenv("FALKORDB_SAVE_BATCH_SIZE", "2000"))))
        except ValueError:
            batch_size = 2000

        # Observed-casing maps: everything this call CREATES is written in
        # the graph's existing casing (or mints the canonical one) so one
        # logical type/label never fragments across case variants.
        rel_casing, label_casing = await self._type_casing_maps()

        # Group nodes by label for label-specific MERGE
        nodes_by_label: Dict[str, list] = defaultdict(list)
        for node in nodes:
            label = self._consistent_casing(
                _sanitize_label(str(node.entity_type)), label_casing,
            )
            native_props, residual_blob = _split_user_properties(node.properties)
            nodes_by_label[label].append({
                "urn": node.urn,
                "displayName": node.display_name or "",
                "qualifiedName": node.qualified_name or "",
                "description": node.description or "",
                "nativeProps": native_props,
                "propertiesRaw": residual_blob,
                "tags": json.dumps(node.tags or []),
                "layerAssignment": node.layer_assignment or "",
                "childCount": node.child_count or 0,
                "sourceSystem": node.source_system or "",
                "lastSyncedAt": node.last_synced_at or "",
                "level": self._get_node_level(node.entity_type),
                "searchableText": _compute_searchable_text(
                    node.display_name, node.qualified_name,
                    node.description, native_props, tags=node.tags,
                ),
            })

        # Ensure per-label URN indexes BEFORE the writes: node MERGE and
        # edge MATCH both look up by urn, and without the index each row
        # is a label scan. Once per provider instance — CREATE INDEX is
        # idempotent but there's no point re-issuing DDL per chunk.
        if nodes_by_label and not getattr(self, "_save_indices_ensured", False):
            try:
                await self.ensure_indices(list(nodes_by_label.keys()))
                self._save_indices_ensured = True
            except Exception as exc:
                logger.warning(
                    "save_custom_graph: ensure_indices failed (continuing; "
                    "writes will be slower without URN indexes): %s", exc,
                )

        # Bulk-cache urn→label mappings
        label_mapping = {}
        for label, items in nodes_by_label.items():
            for item in items:
                label_mapping[item["urn"]] = label
            for i in range(0, len(items), batch_size):
                batch = items[i : i + batch_size]
                try:
                    # Notes on the SET / REMOVE shape:
                    # - `n += item.nativeProps` merges user-supplied scalar
                    #   properties as real node fields. Merge semantics —
                    #   keys that disappear across upserts are NOT removed
                    #   (delete via an explicit op if needed). This matches
                    #   how every other reserved field is upserted here.
                    # - `n.propertiesRaw` always written (always a string,
                    #   "{}" when empty) so we don't need a separate REMOVE
                    #   round-trip when the residual goes empty.
                    # - `REMOVE n.properties` strips the legacy blob on
                    #   every write so the read-path transitional code
                    #   becomes dead weight as soon as a node is touched.
                    # - `n.level = coalesce(item.level, n.level)` keeps the
                    #   pre-refactor semantics: if the engine hasn't
                    #   injected the entity-type→level map yet (seed-from-
                    #   file before ontology resolution), level stays as-is.
                    await self._bulk_write_batch(
                        f"UNWIND $batch AS item "
                        f"MERGE (n:{label} {{urn: item.urn}}) "
                        f"SET n.displayName = item.displayName, "
                        f"n.qualifiedName = item.qualifiedName, "
                        f"n.description = item.description, "
                        f"n.tags = item.tags, "
                        f"n.layerAssignment = item.layerAssignment, "
                        f"n.childCount = item.childCount, "
                        f"n.sourceSystem = item.sourceSystem, "
                        f"n.lastSyncedAt = item.lastSyncedAt, "
                        f"n.propertiesRaw = item.propertiesRaw, "
                        f"n.level = coalesce(item.level, n.level), "
                        f"n.searchableText = item.searchableText, "
                        f"n += item.nativeProps "
                        f"REMOVE n.properties",
                        {"batch": batch},
                        what=f"node batch :{label}",
                    )
                except Exception as e:
                    logger.error(f"Node merge failed for label {label}: {e}")
                    raise
        await self._cache_urn_labels_bulk(label_mapping)

        # urn → label for endpoint MATCH: same-call nodes (authoritative) over
        # the caller-supplied map (endpoints saved in a prior call). Resolve ONLY the
        # endpoints referenced by THIS call's edges — ``endpoint_labels`` can be the whole
        # graph (millions of urns), so iterating/sanitizing all of it per call is O(graph)
        # per batch (~1.4s/10k-chunk at 2M nodes → ~11min of pure Python for a 5M-edge
        # load). A small value cache avoids re-sanitizing the handful of distinct labels.
        referenced = {u for e in edges for u in (e.source_urn, e.target_urn)}
        urn_label: Dict[str, str] = {}
        _san_cache: Dict[str, str] = {}
        for urn in referenced:
            lbl = label_mapping.get(urn)          # already sanitized (same-call node)
            if lbl is None and endpoint_labels:
                raw = endpoint_labels.get(urn)
                if raw is not None:
                    lbl = _san_cache.get(raw)
                    if lbl is None:
                        lbl = _sanitize_label(str(raw))
                        _san_cache[raw] = lbl
            if lbl is not None:
                urn_label[urn] = lbl

        # Endpoints still unknown (edges into nodes saved in a prior call
        # with no caller-supplied label): resolve through the urn→label
        # cache / graph in one bulk pass so they hit the indexed MATCH
        # too; anything unresolvable keeps the label-less fallback below.
        unknown = list(referenced - set(urn_label))
        if unknown:
            try:
                resolved = await self._resolve_urn_labels_bulk(unknown)
                urn_label.update(
                    {u: lbl for u, lbl in resolved.items() if lbl}
                )
            except Exception as exc:
                logger.warning(
                    "save_custom_graph: bulk urn→label resolve failed (%s) — "
                    "%d endpoint(s) fall back to unlabeled matches",
                    exc, len(unknown),
                )

        # Group edges by (relationship type, source label, target label) so each
        # UNWIND's endpoint MATCH is label-qualified (index-eligible). A None label
        # means "unknown endpoint" → label-less MATCH (correct, unindexed fallback).
        edges_grouped: Dict[tuple, list] = defaultdict(list)
        for edge in edges:
            rel_type = self._consistent_casing(
                _sanitize_label(str(edge.edge_type)), rel_casing,
            )
            key = (rel_type, urn_label.get(edge.source_urn), urn_label.get(edge.target_urn))
            edges_grouped[key].append({
                "src": edge.source_urn,
                "tgt": edge.target_urn,
                "eid": edge.id,
                "conf": edge.confidence,
                "props": json.dumps(edge.properties),
            })

        for (rel_type, src_label, tgt_label), items in edges_grouped.items():
            a_pat = f"(a:{src_label} {{urn: item.src}})" if src_label else "(a {urn: item.src})"
            b_pat = f"(b:{tgt_label} {{urn: item.tgt}})" if tgt_label else "(b {urn: item.tgt})"
            for i in range(0, len(items), batch_size):
                batch = items[i : i + batch_size]
                await self._bulk_write_batch(
                    f"UNWIND $batch AS item "
                    f"MATCH {a_pat} "
                    f"MATCH {b_pat} "
                    f"MERGE (a)-[r:{rel_type}]->(b) "
                    f"SET r.id = item.eid, r.confidence = item.conf, "
                    f"r.properties = item.props",
                    {"batch": batch},
                    what=f"edge batch :{rel_type}",
                )

        return True

    async def create_node(self, node: GraphNode, containment_edge: Optional[GraphEdge] = None) -> bool:
        await self._ensure_connected()
        try:
            rel_casing, label_casing = await self._type_casing_maps()
            label = self._consistent_casing(
                _sanitize_label(str(node.entity_type)), label_casing,
            )
            native_props, residual_blob = _split_user_properties(node.properties)
            # Reserved fields go into the merge map alongside native user
            # props — `SET n += $p` writes them all in one pass. The native
            # user props sit at the top level of the map (they ARE the new
            # node fields); the legacy blob is stripped via REMOVE.
            params: Dict[str, Any] = {
                "displayName": node.display_name or "",
                "qualifiedName": node.qualified_name or "",
                "description": node.description or "",
                "propertiesRaw": residual_blob,
                "tags": json.dumps(node.tags or []),
                "layerAssignment": node.layer_assignment or "",
                "sourceSystem": node.source_system or "",
                "lastSyncedAt": node.last_synced_at or "",
                "searchableText": _compute_searchable_text(
                    node.display_name, node.qualified_name,
                    node.description, native_props, tags=node.tags,
                ),
            }
            if node.child_count is not None:
                params["childCount"] = node.child_count
            # Only include level when the engine has injected the mapping;
            # otherwise omit the key so SET n += $p doesn't overwrite an
            # existing level with null.
            level = self._get_node_level(node.entity_type)
            if level is not None:
                params["level"] = level
            # Merge native user props on top — they become real node
            # fields. Reserved-key collisions were already dropped by
            # _split_user_properties so this is safe.
            params.update(native_props)
            await self._query(
                f"MERGE (n:{label} {{urn: $urn}}) SET n += $p REMOVE n.properties",
                params={"urn": node.urn, "p": params},
            )
            await self._cache_urn_label(node.urn, label)
            if containment_edge:
                rel_type = self._consistent_casing(
                    _sanitize_label(str(containment_edge.edge_type)), rel_casing,
                )
                await self._query(
                    f"""
                    MATCH (a {{urn: $src}}) MATCH (b {{urn: $tgt}})
                    MERGE (a)-[r:{rel_type}]->(b)
                    SET r.id = $eid, r.confidence = $conf, r.properties = $props
                    """,
                    params={
                        "src": containment_edge.source_urn,
                        "tgt": containment_edge.target_urn,
                        "eid": containment_edge.id,
                        "conf": containment_edge.confidence,
                        # Write r.properties like every other edge writer — it was omitted here, so a
                        # containment edge created with properties lost them until the next rebuild.
                        "props": json.dumps(containment_edge.properties or {}),
                    },
                )
            return True
        except Exception as e:
            logger.error(f"create_node failed: {e}")
            return False

    async def create_edge(self, edge: GraphEdge) -> bool:
        """Create a single edge in FalkorDB."""
        await self._ensure_connected()
        try:
            rel_casing, _ = await self._type_casing_maps()
            rel_type = self._consistent_casing(
                _sanitize_label(str(edge.edge_type)), rel_casing,
            )
            await self._query(
                f"MATCH (a {{urn: $src}}) MATCH (b {{urn: $tgt}}) "
                f"MERGE (a)-[r:{rel_type}]->(b) "
                f"SET r.id = $eid, r.confidence = $conf, r.properties = $props",
                params={
                    "src": edge.source_urn,
                    "tgt": edge.target_urn,
                    "eid": edge.id,
                    # Pass confidence through RAW (may be None) — matching save_custom_graph, the
                    # projector reseed, and create_node's containment edge. `edge.confidence or 1.0`
                    # silently rewrote a legitimate 0.0 (and None) to 1.0, fabricating a value the
                    # rebuild round-trip would then treat as real.
                    "conf": edge.confidence,
                    "props": json.dumps(edge.properties or {}),
                },
            )
            return True
        except Exception as e:
            logger.error(f"create_edge failed: {e}")
            return False

    async def update_edge(self, edge_id: str, properties: Dict[str, Any]) -> Optional[GraphEdge]:
        """Update edge properties by edge ID."""
        await self._ensure_connected()
        try:
            result = await self._query(
                "MATCH (a)-[r]->(b) WHERE r.id = $eid "
                "SET r.properties = $props "
                "RETURN a.urn, b.urn, type(r), properties(r)",
                params={"eid": edge_id, "props": json.dumps(properties)},
            )
            if not result.result_set:
                return None
            row = result.result_set[0]
            return _edge_from_row(row[0], row[1], row[2], row[3] or {})
        except Exception as e:
            logger.error(f"update_edge failed: {e}")
            return None

    async def delete_edge(self, edge_id: str) -> bool:
        """Delete an edge by its ID property."""
        await self._ensure_connected()
        try:
            result = await self._query(
                "MATCH ()-[r]->() WHERE r.id = $eid DELETE r RETURN count(r)",
                params={"eid": edge_id},
            )
            if result.result_set and result.result_set[0][0] > 0:
                return True
            return False
        except Exception as e:
            logger.error(f"delete_edge failed: {e}")
            return False
