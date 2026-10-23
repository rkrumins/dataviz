"""Relationships: conditions on the entities related to each one.

"Datasets whose parent is a domain", "fed by a topic", "every column
described", "at least three sources", "feeds a dashboard within three hops
through confident edges whose parent is Finance". Here: the model's rules,
the service's caps, the reference semantics (the stub, which
``tests/integration/test_search_relations_live.py`` holds every FalkorDB
engine to), and the Cypher the compiler writes — a relationship in the tail
after the head, walked from the entities it names when it names them,
degree counted the way a projection allows, names never shared between two
comprehensions of a statement.
"""
from __future__ import annotations

import re
from dataclasses import replace
from types import SimpleNamespace

import pytest
from pydantic import TypeAdapter, ValidationError as PydanticValidationError

from backend.app.providers.falkordb_deep_search import (
    _build_candidate_cypher,
    _build_within_hops_continuation,
    _Compiler,
    tail_clauses,
)
from backend.app.providers.falkordb_search import membership
from backend.app.providers.falkordb_search.keys import SortKey, SortSpec
from backend.app.providers.falkordb_search.plan import (
    Context,
    Unit,
    match_statement,
    raw_probe_statement,
)
from backend.app.providers.falkordb_search.raw_properties import RawLeaf
from backend.app.services import view_library
from backend.app.services.advanced_search_service import (
    AdvancedSearchService,
    ValidationError,
    _count_and_validate,
    _validate_predicate,
    follows_relationships,
)
from backend.app.services.view_scope import EffectiveViewScope
from backend.common.models.search import Predicate, RelatedPredicate, SearchQuery
from backend.graph.adapters.stub_deep_search import StubDeepSearchProvider

P = TypeAdapter(Predicate).validate_python


def rel(axis, where=None, **kw):
    p = {"kind": "related", "axis": axis, **kw}
    if where is not None:
        p["where"] = where
    return p


def TYPE(*values):
    return {"kind": "entityType", "values": list(values)}


def IS(*urns):
    return {"kind": "is", "refs": [{"urn": u} for u in urns]}


def AND(*children):
    return {"kind": "group", "op": "and", "children": list(children)}


def OR(*children):
    return {"kind": "group", "op": "or", "children": list(children)}


def _query(predicate) -> SearchQuery:
    return SearchQuery.model_validate({"predicate": predicate, "scope": {"viewId": "v"},
                                       "options": {"results": "hits"}})


def _compiler(**kw) -> _Compiler:
    return _Compiler(lineage_edge_types={"FLOWS_TO", "AGGREGATED"},
                     containment_edge_types={"CONTAINS"}, **kw)


# ---------------------------------------------------------------------------
# The model
# ---------------------------------------------------------------------------

class TestModel:
    @pytest.mark.parametrize("raw, why", [
        (rel("parent", maxHops=2), "parent is one step"),
        (rel("child", minHops=2, maxHops=2), "child is one step"),
        (rel("root", maxHops=3), "root takes no hops"),
        (rel("ancestor", edge={"kind": "edgeHasProperty", "key": "k"}),
         "edge filters apply to lineage"),
        (rel("descendant", edgeTypes=["X"]), "edge filters apply to lineage"),
        (rel("upstream", minHops=3, maxHops=2), "maxHops is less than minHops"),
        (rel("downstream", maxHops=11), "at most 10 hops"),
        (rel("child", quantifier="none", count={"op": "gt", "value": 1}),
         "count takes the place of the quantifier"),
    ])
    def test_a_relationship_takes_a_shape_its_axis_has(self, raw, why):
        with pytest.raises(PydanticValidationError, match=why):
            P(raw)

    def test_how_far_each_axis_reaches_by_default(self):
        assert P(rel("parent")).hop_range() == (1, 1)
        assert P(rel("upstream")).hop_range() == (1, 1)
        assert P(rel("downstream", minHops=2)).hop_range() == (2, 2)
        assert P(rel("neighbor", maxHops=3)).hop_range() == (1, 3)
        assert P(rel("ancestor")).hop_range() == (1, 20)
        assert P(rel("descendant", minHops=2)).hop_range() == (2, 20)
        assert P(rel("root")).hop_range() == (1, 20)

    def test_conditions_nest_and_round_trip(self):
        raw = rel("downstream", rel("parent", TYPE("workspace")), maxHops=3,
                  edge={"kind": "edgeProperty", "key": "confidence", "op": "gte",
                        "value": 0.8, "valueType": "number"},
                  edgeTypes=["FLOWS_TO"], count={"op": "gte", "value": 2})
        p = P(AND(raw))
        assert isinstance(p.children[0], RelatedPredicate)
        assert isinstance(p.children[0].where, RelatedPredicate)
        again = P(p.model_dump(by_alias=True, exclude_none=True))
        assert again == p


