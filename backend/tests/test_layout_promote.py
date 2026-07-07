"""Pure unit tests for the branch-scoped-layout 3-way promote merge
(``backend.app.services.versioning.layout_promote``). No DB / ORM.

The module merges a Context View's canonical ``referenceLayout`` on branch
merge/publish: given the fork-point base (F), the current published base (P,
possibly moved since the fork) and the draft's effective layout (D = F + draft
edits), it produces P' — the layout to write back to the published base.

Per key (assignment urn, or layer id): draft-untouched (D == F) takes P
(preserving published's own since-fork change); draft-changed (D != F) takes D
(draft wins conflicts). Layer order follows the draft's array order, with
published-only layers appended; ``order`` is renumbered 0..n-1. A final
referential-integrity pass drops assignments pointing at a deleted layer.
"""
import copy

import pytest

from backend.app.services.versioning.layout_promote import (
    merge_layout_3way,
    merge_scope_3way,
)


def _layout(layers=None, assignments=None):
    return {"layers": list(layers or []), "assignments": dict(assignments or {})}


def _layer(lid, name="L", order=0, **extra):
    return {"id": lid, "name": name, "order": order, **extra}


def _assign(layer_id, **extra):
    return {"layerId": layer_id, "inheritsChildren": True, **extra}


def _ids(layout):
    return [l["id"] for l in layout["layers"]]


def _orders(layout):
    return [l["order"] for l in layout["layers"]]


class TestDraftCreates:
    def test_draft_creates_layer_and_assignment_present_in_result(self):
        # (1) draft adds a new layer + an assignment onto it.
        f = _layout(layers=[_layer("l1", "Systems", 0)])
        p = _layout(layers=[_layer("l1", "Systems", 0)])
        d = _layout(
            layers=[_layer("l1", "Systems", 0), _layer("l2", "Data", 1)],
            assignments={"urn:b": _assign("l2")},
        )
        result = merge_layout_3way(f, p, d)
        assert _ids(result) == ["l1", "l2"]
        assert result["assignments"]["urn:b"]["layerId"] == "l2"


class TestDraftRenames:
    def test_draft_rename_layer_applied(self):
        # (2) same layer id, name changed on the draft only.
        f = _layout(layers=[_layer("l1", "Old", 0)])
        p = _layout(layers=[_layer("l1", "Old", 0)])
        d = _layout(layers=[_layer("l1", "New", 0)])
        result = merge_layout_3way(f, p, d)
        assert result["layers"][0]["name"] == "New"


class TestDraftDeletesLayer:
    def test_draft_delete_layer_gone_and_its_assignment_pruned(self):
        # (3) draft removes l1 (and its assignment) -> both gone from result.
        f = _layout(
            layers=[_layer("l1", "A", 0), _layer("l2", "B", 1)],
            assignments={"urn:a": _assign("l1"), "urn:b": _assign("l2")},
        )
        p = copy.deepcopy(f)
        d = _layout(layers=[_layer("l2", "B", 0)], assignments={"urn:b": _assign("l2")})
        result = merge_layout_3way(f, p, d)
        assert _ids(result) == ["l2"]
        assert "urn:a" not in result["assignments"]
        assert "urn:b" in result["assignments"]


class TestDraftDeletesAssignment:
    def test_draft_delete_assignment_gone_layer_kept(self):
        # (4) draft removes an assignment; its layer is untouched.
        f = _layout(layers=[_layer("l1", "A", 0)], assignments={"urn:a": _assign("l1")})
        p = copy.deepcopy(f)
        d = _layout(layers=[_layer("l1", "A", 0)], assignments={})
        result = merge_layout_3way(f, p, d)
        assert "urn:a" not in result["assignments"]
        assert _ids(result) == ["l1"]


class TestDraftReorders:
    def test_draft_reorder_result_follows_draft_order_renumbered(self):
        # (5) draft reorders layers; result follows draft array order and the
        # `order` fields are renumbered 0..n-1 (draft's stale 99s discarded).
        f = _layout(
            layers=[_layer("l1", "A", 0), _layer("l2", "B", 1), _layer("l3", "C", 2)]
        )
        p = copy.deepcopy(f)
        d = _layout(
            layers=[_layer("l3", "C", 99), _layer("l1", "A", 99), _layer("l2", "B", 99)]
        )
        result = merge_layout_3way(f, p, d)
        assert _ids(result) == ["l3", "l1", "l2"]
        assert _orders(result) == [0, 1, 2]


