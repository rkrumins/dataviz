"""Per-server schema/index memo state, plus ``SchemaMixin``.

The two memo sets below moved unchanged from the pre-class section of the
former ``falkordb_provider.py`` (lines 49-54 as of the package move).

``SchemaMixin`` is carved from two non-contiguous blocks of
``FalkorDBProvider``'s class body as it stood before this split:
``_seed_from_file`` through ``ensure_indices`` (lines 67-301), and
``ensure_projections`` through ``_log_aggregation_index_health`` (lines
2149-2332, including their "Projection / Materialization Lifecycle Hooks"
comment header) — about 1,800 lines apart in the original file. The mixin
is the sole reader of both memo sets below; see ``docs/superpowers/plans/2026-08-30-pr1-falkordb-decoupling.md`` §2.2 for why this has
to be a mixin rather than a delegate/helper object.
"""
import asyncio
import json
import os
from typing import Dict, List, Optional

from backend.app.models.graph import GraphEdge, GraphNode
from backend.app.providers.falkordb._log import logger

# Per-server (host, port) facts we only need to discover / report ONCE, so onboarding
# many graphs against the same FalkorDB doesn't re-probe and re-log the same thing on
# every graph. Whether a FalkorDB build supports a label-less property index, and whether
# we've already logged its index-health summary, are server-level — not per-graph.
_UNLABELED_URN_UNSUPPORTED: set = set()
_INDEX_HEALTH_LOGGED: set = set()


