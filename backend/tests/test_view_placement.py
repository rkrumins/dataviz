"""The placement contract's Python reference — ``backend/app/services/view_placement.py``.

The shared corpus (``tests/test_placement_conformance.py``) pins what both twins answer for whole
views. These tests pin the reference's own pieces: the rule sort key, inert reasons, the glob
grammar, the containment vocabulary, the tiers, ``place_all``'s order independence and cycles, the
write-path matrix, graph-node facts, the save check and the flag reader.
"""
import copy
import itertools
import os
import subprocess
import sys

import pytest

from backend.app.ontology.models import ResolvedOntology
from backend.app.services.view_placement import (
    CONTRACT_FLAG,
    CONTRACT_VERSION,
    HAND,
    MEMBER_SOURCES,
    RULE_OPERATORS,
    SOFT,
    NodeFacts,
    ParentContext,
    Placement,
    PlacementSpec,
    child_is_source,
    containment_from_ontology,
    containment_parents,
    contract_enabled,
    facts_from_graph_node,
    inert_rule_errors,
    place,
    place_all,
    suggest_placement,
)
from backend.common.models.graph import EdgeTypeMetadata, GraphEdge, GraphNode, OntologyMetadata

NO_CRITERIA = "has no criteria, so it can never place anything"


def spec(*layers, assignments=None, scope=None):
    reference = {"layers": list(layers)}
    if assignments is not None:
        reference["assignments"] = assignments
    content = {"entityScope": scope} if scope else {}
    return PlacementSpec.from_config({"content": content, "layout": {"referenceLayout": reference}})


def facts(urn, entity_type="", **kw):
    return NodeFacts(urn, entity_type, **kw)


def as_json(placements):
    return {urn: p.to_json() for urn, p in placements.items()}


def test_constants():
    assert CONTRACT_FLAG == "placementContractEnabled"
    assert CONTRACT_VERSION == 1
    assert RULE_OPERATORS == {"equals": "eq", "notEquals": "neq", "contains": "contains",
                              "startsWith": "startsWith", "endsWith": "endsWith", "exists": "isSet"}
    assert MEMBER_SOURCES == {"explicit", "inherited", "stamped", "rule"}


# ---------------------------------------------------------------------------
# Compiling a view
# ---------------------------------------------------------------------------

