"""FalkorDB schema/ontology statistics and the counts fast-path — ``StatsMixin``.

Carved from ``backend/app/providers/falkordb/provider.py``'s
``FalkorDBProvider`` class body as it stood before this split: the
"Schema-level caches are persisted in Postgres..." comment header through
``get_distinct_values`` (lines 10123-10673), a single contiguous block —
the ``_SCHEMA_CACHE_TTL`` doc-comment moved with the constant it heads.

This mixin holds the schema/ontology introspection surface: ``get_stats``
and ``get_schema_stats`` (full scans, Redis-cached), ``get_counts_fast``
(the O(schema)-not-O(graph) path that answers an unfiltered ``count()``
from FalkorDB's label/relation matrices with no scan operator at all —
lost the moment a projection like ``labels(n)[0]`` joins the query, which
is exactly why ``get_stats`` is the slow one), ``get_ontology_metadata``,
``get_node_degrees``, and ``get_distinct_values``. ``get_counts_fast`` and
``prime_stats_cache`` are reached via ``getattr`` from the insights
collector and the reconcile sweeper; ``get_node_degrees`` from
``ContextEngine`` — all public, all must stay reachable, and none of
``get_counts_fast``'s queries may gain a projection. See carve-protocol.md
in ``.superpowers/sdd/2026-08-30-pr1-falkordb-decoupling/`` for why this
has to be a mixin rather than a delegate/helper object.
"""
import json
import os
from typing import Any, Dict, List, Optional, Set

from backend.app.models.graph import (
    EdgeTypeMetadata,
    EdgeTypeSummary,
    EntityTypeHierarchy,
    EntityTypeSummary,
    GraphSchemaStats,
    OntologyMetadata,
    TagSummary,
)
from backend.common.interfaces.provider import ProviderConfigurationError
from backend.app.providers.falkordb._log import logger
from backend.app.providers.falkordb.rowmap import _sanitize_label


