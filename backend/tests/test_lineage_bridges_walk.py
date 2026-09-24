"""The lineage-bridges walker, against an in-memory graph and a brute-force oracle.

The walker (``backend/common/providers/lineage_bridges.py``) answers: which
members of a set reach which other members through lineage the set does not
contain, and in how many hops. These tests pin that answer three ways:

* worked scenarios — the A→B→C→D→E→F→G chain the feature exists for, nesting,
  ``inheritsChildren=False`` blocking, cycles, hubs, budgets, failures;
* an ORACLE property test — on hundreds of random cyclic graphs with random
  containment and random member sets, with ample budget the walker's links
  must EQUAL a brute-force per-origin BFS;
* the HONESTY property under tight budgets — every link reported is real (and
  never shorter than the truth), and every link missing or reported long has
  its source flagged incomplete downstream or its target flagged upstream.
"""
from __future__ import annotations

import asyncio
import random
from collections import deque
from typing import Dict, List, Mapping, Optional, Sequence, Set, Tuple

import pytest

from backend.common.models.graph import GraphNode
from backend.common.providers import lineage_bridges as lb
from backend.common.providers.lineage_bridges import (
    ExpandPage,
    Hop,
    RegionSeeds,
    owner_from_chain,
    run_bridge_path,
    run_lineage_bridges,
)


# ---------------------------------------------------------------------------
# In-memory graph + callbacks
# ---------------------------------------------------------------------------

class FakeGraph:
    def __init__(self) -> None:
        self.labels: Dict[str, str] = {}
        self.parent: Dict[str, str] = {}
        self.edges: List[Tuple[str, str, str]] = []   # (source, target, edge id)

    def node(self, urn: str, label: str = "Node", parent: Optional[str] = None) -> "FakeGraph":
        self.labels[urn] = label
        if parent:
            self.parent[urn] = parent
        return self

    def edge(self, source: str, target: str) -> "FakeGraph":
        for urn in (source, target):
            self.labels.setdefault(urn, "Node")
        self.edges.append((source, target, f"e{len(self.edges)}"))
        return self

    def chain(self, urn: str) -> List[str]:
        out: List[str] = []
        cur = self.parent.get(urn)
        while cur is not None:
            out.append(cur)
            cur = self.parent.get(cur)
        return out

    def lineage_bearing(self) -> Set[str]:
        return {s for s, _, _ in self.edges} | {t for _, t, _ in self.edges}

    def successors(self, urn: str) -> List[str]:
        return [t for s, t, _ in self.edges if s == urn]


class FakeCallbacks:
    """``BridgeCallbacks`` over a FakeGraph, with failure injection."""

    def __init__(
        self,
        graph: FakeGraph,
        *,
        supports_degrees: bool = True,
        fail_expand: Optional[Set[str]] = None,
        fail_degrees: bool = False,
        fail_chains: bool = False,
    ) -> None:
        self.g = graph
        self.supports_degrees = supports_degrees
        self.fail_expand = fail_expand or set()
        self.fail_degrees = fail_degrees
        self.fail_chains = fail_chains
        self.expanded: List[Tuple[str, bool]] = []

    async def region_seeds(self, members: Mapping[str, bool], *, cap: int, timeout: float) -> RegionSeeds:
        # The contract: a member's own node is always listed; the cap applies
        # to what lies beneath the members.
        owned: Dict[str, str] = {}
        beneath: Dict[str, str] = {}
        for urn in sorted(self.g.lineage_bearing()):
            owner = owner_from_chain(urn, self.g.chain(urn), members)
            if owner is None:
                continue
            (owned if urn in members else beneath)[urn] = owner
        complete = len(beneath) <= cap
        owned.update(dict(sorted(beneath.items())[:cap]))
        return RegionSeeds(
            owner=owned,
            labels={u: self.g.labels.get(u, "") for u in owned},
            complete=complete,
        )

    async def degrees(self, nodes, *, incoming: bool, timeout: float):
        if self.fail_degrees:
            return None
        out: Dict[str, int] = {}
        for urn, _ in nodes:
            out[urn] = sum(1 for s, t, _ in self.g.edges if (t if incoming else s) == urn)
        return out

    async def expand(self, nodes, *, incoming: bool, limit: int, timeout: float) -> ExpandPage:
        page = ExpandPage()
        for urn, _ in nodes:
            self.expanded.append((urn, incoming))
            if urn in self.fail_expand:
                page.failed.add(urn)
                continue
            for s, t, eid in self.g.edges:
                if (t if incoming else s) != urn:
                    continue
                other = s if incoming else t
                page.hops.append(Hop(
                    source=s, target=t, other=other,
                    other_label=self.g.labels.get(other, ""), edge_id=eid, edge_type="FLOWS",
                ))
                if len(page.hops) >= limit:
                    return page
        return page

    async def ancestor_chains(self, urns, *, timeout: float):
        if self.fail_chains:
            return None
        return {u: self.g.chain(u) for u in urns}

    async def hydrate(self, urns, *, timeout: float) -> List[GraphNode]:
        return [
            GraphNode(urn=u, entityType=self.g.labels.get(u, "Node"), displayName=u)
            for u in urns if u in self.g.labels
        ]


