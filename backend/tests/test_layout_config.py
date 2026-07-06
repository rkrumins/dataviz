"""Pure unit tests for backend.app.services.layout_config (no DB).

Mirrors the TS test cases in
frontend/src/utils/__tests__/referenceLayout.test.ts — keep the two in sync.
"""
from backend.app.services.layout_config import (
    derive_entity_scope,
    parse_reference_layout,
)


class TestParseReferenceLayout:
    def test_none_config_returns_empty(self):
        result = parse_reference_layout(None)
        assert result.layers == []
        assert result.assignments == {}

    def test_malformed_config_returns_empty(self):
        result = parse_reference_layout({"layout": "not a dict"})
        assert result.layers == []
        assert result.assignments == {}

    def test_missing_reference_layout_returns_empty(self):
        result = parse_reference_layout({"content": {}, "filters": {}})
        assert result.layers == []
        assert result.assignments == {}

    def test_canonical_nested_location(self):
        config = {
            "layout": {
                "referenceLayout": {
                    "layers": [{"id": "l1", "name": "Layer 1", "entityTypes": [], "order": 0}],
                    "assignments": {"urn:canonical": {"layerId": "l1", "inheritsChildren": True, "assignedBy": "user"}},
                }
            }
        }
        result = parse_reference_layout(config)
        assert result.assignments == {"urn:canonical": {"layerId": "l1", "inheritsChildren": True, "assignedBy": "user"}}
        assert result.layers == [{"id": "l1", "name": "Layer 1", "entityTypes": [], "order": 0}]

    def test_legacy_top_level_spelling_fallback(self):
        # No config["layout"]["referenceLayout"] — falls back to the legacy
        # top-level config["referenceLayout"] spelling view_scope.py still reads.
        config = {
            "referenceLayout": {
                "layers": [{"id": "l1", "name": "Layer 1", "entityTypes": [], "order": 0}],
                "assignments": {"urn:legacy-spot": {"layerId": "l1", "inheritsChildren": True}},
            }
        }
        result = parse_reference_layout(config)
        assert result.assignments == {"urn:legacy-spot": {"layerId": "l1", "inheritsChildren": True}}

    def test_nested_location_wins_over_legacy_top_level(self):
        config = {
            "layout": {"referenceLayout": {"layers": [], "assignments": {"urn:nested": {"layerId": "l1", "inheritsChildren": True}}}},
            "referenceLayout": {"layers": [], "assignments": {"urn:top-level": {"layerId": "l1", "inheritsChildren": True}}},
        }
        result = parse_reference_layout(config)
        assert "urn:nested" in result.assignments
        assert "urn:top-level" not in result.assignments

    def test_up_converts_entity_assignments_keyed_by_urn(self):
        config = {
            "layout": {"referenceLayout": {"layers": [{
                "id": "l1", "name": "L", "entityTypes": [], "order": 0,
                "entityAssignments": [
                    {"urn": "urn:x", "layerId": "l1", "inheritsChildren": False, "priority": 999,
                     "assignedBy": "user", "assignedAt": "2026-01-01"},
                ],
            }]}}
        }
        result = parse_reference_layout(config)
        assert result.assignments["urn:x"] == {
            "layerId": "l1",
            "logicalNodeId": None,
            "inheritsChildren": False,
            "assignedBy": "user",
            "assignedAt": "2026-01-01",
        }
        assert "priority" not in result.assignments["urn:x"]
        assert "entityAssignments" not in result.layers[0]

    def test_up_converts_entity_assignments_keyed_by_entity_id_when_urn_absent(self):
        config = {
            "layout": {"referenceLayout": {"layers": [{
                "id": "l1", "name": "L", "entityTypes": [], "order": 0,
                "entityAssignments": [{"entityId": "urn:by-entity-id", "layerId": "l1", "priority": 500}],
            }]}}
        }
        result = parse_reference_layout(config)
        assert result.assignments["urn:by-entity-id"]["layerId"] == "l1"
        assert result.assignments["urn:by-entity-id"]["inheritsChildren"] is True  # defaulted

    def test_converts_exact_urn_layer_rules(self):
        config = {
            "layout": {"referenceLayout": {"layers": [{
                "id": "l1", "name": "L", "entityTypes": [], "order": 0,
                "rules": [{"id": "r1", "urnPattern": "urn:exact:1", "priority": 100}],
            }]}}
        }
        result = parse_reference_layout(config)
        assert result.assignments["urn:exact:1"] == {
            "layerId": "l1", "inheritsChildren": True, "assignedBy": "rule",
        }

    def test_converts_exact_urn_logical_node_rules_tagging_logical_node_id(self):
        config = {
            "layout": {"referenceLayout": {"layers": [{
                "id": "l1", "name": "L", "entityTypes": [], "order": 0,
                "logicalNodes": [{
                    "id": "ln1", "name": "LN", "type": "container",
                    "rules": [{"id": "r1", "urnPattern": "urn:exact:2"}],
                }],
            }]}}
        }
        result = parse_reference_layout(config)
        assert result.assignments["urn:exact:2"] == {
            "layerId": "l1", "logicalNodeId": "ln1", "inheritsChildren": True, "assignedBy": "rule",
        }

    def test_converts_exact_urn_rule_on_nested_child_logical_node(self):
        config = {
            "layout": {"referenceLayout": {"layers": [{
                "id": "l1", "name": "L", "entityTypes": [], "order": 0,
                "logicalNodes": [{
                    "id": "ln1", "name": "LN", "type": "container",
                    "children": [{
                        "id": "ln1a", "name": "Child", "type": "container",
                        "children": [{
                            "id": "ln1a-i", "name": "Grandchild", "type": "group",
                            "rules": [{"id": "r1", "urnPattern": "urn:nested:1"}],
                        }],
                    }],
                }],
            }]}}
        }
        result = parse_reference_layout(config)
        assert result.assignments["urn:nested:1"] == {
            "layerId": "l1", "logicalNodeId": "ln1a-i", "inheritsChildren": True, "assignedBy": "rule",
        }

    def test_glob_rule_on_nested_child_logical_node_not_converted(self):
        config = {
            "layout": {"referenceLayout": {"layers": [{
                "id": "l1", "name": "L", "entityTypes": [], "order": 0,
                "logicalNodes": [{
                    "id": "ln1", "name": "LN", "type": "container",
                    "children": [{
                        "id": "ln1a", "name": "Child", "type": "container",
                        "rules": [{"id": "r1", "urnPattern": "urn:nested:*"}],
                    }],
                }],
            }]}}
        }
        result = parse_reference_layout(config)
        assert result.assignments == {}

    def test_collision_parent_rule_beats_nested_child_rule(self):
        config = {
            "layout": {"referenceLayout": {"layers": [{
                "id": "l1", "name": "L", "entityTypes": [], "order": 0,
                "logicalNodes": [{
                    "id": "ln-parent", "name": "Parent", "type": "container",
                    "rules": [{"id": "r1", "urnPattern": "urn:shared"}],
                    "children": [{
                        "id": "ln-child", "name": "Child", "type": "container",
                        "rules": [{"id": "r2", "urnPattern": "urn:shared"}],
                    }],
                }],
            }]}}
        }
        result = parse_reference_layout(config)
        assert result.assignments["urn:shared"]["logicalNodeId"] == "ln-parent"

    def test_glob_rules_not_converted(self):
        config = {
            "layout": {"referenceLayout": {"layers": [{
                "id": "l1", "name": "L", "entityTypes": [], "order": 0,
                "rules": [
                    {"id": "r1", "urnPattern": "urn:*:sales"},
                    {"id": "r2", "urnPattern": "urn:x?y"},
                ],
            }]}}
        }
        result = parse_reference_layout(config)
        assert result.assignments == {}
        assert len(result.layers[0]["rules"]) == 2

    def test_collision_precedence_top_level_beats_entity_assignments_beats_rules(self):
        config = {
            "layout": {"referenceLayout": {
                "layers": [{
                    "id": "l1", "name": "L", "entityTypes": [], "order": 0,
                    "entityAssignments": [{"urn": "urn:same", "layerId": "l1", "inheritsChildren": True, "priority": 1000}],
                    "rules": [{"id": "r1", "urnPattern": "urn:same"}],
                }],
                "assignments": {"urn:same": {"layerId": "TOP", "inheritsChildren": True, "assignedBy": "user"}},
            }}
        }
        result = parse_reference_layout(config)
        assert result.assignments["urn:same"]["layerId"] == "TOP"

    def test_collision_precedence_entity_assignments_beats_rules(self):
        config = {
            "layout": {"referenceLayout": {"layers": [{
                "id": "l1", "name": "L", "entityTypes": [], "order": 0,
                "entityAssignments": [{"urn": "urn:same2", "layerId": "l1", "inheritsChildren": True, "priority": 1000, "assignedBy": "user"}],
                "rules": [{"id": "r1", "urnPattern": "urn:same2"}],
            }]}}
        }
        result = parse_reference_layout(config)
        assert result.assignments["urn:same2"]["assignedBy"] == "user"

    def test_never_mutates_input(self):
        config = {
            "layout": {"referenceLayout": {"layers": [{
                "id": "l1", "name": "L", "entityTypes": [], "order": 0,
                "entityAssignments": [{"entityId": "urn:a", "layerId": "l1", "inheritsChildren": True, "priority": 1}],
            }]}}
        }
        import copy
        snapshot = copy.deepcopy(config)
        parse_reference_layout(config)
        assert config == snapshot


class TestDeriveEntityScope:
    def test_explicit_scope_wins(self):
        config = {
            "content": {"entityScope": "all"},
            "layout": {"referenceLayout": {"layers": [], "assignments": {"urn:a": {"layerId": "l1", "inheritsChildren": True}}}},
        }
        assert derive_entity_scope(config) == "all"

    def test_derives_curated_when_assignments_non_empty(self):
        config = {
            "layout": {"referenceLayout": {"layers": [], "assignments": {"urn:a": {"layerId": "l1", "inheritsChildren": True}}}},
        }
        assert derive_entity_scope(config) == "curated"

    def test_derives_all_when_assignments_empty(self):
        config = {"layout": {"referenceLayout": {"layers": [], "assignments": {}}}}
        assert derive_entity_scope(config) == "all"

    def test_none_config_derives_all(self):
        assert derive_entity_scope(None) == "all"
