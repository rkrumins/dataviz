"""The membership resolver — seeds and how far they reach in, the entities that names out.

A fake engine holds a small graph so the resolver's own logic is what is tested:

    containment   dom ⊃ tbl_a ⊃ {col_a1, col_a2};  dom ⊃ tbl_b ⊃ col_b1;  tbl_up ⊃ col_up
    lineage       src3 → src2 → src1 → col_a1 → rep1 → rep2
                  tbl_up → tbl_b            (a lineage edge between containers)
                  u1…u5 → hub → col_a2      (hub: more lineage than one step carries — paged)

and a closure step that reaches at most ``step_max`` hops, so a walk deeper than one step
must re-root what the step left on its frontier — the path a 25-hop limit takes on a
real graph.
"""
import pytest

from backend.app.services import view_membership as vm
from backend.app.services.view_membership import resolve_membership
from backend.common.models.graph import (
    GraphEdge,
    GraphNode,
    TraceClosureResult,
    TraceFocus,
    TraceFrontierNode,
)
from backend.common.models.view_membership import MembershipSpec

CONTAINS = {
    "dom": ["tbl_a", "tbl_b"],
    "tbl_a": ["col_a1", "col_a2"],
    "tbl_b": ["col_b1"],
    "tbl_up": ["col_up"],
}
LINEAGE = [
    ("src3", "src2"), ("src2", "src1"), ("src1", "col_a1"),
    ("col_a1", "rep1"), ("rep1", "rep2"),
    ("tbl_up", "tbl_b"),
    ("hub", "col_a2"),
    *[(f"u{i}", "hub") for i in range(1, 6)],
]
HUBS = {"hub"}
HUB_PAGE = 2


def _node(urn: str) -> GraphNode:
    return GraphNode(urn=urn, displayName=urn, entityType="thing")


class FakeEngine:
    def __init__(self, step_max: int = 25, chains: bool = True, step_gives_up: str = ""):
        self.step_max = step_max
        self.chains_supported = chains
        self.step_gives_up = step_gives_up   # a closure step's truncation reason, when set
        self.closure_calls = []
        self.descendant_calls = []
        self.parent = {c: p for p, cs in CONTAINS.items() for c in cs}
        self.all = set(self.parent) | set(CONTAINS) | {u for e in LINEAGE for u in e}

    # ── reads the resolver makes ────────────────────────────────────────────
    async def get_nodes_query(self, query):
        return [_node(u) for u in query.urns if u in self.all]

    async def get_descendants(self, urn, depth=5, entity_types=None, limit=100, offset=0):
        self.descendant_calls.append((urn, depth))
        out, frontier = [], [urn]
        for _ in range(depth):
            frontier = [c for p in frontier for c in CONTAINS.get(p, [])]
            out.extend(frontier)
        return [_node(u) for u in out[offset:offset + limit]]

    async def get_ancestor_chains(self, urns):
        if not self.chains_supported:
            raise NotImplementedError("no containment walk on this reader")
        out = {}
        for u in urns:
            chain, p = [], self.parent.get(u)
            while p:
                chain.append(p)
                p = self.parent.get(p)
            out[u] = chain
        return out

    async def trace_closure(self, req):
        self.closure_calls.append(req)
        up = req.direction == "upstream"
        nbrs = (lambda n: [s for s, t in LINEAGE if t == n]) if up else (lambda n: [t for s, t in LINEAGE if s == n])
        edge = (lambda a, b: (b, a)) if up else (lambda a, b: (a, b))

        if req.after_cursor:                       # a hub's next page
            start = int(req.after_cursor.split(":")[1])
            all_n = nbrs(req.urn)
            page = all_n[start:start + HUB_PAGE]
            more = start + HUB_PAGE < len(all_n)
            return self._result(up, [req.urn], set(page), [edge(req.urn, m) for m in page],
                                [TraceFrontierNode(urn=req.urn, nextCursor=f"e:{start + HUB_PAGE}")] if more else [])

        anchors = set()
        for s in req.seed_urns or [req.urn]:
            anchors |= self._lineage_leaves(s)
        depth = min(req.upstream_depth if up else req.downstream_depth, self.step_max)
        seen, side, edges, frontier, unfinished = set(anchors), set(), [], set(anchors), []
        for hop in range(depth):
            nxt = set()
            for n in frontier:
                if n in HUBS and n not in anchors:
                    unfinished.append(TraceFrontierNode(urn=n, nextCursor="e:0", reason="cut"))
                    continue
                for m in nbrs(n):
                    s_, t_ = edge(n, m)
                    edges.append((s_, t_))
                    if m not in seen:
                        seen.add(m)
                        side.add(m)
                        nxt.add(m)
            frontier = nxt
        unfinished += [TraceFrontierNode(urn=n, reason="depth") for n in frontier if nbrs(n)]
        return self._result(up, sorted(anchors), side, edges, unfinished)

    # ── helpers ─────────────────────────────────────────────────────────────
    def _lineage_leaves(self, urn):
        """A container walks from what inside it carries lineage, as the real closure does."""
        carries = {u for e in LINEAGE for u in e}
        if urn in carries:
            return {urn}
        out, stack = set(), list(CONTAINS.get(urn, []))
        while stack:
            u = stack.pop()
            if u in carries:
                out.add(u)
            stack.extend(CONTAINS.get(u, []))
        return out or {urn}

    def _result(self, up, anchors, side, edges, frontier):
        nodes = [_node(u) for u in sorted(set(anchors) | set(side))]
        ge = [GraphEdge(id=f"{s}>{t}", sourceUrn=s, targetUrn=t, edgeType="FLOWS_TO") for s, t in edges]
        return TraceClosureResult(
            nodes=nodes, edges=ge,
            upstreamUrns=set(side) if up else set(),
            downstreamUrns=set() if up else set(side),
            focus=TraceFocus(urn=anchors[0] if anchors else "x", level=0, entityType="thing"),
            effectiveLevel=0,
            frontierUp=frontier if up else [], frontierDown=[] if up else frontier,
            truncated=bool(self.step_gives_up), truncationReason=self.step_gives_up or None,
        )