# ---------------------------------------------------------------------------
# The service's caps
# ---------------------------------------------------------------------------

class TestValidation:
    def test_relationships_nest_three_deep(self):
        _validate_predicate(P(rel("upstream", rel("parent", rel("root", TYPE("domain"))))))
        with pytest.raises(ValidationError, match=r"\$.where.where.where.*more than 3 deep"):
            _validate_predicate(P(rel("upstream", rel("parent", rel("root",
                                                                     rel("child"))))))

    def test_lineage_tested_from_every_candidate_goes_three_hops(self):
        _validate_predicate(P(rel("downstream", TYPE("dashboard"), maxHops=3)))
        with pytest.raises(ValidationError, match="4 hops.*at most 3.*Name the far end"):
            _validate_predicate(P(rel("downstream", TYPE("dashboard"), maxHops=4)))

    def test_lineage_walked_from_named_entities_goes_ten(self):
        _validate_predicate(P(AND(TYPE("dataset"), rel("upstream", IS("u"), maxHops=10))))
        # Not walked from them: under OR, quantified, or nested.
        for raw in (OR(TYPE("dataset"), rel("upstream", IS("u"), maxHops=10)),
                    rel("upstream", IS("u"), maxHops=10, quantifier="none"),
                    rel("parent", rel("upstream", IS("u"), maxHops=10))):
            with pytest.raises(ValidationError, match="at most 3"):
                _validate_predicate(P(raw))

    def test_a_rule_follows_lineage_one_hop(self):
        _validate_predicate(P(rel("upstream", TYPE("topic"))), rule=True)
        with pytest.raises(ValidationError, match="a rule follows lineage one hop"):
            _validate_predicate(P(rel("upstream", TYPE("topic"), maxHops=2)), rule=True)
        with pytest.raises(view_library.LibraryError, match="a rule follows lineage one hop"):
            view_library._check_predicate(rel("downstream", IS("u"), maxHops=2), rule=True)
        # A saved query may.
        view_library._check_predicate(rel("downstream", IS("u"), maxHops=2), rule=False)

    def test_a_rule_may_use_every_other_relationship(self):
        for raw in (rel("parent", TYPE("domain")), rel("root", IS("u")),
                    rel("child", {"kind": "property", "key": "description",
                                  "op": "isNotEmpty"}, quantifier="all"),
                    rel("child", count={"op": "gt", "value": 100}),
                    rel("upstream", {"kind": "hasProperty", "key": "owner"})):
            view_library._check_predicate(raw, rule=True)

    @pytest.mark.parametrize("inner", [
        {"kind": "descendantOf", "urns": ["u"]},
        {"kind": "withinHops", "urns": ["u"], "hops": 2},
        {"kind": "path", "sourceUrns": ["a"], "targetUrns": ["b"]},
    ])
    def test_route_kinds_cant_sit_in_a_relationships_condition(self, inner):
        with pytest.raises(ValidationError, match=r"\$.where.*can't sit inside"):
            _validate_predicate(P(rel("parent", inner)))

    def test_rollups_are_followed_one_hop(self):
        _validate_predicate(P(rel("downstream", edgeTypes=["AGGREGATED"])))
        with pytest.raises(ValidationError, match="AGGREGATED edges.*one hop"):
            _validate_predicate(P(rel("downstream", edgeTypes=["AGGREGATED"], maxHops=2)))

    def test_a_relationships_edge_filter_is_held_to_the_edge_caps(self):
        many = {"kind": "edgeGroup", "op": "and", "children": [
            {"kind": "edgeHasProperty", "key": f"k{i}"} for i in range(17)]}
        with pytest.raises(ValidationError, match=r"\$.edge has 17 conditions"):
            _validate_predicate(P(rel("upstream", edge=many)))
        with pytest.raises(ValidationError, match="confidence"):
            _validate_predicate(P(rel("upstream", edge={
                "kind": "edgeProperty", "key": "confidence", "op": "gt", "value": "high",
                "valueType": "number"})))

    def test_a_conditions_leaves_count(self):
        assert _validate_predicate(P(rel("parent", AND(TYPE("a"), TYPE("b"))))) == 3
        wide = rel("child", AND(*[TYPE(f"t{i}") for i in range(64)]))
        with pytest.raises(ValidationError, match="65 leaves"):
            _count_and_validate(_query(wide))

    def test_a_share_link_never_follows_one(self):
        assert follows_relationships(P(AND(TYPE("dataset"), rel("parent", TYPE("domain")))))
        assert not follows_relationships(P(AND(TYPE("dataset"))))


