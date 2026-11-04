"""
Phase 3 — Unit tests for backend.app.services.context_engine.ContextEngine
"""
import time
from typing import Any, Dict, List, Optional

import pytest

from backend.common.interfaces.provider import GraphDataProvider
from backend.common.models.graph import (
    GraphEdge,
    GraphNode,
    GraphSchemaStats,
    LineageResult,
    NodeQuery,
    EdgeQuery,
    OntologyMetadata,
    ChildrenWithEdgesResult,
)
from backend.app.ontology.models import ResolvedOntology
from backend.app.services.context_engine import ContextEngine


# ---------------------------------------------------------------------------
# Stubs
# ---------------------------------------------------------------------------


class _StubProvider(GraphDataProvider):
    """Minimal stub implementing all abstract methods of GraphDataProvider."""

    def __init__(self, nodes=None, edges=None):
        self._nodes = {n.urn: n for n in (nodes or [])}
        self._edges = edges or []

    @property
    def name(self) -> str:
        return "stub"

    async def get_node(self, urn: str) -> Optional[GraphNode]:
        return self._nodes.get(urn)

    async def get_nodes(self, query: NodeQuery) -> List[GraphNode]:
        if query.urns:
            return [self._nodes[u] for u in query.urns if u in self._nodes]
        return list(self._nodes.values())

    async def search_nodes(self, query: str, limit: int = 10, **kw) -> List[GraphNode]:
        return [
            n for n in self._nodes.values()
            if query.lower() in n.display_name.lower()
        ][:limit]

    async def get_edges(self, query: EdgeQuery = None) -> List[GraphEdge]:
        if query and query.any_urns:
            urns = set(query.any_urns)
            return [
                e for e in self._edges
                if e.source_urn in urns or e.target_urn in urns
            ]
        return self._edges

    async def get_children(self, parent_urn, entity_types=None, edge_types=None, **kw) -> List[GraphNode]:
        child_urns = {e.target_urn for e in self._edges if e.source_urn == parent_urn}
        return [self._nodes[u] for u in child_urns if u in self._nodes]

    async def get_parent(self, child_urn: str) -> Optional[GraphNode]:
        for e in self._edges:
            if e.target_urn == child_urn and e.edge_type.upper() == "CONTAINS":
                return self._nodes.get(e.source_urn)
        return None

    async def get_upstream(self, urn, depth, include_column_lineage=False, descendant_types=None) -> LineageResult:
        return LineageResult(
            nodes=list(self._nodes.values()), edges=self._edges,
            totalCount=len(self._nodes), hasMore=False,
        )

    async def get_downstream(self, urn, depth, include_column_lineage=False, descendant_types=None) -> LineageResult:
        return LineageResult(
            nodes=list(self._nodes.values()), edges=self._edges,
            totalCount=len(self._nodes), hasMore=False,
        )

    async def get_full_lineage(self, urn, upstream_depth, downstream_depth, include_column_lineage=False, descendant_types=None) -> LineageResult:
        return LineageResult(
            nodes=list(self._nodes.values()), edges=self._edges,
            totalCount=len(self._nodes), hasMore=False,
        )

    async def get_aggregated_edges_between(self, source_urns, target_urns, granularity, containment_edges, lineage_edges, *, timeout=None) -> Any:
        return []

    async def get_trace_lineage(self, urn, direction, depth, containment_edges, lineage_edges) -> LineageResult:
        return LineageResult(
            nodes=list(self._nodes.values()), edges=self._edges,
            totalCount=len(self._nodes), hasMore=False,
        )

    async def get_stats(self) -> Dict[str, Any]:
        return {"node_count": len(self._nodes), "edge_count": len(self._edges)}

    async def get_schema_stats(self) -> GraphSchemaStats:
        return GraphSchemaStats(totalNodes=len(self._nodes), totalEdges=len(self._edges))

    async def get_ontology_metadata(self) -> OntologyMetadata:
        return OntologyMetadata(
            containmentEdgeTypes=["CONTAINS"],
            lineageEdgeTypes=["TRANSFORMS"],
            edgeTypeMetadata={},
            entityTypeHierarchy={},
            rootEntityTypes=[],
        )

    async def get_distinct_values(self, property_name: str) -> List[Any]:
        return []

    async def get_ancestors(self, urn: str, limit: int = 100, offset: int = 0) -> List[GraphNode]:
        return []

    async def get_descendants(self, urn, depth=5, entity_types=None, limit=100, offset=0) -> List[GraphNode]:
        return []

    async def get_nodes_by_tag(self, tag, limit=100, offset=0) -> List[GraphNode]:
        return []

    async def get_nodes_by_layer(self, layer_id, limit=100, offset=0, **kw) -> List[GraphNode]:
        return []

    async def save_custom_graph(self, nodes, edges) -> bool:
        return True

    async def create_node(self, node, containment_edge=None) -> bool:
        return True

    async def create_edge(self, edge) -> bool:
        return True

    async def update_edge(self, edge_id, properties=None) -> Optional[GraphEdge]:
        return None

    async def delete_edge(self, edge_id) -> bool:
        return True


