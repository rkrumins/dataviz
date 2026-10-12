"""fold_batch_ops: several ops on one entity in one save compose, in order, into one pending value.

The rule that used to live inline in ``apply_ops``. It applied the second update ONTO the first —
which strips removal markers — so a rename and a property removal on the same node in one save
kept the rename and silently lost the removal.
"""
from backend.app.services.versioning.changeset import fold_batch_ops
from backend.common.property_patch import PROP_DELETE, apply_patch


def _is_edge(payload):
    return "sourceEntityId" in payload


def _sanitize(payload):
    # Stand-in for the service's node sanitiser: reserved keys never live in `properties`.
    props = {k: v for k, v in (payload.get("properties") or {}).items() if k != "childCount"}
    return {**payload, "properties": props} if "properties" in payload else payload


def _fold(ops):
    return fold_batch_ops(ops, is_edge_payload=_is_edge, sanitize_node=_sanitize)


def test_rename_then_property_removal_keeps_both():
    fold = _fold([
        {"op": "update", "entity_kind": "node", "entity_id": "n1", "payload": {"displayName": "New"}},
        {"op": "update", "entity_kind": "node", "entity_id": "n1",
         "payload": {"properties": {"gone": PROP_DELETE}}},
    ])
    assert fold.update_ids == {"n1"}
    assert apply_patch({"displayName": "Old", "properties": {"gone": 1, "kept": 2}}, fold.new_vals["n1"]) == {
        "displayName": "New", "properties": {"kept": 2}}


def test_property_removal_then_rename_keeps_both():
    fold = _fold([
        {"op": "update", "entity_kind": "node", "entity_id": "n1",
         "payload": {"properties": {"gone": PROP_DELETE}}},
        {"op": "update", "entity_kind": "node", "entity_id": "n1", "payload": {"displayName": "New"}},
    ])
    assert fold.new_vals["n1"] == {"displayName": "New", "properties": {"gone": PROP_DELETE}}


def test_update_after_create_patches_the_create_and_drops_markers():
    fold = _fold([
        {"op": "create", "entity_kind": "node", "entity_id": "n1",
         "payload": {"urn": "n1", "entityType": "Dataset", "properties": {"a": 1, "b": 2}}},
        {"op": "update", "entity_kind": "node", "entity_id": "n1",
         "payload": {"displayName": "Named", "properties": {"a": PROP_DELETE}}},
    ])
    assert fold.update_ids == set()
    assert fold.new_vals["n1"] == {"urn": "n1", "entityType": "Dataset", "displayName": "Named",
                                   "properties": {"b": 2}}


def test_a_create_never_carries_a_marker():
    fold = _fold([{"op": "create", "entity_kind": "node", "entity_id": "n1",
                   "payload": {"urn": "n1", "properties": {"a": PROP_DELETE}}}])
    assert fold.new_vals["n1"] == {"urn": "n1", "properties": {}}


def test_delete_then_create_restarts_the_entity():
    fold = _fold([
        {"op": "update", "entity_kind": "edge", "entity_id": "e1", "payload": {"properties": {"x": 1}}},
        {"op": "delete", "entity_kind": "edge", "entity_id": "e1", "payload": None},
    ])
    assert fold.new_vals["e1"] is None and fold.update_ids == set()
    fold = _fold([
        {"op": "delete", "entity_kind": "edge", "entity_id": "e1", "payload": None},
        {"op": "create", "entity_kind": "edge", "entity_id": "e1",
         "payload": {"sourceEntityId": "a", "targetEntityId": "b", "edgeType": "FLOWS_TO"}},
    ])
    assert fold.update_ids == set()
    assert fold.new_vals["e1"]["edgeType"] == "FLOWS_TO"


def test_first_updates_base_version_is_the_occ_token():
    fold = _fold([
        {"op": "update", "entity_kind": "node", "entity_id": "n1", "payload": {"displayName": "A"},
         "base_version": "v1"},
        {"op": "update", "entity_kind": "node", "entity_id": "n1", "payload": {"displayName": "B"},
         "base_version": "v2"},
    ])
    assert fold.base_versions == {"n1": "v1"}
    assert fold.new_vals["n1"] == {"displayName": "B"}


def test_kind_falls_back_to_payload_shape():
    fold = _fold([
        {"op": "create", "entity_id": "e1",
         "payload": {"sourceEntityId": "a", "targetEntityId": "b", "edgeType": "T"}},
        {"op": "create", "entity_id": "n1", "payload": {"urn": "n1"}},
    ])
    assert fold.kind_by_entity == {"e1": "edge", "n1": "node"}


def test_node_payloads_are_sanitised_edges_are_not():
    fold = _fold([
        {"op": "update", "entity_kind": "node", "entity_id": "n1",
         "payload": {"properties": {"childCount": 4, "a": 1}}},
        {"op": "update", "entity_kind": "edge", "entity_id": "e1",
         "payload": {"properties": {"childCount": 4}}},
    ])
    assert fold.new_vals["n1"] == {"properties": {"a": 1}}
    assert fold.new_vals["e1"] == {"properties": {"childCount": 4}}


def test_duplicate_import_rows_compose():
    """Two import rows for one existing entity: the second's values win, the first's removal holds."""
    fold = _fold([
        {"op": "update", "entity_kind": "node", "entity_id": "n1",
         "payload": {"properties": {"a": PROP_DELETE, "b": "1"}}},
        {"op": "update", "entity_kind": "node", "entity_id": "n1", "payload": {"properties": {"b": "2"}}},
    ])
    assert apply_patch({"properties": {"a": "x", "b": "0", "c": "k"}}, fold.new_vals["n1"]) == {
        "properties": {"b": "2", "c": "k"}}