def spec(urns=None, query=None, **expand):
    seeds = {"urns": urns} if urns is not None else {"query": query}
    return MembershipSpec.model_validate({"seeds": seeds, "expand": expand})


def by_urn(result):
    return {m.urn: m for m in result.members}


# ── Seeds ───────────────────────────────────────────────────────────────────


async def test_seeds_that_name_nothing_are_counted_not_walked():
    result = await resolve_membership(FakeEngine(), spec(["tbl_a", "ghost"]))
    assert set(by_urn(result)) == {"tbl_a"}
    assert by_urn(result)["tbl_a"].via == "seed"
    assert result.missing_seeds == 1
    assert result.counts.seeds == 1


def test_the_same_scope_has_one_identity_whatever_the_order():
    a = spec(["b", "a", "a"], upstream=1).spec_hash()
    b = spec(["a", "b"], upstream=1).spec_hash()
    assert a == b
    assert a != spec(["a", "b"], upstream=2).spec_hash()


def test_a_spec_names_urns_or_a_query_and_stays_in_range():
    with pytest.raises(ValueError):
        MembershipSpec.model_validate({"seeds": {}})
    with pytest.raises(ValueError):
        MembershipSpec.model_validate({"seeds": {"urns": ["a"]}, "expand": {"upstream": 26}})
    with pytest.raises(ValueError):
        MembershipSpec.model_validate({"seeds": {"urns": ["a"]}, "expand": {"children": 3}})
    assert MembershipSpec.model_validate({"seeds": {"urns": ["a"]}, "expand": {"upstream": "all"}})


async def test_query_seeds_come_from_the_search_and_say_when_more_existed():
    async def search(predicate):
        return ["col_a1", "col_a1"], True

    result = await resolve_membership(FakeEngine(), spec(query={"kind": "text", "value": "a"}), search=search)
    assert set(by_urn(result)) == {"col_a1"}
    assert [t.reason for t in result.truncated] == ["seed_cap"]


# ── What is inside ──────────────────────────────────────────────────────────


async def test_children_one_level_then_two():
    one = await resolve_membership(FakeEngine(), spec(["dom"], children=1))
    assert {u for u, m in by_urn(one).items() if m.via == "inside"} == {"tbl_a", "tbl_b"}
    assert one.counts.inside == 2

    two = await resolve_membership(FakeEngine(), spec(["dom"], children=2))
    assert {u for u, m in by_urn(two).items() if m.via == "inside"} == {"tbl_a", "tbl_b", "col_a1", "col_a2", "col_b1"}


async def test_everything_inside_is_named_not_enumerated():
    engine = FakeEngine()
    result = await resolve_membership(engine, spec(["dom"], children="all"))
    assert result.whole_subtree == ["dom"]
    assert result.counts.inside is None
    assert engine.descendant_calls == []


# ── Sources and consumers ───────────────────────────────────────────────────


async def test_one_hop_upstream_with_its_distance():
    result = await resolve_membership(FakeEngine(), spec(["col_a1"], upstream=1))
    assert {u: m.hops for u, m in by_urn(result).items() if m.via == "upstream"} == {"src1": 1}
    assert result.counts.upstream == 1


