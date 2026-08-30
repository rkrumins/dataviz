"""FalkorDB ontology/containment configuration — ``OntologyMixin``.

Carved from ``backend/app/providers/falkordb/provider.py``'s
``FalkorDBProvider`` class body as it stood before this split: the ``name``
property through ``_extract_node_from_result`` (lines 303-755), a single
contiguous block that immediately followed ``SchemaMixin``'s first block.
Includes the ``TRACE_DEGREE_CAP`` class attribute — its only reader is in
the trace area of ``provider.py``; it resolves through the MRO, so it is
not duplicated there.

This mixin owns the per-source ontology configuration injected by
``ContextEngine`` / the aggregation worker after ontology resolution
(containment edge types, entity-type levels, resolved edge metadata,
source-vocabulary aliases, node identity) and the containment/alias
helpers built on it. See ``docs/superpowers/plans/2026-08-30-pr1-falkordb-decoupling.md`` §2.2 for why this has
to be a mixin rather than a delegate/helper object.
"""
import asyncio
import os
from typing import Any, Dict, List, Optional, Set, Tuple

from backend.app.models.graph import GraphNode
from backend.common.interfaces.provider import ProviderConfigurationError
from backend.app.providers.falkordb._log import logger
from backend.app.providers.falkordb.rowmap import _sanitize_label, _node_from_props


