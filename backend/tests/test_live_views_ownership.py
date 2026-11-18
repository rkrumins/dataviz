"""Who owns which entry of a view made from a query, through every write.

The server owns its members (rows of ``view_members``): whether each is in and whether it
cascades. People own where a member sits — an entry a canvas save sends for one is a move,
remembered and applied to the member, never stored — and every entry they placed themselves.
"""
import pytest

from backend.app.services.live_views import ownership
from backend.app.services.live_views.ownership import (
    MemberOpError,
    apply_member_ops,
    carry_into_config,
    reconcile_layout_write,
    reconcile_promote,
    remember,
    take_members,
)
from backend.common.models.view_membership import MACHINE, MemberOps

L = ["L1", "L2", "L3"]


def m(layer, **kw):
    return {"layerId": layer, "inheritsChildren": False, "assignedBy": MACHINE, **kw}


def u(layer, **kw):
    return {"layerId": layer, "inheritsChildren": True, "assignedBy": "user", **kw}


def at(layer, **kw):
    """A member's row, as the member table reads it (assignment-shaped)."""
    return {"layerId": layer, "inheritsChildren": False, **kw}


def write(stored, sent, members, **kw):
    kw.setdefault("record_overrides", True)
    return reconcile_layout_write(stored, sent, members=members, layer_ids=L,
                                  fallback_layer_id=kw.pop("fallback", None), **kw)


# ── A canvas save ───────────────────────────────────────────────────────────


def test_a_save_stores_only_what_people_placed():
    out = write({"mine": u("L2")}, {"mine": u("L3"), "a": m("L1")}, {"a": at("L1")})
    assert out.assignments == {"mine": u("L3")}
    assert out.moves == {} and out.overrides == {}, "a member sent back where it is moved nowhere"


def test_echoes_of_members_that_left_and_invented_server_entries_are_dropped():
    out = write({}, {"left": m("L2"), "forged": {"layerId": "L1", "assignedBy": MACHINE}, "new": u("L1")}, {})
    assert out.assignments == {"new": u("L1")}


def test_moving_a_member_is_remembered_and_applied_and_its_cascade_stays_the_servers():
    sent = {"x": {"layerId": "L2", "orderKey": "a1", "inheritsChildren": True, "assignedBy": "user"}}
    out = write({}, sent, {"x": at("L1")}, now="t1")
    assert out.assignments == {}, "a member is never a person's entry"
    assert out.moves == {"x": {"layerId": "L2", "orderKey": "a1"}}
    assert out.overrides == {"x": {"layerId": "L2", "orderKey": "a1", "at": "t1"}}


def test_a_persons_own_entry_for_a_member_stays_theirs():
    out = write({"x": u("L1")}, {"x": u("L3")}, {"x": at("L1")})
    assert out.assignments == {"x": u("L3")} and out.moves == {}


def test_a_member_moved_to_a_layer_that_is_gone_waits_in_the_fallback():
    out = write({}, {"x": {"layerId": "gone", "orderKey": "z"}}, {"x": at("L1")}, fallback="L3")
    assert out.moves == {"x": {"layerId": "L3"}}


def test_a_drafts_moves_are_its_own_entries_until_it_is_published():
    members = {"x": at("L1"), "y": at("L1")}
    out = write({}, {"x": m("L2"), "y": m("L1")}, members, record_overrides=False)
    assert out.assignments == {"x": m("L2")}, "only a move is kept; one where it is says nothing"
    assert out.overrides == {} and out.moves == {}
    again = write(out.assignments, {}, members, record_overrides=False)
    assert again.assignments == {"x": m("L2")}, "a draft's move the client did not echo is still its own"


# ── A draft published ───────────────────────────────────────────────────────


def test_publishing_a_draft_applies_its_moves_and_drops_its_members_that_left():
    fork = {"copied": m("L1"), "mine": u("L2")}             # a draft opened before members had a table
    draft = {"a": m("L3"), "copied": m("L1"), "left": m("L2"), "mine": u("L2"), "hand": u("L1")}
    merged = {"a": m("L3"), "copied": m("L1"), "left": m("L2"), "mine": u("L2"), "hand": u("L1")}
    members = {"a": at("L1"), "copied": at("L2")}
    out = reconcile_promote(merged, fork=fork, draft=draft, members=members, layer_ids=L,
                            fallback_layer_id=None, now="t2")
    assert out.assignments == {"mine": u("L2"), "hand": u("L1")}
    assert out.moves == {"a": {"layerId": "L3"}}
    assert out.overrides == {"a": {"layerId": "L3", "at": "t2"}}