# ---------------------------------------------------------------------------
# The reference semantics
# ---------------------------------------------------------------------------

def _graph() -> StubDeepSearchProvider:
    """Sales ⊃ {orders ⊃ {id, amount}, customers, shared}; Finance ⊃ shared;
    events → orders → revenue; a → b → c → a; d1 → {d2, d3} → d4; and a
    rollup Sales ⇒ Finance."""
    nodes = [
        ("sales", "domain"), ("finance", "workspace"), ("orders", "dataset"),
        ("id", "column"), ("amount", "column"), ("customers", "dataset"),
        ("shared", "dataset"), ("events", "topic"), ("revenue", "dashboard"),
        ("a", "dataset"), ("b", "dataset"), ("c", "dataset"),
        ("d1", "dataset"), ("d2", "dataset"), ("d3", "dataset"), ("d4", "dataset"),
    ]
    contains = [("sales", "orders"), ("orders", "id"), ("orders", "amount"),
                ("sales", "customers"), ("sales", "shared"), ("finance", "shared")]
    lineage = [("events", "orders", 0.9), ("orders", "revenue", 0.5), ("a", "b", 0.9),
               ("b", "c", 0.9), ("c", "a", 0.9), ("d1", "d2", 0.9), ("d1", "d3", 0.9),
               ("d2", "d4", 0.9), ("d3", "d4", 0.9)]
    return StubDeepSearchProvider(
        nodes=[{"urn": u, "entityType": t, "displayName": u,
                **({"description": "pk"} if u == "id" else {})} for u, t in nodes],
        edges=([{"source": s, "target": t, "type": "CONTAINS"} for s, t in contains]
               + [{"source": s, "target": t, "type": "FLOWS_TO", "confidence": c}
                  for s, t, c in lineage]
               + [{"source": "sales", "target": "finance", "type": "AGGREGATED"}]))


async def _matching(raw) -> list:
    stub = _graph()
    answer = await stub.deep_search_membership(
        SimpleNamespace(root_urns=None, entity_types=None), [("q", P(raw))],
        [n["urn"] for n in stub._nodes])
    return sorted(answer["matches"]["q"])


