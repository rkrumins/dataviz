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
    qualifiedName then names neither — but the file's own id of the first still names it (a third
    row by that id names its node, and is refused for saying otherwise than the first)."""
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
    assert by_row[2]["resolved_op"] == "invalid" and by_row[2]["matched_entity_id"] == "ent_0"
    assert "row 1 of this file already names this node" in by_row[2]["reasons"][0]
    assert by_row[3]["resolved_op"] == "create", by_row[3]
    for i in (4, 5):                     # B's edge, and one naming the qualifiedName alone
        assert by_row[i]["resolved_op"] == "invalid", by_row[i]
    assert [(o["op"], o["entity_id"]) for o in ops] == [("create", "ent_0"), ("create", "ev_1")], ops


def test_an_invalid_row_still_names_the_entity_it_matched():
    """A row quarantined as invalid — its columns shifted, or its type off the ontology — still
    records the entity it names, so a replace never reads that entity as absent from the file. A
    qualifiedName several entities carry still names none of them."""
    ops, res = resolve_rows([
        {"_row_index": 0, "kind": "node", "op": "upsert", "entity_id": "", "urn": "urn:A",
         "entityType": "Tabel"},
        {"_row_index": 1, "kind": "node", "op": "invalid", "op_error": "shifted", "entity_id": "",
         "urn": "urn:A"},
    ], _indexes(), mint_id=lambda: "never", ontology={"node_types": ["Table"]})
    assert ops == []
    assert [(r["resolved_op"], r["matched_entity_id"]) for r in res] == [
        ("invalid", "ent_A"), ("invalid", "ent_A")], res
    assert res[1]["reasons"] == ["shifted"]

    _, res = resolve_rows([
        {"_row_index": 0, "kind": "node", "op": "invalid", "op_error": "shifted", "entity_id": "",
         "qualifiedName": "shared.q"},
    ], _two_nodes(), mint_id=lambda: "never")
    assert (res[0]["resolved_op"], res[0]["matched_entity_id"]) == ("invalid", None), res


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
         "sourceUrn": "urn:A", "targetUrn": "urn:B", "properties": {"note": "x"}},
        {"_row_index": 1, "kind": "edge", "op": "upsert", "entity_id": "", "edgeType": "lineage",
         "sourceUrn": "urn:A", "targetUrn": "urn:B", "properties": {"note": "x"}},
    ], idx, mint_id=lambda: "never")
    assert [r["resolved_op"] for r in res] == ["update", "unchanged"], res
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


# ── File ids are pointers (the worker's mode: ``mint_urn`` and ``derive_urn`` set) ──────────────

import uuid as _uuid

from backend.app.services.versioning.import_export.resolve import pointer_id

_U = "urn:uuid:0192f5a4-7b3c-7d2e-8f1a-2b3c4d5e6f70"            # a free urn:uuid, lowercase
_TAKEN = "urn:uuid:0192f5a4-7b3c-7d2e-8f1a-2b3c4d5e6f71"


def _pointer_run(rows, **indexes):
    v7s = iter(f"urn:uuid:0192f5a4-0000-7000-8000-00000000000{i}" for i in range(10))
    base = {"urn_to_eid": {}, "qname_to_eid": {}, "edge_to_eid": {}, "node_eids": set()}
    ops, res = resolve_rows(rows, {**base, **indexes}, mint_id=lambda: next(v7s),
                            mint_urn=lambda _t: next(v7s), identity_prop="asset_id",
                            derive_urn=lambda seed: pointer_id("ds1", seed))
    return ops, {r["_row_index"]: r for r in res}


def _node_row(i, **kw):
    return {"_row_index": i, "kind": "node", "op": "upsert", "entity_id": kw.pop("entity_id", ""),
            "entityType": "Table", **kw}


def test_a_new_node_takes_the_id_its_pointer_derives_and_not_the_pointer():
    ops, res = _pointer_run([
        _node_row(0, urn="urn:li:x", displayName="x", properties={"asset_id": "A-1", "k": 1}),
        _node_row(1, displayName="y", properties={"asset_id": "A-2"}),
        _node_row(2, entity_id="f1", displayName="z"),
        {"_row_index": 3, "kind": "edge", "op": "upsert", "entity_id": "", "edgeType": "FLOWS",
         "sourceUrn": "urn:li:x", "target_entity_id": "f1"},
    ])
    x, y, z = (ops[i] for i in range(3))
    assert x["entity_id"] == x["payload"]["urn"] == pointer_id("ds1", "urn:li:x")
    assert x["payload"]["properties"] == {"k": 1}, "the identifier value is a pointer: not stored"
    assert y["entity_id"] == pointer_id("ds1", "A-2") and "minted" not in x and "minted" not in y
    assert _uuid.UUID(x["entity_id"][len("urn:uuid:"):]).version == 5
    assert z.get("minted") and z["entity_id"] == z["payload"]["urn"], "no pointer: minted"
    assert pointer_id("ds1", "urn:li:x") == x["entity_id"] != pointer_id("ds2", "urn:li:x")
    edge = ops[3]["payload"]
    assert (edge["sourceEntityId"], edge["targetEntityId"]) == (x["entity_id"], z["entity_id"])
    assert all(r["resolved_op"] == "create" for r in res.values())


def test_a_matched_row_keeps_its_nodes_urn_and_identifier():
    held = {"urn": _U, "entityType": "Table", "displayName": "x", "properties": {"asset_id": _U}}
    ops, res = _pointer_run(
        [_node_row(0, urn="urn:li:x", displayName="x2", properties={"asset_id": "A-1"})],
        urn_to_eid={"urn:li:x": _U}, node_eids={_U}, current={_U: held})
    assert res[0]["resolved_op"] == "update" and res[0]["matched_entity_id"] == _U
    assert ops[0]["payload"] == {"displayName": "x2"}, ops[0]


def test_two_pointers_that_name_two_nodes_refuse_the_row():
    ops, res = _pointer_run([_node_row(0, urn="urn:a", properties={"asset_id": "A-2"})],
                            urn_to_eid={"urn:a": "N1", "A-2": "N2"}, node_eids={"N1", "N2"})
    assert ops == [] and res[0]["resolved_op"] == "invalid"
    assert "two different entities" in res[0]["reasons"][0]


def test_an_uppercase_urn_uuid_finds_its_node_and_a_free_one_is_kept():
    other = "URN:UUID:0192F5A4-7B3C-7D2E-8F1A-2B3C4D5E6F7F"
    ops, res = _pointer_run(
        [_node_row(0, urn=_U.upper(), displayName="x"), _node_row(1, urn=other, displayName="o")],
        urn_to_eid={_U: _U}, node_eids={_U}, current={_U: {"urn": _U, "entityType": "Table",
                                                         "displayName": "x"}})
    assert res[0]["matched_entity_id"] == _U and res[0]["resolved_op"] == "unchanged"
    assert ops[0]["entity_id"] == ops[0]["payload"]["urn"] == other.lower()


def test_a_taken_uuid_gets_a_derived_id_and_a_deleted_holder_is_brought_back():
    ops, _res = _pointer_run([_node_row(0, urn=_TAKEN), _node_row(1, urn="urn:li:gone")],
                             taken={_TAKEN}, restore={"urn:li:gone": "ent_D"})
    assert ops[0]["entity_id"] == ops[0]["payload"]["urn"] == pointer_id("ds1", _TAKEN)
    assert (ops[1]["entity_id"], ops[1]["payload"]["urn"]) == ("ent_D", "urn:li:gone")


def test_a_delete_and_an_edge_find_their_node_by_pointer_and_by_file_id():
    d = pointer_id("ds1", "urn:li:x")
    ops, res = _pointer_run([
        _node_row(0, entity_id="f9", urn="urn:li:x", displayName="x"),
        {"_row_index": 1, "kind": "edge", "op": "upsert", "entity_id": "", "edgeType": "FLOWS",
         "source_entity_id": "f9", "targetUrn": "urn:li:y"},
        _node_row(2, op="delete", urn="urn:li:y"),
    ], urn_to_eid={"urn:li:x": d, "urn:li:y": "N2"}, node_eids={d, "N2"},
        current={d: {"urn": d, "entityType": "Table", "displayName": "x"}})
    assert res[0]["resolved_op"] == "unchanged"
    assert res[2]["resolved_op"] == "delete" and res[2]["matched_entity_id"] == "N2"
    edge = next(o for o in ops if o["entity_kind"] == "edge")["payload"]
    assert (edge["sourceEntityId"], edge["targetEntityId"]) == (d, "N2")


# ── An offline edit is reconciled, never silently lost ──────────────────────────────────────────
# A row an export wrote carries ``baseVersion``, the content hash of the version it was exported
# at. If the entity has changed since (``hash_of`` holds its head), only the cells the user changed
# apply; a cell someone else also changed refuses the row; a version this graph doesn't hold
# (``bases``) — another graph's export — applies as the row stands.

from backend.common.property_patch import PROP_DELETE

_X = "urn:uuid:0192f5a4-7b3c-7d2e-8f1a-2b3c4d5e6f72"
_AT_EXPORT = {"urn": _X, "entityType": "Table", "displayName": "x", "description": "d0",
              "tags": ["a"], "properties": {"owner": "alice", "tier": "gold"}}


def _stale_run(row, now, **indexes):
    """``row`` exported at ``_AT_EXPORT`` (hash ``h1``), resolved against ``now`` (hash ``h2``)."""
    return _pointer_run([_node_row(0, entity_id=_X, urn=_X, baseVersion="h1", **row)],
                        node_eids={_X}, urn_to_eid={_X: _X}, current={_X: now},
                        **{"hash_of": {_X: "h2"}, "bases": {(_X, "h1"): _AT_EXPORT}, **indexes})


def _exported(**changes):
    """The row as the export wrote it, with the user's ``changes``."""
    cells = {k: v for k, v in _AT_EXPORT.items() if k != "urn"}
    props = {**cells.pop("properties"), **changes.pop("properties", {})}
    return {**cells, **changes, "properties": props}


