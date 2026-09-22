"""Reconciliation (what matched) and merging (updating a view from a file), as pure functions."""
from __future__ import annotations

from backend.app.services.view_transfer.merge import (
    DIVERGED, FAST_FORWARD, FILE_IS_OLDER, UNRELATED, UP_TO_DATE,
    merge_definitions, update_status,
)
from backend.app.services.view_transfer.reconcile import (
    ATTENTION, BLOCKED, READY, Policy, TargetTypes, aggregate, reconcile_view, suggest_types,
)


def _definition(assignments, *, layers=None, anchor=None, extra=None):
    layer = {"id": "l1", "name": "Sources", "order": 0, "entityTypes": ["dataset"]}
    if anchor:
        layer["anchorUrn"] = anchor
    d = {"layout": {"type": "reference", "referenceLayout": {
        "layers": layers or [layer], "assignments": {u: {"layerId": "l1", "inheritsChildren": True} for u in assignments}}},
        "content": {"entityScope": "curated", "visibleEntityTypes": ["dataset"],
                    "visibleRelationshipTypes": ["PRODUCES"]}}
    if extra:
        d.update(extra)
    return d


TYPES = TargetTypes(entity={"dataset": "Dataset", "Table": "Table"}, relationship={"PRODUCES": "Produces"})


def test_every_state_is_counted_and_listed():
    definition = _definition(["urn:ok", "urn:renamed", "urn:retyped", "urn:gone", "urn:unknown"], anchor="urn:ok")
    exported = {
        "urn:ok": {"name": "orders", "type": "dataset"},
        "urn:renamed": {"name": "old name", "type": "dataset"},
        "urn:retyped": {"name": "x", "type": "dataset"},
        "urn:gone": {"name": "gone", "type": "dataset"},
    }
    lookup = {
        "urn:ok": {"name": "orders", "type": "Dataset"},  # case-only type difference is a match
        "urn:renamed": {"name": "new name", "type": "dataset"},
        "urn:retyped": {"name": "x", "type": "table"},
        "urn:gone": None,
        # urn:unknown absent → its lookup failed
    }
    report = reconcile_view(definition, exported=exported, lookup=lookup, types=TYPES, policy=Policy())
    e = report["summary"]["entities"]
    assert (e["total"], e["matched"], e["renamed"], e["typeChanged"], e["missing"], e["unknown"]) == (5, 1, 1, 1, 1, 1)
    assert e["found"] == 3 and e["checked"] == 4 and e["matchRate"] == 0.75
    statuses = {x["urn"]: x["status"] for x in report["entities"]}
    assert statuses == {"urn:gone": "missing", "urn:unknown": "unknown",
                        "urn:retyped": "type_changed", "urn:renamed": "renamed"}
    assert [x["urn"] for x in report["entities"]][0] == "urn:gone", "missing sorts first"
    gone = next(x for x in report["entities"] if x["urn"] == "urn:gone")
    assert gone["exported"] == {"name": "gone", "type": "dataset"} and gone["layerId"] == "l1"
    assert report["summary"]["verdict"] == ATTENTION
    assert any(n["code"] == "unchecked" for n in report["notices"])
    layer = report["layers"][0]
    assert layer["missing"] == 1 and layer["unknown"] == 1 and layer["healthy"] is False
    assert layer["anchor"] == {"urn": "urn:ok", "status": "matched"}


def test_a_complete_match_is_ready():
    definition = _definition(["urn:a", "urn:b"])
    lookup = {"urn:a": {"name": "a", "type": "dataset"}, "urn:b": {"name": "b", "type": "dataset"}}
    report = reconcile_view(definition, exported={}, lookup=lookup, types=TYPES, policy=Policy())
    assert report["summary"]["verdict"] == READY and report["summary"]["matchRate"] == 1.0
    assert report["entities"] == []


def test_nothing_found_in_a_big_view_means_the_wrong_graph():
    urns = [f"urn:{i}" for i in range(25)]
    report = reconcile_view(_definition(urns), exported={}, lookup={u: None for u in urns},
                            types=TYPES, policy=Policy())
    assert report["summary"]["verdict"] == BLOCKED
    assert "different graph" in report["summary"]["verdictReason"]


def test_missing_types_are_listed_with_suggestions():
    definition = _definition(["urn:a"], extra={"entityOverrides": {"table": {"color": "#fff"}}})
    report = reconcile_view(definition, exported={}, lookup={"urn:a": {"name": "a", "type": "dataset"}},
                            types=TYPES, policy=Policy())
    types = {t["id"]: t for t in report["types"]["entity"]}
    assert types["dataset"]["status"] == "present" and types["dataset"]["layers"] == ["Sources"]
    assert types["table"]["status"] == "missing" and types["table"]["suggestions"] == ["Table"]
    assert report["summary"]["verdict"] == ATTENTION


def test_suggestions_find_close_ids_and_labels():
    known = {"dataset": "Dataset", "dashboard": "Dashboard", "jobRun": "Job run"}
    assert suggest_types("datasets", known)[0] == "dataset"
    assert suggest_types("job run", known) == ["jobRun"]
    assert suggest_types("zzz", known) == []


def test_policy_notices():
    definition = _definition(["urn:a"])
    definition["layout"]["referenceLayout"]["assignments"]["urn:a"]["orderKey"] = "a0"
    report = reconcile_view(definition, exported={}, lookup={"urn:a": {"name": "a", "type": "dataset"}},
                            types=TargetTypes(), policy=Policy(view_type_allowed=False, node_sorting_enabled=False))
    codes = {n["code"] for n in report["notices"]}
    assert {"view_type_disabled", "node_sorting_disabled", "ontology_unavailable"} <= codes
    assert report["summary"]["verdict"] == BLOCKED