class _StubOntologyService:
    """Stub OntologyServiceProtocol for unit tests."""

    def __init__(self, resolved=None):
        self._resolved = resolved or ResolvedOntology()
        self.resolve_call_count = 0

    async def resolve(self, **kw) -> ResolvedOntology:
        self.resolve_call_count += 1
        return self._resolved


class _StubRegistry:
    async def get_provider(self, connection_id, session):
        return _StubProvider()


# ---------------------------------------------------------------------------
# Fixtures
# ---------------------------------------------------------------------------

def _node(urn: str, name: str = "", entity_type: str = "dataset") -> GraphNode:
    return GraphNode(urn=urn, displayName=name or urn, entityType=entity_type)


def _edge(src: str, tgt: str, etype: str = "CONTAINS") -> GraphEdge:
    return GraphEdge(id=f"{src}->{tgt}", sourceUrn=src, targetUrn=tgt, edgeType=etype)


# ---------------------------------------------------------------------------
# Tests
# ---------------------------------------------------------------------------


class TestContextEngineInit:
    def test_none_provider_raises(self):
        with pytest.raises(ValueError, match="requires an explicit provider"):
            ContextEngine(provider=None)

    def test_custom_provider_is_used(self):
        stub = _StubProvider()
        engine = ContextEngine(provider=stub)
        assert engine.provider is stub

    async def test_for_connection_requires_connection_id(self):
        with pytest.raises(ValueError, match="connection_id is required"):
            await ContextEngine.for_connection(None, _StubRegistry(), session=object())  # type: ignore[arg-type]


class TestContextEngineNodeOps:
    async def test_get_node_delegates_to_provider(self):
        n = _node("urn:a", "Alpha")
        engine = ContextEngine(provider=_StubProvider(nodes=[n]))
        result = await engine.get_node("urn:a")
        assert result is not None
        assert result.urn == "urn:a"

    async def test_get_node_missing_returns_none(self):
        engine = ContextEngine(provider=_StubProvider())
        result = await engine.get_node("urn:missing")
        assert result is None

    async def test_search_nodes_delegates_to_provider(self):
        nodes = [_node("urn:a", "Alpha"), _node("urn:b", "Beta")]
        engine = ContextEngine(provider=_StubProvider(nodes=nodes))
        results = await engine.search_nodes("alpha")
        assert len(results) == 1
        assert results[0].urn == "urn:a"