class TestConflictDraftWins:
    def test_conflict_both_changed_draft_wins_for_layer_and_assignment(self):
        # (6) published and draft both changed the same layer name and the same
        # assignment layerId, differently -> draft wins on both.
        f = _layout(
            layers=[_layer("l1", "Base", 0), _layer("l2", "Other", 1)],
            assignments={"urn:a": _assign("l1", note="base")},
        )
        p = _layout(
            layers=[_layer("l1", "PubName", 0), _layer("l2", "Other", 1)],
            assignments={"urn:a": _assign("l2", note="pub")},
        )
        d = _layout(
            layers=[_layer("l1", "DraftName", 0), _layer("l2", "Other", 1)],
            assignments={"urn:a": _assign("l1", note="draft")},
        )
        result = merge_layout_3way(f, p, d)
        assert result["layers"][0]["name"] == "DraftName"
        assert result["assignments"]["urn:a"]["note"] == "draft"
        assert result["assignments"]["urn:a"]["layerId"] == "l1"


class TestPublishedOnlyPreserved:
    def test_published_only_new_layer_preserved_and_appended(self):
        # (7) published added a layer since the fork; draft never touched it ->
        # preserved, appended after the draft's layers.
        f = _layout(layers=[_layer("l1", "A", 0)])
        d = _layout(layers=[_layer("l1", "A", 0)])
        p = _layout(layers=[_layer("l1", "A", 0), _layer("lpub", "Pub", 1)])
        result = merge_layout_3way(f, p, d)
        assert _ids(result) == ["l1", "lpub"]
        assert _orders(result) == [0, 1]

    def test_published_only_new_assignment_preserved(self):
        # (8) published added an assignment since the fork; draft untouched.
        f = _layout(layers=[_layer("l1", "A", 0)], assignments={})
        d = _layout(layers=[_layer("l1", "A", 0)], assignments={})
        p = _layout(layers=[_layer("l1", "A", 0)], assignments={"urn:p": _assign("l1")})
        result = merge_layout_3way(f, p, d)
        assert "urn:p" in result["assignments"]
        assert result["assignments"]["urn:p"]["layerId"] == "l1"


class TestReferentialIntegrity:
    def test_assignment_to_draft_deleted_layer_is_pruned(self):
        # (9) draft deleted layer l1 but the assignment onto it was untouched
        # (survives the value-merge from F==P==D) -> the referential-integrity
        # pass drops the now-orphaned assignment. Self-heal, never raises.
        f = _layout(layers=[_layer("l1", "A", 0)], assignments={"urn:a": _assign("l1")})
        p = copy.deepcopy(f)
        d = _layout(layers=[], assignments={"urn:a": _assign("l1")})
        result = merge_layout_3way(f, p, d)
        assert result["layers"] == []
        assert "urn:a" not in result["assignments"]


class TestScopeMerge:
    def test_scope_draft_changed_draft_wins(self):
        # (10a) draft flipped entityScope -> draft wins.
        assert merge_scope_3way("all", "all", "curated") == "curated"

    def test_scope_draft_unchanged_published_wins(self):
        # (10b) draft left entityScope alone but published changed it -> published.
        assert merge_scope_3way("all", "curated", "all") == "curated"

    def test_scope_no_change_anywhere(self):
        assert merge_scope_3way("curated", "curated", "curated") == "curated"


class TestNoOp:
    def test_identical_inputs_return_equivalent_layout(self):
        # (11) F == P == D -> result equals that layout (orders 0..n-1).
        base = _layout(
            layers=[_layer("l1", "A", 0), _layer("l2", "B", 1)],
            assignments={"urn:a": _assign("l1")},
        )
        result = merge_layout_3way(
            copy.deepcopy(base), copy.deepcopy(base), copy.deepcopy(base)
        )
        assert _ids(result) == ["l1", "l2"]
        assert _orders(result) == [0, 1]
        assert result["assignments"] == {"urn:a": _assign("l1")}