class StatsMixin:
    """Schema/ontology statistics: full-scan stats, the no-scan counts
    fast-path, ontology metadata, node degrees, and distinct values."""

    # Schema-level caches are persisted in Postgres by the stats service;
    # this in-memory Redis layer is just a short-term memoization for
    # repeated calls within a polling interval. Default 300s (5 min) —
    # matches the stats service poll interval. Set to 0 to disable.
    _SCHEMA_CACHE_TTL = int(os.getenv("FALKORDB_SCHEMA_CACHE_TTL", "300"))

    async def get_stats(self, bypass_cache: bool = False) -> Dict[str, Any]:
        """Node/edge counts + per-type breakdowns (two grouped scans).

        ``bypass_cache=True`` skips the Redis cache READ but still
        writes-through on success — for refresh paths (the insights
        counts poll) that must never persist pre-aged cached counts as
        fresh, while still priming the cache for other callers.
        """
        await self._ensure_connected()

        # Check Redis cache (best-effort; Postgres is the source of truth)
        cache_key = f"{self._cache_ns}:stats_cache"
        if self._SCHEMA_CACHE_TTL > 0 and not bypass_cache:
            try:
                cached = await self._redis.get(cache_key)
                if cached:
                    return json.loads(cached)
            except Exception:
                pass

        # Empty / never-created graphs raise "Invalid graph operation on
        # empty key" on GRAPH.RO_QUERY — a valid 0-node / 0-edge state, not
        # an outage. Tolerate it so discovery reports the asset as empty
        # rather than the whole provider as down.
        entity_type_counts: Dict[str, Any] = {}
        node_count = 0
        edge_type_counts: Dict[str, Any] = {}
        edge_count = 0
        # The node/edge count scans are O(nodes)+O(edges) — on a million-edge
        # graph they exceed the 5s read default and the stats refresh fails
        # (then the asset shows stale). Give them a dedicated, generous
        # timeout so a cache-miss scan can complete and warm {graph}:stats_cache.
        _stats_q_timeout = float(os.getenv("FALKORDB_STATS_QUERY_TIMEOUT_SECS", "30"))
        try:
            # Optimize: Combine node counting with type aggregation
            type_res = await self._ro_query(
                "MATCH (n) RETURN labels(n)[0] AS lbl, count(*) AS c",
                timeout=_stats_q_timeout,
            )
            for row in (type_res.result_set or []):
                lbl = row[0] or "unknown"
                cnt = row[1]
                entity_type_counts[lbl] = cnt
                node_count += cnt

            # Optimize: Combine edge counting with type aggregation
            edge_type_res = await self._ro_query(
                "MATCH ()-[r]->() RETURN type(r) AS t, count(*) AS c",
                timeout=_stats_q_timeout,
            )
            for row in (edge_type_res.result_set or []):
                t = row[0] or "UNKNOWN"
                cnt = row[1]
                edge_type_counts[t] = cnt
                edge_count += cnt
        except Exception as exc:
            if not await self._is_verified_missing_graph(exc):
                raise
            logger.info(
                "get_stats on %s: graph key does not exist yet (empty graph) "
                "— returning zero stats.", self._graph_name,
            )
            entity_type_counts, node_count = {}, 0
            edge_type_counts, edge_count = {}, 0

        result = {
            "nodeCount": node_count,
            "edgeCount": edge_count,
            "entityTypeCounts": entity_type_counts,
            "edgeTypeCounts": edge_type_counts,
        }

        if self._SCHEMA_CACHE_TTL > 0:
            try:
                await self._redis.setex(cache_key, self._SCHEMA_CACHE_TTL, json.dumps(result))
            except Exception:
                pass

        return result

    async def get_counts_fast(self) -> Optional[Dict[str, Any]]:
        """Same payload as :meth:`get_stats`, without scanning the graph.

        FalkorDB's ``reduce_count`` optimization answers ``count()`` over an
        unfiltered pattern from the label/relation matrix counters — the plan
        is ``Results / Project`` with no scan operator at all. Projecting
        ``labels(n)[0]`` or ``type(r)`` alongside the count is what loses it,
        which is exactly what ``get_stats`` does and why its two queries cost
        ~514ms on a 500k-node / 850k-edge graph where this costs ~1.3ms.

        So the per-type breakdown comes from the schema catalogue
        (``db.labels()`` / ``db.relationshipTypes()``, both O(#types)) plus one
        constant-time count each. **Never add a projection to these queries.**

        Cost is ``4 + labels + types`` round trips and is therefore constant in
        the SIZE of the graph but linear in the size of its SCHEMA — the exact
        inverse of ``get_stats``. On a small graph with a wide schema the two
        converge; the win is on the large graphs that forced the 900s poll
        interval in the first place.

        Returns ``None`` — not an error — when the counts cannot be trusted,
        so the caller falls back to :meth:`get_stats`. That happens when the
        label counts sum ABOVE the node total, which means multi-label nodes:
        per-label counting then double-counts relative to ``labels(n)[0]``
        semantics. Our own writers are single-label by construction
        (``MERGE (n:{label} {urn: …})``) but an external loader need not be.
        """
        await self._ensure_connected()

        async def _count(cypher: str) -> int:
            res = await self._ro_query_tolerant(cypher, op="probe.count")
            rows = res.result_set or []
            return int(rows[0][0] or 0) if rows and rows[0] else 0

        async def _catalogue(cypher: str) -> List[str]:
            res = await self._ro_query_tolerant(cypher, op="probe.catalogue")
            return [row[0] for row in (res.result_set or []) if row and row[0]]

        labels = await _catalogue(self.dialect.labels_statement())
        rel_types = await _catalogue(self.dialect.relationship_types_statement())
        node_count = await _count("MATCH (n) RETURN count(n)")
        edge_count = await _count("MATCH ()-[r]->() RETURN count(r)")

        # Zero-count buckets are DROPPED, not reported. The catalogue keeps
        # listing a label/type after its last row is deleted, where get_stats
        # simply returns no row for it — and a {"Ghost": 0} key hashes
        # differently from an absent one, so keeping it would read as drift on
        # the first probe of every graph that ever deleted a type.
        entity_type_counts: Dict[str, Any] = {}
        for label in labels:
            safe = str(label).replace("`", "")
            count = await _count(f"MATCH (n:`{safe}`) RETURN count(n)")
            if count:
                entity_type_counts[label] = count

        edge_type_counts: Dict[str, Any] = {}
        for rel_type in rel_types:
            safe = str(rel_type).replace("`", "")
            count = await _count(f"MATCH ()-[r:`{safe}`]->() RETURN count(r)")
            if count:
                edge_type_counts[rel_type] = count

        label_sum = sum(entity_type_counts.values())
        if label_sum > node_count:
            logger.info(
                "get_counts_fast on %s: label counts sum to %d over %d nodes "
                "(multi-label graph) — deferring to the full scan",
                self._graph_name, label_sum, node_count,
            )
            return None
        if label_sum < node_count:
            # Unlabelled nodes: invisible to per-label counts, and get_stats
            # buckets them under `labels(n)[0] or "unknown"`. Deriving the
            # remainder reproduces that bucket exactly.
            entity_type_counts["unknown"] = node_count - label_sum

        # An edge carries exactly one type, so unlike nodes there is no honest
        # remainder to attribute. A disagreement means the catalogue is not
        # describing this graph; refuse rather than report a wrong shape.
        if sum(edge_type_counts.values()) != edge_count:
            logger.info(
                "get_counts_fast on %s: edge-type counts sum to %d over %d "
                "edges — deferring to the full scan",
                self._graph_name, sum(edge_type_counts.values()), edge_count,
            )
            return None

        result = {
            "nodeCount": node_count,
            "edgeCount": edge_count,
            "entityTypeCounts": entity_type_counts,
            "edgeTypeCounts": edge_type_counts,
        }
        # Same payload get_stats would have produced, so priming its cache
        # keeps the two from disagreeing for the TTL.
        await self.prime_stats_cache(result)
        return result

    async def prime_stats_cache(self, stats: Dict[str, Any]) -> None:
        """Write-through prime of the ``{graph}:stats_cache`` Redis key.

        Called by the insights collector after a poll derives fresh
        counts (from ``get_schema_stats``), so subsequent ``get_stats``
        callers — per-asset discovery, web-tier data-source stats —
        serve poll-fresh values instead of re-scanning. Best-effort.
        """
        if self._SCHEMA_CACHE_TTL <= 0:
            return
        await self._ensure_connected()
        try:
            await self._redis.setex(
                f"{self._cache_ns}:stats_cache",
                self._SCHEMA_CACHE_TTL,
                json.dumps(stats),
            )
        except Exception:
            pass

    async def get_schema_stats(self) -> GraphSchemaStats:
        await self._ensure_connected()
        
        entity_stats = []
        total_nodes = 0
        edge_stats = []
        total_edges = 0
        # Empty / never-created graph → valid empty schema, not an outage.
        _stats_q_timeout = float(os.getenv("FALKORDB_STATS_QUERY_TIMEOUT_SECS", "30"))
        try:
            # Single query: counts + samples per label using collect() with slicing
            type_res = await self._ro_query(
                "MATCH (n) "
                "WITH labels(n)[0] AS lbl, n.displayName AS name "
                "WITH lbl, count(*) AS c, collect(name)[0..3] AS samples "
                "RETURN lbl, c, samples",
                timeout=_stats_q_timeout,
            )
            for row in (type_res.result_set or []):
                lbl = row[0] or "unknown"
                if str(lbl).startswith("_"):
                    # System-internal labels (_AggMeta run metadata,
                    # _Projection scaffolding) — not user entity types;
                    # surfacing them puts phantom types in the ontology
                    # wizard.
                    continue
                cnt = row[1]
                samples = [s for s in (row[2] or []) if s]
                total_nodes += cnt
                entity_stats.append(EntityTypeSummary(id=lbl, name=lbl, count=cnt, sampleNames=samples))

            edge_type_res = await self._ro_query(
                "MATCH ()-[r]->() RETURN type(r) AS t, count(*) AS c",
                timeout=_stats_q_timeout,
            )
            for row in (edge_type_res.result_set or []):
                t = row[0] or "UNKNOWN"
                cnt = row[1]
                edge_stats.append(EdgeTypeSummary(id=t, name=t, count=cnt))
                total_edges += cnt
        except Exception as exc:
            if not await self._is_verified_missing_graph(exc):
                raise
            logger.info(
                "get_schema_stats on %s: graph key does not exist yet "
                "(empty graph) — returning empty schema.", self._graph_name,
            )
            return GraphSchemaStats(
                totalNodes=0, totalEdges=0,
                entityTypeStats=[], edgeTypeStats=[], tagStats=[],
            )

        # Tag stats — a full node scan like the two above; give it the
        # same generous stats budget (it previously ran on the default
        # connection timeout and was the silent killer on large graphs).
        try:
            tag_res = await self._ro_query(
                "MATCH (n) WHERE n.tags IS NOT NULL AND n.tags <> '[]' RETURN n.tags",
                timeout=_stats_q_timeout,
            )
            tag_counts: Dict[str, int] = {}
            tag_types: Dict[str, Set[str]] = {}
            for row in (tag_res.result_set or []):
                tags_raw = row[0]
                try:
                    tags = json.loads(tags_raw) if isinstance(tags_raw, str) else (tags_raw or [])
                except Exception:
                    continue
                for tag in tags:
                    tag_counts[tag] = tag_counts.get(tag, 0) + 1
                    if tag not in tag_types:
                        tag_types[tag] = set()
                    tag_types[tag].add("entity")
            tag_stats = [TagSummary(tag=t, count=c, entityTypes=list(tag_types.get(t, {"entity"}))) for t, c in tag_counts.items()]
        except Exception as e:
            logger.warning(f"Failed to fetch tag stats: {e}")
            tag_stats = []

        return GraphSchemaStats(
            totalNodes=total_nodes,
            totalEdges=total_edges,
            entityTypeStats=entity_stats,
            edgeTypeStats=edge_stats,
            tagStats=tag_stats,
        )

    async def get_ontology_metadata(self) -> OntologyMetadata:
        """
        Build ontology metadata including containment and lineage roles.
        Optimized to use Cypher aggregations instead of full scans.
        Cached in Redis with 60s TTL — ontology rarely changes.
        """
        await self._ensure_connected()

        cache_key = f"{self._cache_ns}:ontology_cache"
        if self._SCHEMA_CACHE_TTL > 0:
            try:
                cached = await self._redis.get(cache_key)
                if cached:
                    cached_meta = OntologyMetadata(**json.loads(cached))
                    # Keep the sync case-fold floor (_alias_rel_types) warm even
                    # on a cache hit: the metadata's edge-type keys ARE the
                    # observed physical spellings, so trace/top-level resolve
                    # declared→physical correctly without re-probing the graph.
                    self._observed_rel_types = set(cached_meta.edge_type_metadata or {})
                    return cached_meta
            except Exception:
                pass

        # Introspection must NOT depend on containment having been injected.
        # ``_resolve_ontology`` calls this method BEFORE ``_inject_resolved`` on a
        # fresh provider, and ``_get_containment_edge_types`` raises when the set
        # isn't configured yet. Letting that raise here aborts the whole
        # introspection (observed vocabulary discovery below), which leaves the
        # per-source case-alias map empty on the FIRST resolve — so declared
        # UPPER_SNAKE types get injected verbatim into case-sensitive Cypher and
        # match nothing (a flat hierarchy on a freshly-onboarded data source).
        # Containment here is only a classification hint for the observed types;
        # treat "not configured yet" as empty and let the rest run.
        try:
            containment = list(self._get_containment_edge_types())
        except ProviderConfigurationError:
            containment = []
        containment_upper = {t.upper() for t in containment}
        
        # 1. Determine Lineage Types
        # db.relationshipTypes() reads the graph schema catalog — O(#types),
        # no edge scan. The DISTINCT type(r) scan (O(#edges): ~1s per million
        # edges, and this runs on every ontology-cache miss) remains only as
        # a fallback for engines without the procedure. The catalog can list
        # types whose last edge was deleted — harmless here: downstream
        # classification treats the list as "observed vocabulary" and a
        # stale entry simply classifies an absent type.
        all_types: List[str] = []
        try:
            type_res = await self._ro_query_tolerant(
                self.dialect.relationship_types_statement(),
                op="ontology.reltypes",
            )
            all_types = [row[0] for row in (type_res.result_set or []) if row and row[0]]
        except Exception as exc:
            logger.debug("db.relationshipTypes() unavailable (%s) — falling back to edge scan", exc)
        if not all_types:
            type_res = await self._ro_query_tolerant(
                "MATCH ()-[r]->() RETURN DISTINCT type(r)", op="ontology.edge_scan",
            )
            all_types = [row[0] for row in (type_res.result_set or [])]

        # Feed the sync case-fold floor (_alias_rel_types) the observed
        # vocabulary discovered here (catalog ∪ edge-scan fallback), so every
        # read-path consumer resolves declared→physical case variants without
        # depending on the injected per-source alias map being non-empty.
        self._observed_rel_types = {str(t) for t in all_types if t}

        # Use ontology-resolved edge metadata if available, otherwise fall back to heuristics
        resolved_meta = getattr(self, "_resolved_edge_metadata", None)
        resolved_lineage = getattr(self, "_resolved_lineage_types", None)

        if resolved_meta is not None and resolved_lineage is not None:
            # Ontology-driven classification
            lineage_types = [t for t in all_types if t.upper() in resolved_lineage]
        else:
            # Heuristic fallback (pre-ontology or no ontology)
            config_lineage = os.getenv("LINEAGE_EDGE_TYPES", "").strip()
            if config_lineage:
                lineage_types = [t.strip() for t in config_lineage.split(",") if t.strip()]
            else:
                config_metadata = os.getenv("METADATA_EDGE_TYPES", "").strip()
                metadata_types = {t.strip().upper() for t in config_metadata.split(",") if t.strip()} if config_metadata else set()
                lineage_types = []
                for t in all_types:
                    if t.upper() not in containment_upper and t.upper() not in metadata_types and t.upper() != "AGGREGATED":
                        lineage_types.append(t)

        lineage_upper = {t.upper() for t in lineage_types}

        # 2. Build Edge Metadata
        edge_type_metadata: Dict[str, EdgeTypeMetadata] = {}
        for et in all_types:
            et_upper = et.upper()
            is_containment = et_upper in containment_upper
            is_lineage = et_upper in lineage_upper

            # Prefer resolved ontology metadata for direction/category
            if resolved_meta and et_upper in resolved_meta:
                meta = resolved_meta[et_upper]
                direction = meta.get("direction", "bidirectional") if isinstance(meta, dict) else getattr(meta, "direction", "bidirectional")
                category = meta.get("category", "association") if isinstance(meta, dict) else getattr(meta, "category", "association")
            elif is_containment:
                category = "structural"
                direction = "parent-to-child"
            elif is_lineage:
                category = "flow"
                direction = "source-to-target"
            else:
                category = "association"
                direction = "bidirectional"

            edge_type_metadata[et] = EdgeTypeMetadata(
                isContainment=is_containment,
                isLineage=is_lineage,
                direction=direction,
                category=category,
                description=f"{category} relationship: {et}",
            )

        # 3. Build Entity Hierarchy
        # Query containment relationships directly
        hierarchy_cypher = (
            "MATCH (p)-[r]->(c) "
            "WHERE type(r) IN $containment "
            "RETURN DISTINCT labels(p)[0], labels(c)[0], type(r)"
        )
        hierarchy_res = await self._ro_query_tolerant(
            hierarchy_cypher,
            params={"containment": containment}
        )
        
        entity_type_hierarchy: Dict[str, EntityTypeHierarchy] = {}
        found_parent_types = set()
        found_child_types = set()
        
        for row in (hierarchy_res.result_set or []):
            p_type, c_type, r_type = row[0], row[1], row[2]
            if not p_type or not c_type: continue
            
            # Normalize for direction
            meta = edge_type_metadata.get(r_type)
            if meta and meta.direction == "child-to-parent":
                parent_t, child_t = c_type, p_type
            else:
                parent_t, child_t = p_type, c_type
                
            if parent_t not in entity_type_hierarchy:
                entity_type_hierarchy[parent_t] = EntityTypeHierarchy(canContain=[], canBeContainedBy=[])
            if child_t not in entity_type_hierarchy:
                entity_type_hierarchy[child_t] = EntityTypeHierarchy(canContain=[], canBeContainedBy=[])
                
            if child_t not in entity_type_hierarchy[parent_t].can_contain:
                entity_type_hierarchy[parent_t].can_contain.append(child_t)
            if parent_t not in entity_type_hierarchy[child_t].can_be_contained_by:
                entity_type_hierarchy[child_t].can_be_contained_by.append(parent_t)
                
            found_parent_types.add(parent_t)
            found_child_types.add(child_t)

        root_entity_types = list(found_parent_types - found_child_types)

        result = OntologyMetadata(
            containmentEdgeTypes=containment,
            lineageEdgeTypes=lineage_types,
            edgeTypeMetadata=edge_type_metadata,
            entityTypeHierarchy=entity_type_hierarchy,
            rootEntityTypes=root_entity_types,
        )

        if self._SCHEMA_CACHE_TTL > 0:
            try:
                await self._redis.setex(cache_key, self._SCHEMA_CACHE_TTL, result.model_dump_json())
            except Exception:
                pass

        return result

    async def get_node_degrees(
        self, urns: List[str], edge_types: Optional[List[str]] = None,
    ) -> Dict[str, Dict[str, int]]:
        """TOTAL lineage degree (in/out) per URN over the FULL graph.

        The canvas subtracts its loaded (internal) degree from these
        totals to derive how much lineage lies OUTSIDE the current
        view's scope — the "no lineage" vs "lineage outside this view"
        distinction for curated subset views. Per-node adjacency
        aggregates (never a set-membership XOR over all edges), with
        label-bucketed URN seeks so no bucket falls back to a full node
        scan.

        Semantics: a URN ABSENT from the result is UNKNOWN (its bucket's
        query failed) — callers must not treat absence as zero. URNs in
        a successfully-queried bucket that simply have no edges are
        explicitly zero-filled.
        """
        out: Dict[str, Dict[str, int]] = {}
        if not urns:
            return out
        await self._ensure_connected()
        rel_alt = "|".join(_sanitize_label(t) for t in (edge_types or []) if t)
        rel_frag = f":{rel_alt}" if rel_alt else ""
        for label, bucket_urns in await self._label_buckets(urns):
            lbl_frag = f":{label}" if label else ""
            bucket_ok = True
            counts: Dict[str, Dict[str, int]] = {}
            for direction, pattern in (
                ("out", f"(n{lbl_frag})-[r{rel_frag}]->()"),
                ("in", f"(n{lbl_frag})<-[r{rel_frag}]-()"),
            ):
                cypher = (
                    f"MATCH {pattern} WHERE n.urn IN $urns "
                    "RETURN n.urn AS urn, count(r) AS c"
                )
                try:
                    result = await self._ro_query(
                        cypher, params={"urns": bucket_urns}, timeout=2.0,
                        op="node_degrees",
                    )
                except Exception as exc:
                    logger.warning(
                        "get_node_degrees %s failed (%d urns, label=%r): %s",
                        direction, len(bucket_urns), label, exc,
                    )
                    bucket_ok = False
                    break
                for row in (result.result_set or []):
                    counts.setdefault(str(row[0]), {"in": 0, "out": 0})[direction] = int(row[1] or 0)
            if not bucket_ok:
                continue  # absent = unknown, never zero
            for urn in bucket_urns:
                out[urn] = counts.get(urn, {"in": 0, "out": 0})
        return out

    async def get_distinct_values(self, property_name: str) -> List[Any]:
        await self._ensure_connected()
        if property_name in ("entityType", "entitytype"):
            res = await self._ro_query("MATCH (n) RETURN DISTINCT labels(n)[0] AS lbl")
            return [row[0] for row in (res.result_set or []) if row[0]]
        if property_name == "tags":
            res = await self._ro_query("MATCH (n) RETURN n.tags")
            seen = set()
            for row in (res.result_set or []):
                raw = row[0]
                try:
                    tags = json.loads(raw) if isinstance(raw, str) else (raw or [])
                    for t in tags:
                        seen.add(t)
                except Exception:
                    pass
            return list(seen)
        safe_prop = "".join(c for c in property_name if c.isalnum() or c == "_") or "urn"
        try:
            res = await self._ro_query(
                f"MATCH (n) WHERE n.{safe_prop} IS NOT NULL RETURN DISTINCT n.{safe_prop} AS v LIMIT 100"
            )
            return [row[0] for row in (res.result_set or [])]
        except Exception:
            return []
