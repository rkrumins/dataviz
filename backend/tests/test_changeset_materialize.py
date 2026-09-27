"""materialize(): an `update` op is a PATCH, not a wholesale replace.

The canvas sends partial update payloads (only the edited fields). When `update` replaced the whole
entity, every unspecified field (urn, displayName, qualifiedName, properties…) was silently dropped —
invisible on the draft (the overlay still had the base row) but written onto main by publish/merge,
surfacing as blank names (node falls back to its urn) + lost properties.

`properties` merges key by key too: a partial properties patch used to REPLACE the bag on this path
(stage → checkpoint, the shared-draft fold) while the draft-save path merged it, so the same edit
meant two different things. A removal is explicit (`PROP_DELETE`, from `unsetProperties`) and never
stored. `create` still replaces wholesale and `delete` still tombstones.
"""
from backend.app.services.versioning.changeset import materialize
from backend.common.property_patch import PROP_DELETE


def test_update_is_field_level_patch_preserving_unmentioned_fields():
    base = {"n1": {"urn": "n1", "displayName": "Name", "qualifiedName": "q.n1",
                   "entityType": "Dataset", "properties": {"owner": "team"}}}
    out = materialize(base, [{"entity_id": "n1", "op": "update", "payload": {"description": "new"}}])
    assert out["n1"] == {"urn": "n1", "displayName": "Name", "qualifiedName": "q.n1",
                         "entityType": "Dataset", "properties": {"owner": "team"}, "description": "new"}


def test_update_merges_properties_key_by_key():
    base = {"n1": {"urn": "n1", "displayName": "Old", "properties": {"a": 1}}}
    out = materialize(base, [{"entity_id": "n1", "op": "update",
                              "payload": {"displayName": "New", "properties": {"b": 2}}}])
    assert out["n1"] == {"urn": "n1", "displayName": "New", "properties": {"a": 1, "b": 2}}


def test_update_removes_a_marked_property_and_never_stores_the_marker():
    base = {"n1": {"urn": "n1", "properties": {"a": 1, "b": 2}}}
    out = materialize(base, [{"entity_id": "n1", "op": "update",
                              "payload": {"properties": {"a": PROP_DELETE}}}])
    assert out["n1"] == {"urn": "n1", "properties": {"b": 2}}


def test_a_removal_survives_a_later_update_of_another_property():
    base = {"n1": {"urn": "n1", "properties": {"a": 1, "b": 2}}}
    out = materialize(base, [
        {"entity_id": "n1", "op": "update", "payload": {"properties": {"a": PROP_DELETE}}},
        {"entity_id": "n1", "op": "update", "payload": {"properties": {"b": 3}}},
    ])
    assert out["n1"] == {"urn": "n1", "properties": {"b": 3}}


def test_create_replaces_wholesale_and_delete_tombstones():
    base = {"n1": {"urn": "n1", "displayName": "Name", "stale": "x"}}
    assert materialize({}, [{"entity_id": "n2", "op": "create",
                             "payload": {"urn": "n2", "displayName": "X"}}])["n2"] == {"urn": "n2", "displayName": "X"}
    assert materialize(base, [{"entity_id": "n1", "op": "delete", "payload": None}])["n1"] is None


def test_create_never_stores_a_removal_marker():
    out = materialize({}, [{"entity_id": "n2", "op": "create",
                            "payload": {"urn": "n2", "properties": {"a": PROP_DELETE, "b": 1}}}])
    assert out["n2"] == {"urn": "n2", "properties": {"b": 1}}


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


def test_materialize_never_mutates_the_base_state():
    base = {"n1": {"urn": "n1", "properties": {"a": 1}}}
    materialize(base, [{"entity_id": "n1", "op": "update", "payload": {"properties": {"a": PROP_DELETE}}}])
    assert base == {"n1": {"urn": "n1", "properties": {"a": 1}}}