class TestRuleOrder:
    def test_rules_sort_once_by_priority_then_layer_order_position_and_index(self):
        s = spec(
            {"id": "late", "order": 2, "rules": [{"id": "high", "priority": 5, "entityTypes": ["T"]}]},
            {"id": "early", "order": 1, "rules": [{"id": "e0", "entityTypes": ["T"]},
                                                  {"id": "e1", "priority": 0, "entityTypes": ["T"]}]},
            {"id": "tie", "order": 1, "rules": [{"id": "t0", "entityTypes": ["T"]}]},
        )
        assert [r.id for r in s.rules] == ["high", "e0", "e1", "t0"]
        assert [r.key for r in s.rules] == [(-5, 2, 0, 0), (0, 1, 1, 0), (0, 1, 1, 1), (0, 1, 2, 0)]
        assert place(s, facts("u", "T")).to_json() == {"layerId": "late", "source": "rule", "ruleId": "high"}

    @pytest.mark.parametrize("extra", [{}, {"priority": None}, {"priority": "10"}, {"priority": True},
                                       {"priority": float("nan")}, {"priority": float("inf")}, {"priority": [3]}])
    def test_a_missing_or_non_numeric_priority_is_zero(self, extra):
        s = spec({"id": "b", "order": 1, "rules": [{"id": "b0", "priority": 0, "entityTypes": ["T"]}]},
                 {"id": "a", "order": 0, "rules": [{"id": "a0", "entityTypes": ["T"], **extra}]})
        assert [(r.id, r.priority) for r in s.rules] == [("a0", 0), ("b0", 0)]
        assert place(s, facts("u", "T")).layer_id == "a"  # the tie goes to the lower layer order

    def test_negative_priorities_sort_after_every_priority_zero_rule(self):
        s = spec({"id": "a", "order": 0, "rules": [{"id": "neg", "priority": -1, "entityTypes": ["T"]}]},
                 {"id": "b", "order": 1, "entityTypes": ["T"]})
        assert [r.id for r in s.rules] == ["_type_b_T", "neg"]
        assert place(s, facts("u", "T")).layer_id == "b"

    def test_layer_entity_types_are_priority_zero_rules_after_the_layers_authored_rules(self):
        s = spec({"id": "a", "order": 0, "entityTypes": ["Dataset", "Dataset", "dataset", "", 7],
                  "rules": [{"id": "r", "tags": ["x"]}]})
        assert [r.id for r in s.rules] == ["r", "_type_a_Dataset", "_type_a_dataset"]
        assert [r.key for r in s.rules] == [(0, 0, 0, 0), (0, 0, 0, 1), (0, 0, 0, 2)]
        assert s.rules[1].types == {"dataset"} and s.rules[1].cascades_soft

    def test_the_first_layer_wins_a_type_claimed_twice(self):
        s = spec({"id": "b", "order": 1, "entityTypes": ["Table"]}, {"id": "a", "order": 0, "entityTypes": ["TABLE"]})
        assert place(s, facts("u", "table")).to_json() == {"layerId": "a", "source": "rule", "ruleId": "_type_a_TABLE"}

    def test_layers_sort_by_order_then_position_and_need_a_string_id(self):
        s = spec({"id": "x", "order": "9"}, {"id": "", "order": -5}, {"name": "no id"}, "junk",
                 {"id": "y", "order": -1, "showUnassigned": "true"}, {"id": "z", "order": 0, "showUnassigned": True})
        assert s.layer_ids == {"x", "y", "z"}
        assert s.first_layer_id == "y"
        assert s.fallback_layer_id == "z"

    def test_rule_ids_default_to_their_layer_and_index(self):
        s = spec({"id": "a", "rules": ["junk", {"entityTypes": ["T"]}, {"id": "", "tags": ["x"]}]})
        assert [r.id for r in s.rules] == ["_rule_a_1", "_rule_a_2"]

    def test_explicit_entries_need_a_layer_id(self):
        s = spec({"id": "a"}, scope="all", assignments={
            "blank": {"layerId": ""}, "missing": {}, "number": {"layerId": 5},
            "stale": {"layerId": "gone"}, "kept": {"layerId": "a", "inheritsChildren": False, "logicalNodeId": "n"}})
        assert set(s.explicit) == {"stale", "kept"}
        assert s.explicit["kept"].logical_node_id == "n" and not s.explicit["kept"].inherits_children
        for urn in ("blank", "missing", "number"):
            assert place(s, facts(urn)).to_json() == {"layerId": None, "source": "none"}  # absent, never stale

    def test_scope_comes_from_the_full_config(self):
        assert spec({"id": "a"}).scope == "all"
        assert spec({"id": "a"}, assignments={"u": {"layerId": "a"}}).scope == "curated"
        assert spec({"id": "a"}, assignments={"u": {"layerId": "a"}}, scope="all").scope == "all"


class TestInertRules:
    def reasons(self, *rules):
        return [reason for _, _, reason in spec({"id": "a", "rules": list(rules)}).inert]

    def test_a_rule_with_no_criteria(self):
        assert self.reasons({"id": "r"}, {"id": "s", "entityTypes": [""], "tags": [""], "urnPattern": "",
                                          "conditions": []}) == [NO_CRITERIA, NO_CRITERIA]

    def test_contains_nothing_gives_the_semantics_reason(self):
        rule = {"id": "r", "propertyMatch": {"field": "name", "operator": "contains", "value": ""}}
        assert self.reasons(rule) == ["cannot compare 'name': type some text to look for"]

    def test_a_missing_value(self):
        rule = {"id": "r", "entityTypes": ["T"], "conditions": [{"field": "owner", "operator": "equals"}]}
        assert self.reasons(rule) == ["cannot compare 'owner': enter a value"]

    def test_an_unknown_operator(self):
        rule = {"id": "r", "entityTypes": ["T"], "conditions": [{"field": "owner", "operator": "between", "value": 1}]}
        assert self.reasons(rule) == ["uses an unknown operator between"]

    def test_a_blank_or_non_string_field_is_an_absent_condition(self):
        s = spec({"id": "a", "rules": [{"id": "r", "entityTypes": ["T"],
                                        "propertyMatch": {"field": "", "operator": "bogus"},
                                        "conditions": [{"field": None, "operator": "contains", "value": ""}]}]})
        assert s.inert == ()
        assert place(s, facts("u", "T")).layer_id == "a"
        assert self.reasons({"id": "r", "propertyMatch": {"field": "", "operator": "equals", "value": ""}}) == [NO_CRITERIA]

    def test_an_inert_rule_claims_nothing(self):
        s = spec({"id": "a", "order": 0, "rules": [{"id": "dead", "priority": 9, "entityTypes": ["T"],
                                                    "conditions": [{"field": "x", "operator": "nope"}]}]},
                 {"id": "b", "order": 1, "entityTypes": ["T"]})
        assert s.inert == (("a", "dead", "uses an unknown operator nope"),)
        assert [r.id for r in s.rules] == ["_type_b_T"]
        assert place(s, facts("u", "T")).layer_id == "b"


