import asyncio
import hashlib
import json as _json
import logging
import time
from typing import Iterable, List, Dict, Any, Set, Optional, Tuple, TYPE_CHECKING
from ..models.graph import (
    GraphNode, GraphEdge, LineageResult, NodeQuery, EdgeQuery, GraphSchemaStats, OntologyMetadata,
    GraphSchema, EntityTypeDefinition, RelationshipTypeDefinition, EntityVisualSchema, EntityHierarchySchema, EntityBehaviorSchema,
    RelationshipVisualSchema, FieldSchema, AggregatedEdgeRequest, AggregatedEdgeResult, AggregatedEdgeInfo,
    CreateNodeRequest, CreateNodeResult, ChildrenWithEdgesResult, TopLevelNodesResult,
    TraceRequest, TraceResult, ExpandRequest,
)
from backend.common.models.graph import (
    TraceResultV2, TraceExpandRequest, TraceDelta, TraceMeta, MegaNodeInfo,
    TraceClosureRequest, TraceClosureResult,
)

from ..providers.base import GraphDataProvider
from ..config.resilience import (
    FALKORDB_AGGREGATED_READ_TIMEOUT_SECS,
    TRACE_ENGINE_HEADROOM_SECS,
    TRACE_TIMEOUT_SECS,
)
from backend.common.adapters import ProviderUnavailable

if TYPE_CHECKING:
    from sqlalchemy.ext.asyncio import AsyncSession
    from ..ontology.protocols import OntologyServiceProtocol

logger = logging.getLogger(__name__)


# Granularity is now expressed as an entity type ID string (e.g. "dataset", "term").
# Coarseness is derived from hierarchy.level in the resolved ontology — level 0 = coarsest.
# No hardcoded mapping needed.

#: Relationship types this system MATERIALISES itself. They are stored in
#: the graph like any other edge, and a source's resolved ontology
#: routinely lists them among its lineage types — but nothing in the data
#: source ever said them: ``:AGGREGATED`` is the aggregation worker's own
#: rollup of a real flow, projected onto every coarser grain above its
#: endpoints. A walk that treats them as lineage counts one real flow once
#: per level of containment above it.
#:
#: Uppercase, and compared uppercase — the graph's own spelling varies per
#: source (see ``_alias_rel_types``).
#:
#: This is the ONE place that names them for the closure. The aggregated
#: read paths (``trace_at_level``, ``expand_aggregated_edge`` and the
#: materialiser) read ``:AGGREGATED`` deliberately and carry their own
#: literals; they are a different question and are left alone.
SYNTHETIC_LINEAGE_EDGE_TYPES = frozenset({"AGGREGATED"})


def _real_lineage_types(edge_types: Iterable[str]) -> List[str]:
    """`edge_types` minus anything this system materialised itself.

    Order-preserving and duplicate-tolerant, because the provider turns
    the list straight into a Cypher relationship alternation.
    """
    return [
        t for t in edge_types
        if t and str(t).upper() not in SYNTHETIC_LINEAGE_EDGE_TYPES
    ]