class TestContextEngineCreateNode:
    """A created node carries its source's own name and identity properties, bound BEFORE it fans
    out to the provider — a main write-through records and writes that same node."""

    @staticmethod
    def _engine(monkeypatch, identity):
        written = []

        class _Recording(_StubProvider):
            async def create_node(self, node, containment_edge=None) -> bool:
                written.append(node)
                return True

        engine = ContextEngine(provider=_Recording())

        async def _resolved():
            return ResolvedOntology()
        monkeypatch.setattr(engine, "_resolve_ontology", _resolved)
        engine._node_identity = identity
        return engine, written

    async def test_binds_the_name_and_identity_properties(self, monkeypatch):
        from backend.app.services.node_identity import ResolvedNodeIdentity
        from backend.common.models.graph import CreateNodeRequest

        engine, written = self._engine(
            monkeypatch, ResolvedNodeIdentity(identity_property="id", name_property="title"))
        result = await engine.create_node(CreateNodeRequest(
            entityType="dataset", displayName="Orders",
            properties={"id": "copied", "owner": "ana"}))
        [node] = written
        assert result.success and result.node is node
        assert node.properties == {"id": node.urn, "title": "Orders", "owner": "ana"}

    async def test_without_a_mapping_the_node_is_unchanged(self, monkeypatch):
        from backend.common.models.graph import CreateNodeRequest

        engine, written = self._engine(monkeypatch, None)       # no session: none can be read
        await engine.create_node(CreateNodeRequest(
            entityType="dataset", displayName="Orders", properties={"owner": "ana"}))
        assert written[0].properties == {"owner": "ana"}


class TestContextEngineCreatesAreNamedByTheMinter:
    """Every node and edge the engine creates is named ``urn:uuid:`` by the platform's minter. A
    keyed create is idempotent: its id is derived from the key, and sent again it answers with
    what the first one created instead of writing a second."""

    @staticmethod
    def _engine(monkeypatch, nodes=()):
        written = []

        class _Recording(_StubProvider):
            async def create_node(self, node, containment_edge=None) -> bool:
                written.append(node)
                self._nodes[node.urn] = node
                return True

            async def create_edge(self, edge) -> bool:
                written.append(edge)
                self._edges.append(edge)
                return True

        engine = ContextEngine(provider=_Recording(nodes=list(nodes)))

        async def _resolved():
            return ResolvedOntology()
        monkeypatch.setattr(engine, "_resolve_ontology", _resolved)
        engine._node_identity = None
        engine._data_source_id = "ds1"
        return engine, written

    @staticmethod
    def _v(urn):
        import uuid
        from backend.app.services.versioning.ids import uuid_urn
        assert uuid_urn(urn) == urn, urn
        return uuid.UUID(urn[len("urn:uuid:"):]).version

    async def test_a_new_node_and_edge_are_urn_uuid_v7(self, monkeypatch):
        from backend.common.models.graph import CreateEdgeRequest, CreateNodeRequest

        engine, written = self._engine(monkeypatch, [_node("urn:a"), _node("urn:b")])
        made = await engine.create_node(CreateNodeRequest(entityType="dataset", displayName="Orders"))
        assert made.success and self._v(made.node.urn) == 7
        edge = await engine.create_edge(CreateEdgeRequest(
            sourceUrn="urn:a", targetUrn="urn:b", edgeType="FLOWS_TO"))
        assert edge.success and self._v(edge.edge.id) == 7

    async def test_a_keyed_create_sent_again_answers_with_what_it_made(self, monkeypatch):
        from backend.common.models.graph import CreateEdgeRequest, CreateNodeRequest

        engine, written = self._engine(monkeypatch, [_node("urn:a"), _node("urn:b")])
        ask = CreateNodeRequest(entityType="dataset", displayName="Orders", idempotencyKey="k-1")
        first, again = await engine.create_node(ask), await engine.create_node(ask)
        assert self._v(first.node.urn) == 5 and again.node.urn == first.node.urn
        other = await engine.create_node(CreateNodeRequest(
            entityType="dataset", displayName="Orders", idempotencyKey="k-2"))
        assert other.node.urn != first.node.urn
        link = CreateEdgeRequest(sourceUrn="urn:a", targetUrn="urn:b", edgeType="FLOWS_TO",
                                 idempotencyKey="e-1")
        e1, e2 = await engine.create_edge(link), await engine.create_edge(link)
        assert self._v(e1.edge.id) == 5 and e2.edge.id == e1.edge.id
        assert len(written) == 3, written                    # two nodes and one edge, once each

    async def test_a_key_is_one_callers_on_one_branch(self, monkeypatch):
        from backend.common.models.graph import CreateNodeRequest

        ask = CreateNodeRequest(entityType="dataset", displayName="Orders", idempotencyKey="k-1")
        urns = set()
        for branch, actor in (("br_1", "alice"), ("br_1", "bob"), ("br_2", "alice")):
            engine, _written = self._engine(monkeypatch)
            engine._branch_id, engine._actor = branch, actor
            urns.add((await engine.create_node(ask)).node.urn)
        assert len(urns) == 3, urns                          # someone else's, or another draft's


