"""The portable definition of a view, and the hash that proves a round-trip lost nothing."""
from __future__ import annotations

import json
import random

from backend.app.services.view_transfer.canonical import (
    canonical_json,
    config_from_definition,
    content_hash,
    portable_definition,
)


def _config(**extra):
    config = {
        "icon": "Layout",
        "content": {"visibleEntityTypes": ["domain"], "visibleRelationshipTypes": ["CONTAINS"],
                    "defaultDepth": 5, "maxDepth": 10, "rootEntityTypes": ["domain"],
                    "entityScope": "curated"},
        "layout": {
            "type": "reference",
            "lod": {"enabled": False, "levels": []},
            "referenceLayout": {
                "layers": [{"id": "l1", "name": "Sources", "entityTypes": ["system"], "order": 0}],
                "assignments": {"urn:a": {"layerId": "l1", "inheritsChildren": True, "assignedBy": "user"}},
                "displayRules": [{"id": "dr1", "name": "PII", "color": "#f00", "predicate": {"kind": "tag", "values": ["pii"]}, "enabled": True, "createdAt": "2026-01-01"}],
                "defaultNodeSortMode": "alpha-desc",
            },
        },
        "filters": {"entityTypeFilters": [], "fieldFilters": [], "searchableFields": [], "quickFilters": []},
        "entityOverrides": {"domain": {"color": "#123456"}},
    }
    config.update(extra)
    return config


def test_environment_and_label_keys_never_travel():
    config = _config(id="view_1", workspaceId="ws_1", dataSourceId="ds_1", scopeKey="ws_1/ds_1",
                     workspaceName="Finance", isFavourited=True, visibility="enterprise",
                     isPublic=True, createdBy="usr_1", createdAt="t", updatedAt="t",
                     name="Named", description="Described", tags=["x"], contextModelId="cm_1")
    definition = portable_definition(config, "reference")
    for key in ("id", "workspaceId", "dataSourceId", "scopeKey", "workspaceName", "isFavourited",
                "visibility", "isPublic", "createdBy", "createdAt", "updatedAt", "name",
                "description", "tags", "icon", "contextModelId"):
        assert key not in definition, key


def test_everything_else_is_kept_verbatim_including_unknown_keys():
    config = _config(grouping={"enabled": True, "groupByField": "owner"}, futureKey={"a": [1, 2]})
    definition = portable_definition(config, "reference")
    assert definition["grouping"] == {"enabled": True, "groupByField": "owner"}
    assert definition["futureKey"] == {"a": [1, 2]}
    assert definition["entityOverrides"] == {"domain": {"color": "#123456"}}
    rl = definition["layout"]["referenceLayout"]
    assert rl["displayRules"][0]["id"] == "dr1"
    assert rl["defaultNodeSortMode"] == "alpha-desc"


def test_legacy_layout_is_up_converted_and_moved_under_layout():
    config = {
        "referenceLayout": {
            "layers": [{
                "id": "l1", "name": "L", "entityTypes": [], "order": 0,
                "entityAssignments": [{"entityId": "urn:legacy", "layerId": "l1", "inheritsChildren": True, "priority": 1000}],
                "rules": [{"id": "r1", "urnPattern": "urn:exact", "priority": 1}],
            }],
        },
    }
    definition = portable_definition(config, "reference")
    assert "referenceLayout" not in definition
    rl = definition["layout"]["referenceLayout"]
    assert set(rl["assignments"]) == {"urn:legacy", "urn:exact"}
    assert "entityAssignments" not in rl["layers"][0]
    # None-valued fields from the up-convert mean "absent" and are dropped, so the backend's
    # normaliser and the browser's hash the same view identically.
    assert "logicalNodeId" not in rl["assignments"]["urn:legacy"]
    assert "assignedAt" not in rl["assignments"]["urn:legacy"]


def test_staged_temporary_urns_never_travel():
    config = _config()
    config["layout"]["referenceLayout"]["assignments"]["urn:staged:abc"] = {"layerId": "l1", "inheritsChildren": True}
    definition = portable_definition(config, "reference")
    assert "urn:staged:abc" not in definition["layout"]["referenceLayout"]["assignments"]


