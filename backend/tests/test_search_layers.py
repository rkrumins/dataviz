"""The layer filter: in a layer of the view as its canvas places entities there.

``view_placement`` is the contract the canvas places by; the search reads a layer filter's value
against the view (a layer's id, else a name no other layer has), carries the view's placement on
the filter, and every engine answers it as ``place_all`` would — the stub with ``place_all``
itself, FalkorDB with ``falkordb_placement`` (held to the shared corpus live, in
``tests/integration/test_search_layers_live.py``). A value no layer has keeps matching the stamp
entities carry, and says so.
"""
from __future__ import annotations

from types import SimpleNamespace

import pytest
from pydantic import TypeAdapter

from backend.app.providers.falkordb_deep_search import _Compiler, _relation_cost, match_hash
from backend.app.providers.falkordb_placement import glob_test, layer_test, _value
from backend.app.services import advanced_search_service as svc_mod
from backend.app.services.advanced_search_service import (
    AdvancedSearchService,
    ValidationError,
    _layer_id,
    _resolve_item_layers,
    _with_resolved_layers,
)
from backend.app.services.view_placement import (
    LayerTarget,
    NodeFacts,
    PlacementSpec,
    place_all,
)
from backend.app.services.deep_search import CompileError
from backend.app.services.native_query.parse_cost import operand, parse_cost
from backend.app.services.view_scope import EffectiveViewScope, _compute_scope_hash, _placement_inputs
from backend.common.models.search import Predicate, SearchQuery, SearchRuleItem
from backend.graph.adapters.stub_deep_search import StubDeepSearchProvider

P = TypeAdapter(Predicate).validate_python


def view(layers, assignments=None, scope="all"):
    return {"content": {"entityScope": scope},
            "layout": {"referenceLayout": {"layers": layers, "assignments": assignments or {}}}}


LAYERS = [
    {"id": "src", "name": "Sources", "order": 0, "entityTypes": ["system"]},
    {"id": "core", "name": "Core data", "order": 1, "entityTypes": ["dataset"],
     "rules": [{"id": "pii", "priority": 5, "tags": ["PII"]}]},
    {"id": "out", "name": "Reporting", "order": 2, "entityTypes": ["dashboard"]},
    {"id": "rest", "name": "Everything else", "order": 3, "showUnassigned": True},
]
CONFIG = view(LAYERS, {"sys:hand": {"layerId": "out", "inheritsChildren": True}})


def eff_scope(config=CONFIG) -> EffectiveViewScope:
    placement, layers, digest = _placement_inputs(config)
    return EffectiveViewScope(
        view_id="v", workspace_id="ws", data_source_id=None, canvas_kind="reference",
        root_urns=(), entity_type_allow_list=frozenset(), layer_allow_list=frozenset(),
        max_depth=12, scope_hash="h", placement=placement, layers=layers,
        placement_digest=digest)


def layer(value):
    return {"kind": "layer", "layerAssignment": value}


# ---------------------------------------------------------------------------
# The view's placement, read with its scope
# ---------------------------------------------------------------------------

class TestPlacementInputs:
    def test_a_view_without_layers_has_none(self):
        assert _placement_inputs({}) == (None, (), "")

    def test_layers_in_board_order_named_or_by_id(self):
        _, layers, _ = _placement_inputs(view([
            {"id": "b", "order": 2}, {"id": "a", "name": "A", "order": 1}, {"id": "c", "name": ""}]))
        assert layers == (("c", "c"), ("a", "A"), ("b", "b"))

    def test_the_digest_follows_what_decides_placement(self):
        _, _, base = _placement_inputs(CONFIG)
        assert _placement_inputs(CONFIG)[2] == base
        moved = view(LAYERS, {"sys:hand": {"layerId": "core", "inheritsChildren": True}})
        ruled = view([*LAYERS[:3], {**LAYERS[3], "entityTypes": ["job"]}],
                     {"sys:hand": {"layerId": "out", "inheritsChildren": True}})
        curated = view(LAYERS, {"sys:hand": {"layerId": "out", "inheritsChildren": True}},
                       scope="curated")
        assert len({base, *(_placement_inputs(c)[2] for c in (moved, ruled, curated))}) == 4

    def test_the_scope_hash_carries_it(self):
        common = dict(view_id="v", updated_at="t", root_urns=(), entity_types=frozenset(),
                      layer_ids=frozenset({"a"}), max_depth=12, branch_id="b")
        assert (_compute_scope_hash(**common, placement_digest="x")
                != _compute_scope_hash(**common, placement_digest="y"))


