"""ContextEngine wiring for per-source vocabulary alignment (Task E).

Verifies the Day-N scenario at the engine seam: a graph whose relationship types are
spelled HAS/TO, read under an ontology that declares has/to, gets an alias map
(declared → observed) injected into the provider and its drift recorded — without a DB
(``_data_source_id`` unset skips persistence, so this is a pure in-memory check).
"""
from __future__ import annotations

import pytest

from backend.common.interfaces.provider import GraphDataProvider
from backend.common.models.graph import (
    AggregatedEdgeResult, EdgeTypeMetadata, GraphSchemaStats, LineageResult,
    OntologyMetadata,
)
from backend.app.ontology.models import (
    EntityTypeDefEntry, RelationshipTypeDefEntry, ResolvedOntology)
from backend.app.services.context_engine import ContextEngine


class _AliasRecordingProvider(GraphDataProvider):
    """Minimal provider that introspects an observed vocabulary and records the alias
    map the engine injects. ``observed_rel`` is what the graph actually spells."""

    def __init__(self, observed_rel):
        self._observed_rel = observed_rel
        self.alias_calls = []
        self.containment_calls = []

    @property
    def name(self): return "alias-recording"

    async def get_node(self, urn): return None
    async def get_nodes(self, query): return []
    async def search_nodes(self, query, limit=10): return []
    async def get_edges(self, query): return []
    async def get_children(self, parent_urn, **kw): return []
    async def get_parent(self, child_urn): return None
    async def get_upstream(self, urn, depth, **kw):
        return LineageResult(nodes=[], edges=[], totalCount=0, hasMore=False)
    async def get_downstream(self, urn, depth, **kw):
        return LineageResult(nodes=[], edges=[], totalCount=0, hasMore=False)
    async def get_full_lineage(self, urn, u, d, **kw):
        return LineageResult(nodes=[], edges=[], totalCount=0, hasMore=False)
    async def get_aggregated_edges_between(self, s, t, g, c, l):
        return AggregatedEdgeResult(aggregatedEdges=[], totalSourceEdges=0)
    async def get_trace_lineage(self, urn, direction, depth, c, l):
        return LineageResult(nodes=[], edges=[], totalCount=0, hasMore=False)
    async def get_stats(self): return {"nodeCount": 0, "edgeCount": 0}
    async def get_schema_stats(self): return GraphSchemaStats(totalNodes=0, totalEdges=0)
    async def get_distinct_values(self, p): return []
    async def get_ancestors(self, urn, limit=100, offset=0): return []
    async def get_descendants(self, urn, depth=5, **kw): return []
    async def get_nodes_by_tag(self, tag, limit=100, offset=0): return []
    async def get_nodes_by_layer(self, layer_id, limit=100, offset=0): return []
    async def save_custom_graph(self, nodes, edges): return True
    async def create_node(self, node, containment_edge=None): return True
    async def create_edge(self, edge): return True
    async def update_edge(self, edge_id, properties): return None
    async def delete_edge(self, edge_id): return True

    async def get_ontology_metadata(self) -> OntologyMetadata:
        return OntologyMetadata(
            containmentEdgeTypes=[], lineageEdgeTypes=[],
            edgeTypeMetadata={t: EdgeTypeMetadata(
                isContainment=(t.lower() == "has"), isLineage=(t.lower() == "to"),
                direction="parent-to-child", category="structural")
                for t in self._observed_rel},
            entityTypeHierarchy={}, rootEntityTypes=[])

    # injection points
    def set_containment_edge_types(self, types, from_ontology=True):
        self.containment_calls.append(list(types))
    def set_resolved_edge_metadata(self, m, l): pass
    def set_entity_type_levels(self, m): pass
    def set_source_type_aliases(self, rel, ent=None):
        self.alias_calls.append({"rel": dict(rel), "ent": dict(ent or {})})


class _DeclaredHasToService:
    """Resolves an ontology that DECLARES has/to (lowercase) regardless of the graph's
    observed spelling — the shared-ontology, differently-cased-graph case."""
    async def resolve(self, **kw):
        return ResolvedOntology(
            entity_type_definitions={"Dataset": EntityTypeDefEntry(name="Dataset")},
            relationship_type_definitions={
                "has": RelationshipTypeDefEntry(name="has", is_containment=True),
                "to": RelationshipTypeDefEntry(name="to", is_lineage=True)},
            containment_edge_types=["has"], lineage_edge_types=["to"],
            resolution_sources={"has": "assigned", "to": "assigned", "Dataset": "assigned"})


@pytest.mark.asyncio
async def test_day_n_upper_graph_gets_alias_map_and_drift():
    provider = _AliasRecordingProvider(observed_rel=["HAS", "TO"])
    engine = ContextEngine(provider=provider, ontology_service=_DeclaredHasToService())
    engine._workspace_id = "ws"

    await engine._resolve_ontology()

    assert provider.alias_calls, "engine must inject source type aliases"
    rel_aliases = provider.alias_calls[-1]["rel"]
    assert rel_aliases == {"HAS": ["HAS"], "TO": ["TO"]}

    alignment = await engine.get_source_alignment()
    assert alignment is not None and alignment.has_drift is True


@pytest.mark.asyncio
async def test_day_0_matching_graph_has_no_drift_but_aliases_for_uppercasing():
    """Day-0: a has/to graph read under a has/to ontology has NO user drift, but the
    provider uppercases its containment set internally, so the observed lowercase spelling
    is still injected (HAS→has) so the case-sensitive query matches."""
    provider = _AliasRecordingProvider(observed_rel=["has", "to"])
    engine = ContextEngine(provider=provider, ontology_service=_DeclaredHasToService())
    engine._workspace_id = "ws"

    await engine._resolve_ontology()

    assert provider.alias_calls[-1]["rel"] == {"HAS": ["has"], "TO": ["to"]}
    alignment = await engine.get_source_alignment()
    assert alignment.has_drift is False