class TestGlob:
    @pytest.mark.parametrize("pattern,urn,expected", [
        ("urn:li:*", "urn:li:dataset:x", True),
        ("li:*", "urn:li:x", False),                       # anchored at the start
        ("urn:*:x", "urn:a:x:y", False),                   # and at the end
        ("urn:*", "urn:", True),                           # * may be empty
        ("a*b", "a\nb", True),                             # and spans newlines
        ("a?c", "abc", True),
        ("a?c", "ac", False),
        ("a?c", "abbc", False),
        ("a?c", "a\U0001D518c", True),                     # ? is one code point
        ("a.b*", "axb", False),                            # every other character is literal
        ("(x)+[y]|$^*", "(x)+[y]|$^", True),
        ("x+*", "xx", False),
        ("a\\*", "a\\bc", True),
        ("URN:*", "urn:x", False),                         # case-sensitive
        ("urn:li:dataset:(urn:li:dataPlatform:hive,*",     # an unbalanced ( still compiles
         "urn:li:dataset:(urn:li:dataPlatform:hive,db.orders,PROD)", True),
        ("urn:li:dataset:(urn:li:dataPlatform:?ive,db.orders,PROD)",
         "urn:li:dataset:(urn:li:dataPlatform:hive,db.orders,PROD)", True),
    ])
    def test_grammar(self, pattern, urn, expected):
        rule = spec({"id": "a", "rules": [{"id": "g", "urnPattern": pattern}]}).rules[0]
        assert rule.matches(facts(urn)) is expected


class TestMatch:
    def test_a_rule_is_the_and_of_its_criteria(self):
        rule = spec({"id": "a", "rules": [{
            "id": "r", "entityTypes": ["Dataset"], "tags": ["pii"], "urnPattern": "urn:prod:*",
            "conditions": [{"field": "owner", "operator": "equals", "value": "Alice"}]}]}).rules[0]
        base = dict(urn="urn:prod:1", entity_type="dataset", tags=frozenset({"pii", "x"}), properties={"owner": "ALICE"})
        assert rule.matches(NodeFacts(**base))
        for change in ({"entity_type": "Chart"}, {"tags": frozenset({"PII"})}, {"urn": "urn:dev:1"},
                       {"properties": {"owner": "bob"}}):
            assert not rule.matches(NodeFacts(**{**base, **change}))

    def test_types_fold_case_like_search_semantics(self):
        rule = spec({"id": "a", "rules": [{"id": "r", "entityTypes": ["İndex"]}]}).rules[0]
        assert rule.matches(facts("u", "index"))

    def test_fields_fall_back_to_name_type_and_urn_and_null_counts_as_missing(self):
        rule = spec({"id": "a", "rules": [{"id": "r", "conditions": [
            {"field": "name", "operator": "startsWith", "value": "ord"},
            {"field": "type", "operator": "equals", "value": "TABLE"},
            {"field": "urn", "operator": "endsWith", "value": ":1"}]}]}).rules[0]
        assert rule.matches(facts("urn:t:1", "table", display_name="Orders", properties={"name": None}))
        assert not rule.matches(facts("urn:t:1", "table", display_name="Orders", properties={"name": "Customers"}))

    @pytest.mark.parametrize("operator,value,stored,expected", [
        ("equals", 15, "015", True),                  # numeric text compares as a number
        ("equals", True, "TRUE", True),
        ("equals", "b", ["a", "B"], True),            # a stored list matches when any element does
        ("notEquals", "x", None, False),              # a missing value is never "not x"
        ("notEquals", "x", "y", True),
        ("notEquals", "x", ["x", "y"], False),        # ... and a list only when no element is x
        ("exists", None, None, False),
        ("exists", None, "", True),
        ("contains", "LIC", "Alice", True),
        ("endsWith", "5", 1.5, True),                 # a float reads as '%.15g'
    ])
    def test_values_compare_through_search_semantics(self, operator, value, stored, expected):
        rule = spec({"id": "a", "rules": [{"id": "r", "conditions": [
            {"field": "p", "operator": operator, "value": value}]}]}).rules[0]
        assert rule.matches(facts("u", properties={"p": stored})) is expected

    def test_operator_defaults_to_equals(self):
        rule = spec({"id": "a", "rules": [{"id": "r", "propertyMatch": {"field": "owner", "value": "Alice"}}]}).rules[0]
        assert rule.matches(facts("u", properties={"owner": "alice"}))


