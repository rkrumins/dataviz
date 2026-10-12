"""Every place a definition points at the graph, and rewriting those places.

The fixture below exercises EVERY location ``references.py`` knows about. When a new place that
holds a URN or a type is added to views, add it to the module and to this fixture together.
"""
from __future__ import annotations

import copy

from backend.app.services.view_transfer.references import (
    Rewrite,
    collect,
    definition_stats,
    rewrite,
    urns_of_kind,
)

GOLDEN = {
    "content": {
        "visibleEntityTypes": ["domain", "dataset"],
        "rootEntityTypes": ["domain"],
        "visibleRelationshipTypes": ["CONTAINS", "PRODUCES"],
        "rootUrns": ["urn:root"],
        "entityScope": "curated",
    },
    "filters": {"entityTypeFilters": ["column"], "fieldFilters": []},
    "entityOverrides": {"dashboard": {"color": "#fff"}},
    "layout": {
        "type": "reference",
        "lod": {"enabled": True, "levels": [{"name": "far", "visibleEntityTypes": ["system"]}]},
        "projection": {"targetGranularityType": "table", "containerTypes": ["schema"],
                       "containmentEdgeTypes": ["BELONGS_TO"]},
        "referenceLayout": {
            "layers": [
                {
                    "id": "l1", "name": "Sources", "order": 0, "entityTypes": ["platform"],
                    "anchorUrn": "urn:anchor",
                    "scopeEdges": {"edgeTypes": ["HAS_CHILD"], "includeAll": True, "excludeEdgeTypes": ["SKIP"]},
                    "rules": [
                        {"id": "r1", "priority": 1, "urnPattern": "urn:exact-rule"},
                        {"id": "r2", "priority": 1, "urnPattern": "urn:li:*", "entityTypes": ["job"]},
                    ],
                    "logicalNodes": [{
                        "id": "ln1", "name": "Group", "type": "group",
                        "rules": [{"id": "r3", "priority": 1, "urnPattern": "urn:node-rule", "entityTypes": ["pipeline"]}],
                        "children": [{"id": "ln2", "name": "Child", "type": "group",
                                      "rules": [{"id": "r4", "priority": 1, "entityTypes": ["task"]}]}],
                    }],
                },
            ],
            "assignments": {
                "urn:a": {"layerId": "l1", "inheritsChildren": True},
                "urn:b": {"layerId": "l1", "inheritsChildren": True},
            },
            "displayRules": [{
                "id": "dr1", "name": "Near", "color": "#000", "enabled": True, "createdAt": "t",
                "predicate": {"kind": "group", "op": "and", "children": [
                    {"kind": "descendantOf", "urns": ["urn:pred-desc"]},
                    {"kind": "withinHops", "urns": ["urn:pred-hops"], "hops": 2, "edgeTypes": ["FEEDS"]},
                    {"kind": "path", "sourceUrns": ["urn:pred-src"], "targetUrns": ["urn:pred-dst"]},
                    {"kind": "entityType", "op": "in", "values": ["report"]},
                ]},
            }],
        },
    },
}


def test_collect_finds_every_location():
    refs = collect(GOLDEN)
    assert set(refs.urns) == {
        "urn:a", "urn:b", "urn:anchor", "urn:exact-rule", "urn:node-rule", "urn:root",
        "urn:pred-desc", "urn:pred-hops", "urn:pred-src", "urn:pred-dst",
    }
    assert refs.urns["urn:anchor"] == {"anchor"}
    assert refs.urns["urn:exact-rule"] == {"rule"}
    assert refs.urns["urn:root"] == {"root"}
    assert refs.urns["urn:pred-src"] == {"predicate"}
    assert refs.urn_patterns == {"urn:li:*"}
    assert refs.entity_types == {
        "domain", "dataset", "column", "dashboard", "system", "table", "schema", "platform",
        "job", "pipeline", "task", "report",
    }
    assert refs.relationship_types == {"CONTAINS", "PRODUCES", "BELONGS_TO", "HAS_CHILD", "SKIP", "FEEDS"}
    assert urns_of_kind(refs, "assignment") == ["urn:a", "urn:b"]