class TestSemantics:
    async def test_the_tree_axes(self):
        assert await _matching(rel("parent", TYPE("domain"))) == [
            "customers", "orders", "shared"]
        assert await _matching(rel("child", TYPE("column"))) == ["orders"]
        assert await _matching(rel("descendant", TYPE("column"))) == ["orders", "sales"]
        assert await _matching(rel("ancestor", TYPE("domain"), minHops=2)) == ["amount", "id"]

    async def test_a_root_is_a_container_nothing_contains(self):
        # "shared" has two; either will do. A top-level entity has none.
        assert "shared" in await _matching(rel("root", IS("finance")))
        assert "shared" in await _matching(rel("root", IS("sales")))
        assert "sales" not in await _matching(rel("root"))
        assert await _matching(rel("root", IS("orders"))) == []

    async def test_an_entity_is_never_its_own_relative(self):
        """Round the cycle a → b → c → a, a reaches itself at three hops."""
        assert await _matching(rel("downstream", IS("a"), maxHops=3)) == ["b", "c"]

    async def test_a_route_passes_no_entity_twice(self):
        """x ⇄ y → … x → z: z is one hop from x, never three (x → y → x → z)."""
        stub = StubDeepSearchProvider(
            nodes=[{"urn": u, "entityType": "dataset", "displayName": u} for u in "xyz"],
            edges=[{"source": a, "target": b, "type": "FLOWS_TO"}
                   for a, b in (("x", "y"), ("y", "x"), ("x", "z"))])
        answer = await stub.deep_search_membership(
            SimpleNamespace(root_urns=None, entity_types=None),
            [("q", P(rel("downstream", IS("z"), minHops=2, maxHops=3)))], ["x", "y", "z"])
        assert answer["matches"]["q"] == ["y"]

    async def test_counts_are_of_distinct_entities(self):
        """d1 reaches d4 two ways; it counts once."""
        assert "d1" in await _matching(rel("downstream", maxHops=2,
                                           count={"op": "eq", "value": 3}))

    async def test_every_one_needs_one_at_least(self):
        described = {"kind": "property", "key": "description", "op": "isNotEmpty"}
        assert await _matching(rel("child", described, quantifier="all")) == []
        assert "id" not in await _matching(rel("child", quantifier="all", where=TYPE("x")))
        assert "id" in await _matching(rel("child", TYPE("x"), quantifier="none"))

    async def test_rollups_count_only_when_named(self):
        assert await _matching(rel("downstream", TYPE("workspace"))) == []
        assert await _matching(rel("downstream", TYPE("workspace"),
                                   edgeTypes=["AGGREGATED"])) == ["sales"]

    async def test_every_edge_walked_meets_the_edge_filter(self):
        confident = {"kind": "edgeProperty", "key": "confidence", "op": "gte",
                     "value": 0.8, "valueType": "number"}
        assert await _matching(rel("downstream", TYPE("dashboard"), maxHops=2)) == [
            "events", "orders"]
        assert await _matching(rel("downstream", TYPE("dashboard"), maxHops=2,
                                   edge=confident)) == []


# ---------------------------------------------------------------------------
# The Cypher
# ---------------------------------------------------------------------------