# ---------------------------------------------------------------------------
# Reading a layer filter's value against the view
# ---------------------------------------------------------------------------

class TestResolving:
    LAYERS = (("src", "Sources"), ("core", "Core data"), ("x", "Twin"), ("y", "twin "))

    @pytest.mark.parametrize("value, found", [
        ("core", "core"), ("Core data", "core"), ("  core DATA ", "core"), ("Sources", "src"),
        ("Nope", None), ("cor", None),
    ])
    def test_an_id_else_a_name_ignoring_case(self, value, found):
        assert _layer_id(self.LAYERS, value) == found

    def test_a_name_two_layers_share_names_their_ids(self):
        with pytest.raises(ValidationError, match="2 layers in this view are called .TWIN.*: x, y"):
            _layer_id(self.LAYERS, "TWIN")

    def test_nested_filters_carry_the_placement(self):
        notes = []
        p = _with_resolved_layers(P({"kind": "group", "op": "and", "children": [
            layer("Reporting"),
            {"kind": "related", "axis": "downstream", "where": layer("core")},
            {"kind": "group", "op": "not", "children": [layer("Sources")]},
        ]}), eff_scope(), notes)
        top, rel, neg = p.children
        assert (top._placement.layer_id, rel.where._placement.layer_id,
                neg.children[0]._placement.layer_id) == ("out", "core", "src")
        assert top._placement.digest == eff_scope().placement_digest and notes == []

    def test_a_value_no_layer_has_keeps_the_stamp_and_says_so(self):
        notes = []
        p = _with_resolved_layers(P(layer("bronze")), eff_scope(), notes)
        assert p._placement is None
        assert notes == ["No layer in this view is called “bronze”, so the layer filter "
                         "matched entities whose stored layer is “bronze”."]

    def test_a_view_without_layers_leaves_the_filter_alone(self):
        original = P(layer("core"))
        assert _with_resolved_layers(original, eff_scope({}), []) is original

    def test_past_the_limits_it_says_why(self, monkeypatch):
        monkeypatch.setattr(svc_mod, "LAYER_FILTER_MAX_HAND_PLACED", 0)
        with pytest.raises(ValidationError, match="places 1 entities by hand.*at most 0"):
            _with_resolved_layers(P(layer("core")), eff_scope(), [])

    def test_a_rule_that_cant_be_resolved_is_its_own_error(self):
        twins = view([{"id": "a", "name": "Same"}, {"id": "b", "name": "Same"}])
        items = [SearchRuleItem(id="1", predicate=layer("a")),
                 SearchRuleItem(id="2", predicate=layer("same"))]
        resolved, errors = _resolve_item_layers(items, eff_scope(twins))
        assert [i.id for i in resolved] == ["1"] and resolved[0].predicate._placement.layer_id == "a"
        assert "name the one you mean by its id: a, b" in errors["2"]


# ---------------------------------------------------------------------------
# The Cypher
# ---------------------------------------------------------------------------

def _compiler():
    return _Compiler(lineage_edge_types={"FLOWS_TO"}, containment_edge_types={"CONTAINS"})


def _resolved(raw, config=CONFIG):
    return _with_resolved_layers(P(raw), eff_scope(config), [])