class ContextEngine:
    _ONTOLOGY_CACHE_TTL = 300  # 5 minutes

    def __init__(
        self,
        provider: GraphDataProvider = None,
        ontology_service: Optional["OntologyServiceProtocol"] = None,
    ):
        if provider is None:
            raise ValueError("ContextEngine requires an explicit provider; no default available.")
        self.provider = provider
        self._ontology_service = ontology_service  # injected; None = legacy path
        self._connection_id: Optional[str] = None
        self._workspace_id: Optional[str] = None
        self._data_source_id: Optional[str] = None
        self._db_session: Optional["AsyncSession"] = None
        # Single ontology cache slot (resolved form, includes flat projection fields).
        self._resolved_ontology_cache: Optional[Any] = None
        self._resolved_ontology_cache_ts: float = 0.0
        # The data source's resolved node-identity mapping (None until the
        # first resolution, or when it could not be read).
        self._node_identity: Optional[Any] = None
        # Lock to prevent concurrent ontology resolution (race condition on first request)
        self._ontology_resolve_lock = asyncio.Lock()

    # ------------------------------------------------------------------ #
    # Workspace-aware factory (new)                                        #
    # ------------------------------------------------------------------ #

    @classmethod
    async def for_workspace(
        cls,
        workspace_id: str,
        registry: Any,  # ProviderRegistry — avoid circular import
        session: "AsyncSession",
        data_source_id: Optional[str] = None,
        actor: Optional[str] = None,
        branch_id: Optional[str] = None,
    ) -> "ContextEngine":
        """
        Create a ContextEngine scoped to a workspace data source.
        If data_source_id is given, uses that specific source; otherwise the primary.

        Ontology is resolved and pushed into the provider *eagerly* so
        that endpoints which call ``engine.provider.*`` directly (e.g.
        ``POST /nodes/query`` bypassing ``engine.get_nodes``) observe a
        correctly configured provider. Without eager injection, those
        direct call sites hit ``ProviderConfigurationError`` on the
        first query after the provider is instantiated because the
        provider's ``_resolved_containment_types_set`` flag is only set
        from inside ``_resolve_ontology()``.

        Resolution failure is NOT fatal — the engine still returns so
        the endpoint can surface a cleaner error (and ``_resolve_ontology``
        will retry on subsequent calls once the cache TTL rolls, or when
        the engine is rebuilt on the next request).
        """
        from ..ontology.adapters.sqlalchemy_repo import SQLAlchemyOntologyRepository
        from ..ontology.service import LocalOntologyService

        try:
            provider = await registry.get_provider_for_workspace(
                workspace_id, session, data_source_id
            )
        except ProviderUnavailable:
            raise
        except KeyError:
            raise
        except (ConnectionError, OSError, asyncio.TimeoutError) as exc:
            raise ProviderUnavailable(
                provider_name=f"ws:{workspace_id}",
                reason=f"Provider instantiation failed: {exc}",
            ) from exc

        repo = SQLAlchemyOntologyRepository(session)
        ontology_service = LocalOntologyService(repo)

        # Branch-aware reads. A resolved draft swaps in the read-only Postgres reader. For main
        # (named, opaque id, or omitted) we honour read-your-writes: when the FalkorDB projection
        # lags the committed head (e.g. right after a merge, which commits to Postgres + nudges an
        # async projection but does not write through to FalkorDB), serve main from the Postgres
        # reader so the change shows immediately; once the projection catches up, use the live
        # FalkorDB provider (hot path). A non-versioned data source ignores branch_id (live provider).
        norm = (branch_id or "").strip()
        if data_source_id:
            from .versioning.service import GraphVersioningService
            svc = GraphVersioningService()
            graph = await svc.get_graph_by_data_source(data_source_id)
            if graph is not None:
                gid = graph["graph_id"]
                main_id = await svc.main_branch_id(gid)
                is_draft = norm not in ("", "main", main_id)
                main_fresh = (await svc.projection_watermark(gid))["fresh"]
                read_provider = None
                read_branch: Optional[str] = None
                if is_draft:
                    async with svc._session() as gv_s:
                        try:
                            await svc._get_branch(gv_s, gid, norm)
                        except ValueError as exc:
                            raise KeyError(f"branch_not_found: {norm}") from exc
                    # Draft = main ⊕ sparse delta: overlay the draft's bounded patch set on WHATEVER
                    # serves main — the live FalkorDB provider when fresh (so the materialized
                    # aggregated lineage is reused, not re-derived), else the Postgres main reader.
                    # A no-change draft has an empty delta → pure pass-through → identical to main.
                    from ..providers.versioned_branch_provider import VersionedBranchProvider
                    from ..providers.draft_overlay_provider import DraftOverlayProvider
                    base = provider if main_fresh else VersionedBranchProvider(
                        svc, graph_id=gid, branch_id=main_id, actor=actor)
                    read_provider = DraftOverlayProvider(
                        base, svc=svc, graph_id=gid, branch_id=norm, actor=actor)
                    read_branch = norm
                elif not main_fresh:
                    # Stale main (e.g. right after a merge): serve from Postgres so the change shows
                    # immediately; once the projection catches up, the fresh-FalkorDB hot path is used.
                    from ..providers.versioned_branch_provider import VersionedBranchProvider
                    read_provider = VersionedBranchProvider(svc, graph_id=gid, branch_id=main_id, actor=actor)
                    read_branch = main_id
                if read_provider is not None:
                    engine = cls(provider=read_provider, ontology_service=ontology_service)
                    engine._workspace_id = workspace_id
                    engine._data_source_id = data_source_id
                    engine._db_session = session
                    engine._branch_id = read_branch
                    try:
                        await engine._resolve_ontology()
                    except Exception as exc:
                        logger.warning(
                            "Eager ontology resolution failed for ws=%s ds=%s branch=%s: %s",
                            workspace_id, data_source_id, read_branch, exc,
                        )
                    return engine
            # graph is None → not versioned: ignore branch_id, serve the live provider.

        # Out-of-the-box write-through versioning: wrap the provider so every write also
        # lands as an audited commit on the data source's versioned graph (the audit trail
        # + branch/version history). Reads delegate unchanged. Opt out with
        # GRAPHVER_VERSIONED_WRITES=0.
        from .versioning import config as vconfig
        if vconfig.VERSIONED_WRITES_ENABLED and data_source_id:
            from ..providers.versioned_write_provider import VersionedWriteProvider
            # Resolve the data source's real FalkorDB graph so a lazily-created versioned graph
            # projects merged main state into the SAME graph the canvas reads (not an orphan gv_<id>).
            # The graphver store may be a separate DB, so this app-layer lookup is the only place
            # that knows the name. (projection_mode/_proj is the provider's aggregated-edge graph, a
            # separate concern — base node/edge reads always hit ds.graph_name.)
            from ..db.repositories import data_source_repo
            falkor_graph_name: Optional[str] = None
            try:
                ds_row = await data_source_repo.get_data_source_orm(session, data_source_id)
                if ds_row is not None and ds_row.graph_name:
                    falkor_graph_name = ds_row.graph_name
            except Exception as exc:
                logger.warning(
                    "Could not resolve graph_name for ds=%s (versioned graph will use the "
                    "synthetic fallback until repaired): %s", data_source_id, exc)
            provider = VersionedWriteProvider(
                provider, workspace_id=workspace_id, data_source_id=data_source_id,
                actor=actor or "system", falkor_graph_name=falkor_graph_name,
            )

        engine = cls(provider=provider, ontology_service=ontology_service)
        engine._workspace_id = workspace_id
        engine._data_source_id = data_source_id
        engine._db_session = session

        # Eagerly resolve ontology so the provider is configured before
        # any request handler touches ``engine.provider`` directly.
        # ``_resolve_ontology`` handles provider-introspection failure
        # internally (graceful fallback to DB ontology + empty
        # introspection); we only need to catch catastrophic errors here
        # so engine construction can still succeed for diagnostics
        # (status endpoints, provider listing, etc.).
        try:
            await engine._resolve_ontology()
        except Exception as exc:
            logger.warning(
                "Eager ontology resolution failed for workspace=%s ds=%s: %s — "
                "provider will remain unconfigured; endpoints that call "
                "engine.provider.* directly may fail until the next request.",
                workspace_id, data_source_id, exc,
            )

        return engine

    # ------------------------------------------------------------------ #
    # Connection-aware factory (legacy compat)                             #
    # ------------------------------------------------------------------ #

    @classmethod
    async def for_connection(
        cls,
        connection_id: Optional[str],
        registry: Any,  # ProviderRegistry — avoid circular import
        session: "AsyncSession",
    ) -> "ContextEngine":
        """
        Create a ContextEngine backed by the specified connection.
        """
        if connection_id is None:
            raise ValueError("connection_id is required")
        try:
            provider = await registry.get_provider(connection_id, session)
        except ProviderUnavailable:
            raise
        except KeyError:
            raise
        except (ConnectionError, OSError, asyncio.TimeoutError) as exc:
            raise ProviderUnavailable(
                provider_name=f"conn:{connection_id}",
                reason=f"Provider instantiation failed: {exc}",
            ) from exc
        engine = cls(provider=provider)
        engine._connection_id = connection_id
        engine._db_session = session
        return engine

    # ------------------------------------------------------------------ #
    # Ontology resolution with DB override merging                          #
    # ------------------------------------------------------------------ #

    async def get_ontology_metadata(self) -> OntologyMetadata:
        """
        Return flat ontology metadata projected from the resolved ontology cache.
        """
        resolved = await self._resolve_ontology()
        return resolved.to_flat_metadata()

    async def get_ontology_digest(self) -> Optional[str]:
        """Return a stable SHA-256 digest of the active ontology.

        Used by the ViewWizard drift detector: when a view is saved, this
        digest is captured on the ``ViewORM.ontology_digest`` column; when
        the view is later edited, the wizard compares the stored digest
        against the current one and surfaces a non-blocking banner when
        they differ.

        The digest is computed from the flat OntologyMetadata projection
        (containment/lineage edge types, edge-type metadata, entity-type
        hierarchy, root entity types) serialized as canonical JSON. This
        means semantically-identical ontologies produce identical digests
        regardless of dict/list ordering in the source-of-truth store.

        Returns None when the ontology cannot be resolved (provider down,
        no service wired, etc.) so callers can defensively skip persisting
        a bogus digest.
        """
        try:
            meta = await self.get_ontology_metadata()
        except Exception as exc:
            logger.warning("get_ontology_digest: unable to resolve ontology (%s)", exc)
            return None
        payload = meta.model_dump(by_alias=True)
        canonical = _json.dumps(
            payload, sort_keys=True, separators=(",", ":"), default=str,
        )
        return hashlib.sha256(canonical.encode("utf-8")).hexdigest()

    def invalidate_ontology_cache(self) -> None:
        """Clear cached ontology so the next call re-fetches from source."""
        self._resolved_ontology_cache = None
        self._resolved_ontology_cache_ts = 0.0
        from . import resolved_ontology_cache as ont_cache
        ont_cache.drop_local(self._workspace_id, getattr(self, "_data_source_id", None))

    async def get_resolved_ontology(self):
        """Public access to the resolved ontology (containment + root types) for
        callers outside the engine (top-level cache serve/compute paths)."""
        return await self._resolve_ontology()

    def _inject_resolved(self, resolved, *, force_authoritative: bool = False) -> None:
        """Push a resolved ontology's config into the provider (in-memory
        setters only — no I/O). Shared by the full resolution path and the
        process-cache hit path so BOTH honour the eager-configuration
        contract: endpoints that call ``engine.provider.*`` directly must
        find the provider configured before its first query.

        ``force_authoritative`` marks the injection authoritative regardless
        of resolution_sources — used by the LAST-layer fallback, where an
        introspection-only (possibly empty) result must still configure the
        provider: empty-but-configured beats every subsequent call raising
        ProviderConfigurationError."""
        has_real_ontology = force_authoritative or bool(
            resolved.resolution_sources
            and any(s in ("assigned", "system_default")
                    for s in resolved.resolution_sources.values())
        )
        if hasattr(self.provider, 'set_containment_edge_types'):
            self.provider.set_containment_edge_types(
                resolved.containment_edge_types,
                from_ontology=has_real_ontology,
            )
        if hasattr(self.provider, 'set_ontology_rules'):
            # Rich commit-boundary rules for the versioned write-through —
            # only when an EXPLICITLY ASSIGNED ontology contributed (the
            # system-default/introspection layers must not gate legacy data).
            from backend.app.ontology.rules import resolved_ontology_to_rules
            has_assigned = any(
                s == "assigned"
                for s in (resolved.resolution_sources or {}).values())
            self.provider.set_ontology_rules(
                resolved_ontology_to_rules(resolved) if has_assigned else None)
        if hasattr(self.provider, 'set_resolved_edge_metadata'):
            self.provider.set_resolved_edge_metadata(
                resolved.edge_type_metadata,
                resolved.lineage_edge_types,
            )
        if hasattr(self.provider, 'set_entity_type_levels'):
            # Build entity-type → hierarchy.level mapping. Single
            # source of truth shared with the backfill script via
            # ``derive_level_map``: declared ``hierarchy.level``
            # takes precedence, with ``can_contain`` /
            # ``can_be_contained_by`` as fallback. Runtime and
            # backfill must agree on this map or the digest stamps
            # will look stale to each other.
            from .ontology_levels import derive_level_map
            levels = derive_level_map(resolved)
            self.provider.set_entity_type_levels(levels)

    def _inject_alignment(self, alignment) -> None:
        """Inject the per-source vocabulary alias maps ("always reset"
        contract — an empty map is meaningful)."""
        if hasattr(self.provider, "set_source_type_aliases"):
            if alignment is not None:
                self.provider.set_source_type_aliases(
                    alignment.rel_alias_map(), alignment.entity_alias_map())
            else:
                self.provider.set_source_type_aliases({}, {})

    def _inject_identity(self, identity) -> None:
        """Inject the resolved node-identity mapping (same "always reset"
        contract as the aliases — provider instances are shared and cached).

        Until this existed, the mapping only ever reached a provider inside the
        AGGREGATION worker, so a source keyed by ``id`` read as an empty graph
        until someone re-ran aggregation. Injecting it here is what makes a
        newly-declared mapping take effect on the very next read.
        """
        if hasattr(self.provider, "set_node_identity"):
            if identity is not None:
                self.provider.set_node_identity(
                    identity.identity_property, identity.name_property)
            else:
                self.provider.set_node_identity(None, None)

    async def _resolve_node_identity(self):
        """The data source's effective mapping across all four scopes.

        Best-effort: a failure here must never fail a read — falling back to
        the platform defaults is exactly the behaviour that predates the
        feature."""
        if self._db_session is None or not self._data_source_id:
            return None
        try:
            from .node_identity import load_node_identity
            return await load_node_identity(self._db_session, self._data_source_id)
        except Exception as exc:
            logger.warning(
                "node-identity resolution failed for ds=%s (reads fall back to "
                "the platform defaults): %s", self._data_source_id, exc,
            )
            return None

    async def _resolve_ontology(self):
        """
        Single ontology resolution entry point with TTL caching.
        Returns ResolvedOntology for all callers.

        Guarded by an async lock to prevent concurrent resolution when
        multiple requests arrive before the cache is populated.

        Two cache layers:
        * L0 — this engine instance (engines are per-request; covers repeat
          calls within one request).
        * L1 — the process-wide ``resolved_ontology_cache`` keyed
          (workspace, data source), generation-invalidated via Redis with a
          300s TTL backstop. A hit re-injects provider config (cheap,
          in-memory) and SKIPS introspection queries, the Postgres resolve,
          the ensure_indices DDL storm, and the alignment persistence write
          — the per-request fixed tax that dominated read latency.
        """
        now = time.monotonic()
        if (
            self._resolved_ontology_cache is not None
            and (now - self._resolved_ontology_cache_ts) < self._ONTOLOGY_CACHE_TTL
        ):
            return self._resolved_ontology_cache

        async with self._ontology_resolve_lock:
            # Double-check after acquiring the lock (another coroutine may have resolved while we waited)
            now = time.monotonic()
            if (
                self._resolved_ontology_cache is not None
                and (now - self._resolved_ontology_cache_ts) < self._ONTOLOGY_CACHE_TTL
            ):
                return self._resolved_ontology_cache

            gen_before: Optional[int] = None
            if self._ontology_service and self._workspace_id:
                from . import resolved_ontology_cache as ont_cache
                shared = await ont_cache.lookup(self._workspace_id, self._data_source_id)
                if shared is not None:
                    resolved, alignment, identity = shared
                    self._inject_resolved(resolved)
                    self._source_alignment = alignment
                    self._inject_alignment(alignment)
                    self._node_identity = identity
                    self._inject_identity(identity)
                    self._resolved_ontology_cache = resolved
                    self._resolved_ontology_cache_ts = time.monotonic()
                    return resolved
                # Remember the generation the full resolve runs under so a
                # concurrent bump leaves the stored entry stale (next lookup
                # re-resolves) instead of serving across an invalidation.
                gen_before = await ont_cache.current_generation(
                    self._workspace_id, self._data_source_id)

            # Provider introspection — graceful degradation if provider is unreachable.
            # Outer timeout caps the aggregate introspection call (which may issue
            # 4-5 internal Cypher queries). Per-query timeouts from the provider
            # layer fire first in most cases; this is a defense-in-depth backstop.
            import os as _os
            _INTROSPECTION_TIMEOUT = float(_os.getenv("ONTOLOGY_INTROSPECTION_TIMEOUT", "8"))
            introspected = None
            try:
                introspected = await asyncio.wait_for(
                    self.provider.get_ontology_metadata(),
                    timeout=_INTROSPECTION_TIMEOUT,
                )
            except asyncio.TimeoutError:
                logger.warning(
                    "Provider introspection timed out (get_ontology_metadata) after %.0fs — "
                    "proceeding with empty introspection data.",
                    _INTROSPECTION_TIMEOUT,
                )
            except Exception as exc:
                logger.warning(
                    "Provider introspection failed (get_ontology_metadata): %s — "
                    "proceeding with empty introspection data. Containment/lineage "
                    "classification will rely solely on system defaults or DB overrides.",
                    exc,
                )

            introspected_entity_ids = list(introspected.entity_type_hierarchy.keys()) if introspected else None
            introspected_rel_ids = list(introspected.edge_type_metadata.keys()) if introspected else None

            if self._ontology_service and self._workspace_id:
                try:
                    resolved = await self._ontology_service.resolve(
                        workspace_id=self._workspace_id,
                        data_source_id=self._data_source_id,
                        introspected_entity_ids=introspected_entity_ids,
                        introspected_rel_ids=introspected_rel_ids,
                    )
                    # Push resolved config to the provider so subsequent
                    # queries (childCount, hierarchy) use the correct edge set.
                    # Always push — even an empty list is meaningful (= no containment).
                    self._inject_resolved(resolved)
                    # Ensure indices exist for all ontology-defined entity types.
                    # Runs only on this full-resolution path (once per
                    # generation per pod) — a shared-cache hit skips the DDL.
                    if hasattr(self.provider, 'ensure_indices') and resolved.entity_type_definitions:
                        try:
                            await self.provider.ensure_indices(list(resolved.entity_type_definitions.keys()))
                        except Exception:
                            pass  # best-effort, don't block resolution
                    # Per-source vocabulary alignment (Task E): reconcile the ontology's
                    # declared type spellings with what THIS source graph actually uses so a
                    # case-variant third-party graph (has/to vs HAS/TO) reads correctly, and
                    # surface the mismatch as drift. Never blocks resolution.
                    try:
                        await self._apply_source_alignment(
                            resolved, introspected_entity_ids, introspected_rel_ids)
                    except Exception as exc:
                        logger.warning("source vocabulary alignment failed (non-fatal): %s", exc)
                    # Per-source node identity: which physical property plays
                    # the role of `urn`, and where the human name lives.
                    # Resolved from the data source's whole scope chain and
                    # injected before the first read, so a mapping declared on
                    # the provider or workspace applies immediately rather than
                    # waiting for an aggregation run to stamp the graph.
                    self._node_identity = await self._resolve_node_identity()
                    self._inject_identity(self._node_identity)
                    if gen_before is not None:
                        from . import resolved_ontology_cache as ont_cache
                        ont_cache.store(
                            self._workspace_id, self._data_source_id, gen_before,
                            resolved, getattr(self, "_source_alignment", None),
                            self._node_identity)
                    self._resolved_ontology_cache = resolved
                    self._resolved_ontology_cache_ts = time.monotonic()
                    return resolved
                except Exception as exc:
                    logger.warning("OntologyService.resolve() failed, falling back to introspection: %s", exc)

            # Legacy/no-service fallback: still cache as a ResolvedOntology-shaped object.
            from ..ontology.models import ResolvedOntology

            fallback = ResolvedOntology(
                containment_edge_types=introspected.containment_edge_types if introspected else [],
                lineage_edge_types=introspected.lineage_edge_types if introspected else [],
                edge_type_metadata=introspected.edge_type_metadata if introspected else {},
                entity_type_hierarchy=introspected.entity_type_hierarchy if introspected else {},
                root_entity_types=introspected.root_entity_types if introspected else [],
            )
            # Push the fallback config to the PROVIDER too — the degraded path
            # (ontology service down / resolve() raising) otherwise cached and
            # returned an ontology while leaving the provider's containment/
            # lineage edge set unconfigured, so every subsequent provider query
            # (childCount, hierarchy) raised ProviderConfigurationError until a
            # full resolve succeeded. Authoritative: this is the LAST resolution
            # layer, so even an empty introspection result must configure the
            # provider (empty = flat graph, not "unconfigured").
            self._inject_resolved(fallback, force_authoritative=True)
            # Identity is a per-SOURCE property, independent of whether the
            # ontology resolved — the degraded path must configure it too, or a
            # transient ontology-service outage would silently un-map an
            # id-keyed graph.
            self._node_identity = await self._resolve_node_identity()
            self._inject_identity(self._node_identity)
            self._resolved_ontology_cache = fallback
            self._resolved_ontology_cache_ts = time.monotonic()
            return fallback

    async def _apply_source_alignment(self, resolved, observed_entity_ids, observed_rel_ids):
        """Derive the per-source vocabulary alignment (declared spelling → this graph's
        observed spelling), inject it into the provider as an alias map, and persist the
        drift summary. Best-effort DB work: aliases are injected even when the DB is
        unavailable, so reads stay correct regardless.

        Governed/versioned graphs are canonicalized at the commit boundary (Task C), so
        their observed spellings already equal the declared ones — the alignment is an
        identity and the alias map is empty (cheap short-circuit)."""
        from backend.app.ontology.source_alignment import (
            derive_alignment, MISSING_OBSERVED)

        # Defensively clear any prior ontology's aliases up front. The caller wraps this
        # method in a swallow-all try/except, so a failure below must not leave stale
        # cross-ontology aliases on the provider (honours the setter's "always reset"
        # contract). The success path resets them to the computed map at the end.
        if hasattr(self.provider, "set_source_type_aliases"):
            self.provider.set_source_type_aliases({}, {})

        declared_rel = (set(resolved.containment_edge_types or [])
                        | set(resolved.lineage_edge_types or [])
                        | set((resolved.relationship_type_definitions or {}).keys()))
        declared_ent = set((resolved.entity_type_definitions or {}).keys())
        observed_rel = list(observed_rel_ids or [])
        observed_ent = list(observed_entity_ids or [])

        def _build(explicit_rel=None, explicit_ent=None):
            a = derive_alignment(
                declared_relationship_types=declared_rel,
                declared_entity_types=declared_ent,
                observed_relationship_types=observed_rel,
                observed_entity_types=observed_ent,
                explicit_relationship_mappings=explicit_rel,
                explicit_entity_mappings=explicit_ent,
            )
            # Entity types are introspected only via containment participation, so a
            # declared type absent from that (incomplete) view isn't reliably "missing".
            # Keep entity ALIASES (case variants), drop noisy entity missing-drift.
            a.entity_entries = {k: v for k, v in a.entity_entries.items()
                                if v.kind != MISSING_OBSERVED}
            return a

        alignment = _build()
        ds_id = getattr(self, "_data_source_id", None)
        if ds_id:
            try:
                from backend.app.db.engine import get_session_factory
                from backend.app.db.repositories.data_source_repo import get_data_source_orm
                from backend.app.db.repositories import ontology_source_mapping_repo as osm_repo
                async with get_session_factory()() as s:
                    ds = await get_data_source_orm(s, ds_id)
                    ont_id = getattr(ds, "ontology_id", None) if ds else None
                    ex_rel, ex_ent = await osm_repo.load_explicit_mappings(s, ds_id, ont_id)
                    if ex_rel or ex_ent:
                        alignment = _build(ex_rel, ex_ent)
                    await osm_repo.persist_alignment(
                        s, data_source_id=ds_id, ontology_id=ont_id, alignment=alignment)
                    await s.commit()
            except Exception as exc:
                logger.debug("source alignment DB step skipped (non-fatal): %s", exc)

        self._source_alignment = alignment
        if hasattr(self.provider, "set_source_type_aliases"):
            self.provider.set_source_type_aliases(
                alignment.rel_alias_map(), alignment.entity_alias_map())

    async def get_source_alignment(self):
        """Public accessor for the per-source vocabulary alignment (drift surface).
        Resolves the ontology first so the alignment reflects the live schema."""
        await self._resolve_ontology()
        return getattr(self, "_source_alignment", None)

    async def _get_resolved_ontology(self):
        """Return the cached ResolvedOntology, refreshing via _resolve_ontology() if needed."""
        return await self._resolve_ontology()

    async def get_node(self, urn: str) -> Optional[GraphNode]:
        return await self.provider.get_node(urn)

    async def search_nodes(self, query: str, limit: int = 10, offset: int = 0) -> List[GraphNode]:
        return await self.provider.search_nodes(query, limit=limit, offset=offset)
    
    async def get_stats(self) -> Dict[str, Any]:
        return await self.provider.get_stats()

    async def get_schema_stats(self) -> GraphSchemaStats:
        return await self.provider.get_schema_stats()
    
    async def _ensure_containment_edge_types(self, edge_types: Optional[List[str]]) -> List[str]:
        """If caller did not supply explicit edge_types, resolve from ontology.

        Returns a concrete list (possibly empty). An empty list means the ontology
        explicitly defines no containment types — callers should treat this as
        'no containment hierarchy' rather than falling back to hardcoded defaults.
        """
        if edge_types is not None:
            return edge_types
        resolved = await self._resolve_ontology()
        if resolved and resolved.containment_edge_types:
            return list(resolved.containment_edge_types)
        if resolved is not None:
            # Ontology resolved successfully but has no containment types — this is
            # a valid (empty hierarchy) state, not an error. Return empty list so
            # downstream queries correctly return no children rather than using
            # provider hardcoded fallbacks.
            logger.warning(
                "Ontology resolved with empty containment_edge_types. "
                "Hierarchy queries will return no results."
            )
            return []
        return []  # No ontology at all — graceful empty

    async def get_children(self, urn: str, edge_types: Optional[List[str]] = None, search_query: Optional[str] = None, limit: int = 100, offset: int = 0, sort_property: Optional[str] = "displayName", cursor: Optional[str] = None, sort_direction: str = "asc") -> List[GraphNode]:
        edge_types = await self._ensure_containment_edge_types(edge_types)
        return await self.provider.get_children(urn, entity_types=None, edge_types=edge_types, search_query=search_query, limit=limit, offset=offset, sort_property=sort_property, cursor=cursor, sort_direction=sort_direction)

    async def get_children_with_edges(
        self, urn: str, edge_types: Optional[List[str]] = None,
        lineage_edge_types: Optional[List[str]] = None,
        search_query: Optional[str] = None,
        limit: int = 100, offset: int = 0,
        include_lineage_edges: bool = True,
        sort_property: Optional[str] = "displayName",
        cursor: Optional[str] = None,
        sort_direction: str = "asc",
    ) -> ChildrenWithEdgesResult:
        edge_types = await self._ensure_containment_edge_types(edge_types)
        if not lineage_edge_types:
            resolved = await self._resolve_ontology()
            if resolved and resolved.lineage_edge_types:
                lineage_edge_types = list(resolved.lineage_edge_types)
        return await self.provider.get_children_with_edges(
            urn, edge_types=edge_types, lineage_edge_types=lineage_edge_types,
            search_query=search_query, limit=limit, offset=offset,
            include_lineage_edges=include_lineage_edges,
            sort_property=sort_property, cursor=cursor,
            sort_direction=sort_direction,
        )

    async def get_top_level_or_orphan_nodes(
        self,
        *,
        entity_types: Optional[List[str]] = None,
        search_query: Optional[str] = None,
        limit: int = 100,
        cursor: Optional[str] = None,
        include_child_count: bool = True,
        query_timeout: Optional[float] = None,
        known_total_count: Optional[int] = None,
        sort_direction: str = "asc",
    ) -> TopLevelNodesResult:
        """Return instances with no incoming containment edge, scoped to the
        active workspace/data-source ontology.

        ContextEngine is the correct layer to inject `root_entity_types` from
        the resolved ontology because the provider is ontology-agnostic. The
        provider classifies each returned row as "root type" vs "orphan" using
        that list so the frontend can render a single unified list with a
        "N top-level · M orphan" badge.
        """
        # Ensure ontology has been resolved — this also pushes the resolved
        # containment edge types into the provider as a side effect, so the
        # provider's structural predicate uses the ontology-authoritative set.
        resolved = await self._resolve_ontology()
        root_types: List[str] = []
        if resolved and getattr(resolved, "root_entity_types", None):
            root_types = list(resolved.root_entity_types)

        # Default the entity-type filter to the ontology's full vocabulary so
        # the provider always takes the label-union page/count form (per-label
        # index scans) instead of the unlabeled MATCH (n) full scan. This also
        # keeps internal underscore-labelled nodes (_AggMeta, _Projection) out
        # of the top-level list. Callers passing an explicit filter, and
        # graphs with no resolved vocabulary (pre-ontology), are unchanged.
        if entity_types is None and resolved is not None:
            defined = list(getattr(resolved, "entity_type_definitions", {}) or {})
            if defined:
                entity_types = defined

        # query_timeout / known_total_count are newer keyword-only params some
        # providers (DraftOverlayProvider, VersionedBranchProvider) don't yet
        # accept — only pass the ones actually given, and retry once without
        # them on TypeError. Mirrors the fallback in insights_service/collector.py.
        extra: Dict[str, Any] = {}
        if query_timeout is not None:
            extra["query_timeout"] = query_timeout
        if known_total_count is not None:
            extra["known_total_count"] = known_total_count
        # Only forwarded when non-default so providers predating direction
        # support keep working for asc; a desc request against such a provider
        # falls into the TypeError retry below, which re-raises (desc cannot be
        # silently served as asc).
        if sort_direction != "asc":
            extra["sort_direction"] = sort_direction

        try:
            return await self.provider.get_top_level_or_orphan_nodes(
                root_entity_types=root_types,
                entity_types=entity_types,
                search_query=search_query,
                limit=limit,
                cursor=cursor,
                include_child_count=include_child_count,
                **extra,
            )
        except TypeError:
            if not extra:
                raise
            if "sort_direction" in extra:
                # A provider without direction support cannot silently serve a
                # desc request as asc — surface the incompatibility instead.
                raise
            return await self.provider.get_top_level_or_orphan_nodes(
                root_entity_types=root_types,
                entity_types=entity_types,
                search_query=search_query,
                limit=limit,
                cursor=cursor,
                include_child_count=include_child_count,
            )

    async def get_edges(self, query: EdgeQuery = None) -> List[GraphEdge]:
        if query is None: query = EdgeQuery()
        return await self.provider.get_edges(query)

    async def get_parent(self, child_urn: str) -> Optional[GraphNode]:
        """Get the parent node in the containment hierarchy."""
        return await self.provider.get_parent(child_urn)

    async def get_nodes_query(self, query: NodeQuery) -> List[GraphNode]:
        """Execute an advanced node query."""
        return await self.provider.get_nodes(query)

    async def get_distinct_values(self, property_name: str) -> List[Any]:
        """Get distinct values for a node property."""
        return await self.provider.get_distinct_values(property_name)

    async def get_node_degrees(self, urns, edge_types=None):
        """Total lineage degree per URN (see provider docstring). Providers
        without the capability degrade to {} — absent means unknown."""
        fn = getattr(self.provider, "get_node_degrees", None)
        if fn is None:
            return {}
        return await fn(urns, edge_types)

    async def save_custom_graph(
        self, nodes: List[GraphNode], edges: List[GraphEdge],
    ) -> bool:
        """Persist a custom graph (nodes + edges)."""
        return await self.provider.save_custom_graph(nodes, edges)

    async def materialize_aggregated_edges(
        self,
        batch_size: int = 1000,
        containment_edge_types: Optional[List[str]] = None,
        lineage_edge_types: Optional[List[str]] = None,
        last_cursor: Optional[str] = None,
        on_progress: Optional[Any] = None,
    ) -> Dict[str, Any]:
        """Trigger batch materialization of AGGREGATED edges.

        Returns stats dict. Only supported on FalkorDB providers; raises
        ValueError for other provider types.
        """
        if not hasattr(self.provider, "materialize_aggregated_edges_batch"):
            raise ValueError("Materialization only supported for FalkorDB provider")
        return await self.provider.materialize_aggregated_edges_batch(
            batch_size=batch_size,
            containment_edge_types=containment_edge_types,
            lineage_edge_types=lineage_edge_types,
            last_cursor=last_cursor,
            on_progress=on_progress,
        )

    async def get_neighborhood(self, urn: str) -> Optional[Dict[str, Any]]:
        """Get the node and its immediate edges (incoming/outgoing)."""
        # Run node fetch and edge fetch concurrently (2 round-trips instead of 4)
        node, all_edges = await asyncio.gather(
            self.get_node(urn),
            self.provider.get_edges(EdgeQuery(any_urns=[urn])),
        )
        if not node:
            return None

        # Determine neighbor URNs to fetch their details
        neighbor_urns = set()
        for e in all_edges:
            neighbor_urns.add(e.source_urn)
            neighbor_urns.add(e.target_urn)
        neighbor_urns.discard(urn)  # Don't re-fetch the central node

        neighbor_nodes = await self.provider.get_nodes(
            NodeQuery(urns=list(neighbor_urns), limit=len(neighbor_urns) or 1)
        ) if neighbor_urns else []

        return {
            "node": node,
            "edges": all_edges,
            "neighbors": neighbor_nodes
        }

    async def get_lineage(
        self, 
        urn: str, 
        upstream_depth: int, 
        downstream_depth: int,
        granularity: Optional[str] = None,
        aggregate_edges: bool = True,
        exclude_containment_edges: bool = True,
        include_inherited_lineage: bool = True,
        lineage_edge_types: Optional[List[str]] = None
    ) -> LineageResult:
        """
        Get lineage and optionally aggregate it to a coarser granularity.

        All edge classification (containment vs lineage) is derived from
        the ontology metadata — no hardcoded edge type references.

        Args:
            urn: Starting entity URN
            upstream_depth: How many hops upstream to traverse
            downstream_depth: How many hops downstream to traverse
            granularity: Entity type ID to project to (e.g. "dataset", "term").
                        Nodes finer than this type (higher hierarchy.level) are collapsed
                        upward to their nearest ancestor at this level.
                        None = no aggregation, return all levels as-is.
            aggregate_edges: Whether to aggregate lineage edges at the granularity level
            exclude_containment_edges: Filter out containment edges (for pure data lineage)
            include_inherited_lineage: Aggregate lineage from children to parent
            lineage_edge_types: Optional whitelist of lineage edge types to include.
                               When set, only edges of these types are treated as lineage.
                               When None, all ontology-classified lineage types are used.
        """
        # Load ontology metadata once — merges DB overrides + introspection
        ontology = await self.get_ontology_metadata()
        containment_types = {t.upper() for t in ontology.containment_edge_types} if ontology.containment_edge_types else set()
        all_lineage_types = {t.upper() for t in ontology.lineage_edge_types} if ontology.lineage_edge_types else set()
        
        # Apply optional lineage type filter (user can select subset via TraceOptions)
        if lineage_edge_types:
            active_lineage_types = {t.upper() for t in lineage_edge_types} & all_lineage_types
        else:
            active_lineage_types = all_lineage_types
        
        # Always fetch column lineage at the base to ensure we have data to roll up
        include_cols = True 
        
        # Use new Targeted Trace method
        # Convert sets to lists for the provider
        containment_list = list(containment_types)
        lineage_list = list(active_lineage_types)
        
        
        # If specific direction requested, we might need to filter the result?
        # get_trace_lineage takes 'direction'.
        trace_direction = "both"
        if upstream_depth > 0 and downstream_depth == 0:
            trace_direction = "upstream"
        elif downstream_depth > 0 and upstream_depth == 0:
            trace_direction = "downstream"
            
        # Re-call with correct direction if needed, or just let it return everything?
        # The provider's get_trace_lineage takes 'direction' but I didn't pass it above.
        # Let's correct the call.
        
        result = await self.provider.get_trace_lineage(
            urn,
            trace_direction,
            max(upstream_depth, downstream_depth),
            containment_list,
            lineage_list
        )
        
        # Build containment map BEFORE filtering - needed for column->table aggregation
        containment_map = self._build_containment_map(result.nodes, result.edges, containment_types)
        
        # Filter containment edges if requested (for pure data lineage view)
        # Filter containment edges if requested (for pure data lineage view)
        # We DO NOT filter containment edges here because they are needed for structural context (nesting nodes).
        # "exclude_containment_edges" implies broad traversal behavior, not visual suppression.
        # if exclude_containment_edges:
        #    result = self._filter_containment_edges(result, containment_types)
        
        # Handle inherited lineage - if entity has no direct lineage, try parent
        if include_inherited_lineage:
            result = await self._apply_inherited_lineage(
                urn, result, upstream_depth, downstream_depth,
                containment_types, active_lineage_types
            )
        
        if not aggregate_edges and granularity is None:
            return result

        # When projecting, ensure ancestor nodes at the target level are in the set
        # so aggregated edges have nodes to connect to
        if granularity is not None:
            node_map = {n.urn: n for n in result.nodes}
            ancestor_urns_to_add = set()
            for node in result.nodes:
                anc = self._find_ancestor_at_granularity(
                    node.urn, granularity, result.nodes, containment_map
                )
                if anc and anc not in node_map:
                    ancestor_urns_to_add.add(anc)
            if ancestor_urns_to_add:
                extra_nodes = await self.provider.get_nodes(NodeQuery(urns=list(ancestor_urns_to_add)))
                for n in extra_nodes:
                    if n.urn not in node_map:
                        result.nodes.append(n)
                        node_map[n.urn] = n
            
        # Perform Server-Side Projection (pass containment_map for column aggregation)
        projected_result = self._project_graph(
            result, granularity, aggregate_edges, containment_map, containment_types
        )
        return projected_result
    
    def _filter_containment_edges(
        self, result: LineageResult, containment_types: Set[str]
    ) -> LineageResult:
        """Remove containment edges from result, keeping only data lineage edges."""
        filtered_edges = [
            e for e in result.edges
            if self._normalize_edge_type(e.edge_type) not in containment_types
        ]
        
        return LineageResult(
            nodes=result.nodes,
            edges=filtered_edges,
            upstreamUrns=result.upstream_urns,
            downstreamUrns=result.downstream_urns,
            totalCount=result.total_count,
            hasMore=result.has_more,
            aggregatedEdges=result.aggregated_edges
        )
    
    @staticmethod
    def _normalize_edge_type(edge_type) -> str:
        """Normalize edge type to uppercase string for comparison."""
        return str(edge_type).upper()

    def _entity_level(self, entity_type: str) -> int:
        """
        Return the hierarchy.level of an entity type from the resolved ontology.
        Level 0 = coarsest (root); higher = finer grained.
        Returns a very high value for unknown types so they are treated as leaves.
        """
        if self._resolved_ontology_cache:
            ent_def = self._resolved_ontology_cache.entity_type_definitions.get(entity_type)
            if ent_def is not None:
                return ent_def.hierarchy.level
        return 9999  # unknown type → treat as finest leaf

    def _target_level(self, target_granularity: Optional[str]) -> int:
        """Return the hierarchy.level of the target granularity entity type. None → -1 (accept all)."""
        if target_granularity is None:
            return -1
        return self._entity_level(target_granularity)

    async def _apply_inherited_lineage(
        self, 
        urn: str, 
        result: LineageResult, 
        upstream_depth: int, 
        downstream_depth: int, 
        containment_types: Set[str],
        lineage_types: Set[str]
    ) -> LineageResult:
        """
        If the target entity has no direct lineage edges, inherit from parent.
        This handles cases like clicking on a column that has no lineage but its table does.
        
        Edge classification is derived from ontology — no hardcoded type references.
        """
        # Check if result has any lineage edges using ontology-derived types
        has_direct_lineage = any(
            self._normalize_edge_type(e.edge_type) in lineage_types
            for e in result.edges
        )
        
        if has_direct_lineage:
            # Check if we should merge with parent anyway? 
            # Usually strict inheritance means "use parent if child has none".
            # But if we want comprehensive "context", maybe we always add parent?
            # For now, stick to standard inheritance pattern.
            return result
        
        # Try to get parent's lineage
        parent = await self.provider.get_parent(urn)
        if not parent:
            return result  # No parent, nothing to inherit
        
        # Fetch parent's lineage
        parent_result = await self.provider.get_full_lineage(
            parent.urn, upstream_depth, downstream_depth, include_column_lineage=True
        )
        
        # Filter containment edges from parent result too
        # parent_result = self._filter_containment_edges(parent_result, containment_types)
        
        # Merge: Add original node to parent's result, mark as inherited
        merged_nodes = list(parent_result.nodes)
        original_node = next((n for n in result.nodes if n.urn == urn), None)
        if original_node and original_node not in merged_nodes:
            # We want to insert it, but ensure we don't duplicate
            merged_nodes.append(original_node)
        
        # Update upstream/downstream to include parent
        merged_upstream = parent_result.upstream_urns.copy()
        merged_downstream = parent_result.downstream_urns.copy()
        
        # Mark the inheritance in aggregated edges metadata
        aggregated = parent_result.aggregated_edges or {}
        aggregated['_inheritedFrom'] = parent.urn
        
        return LineageResult(
            nodes=merged_nodes,
            edges=parent_result.edges,
            upstreamUrns=merged_upstream,
            downstreamUrns=merged_downstream,
            totalCount=len(merged_nodes),
            hasMore=parent_result.has_more,
            aggregatedEdges=aggregated
        )

    def _project_graph(
        self,
        result: LineageResult,
        target_granularity: Optional[str],
        aggregate_edges: bool,
        containment_map: Optional[Dict[str, str]] = None,
        containment_types: Optional[Set[str]] = None
    ) -> LineageResult:
        nodes = result.nodes
        edges = result.edges

        if containment_types is None:
            containment_types = set()

        # Use provided containment map or build from edges
        if containment_map is None:
            containment_map = self._build_containment_map(nodes, edges, containment_types)

        # target_level: nodes at or coarser (level <=) are visible; finer nodes collapse upward.
        # Level 0 = coarsest (root). None target = show everything.
        tlevel = self._target_level(target_granularity)

        visible_nodes = []
        visible_node_ids = set()

        for node in nodes:
            entity_key = str(node.entity_type)
            node_level = self._entity_level(entity_key)
            # Include if at or coarser than target (lower or equal level number)
            if tlevel < 0 or node_level <= tlevel:
                visible_nodes.append(node)
                visible_node_ids.add(node.urn)
                
        # Filter edges (keep only those connecting visible nodes, for now)
        # BUT we need to aggregate first!
        
        aggregated_edges_map = {}
        visible_edges = []
        
        if aggregate_edges:
            aggregated_list = self._aggregate_lineage_edges(
                edges, nodes, containment_map, target_granularity, containment_types
            )
            for agg in aggregated_list:
                # Only include if both source/target are visible
                if agg["sourceUrn"] in visible_node_ids and agg["targetUrn"] in visible_node_ids:
                    agg_id = agg["id"]
                    aggregated_edges_map[agg_id] = agg
                    
                    # Create a synthetic edge for the graph
                    visible_edges.append(GraphEdge(
                        id=agg_id,
                        sourceUrn=agg["sourceUrn"],
                        targetUrn=agg["targetUrn"],
                        edgeType="AGGREGATED",
                        confidence=agg["confidence"],
                        properties={
                            "isAggregated": True,
                            "sourceEdgeCount": len(agg["sourceEdges"])
                        }
                    ))
        
        # Add original edges that are visible at this level
        for edge in edges:
            if edge.source_urn in visible_node_ids and edge.target_urn in visible_node_ids:
                # If it's a containment edge, keep it if it fits
                edge_type_normalized = self._normalize_edge_type(edge.edge_type)
                if edge_type_normalized in containment_types:
                     visible_edges.append(edge)
                else:
                    visible_edges.append(edge)

        # Update upstream/downstream URNs to reflect visible nodes?
        # Actually LineageResult.upstream_urns usually refers to the root entities found.
        # We might need to map them to ancestors if they were columns.
        new_upstream = set()
        for urn in result.upstream_urns:
            ancestor = self._find_ancestor_at_granularity(urn, target_granularity, nodes, containment_map)
            if ancestor: new_upstream.add(ancestor)
            
        new_downstream = set()
        for urn in result.downstream_urns:
            ancestor = self._find_ancestor_at_granularity(urn, target_granularity, nodes, containment_map)
            if ancestor: new_downstream.add(ancestor)

        return LineageResult(
            nodes=visible_nodes,
            edges=visible_edges,
            upstreamUrns=new_upstream,
            downstreamUrns=new_downstream,
            totalCount=len(visible_nodes),
            hasMore=False,
            aggregatedEdges=aggregated_edges_map
        )

    def _build_containment_map(
        self, nodes: List[GraphNode], edges: List[GraphEdge],
        containment_types: Set[str]
    ) -> Dict[str, str]:
        """Build child -> parent mapping using ontology-classified containment types."""
        containment = {}
        for edge in edges:
            edge_type_normalized = self._normalize_edge_type(edge.edge_type)
            if edge_type_normalized in containment_types or edge.properties.get("relationship") == "contains":
                containment[edge.target_urn] = edge.source_urn
        return containment

    def _find_ancestor_at_granularity(
        self,
        urn: str,
        target_granularity: Optional[str],
        nodes: List[GraphNode],
        containment_map: Dict[str, str]
    ) -> Optional[str]:
        """
        Walk up the containment chain from `urn` until reaching a node whose
        hierarchy.level <= the target type's level (i.e. at or coarser than target).
        Returns the URN of that ancestor, or None if not found.
        target_granularity=None means no projection — always return the node itself.
        """
        if target_granularity is None:
            return urn

        node_map = {n.urn: n for n in nodes}
        tlevel = self._target_level(target_granularity)

        current_urn = urn
        visited: Set[str] = set()

        while current_urn and current_urn not in visited:
            visited.add(current_urn)
            node = node_map.get(current_urn)
            if node:
                node_level = self._entity_level(str(node.entity_type))
            else:
                # Ancestor not in our node set — treat as coarser (level 0) so we stop here
                node_level = 0

            if node_level <= tlevel:
                return current_urn

            current_urn = containment_map.get(current_urn)

        return None

    def _aggregate_lineage_edges(
        self,
        edges: List[GraphEdge],
        nodes: List[GraphNode],
        containment_map: Dict[str, str],
        target_granularity: Optional[str],
        containment_types: Optional[Set[str]] = None
    ) -> List[Dict[str, Any]]:
        
        if containment_types is None:
            containment_types = set()
        
        aggregated_map = {} # key -> data
        
        for edge in edges:
            # Skip containment edges — ontology-driven
            edge_type_normalized = self._normalize_edge_type(edge.edge_type)
            if edge_type_normalized in containment_types:
                continue
                
            source_ancestor = self._find_ancestor_at_granularity(
                edge.source_urn, target_granularity, nodes, containment_map
            )
            target_ancestor = self._find_ancestor_at_granularity(
                edge.target_urn, target_granularity, nodes, containment_map
            )
            
            if source_ancestor and target_ancestor and source_ancestor != target_ancestor:
                key = f"{source_ancestor}->{target_ancestor}"
                
                if key not in aggregated_map:
                    aggregated_map[key] = {
                        "id": f"agg-{key}",
                        "sourceUrn": source_ancestor,
                        "targetUrn": target_ancestor,
                        "sourceEdges": [],
                        "confidence": 0.0,
                        "granularity": target_granularity
                    }
                
                aggregated_map[key]["sourceEdges"].append(edge.id)
                # Simple confidence logic
                count = len(aggregated_map[key]["sourceEdges"])
                aggregated_map[key]["confidence"] = min(1.0, count / 5.0) # Arbitrary scaling

        return list(aggregated_map.values())

    # ------------------------------------------------------------------ #
    # Trace v2 — thin pass-through to the provider primitives             #
    #                                                                     #
    # The provider does the BFS in Cypher (per-hop set-based) — the      #
    # engine just resolves config (level, lineage types, max_nodes,      #
    # timeout) and forwards. No Python aggregation work; cost scales     #
    # with result size, not graph size.                                   #
    # ------------------------------------------------------------------ #

    async def trace(self, req: TraceRequest) -> TraceResult:
        # Use the RESOLVED ontology (carries entity_type_definitions with
        # hierarchy.level) — get_ontology_metadata() returns the flat
        # OntologyMetadata projection which only has entity_type_hierarchy
        # (canContain/canBeContainedBy) and no level info, so _resolve_level
        # would silently fall back to 0 with that.
        resolved = await self._resolve_ontology()
        level = await self._resolve_level(req.level, req.urn, resolved)
        edge_types = req.lineage_edge_types or list(resolved.lineage_edge_types or [])
        containment_types = list(resolved.containment_edge_types or [])

        async with self._trace_semaphore():
            return await self.provider.trace_at_level(
                urn=req.urn,
                level=level,
                upstream_depth=req.upstream_depth if req.direction in ("upstream", "both") else 0,
                downstream_depth=req.downstream_depth if req.direction in ("downstream", "both") else 0,
                lineage_edge_types=edge_types,
                containment_edge_types=containment_types,
                max_nodes=ContextEngine.TRACE_MAX_NODES,
                timeout_ms=ContextEngine.TRACE_TIMEOUT_MS,
                include_containment_edges=req.include_containment_edges,
                include_inherited_lineage=req.include_inherited_lineage,
            )

    async def trace_closure(self, req: TraceClosureRequest) -> TraceClosureResult:
        """Focus-scoped, regime-independent lineage closure — ONE step of a walk.

        The provider walks RAW lineage outward from the focus (or from
        ``req.seed_urns`` when continuing a walk) — correct at the finest
        grain regardless of aggregation regime, showing only lineage hops
        (containment only seeds/nests). Deliberately NO level resolution:
        the closure is level-free by design, unlike ``trace``. Behind the
        same per-(provider, graph) trace semaphore + engine deadline.
        """
        resolved = await self._resolve_ontology()
        # SYNTHETIC EDGES ARE NOT LINEAGE. See SYNTHETIC_LINEAGE_EDGE_TYPES:
        # a source's resolved ontology routinely LISTS ``AGGREGATED`` among
        # its lineage types, but those relationships are the aggregation
        # worker's own materialised rollups, not anything a data source
        # said. Walking them counts one real flow once per coarser grain
        # above it, which is what put "5 in / 4 out" on a column with two
        # real neighbours — and it contradicts this closure's whole design,
        # which is regime-independent precisely because it depends on NO
        # ``:AGGREGATED`` cells.
        #
        # Filtered from BOTH the resolved default and anything a caller
        # asked for, at this one seam: the provider hands the same list to
        # its BFS, its cursor page AND its degree probe, so the counts the
        # frontier reports stay consistent with the edges that shipped.
        edge_types = _real_lineage_types(
            req.lineage_edge_types or list(resolved.lineage_edge_types or [])
        )
        containment_types = list(resolved.containment_edge_types or [])
        max_nodes = min(req.max_nodes or ContextEngine.TRACE_MAX_NODES, ContextEngine.TRACE_MAX_NODES)
        fn = getattr(self.provider, "trace_closure", None)
        if fn is None:
            raise NotImplementedError("provider does not support trace_closure")

        async with self._trace_semaphore():
            return await fn(
                urn=req.urn,
                upstream_depth=req.upstream_depth if req.direction in ("upstream", "both") else 0,
                downstream_depth=req.downstream_depth if req.direction in ("downstream", "both") else 0,
                lineage_edge_types=edge_types,
                containment_edge_types=containment_types,
                max_nodes=max_nodes,
                timeout_ms=ContextEngine.TRACE_TIMEOUT_MS,
                seed_urns=req.seed_urns,
                exclude_urns=req.exclude_urns,
                after_cursor=req.after_cursor,
            )

    # ------------------------------------------------------------------ #
    # Trace v2 wrappers — skeleton-first contract                          #
    #                                                                     #
    # get_trace_v2 / get_trace_delta_v2 are the V2 entry points called    #
    # by /api/v2/{ws}/graph/trace and /trace/expand. They:                #
    #   1. Clamp "auto" → 0 (skeleton-first; peer-rollup is opt-in)       #
    #   2. Call the existing trace / expand_aggregated_edge primitives    #
    #   3. Populate TraceMeta (regime, timing, truncation, megaNodes)     #
    #   4. Validate the ancestor-chain invariant (every node has its      #
    #      containment ancestors present — required by canvas layer       #
    #      assignment)                                                     #
    # ------------------------------------------------------------------ #

    async def get_trace_v2(self, req: TraceRequest) -> TraceResultV2:
        """Skeleton-first trace. Default ``level=0`` returns the top-level
        Domain skeleton; clients drill down via /trace/expand."""
        # Skeleton-first: "auto" is treated as 0 in V2 (top-level rollup).
        # Callers wanting peer-level rollup must pass an explicit int.
        if req.level == "auto":
            req = req.model_copy(update={"level": 0})

        start_ms = time.monotonic()
        result = await self.trace(req)
        cypher_ms = int((time.monotonic() - start_ms) * 1000)

        self._validate_ancestor_chain(result, regime="skeleton")
        meta = self._build_trace_meta(result, regime="skeleton", cypher_ms=cypher_ms)
        return TraceResultV2(**result.model_dump(by_alias=True), meta=meta)

    async def get_trace_delta_v2(self, req: TraceExpandRequest) -> TraceDelta:
        """Skeleton-first drill-down. Stateless: the (source_urn, target_urn,
        next_level) triple is sufficient — no server session lookup."""
        start_ms = time.monotonic()
        # TraceExpandRequest extends ExpandRequest; pass through directly.
        result = await self.expand_aggregated_edge(req)
        cypher_ms = int((time.monotonic() - start_ms) * 1000)

        self._validate_ancestor_chain(result, regime="expand")
        meta = self._build_trace_meta(
            result, regime="expand", cypher_ms=cypher_ms,
            trace_session_id=req.trace_session_id,
        )
        return TraceDelta(**result.model_dump(by_alias=True), meta=meta)

    def _build_trace_meta(
        self,
        result: TraceResult,
        *,
        regime: str,
        cypher_ms: int,
        trace_session_id: Optional[str] = None,
    ) -> TraceMeta:
        """Project provider response into TraceMeta. Reads optional
        provider-stamped fields (mega_nodes, fallback_level) off the result
        if the provider exposed them; otherwise empty/None."""
        # Provider may stamp these as private attributes (set via
        # model_copy / property override). Read defensively.
        mega_nodes_raw = getattr(result, "_mega_nodes", None) or []
        fallback_level = getattr(result, "_fallback_level", None)

        mega_nodes = [
            mn if isinstance(mn, MegaNodeInfo) else MegaNodeInfo(**mn)
            for mn in mega_nodes_raw
        ]
        # Read the provider's cached level-stamp staleness. False (the
        # default) covers providers that don't track it. When True, some
        # AGGREGATED edges have a missing/stale levelDigest — results are
        # still correct (label-scan fallback) but slower; UI can show a
        # hint that backfill is needed.
        stale_levels = getattr(self.provider, "_levels_backfilled", None) is False

        return TraceMeta(
            regime=regime,
            effectiveLevel=result.effective_level,
            truncationReason=result.truncation_reason,
            cypherMs=cypher_ms,
            nodeCount=len(result.nodes),
            edgeCount=len(result.edges) + len(result.containment_edges),
            fallbackLevel=fallback_level,
            megaNodes=mega_nodes,
            traceSessionId=trace_session_id,
            staleLevels=stale_levels,
        )

    def _validate_ancestor_chain(self, result: TraceResult, *, regime: str) -> None:
        """Enforce the ancestor-chain invariant.

        Every node N in result.nodes must have every containment ancestor
        of N (up to a level-0 root) also present. Required by
        ``useLayerAssignment`` in ContextViewCanvas — children inherit
        their parent's layer, so an orphan deep node has no layer.

        In dev (``TRACE_INVARIANT_STRICT=1``) this raises; in prod it logs
        a warning. The auto-hydration repair path is intentionally not
        implemented here — if the provider is dropping ancestors, that's
        a provider bug, not something to paper over silently."""
        import os
        if not getattr(self, "_invariant_strict", None):
            self._invariant_strict = os.getenv("TRACE_INVARIANT_STRICT", "0") == "1"

        urns_present = {n.urn for n in result.nodes}
        # Containment edges define parent (source) → child (target). For every
        # node, walk up via containment edges and assert each parent is present.
        parent_of: Dict[str, str] = {}
        for ce in result.containment_edges:
            parent_of[ce.target_urn] = ce.source_urn

        missing: List[str] = []
        for urn in list(urns_present):
            cur = urn
            while cur in parent_of:
                parent = parent_of[cur]
                if parent not in urns_present:
                    missing.append(parent)
                    break
                cur = parent

        if missing:
            msg = (
                "trace_invariant_violation regime=%s focus=%s missing_ancestors=%d sample=%s"
                % (regime, result.focus.urn, len(missing), missing[:5])
            )
            if self._invariant_strict:
                raise AssertionError(msg)
            logger.warning(msg)

    async def expand_aggregated_edge(self, req: ExpandRequest) -> TraceResult:
        resolved = await self._resolve_ontology()
        # next_level can be int, entity-type-id, or ABSENT. Absent must
        # survive to the provider as None — it means "drill structurally,
        # one containment step", the only honest ask when the ontology
        # repeats a type at two depths. _resolve_level would coerce None
        # through its "auto" branch into the source's own level, which
        # silently turned a structural request back into the level-pair
        # query the caller was trying to avoid.
        level = (
            None if req.next_level is None
            else await self._resolve_level(req.next_level, req.source_urn, resolved)
        )
        edge_types = req.lineage_edge_types or list(resolved.lineage_edge_types or [])
        containment_types = list(resolved.containment_edge_types or [])

        # Use raw edges when next_level is the finest level in the ontology
        # — at that level AGGREGATED is 1:1 with raw lineage anyway, but
        # raw is safer (no dependency on materialization having run). A
        # structural drill (level None) lets the provider's own
        # agg-first / empty→raw fallback decide instead.
        finest_level = self._finest_level(resolved)
        use_raw = (level is not None and finest_level is not None and level >= finest_level)

        async with self._trace_semaphore():
            return await self.provider.expand_aggregated(
                source_urn=req.source_urn,
                target_urn=req.target_urn,
                next_level=level,
                lineage_edge_types=edge_types,
                containment_edge_types=containment_types,
                max_nodes=ContextEngine.TRACE_MAX_NODES,
                timeout_ms=ContextEngine.TRACE_TIMEOUT_MS,
                use_raw_edges=use_raw,
                include_containment_edges=req.include_containment_edges,
                drill_anchor=getattr(req, "drill_anchor", None),
            )

    async def _resolve_level(self, level_input: Any, source_urn: str, ontology: Any) -> int:
        """Resolve a level specifier (``"auto" | int | entity-type-id``) to an int.

        ``"auto"`` resolves to the source node's own ``hierarchy.level`` —
        peer rollup. An integer is returned unchanged. A string entity-type-id
        is looked up in the resolved ontology.
        """
        if isinstance(level_input, int):
            return level_input
        if isinstance(level_input, str) and level_input != "auto":
            level = self._level_from_entity_type(level_input, ontology)
            if level is not None:
                return level
            logger.warning("Unknown entity-type-id for level: %s — falling back to 'auto'", level_input)

        # "auto" — peer rollup at source's own level
        node = await self.provider.get_node(source_urn)
        if node:
            level = self._level_from_entity_type(str(node.entity_type), ontology)
            if level is not None:
                return level
        return 0  # safe default: top-level

    def _level_from_entity_type(self, entity_type_id: str, ontology: Any) -> Optional[int]:
        defs = getattr(ontology, "entity_type_definitions", None) or {}
        et_def = defs.get(entity_type_id)
        if et_def is None:
            return None
        hierarchy = getattr(et_def, "hierarchy", None)
        if hierarchy is None:
            return None
        level = getattr(hierarchy, "level", None)
        return level if isinstance(level, int) else None

    def _finest_level(self, ontology: Any) -> Optional[int]:
        """Return the largest hierarchy.level in the ontology (= finest grain)."""
        defs = getattr(ontology, "entity_type_definitions", None) or {}
        levels: List[int] = []
        for et_def in defs.values():
            hierarchy = getattr(et_def, "hierarchy", None)
            if hierarchy is not None:
                lvl = getattr(hierarchy, "level", None)
                if isinstance(lvl, int):
                    levels.append(lvl)
        return max(levels) if levels else None

    # PROCESS-WIDE trace semaphores, keyed by the provider's manager
    # identity (fallback: (workspace, data_source)). Engines are
    # constructed per request, so a per-instance semaphore capped
    # nothing — 100 concurrent trace requests each got their own
    # fresh Semaphore(4). Module-level registry gives a real per-
    # (provider, graph) × per-process cap, backstopped by the
    # provider's own _query_semaphore. FIFO-bounded like the worker's
    # ds-meta cache so deleted graphs don't accumulate entries.
    _TRACE_SEMAPHORES: Dict[Any, asyncio.Semaphore] = {}
    _TRACE_SEMAPHORES_MAX = 256

    def _trace_semaphore(self) -> asyncio.Semaphore:
        key = getattr(getattr(self, "provider", None), "manager_cache_key", None)
        if key is None:
            key = (
                getattr(self, "_workspace_id", None),
                getattr(self, "_data_source_id", None),
            )
        sem = self._TRACE_SEMAPHORES.get(key)
        if sem is None:
            import os
            limit = int(os.getenv("TRACE_CONCURRENCY", "4"))
            if len(self._TRACE_SEMAPHORES) >= self._TRACE_SEMAPHORES_MAX:
                oldest = next(iter(self._TRACE_SEMAPHORES))
                self._TRACE_SEMAPHORES.pop(oldest, None)
            sem = asyncio.Semaphore(limit)
            self._TRACE_SEMAPHORES[key] = sem
        return sem

    # Hard caps for trace v2. TRACE_MAX_NODES still env-var driven here
    # (it's not a timeout); TRACE_TIMEOUT_MS derives from the central
    # TRACE_TIMEOUT_SECS in app.config.resilience so a single env var
    # tunes both backend layers and stays in sync with the frontend.
    import os as _os
    TRACE_MAX_NODES: int = int(_os.getenv("TRACE_MAX_NODES", "2000"))
    # Engine budget sits BELOW the HTTP middleware tier by the headroom,
    # so the engine's truncated-200 (timeout/max_nodes/ancestors_failed)
    # always beats the middleware 504.
    TRACE_TIMEOUT_MS: int = int(
        max(5.0, TRACE_TIMEOUT_SECS - TRACE_ENGINE_HEADROOM_SECS) * 1000
    )
    del _os

    async def get_ancestors(self, urn: str, limit: int = 100, offset: int = 0) -> List[GraphNode]:
        return await self.provider.get_ancestors(urn, limit=limit, offset=offset)

    async def get_descendants(
        self, 
        urn: str, 
        depth: int = 5, 
        entity_types: Optional[List[str]] = None,
        limit: int = 100, 
        offset: int = 0
    ) -> List[GraphNode]:
        return await self.provider.get_descendants(urn, depth=depth, entity_types=entity_types, limit=limit, offset=offset)

    async def get_nodes_by_tag(self, tag: str, limit: int = 100, offset: int = 0) -> List[GraphNode]:
        return await self.provider.get_nodes_by_tag(tag, limit=limit, offset=offset)

    async def get_nodes_by_layer(
        self, layer_id: str, limit: int = 100, offset: int = 0,
        sort_direction: str = "asc", cursor: Optional[str] = None,
    ) -> List[GraphNode]:
        return await self.provider.get_nodes_by_layer(
            layer_id, limit=limit, offset=offset,
            sort_direction=sort_direction, cursor=cursor,
        )

    async def get_graph_schema(
        self,
        stats: Optional[GraphSchemaStats] = None,
        ontology: Optional[OntologyMetadata] = None,
    ) -> GraphSchema:
        """
        Build a complete graph schema from resolved ontology definitions and introspection stats.
        Uses the rich entity/relationship definitions from the OntologyService when available;
        falls back to generating definitions from introspection stats + minimal defaults.

        ``stats`` / ``ontology`` may be passed pre-fetched so a caller
        that already ran ``get_schema_stats()`` / ``get_ontology_metadata()``
        (the insights collector) doesn't trigger the full-graph scans a
        second time. When passing ``ontology``, call
        ``get_ontology_metadata()`` on THIS engine first — the rich path
        below reads ``_resolved_ontology_cache``, which that call populates.
        """
        if stats is None:
            stats = await self.provider.get_schema_stats()
        if ontology is None:
            # Calling get_ontology_metadata() will also populate _resolved_ontology_cache
            ontology = await self.get_ontology_metadata()

        resolved = self._resolved_ontology_cache
        entity_types: List[EntityTypeDefinition] = []
        relationship_types: List[RelationshipTypeDefinition] = []

        if resolved and resolved.entity_type_definitions:
            # Rich path: build from ontology service definitions
            entity_types = self._build_entity_types_from_resolved(stats, resolved)
            relationship_types = self._build_rel_types_from_resolved(stats, ontology, resolved)
        else:
            # Legacy/fallback path: minimal definitions from stats + defaults
            from ..ontology.defaults import SYSTEM_ENTITY_TYPES, SYSTEM_RELATIONSHIP_TYPES
            from ..ontology.resolver import parse_entity_definitions, parse_relationship_definitions
            sys_ent = parse_entity_definitions(SYSTEM_ENTITY_TYPES)
            sys_rel = parse_relationship_definitions(SYSTEM_RELATIONSHIP_TYPES)
            entity_types = self._build_entity_types_from_dicts(stats, ontology, sys_ent)
            relationship_types = self._build_rel_types_from_dicts(stats, ontology, sys_rel)

        # Compute the ontology digest from the same OntologyMetadata
        # projection that `get_ontology_digest()` uses, so the value
        # embedded here is byte-identical to what gets stamped onto
        # `ViewORM.ontology_digest` at save time. Keeping the algorithm
        # in one place is important — the ViewWizard drift check is a
        # pure equality test (see `hasOntologyDrifted`).
        try:
            ontology_payload = ontology.model_dump(by_alias=True)
            canonical = _json.dumps(
                ontology_payload, sort_keys=True, separators=(",", ":"), default=str,
            )
            ontology_digest = hashlib.sha256(canonical.encode("utf-8")).hexdigest()
        except Exception as exc:
            logger.warning("get_graph_schema: failed to compute ontology digest (%s)", exc)
            ontology_digest = None

        return GraphSchema(
            version="1.0.0",
            entityTypes=entity_types,
            relationshipTypes=relationship_types,
            rootEntityTypes=ontology.root_entity_types,
            containmentEdgeTypes=ontology.containment_edge_types,
            lineageEdgeTypes=ontology.lineage_edge_types,
            ontologyDigest=ontology_digest,
        )

    def _build_entity_types_from_resolved(self, stats, resolved) -> List[EntityTypeDefinition]:
        """Build EntityTypeDefinition list from rich resolved ontology definitions."""
        from ..ontology.models import EntityTypeDefEntry

        stat_map = {s.id: s for s in stats.entity_type_stats}
        result: List[EntityTypeDefinition] = []

        # Include all types that appear in either stats or resolved definitions
        seen_ids = set(stat_map.keys()) | set(resolved.entity_type_definitions.keys())

        for entity_id in seen_ids:
            ent_def: Optional[EntityTypeDefEntry] = resolved.entity_type_definitions.get(entity_id)
            stat = stat_map.get(entity_id)

            if ent_def is None:
                # Synthesise minimal definition for types only in stats
                from ..ontology.models import EntityTypeDefEntry
                ent_def = EntityTypeDefEntry(name=entity_id.title(), plural_name=entity_id.title() + "s")

            icon = (stat.icon if stat else None) or ent_def.visual.icon
            color = (stat.color if stat else None) or ent_def.visual.color

            result.append(EntityTypeDefinition(
                id=entity_id,
                name=ent_def.name or entity_id.title(),
                pluralName=ent_def.plural_name or (ent_def.name + "s"),
                description=ent_def.description or f"Entity type: {entity_id}",
                visual=EntityVisualSchema(
                    icon=icon,
                    color=color,
                    shape=ent_def.visual.shape,
                    size=ent_def.visual.size,
                    borderStyle=ent_def.visual.border_style,
                    showInMinimap=ent_def.visual.show_in_minimap,
                ),
                fields=[
                    FieldSchema(
                        id=f.id, name=f.name, type=f.type,
                        required=f.required,
                        showInNode=f.show_in_node, showInPanel=f.show_in_panel,
                        showInTooltip=f.show_in_tooltip, displayOrder=f.display_order,
                    )
                    for f in ent_def.fields
                ] or [
                    FieldSchema(id='name', name='Name', type='string', required=True,
                                showInNode=True, showInPanel=True, showInTooltip=True, displayOrder=1),
                ],
                hierarchy=EntityHierarchySchema(
                    level=ent_def.hierarchy.level,
                    canContain=ent_def.hierarchy.can_contain,
                    canBeContainedBy=ent_def.hierarchy.can_be_contained_by,
                    defaultExpanded=ent_def.hierarchy.default_expanded,
                ),
                behavior=EntityBehaviorSchema(
                    selectable=ent_def.behavior.selectable,
                    draggable=ent_def.behavior.draggable,
                    expandable=ent_def.behavior.expandable,
                    traceable=ent_def.behavior.traceable,
                    clickAction=ent_def.behavior.click_action,
                    doubleClickAction=ent_def.behavior.double_click_action,
                ),
            ))

        return result

    def _build_rel_types_from_resolved(self, stats, ontology, resolved) -> List[RelationshipTypeDefinition]:
        """Build RelationshipTypeDefinition list from rich resolved ontology definitions."""
        from ..ontology.models import RelationshipTypeDefEntry

        stat_map = {s.id: s for s in stats.edge_type_stats}
        containment_upper = {t.upper() for t in ontology.containment_edge_types}
        result: List[RelationshipTypeDefinition] = []
        seen_ids = set(stat_map.keys()) | set(resolved.relationship_type_definitions.keys())

        for rel_id in seen_ids:
            rel_def: Optional[RelationshipTypeDefEntry] = resolved.relationship_type_definitions.get(rel_id)
            stat = stat_map.get(rel_id)
            is_containment = rel_id.upper() in containment_upper

            if rel_def is None:
                rel_def = RelationshipTypeDefEntry(name=rel_id.title())
                rel_def.is_containment = is_containment

            result.append(RelationshipTypeDefinition(
                # VERBATIM casing (parity with build_synthetic_schema): the
                # schema id must equal the declared/physical relationship
                # type — the canvas stamps it onto writes (2026-08-19).
                id=rel_id,
                name=rel_def.name or rel_id.title(),
                description=rel_def.description or f"Relationship type: {rel_id}",
                sourceTypes=(stat.source_types if stat else None) or rel_def.source_types,
                targetTypes=(stat.target_types if stat else None) or rel_def.target_types,
                visual=RelationshipVisualSchema(
                    strokeColor=rel_def.visual.stroke_color,
                    strokeWidth=rel_def.visual.stroke_width,
                    strokeStyle=rel_def.visual.stroke_style,
                    animated=rel_def.visual.animated,
                    animationSpeed=rel_def.visual.animation_speed,
                    arrowType=rel_def.visual.arrow_type,
                    curveType=rel_def.visual.curve_type,
                ),
                bidirectional=rel_def.bidirectional,
                showLabel=rel_def.show_label,
                isContainment=rel_def.is_containment,
                isLineage=rel_def.is_lineage,
                category=rel_def.category,
            ))

        return result

    def _build_entity_types_from_dicts(self, stats, ontology, sys_ent) -> List[EntityTypeDefinition]:
        """Fallback: build entity types from defaults dict when no OntologyService is wired."""
        result: List[EntityTypeDefinition] = []
        for stat in stats.entity_type_stats:
            entity_id = stat.id
            ent_def = sys_ent.get(entity_id)
            icon = (stat.icon if stat.icon else None) or (ent_def.visual.icon if ent_def else "Box")
            color = (stat.color if stat.color else None) or (ent_def.visual.color if ent_def else "#6366f1")
            hierarchy_info = ontology.entity_type_hierarchy.get(entity_id, {})
            if isinstance(hierarchy_info, dict):
                can_contain = hierarchy_info.get('canContain', []) or hierarchy_info.get('can_contain', [])
                can_be_contained = hierarchy_info.get('canBeContainedBy', []) or hierarchy_info.get('can_be_contained_by', [])
            else:
                can_contain = getattr(hierarchy_info, 'can_contain', None) or getattr(hierarchy_info, 'canContain', []) or []
                can_be_contained = (
                    getattr(hierarchy_info, 'can_be_contained_by', None)
                    or getattr(hierarchy_info, 'canBeContainedBy', [])
                    or []
                )
            level = ent_def.hierarchy.level if ent_def else 3

            result.append(EntityTypeDefinition(
                id=entity_id,
                name=stat.name,
                pluralName=f"{stat.name}s",
                description=f"Entity type: {stat.name}",
                visual=EntityVisualSchema(
                    icon=icon,
                    color=color,
                    shape=ent_def.visual.shape if ent_def else "rounded",
                    size=ent_def.visual.size if ent_def else "md",
                    borderStyle="solid",
                    showInMinimap=level <= 3,
                ),
                fields=[
                    FieldSchema(id='name', name='Name', type='string', required=True,
                                showInNode=True, showInPanel=True, showInTooltip=True, displayOrder=1),
                ],
                hierarchy=EntityHierarchySchema(
                    level=level, canContain=can_contain,
                    canBeContainedBy=can_be_contained, defaultExpanded=level <= 1,
                ),
                behavior=EntityBehaviorSchema(
                    selectable=True, draggable=level <= 3,
                    expandable=len(can_contain) > 0, traceable=True,
                    clickAction='select',
                    doubleClickAction='expand' if can_contain else 'panel',
                ),
            ))
        return result

    def _build_rel_types_from_dicts(self, stats, ontology, sys_rel) -> List[RelationshipTypeDefinition]:
        """Fallback: build relationship types from defaults dict when no OntologyService is wired."""
        result: List[RelationshipTypeDefinition] = []
        containment_upper = {t.upper() for t in ontology.containment_edge_types}
        lineage_upper = {t.upper() for t in ontology.lineage_edge_types}
        for stat in stats.edge_type_stats:
            edge_id = stat.id
            rel_def = sys_rel.get(edge_id.upper()) or sys_rel.get(edge_id)
            is_containment = edge_id.upper() in containment_upper
            is_lineage = edge_id.upper() in lineage_upper
            result.append(RelationshipTypeDefinition(
                id=edge_id.lower(),
                name=stat.name,
                description=f"Relationship type: {stat.name}",
                sourceTypes=stat.source_types,
                targetTypes=stat.target_types,
                visual=RelationshipVisualSchema(
                    strokeColor=rel_def.visual.stroke_color if rel_def else "#6366f1",
                    strokeWidth=rel_def.visual.stroke_width if rel_def else 2,
                    strokeStyle=rel_def.visual.stroke_style if rel_def else "solid",
                    animated=rel_def.visual.animated if rel_def else True,
                    animationSpeed="normal",
                    arrowType=rel_def.visual.arrow_type if rel_def else "arrow",
                    curveType="bezier",
                ),
                bidirectional=False,
                showLabel=rel_def.show_label if rel_def else False,
                isContainment=is_containment,
                isLineage=is_lineage,
                category=rel_def.category if rel_def else ("structural" if is_containment else "flow" if is_lineage else "association"),
            ))
        return result

    async def get_aggregated_edges(self, request: AggregatedEdgeRequest) -> AggregatedEdgeResult:
        """
        Get aggregated edges between containers at a specified granularity.
        Delegates to provider for optimized Cypher execution.
        """
        # Load ontology metadata for edge classification
        ontology = await self.get_ontology_metadata()

        # Determine active lineage types
        if request.lineage_edge_types:
            lineage_types = request.lineage_edge_types
        else:
            # Default: use all known lineage types from ontology
            # If user passed include_edge_types (legacy), use that?
            if request.include_edge_types:
                lineage_types = [t.value if hasattr(t, "value") else str(t) for t in request.include_edge_types]
            else:
                lineage_types = ontology.lineage_edge_types

        # Determine containment types
        if request.containment_edge_types:
            containment_types = request.containment_edge_types
        else:
            containment_types = ontology.containment_edge_types

        result = await self.provider.get_aggregated_edges_between(
            source_urns=request.source_urns,
            target_urns=request.target_urns,
            granularity=request.granularity,
            containment_edges=list(containment_types),
            lineage_edges=list(lineage_types),
            timeout=FALKORDB_AGGREGATED_READ_TIMEOUT_SECS,
        )

        # Reads NEVER trigger materialization. Aggregation is event-driven
        # — projection on merge/publish/import (projection_target._hook) and
        # post-purge (worker) — plus manual (control plane) and a scheduled
        # drift sweep. A browse must not enqueue a multi-minute worker job:
        # the removed read-path "auto" trigger fired on transient read-cache
        # conditions (chain_cache_miss) and, because nothing on the browse
        # path warmed that cache, looped "verified · no changes" every
        # damping window on perfectly healthy graphs. Freshness is still
        # reported honestly on the result (stale / stale_reason /
        # stamp_version / regime) so the UI can surface a "re-aggregate"
        # affordance; the one-time migration heals the legacy
        # stampVersion<2 backlog. See readpath-perf plan, trigger-model
        # decision (2026-07-12).
        return result

    async def create_node(self, request: CreateNodeRequest) -> CreateNodeResult:
        """
        Create a new node with optional automatic containment edge.
        Validates against the resolved ontology before creation.
        """
        from datetime import datetime
        from backend.app.ontology.urn import make_urn
        from backend.app.ontology.mutation_validator import (
            MutationOp,
            validate_node_mutation,
        )

        # Resolve the ontology once (cached by ContextEngine)
        resolved = await self._get_resolved_ontology()

        # Validate parent relationship if specified
        containment_edge = None
        parent_entity_type: Optional[str] = None
        if request.parent_urn:
            parent_node = await self.provider.get_node(request.parent_urn)
            if not parent_node:
                return CreateNodeResult(
                    node=None,
                    containmentEdge=None,
                    success=False,
                    error=f"Parent node not found: {request.parent_urn}",
                )
            parent_entity_type = str(parent_node.entity_type)

        # Ontology-driven validation
        validation_warnings: List[str] = []
        result = validate_node_mutation(
            op=MutationOp.CREATE,
            entity_type=str(request.entity_type),
            ontology=resolved,
            parent_entity_type=parent_entity_type,
        )
        if not result.ok:
            return CreateNodeResult(
                node=None,
                containmentEdge=None,
                success=False,
                error="; ".join(result.errors),
            )
        validation_warnings = result.warnings or []

        # Generate a canonical Synodic URN
        urn = make_urn(entity_type=str(request.entity_type), source_system="manual")

        if request.parent_urn and parent_entity_type:

            # Ontology-authoritative: default to the ontology's first containment relationship, or
            # None when the ontology declares none — never a fabricated 'CONTAINS'. A client-chosen
            # type (validated below) overrides this.
            containment_type = (
                resolved.containment_edge_types[0]
                if (resolved and resolved.containment_edge_types) else None
            )

            # Honour a client-chosen containment relationship, validated against the
            # resolved ontology: it must be a real containment type, and (when the
            # relationship declares endpoint constraints) compatible with the parent/
            # child entity types in the FORWARD orientation. The edge is always stored
            # parent→child (source=parent), so the parent must be an allowed source and
            # the child an allowed target — a predicate authored child→parent would be
            # persisted against its own constraints. Reject an invalid choice rather
            # than silently substituting.
            requested = request.containment_edge_type
            if requested:
                ct_by_upper = {t.upper(): t for t in (resolved.containment_edge_types if resolved else [])}
                canonical = ct_by_upper.get(requested.upper())
                if not canonical:
                    return CreateNodeResult(
                        node=None, containmentEdge=None, success=False,
                        error=f"'{requested}' is not a containment relationship type",
                    )
                rel_def = (resolved.relationship_type_definitions.get(canonical) if resolved else None)
                if rel_def is not None:
                    src = list(getattr(rel_def, "source_types", None) or [])
                    tgt = list(getattr(rel_def, "target_types", None) or [])

                    def _ok(entity: str, allowed: List[str]) -> bool:
                        # Case-insensitive membership: a discovered graph's entity type
                        # may be cased differently than the ontology's canonical id.
                        return (not allowed) or ("*" in allowed) or (entity.upper() in {a.upper() for a in allowed})

                    if not (_ok(parent_entity_type, src) and _ok(str(request.entity_type), tgt)):
                        return CreateNodeResult(
                            node=None, containmentEdge=None, success=False,
                            error=(
                                f"'{canonical}' can't nest a '{request.entity_type}' under a "
                                f"'{parent_entity_type}'"
                            ),
                        )
                containment_type = canonical

            # No ontology containment relationship (and no client choice) ⇒ create the node at the
            # root instead of under a synthesized edge the ontology never declared.
            if containment_type:
                containment_edge = GraphEdge(
                    id=f"contains-{request.parent_urn}-{urn}",
                    sourceUrn=request.parent_urn,
                    targetUrn=urn,
                    edgeType=containment_type,
                    confidence=1.0,
                    properties={}
                )
        
        # Create the node
        new_node = GraphNode(
            urn=urn,
            entityType=request.entity_type,
            displayName=request.display_name,
            qualifiedName=request.properties.get('qualifiedName', request.display_name),
            description=request.properties.get('description'),
            properties=request.properties,
            tags=request.tags,
            layerAssignment=request.properties.get('layerAssignment'),
            childCount=0,
            sourceSystem='manual',
            lastSyncedAt=datetime.utcnow().isoformat()
        )
        
        # Save to provider (if provider supports it)
        try:
            success = await self.provider.create_node(new_node, containment_edge)
            if not success:
                return CreateNodeResult(
                    node=None,
                    containmentEdge=None,
                    success=False,
                    error="Provider failed to create node"
                )
        except NotImplementedError:
            # Provider doesn't support creation - return the node anyway for optimistic UI
            logger.warning("Provider does not support node creation - returning optimistic result")
        except Exception as e:
            return CreateNodeResult(
                node=None,
                containmentEdge=None,
                success=False,
                error=str(e)
            )
        
        return CreateNodeResult(
            node=new_node,
            containmentEdge=containment_edge,
            success=True,
            error=None,
            warnings=validation_warnings,
        )

    # ------------------------------------------------------------------ #
    # Edge CRUD                                                            #
    # ------------------------------------------------------------------ #

    async def create_edge(self, request) -> Any:
        """
        Create a directed edge with ontology-driven source/target validation.
        Returns an EdgeMutationResult.
        """
        import uuid as _uuid
        from backend.app.ontology.mutation_validator import MutationOp, validate_edge_mutation
        from backend.common.models.graph import EdgeMutationResult

        resolved = await self._get_resolved_ontology()

        # Fetch source and target nodes to get their entity types
        source_node = await self.provider.get_node(request.source_urn)
        target_node = await self.provider.get_node(request.target_urn)

        if not source_node:
            return EdgeMutationResult(success=False, error=f"Source node not found: {request.source_urn}")
        if not target_node:
            return EdgeMutationResult(success=False, error=f"Target node not found: {request.target_urn}")

        # Validate against ontology (fail-open when no ontology is active)
        val = validate_edge_mutation(
            op=MutationOp.CREATE,
            edge_type=request.edge_type,
            source_entity_type=str(source_node.entity_type),
            target_entity_type=str(target_node.entity_type),
            ontology=resolved,
        )
        if not val.ok:
            return EdgeMutationResult(success=False, error="; ".join(val.errors), warnings=val.warnings)

        edge_id = request.idempotency_key or f"edge-{_uuid.uuid4().hex[:12]}"
        edge = GraphEdge(
            id=edge_id,
            sourceUrn=request.source_urn,
            targetUrn=request.target_urn,
            edgeType=request.edge_type,
            confidence=1.0,
            properties=request.properties,
        )

        try:
            await self.provider.create_edge(edge)
        except (NotImplementedError, AttributeError):
            logger.warning("Provider does not support edge creation — returning optimistic result")
        except Exception as exc:
            from backend.app.services.versioning.service import OntologyViolation
            if isinstance(exc, OntologyViolation):       # surface the per-edge reasons, not the count
                reasons = "; ".join(v.get("reason", "") for v in exc.violations) or str(exc)
                return EdgeMutationResult(success=False, error=reasons, warnings=val.warnings or [])
            return EdgeMutationResult(success=False, error=str(exc))

        return EdgeMutationResult(edge=edge, success=True, warnings=val.warnings or [])

    async def update_edge(self, edge_id: str, request) -> Any:
        """Update mutable edge properties."""
        from backend.common.models.graph import EdgeMutationResult

        try:
            edge = await self.provider.update_edge(edge_id, request.properties)
            if edge is None:
                return EdgeMutationResult(success=False, error=f"Edge '{edge_id}' not found")
            return EdgeMutationResult(edge=edge, success=True)
        except (NotImplementedError, AttributeError):
            return EdgeMutationResult(success=False, error="Provider does not support edge updates")
        except Exception as exc:
            return EdgeMutationResult(success=False, error=str(exc))

    async def delete_edge(self, edge_id: str) -> bool:
        """Delete an edge by ID. Returns True on success."""
        try:
            return await self.provider.delete_edge(edge_id)
        except (NotImplementedError, AttributeError):
            logger.warning("Provider does not support edge deletion")
            return False

    # ------------------------------------------------------------------ #
    # Preflight helpers                                                    #
    # ------------------------------------------------------------------ #

    async def get_allowed_children(self, parent_urn: str) -> List[Any]:
        """
        Return all ontology entity types annotated with allowed=True/False
        depending on whether this node's entity type can contain them.
        """
        from backend.app.api.v1.endpoints.graph import AllowedChildOption

        parent_node = await self.provider.get_node(parent_urn)
        resolved = await self._get_resolved_ontology()

        if not parent_node or not resolved:
            return []

        parent_type = str(parent_node.entity_type)
        parent_def = resolved.entity_type_definitions.get(parent_type) if resolved else None
        allowed_children: set = set(parent_def.hierarchy.can_contain) if parent_def else set()

        result = []
        for et_id, et_def in (resolved.entity_type_definitions.items() if resolved else {}.items()):
            allowed = et_id in allowed_children
            result.append(AllowedChildOption(
                entityType=et_id,
                label=et_def.name,
                description=et_def.description,
                allowed=allowed,
                reason=(
                    None if allowed
                    else f"'{parent_type}' cannot contain '{et_id}' per the active ontology"
                ),
            ))
        return sorted(result, key=lambda o: (not o.allowed, o.entity_type))

    async def get_allowed_edges(self, source_urn: str, direction: str = "outgoing") -> List[Any]:
        """
        Return all ontology relationship types annotated with allowed=True/False
        depending on whether this node's entity type can be the source (or target).
        """
        from backend.app.api.v1.endpoints.graph import AllowedEdgeOption

        node = await self.provider.get_node(source_urn)
        resolved = await self._get_resolved_ontology()

        if not node or not resolved:
            return []

        node_type = str(node.entity_type)
        result = []
        for rt_id, rt_def in (resolved.relationship_type_definitions.items() if resolved else {}.items()):
            src_types = rt_def.source_types or []
            tgt_types = rt_def.target_types or []
            if direction in ("outgoing", "both"):
                allowed = (not src_types) or (node_type in src_types)
                reason = (
                    None if allowed
                    else f"'{node_type}' is not a valid source for '{rt_id}'. "
                         f"Allowed: {sorted(src_types)}"
                )
            else:  # incoming
                allowed = (not tgt_types) or (node_type in tgt_types)
                reason = (
                    None if allowed
                    else f"'{node_type}' is not a valid target for '{rt_id}'. "
                         f"Allowed: {sorted(tgt_types)}"
                )
            result.append(AllowedEdgeOption(
                edgeType=rt_id,
                label=rt_def.name,
                description=rt_def.description,
                allowed=allowed,
                reason=reason,
            ))
        return sorted(result, key=lambda o: (not o.allowed, o.edge_type))