class TestCompiler:
    def test_a_relationship_waits_in_the_tail_behind_the_head(self):
        c = _compiler()
        head = c.compile(P(AND(TYPE("dataset"), rel("parent", TYPE("domain")))))
        assert head == "toLower(labels(n)[0]) IN $p0"
        assert c.tail == [
            "ANY(_xb1 IN [(n)<-[:CONTAINS]-(_xr1) WHERE ID(_xr1) <> ID(n) "
            "AND toLower(labels(_xr1)[0]) IN $p2 | true] WHERE _xb1)"]
        assert c.params == {"p0": ["dataset"], "p2": ["domain"]}

    def test_cheaper_relationships_run_first(self):
        c = _compiler()
        c.compile(P(AND(rel("descendant", TYPE("c")), rel("downstream", maxHops=3),
                        rel("parent"))))
        parent, downstream, descendant = c.tail
        assert "[(n)<-[:CONTAINS]-(" in parent
        assert "[(n)-[:FLOWS_TO*1..3]->(" in downstream
        assert "[(n)-[:CONTAINS*1..20]->(" in descendant

    def test_a_relatives_simple_tests_filter_and_the_rest_is_projected(self):
        c = _compiler()
        c.compile(P(rel("child", AND(TYPE("column"), rel("upstream")))))
        [stage] = c.tail
        assert stage.startswith("ANY(_xb0 IN [(n)-[:CONTAINS]->(_xr0) WHERE ID(_xr0) <> ID(n) "
                                "AND toLower(labels(_xr0)[0]) IN $p1 | coalesce(ANY(_xb2 IN "
                                "[(_xr0)<-[:FLOWS_TO]-(_xr2) WHERE ID(_xr2) <> ID(_xr0)")
        # The default lineage types leave the rollups out.
        assert "AGGREGATED" not in stage

    def test_quantifiers_and_counts(self):
        def tail(raw):
            c = _compiler()
            c.compile(P(raw))
            return c.tail[0]

        assert tail(rel("child", quantifier="none")).startswith("NOT ANY(_xb0 IN [")
        every = tail(rel("child", TYPE("column"), quantifier="all"))
        assert every.startswith("coalesce(reduce(_xa0 = null, _xb0 IN [(n)-[:CONTAINS]->(_xr0) "
                                "WHERE ID(_xr0) <> ID(n) | coalesce(toLower(labels(_xr0)[0])")
        counted = tail(rel("upstream", maxHops=2, count={"op": "gte", "value": 3}))
        assert counted.startswith("size(reduce(_xa0 = [], _xi0 IN [(n)<-[:FLOWS_TO*1..2]-(_xr0)")
        assert counted.endswith(") >= $p1")

    def test_a_root_is_said_in_the_projection(self):
        c = _compiler()
        c.compile(P(rel("root", TYPE("domain"))))
        assert ("[(n)<-[:CONTAINS*1..20]-(_xr0) WHERE ID(_xr0) <> ID(n) AND "
                "toLower(labels(_xr0)[0]) IN $p1 | size([(_xr0)<-[:CONTAINS]-(_xy0) | 1]) = 0]"
                in c.tail[0])

    def test_one_edge_or_a_path_of_them_meets_the_edge_filter(self):
        edge = {"kind": "edgeHasProperty", "key": "confidence"}
        c = _compiler()
        c.compile(P(AND(rel("upstream", edge=edge), rel("upstream", maxHops=2, edge=edge))))
        one, path = c.tail
        assert "[(n)<-[_xe0:FLOWS_TO]-(_xr0) WHERE ID(_xr0) <> ID(n) AND " \
               "EXISTS(_xe0.`confidence`)" in one
        assert "[_xp1 = (n)<-[:FLOWS_TO*1..2]-(_xr1) WHERE ID(_xr1) <> ID(n) AND " \
               "ALL(_xe1 IN relationships(_xp1) WHERE EXISTS(_xe1.`confidence`))" in path

    def test_a_users_edge_property_is_read_from_the_json_there_too(self):
        c = _compiler()
        c.compile(P(rel("upstream", edge={"kind": "edgeHasProperty", "key": "transform"})))
        assert "AND coalesce(_xe0.properties, '') CONTAINS $p1 | true]" in c.tail[0]
        assert c.params["p1"] == '"transform": '

    def test_lineage_naming_its_far_end_is_walked_from_it(self):
        c = _compiler()
        head = c.compile(P(AND(TYPE("dataset"),
                               rel("upstream", IS("src"), minHops=2, maxHops=4))))
        assert head == "toLower(labels(n)[0]) IN $p0" and c.tail == []
        fragment, params, _ = _build_within_hops_continuation(c.hoisted_within_hops, 7)
        # Past one hop, a route that passes an entity twice is refused
        # outright: FalkorDB's own walk lets one end on an entity it passed.
        assert fragment == (
            "MATCH _whP0 = (anchor)-[:FLOWS_TO*2..4]->(n) WHERE anchor.urn IN $_whUrns7 "
            "AND ID(anchor) <> ID(n) AND size(nodes(_whP0)) = size(reduce(_xs_wh0 = [], "
            "_xm_wh0 IN nodes(_whP0) | CASE WHEN _xm_wh0 IN _xs_wh0 THEN _xs_wh0 "
            "ELSE _xs_wh0 + [_xm_wh0] END)) WITH DISTINCT n")
        assert params == {"_whUrns7": ["src"]}

    def test_past_one_hop_a_route_passes_no_entity_twice(self):
        c = _compiler()
        c.compile(P(rel("downstream", TYPE("dataset"), minHops=2, maxHops=3)))
        assert c.tail[0].startswith(
            "ANY(_xb0 IN [_xp0 = (n)-[:FLOWS_TO*2..3]->(_xr0) WHERE ID(_xr0) <> ID(n) AND "
            "size(nodes(_xp0)) = size(reduce(_xs0 = [], _xm0 IN nodes(_xp0) | ")

    def test_containment_naming_its_far_end_clamps_and_keeps_the_exact_test(self):
        c = _compiler()
        assert c.compile(P(rel("ancestor", IS("sales"), maxHops=3))) == "true"
        assert (c.hoisted_root_urns, c.hoisted_max_depths) == ([["sales"]], [3])
        assert c.tail == ["ANY(_xb0 IN [(n)<-[:CONTAINS*1..3]-(_xr0) WHERE ID(_xr0) <> ID(n) "
                          "AND _xr0.urn IN $p1 | true] WHERE _xb0)"]

    def test_a_reference_that_named_nothing_matches_nothing(self):
        """What the service makes of it (``_NOTHING``): no relative meets it."""
        c = _compiler()
        nothing = {"kind": "group", "op": "not", "children": [{"kind": "all"}]}
        assert c.compile(P(rel("upstream", nothing))) == "true"
        assert c.tail[0].startswith("ANY(_xb0 IN [(n)<-[:FLOWS_TO]-(_xr0) WHERE "
                                    "ID(_xr0) <> ID(n) AND NOT (true)")

    def test_no_such_edges_relate_nothing(self):
        c = _Compiler(lineage_edge_types=set(), containment_edge_types={"CONTAINS"})
        c.compile(P(AND(rel("upstream", quantifier="none"), rel("downstream"),
                        rel("upstream", count={"op": "lte", "value": 2}))))
        assert c.tail == ["true", "false", "true"]

    def test_degree_in_a_projection_is_a_comprehension(self):
        c = _compiler()
        c.projected = True
        where = c.compile(P({"kind": "isOrphan", "edgeClass": "lineage"}))
        assert where == ("(size([(n)<-[:AGGREGATED|FLOWS_TO]-(_xd0) | 1]) + "
                         "size([(n)-[:AGGREGATED|FLOWS_TO]->(_xo0) | 1])) = $p1")
        c = _compiler()
        c.compile(P(rel("upstream", {"kind": "isRoot", "edgeClass": "lineage"})))
        assert "size([(_xr0)<-[:AGGREGATED|FLOWS_TO]-(_xd1) | 1]) = $p2" in c.tail[0]

    def test_a_relatives_properties_are_compared_natively(self):
        """The raw-property probe answers for a unit's own entities, not
        for their relatives."""
        c = _compiler()
        c.raw_leaves = []
        prop = {"kind": "property", "key": "owner", "op": "eq", "value": "x"}
        c.compile(P(OR(prop, rel("parent", prop))))
        assert [leaf.key for leaf in c.raw_leaves] == ["owner"]
        # The relative is never looked up in the probe's lists: its only ID
        # test is the one that keeps it from being the entity itself.
        assert "ID(n) IN $" in c.tail[0] and c.tail[0].count("ID(_xr") == 1


