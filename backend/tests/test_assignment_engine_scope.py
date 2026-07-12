"""Assignment compute scope: the compute must cover EXACTLY the entities the
caller renders, read COMPLETELY — never a truncating full-graph scan (a LIMIT
that clips the rendered set silently mis-assigns the clipped entities).

* request.urns present     → reads exactly that set (limit = len(urns)).
* request.urns absent       → scopes to request.assignments keys, read whole.
* neither                   → empty (nothing view-specific to assign); no scan.
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
        return self._edges if getattr(self, "_edges", None) else []


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


def test_scoped_compute_reads_exactly_the_requested_urns_completely():
    """request.urns (the loaded view) is read WHOLE — limit == scope size,
    never a truncating cap that would drop rendered entities."""
    fake = _FakeEngine([_node(f"urn:{i}") for i in range(5)])
    result = _run(AssignmentEngine().compute_assignments(
        _request(urns=["urn:1", "urn:3"]), engine=fake))
    nq = fake.node_queries[0]
    assert sorted(nq.urns) == ["urn:1", "urn:3"]
    assert nq.limit == 2  # exactly the scope — no clipping
    assert nq.include_child_count is False
    eq = fake.edge_queries[0]
    assert sorted(eq.source_urns) == ["urn:1", "urn:3"]
    assert sorted(eq.target_urns) == ["urn:1", "urn:3"]
    assert result.stats.truncated is False
    assert result.stats.total_nodes == 2


def test_never_scans_the_whole_graph_when_unscoped():
    """No urns, no explicit placements → NOTHING is read (no MATCH (n) full
    scan). The previous 50k-LIMIT full scan was slow AND lossy past the cap."""
    from backend.app.models.graph import GraphNode
    fake = _FakeEngine([GraphNode(urn=f"urn:{i}", displayName="x", entityType="table")
                        for i in range(100_000)])
    result = _run(AssignmentEngine().compute_assignments(_request(), engine=fake))
    # A full-graph node scan (urns=None) must never be issued.
    assert all(q.urns for q in fake.node_queries) or fake.node_queries == []
    assert result.stats.total_nodes == 0
    assert result.stats.truncated is False


def test_unscoped_falls_back_to_the_placed_entities_read_whole():
    """Legacy caller with no urns but explicit placements → scope to those
    (read completely), so nothing being placed is ever dropped."""
    from backend.app.models.assignment import EntityAssignmentConfig
    fake = _FakeEngine([_node("urn:a"), _node("urn:b"), _node("urn:c")])
    def _place(urn):
        return EntityAssignmentConfig(
            entityId=urn, layerId="l1", priority=1000,
            assignedBy="user", assignedAt="2026-07-11T00:00:00Z")
    placements = {"urn:a": _place("urn:a"), "urn:c": _place("urn:c")}
    result = _run(AssignmentEngine().compute_assignments(
        _request(assignments=placements), engine=fake))
    nq = fake.node_queries[0]
    assert sorted(nq.urns) == ["urn:a", "urn:c"]
    assert nq.limit == 2  # read whole, no truncation
    assert result.stats.truncated is False
