"""A property operation, decided for one entity on the value it has now.

The Property Manager's bulk operations reach ``apply_ops`` as directives, decided inside the
commit's transaction on the entity's current value, not as patches the browser decided from what
it last saw. Each rule below is one cell of the operation table; "blank" is exactly what search's
``isEmpty`` matches, so an operation acts on what a search for it finds.
"""
from __future__ import annotations

import pytest

from backend.app.services.versioning.property_directive import check, resolve

INT64_MAX = 2**63 - 1


def _node(**props):
    return {"urn": "urn:n", "entityType": "Dataset", "displayName": "n", "properties": props}


def _set(key, value):
    return {"kind": "set", "key": key, "value": value}


def _fill(key, value):
    return {"kind": "fillEmpty", "key": key, "value": value}


def _rename(key, new_key):
    return {"kind": "rename", "key": key, "newKey": new_key}


def _remove(key):
    return {"kind": "remove", "key": key}


@pytest.mark.parametrize("props, directive, outcome, after", [
    # set: add, replace a blank, replace a value as typed, and nothing for the same value and type
    ({}, _set("owner", "alice"), "changed", {"owner": "alice"}),
    ({"owner": "  "}, _set("owner", "alice"), "changed", {"owner": "alice"}),
    ({"owner": "bob"}, _set("owner", "alice"), "changed", {"owner": "alice"}),
    ({"owner": "alice"}, _set("owner", "alice"), "unchanged", None),
    ({"code": "42"}, _set("code", 42), "changed", {"code": 42}),
    ({"flag": 1}, _set("flag", True), "changed", {"flag": True}),
    ({"n": 1.0}, _set("n", 1), "changed", {"n": 1}),
    ({"id": 0}, _set("id", INT64_MAX), "changed", {"id": INT64_MAX}),
    ({"id": INT64_MAX}, _set("id", INT64_MAX), "unchanged", None),
    ({"tags": ["a", "b"]}, _set("tags", ["a", "b"]), "unchanged", None),
    # fillEmpty: only where search's isEmpty holds — missing, null, [], or spaces (a tab is content)
    ({}, _fill("tier", "gold"), "changed", {"tier": "gold"}),
    ({"tier": None}, _fill("tier", "gold"), "changed", {"tier": "gold"}),
    ({"tier": []}, _fill("tier", "gold"), "changed", {"tier": "gold"}),
    ({"tier": "   "}, _fill("tier", "gold"), "changed", {"tier": "gold"}),
    ({"tier": "\t"}, _fill("tier", "gold"), "unchanged", None),
    ({"tier": "silver"}, _fill("tier", "gold"), "unchanged", None),
    ({"tier": 0}, _fill("tier", "gold"), "unchanged", None),
    # rename: the value moves verbatim (type, list, nested kept); a blank target is overwritten
    ({}, _rename("owner", "steward"), "unchanged", None),
    ({"owner": "alice", "x": 1}, _rename("owner", "steward"), "changed", {"steward": "alice", "x": 1}),
    ({"owner": ""}, _rename("owner", "steward"), "changed", {"steward": ""}),
    ({"cfg": {"a": [1, {"b": 2}]}}, _rename("cfg", "config"), "changed", {"config": {"a": [1, {"b": 2}]}}),
    ({"id": INT64_MAX}, _rename("id", "gvId"), "changed", {"gvId": INT64_MAX}),
    ({"owner": "alice", "steward": "bob"}, _rename("owner", "steward"), "targetExists", None),
    ({"owner": "alice", "steward": " "}, _rename("owner", "steward"), "changed", {"steward": "alice"}),
    ({"owner": "alice", "steward": None}, _rename("owner", "steward"), "changed", {"steward": "alice"}),
    # remove: drops the key whatever it holds
    ({}, _remove("owner"), "unchanged", None),
    ({"owner": "alice", "x": 1}, _remove("owner"), "changed", {"x": 1}),
    ({"owner": None}, _remove("owner"), "changed", {}),
])
def test_each_operation_is_decided_on_the_current_value(props, directive, outcome, after):
    current = _node(**props)
    res = resolve(current, directive)
    assert res.outcome == outcome
    if after is None:
        assert res.payload is None
    else:
        assert res.payload["properties"] == after
        assert type(res.payload["properties"].get(directive.get("newKey") or directive["key"])) is \
            type(after.get(directive.get("newKey") or directive["key"]))