def run(coro):
    return asyncio.run(coro)


def bridges(cb, members, *, origins=None, direction="downstream", max_hops=10, max_nodes=10_000):
    return run(run_lineage_bridges(
        cb, members=members, origins=origins, direction=direction,
        max_hops=max_hops, max_nodes=max_nodes, deadline=float("inf"),
    ))


def links_of(result) -> Dict[Tuple[str, str], int]:
    return {(link.source, link.target): link.hops for link in result.links}


# ---------------------------------------------------------------------------
# Oracle
# ---------------------------------------------------------------------------

def oracle(graph: FakeGraph, members: Mapping[str, bool], sources, targets, max_hops: int):
    """Per-origin BFS on the whole graph, straight from the definition."""
    owner = {u: owner_from_chain(u, graph.chain(u), members) for u in graph.labels}
    succ: Dict[str, List[str]] = {}
    for s, t, _ in graph.edges:
        succ.setdefault(s, []).append(t)
    links: Dict[Tuple[str, str], int] = {}
    for a in sources:
        starts = [u for u, o in owner.items() if o == a]
        dist = {u: 0 for u in starts}
        queue = deque(starts)
        while queue:
            u = queue.popleft()
            if dist[u] >= max_hops:
                continue
            for v in succ.get(u, ()):
                if v in dist:
                    continue
                dist[v] = dist[u] + 1
                o = owner.get(v)
                if o is not None:
                    if o != a and o in targets:
                        links[(a, o)] = min(links.get((a, o), 99), dist[v])
                    continue
                queue.append(v)
    return links


def random_case(rng: random.Random):
    graph = FakeGraph()
    n = rng.randint(6, 28)
    urns = [f"n{i:02d}" for i in range(n)]
    depth: Dict[str, int] = {}
    for i, urn in enumerate(urns):
        parent = None
        if i > 0 and rng.random() < 0.55:
            candidates = [u for u in urns[:i] if depth[u] < 3]
            if candidates:
                parent = rng.choice(candidates)
        depth[urn] = depth[parent] + 1 if parent else 0
        graph.node(urn, rng.choice(["Table", "Column", "Job"]), parent)
    for _ in range(rng.randint(n, 2 * n + 4)):
        graph.edge(rng.choice(urns), rng.choice(urns))
    picked = rng.sample(urns, rng.randint(2, min(8, n)))
    members = {u: rng.random() < 0.75 for u in picked}
    direction = rng.choice(["downstream", "upstream"])
    origins = sorted(rng.sample(picked, rng.randint(1, len(picked)))) if rng.random() < 0.4 else None
    max_hops = rng.randint(1, 7)
    return graph, members, direction, origins, max_hops


def sides(members, direction, origins):
    chosen = set(origins or members)
    if direction == "upstream":
        return set(members), chosen
    return chosen, set(members)


# ---------------------------------------------------------------------------
# Worked scenarios
# ---------------------------------------------------------------------------