def test_a_stale_row_applies_only_the_cells_its_user_changed():
    now = {**_AT_EXPORT, "properties": {"owner": "bob", "tier": "gold"}}   # a colleague's edit
    ops, res = _stale_run(_exported(description="mine"), now)
    assert res[0]["resolved_op"] == "update", res[0]
    assert ops[0]["payload"] == {"description": "mine"}, "the colleague's owner is not reverted"


def test_a_stale_row_whose_cell_someone_else_also_changed_is_refused_naming_it():
    now = {**_AT_EXPORT, "description": "theirs", "properties": {"owner": "bob", "tier": "gold"}}
    ops, res = _stale_run(_exported(description="mine", properties={"owner": "carol"}), now)
    assert ops == [] and res[0]["resolved_op"] == "invalid"
    assert "changed since you exported it: description, owner" in res[0]["reasons"][0]


def test_a_stale_row_changed_alike_or_untouched_is_unchanged():
    now = {**_AT_EXPORT, "description": "same", "properties": {"owner": "bob", "tier": "gold"}}
    ops, res = _stale_run(_exported(description="same"), now)
    assert ops == [] and res[0]["resolved_op"] == "unchanged", res[0]


def test_a_stale_rows_tags_merge_and_its_removal_applies():
    now = {**_AT_EXPORT, "tags": ["a", "b"]}                               # a colleague added b
    ops, _res = _stale_run(_exported(tags=["a", "c"], properties={"tier": PROP_DELETE}), now)
    assert ops[0]["payload"]["tags"] == ["a", "b", "c"]
    assert ops[0]["payload"]["properties"] == {"tier": PROP_DELETE}