class TestContextEngineChildren:
    async def test_get_children_with_explicit_edge_types(self):
        parent = _node("urn:parent", "Parent")
        child = _node("urn:child", "Child")
        edge = _edge("urn:parent", "urn:child", "CONTAINS")
        engine = ContextEngine(provider=_StubProvider(nodes=[parent, child], edges=[edge]))
        children = await engine.get_children("urn:parent", edge_types=["CONTAINS"])
        assert len(children) == 1
        assert children[0].urn == "urn:child"


class TestContextEngineNeighborhood:
    async def test_get_neighborhood_returns_dict(self):
        n1 = _node("urn:a", "A")
        n2 = _node("urn:b", "B")
        e = _edge("urn:a", "urn:b", "TRANSFORMS")
        engine = ContextEngine(provider=_StubProvider(nodes=[n1, n2], edges=[e]))
        result = await engine.get_neighborhood("urn:a")
        assert result is not None
        assert result["node"].urn == "urn:a"
        assert "edges" in result
        assert "neighbors" in result

    async def test_get_neighborhood_missing_node(self):
        engine = ContextEngine(provider=_StubProvider())
        result = await engine.get_neighborhood("urn:nope")
        assert result is None


class TestContextEngineOntology:
    async def test_get_ontology_metadata_returns_metadata(self):
        resolved = ResolvedOntology(
            containment_edge_types=["CONTAINS"],
            lineage_edge_types=["TRANSFORMS"],
        )
        svc = _StubOntologyService(resolved=resolved)
        engine = ContextEngine(provider=_StubProvider(), ontology_service=svc)
        engine._workspace_id = "ws_test"

        meta = await engine.get_ontology_metadata()
        assert isinstance(meta, OntologyMetadata)
        assert "CONTAINS" in meta.containment_edge_types

    async def test_resolve_ontology_caching(self):
        resolved = ResolvedOntology(containment_edge_types=["CONTAINS"])
        svc = _StubOntologyService(resolved=resolved)
        engine = ContextEngine(provider=_StubProvider(), ontology_service=svc)
        engine._workspace_id = "ws_test"

        await engine._resolve_ontology()
        await engine._resolve_ontology()
        # Second call should use cache, not call resolve again
        assert svc.resolve_call_count == 1

    async def test_invalidate_ontology_cache_forces_re_resolve(self):
        resolved = ResolvedOntology(containment_edge_types=["CONTAINS"])
        svc = _StubOntologyService(resolved=resolved)
        engine = ContextEngine(provider=_StubProvider(), ontology_service=svc)
        engine._workspace_id = "ws_test"

        await engine._resolve_ontology()
        assert svc.resolve_call_count == 1

        engine.invalidate_ontology_cache()
        await engine._resolve_ontology()
        assert svc.resolve_call_count == 2


class TestContextEngineLineage:
    async def test_get_lineage_returns_lineage_result(self):
        n1 = _node("urn:a", "A")
        n2 = _node("urn:b", "B")
        e = _edge("urn:a", "urn:b", "TRANSFORMS")
        resolved = ResolvedOntology(
            containment_edge_types=["CONTAINS"],
            lineage_edge_types=["TRANSFORMS"],
        )
        svc = _StubOntologyService(resolved=resolved)
        engine = ContextEngine(provider=_StubProvider(nodes=[n1, n2], edges=[e]), ontology_service=svc)
        engine._workspace_id = "ws_test"

        result = await engine.get_lineage("urn:a", upstream_depth=1, downstream_depth=1)
        assert isinstance(result, LineageResult)
        assert len(result.nodes) >= 1