class TestCypher:
    def test_a_resolved_layer_is_a_tail_stage(self):
        c = _compiler()
        head = c.compile(_resolved({"kind": "group", "op": "and", "children": [
            {"kind": "entityType", "values": ["dataset"]}, layer("core")]}))
        assert "reverse(nodes(" not in head and "labels(n)" in head
        assert len(c.tail) == 1 and "[:CONTAINS*1..20]->(n)" in c.tail[0]

    def test_inside_a_relationship_it_tests_the_relative_in_the_projection(self):
        c = _compiler()
        c.compile(_resolved({"kind": "related", "axis": "downstream", "where": layer("out")}))
        listed = c.tail[0]
        where, projection = listed.split(" | ", 1)
        assert "->(_xr" in projection and "reverse(nodes(" not in where

    def test_an_unresolved_layer_is_the_stamp(self):
        c = _compiler()
        assert c.compile(P(layer("bronze"))) == "n.layerAssignment = $p0"
        assert c.params == {"p0": "bronze"} and c.tail == []

    def test_the_match_set_key_follows_the_placement(self):
        a = SearchQuery(predicate=_resolved(layer("core")), scope={"viewId": "v"})
        b = SearchQuery(predicate=_resolved(layer("core"), view(
            LAYERS, {"sys:hand": {"layerId": "src", "inheritsChildren": True}})), scope={"viewId": "v"})
        plain = SearchQuery(predicate=P(layer("core")), scope={"viewId": "v"})
        assert len({match_hash(a), match_hash(b), match_hash(plain)}) == 3

    def test_its_units_hold_fewer_entities(self):
        """It reads each entity's ancestors and their rules: a unit of the usual width would
        hold a FalkorDB thread for seconds."""
        from backend.app.providers.falkordb_search.plan import unit_width

        assert unit_width(50_000, _resolved(layer("core"))) == 6_250
        assert unit_width(50_000, P({"kind": "related", "axis": "parent",
                                     "where": _resolved(layer("core"))})) == 6_250
        assert unit_width(50_000, P(layer("core"))) == 50_000       # the stamp alone
        assert unit_width(4_000, _resolved(layer("core"))) == 1_000

    def test_it_costs_more_than_a_parent(self):
        assert _relation_cost(_resolved(layer("core"))) > _relation_cost(
            P({"kind": "related", "axis": "parent"}))

    def test_it_parses_in_linear_time_wherever_it_stands(self):
        """Every kind of rule, hand placement that cascades and a fallback: FalkorDB parses the
        test in a few thousand token reads at the top of a query, as a relationship's far end and
        in a rule's membership column (``parse_cost``), where the walks first written took it
        seconds to minutes."""
        rules = [*LAYERS[:3],
                 {"id": "raw", "name": "Raw", "order": 4, "rules": [
                     {"id": "g", "urnPattern": "urn:*:raw"},
                     {"id": "o", "priority": 2, "conditions": [
                         {"field": "owner", "operator": "equals", "value": "finance"}]}]},
                 LAYERS[3]]
        spec = PlacementSpec.from_config(view(rules, {"sys:hand": {"layerId": "out"}}))

        def test(var, k):
            return layer_test(LayerTarget(spec, "core", "d"), var, name=lambda: k,
                              bind=lambda v: "$p", containment=["CONTAINS"])

        top = f"MATCH (n) WITH n, {operand(test('n', '1'))} AS t WHERE t RETURN n"
        far = (f"MATCH (n) WITH n, ANY(_b IN [(n)-[:FEEDS*1..3]->(_r) | {operand(test('_r', '2'))}] "
               f"+ [] WHERE _b) = true AS t WHERE t RETURN n")
        member = f"MATCH (n) RETURN ANY(_mz IN [0] WHERE {test('n', '3')}) = true AS m0"
        assert max(parse_cost(q) for q in (top, far, member)) < 30_000

    def test_too_many_rules_comparing_properties_are_refused_in_plain_words(self):
        """Rules on properties cost the test the most to parse; types merge into one list."""
        def rules(n, rule):
            return [{"id": f"l{i}", "name": f"L{i}", "order": i, **rule(i)} for i in range(n)]

        def compile_for(layers):
            spec = PlacementSpec.from_config(view(layers))
            return layer_test(LayerTarget(spec, "l0", "d"), "n", name=lambda: "1",
                              bind=lambda v: "$p", containment=["CONTAINS"])

        compile_for(rules(500, lambda i: {"entityTypes": [f"type{i}"]}))
        compile_for(rules(20, lambda i: {"rules": [{"id": f"r{i}", "conditions": [
            {"field": "owner", "operator": "equals", "value": f"o{i}"}]}]}))
        with pytest.raises(CompileError, match="60 rules, 60 of them comparing properties"):
            compile_for(rules(60, lambda i: {"rules": [{"id": f"r{i}", "conditions": [
                {"field": "owner", "operator": "equals", "value": f"o{i}"}]}]}))

    def test_a_curated_view_with_nothing_placed_by_hand_places_nothing(self):
        target = LayerTarget(PlacementSpec.from_config(view(LAYERS, scope="curated")), "core", "d")
        assert layer_test(target, "n", name=lambda: "1", bind=lambda v: "$p",
                          containment=["CONTAINS"]) == "false"

    def test_without_containment_only_its_own_decision_counts(self):
        params = {}

        def bind(v):
            params[f"p{len(params)}"] = v
            return f"$p{len(params) - 1}"

        test = layer_test(LayerTarget(PlacementSpec.from_config(CONFIG), "core", "d"), "n",
                          name=lambda: "1", bind=bind, containment=[])
        assert "CASE WHEN n.urn IN" in test and "n.layerAssignment" in test and ":CONTAINS" not in test
        # A rule's layer and the fallback are known here: the test reads only which applies.
        assert "core" in params.values() and "out" not in params.values()

    def test_stale_hand_placements_are_left_out(self):
        params = {}

        def bind(v):
            params[f"p{len(params)}"] = v
            return f"$p{len(params) - 1}"

        spec = PlacementSpec.from_config(view(LAYERS, {"a": {"layerId": "gone"},
                                                       "b": {"layerId": "src"}}))
        layer_test(LayerTarget(spec, "src", "d"), "n", name=lambda: "1", bind=bind,
                   containment=["CONTAINS"])
        assert ["b"] in params.values() and ["a"] not in params.values()

    @pytest.mark.parametrize("pattern, has, lacks", [
        ("urn:li:x", ["n.urn = $"], ["substring", "STARTS WITH"]),
        ("urn:*", ["STARTS WITH $"], ["ENDS WITH", "substring"]),
        ("*.raw", ["ENDS WITH $"], ["STARTS WITH", "substring"]),
        ("a*b*c", ["STARTS WITH", "ENDS WITH", "range("], []),
        ("a?c", ["size(n.urn) = 3", "+ '   '"], ["STARTS WITH"]),
    ])
    def test_globs_without_regex(self, pattern, has, lacks):
        test = glob_test("n.urn", pattern, lambda v: "$p", "g")
        assert all(h in test for h in has) and not any(l in test for l in lacks), test

    @pytest.mark.parametrize("field, reads", [
        ("name", "coalesce(x.name, CASE WHEN x.displayName <> ''"),
        ("type", "coalesce(x.type, coalesce(labels(x)[0]"),
        ("urn", "x.urn"),
        ("description", "null"),
        ("owner", "x.`owner`"),
        ("we`ird", "x.`we``ird`"),
    ])
    def test_a_rule_reads_the_users_properties_and_three_fields(self, field, reads):
        assert _value("x", field).startswith(reads)


