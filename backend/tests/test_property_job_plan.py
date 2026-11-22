"""A bulk property job's plan and its request, without a database.

``plan_patch`` is what one operation does to one entity's properties — the whole of what a job
writes, window after window — so each kind's writes and skips are pinned here; the request models
and ``_check_property_job`` are what the routes refuse before a job is made, each with its code.
"""
from __future__ import annotations

import json

import pytest
from pydantic import ValidationError

from backend.app.services.versioning import config
from backend.app.services.versioning.import_export import property_job as pj
from backend.app.services.versioning.ontology import EntityRule, OntologyRules
from backend.common.property_patch import PROP_DELETE


def _op(kind, key="owner", **kw):
    return {"kind": kind, "key": key, "onConflict": "skip", **kw}


# ── the plan ──────────────────────────────────────────────────────────────────
def test_set_writes_the_value_and_skips_an_entity_that_holds_it():
    op = _op("set", value="ana")
    assert pj.plan_patch(op, {}) == {"owner": "ana"}
    assert pj.plan_patch(op, {"owner": "bo"}) == {"owner": "ana"}
    assert pj.plan_patch(op, {"owner": "ana", "x": 1}) is None


def test_set_compares_values_as_stored():
    """1, 1.0, True and "1" are four values: each is written over the others."""
    for held in (True, 1.0, "1"):
        assert pj.plan_patch(_op("set", value=1), {"owner": held}) == {"owner": 1}
    assert pj.plan_patch(_op("set", value={"a": [1, 2]}), {"owner": {"a": [1, 2]}}) is None
    assert pj.plan_patch(_op("set", value=None), {"owner": None}) is None


def test_the_plan_compares_what_a_write_stores():
    """A date or a moment is stored one way, so one written another way changes nothing — and one
    that changes is planned in the form it will be stored in. (The job's writes are exact, so 1
    over 1.0 is written as planned: ``test_typed_patch_merge``.)"""
    held = {"owner": "2026-01-05T10:00:00Z"}
    assert pj.plan_patch(_op("set", value="2026-01-05 12:00+02:00"), held) is None
    assert pj.plan_patch(_op("set", value="2026-01-06 12:00+02:00"), held) == {"owner": "2026-01-06T10:00:00Z"}
    assert pj.plan_patch(_op("fillEmpty", value="2026-01-06T00:00"), {}) == {"owner": "2026-01-06T00:00:00Z"}
    assert pj.plan_patch(_op("copy", to="since"), {"owner": "2026-01-05 10:00"}) == {"since": "2026-01-05T10:00:00Z"}


def test_fill_empty_writes_only_where_the_key_is_absent_null_or_blank():
    """Empty as a publish's required field reads it: an empty list is no value either."""
    op = _op("fillEmpty", value="ana")
    for props in ({}, {"owner": None}, {"owner": ""}, {"owner": []}):
        assert pj.plan_patch(op, props) == {"owner": "ana"}
    for held in ("bo", 0, False, [""], {}):
        assert pj.plan_patch(op, {"owner": held}) is None


def test_remove_deletes_a_held_key_and_skips_the_rest():
    assert pj.plan_patch(_op("remove"), {"owner": None}) == {"owner": PROP_DELETE}
    assert pj.plan_patch(_op("remove"), {"other": 1}) is None


def test_rename_moves_the_value_and_skips_a_conflict_unless_it_overwrites():
    op = _op("rename", to="steward")
    assert pj.plan_patch(op, {"owner": "ana"}) == {"steward": "ana", "owner": PROP_DELETE}
    assert pj.plan_patch(op, {"other": 1}) is None                       # no source: unchanged
    held = {"owner": "ana", "steward": "bo"}
    assert pj.plan_patch(op, held) is None and pj.is_conflict(op, held)
    over = {**op, "onConflict": "overwrite"}
    assert pj.plan_patch(over, held) == {"steward": "ana", "owner": PROP_DELETE}
    assert not pj.is_conflict(over, held)
    # The new key holds the value already: only the old one goes.
    assert pj.plan_patch(over, {"owner": "ana", "steward": "ana"}) == {"owner": PROP_DELETE}


def test_copy_is_a_rename_that_keeps_the_key():
    op = _op("copy", to="steward")
    assert pj.plan_patch(op, {"owner": "ana"}) == {"steward": "ana"}
    assert pj.plan_patch(op, {"owner": "ana", "steward": "bo"}) is None
    assert pj.is_conflict(op, {"owner": "ana", "steward": "bo"})
    over = {**op, "onConflict": "overwrite"}
    assert pj.plan_patch(over, {"owner": "ana", "steward": "bo"}) == {"steward": "ana"}
    assert pj.plan_patch(over, {"owner": "ana", "steward": "ana"}) is None
    assert not pj.is_conflict(op, {"steward": "bo"})                      # no source: no conflict


# ── clean-ups: the values a key holds, rewritten where it is held ─────────────
def test_replace_finds_text_in_any_case_unless_asked_and_whole_values_when_asked():
    op = _op("replace", key="dept", find="fin", replaceWith="Finance")
    assert pj.plan_patch(op, {"dept": "FIN ops, fin"}) == {"dept": "Finance ops, Finance"}
    assert pj.plan_patch({**op, "matchCase": True}, {"dept": "FIN ops, fin"}) == {"dept": "FIN ops, Finance"}
    whole = {**op, "wholeValue": True}
    assert pj.plan_patch(whole, {"dept": " Fin"}) is None and pj.plan_patch(whole, {"dept": "FIN"}) == {"dept": "Finance"}
    # Case folds as search folds it: one character at a time, "İ" to "i".
    assert pj.plan_patch(_op("replace", key="k", find="istanbul", replaceWith="X"), {"k": "İSTANBUL!"}) == {"k": "X!"}
    # A list's text elements; numbers, booleans and an entity without the key are left alone.
    assert pj.plan_patch(op, {"dept": ["fin", 1, True, "ops"]}) == {"dept": ["Finance", 1, True, "ops"]}
    for held in ({"dept": 12}, {"dept": None}, {"dept": "ops"}, {}):
        assert pj.plan_patch(op, held) is None
    assert pj.plan_patch({**op, "replaceWith": ""}, {"dept": "fin-ops"}) == {"dept": "-ops"}