async def test_the_whole_upstream_trace_follows_what_each_step_leaves_unfinished():
    # Each closure step reaches one hop: the walk must re-root its frontier, twice.
    engine = FakeEngine(step_max=1)
    result = await resolve_membership(engine, spec(["col_a1"], upstream="all"))
    assert {u: m.hops for u, m in by_urn(result).items() if m.via == "upstream"} == {"src1": 1, "src2": 2, "src3": 3}
    assert len(engine.closure_calls) == 3


async def test_a_depth_beyond_one_step_stops_where_it_was_asked_to():
    result = await resolve_membership(FakeEngine(step_max=1), spec(["col_a1"], upstream=2))
    assert {u for u, m in by_urn(result).items() if m.via == "upstream"} == {"src1", "src2"}


async def test_a_container_seed_walks_from_what_inside_it_carries_lineage():
    result = await resolve_membership(FakeEngine(), spec(["tbl_a"], upstream="all", downstream=1))
    members = by_urn(result)
    assert {"src1", "src2", "src3"} <= {u for u, m in members.items() if m.via == "upstream"}
    assert {u for u, m in members.items() if m.via == "downstream"} == {"rep1"}
    assert members["src3"].hops == 3


async def test_what_is_inside_the_partners():
    result = await resolve_membership(FakeEngine(), spec(["tbl_b"], upstream=1, partnerChildren=1))
    members = by_urn(result)
    assert members["tbl_up"].via == "upstream"
    assert members["col_up"].via == "partnerInside"
    assert result.counts.partner_inside == 1


async def test_a_hub_is_paged_to_the_end():
    result = await resolve_membership(FakeEngine(), spec(["col_a2"], upstream=2))
    members = by_urn(result)
    assert members["hub"].hops == 1
    assert {f"u{i}" for i in range(1, 6)} <= set(members)
    assert all(members[f"u{i}"].hops == 2 for i in range(1, 6))


# ── Limits, said ────────────────────────────────────────────────────────────


async def test_the_member_cap_truncates_and_says_so():
    result = await resolve_membership(FakeEngine(), spec(["dom"], children=2), max_members=3)
    assert len(result.members) == 3
    assert any(t.reason == "member_cap" and t.limit == 3 for t in result.truncated)


async def test_a_spent_budget_keeps_what_it_has_and_says_so():
    result = await resolve_membership(FakeEngine(), spec(["col_a1"], upstream="all"), budget_s=0)
    assert [t.reason for t in result.truncated] == ["deadline"]


@pytest.mark.parametrize("reason, short", [("timeout", True), ("nodes_failed", True), ("max_nodes", False)])
async def test_a_step_that_gave_up_makes_the_answer_incomplete(reason, short):
    result = await resolve_membership(FakeEngine(step_gives_up=reason), spec(["col_a1"], upstream=1))
    assert [t.reason for t in result.truncated] == (["incomplete"] if short else [])
    assert result.degraded_detail == ("incomplete" if short else None)


def test_a_short_answer_is_cached_briefly_and_a_capped_one_for_good():
    """The graph cache's own test: a degraded answer takes seconds and never becomes
    last-known-good; a cap is the answer for that spec, and keeps the full TTL."""
    from backend.app.services.graph_cache import _is_incomplete_result
    from backend.common.models.view_membership import MembershipResult, MembershipTruncation

    def answer(reason):
        return MembershipResult(specHash="h", truncated=[MembershipTruncation(reason=reason, seen=1, limit=1)])

    assert _is_incomplete_result(answer("deadline"))
    assert _is_incomplete_result(answer("incomplete"))
    assert not _is_incomplete_result(answer("member_cap"))
    assert not _is_incomplete_result(MembershipResult(specHash="h"))


async def test_counts_alone_list_no_members():
    result = await resolve_membership(FakeEngine(), spec(["col_a1"], upstream=1), include_members=False)
    assert result.members == [] and result.chains == {}
    assert result.counts.total == 2


# ── Where the members sit ───────────────────────────────────────────────────


async def test_each_member_carries_its_containers_parent_first():
    result = await resolve_membership(FakeEngine(), spec(["col_a1"]))
    assert result.chains["col_a1"] == ["tbl_a", "dom"]


async def test_a_reader_without_a_containment_walk_answers_without_chains():
    result = await resolve_membership(FakeEngine(chains=False), spec(["col_a1"], upstream=1))
    assert result.chains == {}
    assert {"col_a1", "src1"} == set(by_urn(result))


async def test_the_chains_limit_is_said(monkeypatch):
    monkeypatch.setattr(vm, "CHAINS_MAX", 2)
    result = await resolve_membership(FakeEngine(), spec(["dom"], children=2))
    assert len(result.chains) == 2
    assert any(t.reason == "chains_cap" for t in result.truncated)
