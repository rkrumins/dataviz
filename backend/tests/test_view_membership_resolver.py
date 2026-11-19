"""The membership resolver — seeds and how far they reach in, the entities that names out.

A fake engine holds a small graph so the resolver's own logic is what is tested
(``tests/fixtures/membership_graph.py``, shared with the member-set tests):

    containment   dom ⊃ tbl_a ⊃ {col_a1, col_a2};  dom ⊃ tbl_b ⊃ col_b1;  tbl_up ⊃ col_up
    lineage       src3 → src2 → src1 → col_a1 → rep1 → rep2
                  tbl_up → tbl_b            (a lineage edge between containers)
                  u1…u5 → hub → col_a2      (hub: more lineage than one step carries — paged)

and a closure step that reaches at most ``step_max`` hops, so a walk deeper than one step
must re-root what the step left on its frontier — the path a 25-hop limit takes on a real
graph. The tables a trace's columns sit in are read on a column-grain graph beside it:

    sales ⊃ {orders, payments};  orders ⊃ {ord_id, ord_amt, ord_note};  payments ⊃ pay_amt;  rpt ⊃ rpt_c
    pay_amt → ord_amt;  ord_id → rpt_c
"""
import hashlib
import json

import pytest

from backend.app.services import view_membership as vm
from backend.app.services.graph_cache import CacheScope
from backend.app.services.member_sets import walk
from backend.app.services.member_sets.store import set_key
from backend.app.services.view_membership import resolve_membership
from backend.common.models.graph import GraphEdge, GraphNode, TraceClosureResult, TraceFocus
from backend.common.models.view_membership import MembershipDefinition, MembershipSpec, MembershipStatus
from backend.tests.fixtures.membership_graph import FakeEngine


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


TRACE = {"seeds": {"urns": ["urn:li:c2", "urn:li:c1"]},
         "expand": {"upstream": "all", "downstream": 3, "children": "all"}}


@pytest.mark.parametrize("absent", [{}, {"partnerHosts": False, "partnerLineage": False}])
def test_a_trace_spec_keeps_every_identity_it_had_before_hosts(absent):
    """Pinned from before ``partnerHosts`` existed: the spec's hash, a view's resolution
    and definition hashes and stored definition, a member set's key, and the body
    ``GET /views/{id}/membership`` takes its ETag from. False is the same as absent."""
    scope_spec = MembershipSpec.model_validate({**TRACE, "expand": {**TRACE["expand"], **absent}})
    definition = MembershipDefinition.model_validate({
        "sources": [{"spec": scope_spec.model_dump(mode="json", by_alias=True, exclude_none=True)}],
        "layout": {"kind": "stages"}, "provenance": {"origin": "trace"}})
    assert scope_spec.spec_hash() == "624c9e3048ddbabd078a50c29f622fbe"
    assert definition.resolution_hash() == "768e8fde7c72bdf963d1c856679729eb"
    assert definition.definition_hash() == "4f82ef3ec723a6b2b28f1cc80072c53c"
    assert definition.model_dump(mode="json", by_alias=True, exclude_none=True)["sources"][0]["spec"]["expand"] == {
        "children": "all", "upstream": "all", "downstream": 3, "partnerChildren": 0}
    scope = CacheScope(workspace_id="ws", data_source_id="ds", graph_ns="g")
    assert set_key(scope, scope_spec.spec_hash(), read_in=None, boundary="", data_version="1",
                   include_edges=False) == "ff9aefb5fe75d522fb99548be25794741debc9ceba23cf3ddb54a1c708b334d4"
    status = MembershipStatus(mode="live", status="ok", definition=definition,
                              definitionHash=definition.definition_hash())
    body = json.dumps(status.model_dump(mode="json", by_alias=True), sort_keys=True)
    assert hashlib.sha256(body.encode()).hexdigest()[:32] == "1230f07a6a2127de8fdad46ce5ddd244"