class TestPurity:
    def test_inputs_are_not_mutated(self):
        # (12) merge must not mutate any input (notably not renumber a draft
        # layer's `order` in place).
        f = _layout(
            layers=[_layer("l1", "A", 0)],
            assignments={"urn:a": _assign("l1")},
        )
        p = _layout(
            layers=[_layer("l1", "A", 0), _layer("lpub", "Pub", 1)],
            assignments={},
        )
        d = _layout(
            layers=[_layer("l1", "A", 99), _layer("l2", "New", 99)],
            assignments={"urn:b": _assign("l2")},
        )
        f_snap, p_snap, d_snap = copy.deepcopy(f), copy.deepcopy(p), copy.deepcopy(d)
        merge_layout_3way(f, p, d)
        assert f == f_snap
        assert p == p_snap
        assert d == d_snap


class TestRobustness:
    def test_all_empty_inputs(self):
        result = merge_layout_3way(_layout(), _layout(), _layout())
        assert result == {"layers": [], "assignments": {}}

    def test_bare_empty_dicts_and_none(self):
        # Non-canonical / missing inputs normalize to empty rather than raising.
        result = merge_layout_3way({}, None, {})
        assert result == {"layers": [], "assignments": {}}

    def test_determinism_repeated_runs_identical(self):
        f = _layout(layers=[_layer("l1", "A", 0)])
        p = _layout(
            layers=[_layer("l1", "A", 0), _layer("lp", "P", 1)],
            assignments={"urn:p": _assign("lp")},
        )
        d = _layout(
            layers=[_layer("l2", "B", 0), _layer("l1", "A", 1)],
            assignments={"urn:a": _assign("l1"), "urn:b": _assign("l2")},
        )
        first = merge_layout_3way(f, p, d)
        second = merge_layout_3way(f, p, d)
        assert first == second


class TestFullConfigGuard:
    """A bare referenceLayout carries `layers`/`assignments` at top level; a
    FULL view config instead nests them under `layout.referenceLayout` and
    carries `content`/`layout` wrappers. Passing a full config where a bare
    referenceLayout is expected used to silently normalize to EMPTY (every
    published layer/assignment looked deleted → wiped the published layout).
    The guard auto-unwraps a recoverable `layout.referenceLayout`, else raises.
    """

    def _full_config(self, layers=None, assignments=None):
        return {
            "content": {"entityScope": "curated"},
            "layout": {"referenceLayout": _layout(layers, assignments)},
            "filters": {},
        }

    def test_full_config_input_is_auto_unwrapped_not_wiped(self):
        # A full config accidentally passed as the DRAFT is unwrapped to its
        # bare referenceLayout instead of normalizing to empty and wiping.
        f = _layout(layers=[_layer("l1", "A", 0)])
        p = _layout(layers=[_layer("l1", "A", 0)])
        d = self._full_config(
            layers=[_layer("l1", "A", 0), _layer("l2", "New", 1)],
            assignments={"urn:b": _assign("l2")},
        )
        result = merge_layout_3way(f, p, d)
        assert _ids(result) == ["l1", "l2"]
        assert result["assignments"]["urn:b"]["layerId"] == "l2"

    def test_full_config_input_on_published_side_preserved(self):
        # Same guard applies to any side — published passed as a full config
        # keeps its layers rather than looking wholesale-deleted.
        f = _layout(layers=[_layer("l1", "A", 0)])
        p = self._full_config(layers=[_layer("l1", "A", 0), _layer("lpub", "Pub", 1)])
        d = _layout(layers=[_layer("l1", "A", 0)])
        result = merge_layout_3way(f, p, d)
        assert _ids(result) == ["l1", "lpub"]

    def test_full_config_without_reference_layout_raises(self):
        # A full config that carries `content` but no recoverable
        # `layout.referenceLayout` is unrecoverable → loud ValueError rather
        # than a silent wipe.
        bad = {"content": {"entityScope": "all"}, "filters": {}}
        with pytest.raises(ValueError, match="bare referenceLayout"):
            merge_layout_3way(_layout(), _layout(), bad)

    def test_empty_and_none_still_normalize_to_empty(self):
        # The guard must not fire on genuinely-empty / irrelevant inputs.
        assert merge_layout_3way({}, None, {}) == {"layers": [], "assignments": {}}
        assert merge_layout_3way(
            {"foo": 1}, {"bar": 2}, {}
        ) == {"layers": [], "assignments": {}}