# ---------------------------------------------------------------------------
# Containment
# ---------------------------------------------------------------------------

class TestContainment:
    @pytest.mark.parametrize("edge_type,direction,expected", [
        ("CONTAINS", "target-to-source", True),
        ("CONTAINS", "child-to-parent", True),
        ("CONTAINS", "parent-to-child", False),
        ("BELONGS_TO", "parent-to-child", False),
        ("BELONGS_TO", "source-to-target", True),   # the resolver's default says nothing
        ("BELONGS_TO", "bidirectional", True),
        ("BELONGS_TO", None, True),
        ("belongs_to", None, True),
        ("CONTAINS", "source-to-target", False),
        ("CONTAINS", "bidirectional", False),
        ("HAS", None, False),
    ])
    def test_child_is_source(self, edge_type, direction, expected):
        assert child_is_source(edge_type, direction) is expected

    def test_reads_ontology_metadata(self):
        meta = OntologyMetadata(
            containmentEdgeTypes=["CONTAINS", "belongs_to", "has_part", "PART_OF"],
            edgeTypeMetadata={
                "CONTAINS": EdgeTypeMetadata(isContainment=True, direction="parent-to-child"),
                "BELONGS_TO": EdgeTypeMetadata(isContainment=True, direction="source-to-target"),
                "has_part": EdgeTypeMetadata(isContainment=True, direction="child-to-parent"),
            },
            entityTypeHierarchy={},
        )
        assert containment_from_ontology(meta) == {
            "CONTAINS": False, "BELONGS_TO": True, "HAS_PART": True, "PART_OF": False}

    def test_reads_a_resolved_ontology(self):
        resolved = ResolvedOntology(
            containment_edge_types=["BELONGS_TO", "contains"],
            edge_type_metadata={"BELONGS_TO": {"direction": "target-to-source"},
                                "CONTAINS": {"direction": "parent-to-child"}},
        )
        assert containment_from_ontology(resolved) == {"BELONGS_TO": True, "CONTAINS": False}

    def test_parents_follow_the_direction(self):
        edges = [
            GraphEdge(id="1", sourceUrn="db", targetUrn="table", edgeType="CONTAINS"),
            GraphEdge(id="2", sourceUrn="term", targetUrn="domain", edgeType="belongs_to"),
            GraphEdge(id="3", sourceUrn="db", targetUrn="view", edgeType="contains"),
            GraphEdge(id="4", sourceUrn="a", targetUrn="b", edgeType="PRODUCES"),
        ]
        assert containment_parents(edges, {"CONTAINS": False, "BELONGS_TO": True}) == {
            "table": ["db"], "term": ["domain"], "view": ["db"]}


# ---------------------------------------------------------------------------
# Placing one entity
# ---------------------------------------------------------------------------

