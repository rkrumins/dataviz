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

    # ---- casing: the gate MATCHES case-insensitively AND the emitted op carries the ontology's
    #      DECLARED casing, so the case-sensitive FalkorDB projection stays canonical (import does
    #      NOT pass ontology_rules into apply_ops, so canonicalization must happen here). ----
    c_mint = iter(["cn_id", "ce_id"])
    c_ops, _ = resolve_rows([
        {"_row_index": 0, "kind": "node", "op": "upsert", "entity_id": "", "urn": "urn:cn",
         "entityType": "table", "displayName": "n", "qualifiedName": "qn"},
        {"_row_index": 1, "kind": "edge", "op": "upsert", "entity_id": "",
         "edgeType": "lineage", "sourceQualifiedName": "qn", "targetQualifiedName": "qn"},
    ], _indexes(), mint_id=lambda: next(c_mint), ontology=ont)
    c_by_kind = {o["entity_kind"]: o for o in c_ops}
    assert c_by_kind["node"]["payload"]["entityType"] == "Table", c_ops
    assert c_by_kind["edge"]["payload"]["edgeType"] == "LINEAGE", c_ops

    # ---- property deletion: sentinel removes an existing prop; deleting an absent prop is a no-op ----
    from backend.app.services.versioning.import_export.rowmodel import PROP_DELETE
    idx_d = _indexes()
    idx_d["current"] = {"ent_A": {"urn": "urn:A", "entityType": "Table", "displayName": "A",
                                  "qualifiedName": "a", "properties": {"owner": "alice", "keep": "x"}}}
    ops_d, res_d = resolve_rows([
        {"_row_index": 0, "kind": "node", "op": "upsert", "entity_id": "", "urn": "urn:A",
         "entityType": "Table", "displayName": "A", "qualifiedName": "a",
         "properties": {"owner": PROP_DELETE, "gone": PROP_DELETE}},   # owner exists→del; gone absent→noop
    ], idx_d, mint_id=lambda: "x")
    assert res_d[0]["resolved_op"] == "update"
    assert ops_d == [{"op": "update", "entity_kind": "node", "entity_id": "ent_A",
                      "payload": {"properties": {"owner": PROP_DELETE}}}], ops_d


def test_import_resolve():
    _run()


def _two_nodes():
    """Two entities that share a qualifiedName under different urns, and one with its own."""
    return {"urn_to_eid": {"urn:A": "ent_A", "urn:A2": "ent_A2", "urn:B": "ent_B"},
            "qname_to_eid": {"shared.q": None, "b": "ent_B"},       # None: carried by several
            "edge_to_eid": {}, "node_eids": {"ent_A", "ent_A2", "ent_B"}}


def test_a_qualified_name_never_folds_one_urn_into_another():
    """A row with a urn that matches nothing is a NEW entity — even when its qualifiedName is
    another entity's — never an update of that entity under the other urn (distinct urns used to
    collapse into one entity through the qualifiedName fallback)."""
    idx = {"urn_to_eid": {"urn:A": "ent_A"}, "qname_to_eid": {"a": "ent_A"},
           "edge_to_eid": {}, "node_eids": {"ent_A"}}
    ops, res = resolve_rows([
        {"_row_index": 0, "kind": "node", "op": "upsert", "entity_id": "", "urn": "urn:OTHER",
         "entityType": "Table", "displayName": "other", "qualifiedName": "a"},
    ], idx, mint_id=lambda: "ent_NEW")
    assert res[0]["resolved_op"] == "create" and res[0]["matched_entity_id"] == "ent_NEW", res
    assert ops[0]["entity_id"] == "ent_NEW" and ops[0]["payload"]["urn"] == "urn:OTHER"

    # Without a urn, the qualifiedName does identify the row.
    ops, res = resolve_rows([
        {"_row_index": 0, "kind": "node", "op": "upsert", "entity_id": "",
         "entityType": "Table", "displayName": "renamed", "qualifiedName": "a"},
    ], idx, mint_id=lambda: "x")
    assert res[0]["resolved_op"] == "update" and res[0]["matched_entity_id"] == "ent_A", res


