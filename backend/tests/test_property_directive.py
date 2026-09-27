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
