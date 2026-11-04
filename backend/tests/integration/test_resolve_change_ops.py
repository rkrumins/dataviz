"""Pure unit tests for _resolve_change_ops — the /graph/changes op resolver that lets ONE Review &
Save (creates + their edges/updates/layer-moves, referenced by temp `ref`) become a single commit.

Focus here: a collapsed frontend save sends node creates WITHOUT a urn (the backend owns urn
minting, exactly like /nodes/create), and edges/updates reference the fresh nodes by temp ref.
The resolver must mint the urn — a ``urn:uuid:`` UUIDv7 — use it AS the node's entity_id
(entity_id == urn in the versioned graph), and resolve every temp ref. No DB needed.
"""
import uuid
from types import SimpleNamespace

from backend.app.api.v1.endpoints.graph import _resolve_change_ops
from backend.app.services.versioning.ids import new_entity_id, uuid_urn


def mint_id(_prefix):
    return new_entity_id()


def mint_urn(_entity_type):                       # what /graph/changes mints without a key
    return new_entity_id()


def _op(op, kind, id=None, ref=None, payload=None, base_version=None):
    return SimpleNamespace(op=op, kind=kind, id=id, ref=ref, payload=payload, base_version=base_version)


def test_mints_urn_for_urnless_node_create():
    ops, assigned = _resolve_change_ops(
        [_op("create", "node", ref="tmp:1", payload={"entityType": "Table", "displayName": "T"})],
        mint_id, mint_urn)
    urn = assigned["tmp:1"]
    assert uuid_urn(urn) == urn and uuid.UUID(urn[9:]).version == 7, urn    # a urn:uuid (v7)
    assert ops[0]["entity_id"] == urn, ops[0]                        # entity_id IS the urn
    assert ops[0]["payload"]["urn"] == urn, ops[0]                   # and it's in the payload


def test_explicit_urn_is_preserved():
    ops, assigned = _resolve_change_ops(
        [_op("create", "node", ref="tmp:2", payload={"urn": "urn:x", "entityType": "Table"})],
        mint_id, mint_urn)
    assert assigned["tmp:2"] == "urn:x"
    assert ops[0]["entity_id"] == "urn:x"


def test_edge_and_update_refs_resolve_to_minted_urns():
    urns = iter(["urn:synodic:manual:layer:aaa", "urn:synodic:manual:object:bbb"])
    stub_urn = lambda entity_type, source_system="manual": next(urns)
    ops, assigned = _resolve_change_ops([
        _op("create", "node", ref="tmp:L", payload={"entityType": "Layer", "displayName": "L"}),
        _op("create", "node", ref="tmp:O", payload={"entityType": "Object", "displayName": "O"}),
        _op("create", "edge", ref="tmp:e",
            payload={"edgeType": "CONTAINS", "sourceEntityId": "tmp:L", "targetEntityId": "tmp:O"}),
        _op("update", "node", id="tmp:O", payload={"layerAssignment": "layer-1"}),
    ], mint_id, stub_urn)

    L, O = assigned["tmp:L"], assigned["tmp:O"]
    assert L == "urn:synodic:manual:layer:aaa" and O == "urn:synodic:manual:object:bbb"
    edge = next(o for o in ops if o["entity_kind"] == "edge")
    assert edge["payload"]["sourceEntityId"] == L and edge["payload"]["targetEntityId"] == O
    upd = next(o for o in ops if o["op"] == "update")
    assert upd["entity_id"] == O                                     # update's temp ref resolved
    # an edge gets an id of its own, never one of the nodes'
    assert uuid_urn(edge["entity_id"]) == edge["entity_id"] and edge["entity_id"] not in (L, O)


if __name__ == "__main__":
    test_mints_urn_for_urnless_node_create()
    test_explicit_urn_is_preserved()
    test_edge_and_update_refs_resolve_to_minted_urns()
    print("resolver urn-minting + ref-resolution: OK")


def test_a_stand_in_gv_id_addresses_the_entity_itself():
    """A reader shows an urn-less entity as "gv:<entity id>"; an edit, delete, move, or edge end
    addressed to that id means the entity — not an edit of nothing (which failed as "needs a type")."""
    ops, _ = _resolve_change_ops([
        _op("update", "node", id="gv:ent_1", payload={"displayName": "Fixed"}),
        _op("create", "edge", payload={"edgeType": "HAS", "sourceEntityId": "gv:ent_2", "targetEntityId": "gv:ent_1"}),
        _op("move", "node", id="gv:ent_1", payload={"parentEntityId": "gv:ent_2", "edgeType": "HAS"}),
        _op("delete", "node", id="gv:ent_3"),
    ], mint_id, mint_urn)
    assert ops[0]["entity_id"] == "ent_1"
    assert (ops[1]["payload"]["sourceEntityId"], ops[1]["payload"]["targetEntityId"]) == ("ent_2", "ent_1")
    assert (ops[2]["entity_id"], ops[2]["payload"]["parentEntityId"]) == ("ent_1", "ent_2")
    assert ops[3]["entity_id"] == "ent_3"