def test_a_replaced_text_that_reads_as_a_date_is_stored_as_dates_are():
    op = _op("replace", key="d", find="/", replaceWith="-")
    assert pj.plan_patch(op, {"d": "2026/01/05"}) == {"d": "2026-01-05"}
    # Rewritten to the form a date is stored in already: nothing changes.
    assert pj.plan_patch(_op("replace", key="d", find="Z", replaceWith="+00:00"), {"d": "2026-01-05T10:00:00Z"}) is None
    # A value it leaves as it is is never re-stored in another form.
    assert pj.plan_patch(_op("replace", key="d", find="x", replaceWith="y"), {"d": "2026-01-05 10:00"}) is None


def test_normalize_trims_collapses_cases_and_dedupes_text():
    op = _op("normalize", key="k", trim=True, collapseSpaces=True, case="title")
    assert pj.plan_patch(op, {"k": "  data   PLATFORM team "}) == {"k": "Data Platform Team"}
    assert pj.plan_patch(_op("normalize", key="k", trim=True, case="lower"), {"k": " ΑΣ "}) == {"k": "ασ"}
    assert pj.plan_patch(_op("normalize", key="k", trim=False, case="upper"), {"k": " a "}) == {"k": " A "}
    assert pj.plan_patch(_op("normalize", key="k", trim=True), {"k": "tidy"}) is None
    listed = _op("normalize", key="k", trim=True, case="lower", dedupeList=True)
    assert pj.plan_patch(listed, {"k": ["A ", "a", 1, 1.0, 1, " b"]}) == {"k": ["a", 1, 1.0, "b"]}
    assert pj.plan_patch({**listed, "dedupeList": False}, {"k": ["A ", "a"]}) == {"k": ["a", "a"]}


def test_merging_values_matches_each_exactly_as_the_catalog_counts_it():
    op = _op("mapValues", key="dept", map=[
        {"from": "finance ", "fromKind": "String", "to": "Finance", "toKind": "String"},
        {"from": "FINANCE", "to": "Finance"},
        {"from": 1, "fromKind": "Float", "to": "one"}])
    for held, out in (("finance ", "Finance"), ("FINANCE", "Finance"), ("Finance", None), ("finance", None),
                      (1.0, "one"), (1, None), (True, None)):
        assert pj.plan_patch(op, {"dept": held}) == (None if out is None else {"dept": out}), held
    # In a list, each element — then each value once (unless told to keep duplicates).
    assert pj.plan_patch(op, {"dept": ["FINANCE", "Finance", "ops"]}) == {"dept": ["Finance", "ops"]}
    assert pj.plan_patch({**op, "dedupeList": False}, {"dept": ["FINANCE", "Finance"]}) == {"dept": ["Finance", "Finance"]}
    # Applied once, not followed: a → b, b → c leaves a at b.
    chain = _op("mapValues", key="k", map=[{"from": "a", "to": "b"}, {"from": "b", "to": "c"}])
    assert pj.plan_patch(chain, {"k": ["a", "b"]}) == {"k": ["b", "c"]}


@pytest.mark.parametrize("held, kind, out", [
    ("42", "Integer", 42), (" +42.0 ", "Integer", 42), (42.0, "Integer", 42), (-0.0, "Integer", 0),
    ("9223372036854775807", "Integer", 9223372036854775807),
    ("1.5", "Float", 1.5), (".5", "Float", 0.5), (3, "Float", 3.0), (2 ** 60, "Float", float(2 ** 60)),
    (42, "String", "42"), (1.0, "String", "1.0"), (0.1, "String", "0.1"), (True, "String", "true"),
    (" TRUE ", "Boolean", True), ("false", "Boolean", False),
])
def test_convert_stores_each_value_as_the_kind_asked_for(held, kind, out):
    assert pj.plan_patch(_op("convert", key="k", toKind=kind), {"k": held}) == {"k": out}


@pytest.mark.parametrize("held, kind", [
    ("x", "Integer"), (42.5, "Integer"), (True, "Integer"), ("1e3", "Integer"), (2 ** 63, "Integer"),
    ("9223372036854775808", "Integer"), ("1e3", "Float"), ("nan", "Float"), (2 ** 53 + 1, "Float"),
    (False, "Float"), (1, "Boolean"), ("yes", "Boolean"),
])
def test_a_value_that_does_not_convert_is_left_or_removed(held, kind):
    skip = _op("convert", key="k", toKind=kind)
    assert pj.plan_patch(skip, {"k": held}) is None and pj.unconvertible(skip, {"k": held})
    drop = {**skip, "onFail": "remove"}
    assert pj.plan_patch(drop, {"k": held}) == {"k": PROP_DELETE} and pj.unconvertible(drop, {"k": held})


def test_convert_leaves_what_is_already_that_kind_and_converts_a_list_element_by_element():
    op = _op("convert", key="k", toKind="Integer")
    for held in ({"k": 7}, {"k": None}, {"k": {"a": 1}}, {}):
        assert pj.plan_patch(op, held) is None and not pj.unconvertible(op, held)
    assert pj.plan_patch(op, {"k": ["1", 2, 3.0]}) == {"k": [1, 2, 3]}
    # One element that won't: the list is left whole, or loses just that element.
    assert pj.plan_patch(op, {"k": ["1", "x"]}) is None and pj.unconvertible(op, {"k": ["1", "x"]})
    assert pj.plan_patch({**op, "onFail": "remove"}, {"k": ["1", "x"]}) == {"k": [1]}
    # Text that already is text — even a legacy date — is not re-stored.
    assert pj.plan_patch(_op("convert", key="k", toKind="String"), {"k": "2026-01-05 10:00"}) is None


def test_a_window_counts_what_does_not_convert_and_lists_what_it_left():
    found = {"urn:a": ("A", {"k": "3"}, "urn:a"), "urn:b": ("B", {"k": "x"}, "urn:b"),
             "urn:c": ("C", {"k": 4}, "urn:c")}
    ops, counts, refused = pj.plan_window(_op("convert", key="k", toKind="Integer"), found)
    assert [o["entity_id"] for o in ops] == ["A"] and ops[0]["payload"] == {"properties": {"k": 3}}
    assert (counts["changed"], counts["unchanged"], counts["unconvertible"]) == (1, 1, 1)
    assert refused == [{"urn": "urn:b", "entityId": "B", "reason": "unconvertible",
                        "detail": 'Its k holds "x", which isn\'t an integer.'}]
    # Removed as asked: written, counted, not refused.
    ops, counts, refused = pj.plan_window(_op("convert", key="k", toKind="Integer", onFail="remove"), found)
    assert {o["entity_id"] for o in ops} == {"A", "B"} and refused == []
    assert (counts["changed"], counts["unconvertible"]) == (2, 1)