class TestTiers:
    def test_own_explicit_beats_a_hand_parent_a_stamp_and_a_rule(self):
        s = spec({"id": "a", "entityTypes": ["T"]}, {"id": "b"}, {"id": "c"},
                 assignments={"u": {"layerId": "c"}}, scope="all")
        p = place(s, facts("u", "T", stamp="a"), [ParentContext("p", "b", HAND)])
        assert p.to_json() == {"layerId": "c", "source": "explicit"}
        assert p.cascade == HAND

    def test_an_explicit_entry_cascades_by_hand_unless_inherits_children_is_false(self):
        s = spec({"id": "a"}, assignments={"q": {"layerId": "a", "inheritsChildren": False}}, scope="all")
        assert place(s, facts("q")).cascade is None
        assert place_all(s, {"q": facts("q"), "c": facts("c")}, {"c": ["q"]})["c"].source == "none"

    def test_a_hand_parent_beats_the_childs_own_stamp_and_rule(self):
        s = spec({"id": "a"}, {"id": "b", "entityTypes": ["T"]}, scope="all")
        p = place(s, facts("c", "T", stamp="b"), [ParentContext("p", "a", HAND)])
        assert p.to_json() == {"layerId": "a", "source": "inherited", "inheritedFrom": "p"}
        assert p.cascade == HAND

    def test_own_stamp_beats_own_rule(self):
        s = spec({"id": "a", "entityTypes": ["T"]}, {"id": "b"})
        p = place(s, facts("u", "T", stamp="b"))
        assert p.to_json() == {"layerId": "b", "source": "stamped"}
        assert p.cascade == SOFT

    def test_a_stamp_must_name_a_layer(self):
        s = spec({"id": "a", "entityTypes": ["T"]})
        assert place(s, facts("u", "T", stamp="gone")).source == "rule"

    def test_own_rule_beats_a_soft_parent(self):
        s = spec({"id": "a"}, {"id": "b", "entityTypes": ["T"]})
        p = place(s, facts("c", "T"), [ParentContext("p", "a", SOFT)])
        assert p.to_json() == {"layerId": "b", "source": "rule", "ruleId": "_type_b_T"}

    def test_a_child_no_rule_claims_inherits_a_soft_parent(self):
        s = spec({"id": "a"}, {"id": "b", "entityTypes": ["T"]})
        p = place(s, facts("c", "U"), [ParentContext("p", "a", SOFT)])
        assert p.to_json() == {"layerId": "a", "source": "inherited", "inheritedFrom": "p"}
        assert p.cascade == SOFT

    def test_inherits_from_parent_false_stops_the_soft_cascade(self):
        s = spec({"id": "a", "rules": [{"id": "r", "entityTypes": ["T"], "inheritsFromParent": False},
                                       {"id": "s", "entityTypes": ["U"], "inheritsFromParent": None}]})
        assert place(s, facts("p", "T")).cascade is None
        assert place(s, facts("p", "U")).cascade == SOFT
        out = place_all(s, {"p": facts("p", "T"), "c": facts("c")}, {"c": ["p"]})
        assert out["c"].source == "none"

    def test_fallback_is_display_only(self):
        s = spec({"id": "a"}, {"id": "f", "order": 1, "showUnassigned": True})
        out = place_all(s, {"u": facts("u"), "c": facts("c")}, {"c": ["u"]})
        assert out["u"].to_json() == {"layerId": "f", "source": "fallback"}
        assert not out["u"].member and out["u"].cascade is None
        assert out["c"].source == "fallback"  # its own fallback, not inherited

    def test_nothing_places_none(self):
        assert place(spec({"id": "a"}), facts("u")).to_json() == {"layerId": None, "source": "none"}

    def test_a_stale_entry_falls_through_flagged_and_its_gate_goes_with_it(self):
        s = spec({"id": "a", "entityTypes": ["T"]}, scope="all",
                 assignments={"u": {"layerId": "gone", "inheritsChildren": False}})
        p = place(s, facts("u", "T"))
        assert p.to_json() == {"layerId": "a", "source": "rule", "ruleId": "_type_a_T", "staleExplicit": True}
        assert p.cascade == SOFT
        assert place(s, facts("u")).to_json() == {"layerId": None, "source": "none", "staleExplicit": True}

    def test_a_parent_context_naming_an_unknown_layer_is_ignored(self):
        s = spec({"id": "a"}, {"id": "b"})
        p = place(s, facts("c"), [ParentContext("p", "gone", HAND), ParentContext("q", "b", SOFT)])
        assert p.to_json() == {"layerId": "b", "source": "inherited", "inheritedFrom": "q"}

    def test_a_parent_context_without_a_cascade_passes_nothing(self):
        assert place(spec({"id": "a"}), facts("c"), [ParentContext("p", "a", None)]).source == "none"


class TestCurated:
    def test_a_curated_view_places_only_by_hand(self):
        s = spec({"id": "a", "entityTypes": ["T"]}, {"id": "f", "showUnassigned": True},
                 assignments={"p": {"layerId": "a"}})
        assert s.scope == "curated"
        assert place(s, facts("x", "T", stamp="a")).to_json() == {"layerId": None, "source": "none"}
        assert place(s, facts("c", "T"), [ParentContext("p", "a", HAND)]).source == "inherited"
        assert place(s, facts("c", "T"), [ParentContext("q", "a", SOFT)]).source == "none"

    def test_a_created_in_branch_stamp_places_and_cascades_by_hand(self):
        s = spec({"id": "a"}, {"id": "b", "entityTypes": ["T"]}, scope="curated")
        out = place_all(
            s,
            {"new": facts("new", stamp="b"), "kid": facts("kid", "T", stamp="a"),
             "other": facts("other", stamp="b"), "blank": facts("blank", stamp="gone")},
            {"kid": ["new"]},
            frozenset({"new", "blank"}),
        )
        assert out["new"].to_json() == {"layerId": "b", "source": "stamped"}
        assert out["new"].cascade == HAND
        assert out["kid"].to_json() == {"layerId": "b", "source": "inherited", "inheritedFrom": "new"}
        assert out["other"].to_json() == {"layerId": None, "source": "none"}
        assert out["blank"].to_json() == {"layerId": None, "source": "none"}


