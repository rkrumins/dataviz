"""
Abstract GraphDataProvider interface — shared kernel.
Both the visualization service and graph service import from here.
"""
from abc import ABC, abstractmethod
from dataclasses import dataclass
from enum import Enum
from typing import Awaitable, Callable, ClassVar, Dict, FrozenSet, List, Optional, Set, Any

from ..models.graph import (
    GraphNode, GraphEdge, NodeQuery, EdgeQuery,
    LineageResult, GraphSchemaStats, OntologyMetadata,
    ChildrenWithEdgesResult, TopLevelNodesResult,
    TraceResult, TraceClosureResult,
)
from ..providers.cursors import CursorMismatchError


class ProviderConfigurationError(RuntimeError):
    """Raised when a provider is asked to perform an operation that requires
    ontology-driven configuration (e.g. containment edge types) but no such
    configuration has been injected.

    Producers of this error: provider internals (e.g. FalkorDBProvider) when
    the ContextEngine has not yet called set_containment_edge_types() and no
    explicit env-var override is present.

    Consumers: API endpoints should translate this to HTTP 400 with a clear
    message about ontology configuration — never silently fall back to
    hardcoded defaults.
    """
    pass


class ProviderInputError(ValueError):
    """Raised when a write operation receives input that exceeds a
    provider-side limit before any I/O happens.

    Example: a single GraphNode property bag whose JSON encoding exceeds
    Spanner's 10 MiB cell limit. Without this guard, the offending row
    would fail the entire batched mutation atomically — poisoning every
    adjacent row in the same upsert. Catching at the boundary lets the
    API layer translate to HTTP 400 with a clear "row X is too large"
    message and let the caller retry without that row.

    Consumers: API endpoints should translate to HTTP 400.
    """
    pass


# CursorMismatchError (imported above) is defined in
# backend.common.providers.cursors -- the kernel module that owns the
# keyset-pagination helpers that actually raise it -- and re-exported here
# so the provider *contract* stays one place to reach the whole error
# family. Do not define a second class: PR 1's package guard 6
# (tests/test_falkordb_package_guards.py) asserts every path that
# re-exports it -- backend.app.providers.falkordb, the falkordb_provider
# compatibility shim, and this module -- all resolve to the SAME object.


class ProviderFeatureUnsupportedError(NotImplementedError):
    """The provider exists and is reachable but does not implement an
    OPTIONAL feature -- as opposed to ProviderConfigurationError, which
    means the provider exists but has not been configured yet. A subclass
    of NotImplementedError so every existing ``except NotImplementedError``
    (graph.py's trace/expand/closure endpoints -> 501, the deep-search
    fallback, context_engine's materialization guard) keeps working
    untouched.

    ``feature`` is always a ``ProviderFeature`` member or None -- never a
    message string -- so a handler reading ``exc.feature`` never gets a
    surprise full sentence back. Construct directly with a plain message
    (the handful of pre-existing base-class defaults below, whose exact
    wording predates this error family and must not change, have no
    catalog feature to name); use :meth:`for_feature` for a named,
    catalog-checkable capability, which also builds the message.
    """

    def __init__(
        self, message: str, provider: Optional[str] = None,
        feature: "Optional[ProviderFeature]" = None,
    ) -> None:
        self.provider = provider
        self.feature = feature
        super().__init__(message)

    @classmethod
    def for_feature(cls, feature: "ProviderFeature", provider: str) -> "ProviderFeatureUnsupportedError":
        """The structured case: a named ``ProviderFeature`` the provider
        doesn't support."""
        return cls(f"{provider} does not support the {feature.value!r} feature", provider, feature)


def call_optional(provider: Any, method: str, *args: Any, **kwargs: Any) -> bool:
    """Call ``provider.<method>(...)`` when present; return True if it ran.

    Concrete providers always have the ontology-injection setters (base-
    class members with working defaults -- see ``GraphDataProvider``'s
    Ontology Injection Lifecycle section), but the versioned/draft write
    wrappers are not ``GraphDataProvider`` subclasses and may not forward
    all of them. This collapses the ``hasattr(provider, "set_...") and
    provider.set_...(...)`` pattern used at every injection call site into
    one call.
    """
    fn = getattr(provider, method, None)
    if not callable(fn):
        return False
    fn(*args, **kwargs)
    return True


async def await_optional(provider: Any, method: str, *args: Any, default: Any = None, **kwargs: Any) -> Any:
    """Async counterpart of :func:`call_optional`: awaits
    ``provider.<method>(...)`` when present, returning ``default`` when the
    wrapper in hand does not forward it.
    """
    fn = getattr(provider, method, None)
    if not callable(fn):
        return default
    return await fn(*args, **kwargs)