def test_the_kinds_values_are_told_apart_by_are_the_catalogs():
    from backend.app.providers.falkordb_search import catalog
    for value in (1, 1.0, True, "1", "x", [1], {"a": 1}, None, 2 ** 60, -0.5):
        assert pj.kind_of(value) == catalog._kind_of(value), value
        assert pj._slot(pj.kind_of(value), value) == catalog._slot(pj.kind_of(value), value)


def test_each_clean_up_names_its_commits():
    assert pj.describe(_op("replace", key="dept", find="Fin", replaceWith="Finance")) == \
        "Replace “Fin” → “Finance” in dept"
    assert pj.describe(_op("replace", key="d", find="x" * 60, replaceWith="")) == \
        f"Replace “{'x' * 39}…” → “” in d"
    assert pj.describe(_op("normalize", key="dept", trim=True, collapseSpaces=True, case="lower")) == \
        "Normalize dept (trim, collapse spaces, lower case)"
    assert pj.describe(_op("mapValues", key="dept", map=[{"from": "a", "to": "b"}] * 3)) == "Merge 3 values of dept"
    assert pj.describe(_op("convert", key="tier", toKind="Float")) == "Convert tier to Decimal"
    assert pj.window_message(_op("convert", key="tier", toKind="Integer"), None, 1, 2) == \
        "Bulk property: Convert tier to Integer (1/2)"


def test_a_window_plans_each_entity_once_and_counts_what_it_skips():
    found = {"urn:a": ("A", {"owner": "x"}, "urn:a"),
             "gv:A": ("A", {"owner": "x"}, "urn:a"),                     # the same entity again
             "urn:b": ("B", {"owner": "y", "steward": "z"}, "urn:b"),
             "urn:c": ("C", {}, "urn:c")}
    ops, counts, refused = pj.plan_window(_op("rename", to="steward"), found)
    assert ops == [{"op": "update", "entity_kind": "node", "entity_id": "A",
                    "payload": {"properties": {"steward": "x", "owner": PROP_DELETE}}}]
    assert counts == {"changed": 1, "unchanged": 2, "missing": 0, "deletedInDraft": 0, "conflicts": 1,
                      "unconvertible": 0, "noLongerMatches": 0, "changedSince": 0}
    assert refused == [{"urn": "urn:b", "entityId": "B", "reason": "conflict",
                        "detail": "It already has steward."}]


# ── a search target's matches, checked again on the draft's values ───────────
def test_a_search_answered_by_an_entitys_own_values_is_checked_again():
    gold = {"kind": "property", "key": "tier", "op": "eq", "value": "gold"}
    for exact in (gold, {"kind": "hasProperty", "key": "owner"},
                  {"kind": "group", "op": "and", "children": [gold, {"kind": "tag", "values": ["pii"]}]},
                  {"kind": "is", "refs": [{"urn": "urn:a"}]}):
        assert pj.predicate_recheck(exact) is not None, exact
        assert pj.recheck_summary(pj.predicate_recheck(exact)) == {"exact": True, "note": None}
    check = pj.predicate_recheck(gold)
    assert check({"urn": "u", "entityType": "Table", "tier": "gold"})
    assert not check({"urn": "u", "entityType": "Table", "tier": "silver"})


def test_a_search_its_own_values_cant_answer_is_not_checked_again():
    """Relationships, the view's layers, where an entity sits, a field the platform keeps, a name
    to resolve, a Connections search: the job edits what the published graph matched."""
    for approximate in (
            {"kind": "degree", "direction": "in", "op": "gt", "value": 0},
            {"kind": "layer", "layerAssignment": "gold"},
            {"kind": "descendantOf", "urns": ["urn:db"]},
            {"kind": "property", "key": "childCount", "op": "gt", "value": 1, "valueType": "number"},
            {"kind": "is", "refs": [{"path": ["Sales", "Orders"]}]},
            {"kind": "edges", "edgeTypes": ["FLOWS_TO"]},
            {"kind": "group", "op": "or", "children": [
                {"kind": "hasProperty", "key": "owner"}, {"kind": "isOrphan"}]}):
        assert pj.predicate_recheck(approximate) is None, approximate
    assert pj.recheck_summary(None) == {"exact": False, "note": pj.RECHECK_APPROXIMATE}


def test_a_window_leaves_alone_what_the_search_no_longer_matches_in_the_draft():
    from backend.app.services.versioning.import_export.snapshot import Winner

    def winner(eid, **props):
        return Winner(entity_id=eid, live=True, urn=f"urn:{eid}", payload=json.dumps({
            "urn": f"urn:{eid}", "entityType": "Table", "displayName": eid, "properties": props}))
    at = {"urn:a": "a", "urn:b": "b", "urn:gone": "g", "urn:c": "c"}
    winners = {"a": winner("a", tier="gold"), "b": winner("b", tier="silver"),
               # Stored with no tags and no properties at all: read as a draft's reads read it.
               "c": Winner(entity_id="c", live=True, urn="urn:c", payload=json.dumps({
                   "urn": "urn:c", "entityType": "Table", "tags": None, "properties": None}))}
    check = pj.predicate_recheck({"kind": "property", "key": "tier", "op": "eq", "value": "gold"})
    found, stale, gone = pj.parse_targets(at, winners, check)
    assert found == {"urn:a": ("a", {"tier": "gold"}, "urn:a")}
    assert stale == {"urn:b": "b", "urn:c": "c"} and gone == ["urn:gone"]
    # Not checked again (an id target, or a search its values can't answer): every one is found.
    found, stale, _gone = pj.parse_targets(at, winners)
    assert set(found) == {"urn:a", "urn:b", "urn:c"} and stale == {}


def test_commits_are_named_by_the_operation_and_the_window():
    assert pj.window_message(_op("rename", to="steward"), None, 37, 120) == \
        "Bulk property: Rename owner → steward (37/120)"
    assert pj.window_message(_op("fillEmpty", value=1), None, 1, 1) == \
        "Bulk property: Fill owner where empty (1/1)"
    assert pj.window_message(_op("remove"), "Tidy up", 2, 3) == "Tidy up (2/3)"


def test_the_running_summary_adds_each_window_and_keeps_twenty_examples():
    summary = pj.empty_summary(3)
    rows = [{"urn": f"u{i}", "entityId": None, "reason": "missing", "detail": "x"} for i in range(15)]
    summary = pj._tally(summary, {"changed": 4, "missing": 15}, rows, "cmt_1")
    summary = pj._tally(summary, {"changed": 2, "conflicts": 10},
                        [{**r, "reason": "conflict"} for r in rows[:10]], None)
    summary = pj._tally(summary, {"unchanged": 1}, [], "cmt_3")
    assert (summary["changed"], summary["unchanged"], summary["missing"], summary["conflicts"]) == (6, 1, 15, 10)
    assert summary["refused"]["count"] == 25
    assert summary["refused"]["byReason"] == {"missing": 15, "conflict": 10}
    assert len(summary["refused"]["examples"]) == pj.REFUSED_EXAMPLES
    assert (summary["commits"], summary["firstCommitId"], summary["lastCommitId"]) == (2, "cmt_1", "cmt_3")
    assert summary["chunks"] == 3