def test_aggregate_scores_several_views():
    a = reconcile_view(_definition(["urn:a"]), exported={}, lookup={"urn:a": {"name": "a", "type": "dataset"}},
                       types=TYPES, policy=Policy())
    b = reconcile_view(_definition(["urn:b"]), exported={}, lookup={"urn:b": None}, types=TYPES, policy=Policy())
    total = aggregate([a, b])
    assert total["entities"]["found"] == 1 and total["entities"]["total"] == 2 and total["views"] == 2


# ── Update status and merge ─────────────────────────────────────────────────


def test_update_status_classifies_every_relationship():
    history = ["h1", "h2", "h3"]
    kw = dict(incoming_history_hashes=history)
    assert update_status(incoming_hash="h3", target_working_hash="h3", target_versions=[(1, "h1")], **kw).status == UP_TO_DATE
    older = update_status(incoming_hash="h1", target_working_hash="h9", target_versions=[(1, "h1"), (2, "h9")], **kw)
    assert (older.status, older.base_version) == (FILE_IS_OLDER, 1)
    ff = update_status(incoming_hash="h3", target_working_hash="h2", target_versions=[(1, "h1"), (2, "h2")], **kw)
    assert (ff.status, ff.base_version) == (FAST_FORWARD, 2)
    div = update_status(incoming_hash="h3", target_working_hash="hX", target_versions=[(1, "h1"), (2, "h2"), (3, "hY")], **kw)
    assert (div.status, div.base_version, div.base_hash) == (DIVERGED, 2, "h2")
    assert update_status(incoming_hash="h3", target_working_hash="hX", target_versions=[(1, "hZ")], **kw).status == UNRELATED


def test_an_import_that_changed_its_file_still_answers_to_the_files_hash():
    # v1 was imported from a file with hash hF, but stored hS (an entity was dropped on the way in).
    versions = [(1, "hS", "hF")]
    # The same file again, nothing changed here since: up to date, not "older".
    same = update_status(incoming_hash="hF", incoming_history_hashes=["hF"], target_working_hash="hS",
                         target_versions=versions)
    assert same.status == UP_TO_DATE
    # A newer file from the same lineage finds v1 through the file's hash. What was stored differs
    # from that file (the choices made on import), so the two sides have diverged, and a merge
    # starts from the file's design.
    newer = update_status(incoming_hash="hF2", incoming_history_hashes=["hF", "hF2"], target_working_hash="hS",
                          target_versions=versions)
    assert (newer.status, newer.base_version, newer.base_hash) == (DIVERGED, 1, "hF")
    # Once this view moved past the import, the old file is older.
    moved = update_status(incoming_hash="hF", incoming_history_hashes=["hF"], target_working_hash="hX",
                          target_versions=[(1, "hS", "hF"), (2, "hX", None)])
    assert (moved.status, moved.base_version) == (FILE_IS_OLDER, 1)


def _layout(assignments, layers=None):
    return {"layout": {"type": "reference", "referenceLayout": {
        "layers": layers or [{"id": "l1", "name": "Sources", "order": 0}, {"id": "l2", "name": "Marts", "order": 1}],
        "assignments": assignments}},
        "content": {"entityScope": "curated"}, "filters": {"fieldFilters": []}}


def test_merge_keeps_local_edits_and_lets_the_file_win_conflicts():
    base = _layout({"urn:a": {"layerId": "l1"}, "urn:b": {"layerId": "l1"}})
    ours = _layout({"urn:a": {"layerId": "l2"}, "urn:b": {"layerId": "l1"}, "urn:local": {"layerId": "l1"}})
    ours["filters"] = {"fieldFilters": [{"field": "owner"}]}
    theirs = _layout({"urn:a": {"layerId": "l1", "orderKey": "a0"}, "urn:b": {"layerId": "l2"},
                      "urn:incoming": {"layerId": "l2"}})
    result = merge_definitions(base, ours, theirs)
    assignments = result.definition["layout"]["referenceLayout"]["assignments"]
    assert assignments["urn:local"] == {"layerId": "l1"}, "a local-only addition survives"
    assert assignments["urn:incoming"] == {"layerId": "l2"}, "a file-only addition arrives"
    assert assignments["urn:b"] == {"layerId": "l2"}, "a file-only change arrives"
    assert assignments["urn:a"] == {"layerId": "l1", "orderKey": "a0"}, "both changed: the file wins"
    assert "assignments.urn:a" in result.conflicts
    assert result.definition["filters"] == {"fieldFilters": [{"field": "owner"}]}, "a local-only setting survives"
    assert result.definition["content"]["entityScope"] == "curated"


def test_merge_of_scalar_settings_changed_on_both_sides_takes_the_file():
    base = {"layout": {"type": "graph"}, "content": {"defaultDepth": 3, "entityScope": "all"}}
    ours = {"layout": {"type": "graph"}, "content": {"defaultDepth": 4, "entityScope": "all"}}
    theirs = {"layout": {"type": "graph"}, "content": {"defaultDepth": 5, "entityScope": "curated"}}
    result = merge_definitions(base, ours, theirs)
    assert result.definition["content"] == {"defaultDepth": 5, "entityScope": "curated"}
    assert "content.defaultDepth" in result.conflicts