def test_an_ambiguous_qualified_name_is_quarantined():
    """A qualifiedName several entities carry names none of them: a urn-less row (node, delete or
    edge end) that relies on it is invalid with a reason that says so, never written to a guess."""
    rows = [
        {"_row_index": 0, "kind": "node", "op": "upsert", "entity_id": "",
         "entityType": "Table", "displayName": "x", "qualifiedName": "shared.q"},
        {"_row_index": 1, "kind": "node", "op": "delete", "entity_id": "", "qualifiedName": "shared.q"},
        {"_row_index": 2, "kind": "edge", "op": "upsert", "entity_id": "", "edgeType": "LINEAGE",
         "sourceQualifiedName": "shared.q", "targetQualifiedName": "b"},
        # its urn decides: the shared qualifiedName beside it is never consulted
        {"_row_index": 3, "kind": "edge", "op": "upsert", "entity_id": "", "edgeType": "LINEAGE",
         "sourceUrn": "urn:A2", "sourceQualifiedName": "shared.q", "targetQualifiedName": "b"},
    ]
    ops, res = resolve_rows(rows, _two_nodes(), mint_id=lambda: "ev_1")
    by_row = {r["_row_index"]: r for r in res}
    for i in (0, 1, 2):
        assert by_row[i]["resolved_op"] == "invalid", by_row[i]
        assert "more than one entity" in by_row[i]["reasons"][0], by_row[i]
    assert by_row[3]["resolved_op"] == "create", by_row[3]
    assert ops == [{"op": "create", "entity_kind": "edge", "entity_id": "ev_1",
                    "payload": {"edgeType": "LINEAGE", "sourceEntityId": "ent_A2",
                                "targetEntityId": "ent_B"}}], ops


def test_a_created_node_makes_its_qualified_name_ambiguous():
    """A node this file creates under its own urn, with a qualifiedName an existing entity has:
    a later urn-less row naming that qualifiedName could mean either, so it is quarantined."""
    idx = {"urn_to_eid": {"urn:A": "ent_A"}, "qname_to_eid": {"a": "ent_A"},
           "edge_to_eid": {}, "node_eids": {"ent_A"}}
    minted = iter(["ent_N", "ev_1"])
    ops, res = resolve_rows([
        {"_row_index": 0, "kind": "node", "op": "upsert", "entity_id": "", "urn": "urn:N",
         "entityType": "Table", "displayName": "n", "qualifiedName": "a"},
        {"_row_index": 1, "kind": "edge", "op": "upsert", "entity_id": "", "edgeType": "LINEAGE",
         "sourceQualifiedName": "a", "targetUrn": "urn:A"},
    ], idx, mint_id=lambda: next(minted))
    by_row = {r["_row_index"]: r for r in res}
    assert by_row[0]["resolved_op"] == "create"
    assert by_row[1]["resolved_op"] == "invalid" and "more than one" in by_row[1]["reasons"][0]
    assert [o["entity_id"] for o in ops] == ["ent_N"]


def test_two_items_of_one_file_sharing_a_qualified_name_are_not_merged():
    """Two urn-less rows of one file, different items (their file entity_ids differ) under one
    qualifiedName: the second is not an update of the first. It is quarantined, and the
    qualifiedName then names neither — but the file's own id of the first still names it."""
    idx = {"urn_to_eid": {}, "qname_to_eid": {}, "edge_to_eid": {}, "node_eids": set()}
    minted = iter(["ent_0", "ev_1", "ev_2"])
    ops, res = resolve_rows([
        {"_row_index": 0, "kind": "node", "op": "upsert", "entity_id": "src_A",
         "entityType": "Column", "displayName": "A", "qualifiedName": "db.t.id"},
        {"_row_index": 1, "kind": "node", "op": "upsert", "entity_id": "src_B",
         "entityType": "Column", "displayName": "B", "qualifiedName": "db.t.id"},
        {"_row_index": 2, "kind": "node", "op": "upsert", "entity_id": "src_A",
         "entityType": "Column", "displayName": "A again", "qualifiedName": "db.t.id"},
        {"_row_index": 3, "kind": "edge", "op": "upsert", "entity_id": "", "edgeType": "LINEAGE",
         "source_entity_id": "src_A", "sourceQualifiedName": "db.t.id",
         "target_entity_id": "src_A", "targetQualifiedName": "db.t.id"},
        {"_row_index": 4, "kind": "edge", "op": "upsert", "entity_id": "", "edgeType": "LINEAGE",
         "source_entity_id": "src_B", "sourceQualifiedName": "db.t.id",
         "target_entity_id": "src_A", "targetQualifiedName": "db.t.id"},
        {"_row_index": 5, "kind": "edge", "op": "upsert", "entity_id": "", "edgeType": "LINEAGE",
         "sourceQualifiedName": "db.t.id", "target_entity_id": "src_A"},
    ], idx, mint_id=lambda: next(minted))
    by_row = {r["_row_index"]: r for r in res}
    assert by_row[0]["resolved_op"] == "create" and by_row[0]["matched_entity_id"] == "ent_0"
    assert by_row[1]["resolved_op"] == "invalid" and "more than one item" in by_row[1]["reasons"][0]
    assert by_row[2]["resolved_op"] == "update" and by_row[2]["matched_entity_id"] == "ent_0"
    assert by_row[3]["resolved_op"] == "create", by_row[3]
    for i in (4, 5):                     # B's edge, and one naming the qualifiedName alone
        assert by_row[i]["resolved_op"] == "invalid", by_row[i]
    assert [(o["op"], o["entity_id"]) for o in ops] == [
        ("create", "ent_0"), ("update", "ent_0"), ("create", "ev_1")], ops