def test_rewrite_remaps_every_location_and_never_mutates_its_input():
    original = copy.deepcopy(GOLDEN)
    rw = Rewrite(
        urn_map={u: u + "-prod" for u in collect(GOLDEN).urns},
        type_map={t: t.upper() for t in collect(GOLDEN).entity_types},
        rel_type_map={t: t.lower() for t in collect(GOLDEN).relationship_types},
    )
    out = rewrite(GOLDEN, rw)
    assert GOLDEN == original
    refs = collect(out)
    assert set(refs.urns) == {u + "-prod" for u in collect(GOLDEN).urns}
    assert refs.entity_types == {t.upper() for t in collect(GOLDEN).entity_types}
    assert refs.relationship_types == {t.lower() for t in collect(GOLDEN).relationship_types}
    assert refs.urn_patterns == {"urn:li:*"}, "a glob names no single entity and is left alone"


def test_drop_removes_urns_but_never_empties_a_predicate():
    out = rewrite(GOLDEN, Rewrite(drop_urns={"urn:a", "urn:anchor", "urn:exact-rule", "urn:node-rule",
                                             "urn:root", "urn:pred-desc"}))
    rl = out["layout"]["referenceLayout"]
    assert set(rl["assignments"]) == {"urn:b"}
    assert "anchorUrn" not in rl["layers"][0]
    rule_ids = [r["id"] for r in rl["layers"][0]["rules"]]
    assert "r1" not in rule_ids, "the URN was the rule's only criterion, so the rule goes"
    node_rule = rl["layers"][0]["logicalNodes"][0]["rules"][0]
    assert "urnPattern" not in node_rule and node_rule["entityTypes"] == ["pipeline"], (
        "a rule with other criteria keeps them")
    assert out["content"]["rootUrns"] == []
    desc = rl["displayRules"][0]["predicate"]["children"][0]
    assert desc["urns"] == ["urn:pred-desc"], "predicates are remapped, never pruned"


def test_remap_onto_an_assigned_urn_keeps_the_existing_placement():
    out = rewrite(GOLDEN, Rewrite(urn_map={"urn:a": "urn:b"}))
    assignments = out["layout"]["referenceLayout"]["assignments"]
    assert set(assignments) == {"urn:b"}
    assert assignments["urn:b"] == GOLDEN["layout"]["referenceLayout"]["assignments"]["urn:b"]


def test_dropped_types_leave_every_list_and_the_granularity():
    out = rewrite(GOLDEN, Rewrite(drop_types={"domain", "table", "dashboard"}))
    assert out["content"]["visibleEntityTypes"] == ["dataset"]
    assert out["content"]["rootEntityTypes"] == []
    assert out["layout"]["projection"]["targetGranularityType"] is None
    assert "dashboard" not in out["entityOverrides"]


def test_type_remap_onto_an_existing_override_keeps_the_existing_one():
    definition = copy.deepcopy(GOLDEN)
    definition["entityOverrides"]["table"] = {"color": "#abc"}
    out = rewrite(definition, Rewrite(type_map={"dashboard": "table"}))
    assert out["entityOverrides"] == {"table": {"color": "#abc"}}


def test_empty_rewrite_is_a_copy():
    out = rewrite(GOLDEN, Rewrite())
    assert out == GOLDEN and out is not GOLDEN


def test_stats():
    stats = definition_stats(GOLDEN)
    assert stats == {
        "layers": 1, "assignments": 2, "anchors": 1, "rules": 4, "logicalNodes": 2,
        "displayRules": 1, "entityTypes": 12, "relationshipTypes": 6,
    }


def test_malformed_definitions_are_tolerated():
    for bad in (None, [], "x", {"layout": "x"}, {"layout": {"referenceLayout": {"layers": "x", "assignments": []}}}):
        refs = collect(bad)
        assert refs.urns == {} and refs.entity_types == set()
        assert isinstance(rewrite(bad, Rewrite(drop_urns={"u"})), dict)
        assert definition_stats(bad)["layers"] == 0
