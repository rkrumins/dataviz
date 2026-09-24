"""``build_subset_config`` — a subset's config, built from its source's.

The one property everything else serves: re-reading the subset's config the
way every reader does (``parse_reference_layout``) yields EXACTLY the picked
entities — nothing the source held comes back through a rule, an anchor, a
group or a legacy spelling.
"""
from __future__ import annotations

import pytest

from backend.app.services.layout_config import derive_entity_scope, parse_reference_layout
from backend.app.services.view_subset import SubsetConfigError, SubsetMember, build_subset_config

NOW = "2026-09-24T10:00:00+00:00"
BRIDGED = {"mode": "bridged", "maxHops": 8}


def _source() -> dict:
    return {
        "icon": "Layers",
        "content": {
            "visibleEntityTypes": ["table", "column"],
            "entityScope": "curated",
            "rootUrns": ["urn:everything"],
        },
        "filters": {"entityTypeFilters": [], "fieldFilters": [{"field": "owner"}]},
        "entityOverrides": {"table": {"color": "#123456"}},
        "layout": {
            "type": "reference",
            "lod": {"enabled": False, "levels": []},
            "referenceLayout": {
                "layers": [
                    {
                        "id": "raw", "name": "Raw", "order": 0, "color": "#111", "width": 320,
                        "entityTypes": ["table"],
                        "rules": [
                            {"id": "r-exact", "urnPattern": "urn:exact:unpicked", "priority": 1},
                            {"id": "r-glob", "urnPattern": "urn:glob:*", "priority": 2},
                        ],
                        "anchorUrn": "urn:A",
                    },
                    {
                        "id": "staging", "name": "Staging", "order": 1, "nodeSortMode": "custom",
                        "logicalNodes": [
                            {"id": "g-parent", "name": "Parent", "type": "group", "children": [
                                {"id": "g-child", "name": "Child", "type": "group",
                                 "rules": [{"id": "gr", "urnPattern": "urn:exact:in-group", "priority": 1}]},
                            ]},
                            {"id": "g-other", "name": "Other", "type": "group"},
                        ],
                    },
                    {"id": "marts", "name": "Marts", "order": 2},
                ],
                "assignments": {
                    "urn:A": {"layerId": "raw", "inheritsChildren": True},
                    "urn:B": {"layerId": "staging", "inheritsChildren": True, "orderKey": "a0"},
                    "urn:C": {"layerId": "staging", "logicalNodeId": "g-child", "inheritsChildren": True},
                    "urn:D": {"layerId": "marts", "inheritsChildren": True},
                },
                "displayRules": [{"id": "dr", "tag": "pii"}],
                "defaultNodeSortMode": "alpha-desc",
            },
        },
    }


def _build(members, source=None):
    return build_subset_config(source or _source(), members, connectivity=BRIDGED, now=NOW)


def test_rereading_the_subset_yields_exactly_the_picks():
    out = _build([
        SubsetMember("urn:A", "raw"),
        SubsetMember("urn:C", "staging", "g-child"),
    ])
    layout = parse_reference_layout(out)
    assert set(layout.assignments) == {"urn:A", "urn:C"}     # no urn:exact:*, no urn:B/D


def test_exact_urn_rules_are_stripped_and_globs_kept():
    out = _build([SubsetMember("urn:A", "raw"), SubsetMember("urn:C", "staging", "g-child")])
    raw, staging = out["layout"]["referenceLayout"]["layers"]
    assert [r["id"] for r in raw["rules"]] == ["r-glob"]
    child = staging["logicalNodes"][0]["children"][0]
    assert child["rules"] == []


def test_layers_are_pruned_to_the_picks_in_source_order():
    out = _build([SubsetMember("urn:D", "marts"), SubsetMember("urn:A", "raw")])
    layers = out["layout"]["referenceLayout"]["layers"]
    assert [l["id"] for l in layers] == ["raw", "marts"]
    assert layers[0]["width"] == 320 and layers[0]["color"] == "#111"


