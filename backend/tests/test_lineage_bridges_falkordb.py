"""FalkorDB's answers to the lineage-bridges walker (``falkordb_bridges.py``).

The new Cypher here is the region enumeration — ``(root, descendant, label)``
rows, label-qualified, keyset-paged and trimmed back to whole descendants — so
the fake answers exactly that shape and asserts it. The reads the adapter
composes (``_lineage_degrees``, ``_expand_raw_lineage_set``, the chain cache,
the node batch) have their own tests; here they are stubbed over the same
in-memory graph, and the whole walker is then run through the adapter.
"""
from __future__ import annotations

import asyncio
from typing import Dict, List, Optional, Set, Tuple

from backend.app.providers import falkordb_bridges as fb
from backend.app.providers.falkordb_bridges import FalkorBridgeCallbacks
from backend.app.providers.falkordb_provider import FalkorDBProvider
from backend.common.models.graph import GraphNode
from backend.common.providers.lineage_bridges import run_bridge_path, run_lineage_bridges


class _Result:
    def __init__(self, rows):
        self.result_set = rows


class _Graph:
    def __init__(self) -> None:
        self.label: Dict[str, str] = {}
        self.parent: Dict[str, str] = {}
        self.edges: List[Tuple[str, str, str]] = []
        self.queries: List[Tuple[str, dict]] = []
        self.fail_region = False
        self.fail_expand_labels: Set[str] = set()

    def node(self, urn, label, parent=None):
        self.label[urn] = label
        if parent:
            self.parent[urn] = parent
        return self

    def flow(self, s, t):
        self.edges.append((s, t, f"{len(self.edges)}"))
        return self

    def chain(self, urn) -> List[str]:
        out, cur = [], self.parent.get(urn)
        while cur:
            out.append(cur)
            cur = self.parent.get(cur)
        return out

    def lineage_bearing(self) -> Set[str]:
        return {s for s, _, _ in self.edges} | {t for _, t, _ in self.edges}

    # -- the provider seams ------------------------------------------------

    async def ro_query(self, cypher, params=None, timeout=None, op=None, **kwargs):
        self.queries.append((cypher, dict(params or {})))
        assert op == "bridges.region", cypher
        if self.fail_region:
            raise RuntimeError("region query timed out")
        roots, cap, after = params["roots"], params["cap"], params.get("after")
        rows = set()
        for root in roots:
            for urn in self.label:
                if root in self.chain(urn) and urn in self.lineage_bearing():
                    rows.add((root, urn, self.label[urn]))
        ordered = sorted(rows, key=lambda r: (r[1], r[0]))
        if after is not None:
            ordered = [r for r in ordered if r[1] >= after]
        return _Result([list(r) for r in ordered[:cap]])

    async def labels_bulk(self, urns):
        return {u: self.label.get(u) for u in urns}

    async def lineage_degrees(self, anchors, ltypes, *, up, down, timeout):
        out = {}
        for urn, _ in anchors:
            i = sum(1 for _, t, _ in self.edges if t == urn) if up else 0
            o = sum(1 for s, _, _ in self.edges if s == urn) if down else 0
            out[urn] = (i, o)
        return out

    async def expand(self, frontier, labels, direction, ltypes, limit, timeout):
        rows, failed = [], set()
        for urn in frontier:
            label = labels.get(urn) or ""
            if label in self.fail_expand_labels:
                failed.add(label)
                continue
            for s, t, eid in self.edges:
                if (direction == "outgoing" and s == urn) or (direction == "incoming" and t == urn):
                    other = t if direction == "outgoing" else s
                    rows.append({
                        "sourceUrn": s, "targetUrn": t, "edgeId": eid, "edgeType": "FLOWS",
                        "otherUrn": other, "otherLabel": self.label.get(other, ""),
                    })
        return rows[:limit], failed

    async def chains(self, urns):
        return {u: self.chain(u) for u in urns}

    async def nodes_batch(self, urns):
        return [GraphNode(urn=u, entityType=self.label.get(u, "x"), displayName=u) for u in urns if u in self.label]


def _provider(graph: _Graph) -> FalkorDBProvider:
    p = FalkorDBProvider(host="x", graph_name="g")
    p._redis = None
    p._entity_type_levels = {"Domain": 0, "Table": 1, "Column": 2}
    p._ro_query = graph.ro_query
    p._resolve_urn_labels_bulk = graph.labels_bulk
    p._lineage_degrees = graph.lineage_degrees
    p._expand_raw_lineage_set = graph.expand
    p._compute_and_store_ancestors_bulk = graph.chains
    p.get_nodes_batch = graph.nodes_batch
    return p


def _callbacks(graph: _Graph) -> FalkorBridgeCallbacks:
    return FalkorBridgeCallbacks(_provider(graph), ["FLOWS"], ["CONTAINS"])


def _run(coro):
    return asyncio.run(coro)


def _chain_graph() -> _Graph:
    g = _Graph()
    for t in "ABCDEFG":
        g.node(t, "Table").node(f"{t}.c", "Column", parent=t)
    for a, b in zip("ABCDEFG", "BCDEFG"):
        g.flow(f"{a}.c", f"{b}.c")
    return g


# ---------------------------------------------------------------------------