def test_only_the_properties_change_and_the_current_value_is_left_alone():
    current = _node(owner="bob")
    res = resolve(current, _set("owner", "alice"))
    assert {k: v for k, v in res.payload.items() if k != "properties"} == \
        {"urn": "urn:n", "entityType": "Dataset", "displayName": "n"}
    assert current["properties"] == {"owner": "bob"}


def test_a_node_without_properties_gains_them():
    res = resolve({"urn": "urn:n", "entityType": "Dataset"}, _set("owner", "alice"))
    assert res.outcome == "changed" and res.payload["properties"] == {"owner": "alice"}


@pytest.mark.parametrize("directive", [
    {"kind": "retype", "key": "owner"},
    {"kind": "set", "key": "", "value": 1},
    {"kind": "set", "key": "owner"},
    {"kind": "fillEmpty", "key": "owner"},
    {"kind": "rename", "key": "owner"},
    {"kind": "rename", "key": "owner", "newKey": "owner"},
    {"kind": "rename", "key": "owner", "newKey": ""},
    {"kind": "remove"},
])
def test_a_malformed_directive_is_refused(directive):
    with pytest.raises(ValueError):
        check(directive)


@pytest.mark.parametrize("directive", [
    _set("owner", "alice"), _set("owner", None), _fill("tier", "gold"),
    _rename("owner", "steward"), _remove("owner"),
])
def test_a_well_formed_directive_passes(directive):
    check(directive)


# ---------------------------------------------------------------------------
# revert: an operation undone on one entity, only where nothing edited it since
# ---------------------------------------------------------------------------

def _revert(**restore):
    return {"kind": "revert", "restore": restore}


@pytest.mark.parametrize("props, directive, outcome, after", [
    # A set that added a key: it goes. One that replaced a value: the value comes back, as typed.
    ({"owner": "alice", "x": 1}, _revert(owner={"after": "alice"}), "changed", {"x": 1}),
    ({"code": 42}, _revert(code={"before": "42", "after": 42}), "changed", {"code": "42"}),
    ({"id": INT64_MAX}, _revert(id={"before": 0, "after": INT64_MAX}), "changed", {"id": 0}),
    # A remove: the value comes back whatever it held.
    ({}, _revert(cfg={"before": {"a": [1, {"b": 2}]}}), "changed", {"cfg": {"a": [1, {"b": 2}]}}),
    # A rename: the old key back, the new one as it was (absent, or the blank it overwrote).
    ({"steward": "alice"}, _revert(owner={"before": "alice"}, steward={"after": "alice"}),
     "changed", {"owner": "alice"}),
    ({"steward": "alice"}, _revert(owner={"before": "alice"}, steward={"before": " ", "after": "alice"}),
     "changed", {"owner": "alice", "steward": " "}),
    # Already as it was (an undo run again): nothing to do.
    ({"x": 1}, _revert(owner={"after": "alice"}), "unchanged", None),
    ({"code": "42"}, _revert(code={"before": "42", "after": 42}), "unchanged", None),
    # Edited since — another value, another type, removed, or one key of a rename moved on: left alone.
    ({"owner": "carol"}, _revert(owner={"after": "alice"}), "changedSince", None),
    ({"flag": 1}, _revert(flag={"before": False, "after": True}), "changedSince", None),
    ({}, _revert(code={"before": "42", "after": 42}), "changedSince", None),
    ({"steward": "alice", "owner": "dave"}, _revert(owner={"before": "alice"}, steward={"after": "alice"}),
     "changedSince", None),
])
def test_a_revert_puts_back_only_what_nothing_edited_since(props, directive, outcome, after):
    res = resolve(_node(**props), directive)
    assert res.outcome == outcome
    assert (res.payload["properties"] if res.payload else None) == after
    if after:
        for key, value in after.items():
            assert type(res.payload["properties"][key]) is type(value)


@pytest.mark.parametrize("directive", [
    {"kind": "revert"},
    {"kind": "revert", "restore": {}},
    {"kind": "revert", "restore": {"owner": "alice"}},
    {"kind": "revert", "restore": {"": {"after": 1}}},
    {"kind": "revert", "restore": {"owner": {"later": 1}}},
])
def test_a_malformed_revert_is_refused(directive):
    with pytest.raises(ValueError):
        check(directive)


def test_a_well_formed_revert_passes():
    check(_revert(owner={"before": "a", "after": "b"}, steward={}))
