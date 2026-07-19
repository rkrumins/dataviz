"""Pure unit tests for the write-side node-ordering sanitation
(``backend.app.services.layout_config.sanitize_node_ordering``): invalid
``defaultNodeSortMode`` / ``nodeSortMode`` / ``orderKey`` values are DROPPED
(never rejected — pre-existing junk must not block an unrelated save), valid
layouts pass through by identity, and the input is never mutated.
"""
import copy

from backend.app.services.layout_config import (
    MAX_ORDER_KEY_LEN,
    sanitize_node_ordering,
)


def _layout(**overrides):
    base = {
        "layers": [
            {"id": "l1", "name": "L1", "order": 0, "nodeSortMode": "custom"},
            {"id": "l2", "name": "L2", "order": 1},
        ],
        "assignments": {
            "urn:a": {"layerId": "l1", "inheritsChildren": True, "orderKey": "a1"},
            "urn:b": {"layerId": "l2", "inheritsChildren": True},
        },
        "defaultNodeSortMode": "alpha-desc",
        "displayRules": [{"id": "r1"}],
    }
    base.update(overrides)
    return base


class TestPassThrough:
    def test_valid_layout_returns_same_object(self):
        layout = _layout()
        assert sanitize_node_ordering(layout) is layout

    def test_all_valid_modes_accepted(self):
        for mode in ("alpha-asc", "alpha-desc", "type-asc", "count-desc", "custom"):
            layout = _layout(layers=[{"id": "l1", "nodeSortMode": mode}])
            assert sanitize_node_ordering(layout) is layout

    def test_non_dict_input_passes_through(self):
        assert sanitize_node_ordering(None) is None  # type: ignore[arg-type]


class TestDropsInvalid:
    def test_invalid_default_mode_dropped(self):
        out = sanitize_node_ordering(_layout(defaultNodeSortMode="sideways"))
        assert "defaultNodeSortMode" not in out

    def test_custom_cannot_be_the_view_default(self):
        out = sanitize_node_ordering(_layout(defaultNodeSortMode="custom"))
        assert "defaultNodeSortMode" not in out

    def test_invalid_layer_mode_dropped_others_kept(self):
        layout = _layout(layers=[
            {"id": "l1", "nodeSortMode": "bogus"},
            {"id": "l2", "nodeSortMode": "alpha-desc"},
        ])
        out = sanitize_node_ordering(layout)
        assert "nodeSortMode" not in out["layers"][0]
        assert out["layers"][1]["nodeSortMode"] == "alpha-desc"

    def test_bad_order_keys_dropped_good_kept(self):
        layout = _layout(assignments={
            "urn:num": {"layerId": "l1", "orderKey": 42},
            "urn:empty": {"layerId": "l1", "orderKey": ""},
            "urn:huge": {"layerId": "l1", "orderKey": "x" * (MAX_ORDER_KEY_LEN + 1)},
            "urn:ok": {"layerId": "l1", "orderKey": "a1"},
        })
        out = sanitize_node_ordering(layout)
        assert "orderKey" not in out["assignments"]["urn:num"]
        assert "orderKey" not in out["assignments"]["urn:empty"]
        assert "orderKey" not in out["assignments"]["urn:huge"]
        assert out["assignments"]["urn:ok"]["orderKey"] == "a1"

    def test_never_mutates_input_and_preserves_side_fields(self):
        layout = _layout(defaultNodeSortMode="bogus")
        snapshot = copy.deepcopy(layout)
        out = sanitize_node_ordering(layout)
        assert layout == snapshot            # input untouched
        assert out["displayRules"] == [{"id": "r1"}]   # unrelated fields survive
        assert out["assignments"]["urn:a"]["orderKey"] == "a1"