def test_a_stale_delete_is_refused():
    now = {**_AT_EXPORT, "description": "theirs"}
    ops, res = _pointer_run([_node_row(0, op="delete", entity_id=_X, baseVersion="h1")],
                            node_eids={_X}, current={_X: now}, hash_of={_X: "h2"},
                            bases={(_X, "h1"): _AT_EXPORT})
    assert ops == [] and res[0]["resolved_op"] == "invalid"
    assert "changed since you exported it" in res[0]["reasons"][0]


def test_a_row_from_elsewhere_or_without_a_base_sets_what_it_carries():
    now = {**_AT_EXPORT, "properties": {"owner": "bob", "tier": "gold"}}
    for indexes in ({"bases": {}}, {"hash_of": {}}):           # a version this graph never held
        ops, _res = _stale_run(_exported(description="mine"), now, **indexes)
        assert ops[0]["payload"] == {"description": "mine", "properties": {"owner": "alice"}}
    ops, _res = _pointer_run([_node_row(0, entity_id=_X, urn=_X, **_exported(description="mine"))],
                             node_eids={_X}, current={_X: now}, hash_of={_X: "h2"})
    assert ops[0]["payload"] == {"description": "mine", "properties": {"owner": "alice"}}


def test_a_urn_edit_is_reported_and_a_urn_of_another_node_refuses_the_row():
    held = {"urn": _X, "entityType": "Table", "displayName": "x"}
    ops, res = _pointer_run([_node_row(0, entity_id=_X, urn="urn:li:renamed", displayName="x2"),
                             _node_row(1, entity_id=_X, urn="urn:li:y", displayName="x3")],
                            node_eids={_X, "N2"}, urn_to_eid={"urn:li:y": "N2"},
                            current={_X: held, "N2": {"urn": "urn:li:y"}})
    assert res[0]["resolved_op"] == "update" and ops[0]["payload"] == {"displayName": "x2"}
    assert "urn 'urn:li:renamed' isn't stored" in res[0]["reasons"][0]
    assert res[1]["resolved_op"] == "invalid"
    assert "its entity_id and its urn name two different entities" in res[1]["reasons"][0]