def test_hosts_are_a_scope_of_their_own_and_their_lineage_needs_them():
    with_hosts = MembershipSpec.model_validate({**TRACE, "expand": {**TRACE["expand"], "partnerHosts": True}})
    assert with_hosts.spec_hash() != MembershipSpec.model_validate(TRACE).spec_hash()
    assert with_hosts.model_dump(by_alias=True)["expand"]["partnerHosts"] is True
    with pytest.raises(ValueError, match="expand.partnerLineage walks the tables the sources and consumers "
                                         "sit in: it needs partnerHosts"):
        MembershipSpec.model_validate({**TRACE, "expand": {**TRACE["expand"], "partnerLineage": True}})


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


# ── The tables the sources and consumers sit in ─────────────────────────────


def hosts(urns, **expand):
    return spec(urns, partnerHosts=True, **expand)


async def test_a_column_brings_in_the_table_it_sits_in_at_its_distance():
    result = await resolve_membership(FakeEngine(containment=True), hosts(["rpt_c"], upstream=1))
    assert {u: (m.via, m.hops) for u, m in by_urn(result).items()} == {
        "rpt_c": ("seed", None), "ord_id": ("upstream", 1), "orders": ("upstream", 1)}
    assert result.counts.upstream == 2


async def test_what_is_inside_the_tables_is_read_and_a_column_is_not():
    engine = FakeEngine(containment=True)
    result = await resolve_membership(engine, hosts(["rpt_c"], upstream=1, partnerChildren=1))
    assert {u for u, m in by_urn(result).items() if m.via == "partnerInside"} == {"ord_amt", "ord_note"}
    assert engine.descendant_calls == [("orders", 1)], "a column, counted empty, is never read"

    whole = await resolve_membership(FakeEngine(containment=True),
                                     hosts(["rpt_c"], upstream=1, partnerChildren="all"))
    assert whole.whole_subtree == ["ord_id", "orders"]


async def test_the_tables_lineage_is_walked_one_hop_further_while_depth_is_left():
    walked = await resolve_membership(FakeEngine(containment=True),
                                      hosts(["rpt_c"], upstream="all", partnerLineage=True))
    assert {u: m.hops for u, m in by_urn(walked).items() if m.via == "upstream"} == {
        "ord_id": 1, "orders": 1, "pay_amt": 2, "payments": 2}

    engine = FakeEngine(containment=True)
    shallow = await resolve_membership(engine, hosts(["rpt_c"], upstream=1, partnerLineage=True))
    assert {u for u, m in by_urn(shallow).items() if m.via == "upstream"} == {"ord_id", "orders"}
    assert len(engine.closure_calls) == 1, "a table at the depth asked for joins, and is not walked"

    engine = FakeEngine(containment=True)
    await resolve_membership(engine, hosts(["rpt_c"], upstream="all", partnerLineage=True))
    assert {r.upstream_depth for r in engine.closure_calls} == {1}, "a hop a step, the tables in step"


@pytest.mark.parametrize("children, orders", [(1, ("inside", None)), ("all", None)])
async def test_a_seed_or_what_is_inside_one_is_never_a_host(children, orders):
    # A column a step, the walk reaches ord_amt (inside the seed) from pay_amt.
    result = await resolve_membership(FakeEngine(containment=True, seed_page=1),
                                      hosts(["sales"], children=children, downstream=1))
    members = {u: (m.via, m.hops) for u, m in by_urn(result).items()}
    assert members["ord_amt"] == ("downstream", 1)
    assert members.get("orders") == orders
    assert members["rpt"] == ("downstream", 1), "rpt_c's table is no seed's"


async def test_a_table_brings_no_host_and_an_engine_that_cannot_say_brings_none():
    table = await resolve_membership(FakeEngine(containment=True), hosts(["tbl_up"], downstream=1))
    assert set(by_urn(table)) == {"tbl_up", "tbl_b"}, "a table is its own host: dom does not join"

    untyped = await resolve_membership(FakeEngine(), hosts(["rpt_c"], upstream=1))
    assert set(by_urn(untyped)) == {"rpt_c", "ord_id"}
    assert await walk.leaf_rule(object()) is None


