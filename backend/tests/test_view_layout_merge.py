"""Pure unit tests for the Task-6 data-migration merge helper
(``backend.app.db.migrations_support.view_layout_merge``). No DB.

The helper folds a context-model instance's layer state (``cm_layers`` =
``layers_config``, ``cm_assignments`` = ``instance_assignments``) into a
view's config, producing the canonical shape:
``config.layout.referenceLayout = {layers, assignments}`` with an explicit
``content.entityScope`` and no legacy per-layer ``entityAssignments``.
"""
import copy

from backend.app.db.migrations_support.view_layout_merge import merge_view_layout


def _ref(config):
    return config["layout"]["referenceLayout"]


class TestNoReferenceLayout:
    def test_missing_reference_layout_is_untouched(self):
        config = {"content": {"maxDepth": 5}, "filters": {}}
        result = merge_view_layout(config, cm_layers=[{"id": "l1"}], cm_assignments={"urn:a": {"layerId": "l1"}})
        # Rows without any referenceLayout are left exactly as-is — cm inputs ignored.
        assert result is config
        assert "entityScope" not in config["content"]

    def test_non_dict_config_returned_as_is(self):
        assert merge_view_layout(None, None, None) is None


class TestNormalizeOnly:
    def test_strips_entity_assignments_and_builds_assignment_map(self):
        config = {
            "content": {},
            "layout": {"referenceLayout": {"layers": [
                {"id": "l1", "name": "Source", "order": 0, "entityAssignments": [
                    {"entityId": "urn:a", "layerId": "l1", "priority": 1000,
                     "assignedBy": "user", "inheritsChildren": True},
                ]},
            ]}},
        }
        result = merge_view_layout(config, cm_layers=None, cm_assignments=None)
        layers = _ref(result)["layers"]
        assert "entityAssignments" not in layers[0]
        assert layers[0]["name"] == "Source"
        assert _ref(result)["assignments"]["urn:a"]["layerId"] == "l1"
        # priority is dropped in the canonical assignment shape
        assert "priority" not in _ref(result)["assignments"]["urn:a"]
        assert result["content"]["entityScope"] == "curated"


class TestCmAssignmentsWin:
    def test_cm_wins_per_urn_but_non_conflicting_survive(self):
        config = {
            "content": {},
            "layout": {"referenceLayout": {"layers": [
                {"id": "l1", "entityAssignments": [
                    {"entityId": "urn:a", "layerId": "l1", "inheritsChildren": True},
                    {"entityId": "urn:keepme", "layerId": "l1", "inheritsChildren": True},
                ]},
            ]}},
        }
        cm_assignments = {
            "urn:a": {"layerId": "l2", "assignedBy": "user", "logicalNodeId": None, "inheritsChildren": True},
            "urn:cmonly": {"layerId": "l3", "assignedBy": "user", "logicalNodeId": None, "inheritsChildren": True},
        }
        result = merge_view_layout(config, cm_layers=None, cm_assignments=cm_assignments)
        a = _ref(result)["assignments"]
        assert a["urn:a"]["layerId"] == "l2"          # cm wins the conflict
        assert a["urn:keepme"]["layerId"] == "l1"     # step-1-only survives
        assert a["urn:cmonly"]["layerId"] == "l3"     # cm-only added


class TestCmLayerMerge:
    def test_cm_wins_fields_cm_only_included_view_only_appended_renumbered(self):
        config = {
            "content": {},
            "layout": {"referenceLayout": {"layers": [
                {"id": "l1", "name": "Old", "color": "#111", "order": 0},
                {"id": "l3", "name": "ViewOnly", "order": 1},
            ]}},
        }
        cm_layers = [
            {"id": "l1", "name": "New", "order": 0},      # conflicting field: cm name wins
            {"id": "l2", "name": "CmOnly", "order": 1},   # cm-only layer
        ]
        result = merge_view_layout(config, cm_layers=cm_layers, cm_assignments=None)
        layers = _ref(result)["layers"]
        assert [l["id"] for l in layers] == ["l1", "l2", "l3"]   # cm order first, view-only appended
        assert layers[0]["name"] == "New"                        # cm wins conflicting field
        assert layers[0]["color"] == "#111"                      # view-only field preserved
        assert [l["order"] for l in layers] == [0, 1, 2]         # renumbered 0..n-1