class TestStatements:
    def test_the_capped_prefix_runs_the_tail_before_its_cap(self):
        cypher = _build_candidate_cypher(
            where_fragment="n.a = 1", entity_types_param=False, candidate_cap=50,
            within_hops_continuation="MATCH h WITH DISTINCT n",
            tail=tail_clauses(["S1", "S2"]))
        assert cypher == ("MATCH (n) WHERE n.a = 1 MATCH h WITH DISTINCT n "
                          "WITH n, S1 AS _xt0 WHERE _xt0 WITH n, S2 AS _xt1 WHERE _xt1 "
                          "WITH n WITH n LIMIT 50")

    def test_a_unit_runs_it_after_its_clamps_and_hops_and_never_probes_it(self):
        ctx = Context(where="n.a = 1", params={}, sort=SortSpec((SortKey("n.urn"),)),
                      containment=("CONTAINS",), max_depth=12, within_hops="HOPS",
                      tail=("S1",))
        cypher, _ = match_statement(Unit("range", "L"), ctx, [[1]])
        assert cypher.endswith("WHERE ID(_r0) IN $_roots0 WITH DISTINCT n HOPS "
                               "WITH n, S1 AS _xt0 WHERE _xt0 WITH n")
        probe, _ = raw_probe_statement(Unit("range", "L"), replace_raw(ctx))
        assert "S1" not in probe and "HOPS" not in probe

    def test_rules_side_by_side_never_share_a_name(self):
        provider = SimpleNamespace(_get_lineage_edge_types=lambda: {"FLOWS_TO"},
                                   _get_containment_edge_types=lambda: {"CONTAINS"})
        items = [(f"r{i}", P(rel("upstream", rel("parent", TYPE("domain")))))
                 for i in range(3)]
        columns, *_ = membership._compile(provider, items, {})
        per_rule = [set(re.findall(r"_x[a-z]\d+", where)) for _, where in columns]
        assert all(per_rule)
        assert per_rule[0].isdisjoint(per_rule[1]) and per_rule[1].isdisjoint(per_rule[2])

    def test_a_rule_tests_lineage_where_it_stands(self):
        """Membership runs no hop continuation: a lineage relationship naming
        its far end is tested from the entity instead."""
        provider = SimpleNamespace(_get_lineage_edge_types=lambda: {"FLOWS_TO"},
                                   _get_containment_edge_types=lambda: {"CONTAINS"})
        errors = {}
        columns, *_ = membership._compile(provider, [("r", P(rel("upstream", IS("u"))))],
                                          errors)
        assert not errors
        assert columns == [("r", "(ANY(_xb0 IN [(n)<-[:FLOWS_TO]-(_xr0) WHERE ID(_xr0) <> "
                                 "ID(n) AND _xr0.urn IN $p1 | true] WHERE _xb0))")]