# ── an undo: what a commit wrote, put back ────────────────────────────────────
def test_an_undo_puts_back_what_the_commit_changed_where_the_entity_still_holds_it():
    """Only the keys the commit changed are put back: what else changed since is kept."""
    before, after = {"owner": "a", "tier": 1}, {"owner": "b", "tier": 1}
    assert pj.plan_undo(before, after, {"owner": "b", "tier": 2, "new": 3}) == {"owner": "a"}
    assert pj.plan_undo(before, after, {"owner": "c", "tier": 1}) == (
        "changed_since", "Its owner changed since the bulk change — left as it is.")
    assert pj.plan_undo(before, after, {"tier": 1}) == (
        "changed_since", "Its owner changed since the bulk change — left as it is.")
    assert pj.plan_undo(before, after, None) == ("deleted_in_draft", "Deleted in this draft.")


def test_an_undo_of_what_is_put_back_already_changes_nothing():
    """An entity that holds what it held before — put back by hand, or by an undo cancelled part-way
    and asked again — has nothing to put back, and isn't listed."""
    assert pj.plan_undo({"owner": "a"}, {"owner": "b"}, {"owner": "a", "x": 1}) is None
    assert pj.plan_undo({"owner": "a"}, {"owner": "a"}, {"owner": "z"}) is None      # the commit changed nothing


def test_an_undo_of_a_rename_puts_both_keys_back():
    before, after = {"owner": "a", "x": 1}, {"steward": "a", "x": 1}
    assert pj.plan_undo(before, after, {"steward": "a", "x": 1}) == {"owner": "a", "steward": PROP_DELETE}
    assert pj.plan_undo(before, after, {"steward": "a", "owner": "z", "x": 1})[0] == "changed_since"
    assert pj.plan_undo(before, after, {"steward": "b", "x": 1})[0] == "changed_since"


def test_a_key_the_entity_did_not_hold_before_is_removed_and_one_removed_is_given_back():
    assert pj.plan_undo({}, {"owner": "ana"}, {"owner": "ana"}) == {"owner": PROP_DELETE}          # a fill
    assert pj.plan_undo({"owner": None}, {"owner": "ana"}, {"owner": "ana"}) == {"owner": None}
    assert pj.plan_undo({"owner": ["a", "b"]}, {}, {}) == {"owner": ["a", "b"]}                     # a remove
    assert pj.plan_undo({"owner": "a"}, {}, {"owner": "b"})[0] == "changed_since"


def test_an_undo_puts_back_each_value_in_the_kind_it_was_stored_as():
    """1, 1.0, true and "1" are four values: a convert or a set is undone to the very one."""
    restored = pj.plan_undo({"score": 1.0, "tier": "42"}, {"score": 1, "tier": 42}, {"score": 1, "tier": 42})
    assert restored == {"score": 1.0, "tier": "42"}
    assert [type(v) for v in restored.values()] == [float, str]
    assert pj.plan_undo({"score": 1.0}, {"score": 1}, {"score": True})[0] == "changed_since"
    assert pj.plan_undo({"score": 1.0}, {"score": 1}, {"score": 1.0}) is None


def test_an_undo_window_plans_each_entity_the_commit_wrote_and_lists_what_it_left():
    from backend.app.services.versioning.import_export.snapshot import Winner

    def payload(**props):
        return json.dumps({"edgeType": "FLOWS_TO", "properties": props})
    rows = [("E1", payload(owner="b"), None), ("E2", payload(owner="b"), None), ("E3", payload(owner="b"), None),
            ("E4", payload(owner="b"), None)]
    before = {"E1": {"properties": {"owner": "a"}}, "E2": {"properties": {"owner": "a"}},
              "E3": {"properties": {}}, "E4": {"properties": {"owner": "a"}}}
    current = {"E1": Winner("E1", True, payload=payload(owner="b", tier=1)),
               "E2": Winner("E2", True, payload=payload(owner="c")),
               "E3": Winner("E3", True, payload=payload())}
    (ops, counts, refused), urns = pj.plan_undo_window(rows, before, current, "edge")
    assert ops == [
        {"op": "update", "entity_kind": "edge", "entity_id": "E1", "payload": {"properties": {"owner": "a"}}}]
    assert {k: v for k, v in counts.items() if v} == {"changed": 1, "unchanged": 1, "changedSince": 1,
                                                      "deletedInDraft": 1}
    assert [(r["entityId"], r["reason"]) for r in refused] == [("E2", "changed_since"), ("E4", "deleted_in_draft")]
    assert urns == {"E1": None, "E2": None, "E3": None, "E4": None}


def test_an_undo_is_named_after_what_it_undoes():
    undo = {"kind": "undo", "key": "owner", "to": "steward", "sourceJobId": "vjob_1",
            "sourceLabel": "Rename owner → steward"}
    assert pj.describe(undo) == "Undo: Rename owner → steward"
    assert pj.window_message(undo, None, 1, 2) == "Bulk property: Undo: Rename owner → steward (1/2)"


class _Store:
    """An object store in memory."""

    def __init__(self):
        self.blobs = {}

    async def put_stream(self, key, chunks):
        self.blobs[key] = b"".join([c async for c in chunks])

    async def open_stream(self, key):
        yield self.blobs[key]

    async def stat(self, key):
        return type("Stat", (), {"exists": key in self.blobs})()

    async def delete(self, key):
        self.blobs.pop(key, None)


async def test_targets_are_kept_a_window_a_file(monkeypatch):
    monkeypatch.setattr(config, "PROPERTY_JOB_WINDOW", 2)
    store = _Store()
    assert await pj.write_targets(store, "vjob_1", ["a", "b", "c"]) == 2
    assert await pj.read_lines(store, pj.targets_key("vjob_1", 1)) == ["c"]
    assert pj.targets_key("vjob_1", 0) == "property-jobs/vjob_1/targets/0.ndjson"