class SchemaMixin:
    """Index creation and identity-URN stamping for the source and
    projection graphs, plus per-source graph seeding."""

    async def _seed_from_file(self):
        """Load graph from seed JSON file if graph is empty."""
        import os as _os
        path = self._seed_file
        if not path or not _os.path.exists(path):
            logger.warning(f"Seed file not found: {path}")
            return
        try:
            with open(path, "r") as f:
                data = json.load(f)
            nodes = [GraphNode(**n) for n in data.get("nodes", [])]
            edges = [GraphEdge(**e) for e in data.get("edges", [])]
            # Limit for large files
            if len(nodes) > 50000:
                nodes = nodes[:50000]
            if len(edges) > 100000:
                edges = edges[:100000]
            await self.save_custom_graph(nodes, edges)
            logger.info(f"Seeded {len(nodes)} nodes and {len(edges)} edges from {path}")
        except Exception as e:
            logger.error(f"Seed failed: {e}")

    async def stamp_identity_urns(self) -> int:
        """Stamp per-source CONFORMANCE properties onto every node that lacks them, so the entire
        urn-keyed write / index / read / trace stack works for an onboarded graph that keys nodes
        by e.g. ``id`` and names them under e.g. ``name`` instead of the platform's ``urn`` /
        ``displayName``.

        This is THE definitive fix. The AGGREGATED write and every read filter on the ``urn``
        PROPERTY (a ``MERGE`` cannot key on a ``coalesce`` expression), and the read stack renders
        ``displayName`` verbatim — so resolving identity only in the aggregation directory left
        in-source aggregation attaching ZERO edges, and a non-``displayName`` name rendered blank.
        Stamping both up front makes all of it work unchanged.

        * ``urn`` ← ``identity_property``  (only when it's a non-default property)
        * ``displayName`` ← ``name_property``  (piggybacks on the urn pass, or runs standalone only
          for a CUSTOM name property — a fully conforming source stays a complete no-op)

        Each stamped value records WHICH property it came from, in ``urnSource`` / ``nameSource``.
        That provenance is what makes the mapping editable rather than write-once: a fill-only pass
        can never rewrite a node it already stamped, so re-pointing a source from ``id`` to ``uuid``
        used to leave every existing node on the OLD identity forever, with no error and no way to
        tell from the graph which nodes were wrong. A node whose marker disagrees with the current
        mapping is now re-stamped from the new property.

        Safe: in-source projection only (never mutates a possibly read-only source behind a
        dedicated projection); a node with NO marker carried its own native ``urn`` /
        ``displayName`` and is never touched, so this can only ever overwrite values it wrote
        itself; batched by internal ID range (no property index needed); best-effort per batch.
        Idempotent — a re-run with an unchanged mapping only touches nodes added since the last
        one. Returns properties stamped.
        """
        ident = str(getattr(self, "_node_identity_property", None) or "urn").replace("`", "")
        name_prop = str(getattr(self, "_name_property", None) or "name").replace("`", "")
        stamp_urn = bool(ident) and ident != "urn"
        # Name-stamp piggybacks on a urn stamp, or runs standalone only for a non-default name
        # property — so a conforming (urn/displayName) source never triggers a write pass.
        stamp_name = bool(name_prop) and name_prop != "displayName" and (stamp_urn or name_prop != "name")
        if not stamp_urn and not stamp_name:
            return 0
        if getattr(self, "_projection_mode", None) == "dedicated":
            return 0  # projection is separate; don't write to the (maybe read-only) source
        await self._ensure_connected()
        try:
            res = await self._ro_query("MATCH (n) RETURN max(ID(n))", op="identity.max_id")
            rows = res.result_set or []
            max_id = int(rows[0][0]) if rows and rows[0] and rows[0][0] is not None else -1
        except Exception as exc:
            logger.warning(
                "FalkorDB %s: conformance stamp skipped — max-id probe failed: %s",
                self._graph_name, exc,
            )
            return 0
        if max_id < 0:
            return 0

        # Two cases per property:
        #   FILL     — the canonical value is missing, so take it from the source property;
        #   RE-POINT — we filled it before from a DIFFERENT property (the marker says so),
        #              so the mapping changed under us and the old value is stale.
        # A node with no marker and a value present is native data: excluded by both.
        #
        # The two properties are stamped in ONE pass (these are full scans; two passes would
        # double the cost on a multi-million-node graph), which means the WHERE matches a node
        # that qualifies for EITHER. Each SET is therefore guarded by its OWN condition — an
        # unguarded pair would let a node that only needed a displayName fill also have its
        # native urn overwritten.
        sets, wheres = [], []
        if stamp_urn:
            urn_cond = (
                f"((n.`urn` IS NULL OR (n.`urnSource` IS NOT NULL AND n.`urnSource` <> $ident)) "
                f"AND n.`{ident}` IS NOT NULL)"
            )
            sets.append(
                f"n.`urn` = CASE WHEN {urn_cond} THEN n.`{ident}` ELSE n.`urn` END, "
                f"n.`urnSource` = CASE WHEN {urn_cond} THEN $ident ELSE n.`urnSource` END"
            )
            wheres.append(urn_cond)
        if stamp_name:
            name_cond = (
                f"((n.`displayName` IS NULL OR (n.`nameSource` IS NOT NULL "
                f"AND n.`nameSource` <> $nameProp)) AND n.`{name_prop}` IS NOT NULL)"
            )
            sets.append(
                f"n.`displayName` = CASE WHEN {name_cond} THEN n.`{name_prop}` "
                f"ELSE n.`displayName` END, "
                f"n.`nameSource` = CASE WHEN {name_cond} THEN $nameProp ELSE n.`nameSource` END"
            )
            wheres.append(name_cond)
        set_clause = ", ".join(sets)
        where_clause = " OR ".join(wheres)

        width = 50_000
        stamped = 0
        lo = 0
        while lo <= max_id:
            hi = lo + width
            try:
                r = await self._query(
                    f"MATCH (n) WHERE ID(n) >= $lo AND ID(n) < $hi AND ({where_clause}) "
                    f"SET {set_clause}",
                    params={
                        "lo": lo, "hi": hi, "ident": ident, "nameProp": name_prop,
                    },
                    op="identity.stamp",
                )
                stamped += int(getattr(r, "properties_set", 0) or 0)
            except Exception as exc:
                logger.warning(
                    "FalkorDB %s: conformance stamp batch [%d,%d) failed (continuing): %s",
                    self._graph_name, lo, hi, exc,
                )
            lo = hi
        if stamped:
            logger.info(
                "FalkorDB %s: conformance stamp set %d propert(y/ies) (urn←%s, displayName←%s).",
                self._graph_name, stamped, ident if stamp_urn else "—",
                name_prop if stamp_name else "—",
            )
        return stamped

    async def ensure_indices(self, entity_type_ids: Optional[List[str]] = None):
        """Create indices for node labels and properties.

        When *entity_type_ids* is provided (e.g. from the resolved ontology),
        those labels are indexed in addition to the hardcoded defaults.

        The label/property policy lives in ``index_policy`` — shared with the
        alignment-analysis endpoint so its performance predictions can never
        drift from what is actually indexed here.
        """
        from backend.app.providers.index_policy import INDEXED_NODE_PROPS, indexed_labels

        labels = indexed_labels(entity_type_ids)
        # Remember the ontology vocabulary the indices were built for, so
        # label-union readers (get_nodes_by_layer) can anchor on the same
        # label set the label-scoped indexes actually cover.
        self._indexed_entity_type_ids = list(entity_type_ids or [])
        # Idempotent CREATE INDEX is fine if the index already exists.
        properties = list(INDEXED_NODE_PROPS)
        # Index the source's URN-equivalent too, so the identity-urn stamp's
        # NULL-urn lookup and any direct property access are index-backed rather
        # than full label scans. No-op when the source uses the default `urn`
        # (already in INDEXED_NODE_PROPS).
        _ident = getattr(self, "_node_identity_property", None)
        if _ident and _ident != "urn" and _ident not in properties:
            properties.append(_ident)

        _init_timeout = float(os.getenv("FALKORDB_INIT_TIMEOUT", "3"))
        # Failure accounting: "already indexed" is success (idempotent DDL);
        # everything else is collected and reported in ONE warning at the end
        # so a persistently failing CREATE INDEX (unsupported server version,
        # timeouts) is visible instead of silently swallowed. Still
        # best-effort — this method never raises; queries work unindexed.
        failures: list[str] = []

        async def _create_index(cypher: str) -> None:
            try:
                # Server-side timeout too — an abandoned DDL statement
                # must not keep burning FalkorDB CPU after the client
                # deadline fires.
                await asyncio.wait_for(
                    self._graph.query(
                        cypher, timeout=self._db_timeout_ms(_init_timeout),
                    ),
                    timeout=_init_timeout,
                )
            except Exception as exc:
                if self.dialect.is_index_exists_error(exc):
                    return
                failures.append(f"{cypher}: {type(exc).__name__}: {exc}")

        total = 0
        for label in labels:
            for prop in properties:
                total += 1
                await _create_index(self.dialect.create_node_index(label, prop))

        # Edge-property indices on :AGGREGATED powering the level-pair
        # fast path used by ``_expand_aggregated_set``. With these in
        # place, ``WHERE r.sourceLevel = $L AND r.targetLevel = $L``
        # becomes a composite index seek instead of a per-edge property
        # read after the rel-typed MATCH. Idempotent CREATE INDEX, best-
        # effort: older FalkorDB releases may not support edge-property
        # indices, in which case the trace continues to work via the
        # legacy neighbour-label scan fallback.
        # Composite index attempt first — when supported by the FalkorDB
        # version this is a single index seek on (sourceLevel, targetLevel)
        # rather than two single-column lookups OR-merged by the planner.
        # Idempotent; falls back to two single-column indices below if the
        # planner does not support composite edge indices.
        _agg_edge_type = self.dialect.aggregated_edge_type
        aggregated_edge_indices = [
            self.dialect.create_edge_index(_agg_edge_type, ("sourceLevel", "targetLevel")),
            self.dialect.create_edge_index(_agg_edge_type, ("sourceLevel",)),
            self.dialect.create_edge_index(_agg_edge_type, ("targetLevel",)),
            # Depth stamps (stampVersion>=2) are the PREFERRED read filters
            # (Q3 mixed-depth derivation, trace structural drill) — without
            # these they run as Conditional Traverse property reads.
            # Verified supported on FalkorDB v4.16.0 (WS0 D1 spike).
            self.dialect.create_edge_index(_agg_edge_type, ("sourceDepth", "targetDepth")),
            self.dialect.create_edge_index(_agg_edge_type, ("sourceDepth",)),
            self.dialect.create_edge_index(_agg_edge_type, ("targetDepth",)),
        ]
        for index_cypher in aggregated_edge_indices:
            total += 1
            await _create_index(index_cypher)

        if failures:
            logger.warning(
                "ensure_indices: %d/%d index statements failed (queries still "
                "work, unindexed). First failures: %s",
                len(failures), total, "; ".join(failures[:3]),
            )
        else:
            logger.debug("ensure_indices: %d index statements ensured", total)

    # ------------------------------------------------------------------ #
    # Projection / Materialization Lifecycle Hooks                         #
    # ------------------------------------------------------------------ #

    async def ensure_projections(self) -> None:
        """Create indices on the projection target for fast AGGREGATED reads
        and (critically) for the unlabeled MERGE that runs on the write path.

        The aggregation worker issues ``MERGE (s {urn: item.s})`` without a
        label. Per-label URN indexes (created in ``_initialize_indices``)
        don't help here — FalkorDB's planner can't fan out across labeled
        indexes for an unlabeled MATCH. Without a property-only URN index,
        every MERGE in the aggregation hot path becomes a full node scan,
        which is the root cause of the 200% CPU spikes observed on million-
        node graphs (one outer batch fans out to ~100 sub-batches × 500
        MERGEs, each scanning all nodes).

        FalkorDB versions vary on whether ``CREATE INDEX FOR (n) ON (n.urn)``
        without a label predicate is supported; we attempt it best-effort
        and fall through silently on older releases (the existing per-label
        URN indexes remain in place for labeled queries).
        """

        try:
            await self._proj_query(
                self.dialect.create_node_index(self.dialect.projection_label, "urn")
            )
        except Exception:
            pass  # Index may already exist

        # Label-less URN index. FalkorDB's openCypher requires a label on an index, so
        # `CREATE INDEX FOR (n) ON (n.urn)` is unsupported on every build — AND it is no
        # longer needed: every write/read hot path (bulk load, incremental MERGE, and the
        # AGGREGATED upsert at projection.py) is label-qualified and served by the per-label
        # URN indexes. Discover support ONCE PER SERVER so onboarding many graphs doesn't
        # re-attempt and re-log the same fallback on each graph (the recurring "falling back
        # to per-label indexes" noise).
        server = (self._host, self._port)
        if server not in _UNLABELED_URN_UNSUPPORTED:
            try:
                await self._proj_query(self.dialect.create_unlabeled_index("urn"))
            except Exception:
                _UNLABELED_URN_UNSUPPORTED.add(server)
                logger.info(
                    "FalkorDB %s:%s uses the labeled-index strategy (no label-less property "
                    "index on this build; every hot path is label-qualified and index-driven "
                    "via the per-label URN indexes). Expected — not a degradation.",
                    self._host, self._port,
                )

        # Index-health smoke probe: log the summary ONCE per server (not per onboarded
        # graph). Surfaces a genuinely missing index without spamming every reconcile.
        if server not in _INDEX_HEALTH_LOGGED:
            _INDEX_HEALTH_LOGGED.add(server)
            await self._log_aggregation_index_health()

    async def _log_aggregation_index_health(self) -> None:
        """Introspect the projection graph's index catalogue and log a
        one-line summary of AGGREGATED-relevant indexes.

        Runs ``CALL db.indexes()`` defensively (column order varies by
        FalkorDB version; row shape may differ on very old releases).
        Categorizes results into:

        - **labeled URN indexes**: ``(:Label) ON (n.urn)`` — drives every
          label-qualified MATCH in the bulk-rebuild path.
        - **unlabeled URN index**: ``() ON (n.urn)`` — drives the
          incremental MERGE path and the label-resolution fallback.
        - **AGGREGATED edge indexes**: ``()-[r:AGGREGATED]-() ON
          (r.sourceLevel ...)`` — drives the trace fast path.

        Never raises; never blocks startup. A missing index is reported
        at WARNING level so it surfaces in operator alerts.
        """
        try:
            res = await asyncio.wait_for(
                self._proj.ro_query(self.dialect.indexes_statement(), {}),
                timeout=2.0,
            )
        except Exception as exc:
            logger.info(
                "Index health probe on %s: CALL db.indexes() not "
                "available (%s) — skipping. Operator should verify "
                "indexes manually if aggregation perf is poor.",
                self._graph_name, exc,
            )
            return

        rows = res.result_set or []
        labeled_urn: List[str] = []
        unlabeled_urn = False
        aggregated_indexes: List[str] = []

        # Row-shape parsing (FalkorDB's historical column order: label,
        # properties, types, language, stopwords, entitytype, info; read
        # defensively because it varies by build) lives in
        # ``self.dialect.parse_index_rows`` now -- see that method's
        # docstring. What follows is the categorization that was always
        # specific to this health check, not to FalkorDB's column layout.
        for parsed in self.dialect.parse_index_rows(rows):
            # Edge index on AGGREGATED?
            if (
                parsed.is_edge_index
                and isinstance(parsed.label, str)
                and parsed.label.upper() == "AGGREGATED"
            ):
                aggregated_indexes.append(
                    f"({parsed.label} ON {parsed.props})"
                )
                continue

            # Node index on URN.
            if "urn" in parsed.props:
                if parsed.label:
                    labeled_urn.append(str(parsed.label))
                else:
                    unlabeled_urn = True

        if labeled_urn or unlabeled_urn or aggregated_indexes:
            logger.info(
                "Index health on %s: labeled_urn=%d (%s), "
                "unlabeled_urn=%s, aggregated_edge_indexes=%d (%s)",
                self._graph_name,
                len(labeled_urn),
                ",".join(sorted(set(labeled_urn))[:8])
                + ("..." if len(set(labeled_urn)) > 8 else ""),
                "present" if unlabeled_urn else "MISSING",
                len(aggregated_indexes),
                "; ".join(aggregated_indexes) or "none",
            )
        else:
            logger.warning(
                "Index health on %s: NO URN or AGGREGATED indexes detected. "
                "Aggregation will scan every node on every MERGE/MATCH — "
                "this is the 200%% CPU configuration. Verify "
                "_initialize_indices ran and the FalkorDB version supports "
                "the CREATE INDEX syntax in use.",
                self._graph_name,
            )

        if not unlabeled_urn:
            # Labeled-only is a fully supported strategy: every hot path
            # (ancestor chains, node directory, apply MERGEs, the
            # incremental write hook, on-demand reads) anchors on the
            # per-label URN indexes. Health depends only on whether every
            # ontology label is covered — warn on GAPS, not on the
            # server lacking unlabeled-index support.
            entity_levels: Dict[str, int] = getattr(self, "_entity_type_levels", None) or {}
            expected: set = set()
            for lbl in entity_levels:
                expected.update(self._alias_entity_types([lbl]))
            have = set(labeled_urn)
            missing = sorted(l for l in expected if l not in have)
            if missing:
                logger.warning(
                    "Index health on %s: no unlabeled URN index (server "
                    "does not support it) and %d ontology label(s) lack a "
                    "URN index: %s. Queries anchored on those labels will "
                    "scan — run ensure_indices / retrigger aggregation to "
                    "create them.",
                    self._graph_name, len(missing), ", ".join(missing[:8]),
                )
            else:
                logger.info(
                    "Index health on %s: labeled-only strategy active "
                    "(server lacks unlabeled-index support; every ontology "
                    "label has a URN index — job hot paths are index-"
                    "driven; bounded visible-set reads may still issue "
                    "single-scan queries).",
                    self._graph_name,
                )
