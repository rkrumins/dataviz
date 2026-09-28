"""
The real relationships a roll-up stands for (``ContextEngine.get_edges_beneath``): from one entity or
anything it contains, to another or anything it contains — at any depth, roll-ups and self-loops
left out, bounded, and said so when a bound is hit.
"""
import asyncio
from typing import Dict, List

from backend.common.models.graph import EdgeQuery, GraphEdge, GraphNode
from backend.app.services.context_engine import ContextEngine


def _run(coro):
    return asyncio.new_event_loop().run_until_complete(coro)


class _Ontology:
    lineage_edge_types = ["FLOWS_TO", "AGGREGATED"]
    containment_edge_types = ["CONTAINS"]


class _Provider:
    """A containment tree plus an edge list; ``get_edges`` answers like a provider — within the
    lists and the limit, never checking both ends itself."""

    def __init__(self, tree: Dict[str, List[str]], edges: List[tuple]):
        self.tree = tree
        self.edges = [
            GraphEdge(id=f"{s}>{t}:{k}", sourceUrn=s, targetUrn=t, edgeType=k) for s, t, k in edges
        ]
        self.children_calls: List[tuple] = []
        self.edge_queries: List[EdgeQuery] = []

    async def get_children(self, parent_urn, entity_types=None, edge_types=None, limit=100, **kw):
        self.children_calls.append((parent_urn, tuple(edge_types or ())))
        return [GraphNode(urn=u, displayName=u, entityType="x") for u in self.tree.get(parent_urn, [])][:limit]

    async def get_edges(self, query: EdgeQuery):
        self.edge_queries.append(query)
        src = set(query.source_urns or [])
        return [e for e in self.edges if e.source_urn in src][: query.limit]


def _engine(provider) -> ContextEngine:
    eng = object.__new__(ContextEngine)
    eng.provider = provider

    async def _resolve_ontology():
        return _Ontology()

    eng._resolve_ontology = _resolve_ontology
    return eng


TREE = {
    "REPORTING": ["reports"],
    "reports": ["r1", "r2"],
    "DASH": ["tiles"],
    "tiles": ["t1"],
}


def _ids(result):
    return [(e.source_urn, e.target_urn, e.edge_type) for e in result.edges]


def test_finds_relationships_at_any_depth_on_both_sides():
    p = _Provider(TREE, [
        ("r2", "t1", "FLOWS_TO"),
        ("r1", "t1", "FLOWS_TO"),
        ("REPORTING", "DASH", "FLOWS_TO"),
    ])
    res = _run(_engine(p).get_edges_beneath("REPORTING", "DASH"))
    assert _ids(res) == [
        ("REPORTING", "DASH", "FLOWS_TO"),
        ("r1", "t1", "FLOWS_TO"),
        ("r2", "t1", "FLOWS_TO"),
    ]
    assert res.total == 3 and res.truncated is False
    # One edge read, real lineage types only, containment walked by the ontology's types.
    assert len(p.edge_queries) == 1
    assert p.edge_queries[0].edge_types == ["FLOWS_TO"]
    assert set(p.edge_queries[0].target_urns) == {"DASH", "tiles", "t1"}
    assert all(types == ("CONTAINS",) for _, types in p.children_calls)


def test_leaves_out_roll_ups_self_loops_and_edges_that_leave_the_two_sides():
    p = _Provider({**TREE, "reports": ["r1", "r2", "t1"]}, [
        ("r1", "t1", "AGGREGATED"),       # a roll-up, even if the provider returns it
        ("r1", "r1", "FLOWS_TO"),         # a self-loop
        ("r1", "elsewhere", "FLOWS_TO"),  # leaves B's side
        ("r2", "t1", "FLOWS_TO"),
    ])
    res = _run(_engine(p).get_edges_beneath("REPORTING", "DASH"))
    assert _ids(res) == [("r2", "t1", "FLOWS_TO")]


def test_one_entry_per_relationship():
    p = _Provider(TREE, [("r1", "t1", "FLOWS_TO")])
    p.edges = p.edges + p.edges
    res = _run(_engine(p).get_edges_beneath("REPORTING", "DASH"))
    assert res.total == 1


def test_says_truncated_when_a_side_has_too_many_entities():
    eng = _engine(_Provider({"A": [f"a{i}" for i in range(10)], "B": []}, [("a9", "B", "FLOWS_TO")]))
    eng.BENEATH_MAX_NODES = 5
    res = _run(eng.get_edges_beneath("A", "B"))
    assert res.truncated is True
    assert res.edges == []   # a9 was past the bound


def test_says_truncated_when_the_walk_is_too_deep():
    chain = {f"n{i}": [f"n{i + 1}"] for i in range(5)}
    eng = _engine(_Provider(chain, [("n1", "x", "FLOWS_TO")]))
    eng.BENEATH_MAX_DEPTH = 2
    res = _run(eng.get_edges_beneath("n0", "x"))
    assert res.truncated is True
    assert _ids(res) == [("n1", "x", "FLOWS_TO")]


def test_says_truncated_when_the_edge_list_hits_its_cap():
    p = _Provider(TREE, [("r1", "t1", "FLOWS_TO"), ("r2", "t1", "FLOWS_TO")])
    eng = _engine(p)
    eng.BENEATH_MAX_EDGES = 2
    res = _run(eng.get_edges_beneath("REPORTING", "DASH"))
    assert res.total == 2 and res.truncated is True


def test_no_lineage_types_means_nothing_to_list():
    class _NoLineage(_Ontology):
        lineage_edge_types = ["AGGREGATED"]

    p = _Provider(TREE, [("r1", "t1", "FLOWS_TO")])
    eng = _engine(p)

    async def _resolve():
        return _NoLineage()

    eng._resolve_ontology = _resolve
    res = _run(eng.get_edges_beneath("REPORTING", "DASH"))
    assert res.total == 0 and p.edge_queries == []