def test_endpoints_resolve_by_entity_id_then_urn_then_qualified_name():
    idx = _two_nodes()
    minted = iter(["ev_1", "ev_2", "ev_3"])
    ops, res = resolve_rows([
        # the entity id wins over a urn naming another entity
        {"_row_index": 0, "kind": "edge", "op": "upsert", "entity_id": "", "edgeType": "LINEAGE",
         "source_entity_id": "ent_A", "sourceUrn": "urn:B", "targetUrn": "urn:B"},
        # an unknown entity id falls through to the urn
        {"_row_index": 1, "kind": "edge", "op": "upsert", "entity_id": "", "edgeType": "LINEAGE",
         "source_entity_id": "ent_GONE", "sourceUrn": "urn:A2", "targetUrn": "urn:B"},
        # a urn that matches nothing is not found — its qualifiedName is not a fallback
        {"_row_index": 2, "kind": "edge", "op": "upsert", "entity_id": "", "edgeType": "LINEAGE",
         "sourceUrn": "urn:NOPE", "sourceQualifiedName": "b", "targetUrn": "urn:A"},
    ], idx, mint_id=lambda: next(minted))
    by_row = {r["_row_index"]: r for r in res}
    assert [(o["payload"]["sourceEntityId"], o["payload"]["targetEntityId"]) for o in ops] == \
        [("ent_A", "ent_B"), ("ent_A2", "ent_B")], ops
    assert by_row[2]["resolved_op"] == "invalid" and by_row[2]["reasons"] == ["edge endpoint not found"]


def test_an_edge_is_the_same_edge_whatever_the_case_of_its_type():
    """Edge identity is (source, target, TYPE): a case variant of a stored edge's type matches it
    (it was a duplicate the write gate refused, failing the whole window) and keeps the stored
    spelling. Two rows of one file differing only in case are one edge, spelled as first written."""
    idx = {"urn_to_eid": {"urn:A": "ent_A", "urn:B": "ent_B"}, "qname_to_eid": {},
           "edge_to_eid": {("ent_A", "ent_B", "Lineage"): "edg_AB"}, "node_eids": {"ent_A", "ent_B"},
           "current": {"edg_AB": {"edgeType": "Lineage", "sourceEntityId": "ent_A",
                                  "targetEntityId": "ent_B"}}}
    ops, res = resolve_rows([
        {"_row_index": 0, "kind": "edge", "op": "upsert", "entity_id": "", "edgeType": "LINEAGE",
         "sourceUrn": "urn:A", "targetUrn": "urn:B"},
        {"_row_index": 1, "kind": "edge", "op": "upsert", "entity_id": "", "edgeType": "lineage",
         "sourceUrn": "urn:A", "targetUrn": "urn:B", "properties": {"note": "x"}},
    ], idx, mint_id=lambda: "never")
    assert [r["resolved_op"] for r in res] == ["unchanged", "update"], res
    assert ops == [{"op": "update", "entity_kind": "edge", "entity_id": "edg_AB",
                    "payload": {"properties": {"note": "x"}}}], ops

    minted = iter(["ev_1"])
    ops, res = resolve_rows([
        {"_row_index": 0, "kind": "edge", "op": "upsert", "entity_id": "", "edgeType": "Flows",
         "sourceUrn": "urn:B", "targetUrn": "urn:A"},
        {"_row_index": 1, "kind": "edge", "op": "upsert", "entity_id": "", "edgeType": "FLOWS",
         "sourceUrn": "urn:B", "targetUrn": "urn:A"},
    ], {**idx, "edge_to_eid": {}}, mint_id=lambda: next(minted))
    assert [r["matched_entity_id"] for r in res] == ["ev_1", "ev_1"], res
    assert ops[0]["op"] == "create" and ops[0]["payload"]["edgeType"] == "Flows"
    assert all(o["payload"].get("edgeType", "Flows") == "Flows" for o in ops), ops


if __name__ == "__main__":
    _run()
    print("import resolve: OK")
