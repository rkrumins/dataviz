"""What a bulk import's window ahead is matched again for (``import_worker._tokens``).

Two windows whose tokens meet may each read what the other writes, so one resolved ahead of the
other's write is matched again after it. A node row's tokens are what it names its node by and what
it resolved to; an edge row's, the edge it creates or matches. Windows that share none of these
never read each other's writes. integration/test_import_bulk_ahead.py proves the whole on Postgres.
"""
from backend.app.services.versioning.import_export.import_worker import _tokens
from backend.app.services.versioning.import_export.resolve import KeyIndex

_KEYS = KeyIndex({"Table": ["ext"]}, {"Table": ["code"]})


def _nodes(*rows, matched=()):
    rows = [{"kind": "node", "entityType": "Table", **r} for r in rows]
    resolutions = [{"matched_entity_id": eid} for eid in matched]
    return _tokens("node", rows, [], resolutions, "ident", _KEYS, {"table": "Table"})


def _edges(*creates, rows=(), matched=()):
    ops = [{"op": "create", "entity_id": f"new{i}",
            "payload": {"sourceEntityId": s, "targetEntityId": t, "edgeType": etype}}
           for i, (s, t, etype) in enumerate(creates)]
    resolutions = [{"matched_entity_id": eid} for eid in matched]
    return _tokens("edge", [{"kind": "edge", **r} for r in rows], ops, resolutions, None, None, {})


def _meet(a, b) -> bool:
    return not a.isdisjoint(b)


def test_node_rows_meet_by_any_name_they_give_a_node():
    assert _meet(_nodes({"urn": "urn:x:1"}), _nodes({"urn": "urn:x:1", "displayName": "other"}))
    uuid = "urn:uuid:3F2504E0-4F89-11D3-9A0C-0305E82C3301"
    assert _meet(_nodes({"urn": uuid}), _nodes({"urn": uuid.lower()})), "a urn:uuid in any case"
    assert _meet(_nodes({"urn": "urn:x:1"}), _nodes({"properties": {"ident": "urn:x:1"}})), (
        "the identifier value points as the urn does")
    assert _meet(_nodes({"entity_id": "F1"}), _nodes({"entity_id": "F1"}))
    assert _meet(_nodes({"qualifiedName": "db.t"}), _nodes({"urn": "urn:x:2", "qualifiedName": "db.t"}))
    assert _meet(_nodes({"properties": {"ext": "K"}}), _nodes({"entityType": "table", "properties": {"ext": "K"}}))
    assert _meet(_nodes({"properties": {"code": "C"}}), _nodes({"properties": {"code": "C"}})), "unique values"
    assert _meet(_nodes({"urn": "urn:x:1"}, matched=["E1"]), _nodes({"entity_id": "E1"})), (
        "a row naming the entity another row resolved to")


def test_node_rows_that_name_different_things_do_not_meet():
    one = _nodes({"urn": "urn:x:1", "qualifiedName": "db.a", "properties": {"ext": "K1", "code": "C1"}},
                 matched=["E1"])
    other = _nodes({"urn": "urn:x:2", "qualifiedName": "db.b", "properties": {"ext": "K2", "code": "C2"}},
                   matched=["E2"])
    assert not _meet(one, other)
    assert not _meet(_nodes({"properties": {"other": "K1"}}), _nodes({"properties": {"other": "K1"}})), (
        "a field no type matches by or keeps unique names nothing")


def test_edge_windows_meet_by_the_edges_they_create_or_match():
    assert _meet(_edges(("a", "b", "LINEAGE")), _edges(("a", "b", "lineage"))), "a type in any case"
    assert _meet(_edges(matched=["X1"]), _edges(rows=[{"entity_id": "X1"}]))
    assert not _meet(_edges(("a", "b", "LINEAGE")), _edges(("a", "c", "LINEAGE"), ("c", "b", "LINEAGE"))), (
        "edges sharing an end only: every node is written before the first edge window")
    assert not _meet(_edges(("a", "b", "LINEAGE")), _edges(("a", "b", "CONTAINS")))