def chain_graph() -> FakeGraph:
    """A→B→…→G at COLUMN grain: every table holds one column, lineage runs
    between the columns — where it lives in a real estate."""
    g = FakeGraph()
    names = "ABCDEFG"
    for name in names:
        g.node(name, "Table").node(f"{name}.c", "Column", parent=name)
    for a, b in zip(names, names[1:]):
        g.edge(f"{a}.c", f"{b}.c")
    return g


class TestTheChain:
    def test_picking_a_c_f_keeps_the_story_as_two_virtual_hops(self):
        result = bridges(FakeCallbacks(chain_graph()), {"A": True, "C": True, "F": True})
        assert links_of(result) == {("A", "C"): 2, ("C", "F"): 3}
        assert result.incomplete == []
        assert not result.truncated

    def test_a_path_that_avoids_c_keeps_a_to_f(self):
        g = chain_graph().node("X", "Table").node("X.c", "Column", parent="X")
        g.edge("A.c", "X.c").edge("X.c", "F.c")
        result = bridges(FakeCallbacks(g), {"A": True, "C": True, "F": True})
        assert links_of(result) == {("A", "C"): 2, ("C", "F"): 3, ("A", "F"): 2}

    def test_adjacent_members_are_direct_links(self):
        result = bridges(FakeCallbacks(chain_graph()), {"A": True, "B": True})
        assert links_of(result) == {("A", "B"): 1}

    def test_max_hops_bounds_the_answer(self):
        result = bridges(FakeCallbacks(chain_graph()), {"A": True, "C": True, "F": True}, max_hops=2)
        assert links_of(result) == {("A", "C"): 2}

    def test_upstream_from_one_origin(self):
        result = bridges(
            FakeCallbacks(chain_graph()), {"A": True, "C": True, "F": True},
            origins=["F"], direction="upstream",
        )
        assert links_of(result) == {("C", "F"): 3}

    def test_downstream_from_one_origin(self):
        result = bridges(
            FakeCallbacks(chain_graph()), {"A": True, "C": True, "F": True},
            origins=["A"], direction="downstream",
        )
        assert links_of(result) == {("A", "C"): 2}

    def test_degreeless_providers_give_the_same_answer(self):
        result = bridges(FakeCallbacks(chain_graph(), supports_degrees=False), {"A": True, "C": True, "F": True})
        assert links_of(result) == {("A", "C"): 2, ("C", "F"): 3}

    def test_a_failed_degree_probe_falls_back_to_chunked_reads(self):
        result = bridges(FakeCallbacks(chain_graph(), fail_degrees=True), {"A": True, "C": True, "F": True})
        assert links_of(result) == {("A", "C"): 2, ("C", "F"): 3}
        assert not result.truncated

    def test_the_same_request_gives_the_same_answer(self):
        cb = FakeCallbacks(chain_graph())
        first = bridges(cb, {"A": True, "C": True, "F": True})
        second = bridges(cb, {"A": True, "C": True, "F": True})
        assert first.links == second.links and first.incomplete == second.incomplete