async def test_a_step_without_its_chains_is_taken_again_then_let_go_when_finding_hosts():
    engine = FakeEngine(containment=True, step_gives_up="ancestors_failed")
    result = await resolve_membership(engine, hosts(["rpt_c"], upstream=1))
    assert len(engine.closure_calls) == walk.TRIES
    assert set(by_urn(result)) == {"rpt_c", "ord_id"}, "what it found is kept once let go"
    assert [t.reason for t in result.truncated] == ["incomplete"]

    plain = FakeEngine(containment=True, step_gives_up="ancestors_failed")
    result = await resolve_membership(plain, spec(["rpt_c"], upstream=1))
    assert len(plain.closure_calls) == 1 and result.truncated == [], "without hosts, chains are no part of it"


def test_a_host_found_nearer_keeps_the_nearer_distance():
    """The rule itself (``walk.absorb``): a column found at 1 inside a table known at 3
    brings the table to 1, queued to be walked from there; a table the step found in
    its own right (at 2) keeps the nearer of the two."""
    types = {"a": "schemaField", "c": "schemaField", "d": "schemaField", "t": "dataset", "u": "dataset"}
    result = TraceClosureResult(
        nodes=[GraphNode(urn=u, displayName=u, entityType=t) for u, t in types.items()],
        edges=[GraphEdge(id=f"{s}>{t}", sourceUrn=s, targetUrn=t, edgeType="FLOWS_TO")
               for s, t in (("a", "c"), ("a", "d"), ("d", "u"))],
        containmentEdges=[GraphEdge(id=f"{p}>{c}", sourceUrn=p, targetUrn=c, edgeType="CONTAINS")
                          for p, c in (("t", "c"), ("u", "d"))],
        downstreamUrns={"c", "d", "u"}, focus=TraceFocus(urn="a", level=0, entityType="schemaField"),
        effectiveLevel=0,
    )
    work = walk.Work("batch", ["a"], 0, {"a": "a"})
    known = {"a": walk.Known(via="seed", hops=0), "t": walk.Known(via="downstream", hops=3, walked=2)}

    change, _ = walk.absorb(work, result, known, "downstream", 5,
                            is_leaf=lambda t: t == "schemaField", walk_hosts=True)
    assert {f.urn: f.hops for f in change.new} == {"c": 1, "d": 1, "u": 1}
    assert {f.urn: f.hops for f in change.nearer} == {"t": 1}
    assert sorted(change.queue) == ["t", "u"]

    plain, _ = walk.absorb(work, result, known, "downstream", 5)
    assert {f.urn: f.hops for f in plain.new} == {"c": 1, "d": 1, "u": 2} and plain.nearer == []


def test_what_is_inside_a_host_is_walked_from_the_hosts_distance():
    """Two tables walked at 2 (``walk.absorb``): a column of one that a column of the
    other reaches is a partner at 3 — shipped as reached (b1) or only walked from (b2) —
    and is walked from 2, as what is inside its table is: what it reaches is at 3 too."""
    types = {"A": "dataset", "a1": "schemaField", "B": "dataset", "b1": "schemaField", "b2": "schemaField",
             "C": "dataset", "c": "schemaField"}
    result = TraceClosureResult(
        nodes=[GraphNode(urn=u, displayName=u, entityType=t) for u, t in types.items()],
        edges=[GraphEdge(id=f"{s}>{t}", sourceUrn=s, targetUrn=t, edgeType="FLOWS_TO")
               for s, t in (("a1", "b1"), ("a1", "b2"), ("b1", "c"))],
        containmentEdges=[GraphEdge(id=f"{p}>{c}", sourceUrn=p, targetUrn=c, edgeType="CONTAINS")
                          for p, c in (("A", "a1"), ("B", "b1"), ("B", "b2"), ("C", "c"))],
        downstreamUrns={"b1", "c"}, focus=TraceFocus(urn="A", level=0, entityType="dataset"),
        effectiveLevel=0,
    )
    work = walk.Work("batch", ["A", "B"], 2, {"A": "s", "B": "s"})
    known = {"A": walk.Known(via="downstream", hops=2), "B": walk.Known(via="downstream", hops=2)}

    change, _ = walk.absorb(work, result, known, "downstream", 10,
                            is_leaf=lambda t: t == "schemaField", walk_hosts=True)
    assert {f.urn: f.hops for f in change.new} == {"b1": 3, "b2": 3, "c": 3, "C": 3}
    assert change.walked == ["b1", "b2"], "walked from their table's distance: not again from their own"


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