def test_region_seeds_own_the_columns_through_one_label_qualified_query():
    g = _chain_graph()
    seeds = _run(_callbacks(g).region_seeds({"A": True, "C": True}, cap=100, timeout=5))
    assert seeds.owner == {"A.c": "A", "C.c": "C"}
    assert seeds.labels == {"A.c": "Column", "C.c": "Column"}
    assert seeds.complete and not seeds.failed
    (cypher, params), = g.queries
    assert "MATCH (f:Table)-[:CONTAINS*1.." in cypher
    assert "(d)-[:FLOWS]-()" in cypher
    assert "ORDER BY urn, root LIMIT $cap" in cypher
    assert params["roots"] == ["A", "C"]


def test_the_deepest_member_owns_and_a_non_inheriting_one_blocks():
    g = _Graph().node("D", "Domain").node("T", "Table", parent="D").node("U", "Table", parent="D")
    g.node("T.c", "Column", parent="T").node("U.c", "Column", parent="U").node("X", "Job")
    g.flow("T.c", "X").flow("X", "U.c")
    seeds = _run(_callbacks(g).region_seeds({"D": True, "T": True, "U": False}, cap=100, timeout=5))
    # T.c sits under D and T: T is deeper. U.c sits under D and U: U blocks.
    assert seeds.owner == {"T.c": "T"}


def test_a_non_inheriting_member_with_nothing_above_it_is_not_enumerated():
    g = _chain_graph()
    _run(_callbacks(g).region_seeds({"A": True, "B": False}, cap=100, timeout=5))
    (_, params), = g.queries
    assert params["roots"] == ["A"]


def test_members_own_themselves_when_they_carry_lineage():
    g = _Graph().node("A", "Table").node("B", "Table").flow("A", "B")
    seeds = _run(_callbacks(g).region_seeds({"A": True, "B": False}, cap=0, timeout=5))
    assert seeds.owner == {"A": "A", "B": "B"}


def test_pages_never_split_a_descendant_across_two_queries(monkeypatch):
    """A column under two members yields two rows; a page boundary between
    them must not lose the deeper one (which decides the owner)."""
    monkeypatch.setattr(fb, "REGION_PAGE_ROWS", 3)
    g = _Graph().node("D", "Domain")
    for t in ("T1", "T2", "T3"):
        g.node(t, "Table", parent="D").node(f"{t}.c", "Column", parent=t).flow(f"{t}.c", "Z")
    seeds = _run(_callbacks(g).region_seeds({"D": True, "T1": True, "T2": True, "T3": True}, cap=100, timeout=5))
    assert seeds.owner == {"T1.c": "T1", "T2.c": "T2", "T3.c": "T3"}
    assert seeds.complete
    assert any("d.urn >= $after" in c for c, _ in g.queries)


def test_the_cap_says_the_regions_are_not_fully_known(monkeypatch):
    monkeypatch.setattr(fb, "REGION_PAGE_ROWS", 2)
    g = _chain_graph()
    seeds = _run(_callbacks(g).region_seeds({t: True for t in "ABCDEFG"}, cap=3, timeout=5))
    assert not seeds.complete and not seeds.failed
    assert len([u for u in seeds.owner if u.endswith(".c")]) <= 3


def test_a_failed_enumeration_is_a_failure():
    g = _chain_graph()
    g.fail_region = True
    seeds = _run(_callbacks(g).region_seeds({"A": True}, cap=100, timeout=5))
    assert seeds.failed and not seeds.complete


def test_degrees_answer_the_walked_direction():
    g = _chain_graph()
    cb = _callbacks(g)
    assert _run(cb.degrees([("B.c", "Column")], incoming=True, timeout=5)) == {"B.c": 1}
    assert _run(cb.degrees([("G.c", "Column")], incoming=False, timeout=5)) == {"G.c": 0}


def test_a_failed_expand_bucket_names_its_nodes():
    g = _chain_graph()
    g.fail_expand_labels = {"Column"}
    page = _run(_callbacks(g).expand([("B.c", "Column")], incoming=False, limit=10, timeout=5))
    assert page.hops == [] and page.failed == {"B.c"}


def test_the_whole_walk_through_falkordb_reads():
    g = _chain_graph()
    result = _run(run_lineage_bridges(
        _callbacks(g), members={"A": True, "C": True, "F": True}, origins=None,
        direction="downstream", max_hops=10, max_nodes=1000, deadline=float("inf"),
    ))
    assert [(l.source, l.target, l.hops) for l in result.links] == [("A", "C", 2), ("C", "F", 3)]
    assert result.incomplete == [] and not result.truncated

    path = _run(run_bridge_path(
        _callbacks(g), members={"A": True, "C": True, "F": True}, source="A", target="C",
        max_hops=10, max_nodes=1000, deadline=float("inf"),
    ))
    assert path.hops == 2 and path.hidden_urns == ["B.c"]
    assert {n.urn for n in path.nodes} >= {"B.c", "B"}


def test_the_provider_method_runs_the_walk():
    g = _chain_graph()
    provider = _provider(g)

    async def _connected():
        return None

    provider._ensure_connected = _connected
    result = _run(provider.lineage_bridges(
        members={"A": True, "C": True}, origins=None, direction="downstream",
        max_hops=5, max_nodes=1000, lineage_edge_types=["FLOWS"],
        containment_edge_types=["CONTAINS"], timeout_ms=5000,
    ))
    assert [(l.source, l.target, l.hops) for l in result.links] == [("A", "C", 2)]
