"""Contract defaults on GraphDataProvider — pure unit tests, no I/O.

Plan: docs/superpowers/plans/2026-08-30-pr2-provider-catalog-contract.md
§2.1 (error family), §2.2 (ontology injection setters as base members),
§2.3 minus capability_for (ProviderFeature / ProviderCapability.supports),
§2.4 (per-method defaults) and §2.7 (containment_configured).

``_MinimalProvider`` implements ONLY the 25 abstract members — no
``__init__`` (the contract requires none), no overrides of anything under
test. Every assertion below is therefore provably exercising a base-class
default, not an override that happens to agree with it.
"""
from __future__ import annotations

from typing import Any, Dict, List, Optional

import pytest

from backend.common.interfaces.provider import (
    CursorMismatchError,
    GraphDataProvider,
    ProviderFeature,
    ProviderFeatureUnsupportedError,
    call_optional,
)
from backend.common.models.graph import (
    EdgeQuery,
    GraphEdge,
    GraphNode,
    GraphSchemaStats,
    LineageResult,
    NodeQuery,
    OntologyMetadata,
)


class _MinimalProvider(GraphDataProvider):
    """The 25 abstract members and nothing else."""

    @property
    def name(self) -> str:
        return "minimal"

    async def get_node(self, urn: str) -> Optional[GraphNode]:
        return None

    async def get_nodes(self, query: NodeQuery) -> List[GraphNode]:
        self.last_get_nodes_query = query
        return []

    async def search_nodes(self, query: str, limit: int = 10) -> List[GraphNode]:
        return []

    async def get_edges(self, query: EdgeQuery) -> List[GraphEdge]:
        return []

    async def get_children(self, parent_urn: str, **kw: Any) -> List[GraphNode]:
        return []

    async def get_parent(self, child_urn: str) -> Optional[GraphNode]:
        return None

    async def get_upstream(self, urn: str, depth: int, **kw: Any) -> LineageResult:
        return LineageResult(nodes=[], edges=[], totalCount=0, hasMore=False)

    async def get_downstream(self, urn: str, depth: int, **kw: Any) -> LineageResult:
        return LineageResult(nodes=[], edges=[], totalCount=0, hasMore=False)

    async def get_full_lineage(
        self, urn: str, upstream_depth: int, downstream_depth: int, **kw: Any,
    ) -> LineageResult:
        return LineageResult(nodes=[], edges=[], totalCount=0, hasMore=False)

    async def get_aggregated_edges_between(
        self, source_urns, target_urns, granularity, containment_edges, lineage_edges,
    ) -> Any:
        return None

    async def get_trace_lineage(self, urn, direction, depth, containment_edges, lineage_edges) -> LineageResult:
        return LineageResult(nodes=[], edges=[], totalCount=0, hasMore=False)

    async def get_stats(self) -> Dict[str, Any]:
        return {}

    async def get_schema_stats(self) -> GraphSchemaStats:
        return GraphSchemaStats(totalNodes=0, totalEdges=0)

    async def get_ontology_metadata(self) -> OntologyMetadata:
        return OntologyMetadata(
            containmentEdgeTypes=[], lineageEdgeTypes=[], edgeTypeMetadata={},
            entityTypeHierarchy={}, rootEntityTypes=[],
        )

    async def get_distinct_values(self, property_name: str) -> List[Any]:
        return []

    async def get_ancestors(self, urn: str, limit: int = 100, offset: int = 0) -> List[GraphNode]:
        return []

    async def get_descendants(self, urn: str, depth: int = 5, **kw: Any) -> List[GraphNode]:
        return []

    async def get_nodes_by_tag(self, tag: str, limit: int = 100, offset: int = 0) -> List[GraphNode]:
        return []

    async def get_nodes_by_layer(
        self, layer_id: str, limit: int = 100, offset: int = 0, **kw: Any,
    ) -> List[GraphNode]:
        return []

    async def save_custom_graph(self, nodes: List[GraphNode], edges: List[GraphEdge]) -> bool:
        return True

    async def create_node(self, node: GraphNode, containment_edge: Optional[GraphEdge] = None) -> bool:
        return True

    async def create_edge(self, edge: GraphEdge) -> bool:
        return True

    async def update_edge(self, edge_id: str, properties: Dict[str, Any]) -> Optional[GraphEdge]:
        return None

    async def delete_edge(self, edge_id: str) -> bool:
        return True


class _DoubleWithSetter:
    """Not a GraphDataProvider — exposes exactly one settor, for
    call_optional's "True on the double" case."""

    def __init__(self) -> None:
        self.calls: List[Any] = []

    def set_containment_edge_types(self, types, from_ontology=True) -> None:
        self.calls.append((types, from_ontology))


@pytest.fixture
def provider() -> _MinimalProvider:
    return _MinimalProvider()


# ---------------------------------------------------------------------------
# No __init__ — attributes exist only once a setter has run.
# ---------------------------------------------------------------------------

def test_no_init_required(provider):
    assert not hasattr(provider, "_resolved_containment_types_set")
    assert provider.containment_configured is False


# ---------------------------------------------------------------------------
# §2.2 — the ontology injection setters, on FalkorDB's own attribute names.
# ---------------------------------------------------------------------------

def test_set_containment_edge_types_uppercases_and_sets_sentinel(provider):
    provider.set_containment_edge_types(["contains"])
    assert provider._resolved_containment_types == {"CONTAINS"}
    assert provider._resolved_containment_types_set is True
    assert provider.containment_configured is True


def test_set_containment_edge_types_empty_introspection_leaves_sentinel_unset(provider):
    provider.set_containment_edge_types([], from_ontology=False)
    assert not hasattr(provider, "_resolved_containment_types_set")
    assert provider.containment_configured is False