async def test_the_refused_rows_read_as_csv_and_never_as_a_formula():
    store = _Store()
    await pj.write_lines(store, pj.refused_key("vjob_1", 1), [
        {"urn": "=HYPERLINK(1)", "entityId": "E1", "reason": "write_refused", "detail": "a, b"}])
    body = b"".join([c async for c in pj.refused_csv(store, "vjob_1", 2)]).decode()
    assert body.splitlines() == ["urn,entityId,reason,detail", "'=HYPERLINK(1),E1,write_refused,\"a, b\""]


# ── the request ───────────────────────────────────────────────────────────────
@pytest.fixture(scope="module")
def V():
    from backend.app.api.v1.endpoints import versioning
    return versioning


def _request(V, op, target=None):
    return V.PropertyJobRequest.model_validate(
        {"op": op, "target": {"ids": ["urn:a", "urn:b"]} if target is None else target})


def test_an_op_says_everything_its_kind_needs(V):
    for bad in ({"kind": "rename", "key": "owner"}, {"kind": "copy", "key": "owner"},
                {"kind": "set", "key": "owner"}, {"kind": "fillEmpty", "key": "owner", "value": ""},
                {"kind": "fillEmpty", "key": "owner", "value": None},
                {"kind": "set", "key": "owner", "value": "x" * (64 * 1024)},
                {"kind": "set", "key": "", "value": 1}, {"kind": "set", "key": "k" * 129, "value": 1},
                {"kind": "drop", "key": "owner"}):
        with pytest.raises(ValidationError):
            _request(V, bad)
    op = _request(V, {"kind": "set", "key": "owner", "value": None, "to": "ignored"}).op
    assert op.wire() == {"kind": "set", "key": "owner", "onConflict": "skip", "value": None}


def test_a_target_is_ids_or_a_search_in_a_view(V):
    pred = {"kind": "hasProperty", "key": "owner"}
    for bad in ({}, {"ids": []}, {"ids": ["a"], "viewId": "v", "predicate": pred}, {"predicate": pred}):
        with pytest.raises(ValidationError):
            _request(V, {"kind": "remove", "key": "owner"}, bad)
    target = _request(V, {"kind": "remove", "key": "owner"},
                      {"viewId": "v1", "predicate": pred, "scopeMode": "data_source"}).target
    assert target.wire()["scopeMode"] == "data_source" and target.wire()["predicate"]["key"] == "owner"


def _code(V, op, target=None, rules=None):
    body = _request(V, op, target)
    refusal = V._check_property_job(body.op, body.target, rules)
    return refusal and refusal[:2]


def test_what_a_job_refuses_before_it_is_made(V):
    pred = {"kind": "hasProperty", "key": "owner"}
    assert _code(V, {"kind": "set", "key": "displayName", "value": "x"}) == (422, "reserved_key")
    assert _code(V, {"kind": "rename", "key": "owner", "to": "urn"}) == (422, "reserved_key")
    assert _code(V, {"kind": "copy", "key": "owner", "to": "owner"}) == (422, "same_key")
    assert _code(V, {"kind": "remove", "key": "owner"},
                 {"ids": [f"u{i}" for i in range(config.PROPERTY_JOB_MAX_IDS + 1)]}) == (422, "too_many_ids")
    assert _code(V, {"kind": "remove", "key": "owner"},
                 {"viewId": "v", "predicate": pred, "scopeMode": "visible"}) == (422, "visible_scope")
    assert _code(V, {"kind": "rename", "key": "owner", "to": "steward"}) is None


def test_one_value_for_a_unique_field_is_refused_on_more_than_one_entity(V):
    rules = OntologyRules(entity_types={"Dataset": EntityRule(unique_fields=frozenset({"code"}))})
    pred = {"kind": "hasProperty", "key": "code"}
    assert _code(V, {"kind": "set", "key": "code", "value": "X"}, rules=rules) == (422, "unique_field")
    assert _code(V, {"kind": "fillEmpty", "key": "code", "value": "X"},
                 {"viewId": "v", "predicate": pred}, rules=rules) == (422, "unique_field")
    assert _code(V, {"kind": "copy", "key": "owner", "to": "code"}, rules=rules) == (422, "unique_field")
    assert _code(V, {"kind": "set", "key": "code", "value": "X"}, {"ids": ["urn:a"]}, rules=rules) is None
    assert _code(V, {"kind": "remove", "key": "code"}, rules=rules) is None
    assert _code(V, {"kind": "set", "key": "code", "value": "X"}) is None          # no ontology


def test_what_publishing_would_refuse_is_warned_never_refused(V):
    from backend.app.services.versioning.ontology import FieldRule
    rules = OntologyRules(entity_types={"Dataset": EntityRule(fields={
        "tier": FieldRule(type="status", allowed=("gold", "silver"), name="Tier"),
        "owner": FieldRule(required=True, name="Owner"),
        "rows": FieldRule(type="number", name="Rows")})})

    def warned(op):
        body = _request(V, op)
        assert V._check_property_job(body.op, body.target, rules) is None      # never a refusal
        return [(w["code"], w["entityType"], w["field"]) for w in V._property_job_warnings(body.op, rules)]

    assert warned({"kind": "set", "key": "tier", "value": "bronze"}) == [("field_not_allowed", "Dataset", "tier")]
    assert warned({"kind": "fillEmpty", "key": "rows", "value": "many"}) == [("field_type", "Dataset", "rows")]
    assert warned({"kind": "set", "key": "tier", "value": "gold"}) == []
    assert warned({"kind": "remove", "key": "owner"}) == [("field_required", "Dataset", "owner")]
    assert warned({"kind": "rename", "key": "owner", "to": "steward"}) == [("field_required", "Dataset", "owner")]
    assert warned({"kind": "copy", "key": "label", "to": "tier"}) == [("field_checked", "Dataset", "tier")]
    assert warned({"kind": "set", "key": "other", "value": "x"}) == []
    assert V._property_job_warnings(_request(V, {"kind": "remove", "key": "owner"}).op, None) == []


def test_a_job_over_relationships_is_warned_by_the_relationship_types_fields(V):
    """Named as the ontology spells the type — the rules key edge types in capitals."""
    from backend.app.services.versioning.ontology import EdgeRule, FieldRule
    rules = OntologyRules(
        entity_types={"Dataset": EntityRule(fields={"tier": FieldRule(type="status", allowed=("x",))})},
        edge_types={"OWNS": EdgeRule(fields={
            "tier": FieldRule(type="status", allowed=("gold", "silver"), name="Tier"),
            "since": FieldRule(type="date", required=True, name="Since")}), "FLOWS_TO": EdgeRule()},
        edge_type_canonical={"OWNS": "Owns", "FLOWS_TO": "FLOWS_TO"})

    def warned(op):
        body = _request(V, op, {"edgeIds": ["e1", "e2"]})
        assert V._check_property_job(body.op, body.target, rules) is None      # never a refusal
        return V._property_job_warnings(body.op, rules, edges=True)

    [tier] = warned({"kind": "set", "key": "tier", "value": "bronze"})
    assert (tier["code"], tier["entityType"], tier["field"]) == ("field_not_allowed", "Owns", "tier")
    assert tier["message"].endswith("A Owns relationship given it can't be published until it holds a value "
                                    "the field allows.")
    assert [(w["code"], w["field"]) for w in warned({"kind": "remove", "key": "since"})] == [("field_required", "since")]
    assert [w["code"] for w in warned({"kind": "copy", "key": "note", "to": "since"})] == ["field_checked"]
    assert warned({"kind": "set", "key": "tier", "value": "gold"}) == []