class OntologyMixin:
    """Per-source ontology configuration (containment types, entity-type
    levels, edge metadata, vocabulary aliases, node identity) injected by
    ContextEngine / the aggregation worker, and the containment/alias
    helpers built on it."""

    @property
    def name(self) -> str:
        return "FalkorDBProvider"

    def set_containment_edge_types(self, types: List[str], from_ontology: bool = True) -> None:
        """Called by ContextEngine after ontology resolution to inject the
        authoritative containment edge types from the resolver.

        Parameters
        ----------
        types : list
            The containment edge types. Empty list means the ontology explicitly
            defines no containment types (flat graph, no hierarchy).
        from_ontology : bool
            True if these came from a real ontology definition (assigned or system).
            False if from introspection-only — an empty list should NOT suppress
            the hardcoded fallback.

        Cache invalidation is implicit: the ancestors cache key
        (``_ancestors_cache_key``) hashes the resolved type set, so a
        change to ``types`` automatically routes reads/writes to a
        different Redis namespace. No manual flush is needed; old
        namespaces are simply unreachable and lazy-evicted by Redis.
        """
        if from_ontology or types:
            self._resolved_containment_types: Set[str] = {t.upper() for t in types}
            self._resolved_containment_types_set = True
        # else: introspection-only with no containment found — don't set sentinel

    def set_entity_type_levels(self, mapping: Dict[str, int]) -> None:
        """Called by ContextEngine after ontology resolution to inject the
        entity-type → hierarchy.level mapping. Used both at write time
        (populates ``n.level`` on upsert for the level index) and at read
        time (resolves levels via ``labels(n)[0]`` so trace queries work
        even when ``n.level`` hasn't been backfilled on existing nodes).

        Also computes a ``levelDigest`` over the map. AGGREGATED edges
        stamp this digest at materialization time; the cold-start probe
        compares stamped digests to the current one to decide whether
        backfill is needed. When the digest changes (ontology edited),
        we re-trigger the probe so the staleness state refreshes without
        a process restart.
        """
        from backend.app.services.ontology_levels import compute_level_digest

        self._entity_type_levels: Dict[str, int] = dict(mapping)
        new_digest = compute_level_digest(self._entity_type_levels)

        if new_digest != self._level_digest:
            self._level_digest = new_digest
            # New digest → re-probe in the background. Don't block here;
            # the probe runs against the graph and we don't want
            # ontology resolution to wait for it.
            try:
                asyncio.create_task(self._check_levels_backfilled())
            except RuntimeError:
                # No running loop (rare — usually only in synchronous
                # test paths). The probe will run on first trace.
                pass

    def _get_node_level(self, entity_type: Any) -> Optional[int]:
        """Resolve a node's hierarchy level from the cached mapping. Returns
        None when ontology hasn't been resolved or the entity type is unknown
        — backfill or read-time fallback handles those cases.
        """
        mapping = getattr(self, "_entity_type_levels", None)
        if not mapping:
            return None
        return mapping.get(str(entity_type))

    # Per-frontier-node AGGREGATED out-degree cap. When a single node has
    # more aggregated peers than this, the BFS keeps the top-N by weight
    # and emits a MegaNodeInfo so the frontend can render a "+N more"
    # chip. Override via env. Default 5000 — high enough that legitimate
    # hub Domains (lots of underlying lineage) aren't truncated.
    TRACE_DEGREE_CAP: int = int(os.getenv("TRACE_DEGREE_CAP", "5000"))

    async def _check_levels_backfilled(self) -> None:
        """Probe: are :AGGREGATED edges stamped with the CURRENT level digest?

        Sets ``self._levels_backfilled`` to ``True | False``:
          - True  → all edges carry ``r.levelDigest == self._level_digest``
                    → the level-pair fast path can be trusted.
          - False → some edges are missing the digest or carry a stale one
                    (ontology drifted) → the trace path falls back to the
                    label-scan codepath for those edges (correct, slower).

        Logs at most once per (provider lifetime, digest) pair via
        ``_levels_warning_for_digest`` — re-runs with the same digest stay
        quiet. A new digest (ontology edit) re-arms the warning.

        Traces are never refused — the legacy label-scan codepath returns
        correct results during backfill windows. Refusing would break every
        trace whenever the ontology changes.

        Best-effort: if the level map hasn't been injected yet, or the
        probe itself fails (FalkorDB not ready), we leave the flag as None
        and a later call will re-probe.
        """
        digest = self._level_digest
        if not digest:
            # No level map yet — backfilled status is undefined.
            return

        try:
            result = await asyncio.wait_for(
                self._graph.query(
                    "MATCH ()-[r:AGGREGATED]->() "
                    "WHERE r.levelDigest IS NULL OR r.levelDigest <> $digest "
                    "RETURN count(r) AS stale LIMIT 1",
                    params={"digest": digest},
                ),
                timeout=3.0,
            )
            rows = getattr(result, "result_set", None) or []
            stale = int(rows[0][0]) if rows and rows[0] else 0
            self._levels_backfilled = (stale == 0)
            if stale > 0 and self._levels_warning_for_digest != digest:
                logger.warning(
                    "trace: %d AGGREGATED edges have stale or missing "
                    "levelDigest (current=%s) — run "
                    "backfill_aggregated_levels.py to refresh stamps",
                    stale, digest[:12],
                )
                self._levels_warning_for_digest = digest
        except Exception as exc:
            logger.warning("trace: levels_backfilled check failed: %s", exc)
            # Leave None — probed again on demand if needed

    async def _resolve_root_anchor(
        self, urn: str, ctypes: List[str],
    ) -> Tuple[str, int]:
        """Walk containment UP to the absolute Root (a node with no incoming
        containment edge). Returns ``(root_urn, root_level)``.

        Used by skeleton-first trace when ``level=0``: regardless of
        starting nesting depth, we end up at the topmost reachable
        ancestor. When no level-0 ancestor exists (orphan), we return
        the highest level actually reached — caller surfaces this as
        ``meta.fallbackLevel``.

        Cycle-safe: the variable-length walk uses a node-uniqueness
        predicate so a self-referencing typedef ``CONTAINS`` edge can't
        cause runaway expansion.
        """
        if not ctypes:
            # No containment configured — focus is its own root.
            return urn, -1

        max_depth = max(len(getattr(self, "_entity_type_levels", {}) or {}), 10)
        # Find topmost containment ancestor — the deepest reachable walk
        # via incoming containment edges. We use `*1..N` (not `*0..N`)
        # because FalkorDB's planner trips on zero-length paths in the
        # filtered form. Handle the "focus is already top" case with
        # COALESCE on the outer query (anc is null → return focus).
        # The focus anchor is label-qualified via the urn→label cache
        # (urn-index seek, not an All-Node-Scan), and the containment
        # types are a pattern ALTERNATION so the walk never expands
        # non-containment edges at all (the old ALL(rel IN c …) filter
        # expanded EVERY edge type then discarded mismatches).
        focus_label = await self._get_cached_label(urn)
        f_anchor = (
            f"(focus:{_sanitize_label(focus_label)} {{urn: $urn}})"
            if focus_label else "(focus {urn: $urn})"
        )
        c_alt = "|".join(_sanitize_label(t) for t in ctypes if t)
        cypher = (
            f"MATCH {f_anchor} "
            f"OPTIONAL MATCH (focus)<-[c:{c_alt}*1..{max_depth}]-(anc) "
            "WITH focus, anc, size(c) AS depth "
            "ORDER BY depth DESC LIMIT 1 "
            "RETURN COALESCE(anc.urn, focus.urn) AS urn, "
            "       COALESCE(anc.level, focus.level, -1) AS level"
        )
        try:
            result = await self._ro_query(
                cypher, params={"urn": urn}, timeout=1.5, op="trace.root_anchor",
            )
            rows = result.result_set or []
            if rows and rows[0]:
                root_urn = rows[0][0] or urn
                lvl = rows[0][1]
                level = int(lvl) if lvl is not None else -1
                return root_urn, level
        except Exception as exc:
            logger.warning("trace: root anchor resolution failed for %s: %s", urn, exc)
        return urn, -1

    def _types_at_level(self, level: int) -> List[str]:
        """Return entity-type IDs whose ontology hierarchy.level == ``level``.

        Used by trace/expand to filter via ``labels(n)[0] IN $typesAtLevel``
        instead of ``n.level = $level`` — the label-based filter works
        immediately on every existing graph (labels are written at upsert),
        whereas ``n.level`` only works after backfill_node_levels.py runs.
        """
        mapping = getattr(self, "_entity_type_levels", None) or {}
        return [t for t, lvl in mapping.items() if lvl == level]

    async def set_projection_mode(self, mode: str) -> None:
        """Dynamically switch the projection target for aggregation operations.

        Because provider instances are cached and shared across data sources,
        projection_mode cannot be baked into the constructor.  The aggregation
        worker calls this per-job to route AGGREGATED edges to the correct
        graph (source or dedicated ``{graph_name}_proj``).

        Must be called AFTER ``_ensure_connected()`` so ``self._db`` is ready.
        """
        await self._ensure_connected()
        old = self._projection_mode
        self._projection_mode = mode
        if mode == "dedicated":
            if self._proj_graph is None:
                proj_name = f"{self._graph_name}_proj"
                if self._conn_cfg is not None and self._conn_cfg.mode == "cluster":
                    # {graph}_proj may hash to a DIFFERENT shard than {graph}, so it
                    # needs its own owning-node client — reusing self._db would send
                    # the AGGREGATED writes to the wrong node (MOVED/CROSSSLOT).
                    # Same routing _ensure_connected does when the mode is known at
                    # connect time; this path is the per-job switch.
                    from backend.app.providers.falkordb_connection import (
                        build_graph_client,
                    )
                    socket_timeout = self._graph_socket_timeout()
                    self._proj_db, self._proj_pool = await build_graph_client(
                        self._conn_cfg,
                        graph_name=proj_name,
                        pool_kwargs=self._build_pool_kwargs(socket_timeout),
                    )
                    self._proj_graph = self._proj_db.select_graph(proj_name)
                else:
                    self._proj_graph = self._db.select_graph(proj_name)
        else:
            # Switching back to in_source — clear proj_graph so _proj returns _graph
            self._proj_graph = None
        logger.info(
            "Projection mode changed %s → %s for graph %s",
            old, mode, self._graph_name,
        )

    def set_admission_controller(self, controller: Optional[Any]) -> None:
        """Inject the distributed write-admission controller for aggregation
        writes (see ``backend.app.services.aggregation.admission``). Called
        per-job by the aggregation worker; pass None to detach."""
        self._admission_controller = controller

    def set_resolved_edge_metadata(
        self,
        edge_type_metadata: Dict[str, Any],
        lineage_edge_types: List[str],
    ) -> None:
        """Called by ContextEngine after ontology resolution to inject the
        authoritative edge classification from the resolver.
        When set, get_ontology_metadata() uses this instead of
        re-deriving from env vars and hardcoded type names.
        """
        self._resolved_edge_metadata = {k.upper(): v for k, v in edge_type_metadata.items()}
        self._resolved_lineage_types: Set[str] = {t.upper() for t in lineage_edge_types}
        self._resolved_edge_metadata_set = True

    def set_source_type_aliases(
        self,
        relationship_aliases: Dict[str, List[str]],
        entity_aliases: Optional[Dict[str, List[str]]] = None,
    ) -> None:
        """Per-source vocabulary alignment (Task E): ``UPPER(declared) → [observed
        spelling(s)]`` for types the graph spells differently than the ontology
        declares. Injected by ``ContextEngine._resolve_ontology`` from live
        introspection. FalkorDB matches relationship types / labels case-SENSITIVELY,
        so a ``[:HAS]`` pattern misses a ``has`` graph; :meth:`_alias_rel_types`
        translates declared → observed at the single point a type set becomes Cypher.

        Empty maps (governed/canonical graphs, where observed == declared) make the
        translation an identity. Always call this on resolution so a stale alias set
        from a prior ontology can't leak into the next query."""
        self._source_rel_aliases: Dict[str, List[str]] = {
            str(k).upper(): [str(s) for s in v] for k, v in (relationship_aliases or {}).items()}
        self._source_entity_aliases: Dict[str, List[str]] = {
            str(k).upper(): [str(s) for s in v] for k, v in (entity_aliases or {}).items()}

    def set_node_identity(
        self,
        identity_property: Optional[str] = None,
        name_property: Optional[str] = None,
    ) -> None:
        """Per-source node-identity mapping: which physical property plays the
        role of ``urn``, and which holds the human name.

        Resolved across all four scopes by
        ``backend.app.services.node_identity`` and injected here by the
        aggregation worker (before materialization) and by ``ContextEngine``
        (before any read). Same "ALWAYS RESET" contract as
        :meth:`set_source_type_aliases`, and for the same reason: provider
        instances are cached and shared per ``(provider_id, graph_name)``, so
        omitting the call would leak the previous source's mapping into the
        next query. Passing ``None`` restores the platform defaults — that is a
        meaningful instruction, not a no-op.
        """
        from backend.app.services.node_identity import (
            DEFAULT_IDENTITY_PROPERTY, DEFAULT_NAME_PROPERTY,
        )
        self._node_identity_property = (
            str(identity_property).strip() if identity_property else ""
        ) or DEFAULT_IDENTITY_PROPERTY
        self._name_property = (
            str(name_property).strip() if name_property else ""
        ) or DEFAULT_NAME_PROPERTY

    def _alias_types(self, types, alias_attr: str):
        """Translate each declared/canonical type to the source's observed spelling(s)
        via the injected alias map; identity when there's no alias (governed graphs,
        or a type the source spells the same). A declared type can expand to MULTIPLE
        observed spellings (same-source multi-variant), so all are matched at once."""
        if not types:
            return types
        aliases = getattr(self, alias_attr, None)
        if not aliases:
            return types
        out: List[str] = []
        for t in types:
            mapped = aliases.get(str(t).upper())
            if mapped:
                out.extend(mapped)
            else:
                out.append(t)
        seen = list(dict.fromkeys(out))          # dedupe, preserve order
        return set(seen) if isinstance(types, (set, frozenset)) else seen

    def _containment_hop_bound(self) -> int:
        """Upper bound for upward containment walks. Physical depth can
        exceed the LABEL count (recursive same-label nesting, e.g.
        Folder⊃Folder…), so the bound is 2× the level-map size with a
        floor of 16, overridable for pathologically deep hierarchies via
        AGGREGATION_MAX_CONTAINMENT_HOPS. Reader walks and ancestor-chain
        computation MUST share this bound or they disagree with the
        writer about which ancestors exist."""
        override = os.getenv("AGGREGATION_MAX_CONTAINMENT_HOPS")
        if override:
            try:
                return max(1, min(64, int(override)))
            except ValueError:
                pass
        levels = getattr(self, "_entity_type_levels", None) or {}
        return max(2 * len(levels), 16)

    def _floor_case_fold(self, types, observed):
        """Universal case-fold floor: union each resolved type with every
        observed spelling that shares its case-fold, so a declared ``TO``
        still resolves to a graph's ``To``/``to`` even when the injected
        alias map is empty (a governed-but-drifted source, or introspection
        that came back empty). Monotonic — only ADDS same-casefold spellings
        the graph actually has; it never drops a type, so a mismatched cache
        can't make a query miss. Mirrors the aggregation pipeline's
        ``_fold_expand`` at the read-path choke point every consumer flows
        through (trace / top-level / containment / lineage accessors)."""
        if not types or not observed:
            return types
        by_fold: Dict[str, List[str]] = {}
        for o in observed:
            by_fold.setdefault(str(o).casefold(), []).append(str(o))
        out: List[str] = list(types)
        have = set(out)
        for t in list(out):
            for variant in by_fold.get(str(t).casefold(), []):
                if variant not in have:
                    have.add(variant)
                    out.append(variant)
        return set(out) if isinstance(types, (set, frozenset)) else out

    def _alias_rel_types(self, types):
        # Alias translation first (declared → the source's mapped spelling),
        # then a case-fold floor from the reliably-probed observed vocabulary
        # (populated by get_ontology_metadata, which has an edge-scan fallback)
        # so an empty/partial alias map can never cause a silent case miss.
        aliased = self._alias_types(types, "_source_rel_aliases")
        return self._floor_case_fold(aliased, getattr(self, "_observed_rel_types", None))

    def _alias_entity_types(self, types):
        return self._alias_types(types, "_source_entity_aliases")

    def _get_containment_edge_types(self) -> Set[str]:
        """Return the authoritative containment edge type set.

        Single source of truth: the ontology-resolved types injected by
        ContextEngine / aggregation. Empty is a valid resolved state
        (flat graph with no containment hierarchy). Anything else
        raises ``ProviderConfigurationError`` — silently defaulting in
        a multi-tenant system masks ontology-coverage bugs the
        resolution gate is meant to surface.

        The legacy ``CONTAINMENT_EDGE_TYPES`` env-var fallback was
        removed: it was an operator escape hatch from the era before
        the resolution gate, and it lets aggregation paths bypass the
        per-data-source ontology assignment. Operators that need to
        configure containment now do so by editing the ontology.
        """
        if getattr(self, "_resolved_containment_types_set", False):
            # Translate the (uppercased) canonical set to the source's observed
            # spellings so the case-SENSITIVE Cypher patterns match a differently-
            # cased graph. Identity for governed/canonical graphs.
            return self._alias_rel_types(self._resolved_containment_types)
        raise ProviderConfigurationError(
            "Containment edge types are not configured for this provider. "
            "ContextEngine / aggregation must call set_containment_edge_types() "
            "with the resolved ontology before invoking provider methods that "
            "depend on containment classification."
        )

    def _get_lineage_edge_types(self) -> Set[str]:
        """Return the authoritative lineage edge type set.

        Mirrors ``_get_containment_edge_types``. The set is populated by
        ``set_resolved_edge_metadata`` (called from
        ``ContextEngine._resolve_ontology``) from the live ontology's
        ``is_lineage`` flags. Empty is a valid resolved state (graph has
        no lineage edges); a missing set raises ``ProviderConfigurationError``
        so silent misconfiguration is impossible — search predicates that
        depend on lineage (``isOrphan``, ``degree``, ``withinHops``) must
        fail loudly if the ontology was never injected.

        No hardcoded fallback: the whole point of the ontology resolution
        gate is that lineage classification is per-data-source.
        """
        if getattr(self, "_resolved_edge_metadata_set", False):
            # Translate to the source's observed spellings (parity with the containment
            # accessor) so accessor-driven lineage rendering (e.g. deep-search) matches a
            # differently-cased graph. Classification reads the raw uppercase set directly,
            # so it is unaffected.
            return self._alias_rel_types(self._resolved_lineage_types)
        raise ProviderConfigurationError(
            "Lineage edge types are not configured for this provider. "
            "ContextEngine / aggregation must call set_resolved_edge_metadata() "
            "with the resolved ontology before invoking provider methods that "
            "depend on lineage classification (e.g. degree / isOrphan / "
            "withinHops predicates)."
        )

    def _extract_node_from_result(self, row) -> Optional[GraphNode]:
        """Extract GraphNode from a FalkorDB result row (Node or dict of properties)."""
        if not row:
            return None
        cell = row[0] if isinstance(row, (list, tuple)) else row
        ident = getattr(self, "_node_identity_property", None)
        name_prop = getattr(self, "_name_property", None)
        if hasattr(cell, "properties"):
            props = cell.properties or {}
            labels = getattr(cell, "labels", None) or []
            entity_type = labels[0] if labels else props.get("entityType", "unknown")
            return _node_from_props(props, entity_type, ident, name_prop)
        if isinstance(cell, dict):
            return _node_from_props(cell, None, ident, name_prop)
        return None