class ProviderFeature(str, Enum):
    """A named, optional provider capability — checkable up front via
    ``ProviderCapability.supports()`` (a row-level admission gate, before
    any instance exists) rather than only discovered at runtime by calling
    a method and catching ``NotImplementedError`` (still valid for a live,
    possibly-wrapped instance — see ``ProviderFeatureUnsupportedError``).

    The first three mirror ``ProviderCapability``'s pre-existing boolean
    fields (``supports()`` special-cases them so the two can never
    disagree); the rest are new, named after the method or endpoint they
    gate.
    """
    WRITABLE = "writable"
    FULL_CRUD = "full_crud"
    GRAPH_COPY = "graph_copy"
    TRACE_CLOSURE = "trace_closure"                              # trace_closure() -> /trace/closure
    COARSE_TRACE = "coarse_trace"                                 # trace_closure_coarse() rollup lane
    DEEP_SEARCH = "deep_search"                                   # the DeepSearchProvider protocol
    AGGREGATION_MATERIALIZATION = "aggregation_materialization"   # materialize_aggregated_edges_batch()
    BLANK_MODELS = "blank_models"                                 # blank-model versioning gate
    SCHEMA_DISCOVERY = "schema_discovery"                         # discover_schema() is a real implementation
    MULTI_GRAPH = "multi_graph"                                   # list_graphs() enumerates real graphs


@dataclass(frozen=True)
class ProviderCapability:
    """What the system may do with a provider's backing store — the shared, enforced
    capability that drives write routing and the managed-vs-federated source model.

    ``writable``      — writes can be persisted to this store at all.
    ``full_crud``     — supports edge update/delete (not just create).
    ``is_external``   — an externally-owned catalog (federated; we are a view) vs a store
                        we manage end-to-end.
    ``supports_copy`` — a fast server-side graph copy is available (enables per-branch
                        projection by cloning ``main`` + applying the overlay delta).
    ``features``      — optional named capabilities beyond the four above (see
                        ``ProviderFeature``). Defaults to empty so every existing
                        ``ProviderCapability(...)`` construction keeps compiling unchanged.
    """
    writable: bool
    full_crud: bool
    is_external: bool
    supports_copy: bool
    features: FrozenSet[ProviderFeature] = frozenset()

    def supports(self, feature: ProviderFeature) -> bool:
        """Whether this capability includes ``feature``. The three legacy
        booleans are the authoritative answer for their own
        ``ProviderFeature`` members — so a caller migrating a ``.writable``
        / ``.full_crud`` / ``.supports_copy`` check to
        ``.supports(ProviderFeature.X)`` never gets a different answer —
        and every other feature is a plain membership test on ``features``.
        """
        if feature is ProviderFeature.WRITABLE:
            return self.writable
        if feature is ProviderFeature.FULL_CRUD:
            return self.full_crud
        if feature is ProviderFeature.GRAPH_COPY:
            return self.supports_copy
        return feature in self.features


# Keyed by provider_type (authoritative + stable). The enforced kernel form of the static
# ``ProviderCapabilities.supportsWriteBack`` discovery metadata.
PROVIDER_CAPABILITIES: Dict[str, ProviderCapability] = {
    "falkordb": ProviderCapability(writable=True,  full_crud=True,  is_external=False, supports_copy=True),
    "spanner":  ProviderCapability(writable=True,  full_crud=True,  is_external=False, supports_copy=False),
    "neo4j":    ProviderCapability(writable=True,  full_crud=False, is_external=False, supports_copy=False),
    "datahub":  ProviderCapability(writable=False, full_crud=False, is_external=True,  supports_copy=False),
    "mock":     ProviderCapability(writable=True,  full_crud=True,  is_external=False, supports_copy=False),
}

# Unknown providers default to read-only/external (safe: never write to a store we don't
# understand; treat it as a federated view).
_DEFAULT_CAPABILITY = ProviderCapability(writable=False, full_crud=False, is_external=True, supports_copy=False)


def capability_for(provider_type: Optional[str]) -> ProviderCapability:
    """Capability for a ``provider_type`` (e.g. the data source's). Unknown → read-only/external."""
    return PROVIDER_CAPABILITIES.get((provider_type or "").lower(), _DEFAULT_CAPABILITY)


def unwrap_provider(p: Any, max_depth: int = 5) -> Any:
    """Peel provider wrapper layers to reach the concrete adapter instance.

    Mirrors the ad hoc unwrap in ``graph.py``'s ``_resolve_physical_graph_id``:
    ``CircuitBreakerProxy`` exposes its wrapped instance via the ``.target``
    property, ``VersionedWriteProvider`` via ``._inner``, and
    ``DraftOverlayProvider`` via ``._base`` (the one of the three that does
    NOT also implement ``__getattr__`` forwarding, so plain attribute access
    alone would not reach through it). Layers can nest, so this loops rather
    than checking once; it stops at ``max_depth`` or as soon as none of the
    three attributes is found.
    """
    current = p
    for _ in range(max_depth):
        nxt = getattr(current, "target", None)
        if nxt is None:
            nxt = getattr(current, "_inner", None)
        if nxt is None:
            nxt = getattr(current, "_base", None)
        if nxt is None or nxt is current:
            break
        current = nxt
    return current