class TestMultipleParents:
    S = spec({"id": "a"}, {"id": "b"}, {"id": "c"})

    def test_a_hand_parent_beats_a_soft_parent_whose_urn_sorts_first(self):
        p = place(self.S, facts("x"), [ParentContext("p1", "a", SOFT), ParentContext("p2", "b", HAND)])
        assert p.to_json() == {"layerId": "b", "source": "inherited", "inheritedFrom": "p2"}

    def test_the_smallest_urn_wins_within_a_tier_and_different_layers_are_ambiguous(self):
        p = place(self.S, facts("x"), [ParentContext("p2", "b", HAND), ParentContext("p1", "a", HAND)])
        assert p.to_json() == {"layerId": "a", "source": "inherited", "inheritedFrom": "p1", "ambiguousParent": True}

    def test_parents_in_the_same_layer_are_not_ambiguous(self):
        p = place(self.S, facts("x"), [ParentContext("p2", "a", SOFT), ParentContext("p1", "a", SOFT)])
        assert p.to_json() == {"layerId": "a", "source": "inherited", "inheritedFrom": "p1"}

    def test_only_the_deciding_tier_counts_for_ambiguity(self):
        p = place(self.S, facts("x"), [ParentContext("p1", "a", HAND), ParentContext("p0", "c", SOFT)])
        assert p.to_json() == {"layerId": "a", "source": "inherited", "inheritedFrom": "p1"}

    def test_a_hand_placed_parent_beats_a_rule_placed_one_through_place_all(self):
        s = spec({"id": "a", "entityTypes": ["Domain"]}, {"id": "b"}, assignments={"p2": {"layerId": "b"}}, scope="all")
        out = place_all(s, {"p1": facts("p1", "Domain"), "p2": facts("p2"), "x": facts("x")}, {"x": ["p1", "p2"]})
        assert out["x"].to_json() == {"layerId": "b", "source": "inherited", "inheritedFrom": "p2"}


# ---------------------------------------------------------------------------
# Placing a set
# ---------------------------------------------------------------------------

class TestPlaceAll:
    def test_the_answer_does_not_depend_on_input_order(self):
        s = spec({"id": "a", "order": 0}, {"id": "b", "order": 1, "entityTypes": ["T"]}, {"id": "c", "order": 2},
                 assignments={"r": {"layerId": "a"}}, scope="all")
        nodes = [facts("r"), facts("db", "T"), facts("s", stamp="c"), facts("y", "T"), facts("x"), facts("z"),
                 facts("m"), facts("n", "T")]
        parents = {"db": ["r"], "x": ["y", "s"], "z": ["x", "db", "nowhere"], "m": ["n"], "n": ["m", "n"]}
        expected = place_all(s, {f.urn: f for f in nodes}, parents)
        assert as_json(expected) == {
            "r": {"layerId": "a", "source": "explicit"},
            "db": {"layerId": "a", "source": "inherited", "inheritedFrom": "r"},
            "s": {"layerId": "c", "source": "stamped"},
            "y": {"layerId": "b", "source": "rule", "ruleId": "_type_b_T"},
            "x": {"layerId": "c", "source": "inherited", "inheritedFrom": "s", "ambiguousParent": True},
            "z": {"layerId": "a", "source": "inherited", "inheritedFrom": "db"},
            "m": {"layerId": None, "source": "none"},
            "n": {"layerId": "b", "source": "rule", "ruleId": "_type_b_T"},
        }
        for i, order in enumerate(itertools.permutations(nodes[:6])):
            shuffled = {u: (ps[::-1] if i % 2 else ps) for u, ps in reversed(parents.items())}
            got = place_all(s, {f.urn: f for f in order + tuple(nodes[6:][::-1 if i % 2 else 1])}, shuffled)
            assert as_json(got) == as_json(expected)
            assert list(got) == list(expected)

    def test_parents_come_first(self):
        s = spec({"id": "a"}, assignments={"root": {"layerId": "a"}}, scope="all")
        out = place_all(s, {u: facts(u) for u in ("c", "b", "root")}, {"c": ["b"], "b": ["root"]})
        assert list(out) == ["root", "b", "c"]

    def test_a_cycle_is_ignored_while_its_descendants_still_inherit(self):
        s = spec({"id": "x"}, {"id": "y"}, assignments={"a": {"layerId": "x"}}, scope="all")
        out = place_all(s, {"a": facts("a"), "b": facts("b", stamp="y"), "c": facts("c")},
                        {"a": ["b"], "b": ["a"], "c": ["b"]})
        assert as_json(out) == {
            "a": {"layerId": "x", "source": "explicit"},
            "b": {"layerId": "y", "source": "stamped"},  # not inherited from a: the a<->b edges are gone
            "c": {"layerId": "y", "source": "inherited", "inheritedFrom": "b"},
        }

    def test_a_deep_hierarchy_never_recurses(self):
        urns = [f"u{i:05d}" for i in range(5000)]
        s = spec({"id": "a"}, assignments={urns[0]: {"layerId": "a"}}, scope="all")
        nodes = {u: facts(u) for u in urns}
        chain = {urns[i]: [urns[i - 1]] for i in range(1, len(urns))}
        assert all(p.layer_id == "a" for p in place_all(s, nodes, chain).values())
        ring = {**chain, urns[0]: [urns[-1]]}
        out = place_all(s, nodes, ring)
        assert out[urns[0]].source == "explicit"
        assert all(out[u].source == "none" for u in urns[1:])


