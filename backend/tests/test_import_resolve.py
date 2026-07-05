"""resolve_rows — match normalized import rows to entities + build versioned ops (no infra).

The heart of Phase 3: two passes (nodes then edges) over the normalized rows. Nodes match an
existing entity by entity_id -> urn -> qualifiedName (else mint a new id); edges resolve their
endpoints via the same node indexes (including nodes created earlier in the same import) and key
by the endpoint-triple. Emits ``{op, entity_kind, entity_id, payload}`` ops (nodes before edges,
so an edge can reference a node created in the same batch) plus a per-row resolution record
(new/updated/deleted/invalid) for the preview/summary. Pure — runs under the per-file runner.
"""
from backend.app.services.versioning.import_export.resolve import resolve_rows


def _indexes():
    return {
        "urn_to_eid": {"urn:A": "ent_A"},
        "qname_to_eid": {"a": "ent_A"},
        "edge_to_eid": {},
        "node_eids": {"ent_A"},
        "edge_eids": set(),
    }


def _run() -> None:
    minted = iter(["ent_B", "ev_1"])
    rows = [
        # match an existing node by urn -> UPDATE (patch), keeps ent_A
        {"_row_index": 0, "kind": "node", "op": "upsert", "entity_id": "",
         "urn": "urn:A", "entityType": "Table", "displayName": "A renamed"},
        # brand-new node -> CREATE, mints ent_B
        {"_row_index": 1, "kind": "node", "op": "upsert", "entity_id": "",
         "urn": "urn:B", "entityType": "Table", "displayName": "B", "qualifiedName": "b"},
        # edge from a (=ent_A) to b (=ent_B, created above) -> CREATE
        {"_row_index": 2, "kind": "edge", "op": "upsert", "entity_id": "",
         "edgeType": "LINEAGE", "sourceQualifiedName": "a", "targetQualifiedName": "b"},
    ]
    ops, res = resolve_rows(rows, _indexes(), mint_id=lambda: next(minted))

    by_row = {r["_row_index"]: r for r in res}
    assert by_row[0]["resolved_op"] == "update" and by_row[0]["matched_entity_id"] == "ent_A"
    assert by_row[1]["resolved_op"] == "create" and by_row[1]["matched_entity_id"] == "ent_B"
    assert by_row[2]["resolved_op"] == "create" and by_row[2]["matched_entity_id"] == "ev_1"

    # nodes precede edges; the edge references the resolved endpoint entity_ids
    assert [o["entity_kind"] for o in ops] == ["node", "node", "edge"]
    upd = ops[0]
    assert upd == {"op": "update", "entity_kind": "node", "entity_id": "ent_A",
                   "payload": {"urn": "urn:A", "entityType": "Table", "displayName": "A renamed"}}
    edge = ops[2]
    assert edge["op"] == "create" and edge["entity_kind"] == "edge"
    assert edge["payload"]["sourceEntityId"] == "ent_A"
    assert edge["payload"]["targetEntityId"] == "ent_B"
    assert edge["payload"]["edgeType"] == "LINEAGE"

    # ---- delete of a matched node -> delete op ; delete of an unknown -> invalid ----
    minted2 = iter([])
    ops2, res2 = resolve_rows([
        {"_row_index": 0, "kind": "node", "op": "delete", "entity_id": "", "urn": "urn:A"},
        {"_row_index": 1, "kind": "node", "op": "delete", "entity_id": "", "urn": "urn:GONE"},
    ], _indexes(), mint_id=lambda: next(minted2))
    d = {r["_row_index"]: r for r in res2}
    assert d[0]["resolved_op"] == "delete" and d[0]["matched_entity_id"] == "ent_A"
    assert d[1]["resolved_op"] == "invalid"
    assert ops2 == [{"op": "delete", "entity_kind": "node", "entity_id": "ent_A", "payload": None}]

    # ---- node create missing entityType -> invalid, no op ----
    ops3, res3 = resolve_rows([
        {"_row_index": 0, "kind": "node", "op": "upsert", "entity_id": "", "urn": "urn:X"},
    ], _indexes(), mint_id=lambda: "ent_X")
    assert res3[0]["resolved_op"] == "invalid" and ops3 == []

    # ---- edge with an unresolvable endpoint -> invalid ----
    ops4, res4 = resolve_rows([
        {"_row_index": 0, "kind": "edge", "op": "upsert", "entity_id": "",
         "edgeType": "LINEAGE", "sourceQualifiedName": "a", "targetQualifiedName": "missing"},
    ], _indexes(), mint_id=lambda: "ev_x")
    assert res4[0]["resolved_op"] == "invalid" and ops4 == []

    # ---- idempotent round-trip: a matched row identical to the current payload is a no-op,
    #      even when a numeric property came back as a STRING via CSV (the "81 changes" bug). ----
    idx = _indexes()
    idx["current"] = {"ent_A": {"urn": "urn:A", "entityType": "Table", "displayName": "A",
                                "qualifiedName": "a", "properties": {"rows": 5}}}
    ops5, res5 = resolve_rows([
        {"_row_index": 0, "kind": "node", "op": "upsert", "entity_id": "", "urn": "urn:A",
         "entityType": "Table", "displayName": "A", "qualifiedName": "a", "properties": {"rows": "5"}},
    ], idx, mint_id=lambda: "x")
    assert res5[0]["resolved_op"] == "unchanged" and ops5 == []

    # ---- a real rename -> update carrying ONLY the changed field (clean, minimal diff) ----
    ops6, res6 = resolve_rows([
        {"_row_index": 0, "kind": "node", "op": "upsert", "entity_id": "", "urn": "urn:A",
         "entityType": "Table", "displayName": "A renamed", "qualifiedName": "a", "properties": {"rows": "5"}},
    ], idx, mint_id=lambda: "x")
    assert res6[0]["resolved_op"] == "update"
    assert ops6 == [{"op": "update", "entity_kind": "node", "entity_id": "ent_A",
                     "payload": {"displayName": "A renamed"}}], ops6

    # ---- adding a NEW property -> update patches just that property ----
    ops7, res7 = resolve_rows([
        {"_row_index": 0, "kind": "node", "op": "upsert", "entity_id": "", "urn": "urn:A",
         "entityType": "Table", "displayName": "A", "qualifiedName": "a",
         "properties": {"rows": "5", "logicalDataType": "string"}},
    ], idx, mint_id=lambda: "x")
    assert res7[0]["resolved_op"] == "update"
    assert ops7 == [{"op": "update", "entity_kind": "node", "entity_id": "ent_A",
                     "payload": {"properties": {"logicalDataType": "string"}}}], ops7

    # ---- per-row ontology gate: unknown node/edge types are quarantined; casing tolerated ----
    ont = {"node_types": ["Table", "Column"], "edge_types": ["LINEAGE"]}
    o_ops, o_res = resolve_rows([
        {"_row_index": 0, "kind": "node", "op": "upsert", "entity_id": "", "urn": "urn:bad",
         "entityType": "Bogus", "displayName": "x", "qualifiedName": "qx"},
        {"_row_index": 1, "kind": "node", "op": "upsert", "entity_id": "", "urn": "urn:ok",
         "entityType": "table", "displayName": "y", "qualifiedName": "qy"},          # case-tolerant
        {"_row_index": 2, "kind": "edge", "op": "upsert", "entity_id": "",
         "edgeType": "MADE_UP", "sourceQualifiedName": "qy", "targetQualifiedName": "qy"},
    ], _indexes(), mint_id=lambda: "nid", ontology=ont)
    by_row = {r["_row_index"]: r for r in o_res}
    assert by_row[0]["resolved_op"] == "invalid" and "Bogus" in by_row[0]["reasons"][0]
    assert by_row[1]["resolved_op"] == "create", by_row[1]          # 'table' ~ 'Table'
    assert by_row[2]["resolved_op"] == "invalid" and "MADE_UP" in by_row[2]["reasons"][0]


def test_import_resolve():
    _run()


if __name__ == "__main__":
    _run()
    print("import resolve: OK")