def test_entity_scope_and_layout_type_are_made_explicit():
    definition = portable_definition({"layout": {"referenceLayout": {"layers": [], "assignments": {"urn:x": {"layerId": "l"}}}}}, "reference")
    assert definition["content"]["entityScope"] == "curated"
    assert definition["layout"]["type"] == "reference"
    empty = portable_definition({}, "graph")
    assert empty["content"]["entityScope"] == "all"
    assert empty["layout"]["type"] == "graph"


def test_input_is_never_mutated():
    config = _config()
    before = json.dumps(config, sort_keys=True)
    portable_definition(config, "reference")
    assert json.dumps(config, sort_keys=True) == before


def test_hash_ignores_key_order_and_formatting():
    a = _config()
    b = json.loads(json.dumps(a, sort_keys=True, indent=4))
    b = {k: b[k] for k in reversed(list(b))}
    assert content_hash(portable_definition(a, "reference")) == content_hash(portable_definition(b, "reference"))


def test_hash_changes_with_the_design_but_not_the_label():
    base = portable_definition(_config(), "reference")
    renamed = portable_definition(_config(name="Other", description="Else", tags=["t"], icon="Star"), "reference")
    assert content_hash(base) == content_hash(renamed)
    moved = _config()
    moved["layout"]["referenceLayout"]["assignments"]["urn:a"]["layerId"] = "l2"
    moved["layout"]["referenceLayout"]["layers"].append({"id": "l2", "name": "Marts", "entityTypes": [], "order": 1})
    assert content_hash(base) != content_hash(portable_definition(moved, "reference"))


def test_hash_format():
    h = content_hash({"a": 1})
    assert h.startswith("sha256:") and len(h) == len("sha256:") + 64


def test_config_from_definition_restores_the_icon_only():
    definition = portable_definition(_config(), "reference")
    config = config_from_definition(definition, icon="Star")
    assert config["icon"] == "Star"
    assert portable_definition(config, "reference") == definition


def _random_value(rng: random.Random, depth: int):
    kind = rng.randrange(6 if depth < 3 else 4)
    if kind == 0:
        return rng.randrange(-5, 1000)
    if kind == 1:
        return rng.choice(["", "urn:li:x", "Ünïcødé ✓", "a,b\"c", "=SUM(A1)"])
    if kind == 2:
        return rng.choice([True, False, None])
    if kind == 3:
        return rng.random()
    if kind == 4:
        return [_random_value(rng, depth + 1) for _ in range(rng.randrange(4))]
    return {f"k{rng.randrange(20)}": _random_value(rng, depth + 1) for _ in range(rng.randrange(4))}


def _random_config(rng: random.Random) -> dict:
    layers = [{"id": f"l{i}", "name": f"Layer {i}", "entityTypes": ["t"], "order": i,
               "extra": _random_value(rng, 1)} for i in range(rng.randrange(1, 4))]
    assignments = {
        f"urn:{rng.randrange(10_000)}": {
            "layerId": rng.choice(layers)["id"], "inheritsChildren": rng.choice([True, False]),
            "assignedBy": rng.choice(["user", "rule", None]),
            "orderKey": rng.choice([None, "a0", "a1"]),
        }
        for _ in range(rng.randrange(8))
    }
    config = {
        "layout": {"type": "reference", "referenceLayout": {"layers": layers, "assignments": assignments,
                                                            "sideField": _random_value(rng, 1)}},
        "content": {"visibleEntityTypes": ["t"], "entityScope": rng.choice(["all", "curated", None])},
        "random": _random_value(rng, 0),
    }
    if rng.random() < 0.5:
        config["id"] = "view_x"
        config["name"] = "n"
    return config


def test_canonicalising_is_idempotent_and_order_independent_for_random_configs():
    rng = random.Random(20260923)
    for _ in range(300):
        config = _random_config(rng)
        once = portable_definition(config, "reference")
        twice = portable_definition(once, "reference")
        assert once == twice
        assert canonical_json(once) == canonical_json(twice)
        shuffled = json.loads(json.dumps(config))
        items = list(shuffled.items())
        rng.shuffle(items)
        assert content_hash(portable_definition(dict(items), "reference")) == content_hash(once)
