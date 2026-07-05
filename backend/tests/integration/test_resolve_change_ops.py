"""Pure unit tests for _resolve_change_ops — the /graph/changes op resolver that lets ONE Review &
Save (creates + their edges/updates/layer-moves, referenced by temp `ref`) become a single commit.

Focus here: a collapsed frontend save sends node creates WITHOUT a urn (the backend owns urn
minting, exactly like /nodes/create's make_urn), and edges/updates reference the fresh nodes by
temp ref. The resolver must mint the urn, use it AS the node's entity_id (entity_id == urn in the
versioned graph), and resolve every temp ref. No DB needed.
"""
from types import SimpleNamespace

from backend.app.api.v1.endpoints.graph import _resolve_change_ops
from backend.app.ontology.urn import make_urn
from backend.app.services.versioning.ids import prefixed_id


def _op(op, kind, id=None, ref=None, payload=None, base_version=None):
    return SimpleNamespace(op=op, kind=kind, id=id, ref=ref, payload=payload, base_version=base_version)


def test_mints_urn_for_urnless_node_create():
    ops, assigned = _resolve_change_ops(
        [_op("create", "node", ref="tmp:1", payload={"entityType": "Table", "displayName": "T"})],
        prefixed_id, make_urn)
    urn = assigned["tmp:1"]
    assert urn.startswith("urn:synodic:manual:table:"), urn         # minted like /nodes/create
    assert ops[0]["entity_id"] == urn, ops[0]                        # entity_id IS the urn
    assert ops[0]["payload"]["urn"] == urn, ops[0]                   # and it's in the payload


def test_explicit_urn_is_preserved():
    ops, assigned = _resolve_change_ops(
        [_op("create", "node", ref="tmp:2", payload={"urn": "urn:x", "entityType": "Table"})],
        prefixed_id, make_urn)
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
    ], prefixed_id, stub_urn)

    L, O = assigned["tmp:L"], assigned["tmp:O"]
    assert L == "urn:synodic:manual:layer:aaa" and O == "urn:synodic:manual:object:bbb"
    edge = next(o for o in ops if o["entity_kind"] == "edge")
    assert edge["payload"]["sourceEntityId"] == L and edge["payload"]["targetEntityId"] == O
    upd = next(o for o in ops if o["op"] == "update")
    assert upd["entity_id"] == O                                     # update's temp ref resolved
    # an edge gets its own minted entity_id, NOT a urn (edges aren't urn-keyed)
    assert not edge["entity_id"].startswith("urn:synodic:")


if __name__ == "__main__":
    test_mints_urn_for_urnless_node_create()
    test_explicit_urn_is_preserved()
    test_edge_and_update_refs_resolve_to_minted_urns()
    print("resolver urn-minting + ref-resolution: OK")