def test_the_job_keeps_its_op_as_the_plan_reads_it(V):
    op = _request(V, {"kind": "rename", "key": "owner", "to": "steward", "onConflict": "overwrite",
                      "value": "ignored"}).op.wire()
    assert op == {"kind": "rename", "key": "owner", "to": "steward", "onConflict": "overwrite"}
    assert pj.plan_patch(op, {"owner": 1, "steward": 2}) == {"steward": 1, "owner": PROP_DELETE}
    json.dumps(op)


def test_a_clean_up_says_everything_its_kind_needs(V):
    for bad in ({"kind": "replace", "key": "k", "replaceWith": "x"},
                {"kind": "replace", "key": "k", "find": "x"},
                {"kind": "replace", "key": "k", "find": "", "replaceWith": "x"},
                {"kind": "replace", "key": "k", "find": "x" * 257, "replaceWith": ""},
                {"kind": "normalize", "key": "k", "trim": False},
                {"kind": "normalize", "key": "k", "case": "camel"},
                {"kind": "mapValues", "key": "k"}, {"kind": "mapValues", "key": "k", "map": []},
                {"kind": "mapValues", "key": "k", "map": [{"from": "a", "to": "b"}, {"from": "a", "to": "c"}]},
                {"kind": "mapValues", "key": "k", "map": [{"from": None, "to": "b"}]},
                {"kind": "mapValues", "key": "k", "map": [{"from": ["a"], "to": "b"}]},
                {"kind": "mapValues", "key": "k", "map": [{"from": "a", "fromKind": "Integer", "to": "b"}]},
                {"kind": "mapValues", "key": "k", "map": [{"from": 1.5, "fromKind": "Integer", "to": "b"}]},
                {"kind": "mapValues", "key": "k", "map": [{"from": f"v{i}", "to": "x"} for i in range(1001)]},
                {"kind": "convert", "key": "k"}, {"kind": "convert", "key": "k", "toKind": "Date"},
                {"kind": "convert", "key": "k", "toKind": "Integer", "onFail": "keep"}):
        with pytest.raises(ValidationError):
            _request(V, bad)


def test_a_clean_up_is_kept_with_every_choice_it_makes(V):
    wire = lambda op: _request(V, op).op.wire()
    assert wire({"kind": "replace", "key": "dept", "find": "Fin", "replaceWith": "", "value": "ignored"}) == {
        "kind": "replace", "key": "dept", "onConflict": "skip", "find": "Fin", "replaceWith": "",
        "matchCase": False, "wholeValue": False}
    assert wire({"kind": "normalize", "key": "dept", "case": "lower"}) == {
        "kind": "normalize", "key": "dept", "onConflict": "skip", "trim": True, "collapseSpaces": False,
        "case": "lower", "dedupeList": False}
    # Each value's kind is kept with it — a whole decimal stays one, though JSON writes it as 1.
    assert wire({"kind": "mapValues", "key": "n", "map": [
        {"from": 1, "fromKind": "Float", "to": "one"}, {"from": "finance ", "to": "Finance"}]}) == {
        "kind": "mapValues", "key": "n", "onConflict": "skip", "dedupeList": True, "map": [
            {"from": 1.0, "fromKind": "Float", "to": "one", "toKind": "String"},
            {"from": "finance ", "fromKind": "String", "to": "Finance", "toKind": "String"}]}
    assert wire({"kind": "convert", "key": "tier", "toKind": "Integer", "onFail": "remove", "to": "x"}) == {
        "kind": "convert", "key": "tier", "onConflict": "skip", "toKind": "Integer", "onFail": "remove"}
    json.dumps(wire({"kind": "mapValues", "key": "n", "map": [{"from": 1, "fromKind": "Float", "to": 2.5}]}))


def test_merging_values_of_a_unique_field_into_one_is_refused_on_several_entities(V):
    rules = OntologyRules(entity_types={"Dataset": EntityRule(unique_fields=frozenset({"code"}))})
    merge = {"kind": "mapValues", "key": "code", "map": [{"from": "a", "to": "A"}, {"from": "a ", "to": "A"}]}
    assert _code(V, merge, rules=rules) == (422, "unique_field")
    assert _code(V, merge, {"ids": ["urn:a"]}, rules=rules) is None
    # One value to another, or a normalize, may not collide: publishing refuses what does.
    assert _code(V, {**merge, "map": [{"from": "a", "to": "A"}, {"from": "b", "to": "B"}]}, rules=rules) is None
    assert _code(V, {"kind": "normalize", "key": "code", "case": "upper"}, rules=rules) is None
    assert _code(V, {"kind": "replace", "key": "displayName", "find": "a", "replaceWith": "b"}) == (422, "reserved_key")


def test_a_publish_lists_a_job_by_what_it_did_who_ran_it_and_why():
    from types import SimpleNamespace
    big = [{"from": f"v{i}", "fromKind": "String", "to": "V", "toKind": "String"} for i in range(80)]
    job = SimpleNamespace(
        id="vjob_1", status="completed", created_at="2026-11-21T10:00:00Z",
        field_scope={"actor": "usr_ana", "key": "k1", "message": "Merge the Finance spellings",
                     "op": {"kind": "mapValues", "key": "dept", "map": big, "dedupeList": True}},
        summary={"changed": 27110, "refused": {"count": 3}, "commits": 3, "firstCommitId": "cmt_1",
                 "lastCommitId": "cmt_3"})
    entry = pj.audit_entry(job)
    assert {k: v for k, v in entry.items() if k != "op"} == {
        "jobId": "vjob_1", "label": "Merge 80 values of dept", "changed": 27110, "refused": 3,
        "status": "completed", "actor": "usr_ana", "message": "Merge the Finance spellings",
        "createdAt": "2026-11-21T10:00:00Z", "firstCommitId": "cmt_1", "lastCommitId": "cmt_3"}
    assert len(entry["op"]["map"]) == 50 and entry["op"]["mapSize"] == 80
    assert pj.audit_entry(job, partial=True)["partial"] is True
    job.field_scope["op"] = {"kind": "set", "key": "blob", "value": "x" * 2000}
    assert "value" not in pj.audit_entry(job)["op"] and pj.audit_entry(job)["label"] == "Set blob"
    assert pj.window_messages({"kind": "remove", "key": "k"}, None, 2) == [
        "Bulk property: Remove k (1/2)", "Bulk property: Remove k (2/2)"]


