"""Assignment compute scope (WS1 rider): the engine must never silently
compute layer assignments on the NodeQuery()/EdgeQuery() default LIMIT 100.

* request.urns present  → reads exactly that set (canvas's loaded set).
* request.urns absent   → reads up to ASSIGNMENT_MAX_ELEMENTS and flags
  stats.truncated when the graph exceeds it.
"""
import asyncio

from backend.app.models.assignment import LayerAssignmentRequest, ViewLayerConfig
from backend.app.models.graph import GraphNode
from backend.app.services.assignment_engine import AssignmentEngine
from backend.common.models.graph import OntologyMetadata


def _node(urn):
    return GraphNode(urn=urn, displayName=urn, entityType="table")


class _FakeEngine:
    """Records the queries compute_assignments issues."""

    def __init__(self, nodes):
        self._nodes = nodes
        self.node_queries = []
        self.edge_queries = []

    async def get_ontology_metadata(self):
        return OntologyMetadata(
            containmentEdgeTypes=["HAS"], lineageEdgeTypes=["FLOWS_TO"],
            edgeTypeMetadata={}, entityTypeHierarchy={}, rootEntityTypes=[],
        )

    async def get_nodes_query(self, query):
        self.node_queries.append(query)
        rows = self._nodes
        if query.urns:
            rows = [n for n in rows if n.urn in set(query.urns)]
        return rows[: query.limit] if query.limit else rows

    async def get_edges(self, query):
        self.edge_queries.append(query)
        return []


def _request(**kw):
    return LayerAssignmentRequest(
        layers=[ViewLayerConfig(
            id="l1", name="Layer 1", color="#888888", order=0,
            entityTypes=["table"],
        )],
        **kw,
    )


def _run(coro):
    return asyncio.new_event_loop().run_until_complete(coro)


def test_scoped_compute_reads_exactly_the_requested_urns():
    fake = _FakeEngine([_node(f"urn:{i}") for i in range(5)])
    result = _run(AssignmentEngine().compute_assignments(
        _request(urns=["urn:1", "urn:3"]), engine=fake))
    nq = fake.node_queries[0]
    assert sorted(nq.urns) == ["urn:1", "urn:3"]
    assert nq.include_child_count is False
    eq = fake.edge_queries[0]
    assert sorted(eq.source_urns) == ["urn:1", "urn:3"]
    assert sorted(eq.target_urns) == ["urn:1", "urn:3"]
    assert result.stats.truncated is False
    assert result.stats.total_nodes == 2


def test_unscoped_compute_uses_max_elements_not_100(monkeypatch):
    monkeypatch.setenv("ASSIGNMENT_MAX_ELEMENTS", "1000")
    fake = _FakeEngine([_node(f"urn:{i}") for i in range(10)])
    result = _run(AssignmentEngine().compute_assignments(_request(), engine=fake))
    nq = fake.node_queries[0]
    assert nq.limit == 1001  # cap + 1 (truncation probe), never the default 100
    assert nq.urns is None
    assert result.stats.truncated is False


def test_unscoped_compute_flags_truncation_at_the_cap(monkeypatch):
    monkeypatch.setenv("ASSIGNMENT_MAX_ELEMENTS", "5")
    fake = _FakeEngine([_node(f"urn:{i}") for i in range(10)])
    result = _run(AssignmentEngine().compute_assignments(_request(), engine=fake))
    assert result.stats.truncated is True
    assert result.stats.total_nodes == 5  # bounded subset, explicitly flagged
