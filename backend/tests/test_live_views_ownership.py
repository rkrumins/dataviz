"""Who owns which entry of a view made from a query, through every write.

The server owns whether its entries (``assignedBy: "query"``) exist and whether
they cascade; people own where those entries sit, and every entry they placed
themselves.
"""
import pytest

from backend.app.services.live_views import ownership
from backend.app.services.live_views.ownership import (
    MemberOpError,
    apply_member_ops,
    carry_machine_entries,
    reconcile_layout_write,
    reconcile_promote,
    remember,
)
from backend.common.models.view_membership import MACHINE, MemberOps

L = ["L1", "L2", "L3"]


def m(layer, **kw):
    return {"layerId": layer, "inheritsChildren": False, "assignedBy": MACHINE, **kw}


def u(layer, **kw):
    return {"layerId": layer, "inheritsChildren": True, "assignedBy": "user", **kw}


# ── A canvas save ───────────────────────────────────────────────────────────


def test_a_save_from_a_stale_canvas_keeps_the_members_that_arrived_since():
    stored = {"new": m("L1"), "mine": u("L2")}
    sent = {"mine": u("L3")}                          # the client never saw "new"
    out = reconcile_layout_write(stored, sent, layer_ids=L, fallback_layer_id=None, record_overrides=True)
    assert out.assignments == {"mine": u("L3"), "new": m("L1")}


def test_echoes_of_members_that_left_and_invented_server_entries_are_dropped():
    stored = {"kept": m("L1")}
    sent = {"kept": m("L1"), "left": m("L2"), "forged": {"layerId": "L1", "assignedBy": MACHINE}}
    out = reconcile_layout_write(stored, sent, layer_ids=L, fallback_layer_id=None, record_overrides=True)
    assert set(out.assignments) == {"kept"}


def test_moving_a_member_is_remembered_and_its_cascade_is_the_servers():
    stored = {"x": m("L1")}
    sent = {"x": {"layerId": "L2", "orderKey": "a1", "inheritsChildren": True, "assignedBy": "user"}}
    out = reconcile_layout_write(stored, sent, layer_ids=L, fallback_layer_id=None, record_overrides=True, now="t1")
    assert out.assignments["x"] == m("L2", orderKey="a1")
    assert out.overrides == {"x": {"layerId": "L2", "orderKey": "a1", "at": "t1"}}


def test_a_drafts_moves_are_not_remembered_until_it_is_published():
    stored = {"x": m("L1")}
    out = reconcile_layout_write(stored, {"x": m("L2")}, layer_ids=L, fallback_layer_id=None, record_overrides=False)
    assert out.assignments["x"]["layerId"] == "L2" and out.overrides == {}


def test_a_member_whose_layer_was_deleted_waits_in_the_fallback():
    stored = {"x": m("gone", orderKey="z")}
    out = reconcile_layout_write(stored, {"x": m("gone", orderKey="z")}, layer_ids=L, fallback_layer_id="L3",
                                 record_overrides=True)
    assert out.assignments["x"] == m("L3") and out.replace_needed


# ── A draft published ───────────────────────────────────────────────────────


def test_publishing_a_draft_keeps_its_moves_and_takes_the_servers_members():
    fork = {"a": m("L1"), "stale": m("L1"), "mine": u("L2")}
    published = {"a": m("L1"), "fresh": m("L2", inheritsChildren=True), "mine": u("L2")}   # "stale" left
    draft = {"a": m("L3"), "stale": m("L1"), "mine": u("L2"), "hand": u("L1")}
    merged = {"a": m("L3"), "stale": m("L1"), "fresh": m("L2"), "mine": u("L2"), "hand": u("L1")}
    out = reconcile_promote(merged, fork=fork, published=published, draft=draft,
                            layer_ids=L, fallback_layer_id=None, now="t2")
    assert out.assignments == {
        "a": m("L3"), "fresh": m("L2", inheritsChildren=True), "mine": u("L2"), "hand": u("L1"),
    }
    assert out.overrides == {"a": {"layerId": "L3", "at": "t2"}}


def test_a_member_the_draft_placed_by_hand_is_theirs():
    published = {"a": m("L1")}
    merged = {"a": u("L2")}
    out = reconcile_promote(merged, fork={"a": m("L1")}, published=published, draft={"a": u("L2")},
                            layer_ids=L, fallback_layer_id=None)
    assert out.assignments == {"a": u("L2")}


# ── A design replaced (restore, import) ─────────────────────────────────────


def test_a_restored_design_keeps_the_members_until_the_next_update():
    old = {"a": m("L1"), "b": m("gone"), "mine": u("L2")}
    new = {"mine2": u("L1"), "b": u("L2")}            # a version holds no members; "b" placed by hand
    out = carry_machine_entries(new, old, layer_ids=L, fallback_layer_id="L3")
    assert out.assignments == {"mine2": u("L1"), "b": u("L2"), "a": m("L1")}
    assert not out.replace_needed


# ── Keep out, bring back, always include ────────────────────────────────────


def test_excluding_takes_it_out_and_keeps_it_out():
    out, exclude = apply_member_ops({"a": m("L1"), "b": u("L2")}, ["z"], MemberOps(exclude=["a", "b"]), layer_ids=L)
    assert out == {} and exclude == ["z", "a", "b"]


def test_bringing_back_lets_the_query_decide_again():
    _, exclude = apply_member_ops({}, ["a", "b"], MemberOps(unexclude=["a"]), layer_ids=L)
    assert exclude == ["b"]


def test_always_including_a_member_makes_it_the_persons_and_keeps_its_place():
    out, _ = apply_member_ops({"a": m("L1", orderKey="k")}, [],
                              MemberOps(include=[{"urn": "a", "layerId": "L1"}]), layer_ids=L)
    assert out["a"] == {"layerId": "L1", "inheritsChildren": False, "orderKey": "k", "assignedBy": "user"}


def test_always_including_something_new_places_it_by_hand_and_unexcludes_it():
    out, exclude = apply_member_ops({}, ["n"], MemberOps(include=[{"urn": "n", "layerId": "L2"}]),
                                    layer_ids=L, now="t3")
    assert out["n"] == {"layerId": "L2", "inheritsChildren": True, "assignedBy": "user", "assignedAt": "t3"}
    assert exclude == []


def test_always_including_into_a_layer_that_is_gone_is_refused():
    with pytest.raises(MemberOpError):
        apply_member_ops({}, [], MemberOps(include=[{"urn": "n", "layerId": "nope"}]), layer_ids=L)


def test_stopping_drops_only_what_a_person_placed():
    out, _ = apply_member_ops({"a": u("L1"), "b": m("L1")}, [], MemberOps(uninclude=["a", "b"]), layer_ids=L)
    assert out == {"b": m("L1")}


def test_keeping_out_is_bounded(monkeypatch):
    monkeypatch.setattr(ownership, "EXCLUDE_MAX", 2)
    with pytest.raises(MemberOpError):
        apply_member_ops({}, ["a", "b"], MemberOps(exclude=["c"]), layer_ids=L)


def test_remembered_placements_forget_the_oldest_past_the_limit(monkeypatch):
    monkeypatch.setattr(ownership, "OVERRIDES_MAX", 2)
    kept = remember({"a": {"at": "1"}, "b": {"at": "3"}}, {"c": {"at": "2"}})
    assert set(kept) == {"b", "c"}