# ---------------------------------------------------------------------------
# Write paths
# ---------------------------------------------------------------------------

class TestSuggest:
    OPEN = spec({"id": "a", "order": 0, "entityTypes": ["T"]}, {"id": "b", "order": 1},
                {"id": "f", "order": 2, "showUnassigned": True}, scope="all")
    CURATED = spec({"id": "a", "order": 1}, {"id": "b", "order": 0, "entityTypes": ["T"]},
                   assignments={"pinned": {"layerId": "a"}}, scope="curated")

    @pytest.mark.parametrize("node,chosen,default,expected", [
        (facts("u", "T"), None, None, ("a", False)),        # the contract already places it there
        (facts("u", "T"), "a", "b", ("a", False)),
        (facts("u", "T"), "b", None, ("b", True)),          # the chosen layer differs
        (facts("u", "T"), "gone", None, ("a", False)),      # a chosen id naming no layer is ignored
        (facts("u", stamp="b"), None, None, ("b", False)),  # stamped is a member
        (facts("u", "U"), None, None, (None, False)),       # fallback is display only: nothing to pin
        (facts("u", "U"), None, "b", ("b", True)),
        (facts("u", "U"), None, "gone", (None, False)),
        (facts("u", "U"), "b", None, ("b", True)),
    ])
    def test_open(self, node, chosen, default, expected):
        assert suggest_placement(self.OPEN, node, chosen, default) == expected

    @pytest.mark.parametrize("node,chosen,default,expected", [
        (facts("pinned"), None, None, ("a", True)),         # a curated view always pins
        (facts("pinned"), "b", None, ("b", True)),
        (facts("x", "T"), None, None, ("b", True)),         # what an open view would compute
        (facts("x", "T"), None, "a", ("b", True)),          # ... before the default
        (facts("x", "U"), None, "a", ("a", True)),
        (facts("x", "U"), None, None, ("b", True)),         # the first layer by order
        (facts("x", "U"), "a", None, ("a", True)),
        (facts("x", stamp="a"), None, None, ("a", True)),   # its stamp, read as an open view would
    ])
    def test_curated(self, node, chosen, default, expected):
        assert suggest_placement(self.CURATED, node, chosen, default) == expected

    def test_keywords_and_no_layers(self):
        assert suggest_placement(self.OPEN, facts("u", "U"), default_layer_id="b") == ("b", True)
        assert suggest_placement(spec(scope="curated"), facts("u"), "a", "a") == (None, False)


# ---------------------------------------------------------------------------
# Facts, output, save check, flag
# ---------------------------------------------------------------------------

class TestFactsFromGraphNode:
    @pytest.mark.parametrize("extra,stamp", [
        ({"layerAssignment": "a"}, "a"),
        ({"layerAssignment": "", "properties": {"layerAssignment": "b"}}, "b"),
        ({"layerAssignment": None, "properties": {"layerAssignment": "b"}}, "b"),
        ({"layerAssignment": "gone", "properties": {"layerAssignment": "b"}}, "gone"),  # a stale value hides the bag
        ({"layerAssignment": "", "properties": {"layerAssignment": ""}}, None),
        ({"properties": {"layerAssignment": 3}}, None),
        ({}, None),
    ])
    def test_the_stamp(self, extra, stamp):
        node = GraphNode(urn="u", entityType="T", displayName="N", **extra)
        assert facts_from_graph_node(node).stamp == stamp

    def test_the_rest_of_the_facts(self):
        node = GraphNode(urn="u", entityType="Dataset", displayName="Orders", tags=["pii", "x"],
                         properties={"owner": "ann"})
        assert facts_from_graph_node(node) == NodeFacts(
            "u", "Dataset", "Orders", frozenset({"pii", "x"}), {"owner": "ann"}, None)