def test_set_containment_edge_types_empty_from_ontology_true_is_a_resolved_state(provider):
    provider.set_containment_edge_types([], from_ontology=True)
    assert provider._resolved_containment_types == set()
    assert provider._resolved_containment_types_set is True
    assert provider.containment_configured is True


def test_set_entity_type_levels(provider):
    provider.set_entity_type_levels({"Table": 2})
    assert provider._entity_type_levels == {"Table": 2}


def test_set_resolved_edge_metadata(provider):
    provider.set_resolved_edge_metadata({"flows_to": {"x": 1}}, ["flows_to"])
    assert provider._resolved_edge_metadata == {"FLOWS_TO": {"x": 1}}
    assert provider._resolved_lineage_types == {"FLOWS_TO"}
    assert provider._resolved_edge_metadata_set is True


def test_set_source_type_aliases(provider):
    provider.set_source_type_aliases({"has": ["HAS", "Has"]}, {"table": ["Table"]})
    assert provider._source_rel_aliases == {"HAS": ["HAS", "Has"]}
    assert provider._source_entity_aliases == {"TABLE": ["Table"]}


def test_set_source_type_aliases_one_arg_call_shape(provider):
    # worker.py:327 calls with a single positional map.
    provider.set_source_type_aliases({"has": ["HAS"]})
    assert provider._source_rel_aliases == {"HAS": ["HAS"]}
    assert provider._source_entity_aliases == {}


def test_set_node_identity_defaults_to_platform_urn_and_name(provider):
    provider.set_node_identity(None, None)
    assert provider._node_identity_property == "urn"
    assert provider._name_property == "name"


def test_set_node_identity_explicit(provider):
    provider.set_node_identity("uuid", "title")
    assert provider._node_identity_property == "uuid"
    assert provider._name_property == "title"


def test_set_admission_controller_is_a_noop(provider):
    provider.set_admission_controller(object())  # must not raise


def test_set_ontology_rules_stores_verbatim(provider):
    rules = {"any": "shape"}
    provider.set_ontology_rules(rules)
    assert provider._ontology_rules is rules


# ---------------------------------------------------------------------------
# §2.4 — concrete defaults matching what call sites already assume on
# absence (previously via hasattr/getattr).
# ---------------------------------------------------------------------------

def test_inflight_ops_defaults_to_zero(provider):
    assert provider.inflight_ops() == 0


async def test_get_counts_fast_defaults_to_none(provider):
    assert await provider.get_counts_fast() is None


async def test_get_node_degrees_defaults_to_empty_dict(provider):
    assert await provider.get_node_degrees(["urn:a"]) == {}
    assert await provider.get_node_degrees(["urn:a"], ["FLOWS_TO"]) == {}


def test_physical_graph_id_defaults_to_none(provider):
    assert provider.physical_graph_id() is None


async def test_clear_content_caches_is_a_noop(provider):
    await provider.clear_content_caches()


async def test_prime_stats_cache_is_a_noop(provider):
    await provider.prime_stats_cache({"nodeCount": 1})


async def test_ensure_indices_is_a_noop_and_accepts_no_args(provider):
    await provider.ensure_indices(["Table"])
    await provider.ensure_indices()


async def test_stamp_identity_urns_defaults_to_zero(provider):
    assert await provider.stamp_identity_urns() == 0


async def test_get_nodes_batch_delegates_to_get_nodes(provider):
    result = await provider.get_nodes_batch(["urn:a", "urn:b"])
    assert result == []
    query = provider.last_get_nodes_query
    assert isinstance(query, NodeQuery)
    assert query.urns == ["urn:a", "urn:b"]


async def test_get_nodes_batch_empty_list_does_not_crash(provider):
    result = await provider.get_nodes_batch([])
    assert result == []
    assert provider.last_get_nodes_query.limit >= 1


async def test_materialize_aggregated_edges_batch_raises_feature_unsupported(provider):
    with pytest.raises(ProviderFeatureUnsupportedError) as excinfo:
        await provider.materialize_aggregated_edges_batch(
            batch_size=10, on_progress=lambda *a: None,  # arbitrary kwargs, real call sites vary
        )
    assert isinstance(excinfo.value, NotImplementedError)
    assert excinfo.value.feature is ProviderFeature.AGGREGATION_MATERIALIZATION
    assert excinfo.value.provider == "_MinimalProvider"


def test_provider_type_defaults_to_none_on_the_abc_and_the_double():
    assert GraphDataProvider.provider_type is None
    assert _MinimalProvider.provider_type is None


# ---------------------------------------------------------------------------
# §2.1 — CursorMismatchError re-exported, not redefined.
# ---------------------------------------------------------------------------

def test_cursor_mismatch_error_is_the_same_object_via_the_interface_and_the_shim():
    from backend.app.providers.falkordb_provider import CursorMismatchError as FromShim
    from backend.app.providers.falkordb import CursorMismatchError as FromPackage

    assert CursorMismatchError is FromShim
    assert CursorMismatchError is FromPackage
    assert issubclass(CursorMismatchError, ValueError)


# ---------------------------------------------------------------------------
# §2.2 — call_optional
# ---------------------------------------------------------------------------

def test_call_optional_false_on_a_bare_object():
    assert call_optional(object(), "set_containment_edge_types", ["X"]) is False


def test_call_optional_true_on_the_double():
    double = _DoubleWithSetter()
    assert call_optional(double, "set_containment_edge_types", ["X"], from_ontology=False) is True
    assert double.calls == [(["X"], False)]


def test_call_optional_true_on_a_real_provider():
    provider = _MinimalProvider()
    assert call_optional(provider, "set_entity_type_levels", {"Table": 1}) is True
    assert provider._entity_type_levels == {"Table": 1}
