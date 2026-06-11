"""materialize(): an `update` op must be a field-level PATCH, not a wholesale replace.

The canvas sends partial update payloads (only the edited fields). When `update` replaced the whole
entity, every unspecified field (urn, displayName, qualifiedName, properties…) was silently dropped —
invisible on the draft (the overlay still had the base row) but written onto main by publish/merge,
surfacing as blank names (node falls back to its urn) + lost properties. These pure-function tests pin
the patch semantics; `create` still replaces wholesale and `delete` still tombstones.
"""
from backend.app.services.versioning.changeset import materialize


def test_update_is_field_level_patch_preserving_unmentioned_fields():
    base = {"n1": {"urn": "n1", "displayName": "Name", "qualifiedName": "q.n1",
                   "entityType": "Dataset", "properties": {"owner": "team"}}}
    out = materialize(base, [{"entity_id": "n1", "op": "update", "payload": {"description": "new"}}])
    assert out["n1"] == {"urn": "n1", "displayName": "Name", "qualifiedName": "q.n1",
                         "entityType": "Dataset", "properties": {"owner": "team"}, "description": "new"}


def test_update_overwrites_only_the_fields_it_mentions():
    base = {"n1": {"urn": "n1", "displayName": "Old", "properties": {"a": 1}}}
    out = materialize(base, [{"entity_id": "n1", "op": "update",
                              "payload": {"displayName": "New", "properties": {"b": 2}}}])
    assert out["n1"] == {"urn": "n1", "displayName": "New", "properties": {"b": 2}}


def test_create_replaces_wholesale_and_delete_tombstones():
    base = {"n1": {"urn": "n1", "displayName": "Name", "stale": "x"}}
    assert materialize({}, [{"entity_id": "n2", "op": "create",
                             "payload": {"urn": "n2", "displayName": "X"}}])["n2"] == {"urn": "n2", "displayName": "X"}
    assert materialize(base, [{"entity_id": "n1", "op": "delete", "payload": None}])["n1"] is None


def test_update_on_absent_entity_acts_as_create():
    out = materialize({}, [{"entity_id": "n9", "op": "update", "payload": {"urn": "n9", "displayName": "Z"}}])
    assert out["n9"] == {"urn": "n9", "displayName": "Z"}


def test_sequential_ops_compound_on_the_same_entity():
    base = {"n1": {"urn": "n1", "displayName": "Name", "properties": {"a": 1}}}
    out = materialize(base, [
        {"entity_id": "n1", "op": "update", "payload": {"description": "d1"}},
        {"entity_id": "n1", "op": "update", "payload": {"layerAssignment": "L"}},
    ])
    assert out["n1"] == {"urn": "n1", "displayName": "Name", "properties": {"a": 1},
                         "description": "d1", "layerAssignment": "L"}


if __name__ == "__main__":
    test_update_is_field_level_patch_preserving_unmentioned_fields()
    test_update_overwrites_only_the_fields_it_mentions()
    test_create_replaces_wholesale_and_delete_tombstones()
    test_update_on_absent_entity_acts_as_create()
    test_sequential_ops_compound_on_the_same_entity()
    print("changeset.materialize patch semantics: OK")