class TestPlacementJson:
    def test_absent_and_false_keys_are_omitted_and_cascade_never_appears(self):
        assert Placement(None, "none", cascade=HAND).to_json() == {"layerId": None, "source": "none"}
        assert Placement("a", "inherited", inherited_from="p", stale_explicit=True, ambiguous_parent=True,
                         cascade=SOFT).to_json() == {"layerId": "a", "source": "inherited", "inheritedFrom": "p",
                                                     "staleExplicit": True, "ambiguousParent": True}

    def test_member(self):
        assert [Placement("a", s).member for s in ("explicit", "inherited", "stamped", "rule", "fallback")] == [
            True, True, True, True, False]
        assert not Placement(None, "none").member


class TestSaveCheck:
    STORED = {"layers": [{"id": "a", "name": "Sources", "rules": [{"id": "old", "urnPattern": ""}]}]}

    def with_rules(self, *rules):
        layout = copy.deepcopy(self.STORED)
        layout["layers"][0]["rules"] = list(rules)
        return layout

    def test_an_unchanged_inert_rule_passes(self):
        assert inert_rule_errors(self.STORED, copy.deepcopy(self.STORED)) == []

    def test_a_new_inert_rule_is_refused(self):
        layout = self.with_rules({"id": "old", "urnPattern": ""}, {"id": "new", "name": "Empty", "tags": [""]})
        assert inert_rule_errors(layout, self.STORED) == [
            f"layer 'Sources': rule 'Empty' {NO_CRITERIA}"]

    def test_a_changed_inert_rule_is_refused(self):
        layout = self.with_rules({"id": "old", "urnPattern": "", "priority": 3})
        assert inert_rule_errors(layout, self.STORED) == [f"layer 'Sources': rule 'old' {NO_CRITERIA}"]

    def test_deleting_an_earlier_rule_does_not_touch_a_stored_id_less_inert_rule(self):
        """Its positional id shifts when a rule ahead of it goes; its content does not."""
        for earlier in ({"id": "first", "entityTypes": ["T"]}, {"entityTypes": ["T"]}):
            stored = self.with_rules(earlier, {"urnPattern": ""})
            assert inert_rule_errors(self.with_rules({"urnPattern": ""}), stored) == []

    def test_a_changed_id_less_inert_rule_is_refused(self):
        stored = self.with_rules({"entityTypes": ["T"]}, {"urnPattern": ""})
        layout = self.with_rules({"urnPattern": "", "priority": 3})
        assert inert_rule_errors(layout, stored) == [f"layer 'Sources': rule '_rule_a_0' {NO_CRITERIA}"]

    def test_valid_rules_pass(self):
        layout = self.with_rules({"id": "old", "urnPattern": "urn:*"}, {"id": "new", "entityTypes": ["T"]})
        assert inert_rule_errors(layout, self.STORED) == []

    def test_against_nothing_stored(self):
        layout = {"layers": [{"id": "b", "rules": [
            {"entityTypes": ["T"], "conditions": [{"field": "x", "operator": "like", "value": 1}]}]}]}
        expected = ["layer 'b': rule '_rule_b_0' uses an unknown operator like"]
        assert inert_rule_errors(layout, {}) == expected
        assert inert_rule_errors(layout, None) == expected


class TestContractEnabled:
    async def test_reads_the_flag_with_default_false(self, monkeypatch):
        from backend.app.services.feature_flags import feature_flags

        calls = []

        async def is_enabled(key, session, default=True):
            calls.append((key, session, default))
            return True

        async def is_enabled_self_session(key, default=True):
            calls.append((key, None, default))
            return False

        monkeypatch.setattr(feature_flags, "is_enabled", is_enabled)
        monkeypatch.setattr(feature_flags, "is_enabled_self_session", is_enabled_self_session)
        session = object()
        assert await contract_enabled(session) is True
        assert await contract_enabled() is False
        assert calls == [(CONTRACT_FLAG, session, False), (CONTRACT_FLAG, None, False)]


def test_the_module_stays_pure():
    """Importing the contract pulls in only layout_config and search_semantics: no database,
    no flag service (``contract_enabled`` imports it when called)."""
    code = ("import sys, backend.app.services.view_placement; "
            "print(' '.join(sorted(m for m in sys.modules if m.startswith('backend'))))")
    root = os.path.join(os.path.dirname(__file__), "..", "..")
    out = subprocess.run([sys.executable, "-c", code], cwd=root, capture_output=True, text=True, check=True)
    assert set(out.stdout.split()) <= {
        "backend", "backend.app", "backend.app.services", "backend.app.services.layout_config",
        "backend.app.services.view_placement", "backend.common", "backend.common.search_semantics"}