def test_groups_keep_what_was_picked_into_them_and_their_ancestors():
    out = _build([SubsetMember("urn:C", "staging", "g-child")])
    (staging,) = out["layout"]["referenceLayout"]["layers"]
    assert [g["id"] for g in staging["logicalNodes"]] == ["g-parent"]
    assert [g["id"] for g in staging["logicalNodes"][0]["children"]] == ["g-child"]


def test_an_anchor_survives_only_when_it_was_kept_with_its_contents():
    kept = _build([SubsetMember("urn:A", "raw")])
    assert kept["layout"]["referenceLayout"]["layers"][0]["anchorUrn"] == "urn:A"
    shallow = _build([SubsetMember("urn:A", "raw", inherits_children=False)])
    assert "anchorUrn" not in shallow["layout"]["referenceLayout"]["layers"][0]
    elsewhere = _build([SubsetMember("urn:X", "raw")])
    assert "anchorUrn" not in elsewhere["layout"]["referenceLayout"]["layers"][0]


def test_assignments_are_rebuilt_from_the_picks():
    out = _build([
        SubsetMember("urn:B", "staging"),            # same layer as the source: order kept
        SubsetMember("urn:A", "marts"),              # moved: no order carried
        SubsetMember("urn:Z", "raw", inherits_children=False),   # from outside the source
    ])
    assignments = out["layout"]["referenceLayout"]["assignments"]
    assert assignments["urn:B"] == {
        "layerId": "staging", "inheritsChildren": True, "assignedBy": "user",
        "assignedAt": NOW, "orderKey": "a0",
    }
    assert "orderKey" not in assignments["urn:A"]
    assert assignments["urn:Z"]["inheritsChildren"] is False


def test_the_scope_is_curated_the_connectivity_set_and_search_not_widened():
    out = _build([SubsetMember("urn:A", "raw")], source={**_source(), "content": {"visibleEntityTypes": ["table"]}})
    assert out["content"]["entityScope"] == "curated"
    assert derive_entity_scope(out) == "curated"
    assert out["content"]["connectivity"] == {"mode": "bridged", "maxHops": 8}
    assert "rootUrns" not in _build([SubsetMember("urn:A", "raw")])["content"]


def test_display_settings_come_with_it():
    out = _build([SubsetMember("urn:A", "raw")])
    ref = out["layout"]["referenceLayout"]
    assert ref["displayRules"] == [{"id": "dr", "tag": "pii"}]
    assert ref["defaultNodeSortMode"] == "alpha-desc"
    assert out["filters"]["fieldFilters"] == [{"field": "owner"}]
    assert out["entityOverrides"] == {"table": {"color": "#123456"}}
    assert out["layout"]["type"] == "reference" and out["icon"] == "Layers"


def test_a_legacy_top_level_layout_is_read_and_not_carried():
    source = _source()
    legacy = source["layout"].pop("referenceLayout")
    source["referenceLayout"] = legacy
    out = _build([SubsetMember("urn:A", "raw")], source=source)
    assert "referenceLayout" not in out
    assert set(parse_reference_layout(out).assignments) == {"urn:A"}


def test_the_source_config_is_not_mutated():
    source = _source()
    before = repr(source)
    _build([SubsetMember("urn:A", "raw")], source=source)
    assert repr(source) == before


def test_duplicate_picks_collapse_first_wins():
    out = _build([SubsetMember("urn:A", "raw"), SubsetMember("urn:A", "marts")])
    assert out["layout"]["referenceLayout"]["assignments"]["urn:A"]["layerId"] == "raw"


@pytest.mark.parametrize("members, message", [
    ([SubsetMember("urn:A", "gone")], "no layer"),
    ([SubsetMember("urn:C", "staging", "g-gone")], "no group"),
    ([], "at least one"),
])
def test_picks_that_do_not_fit_the_source_are_refused(members, message):
    with pytest.raises(SubsetConfigError, match=message):
        _build(members)