class TestRuleConversion:
    def test_exact_urn_rule_converted_and_removed_glob_kept(self):
        config = {
            "content": {},
            "layout": {"referenceLayout": {"layers": [
                {"id": "l1", "rules": [
                    {"urnPattern": "urn:exact:one"},
                    {"urnPattern": "urn:glob:*"},
                ]},
            ]}},
        }
        result = merge_view_layout(config, cm_layers=None, cm_assignments=None)
        a = _ref(result)["assignments"]
        assert a["urn:exact:one"] == {"layerId": "l1", "inheritsChildren": True, "assignedBy": "rule"}
        layer_rules = _ref(result)["layers"][0]["rules"]
        assert layer_rules == [{"urnPattern": "urn:glob:*"}]      # glob kept, exact removed

    def test_only_exact_rules_drops_the_rules_key(self):
        config = {
            "content": {},
            "layout": {"referenceLayout": {"layers": [
                {"id": "l1", "rules": [{"urnPattern": "urn:exact:one"}]},
            ]}},
        }
        result = merge_view_layout(config, cm_layers=None, cm_assignments=None)
        assert "rules" not in _ref(result)["layers"][0]

    def test_nested_child_logical_node_rule_converted_and_removed(self):
        config = {
            "content": {},
            "layout": {"referenceLayout": {"layers": [
                {"id": "l1", "logicalNodes": [
                    {"id": "n1", "children": [
                        {"id": "n2", "rules": [
                            {"urnPattern": "urn:nested:exact"},
                            {"urnPattern": "urn:nested:*"},
                        ]},
                    ]},
                ]},
            ]}},
        }
        result = merge_view_layout(config, cm_layers=None, cm_assignments=None)
        a = _ref(result)["assignments"]
        assert a["urn:nested:exact"] == {
            "layerId": "l1", "logicalNodeId": "n2", "inheritsChildren": True, "assignedBy": "rule",
        }
        # exact rule stripped from the nested node; glob rule survives
        n2 = _ref(result)["layers"][0]["logicalNodes"][0]["children"][0]
        assert n2["rules"] == [{"urnPattern": "urn:nested:*"}]


class TestEntityScope:
    def test_explicit_scope_preserved_even_with_assignments(self):
        config = {
            "content": {"entityScope": "all"},
            "layout": {"referenceLayout": {"layers": [
                {"id": "l1", "entityAssignments": [{"entityId": "urn:a", "layerId": "l1"}]},
            ]}},
        }
        result = merge_view_layout(config, cm_layers=None, cm_assignments=None)
        assert result["content"]["entityScope"] == "all"

    def test_derived_curated_when_assignments_present(self):
        config = {"content": {}, "layout": {"referenceLayout": {"layers": [
            {"id": "l1", "entityAssignments": [{"entityId": "urn:a", "layerId": "l1"}]},
        ]}}}
        result = merge_view_layout(config, None, None)
        assert result["content"]["entityScope"] == "curated"

    def test_derived_all_when_no_assignments(self):
        config = {"content": {}, "layout": {"referenceLayout": {"layers": [{"id": "l1"}]}}}
        result = merge_view_layout(config, None, None)
        assert result["content"]["entityScope"] == "all"

    def test_creates_content_when_absent(self):
        config = {"layout": {"referenceLayout": {"layers": [
            {"id": "l1", "entityAssignments": [{"entityId": "urn:a", "layerId": "l1"}]},
        ]}}}
        result = merge_view_layout(config, None, None)
        assert result["content"]["entityScope"] == "curated"


class TestLegacyLocation:
    def test_legacy_top_level_migrated_to_nested_and_removed(self):
        config = {
            "content": {},
            "referenceLayout": {"layers": [
                {"id": "l1", "entityAssignments": [{"entityId": "urn:a", "layerId": "l1"}]},
            ]},
        }
        result = merge_view_layout(config, None, None)
        assert "referenceLayout" not in result           # legacy top-level dropped
        assert _ref(result)["assignments"]["urn:a"]["layerId"] == "l1"
        assert result["content"]["entityScope"] == "curated"


class TestIdempotency:
    def test_run_twice_equals_run_once(self):
        config = {
            "content": {"maxDepth": 5},
            "layout": {"referenceLayout": {"layers": [
                {"id": "l1", "name": "Old", "color": "#111", "order": 0, "entityAssignments": [
                    {"entityId": "urn:a", "layerId": "l1", "inheritsChildren": True},
                    {"entityId": "urn:keepme", "layerId": "l1", "inheritsChildren": True},
                ]},
                {"id": "l3", "name": "ViewOnly", "order": 1},
            ]}},
        }
        cm_layers = [
            {"id": "l1", "name": "New", "order": 0, "entityAssignments": [
                {"entityId": "urn:zzz", "layerId": "l1"}]},
            {"id": "l2", "name": "CmOnly", "order": 1},
        ]
        cm_assignments = {"urn:a": {"layerId": "l2", "assignedBy": "user", "logicalNodeId": None, "inheritsChildren": True}}
        once = merge_view_layout(config, cm_layers, cm_assignments)
        # Second pass simulates a re-run after instance cm rows are gone.
        twice = merge_view_layout(copy.deepcopy(once), None, None)
        assert twice == once


class TestNoMutation:
    def test_inputs_are_not_mutated(self):
        config = {"content": {}, "layout": {"referenceLayout": {"layers": [
            {"id": "l1", "entityAssignments": [{"entityId": "urn:a", "layerId": "l1", "inheritsChildren": True}]},
        ]}}}
        cm_layers = [{"id": "l1", "name": "New", "order": 0}]
        cm_assignments = {"urn:a": {"layerId": "l2"}}
        config_before = copy.deepcopy(config)
        cm_layers_before = copy.deepcopy(cm_layers)
        cm_assignments_before = copy.deepcopy(cm_assignments)
        merge_view_layout(config, cm_layers, cm_assignments)
        assert config == config_before
        assert cm_layers == cm_layers_before
        assert cm_assignments == cm_assignments_before
