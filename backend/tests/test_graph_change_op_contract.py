"""The draft-save contract for removing a property: ``unsetProperties``.

An update merges ``payload.properties`` key by key, so a property the client leaves out is KEPT —
the drawer's "delete" used to be exactly that, and the save said "Saved" while nothing changed.
Removal is its own field; the resolvers turn it into the service's one internal form and refuse
anything contradictory with a 422 before a write.
"""
from types import SimpleNamespace

import pytest
from fastapi import HTTPException

from backend.app.api.v1.endpoints.graph import GraphChangeOp, _resolve_change_ops
from backend.app.api.v1.endpoints.versioning import StageOp, _stage_ops
from backend.app.ontology.urn import make_urn
from backend.app.services.versioning.ids import prefixed_id
from backend.common.property_patch import PROP_DELETE, InvalidPatch


def _op(op, kind, id=None, ref=None, payload=None, unset=None, base_version=None):
    return SimpleNamespace(op=op, kind=kind, id=id, ref=ref, payload=payload,
                           unset_properties=unset, base_version=base_version)


def _resolve(*ops):
    return _resolve_change_ops(list(ops), prefixed_id, make_urn)[0]


def test_the_wire_field_parses_by_alias():
    op = GraphChangeOp.model_validate(
        {"op": "update", "kind": "node", "id": "n1", "payload": {}, "unsetProperties": ["a"]})
    assert op.unset_properties == ["a"]


def test_update_unset_becomes_the_internal_removal():
    [op] = _resolve(_op("update", "node", id="n1", payload={"properties": {"b": 2}}, unset=["a"],
                        base_version="v1"))
    assert op == {"op": "update", "entity_kind": "node", "entity_id": "n1",
                  "payload": {"properties": {"b": 2, "a": PROP_DELETE}}, "base_version": "v1"}


def test_edge_update_unset():
    [op] = _resolve(_op("update", "edge", id="e1", payload=None, unset=["weight"]))
    assert op["payload"] == {"properties": {"weight": PROP_DELETE}}


@pytest.mark.parametrize("kind_op", ["create", "delete", "move"])
def test_unset_on_anything_but_an_update_is_refused(kind_op):
    with pytest.raises(InvalidPatch, match="applies to an update"):
        _resolve(_op(kind_op, "node", id="n1", payload={"entityType": "Table"}, unset=["a"]))


def test_set_and_unset_of_one_key_is_refused():
    with pytest.raises(InvalidPatch, match="both set and unset"):
        _resolve(_op("update", "node", id="n1", payload={"properties": {"a": 1}}, unset=["a"]))


def test_a_create_never_carries_a_marker():
    [op] = _resolve(_op("create", "node", ref="t1",
                        payload={"entityType": "Table", "properties": {"a": PROP_DELETE, "b": 1}}))
    assert op["payload"]["properties"] == {"b": 1}


def test_node_description_filed_under_properties_is_lifted():
    """The Hierarchy Builder filed a new node's description under properties, where the node
    sanitiser strips it as a reserved key — the description was lost on save."""
    [create] = _resolve(_op("create", "node", ref="t1",
                            payload={"entityType": "Table", "properties": {"description": "D", "x": 1}}))
    assert create["payload"]["description"] == "D"
    assert create["payload"]["properties"] == {"x": 1}
    [update] = _resolve(_op("update", "node", id="n1", payload={"properties": {"qualifiedName": "q"}}))
    assert update["payload"] == {"qualifiedName": "q", "properties": {}}


def test_edge_payloads_are_never_lifted():
    [op] = _resolve(_op("update", "edge", id="e1", payload={"properties": {"description": "D"}}))
    assert op["payload"] == {"properties": {"description": "D"}}


# ── the API-only stage route ───────────────────────────────────────────────────
def _stage(**kw):
    return StageOp.model_validate({"op": "update", "entityKind": "node", "entityId": "n1", **kw})


def test_stage_translates_unset_properties():
    [op] = _stage_ops([_stage(payload={"properties": {"b": 2}}, unsetProperties=["a"])])
    assert op["payload"] == {"properties": {"b": 2, "a": PROP_DELETE}}
    assert "unset_properties" not in op


def test_stage_without_unset_is_unchanged():
    [op] = _stage_ops([_stage(payload={"displayName": "X"})])
    assert op == {"op": "update", "entity_kind": "node", "entity_id": "n1", "payload": {"displayName": "X"}}


@pytest.mark.parametrize("bad", [
    {"payload": {"properties": {"a": 1}}, "unsetProperties": ["a"]},
    {"op": "create", "unsetProperties": ["a"]},
])
def test_stage_refuses_a_contradictory_patch_with_422(bad):
    with pytest.raises(HTTPException) as exc:
        _stage_ops([_stage(**bad)])
    assert exc.value.status_code == 422
    assert exc.value.detail["type"] == "invalid_patch"
