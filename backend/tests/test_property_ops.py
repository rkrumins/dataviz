"""A property operation's commit names and the search it narrows to (pure).

The job's commits carry the operation as History shows it, with a large integer exact. Its search
is narrowed to what the operation can change — ``fillEmpty`` to an empty key, ``rename`` /
``remove`` to a present one — but never for a ``set`` (search compares across types, so a retype
would be passed over) or for a search whose matches can't be re-checked one entity at a time.
"""
import pytest

from backend.app.services.versioning.property_ops import _narrowed, op_label
from backend.common.models.search import SearchQuery


@pytest.mark.parametrize("op, label", [
    ({"kind": "set", "key": "reviewed", "value": True}, "Set reviewed = true"),
    ({"kind": "set", "key": "owner", "value": "alice"}, "Set owner = alice"),
    ({"kind": "set", "key": "big", "value": 2 ** 63 - 1}, "Set big = 9223372036854775807"),
    ({"kind": "set", "key": "tags", "value": ["a", "b"]}, 'Set tags = ["a", "b"]'),
    ({"kind": "fillEmpty", "key": "owner", "value": "erin"}, "Fill empty owner with erin"),
    ({"kind": "rename", "key": "owner", "newKey": "steward"}, "Rename owner to steward"),
    ({"kind": "remove", "key": "owner"}, "Remove owner"),
])
def test_a_commit_names_the_operation(op, label):
    assert op_label(op) == label


def test_a_long_value_is_cut_short_in_the_name():
    label = op_label({"kind": "set", "key": "notes", "value": "x" * 500})
    assert label.startswith("Set notes = xxx") and label.endswith("…") and len(label) < 100


def _query(predicate):
    return SearchQuery.model_validate({"predicate": predicate, "scope": {
        "viewId": "v", "scopeMode": "view", "rootUrns": ["urn:root"]}})


OWNER_FINANCE = {"kind": "property", "key": "owner", "op": "contains", "value": "finance"}


@pytest.mark.parametrize("op, need", [
    ({"kind": "fillEmpty", "key": "tier", "value": "gold"},
     {"kind": "property", "key": "tier", "op": "isEmpty"}),
    ({"kind": "rename", "key": "tier", "newKey": "level"}, {"kind": "hasProperty", "key": "tier"}),
    ({"kind": "remove", "key": "tier"}, {"kind": "hasProperty", "key": "tier"}),
])
def test_the_search_is_narrowed_to_what_the_operation_can_change(op, need):
    narrowed = _narrowed(_query(OWNER_FINANCE), op)
    assert narrowed.scope.root_urns == ["urn:root"] and narrowed.scope.view_id == "v"
    group = narrowed.predicate
    assert group.kind == "group" and group.op == "and"
    first, second = ({"kind": c.kind, **c.model_dump(by_alias=True, exclude_defaults=True)}
                     for c in group.children)
    assert first == OWNER_FINANCE
    assert second == need


def test_a_set_is_not_narrowed():
    assert _narrowed(_query(OWNER_FINANCE), {"kind": "set", "key": "tier", "value": "gold"}) is None


def test_a_search_within_hops_is_not_narrowed():
    within = {"kind": "group", "op": "and", "children": [
        OWNER_FINANCE, {"kind": "withinHops", "urns": ["urn:a"], "hops": 2}]}
    assert _narrowed(_query(within), {"kind": "remove", "key": "tier"}) is None