def replace_raw(ctx):
    return replace(ctx, raw_leaves=(RawLeaf("k", None, "exact", "r", "t"),))


# ---------------------------------------------------------------------------
# The service
# ---------------------------------------------------------------------------

def _service(stub) -> AdvancedSearchService:
    svc = AdvancedSearchService(SimpleNamespace(provider=stub), session=None, workspace_id="ws")
    eff = EffectiveViewScope(
        view_id="v", workspace_id="ws", data_source_id=None, canvas_kind="graph",
        root_urns=(), entity_type_allow_list=frozenset(), layer_allow_list=frozenset(),
        max_depth=12, scope_hash="h")

    async def resolve(requested):
        return eff

    async def guard(scope):
        return None

    svc._resolve_scope, svc._guard_view_data_source = resolve, guard
    return svc


class TestService:
    async def test_a_search_by_relationship_end_to_end(self):
        page, _ = await _service(_graph()).search(_query(AND(
            TYPE("dataset"), rel("downstream", TYPE("dashboard")))))
        assert [h.node.urn for h in page.hits] == ["orders"]

    async def test_names_inside_a_condition_are_resolved(self):
        page, _ = await _service(_graph()).search(_query(AND(
            rel("upstream", {"kind": "is", "refs": [{"path": ["**", "events"]}]}))))
        assert [h.node.urn for h in page.hits] == ["orders"]
        [resolved] = page.scope_diagnostics.resolved_refs
        assert resolved.at == "$.children[0].where.refs[0]" and resolved.count == 1

    async def test_a_relationship_past_its_caps_is_a_400(self):
        with pytest.raises(ValidationError, match="at most 3"):
            await _service(_graph()).search(_query(AND(
                rel("downstream", TYPE("dashboard"), maxHops=5))))