def _edge_row(i, **kw):
    return {"_row_index": i, "kind": "edge", "op": "upsert", "edgeType": "FLOWS", **kw}


def test_an_exported_edge_with_a_new_end_is_refused_not_doubled():
    e = {"edgeType": "FLOWS", "sourceEntityId": "N1", "targetEntityId": "N2"}
    ops, res = _pointer_run([_edge_row(0, entity_id="E1", source_entity_id="N1",
                                       target_entity_id="N3"),
                             _edge_row(1, entity_id="E1", source_entity_id="N1",
                                       target_entity_id="N2", confidence=0.5)],
                            node_eids={"N1", "N2", "N3"}, edge_eids={"E1"}, current={"E1": e},
                            edge_to_eid={("N1", "N2", "FLOWS"): "E9"})        # a parallel edge
    assert res[0]["resolved_op"] == "invalid" and "differ from edge E1" in res[0]["reasons"][0]
    assert res[1]["resolved_op"] == "update" and res[1]["matched_entity_id"] == "E1"
    assert [o["entity_id"] for o in ops] == ["E1"]


def test_a_second_row_for_one_node_is_refused_unless_it_says_the_same():
    held = {"urn": _X, "entityType": "Table", "displayName": "x"}
    ops, res = _pointer_run([_node_row(0, entity_id=_X, displayName="x2"),
                             _node_row(1, entity_id=_X, displayName="x2"),
                             _node_row(2, entity_id=_X, displayName="x3"),
                             _node_row(3, urn="urn:li:new", displayName="n"),
                             _node_row(4, urn="urn:li:new", displayName="n2")],
                            node_eids={_X}, current={_X: held})
    assert [res[i]["resolved_op"] for i in range(5)] == [
        "update", "unchanged", "invalid", "create", "invalid"]
    assert "row 1 of this file already names this node" in res[2]["reasons"][0]
    assert "row 4 of this file already names this node" in res[4]["reasons"][0]
    assert [o["op"] for o in ops] == ["update", "create"]


def test_a_row_for_a_node_an_earlier_window_named_is_refused_when_it_changes_it():
    held = {"urn": _X, "entityType": "Table", "displayName": "x"}
    _ops, res = _pointer_run([_node_row(20, entity_id=_X, displayName="x"),
                              _node_row(21, entity_id=_X, displayName="x2")],
                             node_eids={_X}, current={_X: held}, earlier={_X: 3})
    assert res[20]["resolved_op"] == "unchanged"
    assert res[21]["resolved_op"] == "invalid" and "row 4 of this file" in res[21]["reasons"][0]


def test_a_second_row_for_one_edge_is_refused_unless_it_says_the_same():
    ops, res = _pointer_run([_edge_row(0, source_entity_id="N1", target_entity_id="N2"),
                             _edge_row(1, source_entity_id="N1", target_entity_id="N2"),
                             _edge_row(2, source_entity_id="N1", target_entity_id="N2",
                                       confidence=0.4)],
                            node_eids={"N1", "N2"})
    assert [res[i]["resolved_op"] for i in range(3)] == ["create", "unchanged", "invalid"]
    assert "row 1 of this file already names this edge" in res[2]["reasons"][0]
    assert len(ops) == 1