class TestOwnership:
    def test_owner_from_chain(self):
        members = {"T": True, "T.c1": True, "U": False}
        assert owner_from_chain("T", [], members) == "T"
        assert owner_from_chain("T.c2", ["T"], members) == "T"
        assert owner_from_chain("T.c1.x", ["T.c1", "T"], members) == "T.c1"
        assert owner_from_chain("U.c", ["U"], members) is None
        assert owner_from_chain("V.c", ["V"], members) is None

    def test_a_nested_member_owns_its_own_subtree(self):
        g = FakeGraph().node("T", "Table")
        g.node("T.c1", "Column", parent="T").node("T.c2", "Column", parent="T")
        g.node("Z", "Table").node("Z.c", "Column", parent="Z").node("Y", "Job")
        g.edge("T.c1", "Y").edge("Y", "Z.c").edge("T.c2", "Z.c")
        result = bridges(FakeCallbacks(g), {"T": True, "T.c1": True, "Z": True})
        assert links_of(result) == {("T.c1", "Z"): 2, ("T", "Z"): 1}

    def test_a_non_inheriting_member_blocks_its_contents(self):
        # T's column belongs to nobody, so lineage runs THROUGH it — the
        # canvas drops it from the view, and the hop over it is virtual.
        g = chain_graph()
        result = bridges(FakeCallbacks(g), {"A": True, "B": False, "C": True})
        assert links_of(result) == {("A", "C"): 2}

    def test_blocking_holds_under_an_inheriting_ancestor(self):
        g = FakeGraph().node("D", "Domain").node("T", "Table", parent="D")
        g.node("T.c", "Column", parent="T").node("A", "Table").node("A.c", "Column", parent="A")
        g.node("C", "Table").node("C.c", "Column", parent="C")
        g.edge("A.c", "T.c").edge("T.c", "C.c")
        result = bridges(FakeCallbacks(g), {"D": True, "T": False, "A": True, "C": True})
        assert links_of(result) == {("A", "C"): 2}

    def test_cycles_terminate_and_both_directions_are_links(self):
        g = FakeGraph().node("A", "Table").node("B", "Table")
        g.node("A.c", "Column", parent="A").node("B.c", "Column", parent="B").node("X", "Job")
        g.edge("A.c", "X").edge("X", "B.c").edge("B.c", "A.c").edge("X", "X")
        result = bridges(FakeCallbacks(g), {"A": True, "B": True})
        assert links_of(result) == {("A", "B"): 2, ("B", "A"): 1}

    def test_lineage_inside_one_member_is_not_a_link(self):
        g = FakeGraph().node("A", "Table").node("A.c1", "Column", parent="A").node("A.c2", "Column", parent="A")
        g.node("X", "Job").edge("A.c1", "X").edge("X", "A.c2")
        assert bridges(FakeCallbacks(g), {"A": True}).links == []

    def test_a_member_with_no_lineage_links_nothing(self):
        result = bridges(FakeCallbacks(chain_graph()), {"A": True, "NOPE": True})
        assert result.links == [] and result.incomplete == []


class TestBudgetsAndFailures:
    def test_the_two_sided_search_meets_at_a_hub_without_expanding_it(self, monkeypatch):
        monkeypatch.setattr(lb, "HUB_DEGREE", 5)
        g = FakeGraph().node("A", "Table").node("A.c", "Column", parent="A")
        g.node("C", "Table").node("C.c", "Column", parent="C").node("H", "Job")
        g.edge("A.c", "H").edge("H", "C.c")
        for i in range(12):
            g.edge("H", f"x{i}")
        cb = FakeCallbacks(g)
        result = bridges(cb, {"A": True, "C": True})
        assert links_of(result) == {("A", "C"): 2}
        assert result.incomplete == [] and not result.truncated
        assert ("H", False) not in cb.expanded          # the hub's fan-out was never read

    def test_a_hub_that_must_be_crossed_is_reported(self, monkeypatch):
        monkeypatch.setattr(lb, "HUB_DEGREE", 3)
        g = FakeGraph().node("A", "Table").node("A.c", "Column", parent="A")
        g.node("C", "Table").node("C.c", "Column", parent="C")
        g.edge("A.c", "H1").edge("H1", "H2").edge("H2", "C.c")
        for i in range(6):
            g.edge("H1", f"x{i}").edge(f"y{i}", "H2")
        result = bridges(FakeCallbacks(g), {"A": True, "C": True})
        assert ("A", "C") not in links_of(result)
        assert result.truncation_reason == "degree_cap"
        flagged = {(i.urn, i.side, i.reason) for i in result.incomplete}
        assert ("A", "downstream", "hub") in flagged or ("C", "upstream", "hub") in flagged

    def test_the_node_budget_is_honest(self):
        result = bridges(FakeCallbacks(chain_graph()), {"A": True, "G": True}, max_nodes=1)
        assert links_of(result) == {}
        assert result.truncated and result.truncation_reason == "max_nodes"
        assert {i.urn for i in result.incomplete} >= {"A"} or {i.urn for i in result.incomplete} >= {"G"}

    def test_a_failed_read_is_a_failure_not_an_empty_answer(self):
        cb = FakeCallbacks(chain_graph(), fail_expand={"B.c", "E.c"})
        result = bridges(cb, {"A": True, "D": True, "G": True})
        assert result.truncated and result.truncation_reason == "expand_failed"
        assert any(i.reason == "failed" for i in result.incomplete)

    def test_a_seed_cap_reports_every_inheriting_member(self, monkeypatch):
        monkeypatch.setattr(lb, "SEED_CAP", 1)
        result = bridges(FakeCallbacks(chain_graph()), {"A": True, "C": True, "F": False})
        flagged = {(i.urn, i.reason) for i in result.incomplete}
        assert ("A", "seed_cap") in flagged and ("C", "seed_cap") in flagged
        assert all(i.urn != "F" for i in result.incomplete)
        assert result.truncation_reason == "max_nodes"

    def test_failed_chains_never_become_a_path_through_a_member(self, monkeypatch):
        # Seeds capped => owners come from chains; chains fail => the unknown
        # nodes are CUT, never walked through as if they belonged to nobody.
        monkeypatch.setattr(lb, "SEED_CAP", 1)
        cb = FakeCallbacks(chain_graph(), fail_chains=True)
        result = bridges(cb, {"A": True, "B": True, "C": True})
        assert ("A", "C") not in links_of(result)
        assert result.truncation_reason in ("chains_failed", "max_nodes")
        assert "chains_failed" in result.truncation_reason or any(i.reason == "failed" for i in result.incomplete)

    def test_a_passed_deadline_truncates_as_timeout(self):
        result = run(run_lineage_bridges(
            FakeCallbacks(chain_graph()), members={"A": True, "G": True}, origins=None,
            direction="downstream", max_hops=10, max_nodes=100, deadline=0.0,
        ))
        assert result.truncated and result.truncation_reason == "timeout"