# ---------------------------------------------------------------------------
# The reference: the stub answers with place_all itself
# ---------------------------------------------------------------------------

NODES = [
    {"urn": "sys:a", "entityType": "system"},
    {"urn": "sys:hand", "entityType": "system"},
    {"urn": "ds:1", "entityType": "dataset"},
    {"urn": "ds:pii", "entityType": "dataset", "tags": ["PII"]},
    {"urn": "ds:handchild", "entityType": "dataset"},
    {"urn": "col:1", "entityType": "column"},
    {"urn": "dash:1", "entityType": "dashboard"},
    {"urn": "job:1", "entityType": "job", "layerAssignment": "src"},
    {"urn": "loose", "entityType": "thing", "layerAssignment": "bronze"},
]
EDGES = [
    {"source": "sys:a", "target": "ds:1", "type": "CONTAINS"},
    {"source": "sys:a", "target": "ds:pii", "type": "CONTAINS"},
    {"source": "sys:hand", "target": "ds:handchild", "type": "CONTAINS"},
    {"source": "ds:1", "target": "col:1", "type": "CONTAINS"},
    {"source": "ds:1", "target": "dash:1", "type": "FLOWS_TO"},
    {"source": "ds:pii", "target": "job:1", "type": "FLOWS_TO"},
]