class TestContextEngineStaticHelpers:
    def test_normalize_edge_type_lowercase(self):
        assert ContextEngine._normalize_edge_type("flows_to") == "FLOWS_TO"

    def test_normalize_edge_type_mixed_case(self):
        assert ContextEngine._normalize_edge_type("Contains") == "CONTAINS"

    def test_normalize_edge_type_already_upper(self):
        assert ContextEngine._normalize_edge_type("TRANSFORMS") == "TRANSFORMS"

    def test_filter_containment_edges(self):
        n1 = _node("urn:a", "A")
        edges = [
            _edge("urn:a", "urn:b", "CONTAINS"),
            _edge("urn:a", "urn:c", "TRANSFORMS"),
        ]
        result = LineageResult(
            nodes=[n1], edges=edges, totalCount=1, hasMore=False,
        )
        engine = ContextEngine(provider=_StubProvider())
        filtered = engine._filter_containment_edges(result, {"CONTAINS"})
        assert len(filtered.edges) == 1
        assert filtered.edges[0].edge_type == "TRANSFORMS"


class TestContextEngineOrphanEntityTypes:
    """orphan_entity_types: the declared types whose top-level instances are orphans."""

    @staticmethod
    def _engine(monkeypatch, resolved) -> ContextEngine:
        engine = ContextEngine(provider=_StubProvider())

        async def _resolved():
            return resolved
        monkeypatch.setattr(engine, "_resolve_ontology", _resolved)
        return engine

    @staticmethod
    def _ontology(types, roots) -> ResolvedOntology:
        return ResolvedOntology(entity_type_definitions={t: {} for t in types}, root_entity_types=roots)

    async def test_lists_declared_non_root_types(self, monkeypatch):
        engine = self._engine(monkeypatch, self._ontology(
            ["Domain", "Schema", "Table", "Mystery"], ["Domain", "Mystery"]))
        assert await engine.orphan_entity_types() == ["Schema", "Table"]

    async def test_requested_types_narrow_case_insensitively(self, monkeypatch):
        engine = self._engine(monkeypatch, self._ontology(["Domain", "Schema", "Table"], ["domain"]))
        assert await engine.orphan_entity_types(["table", "DOMAIN"]) == ["Table"]

    async def test_no_resolved_ontology_lists_none(self, monkeypatch):
        assert await self._engine(monkeypatch, None).orphan_entity_types() == []

    async def test_every_type_a_root_lists_none(self, monkeypatch):
        engine = self._engine(monkeypatch, self._ontology(["Domain", "Platform"], ["Domain", "Platform"]))
        assert await engine.orphan_entity_types() == []

    async def test_degraded_fallback_lists_none(self):
        """Ontology service down: the fallback carries introspected roots but
        declares no types, so there are no orphans to list."""

        class _IntrospectingProvider(_StubProvider):
            async def get_ontology_metadata(self) -> OntologyMetadata:
                return OntologyMetadata(
                    containmentEdgeTypes=["CONTAINS"], edgeTypeMetadata={},
                    entityTypeHierarchy={"Domain": {}, "Table": {"canBeContainedBy": ["Domain"]}},
                    rootEntityTypes=["Domain"],
                )

        class _FailingOntologyService:
            async def resolve(self, **kw):
                raise RuntimeError("ontology service unavailable")

        engine = ContextEngine(provider=_IntrospectingProvider(), ontology_service=_FailingOntologyService())
        engine._workspace_id = "ws_test"
        resolved = await engine._resolve_ontology()
        assert resolved.root_entity_types == ["Domain"] and not resolved.entity_type_definitions
        assert await engine.orphan_entity_types() == []