def provider_type_of(p: Any) -> Optional[str]:
    """The catalog ``provider_type`` of a possibly-wrapped provider, or None
    when unresolvable (e.g. a ``VersionedBranchProvider``, which wraps a
    ``GraphVersioningService`` rather than a live graph adapter — there is
    no physical provider to identify)."""
    return getattr(type(unwrap_provider(p)), "provider_type", None)


def supports_feature(p: Any, feature: ProviderFeature) -> bool:
    """Instance-level feature check for the few call sites with no provider
    ROW in hand. Prefer ``capability_for(row.provider_type).supports(...)``
    when a row is available — the honest check for a wrapper like
    ``DraftOverlayProvider`` that implements a feature by delegation rather
    than by its own class.
    """
    return capability_for(provider_type_of(p)).supports(feature)


class GraphDataProvider(ABC):
    """
    Abstract interface for graph data providers.
    Enables swapping between Mock, FalkorDB, Neo4j, DataHub, etc.
    All methods must be async to prevent blocking the event loop.

    Implementations MUST bound every async I/O call with a per-operation
    deadline (e.g. via ``asyncio.wait_for``). The :class:`CircuitBreakerProxy`
    does not enforce deadlines on provider calls; deadlines are the
    provider's responsibility because only the provider knows the right
    granularity (a single query vs. a batched orchestration). Failure to
    comply will manifest as hung worker tasks during downstream incidents.

    Two conventions this ABC deliberately does NOT enforce via
    ``@abstractmethod`` (every test double that subclasses this ABC
    directly would become uninstantiable):

    * **Ontology injection is a declared obligation, not an optional
      extra.** ``set_containment_edge_types``, ``set_entity_type_levels``,
      ``set_resolved_edge_metadata``, ``set_source_type_aliases``,
      ``set_node_identity``, ``set_admission_controller`` and
      ``set_ontology_rules`` (the "Ontology Injection Lifecycle" section
      below) are base-class members with working defaults rather than
      duck-typed extras a caller must ``hasattr()`` before calling. Every
      registered adapter therefore participates by construction — it
      either inherits the plain-assignment default or overrides it — so a
      provider that simply lacks one of these can no longer fail open the
      way ``ContextEngine`` skipping a missing ``hasattr`` used to: a flat
      graph and no error. See ``containment_configured`` for how a
      provider answers "has an ontology actually been injected into me?" —
      the question anything deriving a *cacheable* answer from injected
      state (e.g. ``get_ontology_metadata``'s shared-cache write) must
      consult before trusting its own classification.
    * **``async def preflight(self, *, deadline_s: float) -> PreflightResult``
      is required by convention, not by this ABC.** A default that
      returned success would lie about reachability; one that returned
      failure would make ``ProviderManager`` gate every such provider as
      permanently down (``manager.py``: "providers without a preflight()
      are never gated"). Every concrete adapter must define its own,
      meeting the contract in ``backend/common/interfaces/preflight.py``:
      wall-clock bounded by ``deadline_s`` (plus scheduling slack),
      returning a ``PreflightResult`` for connectivity outcomes rather than
      raising, cancellation-clean, and never touching the production
      driver pool or running schema work. The provider catalog's
      registration test enforces this by inspecting each registered class
      directly, since the ABC itself cannot.
    """

    # Catalog id ("falkordb", "neo4j", "spanner", ...) set by every
    # registered concrete adapter class; None on the ABC itself and on
    # adapters not yet in the catalog (DataHub). Read by
    # ``provider_type_of`` / ``supports_feature`` above to resolve a live
    # instance's capability via ``type(instance).provider_type`` without a
    # provider ROW in hand.
    provider_type: ClassVar[Optional[str]] = None

    @property
    @abstractmethod
    def name(self) -> str:
        """Provider name for debugging"""
        pass

    # ==========================================
    # Node Operations
    # ==========================================

    @abstractmethod
    async def get_node(self, urn: str) -> Optional[GraphNode]:
        pass

    @abstractmethod
    async def get_nodes(self, query: NodeQuery) -> List[GraphNode]:
        pass

    @abstractmethod
    async def search_nodes(self, query: str, limit: int = 10) -> List[GraphNode]:
        pass

    # ==========================================
    # Edge Operations
    # ==========================================

    @abstractmethod
    async def get_edges(self, query: EdgeQuery) -> List[GraphEdge]:
        pass

    # ==========================================
    # Containment Hierarchy
    # ==========================================

    @abstractmethod
    async def get_children(
        self,
        parent_urn: str,
        entity_types: Optional[List[str]] = None,
        edge_types: Optional[List[str]] = None,
        search_query: Optional[str] = None,
        offset: int = 0,
        limit: int = 100,
        sort_property: Optional[str] = "displayName",
        cursor: Optional[str] = None,
        sort_direction: str = "asc",
    ) -> List[GraphNode]:
        """`sort_direction` ('asc' | 'desc') orders on `sort_property` server-side.
        A cursor is direction-bound: providers reject a cursor minted under the
        other direction (ValueError → 400 at the endpoint)."""
        pass

    async def get_children_with_edges(
        self,
        parent_urn: str,
        edge_types: Optional[List[str]] = None,
        lineage_edge_types: Optional[List[str]] = None,
        search_query: Optional[str] = None,
        offset: int = 0,
        limit: int = 100,
        include_lineage_edges: bool = True,
        sort_property: Optional[str] = "displayName",
        cursor: Optional[str] = None,
        sort_direction: str = "asc",
    ) -> ChildrenWithEdgesResult:
        """Get children with containment and optionally lineage edges in one round-trip.

        Default implementation delegates to get_children + get_edges.
        Providers may override with an optimized single-query implementation.
        """
        from ..models.graph import EdgeQuery
        children = await self.get_children(
            parent_urn, edge_types=edge_types,
            search_query=search_query, offset=offset, limit=limit,
            sort_property=sort_property, cursor=cursor,
            sort_direction=sort_direction,
        )
        child_urns = [c.urn for c in children]
        all_urns = [parent_urn] + child_urns

        # Fetch containment edges between parent and children
        containment_edges: List[GraphEdge] = []
        lineage_edges: List[GraphEdge] = []
        if child_urns:
            edges = await self.get_edges(EdgeQuery(
                source_urns=all_urns, target_urns=all_urns, limit=len(all_urns) * 10,
            ))
            containment_types = set(t.upper() for t in (edge_types or []))
            lineage_filter = set(t.upper() for t in lineage_edge_types) if lineage_edge_types else None
            for e in edges:
                if e.edge_type.upper() in containment_types:
                    containment_edges.append(e)
                elif include_lineage_edges:
                    if lineage_filter is None or e.edge_type.upper() in lineage_filter:
                        lineage_edges.append(e)

        # We don't know total_children without a count query; approximate
        has_more = len(children) >= limit
        total = offset + len(children) + (1 if has_more else 0)

        next_cursor = children[-1].display_name if children and has_more else None
        return ChildrenWithEdgesResult(
            children=children,
            containmentEdges=containment_edges,
            lineageEdges=lineage_edges,
            totalChildren=total,
            hasMore=has_more,
            nextCursor=next_cursor,
        )

    @abstractmethod
    async def get_parent(self, child_urn: str) -> Optional[GraphNode]:
        pass

    async def get_top_level_or_orphan_nodes(
        self,
        *,
        root_entity_types: Optional[List[str]] = None,
        entity_types: Optional[List[str]] = None,
        search_query: Optional[str] = None,
        limit: int = 100,
        cursor: Optional[str] = None,
        include_child_count: bool = True,
        sort_direction: str = "asc",
    ) -> TopLevelNodesResult:
        """Return instances that have no incoming containment edge.

        Definition: a node n is "top-level or orphan" iff there is no edge
        (n' -[:CONTAINMENT_TYPE]-> n) for any configured containment type.
        This is a purely structural predicate — it does NOT depend on the
        node's entity type. The result therefore mixes:
          - Instances of ontology root types (Domain, Platform, …)
          - Orphan instances of non-root types (a Table with no Schema parent,
            e.g. from a broken import)

        The UI distinguishes them via the root_type_count / orphan_count
        fields on TopLevelNodesResult.

        Pagination: cursor-based on display_name for stability under writes.
        Callers pass cursor=None for the first page and cursor=result.next_cursor
        for subsequent pages.

        Containment edge types are resolved from the ontology injected into
        the provider by ContextEngine. Providers MUST raise
        ProviderConfigurationError when no containment edge types are
        resolvable — do NOT silently default to hardcoded type names, as this
        breaks enterprise ontologies that use custom edge naming.
        """
        raise ProviderFeatureUnsupportedError(
            f"{type(self).__name__} does not implement get_top_level_or_orphan_nodes. "
            "Override this method to support the /nodes/top-level endpoint.",
            type(self).__name__,
        )

    # ==========================================
    # Lineage Traversal
    # ==========================================

    @abstractmethod
    async def get_upstream(
        self,
        urn: str,
        depth: int,
        include_column_lineage: bool = False,
        descendant_types: Optional[List[str]] = None,
    ) -> LineageResult:
        pass

    @abstractmethod
    async def get_downstream(
        self,
        urn: str,
        depth: int,
        include_column_lineage: bool = False,
        descendant_types: Optional[List[str]] = None,
    ) -> LineageResult:
        pass

    @abstractmethod
    async def get_full_lineage(
        self,
        urn: str,
        upstream_depth: int,
        downstream_depth: int,
        include_column_lineage: bool = False,
        descendant_types: Optional[List[str]] = None,
    ) -> LineageResult:
        pass

    @abstractmethod
    async def get_aggregated_edges_between(
        self,
        source_urns: List[str],
        target_urns: Optional[List[str]],
        granularity: Any,
        containment_edges: List[str],
        lineage_edges: List[str],
    ) -> Any:
        pass

    @abstractmethod
    async def get_trace_lineage(
        self,
        urn: str,
        direction: str,
        depth: int,
        containment_edges: List[str],
        lineage_edges: List[str],
    ) -> LineageResult:
        pass

    # ------------------------------------------------------------------ #
    # Trace v2 — Cypher-native, ontology-aware                           #
    # ------------------------------------------------------------------ #

    async def trace_at_level(
        self,
        urn: str,
        level: int,
        upstream_depth: int,
        downstream_depth: int,
        lineage_edge_types: List[str],
        containment_edge_types: List[str],
        max_nodes: int,
        timeout_ms: int,
        include_containment_edges: bool = False,
        include_inherited_lineage: bool = True,
    ) -> TraceResult:
        """Trace at a specific hierarchy level using AGGREGATED edges.

        Per-hop set-based BFS (orchestrated in Python, executed in Cypher).
        Returns nodes already at ``level`` plus AGGREGATED edges between
        them, scoped to ``upstream_depth`` / ``downstream_depth`` hops.

        Inherited lineage: if ``include_inherited_lineage=True`` and the
        focus has no AGGREGATED edges at the requested level, the trace
        anchors at the nearest containment ancestor that does, with
        ``isInherited=True`` in the result.

        Default implementation raises NotImplementedError — override in
        concrete providers (Neo4j, FalkorDB).
        """
        raise ProviderFeatureUnsupportedError(
            f"{type(self).__name__} does not implement trace_at_level. "
            "Required for the /trace/v2 endpoint.",
            type(self).__name__,
        )

    async def expand_aggregated(
        self,
        source_urn: str,
        target_urn: str,
        next_level: Optional[int],
        lineage_edge_types: List[str],
        containment_edge_types: List[str],
        max_nodes: int,
        timeout_ms: int,
        use_raw_edges: bool = False,
        include_containment_edges: bool = False,
        drill_anchor: Optional[str] = None,
    ) -> TraceResult:
        """Drill into an AGGREGATED edge: return finer-level nodes + edges
        within (source_subtree × target_subtree) at ``next_level``.

        Set-based, no Cartesian: collect descendants at the target level
        for each anchor, then match edges between the two URN sets.

        When ``use_raw_edges=True`` (typically for the finest level where
        AGGREGATED == raw lineage), the implementation skips AGGREGATED
        and reads raw lineage edges directly.

        ``drill_anchor`` names the anchor being OPENED. Only that side
        descends; the partner contributes itself and its whole subtree,
        so anchors many containment levels apart can still meet. Omit it
        for the historical symmetric behaviour, which is correct only
        when the pair is already at comparable depth.

        ``next_level`` may be ``None`` — a caller whose ontology repeats
        an entity type at two containment depths has no single honest
        level to send, and providers should drill structurally instead.
        """
        raise ProviderFeatureUnsupportedError(
            f"{type(self).__name__} does not implement expand_aggregated. "
            "Required for the /trace/expand endpoint.",
            type(self).__name__,
        )

    async def trace_closure(
        self,
        urn: str,
        upstream_depth: int,
        downstream_depth: int,
        lineage_edge_types: List[str],
        containment_edge_types: List[str],
        max_nodes: int,
        timeout_ms: int,
        seed_urns: Optional[List[str]] = None,
        exclude_urns: Optional[List[str]] = None,
        after_cursor: Optional[str] = None,
    ) -> TraceClosureResult:
        """Focus-scoped, regime-independent lineage closure — ONE step of a walk.

        Walks raw lineage edges outward from ``urn`` (upstream + downstream),
        correct at the finest grain regardless of aggregation regime.
        Containment is hydrated only to nest results, never used as a
        lineage hop.

        ``seed_urns`` continues a walk from known lineage participants
        instead of reseeding from the focus. ``exclude_urns`` are nodes the
        client already holds — never re-shipped in ``nodes``, but a seam
        edge into one still is. ``after_cursor`` pages one node's adjacency
        in one direction instead of walking further.

        Default implementation raises NotImplementedError — override in
        concrete providers (Neo4j, FalkorDB).
        """
        raise ProviderFeatureUnsupportedError(
            f"{type(self).__name__} does not implement trace_closure. "
            "Required for the /trace/closure endpoint.",
            type(self).__name__,
        )

    # ==========================================
    # Metadata Operations
    # ==========================================

    @abstractmethod
    async def get_stats(self) -> Dict[str, Any]:
        pass

    @abstractmethod
    async def get_schema_stats(self) -> GraphSchemaStats:
        pass

    @abstractmethod
    async def get_ontology_metadata(self) -> OntologyMetadata:
        pass

    @abstractmethod
    async def get_distinct_values(self, property_name: str) -> List[Any]:
        pass

    # ==========================================
    # Traversal & Filtering Extensions
    # ==========================================

    @abstractmethod
    async def get_ancestors(self, urn: str, limit: int = 100, offset: int = 0) -> List[GraphNode]:
        pass

    @abstractmethod
    async def get_descendants(
        self,
        urn: str,
        depth: int = 5,
        entity_types: Optional[List[str]] = None,
        limit: int = 100,
        offset: int = 0,
    ) -> List[GraphNode]:
        pass

    @abstractmethod
    async def get_nodes_by_tag(self, tag: str, limit: int = 100, offset: int = 0) -> List[GraphNode]:
        pass

    @abstractmethod
    async def get_nodes_by_layer(
        self,
        layer_id: str,
        limit: int = 100,
        offset: int = 0,
        sort_direction: str = "asc",
        cursor: Optional[str] = None,
    ) -> List[GraphNode]:
        """Nodes whose `layerAssignment` equals `layer_id`, ordered by
        (displayName, urn) in `sort_direction`. `cursor` (keyset, optional)
        takes precedence over `offset` when supported by the provider."""
        pass

    # ==========================================
    # Write Operations
    # ==========================================

    @abstractmethod
    async def save_custom_graph(self, nodes: List[GraphNode], edges: List[GraphEdge]) -> bool:
        pass

    @abstractmethod
    async def create_node(self, node: GraphNode, containment_edge: Optional[GraphEdge] = None) -> bool:
        pass

    @abstractmethod
    async def create_edge(self, edge: GraphEdge) -> bool:
        """Persist a new edge. Returns True on success."""
        pass

    @abstractmethod
    async def update_edge(self, edge_id: str, properties: Dict[str, Any]) -> Optional[GraphEdge]:
        """Update mutable properties of an edge. Returns updated edge or None if not found."""
        pass

    @abstractmethod
    async def delete_edge(self, edge_id: str) -> bool:
        """Delete an edge by its ID. Returns True on success, False if not found."""
        pass

    # ==========================================
    # Ontology Injection Lifecycle
    # (base-class members with working defaults — see the class docstring's
    #  "ontology injection is a declared obligation" note. FalkorDB, Neo4j
    #  and Spanner override some of these with provider-specific behaviour;
    #  the defaults below are what a provider gets for free otherwise.)
    # ==========================================

    def set_containment_edge_types(self, types: List[str], from_ontology: bool = True) -> None:
        """Inject the authoritative containment edge types resolved by
        ``ContextEngine`` / the aggregation worker.

        ``types`` empty with ``from_ontology=True`` means the ontology
        explicitly defines no containment (a flat graph) — a valid resolved
        state, distinct from "never configured". ``from_ontology=False``
        with an empty list is an introspection-only probe that found
        nothing; it must NOT be taken as "resolved to empty", so the
        configured-sentinel is left unset (see ``containment_configured``).
        """
        if from_ontology or types:
            self._resolved_containment_types: Set[str] = {t.upper() for t in (types or [])}
            self._resolved_containment_types_set = True

    @property
    def containment_configured(self) -> bool:
        """Has ``set_containment_edge_types`` actually injected an ontology
        into this instance? False on a freshly-constructed provider.

        Anything deriving a *cacheable* classification from injected state
        must consult this first — an uninjected instance's answer ("no
        containment configured") is correct for IT but is not a fact about
        the graph, and must never poison a shared key that a later,
        correctly-injected caller will read. This is the exact invariant a
        prior fix enforces by hand in FalkorDB's ``get_ontology_metadata``
        (gating its shared-cache write on this same sentinel); this
        accessor is what stops the next provider from reinventing that bug.
        """
        return getattr(self, "_resolved_containment_types_set", False)

    def set_entity_type_levels(self, mapping: Dict[str, int]) -> None:
        """Inject the entity-type → hierarchy.level mapping resolved by
        ``ContextEngine`` / the aggregation worker. Used both at write time
        (populates a level index) and at read time (resolves levels without
        requiring every existing node to be backfilled first).
        """
        self._entity_type_levels: Dict[str, int] = dict(mapping or {})

    def set_resolved_edge_metadata(
        self, edge_type_metadata: Dict[str, Any], lineage_edge_types: List[str],
    ) -> None:
        """Inject the authoritative edge classification resolved by
        ``ContextEngine``. When set, ``get_ontology_metadata`` should use
        this instead of re-deriving classification from env vars or
        hardcoded type names.
        """
        self._resolved_edge_metadata = {k.upper(): v for k, v in (edge_type_metadata or {}).items()}
        self._resolved_lineage_types: Set[str] = {t.upper() for t in (lineage_edge_types or [])}
        self._resolved_edge_metadata_set = True

    def set_source_type_aliases(
        self,
        relationship_aliases: Dict[str, List[str]],
        entity_aliases: Optional[Dict[str, List[str]]] = None,
    ) -> None:
        """Per-source vocabulary alignment: ``UPPER(declared) -> [observed
        spelling(s)]`` for types a graph spells differently than the
        ontology declares. Always called on resolution — even with empty
        maps — so a stale alias set from a prior ontology can't leak into
        the next query on a cached, shared provider instance.
        """
        self._source_rel_aliases: Dict[str, List[str]] = {
            str(k).upper(): [str(s) for s in v] for k, v in (relationship_aliases or {}).items()
        }
        self._source_entity_aliases: Dict[str, List[str]] = {
            str(k).upper(): [str(s) for s in v] for k, v in (entity_aliases or {}).items()
        }

    def set_node_identity(
        self, identity_property: Optional[str] = None, name_property: Optional[str] = None,
    ) -> None:
        """Inject the per-source node-identity mapping: which physical
        property plays the role of ``urn``, and which holds the human name.
        Passing ``None`` restores the platform defaults — a meaningful
        instruction, since provider instances are cached/shared and
        omitting the call would otherwise leak the previous source's
        mapping forward.
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

    def set_admission_controller(self, controller: Optional[Any]) -> None:
        """Inject the distributed write-admission controller for
        aggregation writes. Only meaningful to a provider that materializes
        AGGREGATED edges itself (FalkorDB overrides this to store it);
        others have no use for it, so the default is a no-op rather than an
        error.
        """
        pass

    def set_ontology_rules(self, rules: Any) -> None:
        """Inject the assigned ontology's rich rule set (endpoint-type and
        containment-integrity rules); the versioned-write path enforces
        these in ``apply_ops``. ``None`` clears a previously-injected set.

        No concrete adapter currently derives read behaviour from this —
        the default just stores it — but it must exist on every adapter so
        ``ContextEngine``'s push-down never silently skips a provider that
        hasn't opted in.
        """
        self._ontology_rules = rules

    async def ensure_indices(self, entity_type_ids: Optional[List[str]] = None) -> None:
        """Create/ensure indices for the given entity types (idempotent).
        Called after ``set_entity_type_levels`` so a freshly-onboarded
        source's types get their indices before the first write or trace.
        No-op by default; FalkorDB, Neo4j and Spanner override with a real
        index-creation routine.
        """
        pass

    async def stamp_identity_urns(self) -> int:
        """Backfill ``urn`` from the injected identity property on nodes
        that don't already carry one (onboarded third-party graphs whose
        native key isn't called ``urn``). Returns the number of nodes
        stamped; 0 by default (nothing to stamp, or the provider doesn't
        support onboarding graphs with a foreign identity property).
        """
        return 0

    # ==========================================
    # Capability-Gated Optional Behavior
    # (base defaults = the behaviour call sites already assume when a
    #  provider doesn't have the method at all; see ProviderFeature for the
    #  row-level admission gate built on the same set of capabilities.)
    # ==========================================

    def inflight_ops(self) -> int:
        """Number of guarded operations currently executing on this
        instance. ``ProviderManager`` uses this to avoid closing a provider
        mid-job during recovery eviction; 0 (idle) by default for providers
        that don't track in-flight work.
        """
        return 0

    async def get_counts_fast(self) -> Optional[Dict[str, Any]]:
        """A cheap, approximate node/edge count read (e.g. from a
        maintained counter rather than a full scan). None means "counters
        cannot describe this graph" — callers fall back to a slower exact
        count.
        """
        return None

    async def prime_stats_cache(self, stats: Dict[str, Any]) -> None:
        """Warm this provider's own stats cache with an externally-computed
        result (e.g. after a slow exact count, so the next fast-path read
        doesn't immediately re-trigger it). No-op by default.
        """
        pass

    async def get_node_degrees(
        self, urns: List[str], edge_types: Optional[List[str]] = None,
    ) -> Dict[str, Any]:
        """TOTAL lineage degree per URN over the full graph. Absent means
        unknown — {} by default, which callers treat the same as "no
        entries" rather than as an error.
        """
        return {}

    def physical_graph_id(self) -> Optional[str]:
        """A stable identity for the live (host, port, graph/database) this
        instance is actually connected to — used to scope caches that must
        not be shared across two data sources that happen to point at the
        same physical graph, or split when they don't. None means "no
        physical identity available" (e.g. a managed store with no separate
        physical handle), which callers treat as today's ds-only cache
        scoping.
        """
        return None

    async def clear_content_caches(self) -> None:
        """Invalidate this provider's own content caches (e.g. after a bulk
        rewrite). No-op by default for providers that don't maintain one.
        """
        pass

    async def get_nodes_batch(self, urns: List[str]) -> List[GraphNode]:
        """Batch node fetch. Default delegates to ``get_nodes`` with a
        ``NodeQuery`` scoped to ``urns`` and a limit that fits the whole
        batch; providers with a faster batched primitive override this.
        """
        return await self.get_nodes(NodeQuery(urns=urns, limit=max(1, len(urns))))

    async def materialize_aggregated_edges_batch(self, **kwargs: Any) -> Dict[str, Any]:
        """Batch-materialize :AGGREGATED rollup edges. Optional — gated by
        ``ProviderFeature.AGGREGATION_MATERIALIZATION`` — because it is a
        FalkorDB-specific optimization with no equivalent on a provider
        that doesn't maintain its own rollup edges. ``**kwargs`` because
        callers pass a large, evolving set of tuning/resume parameters a
        provider without this feature has no use for.
        """
        raise ProviderFeatureUnsupportedError.for_feature(ProviderFeature.AGGREGATION_MATERIALIZATION, type(self).__name__)

    # ==========================================
    # Optional Extension Methods
    # (concrete implementations are optional — default no-ops)
    # ==========================================

    # ==========================================
    # Projection / Materialization Lifecycle Hooks
    # (no-ops by default — providers override as needed)
    # ==========================================

    async def set_projection_mode(self, mode: str) -> None:
        """Switch the projection target for aggregation operations.

        ``mode`` is ``"in_source"`` (write aggregated edges to the source
        graph) or ``"dedicated"`` (write to a separate projection graph).
        Called by the aggregation worker per-job before materialization.
        """
        pass

    async def ensure_projections(self) -> None:
        """Set up projection infrastructure (indices, projection graphs, etc.)."""
        pass

    async def on_lineage_edge_written(
        self,
        source_urn: str,
        target_urn: str,
        edge_id: str,
        edge_type: str,
    ) -> None:
        """Called after a lineage edge is created/updated. Materializes AGGREGATED edges."""
        pass

    async def on_lineage_edge_deleted(
        self,
        source_urn: str,
        target_urn: str,
        edge_id: str,
    ) -> None:
        """Called after a lineage edge is removed. Decrements AGGREGATED edge weights."""
        pass

    async def on_containment_changed(self, urn: str) -> None:
        """Called when a node's containment (parent) changes. Rebuilds ancestor chains."""
        pass

    async def count_aggregated_edges(self) -> int:
        """Return the current count of materialized AGGREGATED edges.

        Used as the denominator for purge progress reporting — the
        purge handler reads this once before deletion starts so the UI
        can render a meaningful "X / total" indicator instead of "0 / 0"
        until the very last batch lands. Returns 0 for providers that
        don't materialise aggregated edges.
        """
        return 0

    async def purge_aggregated_edges(
        self,
        *,
        batch_size: int = 10_000,
        progress_callback: Optional[Callable[[int], Awaitable[None]]] = None,
    ) -> int:
        """Remove ALL materialized AGGREGATED edges from the graph.

        Implementations should iterate the deletion in chunks of at most
        ``batch_size`` so a multi-million-edge purge produces visible
        progress (and so the operation cannot silently truncate at a
        single hard-coded LIMIT). After every batch, ``progress_callback``
        — when provided — is awaited with the running total of edges
        deleted so far. Returns the total deleted across all batches.
        """
        return 0

    async def discover_schema(self) -> Dict[str, Any]:
        """Introspect the database and return available labels, relationship
        types, property keys, and sample data.

        Used for schema mapping configuration when connecting to an external
        graph database with an unknown property schema.

        Returns
        -------
        dict
            Keys may include ``labels``, ``relationshipTypes``,
            ``labelDetails`` (per-label counts, property keys, samples),
            and ``suggestedMapping`` (a best-guess SchemaMapping dict).
            Returns empty dict by default.
        """
        return {}

    async def list_graphs(self) -> List[str]:
        """
        List named graph keys / databases available on this provider instance.
        FalkorDB: GRAPH.LIST  |  Neo4j: SHOW DATABASES
        Returns empty list by default.
        """
        return []

    async def close(self) -> None:
        """
        Release connection pool resources.
        Called by ProviderRegistry.evict() before removing a provider from cache.
        """
        pass