# ── the property-name budget ──────────────────────────────────────────────────
class _Falkor:
    def __init__(self, count, names=()):
        self.count, self.names = count, set(names)

    async def property_key_count(self):
        return self.count

    async def _registered_property_names(self, *, fresh=True):
        return self.names


async def _budget(monkeypatch, V, provider, op):
    from types import SimpleNamespace
    from backend.app.services.view_transfer import sources

    async def engine_for(*_a, **_kw):
        if provider is None:
            raise RuntimeError("no provider for this data source")
        return SimpleNamespace(provider=provider)
    monkeypatch.setattr(sources, "engine_for", engine_for)
    monkeypatch.setenv("FALKORDB_NATIVE_PROPERTY_BUDGET", "1000")
    body = _request(V, op)
    return await V._property_name_budget(None, "ws1", {"data_source_id": "ds1"}, body.op)


async def test_a_new_key_near_the_name_ceiling_is_refused_and_past_the_budget_stored_raw(monkeypatch, V):
    rename = {"kind": "rename", "key": "owner", "to": "steward"}
    budget = await _budget(monkeypatch, V, _Falkor(10, {"owner"}), rename)
    assert budget == {"registered": 10, "nativeBudget": 1000, "ceiling": 65_534, "isNew": True, "verdict": "ok"}
    assert (await _budget(monkeypatch, V, _Falkor(5000), rename))["verdict"] == "raw"
    assert (await _budget(monkeypatch, V, _Falkor(65_534 - 256), rename))["verdict"] == "refused"
    # A name the graph holds already costs nothing, however full it is.
    held = await _budget(monkeypatch, V, _Falkor(65_534, {"steward"}), rename)
    assert (held["isNew"], held["verdict"]) == (False, "ok")
    # Through a write-through wrapper, to the store it wraps.
    from types import SimpleNamespace
    wrapped = await _budget(monkeypatch, V, SimpleNamespace(_inner=_Falkor(65_534 - 1)), rename)
    assert wrapped["verdict"] == "refused"
    removal = await _budget(monkeypatch, V, _Falkor(65_534), {"kind": "remove", "key": "owner"})
    assert (removal["isNew"], removal["verdict"]) == (False, "ok")


async def test_a_store_that_wont_say_never_refuses(monkeypatch, V):
    from types import SimpleNamespace
    set_op = {"kind": "set", "key": "tier", "value": 1}
    for provider in (None, SimpleNamespace(), _Falkor(None)):
        budget = await _budget(monkeypatch, V, provider, set_op)
        assert budget["verdict"] == "ok" and budget["registered"] is None and budget["isNew"] is None, budget


# ── a search target, resolved where the job runs ─────────────────────────────
def _search_hook(monkeypatch, *, refuse=None):
    """``_property_targets_from_job`` over a stub search: two requests to export, then a file of
    NDJSON lines cut mid-line."""
    import contextlib
    from types import SimpleNamespace

    from backend.app.api.v1.endpoints import graph as graph_ep
    from backend.app.db import engine as db_engine
    from backend.app.services import advanced_search_service, search_downloads
    from backend.app.services.view_transfer import sources
    from backend.common.models.search import SearchExportResult

    seen = {"exports": []}

    class Search:
        def __init__(self, engine, **kw):
            seen["can_read"] = kw["can_read_view"]

        async def export(self, request, *, principal, signing_key, run_context):
            if refuse:
                raise advanced_search_service.ValidationError(refuse)
            seen["exports"].append(request.session_id)
            if request.session_id is None:
                return SearchExportResult(session_id="s1", status="running", format="ndjson")
            token = search_downloads.mint_download_token("s1", "scope-h", principal, signing_key)
            return SearchExportResult(session_id="s1", status="complete", format="ndjson",
                                      download_token=token)

        async def open_export(self, session_id, scope_hash):
            seen["opened"] = (session_id, scope_hash)

            async def body():
                yield b'{"urn": "urn:a"}\n{"ur'
                yield b'n": "urn:b"}\n{"urn": null}\n{"urn": "urn:c"}'
            return SimpleNamespace(), body()

    @contextlib.asynccontextmanager
    async def session():
        async def commit():
            return None
        yield SimpleNamespace(commit=commit)

    async def engine_for(*_a, **_kw):
        return SimpleNamespace()

    async def data_version(_engine):
        return "dv1"

    monkeypatch.setattr(advanced_search_service, "AdvancedSearchService", Search)
    monkeypatch.setattr(db_engine, "get_async_session", session)
    monkeypatch.setattr(sources, "engine_for", engine_for)
    monkeypatch.setattr(graph_ep, "_search_data_version", data_version)
    monkeypatch.setattr(graph_ep, "_statement_admission", lambda _engine: None)
    return seen


_SEARCH_JOB = {"target": {"kind": "predicate", "viewId": "v1", "scopeMode": "view",
                          "predicate": {"kind": "hasProperty", "key": "owner"}},
               "workspaceId": "ws1", "dataSourceId": "ds1", "branchId": "b1", "actor": "alice"}


async def test_a_search_target_reads_every_match_of_its_export(monkeypatch, V):
    from types import SimpleNamespace
    seen = _search_hook(monkeypatch)
    assert [urn async for urn in V._property_targets_from_job(_SEARCH_JOB)] == ["urn:a", "urn:b", "urn:c"]
    assert seen["exports"] == [None, "s1"] and seen["opened"] == ("s1", "scope-h")
    view = SimpleNamespace(id="v1", workspace_id="ws1", data_source_id="ds1")
    assert await seen["can_read"](view)
    for other in ({"id": "v2"}, {"workspace_id": "ws2"}, {"data_source_id": "ds2"}):
        assert not await seen["can_read"](SimpleNamespace(**{**vars(view), **other}))