# ---------------------------------------------------------------------------
# Oracle properties
# ---------------------------------------------------------------------------

@pytest.mark.parametrize("supports_degrees", [True, False])
def test_with_ample_budget_the_walker_equals_the_oracle(supports_degrees, monkeypatch):
    monkeypatch.setattr(lb, "HUB_DEGREE", 10_000)
    rng = random.Random(20260924 + int(supports_degrees))
    for _ in range(300):
        graph, members, direction, origins, max_hops = random_case(rng)
        sources, targets = sides(members, direction, origins)
        expected = oracle(graph, members, sources, targets, max_hops)
        result = bridges(
            FakeCallbacks(graph, supports_degrees=supports_degrees), members,
            origins=origins, direction=direction, max_hops=max_hops,
        )
        assert links_of(result) == expected, (graph.edges, graph.parent, members, direction, origins, max_hops)
        assert result.incomplete == [] and not result.truncated


def test_under_tight_budgets_every_gap_is_reported(monkeypatch):
    rng = random.Random(7)
    for _ in range(300):
        graph, members, direction, origins, max_hops = random_case(rng)
        monkeypatch.setattr(lb, "HUB_DEGREE", rng.choice([1, 2, 3, 10_000]))
        monkeypatch.setattr(lb, "SEED_CAP", rng.choice([1, 3, 50_000]))
        sources, targets = sides(members, direction, origins)
        truth = oracle(graph, members, sources, targets, max_hops)
        result = bridges(
            FakeCallbacks(graph, supports_degrees=rng.random() < 0.7), members,
            origins=origins, direction=direction, max_hops=max_hops,
            max_nodes=rng.choice([1, 2, 4, 10_000]),
        )
        found = links_of(result)
        flagged_down = {i.urn for i in result.incomplete if i.side == "downstream"}
        flagged_up = {i.urn for i in result.incomplete if i.side == "upstream"}
        context = (graph.edges, graph.parent, members, direction, origins, max_hops, result)
        for pair, hops in found.items():
            assert pair in truth and hops >= truth[pair], context     # every link is real
        for (a, b), hops in truth.items():
            if found.get((a, b)) != hops:
                assert a in flagged_down or b in flagged_up, context  # every gap is named
        if result.incomplete:
            assert result.truncated, context