def _service(config=CONFIG):
    stub = StubDeepSearchProvider(nodes=NODES, edges=EDGES, lineage_edge_types=["FLOWS_TO"])
    svc = AdvancedSearchService(SimpleNamespace(provider=stub), session=None, workspace_id="ws")
    eff = eff_scope(config)

    async def resolve(requested):
        return eff

    async def guard(scope):
        return None

    svc._resolve_scope, svc._guard_view_data_source = resolve, guard
    return svc


def _canvas(config=CONFIG):
    spec = PlacementSpec.from_config(config)
    facts = {n["urn"]: NodeFacts(urn=n["urn"], entity_type=n["entityType"],
                                 tags=frozenset(n.get("tags", ())), stamp=n.get("layerAssignment"))
             for n in NODES}
    parents = {}
    for e in EDGES:
        if e["type"] == "CONTAINS":
            parents.setdefault(e["target"], []).append(e["source"])
    return {u: p.layer_id for u, p in place_all(spec, facts, parents).items()}


async def _urns(svc, raw):
    page, _ = await svc.search(SearchQuery(predicate=raw, scope={"viewId": "v"},
                                           options={"results": "hits", "pageSize": 100}))
    return sorted(h.node.urn for h in page.hits), page


class TestTheReference:
    @pytest.mark.parametrize("value", ["src", "Core data", "reporting", "rest"])
    async def test_each_layer_holds_what_the_canvas_draws_there(self, value):
        placed = _canvas()
        layer_id = {"src": "src", "Core data": "core", "reporting": "out", "rest": "rest"}[value]
        got, _ = await _urns(_service(), layer(value))
        assert got == sorted(u for u, l in placed.items() if l == layer_id)

    async def test_the_canvas_placement_this_view_makes(self):
        assert _canvas() == {
            "sys:a": "src", "sys:hand": "out", "ds:1": "core", "ds:pii": "core",
            "ds:handchild": "out", "col:1": "core", "dash:1": "out", "job:1": "src",
            "loose": "rest"}

    async def test_as_the_far_end_of_a_relationship(self):
        got, _ = await _urns(_service(), {"kind": "related", "axis": "downstream",
                                          "where": layer("Reporting")})
        assert got == ["ds:1"]

    async def test_not_in_a_layer(self):
        got, _ = await _urns(_service(), {"kind": "group", "op": "not",
                                          "children": [layer("core")]})
        assert got == ["dash:1", "ds:handchild", "job:1", "loose", "sys:a", "sys:hand"]

    async def test_a_value_no_layer_has_is_the_stamp_with_a_note(self):
        got, page = await _urns(_service(), layer("bronze"))
        assert got == ["loose"]
        assert any("No layer in this view is called" in n for n in page.scope_diagnostics.notes)