async def test_a_search_matching_too_much_stops_before_its_export_is_whole(monkeypatch, V):
    """The export is followed a few seconds a request, and the job stops once it has written more
    rows than a job edits — not once it has written them all, and never reading them."""
    from backend.app.services import advanced_search_service
    from backend.common.models.search import SearchExportResult

    seen = _search_hook(monkeypatch)
    monkeypatch.setattr(config, "PROPERTY_JOB_MAX_TARGETS", 10)

    class Growing(advanced_search_service.AdvancedSearchService):
        async def export(self, request, *, principal, signing_key, run_context):
            seen["exports"].append((request.session_id, request.wait_ms))
            rows = 6 * len(seen["exports"])
            return SearchExportResult(session_id="s1", status="running", format="ndjson", rows=rows)

        async def open_export(self, session_id, scope_hash):
            raise AssertionError("a search matching too much is never read")
    monkeypatch.setattr(advanced_search_service, "AdvancedSearchService", Growing)
    with pytest.raises(pj.PropertyJobStopped) as stopped:
        [urn async for urn in V._property_targets_from_job(_SEARCH_JOB)]
    assert stopped.value.code == "too_many_targets" and "more than 10 entities" in str(stopped.value)
    assert seen["exports"] == [(None, 5000), ("s1", 5000)]          # 6 rows, then 12: stopped


async def test_a_search_the_engine_refuses_stops_the_job_saying_why(monkeypatch, V):
    _search_hook(monkeypatch, refuse="view_not_found: view 'v1' not found")
    with pytest.raises(pj.PropertyJobStopped) as stopped:
        [urn async for urn in V._property_targets_from_job(_SEARCH_JOB)]
    assert stopped.value.code == "search_refused" and "view_not_found" in str(stopped.value)


# ── relationships: an edge job ───────────────────────────────────────────────
def test_an_edge_window_writes_edge_updates():
    found = {"e1": ("e1", {"owner": "x"}, None), "e2": ("edge:e2", {}, None)}
    ops, counts, refused = pj.plan_window(_op("set", value="ana"), found, "edge")
    assert ops == [{"op": "update", "entity_kind": "edge", "entity_id": eid,
                    "payload": {"properties": {"owner": "ana"}}} for eid in ("e1", "edge:e2")]
    assert counts["changed"] == 2 and refused == []


def test_an_edge_is_named_by_its_id_or_as_a_search_names_one_without():
    assert pj._triple("urn:a|FLOWS_TO|urn:b") == ("urn:a", "FLOWS_TO", "urn:b")
    for not_one in ("e1", "edge:e1", "a|b", "a||b", "a|b|c|d"):
        assert pj._triple(not_one) is None


def test_a_target_names_relationships_by_id_or_by_a_connections_search(V):
    op = {"kind": "remove", "key": "owner"}
    edges = {"kind": "edges", "edgeTypes": ["FLOWS_TO"]}
    for bad in ({"edgeIds": []}, {"ids": ["a"], "edgeIds": ["e"]},
                {"edgeIds": ["e"], "viewId": "v", "predicate": edges}):
        with pytest.raises(ValidationError):
            _request(V, op, bad)
    named = _request(V, op, {"edgeIds": ["e1", "urn:a|FLOWS_TO|urn:b"]}).target
    assert named.entity_kind == "edge" and named.wire() == {"ids": ["e1", "urn:a|FLOWS_TO|urn:b"]}
    for pred in (edges, {"kind": "group", "op": "and", "children": [edges]}):
        assert _request(V, op, {"viewId": "v", "predicate": pred}).target.entity_kind == "edge"
    assert _request(V, op).target.entity_kind == "node"
    assert _request(V, op, {"viewId": "v", "predicate": {"kind": "all"}}).target.entity_kind == "node"


def test_what_an_edge_job_refuses_before_it_is_made(V):
    ids = {"edgeIds": ["e1", "e2"]}
    search = {"viewId": "v", "predicate": {"kind": "edges"}}
    # An edge's own fields, not an entity's, are the platform's.
    for key in ("confidence", "id", "gvHash"):
        assert _code(V, {"kind": "set", "key": key, "value": 1}, ids) == (422, "reserved_key")
    assert _code(V, {"kind": "rename", "key": "owner", "to": "weight"}, search) == (422, "reserved_key")
    assert _code(V, {"kind": "set", "key": "displayName", "value": "x"}, ids) is None
    assert _code(V, {"kind": "remove", "key": "owner"}, search) is None
    assert _code(V, {"kind": "remove", "key": "owner"},
                 {"edgeIds": [f"e{i}" for i in range(config.PROPERTY_JOB_MAX_IDS + 1)]}) == (422, "too_many_ids")
    # A unique field is an entity type's: a relationship's properties have none.
    rules = OntologyRules(entity_types={"Dataset": EntityRule(unique_fields=frozenset({"code"}))})
    assert _code(V, {"kind": "set", "key": "code", "value": "X"}, ids, rules=rules) is None
    assert _code(V, {"kind": "set", "key": "code", "value": "X"}, search, rules=rules) is None


async def test_an_edge_key_costs_the_graph_no_property_name(monkeypatch, V):
    """An edge keeps its user properties in one JSON text: however full the graph's names, a new
    edge key is ok — and the store isn't asked."""
    from backend.app.services.view_transfer import sources

    async def engine_for(*_a, **_kw):
        raise AssertionError("an edge key needs no name budget")
    monkeypatch.setattr(sources, "engine_for", engine_for)
    body = _request(V, {"kind": "set", "key": "brand-new", "value": 1}, {"edgeIds": ["e1"]})
    budget = await V._property_name_budget(None, "ws1", {"data_source_id": "ds1"}, body.op, edges=True)
    assert (budget["verdict"], budget["isNew"], budget["registered"]) == ("ok", False, None)


async def test_a_connections_search_target_reads_each_edge_id(monkeypatch, V):
    from types import SimpleNamespace
    from backend.app.services import advanced_search_service

    seen = _search_hook(monkeypatch)
    Search = advanced_search_service.AdvancedSearchService

    class EdgeSearch(Search):
        async def open_export(self, session_id, scope_hash):
            async def body():
                yield b'{"edgeId": "e1", "urn": null}\n{"edgeId": "urn:a|FLOWS_TO|urn:b"}\n{"edgeId": null}\n'
            return SimpleNamespace(), body()
    monkeypatch.setattr(advanced_search_service, "AdvancedSearchService", EdgeSearch)
    job = {**_SEARCH_JOB, "entityKind": "edge",
           "target": {**_SEARCH_JOB["target"], "predicate": {"kind": "edges"}}}
    assert [k async for k in V._property_targets_from_job(job)] == ["e1", "urn:a|FLOWS_TO|urn:b"]
    assert seen["exports"] == [None, "s1"]