# ---------------------------------------------------------------------------
# Path mode
# ---------------------------------------------------------------------------

def path(cb, members, source, target, *, max_hops=10, max_nodes=10_000):
    return run(run_bridge_path(
        cb, members=members, source=source, target=target,
        max_hops=max_hops, max_nodes=max_nodes, deadline=float("inf"),
    ))


class TestPath:
    def test_the_hidden_steps_behind_a_virtual_hop(self):
        result = path(FakeCallbacks(chain_graph()), {"A": True, "C": True, "F": True}, "C", "F")
        assert result.hops == 3
        assert result.hidden_urns == ["D.c", "E.c"]
        assert result.endpoint_urns == ["C.c", "F.c"]
        assert [(e.source_urn, e.target_urn) for e in result.edges] == [
            ("C.c", "D.c"), ("D.c", "E.c"), ("E.c", "F.c"),
        ]
        assert result.ancestor_chains["D.c"] == ["D"]
        assert {n.urn for n in result.nodes} >= {"D.c", "E.c", "D", "E", "C.c", "F.c"}
        assert not result.truncated

    def test_every_shortest_path_is_included(self):
        g = chain_graph().node("X", "Table").node("X.c", "Column", parent="X")
        g.edge("A.c", "X.c").edge("X.c", "C.c")
        result = path(FakeCallbacks(g), {"A": True, "C": True}, "A", "C")
        assert result.hops == 2 and result.hidden_urns == ["B.c", "X.c"]

    def test_no_path_through_another_member(self):
        result = path(FakeCallbacks(chain_graph()), {"A": True, "C": True, "F": True}, "A", "F")
        assert result.hops is None and result.hidden_urns == []

    def test_path_mode_agrees_with_the_oracle(self, monkeypatch):
        """Hop count AND the exact set of hidden steps: every unowned node that
        lies on some shortest path, and nothing else."""
        monkeypatch.setattr(lb, "HUB_DEGREE", 10_000)
        rng = random.Random(99)
        checked = 0
        for _ in range(300):
            graph, members, _, _, max_hops = random_case(rng)
            a, b = rng.sample(sorted(members), 2)
            best, hidden = shortest_path_steps(graph, members, a, b, max_hops)
            result = path(FakeCallbacks(graph), members, a, b, max_hops=max_hops)
            context = (graph.edges, graph.parent, members, a, b, max_hops)
            assert result.hops == best, context
            assert set(result.hidden_urns) == hidden, context
            if best is not None:
                assert result.edges, context
                checked += 1
        assert checked > 50


def shortest_path_steps(graph: FakeGraph, members, source, target, max_hops):
    """Brute force: the minimum hop count from ``source`` to ``target`` through
    unowned nodes, and every unowned node on a path of exactly that length."""
    owner = {u: owner_from_chain(u, graph.chain(u), members) for u in graph.labels}
    succ: Dict[str, List[str]] = {}
    pred: Dict[str, List[str]] = {}
    for s, t, _ in graph.edges:
        succ.setdefault(s, []).append(t)
        pred.setdefault(t, []).append(s)

    def distances(starts, adj):
        dist = {u: 0 for u in starts}
        queue = deque(starts)
        while queue:
            u = queue.popleft()
            for v in adj.get(u, ()):
                if v in dist:
                    continue
                dist[v] = dist[u] + 1
                if owner.get(v) is None and dist[v] < max_hops:
                    queue.append(v)
        return dist

    forward = distances([u for u, o in owner.items() if o == source], succ)
    arrivals = [d for u, d in forward.items() if owner.get(u) == target]
    if not arrivals or min(arrivals) > max_hops:
        return None, set()
    best = min(arrivals)
    backward = distances([u for u, o in owner.items() if o == target], pred)
    return best, {
        u for u in graph.labels
        if owner.get(u) is None and u in forward and u in backward and forward[u] + backward[u] == best
    }