def test_a_member_the_draft_placed_by_hand_is_theirs():
    out = reconcile_promote({"a": u("L2")}, fork={}, draft={"a": u("L2")}, members={"a": at("L1")},
                            layer_ids=L, fallback_layer_id=None)
    assert out.assignments == {"a": u("L2")} and out.moves == {}


# ── A design replaced (restore, import) ─────────────────────────────────────


def test_a_replaced_design_brings_no_members_and_a_live_view_is_worked_out_again():
    def config(mode):
        return {"membership": {"v": 1, "mode": mode, "sources": [{"spec": {"seeds": {"urns": ["s"]}}}]},
                "layout": {"referenceLayout": {"layers": [{"id": "L1"}],
                                               "assignments": {"a": m("L1"), "mine": u("L1")}}}}

    live = config("live")
    assert carry_into_config(live) is True
    assert live["layout"]["referenceLayout"]["assignments"] == {"mine": u("L1")}
    assert live["content"]["entityScope"] == "curated"
    frozen = config("snapshot")
    assert carry_into_config(frozen) is False, "a snapshot keeps its own members"
    assert frozen["layout"]["referenceLayout"]["assignments"] == {"mine": u("L1")}


def test_members_carried_as_entries_are_taken_out():
    config = {"layout": {"referenceLayout": {"assignments": {"a": m("L1"), "mine": u("L2")}}}}
    assert take_members(config) == {"a": m("L1")}
    assert config["layout"]["referenceLayout"]["assignments"] == {"mine": u("L2")}


# ── Keep out, bring back, always include ────────────────────────────────────


def test_excluding_takes_it_out_and_keeps_it_out():
    out, exclude, gone = apply_member_ops({"b": u("L2")}, ["z"], MemberOps(exclude=["a", "b"]), members={},
                                          layer_ids=L)
    assert out == {} and exclude == ["z", "a", "b"] and gone == ["a", "b"]


def test_bringing_back_lets_the_query_decide_again():
    _, exclude, gone = apply_member_ops({}, ["a", "b"], MemberOps(unexclude=["a"]), members={}, layer_ids=L)
    assert exclude == ["b"] and gone == []


def test_always_including_a_member_makes_it_the_persons_and_keeps_its_place():
    out, _, gone = apply_member_ops({}, [], MemberOps(include=[{"urn": "a", "layerId": "L1"}]),
                                    members={"a": at("L1", orderKey="k")}, layer_ids=L)
    assert out["a"] == {"layerId": "L1", "inheritsChildren": False, "orderKey": "k", "assignedBy": "user"}
    assert gone == ["a"], "a person's own entry now, out of the members"


def test_always_including_something_new_places_it_by_hand_and_unexcludes_it():
    out, exclude, gone = apply_member_ops({}, ["n"], MemberOps(include=[{"urn": "n", "layerId": "L2"}]),
                                          members={}, layer_ids=L, now="t3")
    assert out["n"] == {"layerId": "L2", "inheritsChildren": True, "assignedBy": "user", "assignedAt": "t3"}
    assert exclude == [] and gone == []


def test_always_including_into_a_layer_that_is_gone_is_refused():
    with pytest.raises(MemberOpError):
        apply_member_ops({}, [], MemberOps(include=[{"urn": "n", "layerId": "nope"}]), members={}, layer_ids=L)


def test_stopping_drops_only_what_a_person_placed():
    out, _, _ = apply_member_ops({"a": u("L1"), "b": m("L1")}, [], MemberOps(uninclude=["a", "b"]), members={},
                                 layer_ids=L)
    assert out == {"b": m("L1")}


def test_keeping_out_is_bounded(monkeypatch):
    monkeypatch.setattr(ownership, "EXCLUDE_MAX", 2)
    with pytest.raises(MemberOpError):
        apply_member_ops({}, ["a", "b"], MemberOps(exclude=["c"]), members={}, layer_ids=L)


def test_remembered_placements_forget_the_oldest_past_the_limit(monkeypatch):
    monkeypatch.setattr(ownership, "OVERRIDES_MAX", 2)
    kept = remember({"a": {"at": "1"}, "b": {"at": "3"}}, {"c": {"at": "2"}})
    assert set(kept) == {"b", "c"}
