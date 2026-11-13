"""resolve_rows — match normalized import rows to entities + build versioned ops (no infra).

The heart of Phase 3: two passes (nodes then edges) over the normalized rows. Nodes match an
existing entity by entity_id -> urn -> qualifiedName (else mint a new id); edges resolve their
endpoints via the same node indexes (including nodes created earlier in the same import) and key
by the endpoint-triple. Emits ``{op, entity_kind, entity_id, payload}`` ops (nodes before edges,
so an edge can reference a node created in the same batch) plus a per-row resolution record
(new/updated/deleted/invalid) for the preview/summary. Pure — runs under the per-file runner.
"""
from backend.app.services.versioning.import_export.resolve import (
    _ALREADY_GONE,
    resolve_rows,
)


def _indexes():
    return {
        "urn_to_eid": {"urn:A": "ent_A"},
        "qname_to_eid": {"a": "ent_A"},
        "edge_to_eid": {},
        "node_eids": {"ent_A"},
        "edge_eids": set(),
    }



def test_a_delete_of_what_is_already_gone_is_done():
    """A delta sent again deletes what it deleted before: nothing is left to delete, so its row is
    unchanged, saying so, rather than refused. An edge whose end node is gone went with it. A row
    that isn't a delete still can't point at what isn't there."""
    idx = {**_indexes(), "urn_to_eid": {"urn:A": "ent_A", "urn:B": "ent_B"},
           "node_eids": {"ent_A", "ent_B"}}
    ops, res = resolve_rows([
        {"_row_index": 0, "kind": "edge", "op": "delete", "entity_id": "", "edgeType": "LINEAGE",
         "sourceUrn": "urn:A", "targetUrn": "urn:B"},           # both ends here, no such edge
        {"_row_index": 1, "kind": "edge", "op": "delete", "entity_id": "", "edgeType": "LINEAGE",
         "sourceUrn": "urn:A", "targetUrn": "urn:GONE"},        # an end deleted already
        {"_row_index": 2, "kind": "edge", "op": "upsert", "entity_id": "", "edgeType": "LINEAGE",
         "sourceUrn": "urn:A", "targetUrn": "urn:GONE"},        # not a delete: refused
    ], idx, mint_id=lambda: "unused")
    by_row = {r["_row_index"]: r for r in res}
    assert ops == []
    assert [(by_row[i]["resolved_op"], by_row[i]["reasons"]) for i in (0, 1)] == \
        [("unchanged", [_ALREADY_GONE])] * 2
    assert by_row[2]["resolved_op"] == "invalid" and by_row[2]["reasons"] == [
        "its target urn:GONE names no node the graph holds or the file makes"]

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

    # ---- delete of a matched node -> delete op ; delete of an unknown -> unchanged, with a note:
    # nothing to delete (a delta sent again, or a name that was never there) ----
    minted2 = iter([])
    ops2, res2 = resolve_rows([
        {"_row_index": 0, "kind": "node", "op": "delete", "entity_id": "", "urn": "urn:A"},
        {"_row_index": 1, "kind": "node", "op": "delete", "entity_id": "", "urn": "urn:GONE"},
    ], _indexes(), mint_id=lambda: next(minted2))
    d = {r["_row_index"]: r for r in res2}
    assert d[0]["resolved_op"] == "delete" and d[0]["matched_entity_id"] == "ent_A"
    assert (d[1]["resolved_op"], d[1]["matched_entity_id"]) == ("unchanged", None)
    assert d[1]["reasons"] == [_ALREADY_GONE]
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
    assert by_row[2]["resolved_op"] == "invalid" and by_row[2]["reasons"] == [
        "its source urn:NOPE names no node the graph holds or the file makes"]


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

from backend.app.services.versioning.import_export.resolve import KeyIndex, pointer_id

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


def test_a_new_node_takes_the_id_its_urn_derives_and_keeps_the_urn_as_given():
    ops, res = _pointer_run([
        _node_row(0, urn="urn:li:x", displayName="x", properties={"asset_id": "A-1", "k": 1}),
        _node_row(1, displayName="y", properties={"asset_id": "A-2"}),
        {"_row_index": 2, "kind": "edge", "op": "upsert", "entity_id": "", "edgeType": "FLOWS",
         "sourceUrn": "urn:li:x", "targetKeys": {"asset_id": "A-2"}},
    ])
    x, y = ops[0], ops[1]
    assert x["entity_id"] == pointer_id("ds1", "urn:li:x") and x["payload"]["urn"] == "urn:li:x"
    assert x["payload"]["properties"] == {"k": 1}, "the identifier value is a pointer: not stored"
    assert y["entity_id"] == y["payload"]["urn"] == pointer_id("ds1", "A-2"), "no urn: its id"
    assert "minted" not in x and "minted" not in y
    assert _uuid.UUID(x["entity_id"][len("urn:uuid:"):]).version == 5
    assert pointer_id("ds1", "urn:li:x") == x["entity_id"] != pointer_id("ds2", "urn:li:x")
    edge = ops[2]["payload"]
    assert (edge["sourceEntityId"], edge["targetEntityId"]) == (x["entity_id"], y["entity_id"])
    assert all(r["resolved_op"] == "create" for r in res.values())


def test_a_node_row_that_names_nothing_is_refused_and_so_is_an_edge_to_it():
    """Named only by the file's own entity_id, a node would be created again by every import (and
    a replace would delete the one before): refused, with the reason and its code."""
    ops, res = _pointer_run([
        _node_row(0, entity_id="f1", displayName="z"),
        {"_row_index": 1, "kind": "edge", "op": "upsert", "entity_id": "", "edgeType": "FLOWS",
         "source_entity_id": "f1", "targetUrn": "urn:li:y"},
        _node_row(2, entity_id="f2", qualifiedName="db.t", displayName="q"),
    ], urn_to_eid={"urn:li:y": "N2"}, node_eids={"N2"})
    assert (res[0]["resolved_op"], res[0]["code"]) == ("invalid", "no_key"), res[0]
    assert "give it a urn" in res[0]["reasons"][0]
    assert (res[1]["resolved_op"], res[1]["code"]) == ("invalid", "end_refused"), res[1]
    # Its reader said nothing of where the row is: it is named by its row, counted from 1.
    assert "the file's row 1, which" in res[1]["reasons"][0], "it names the refused row to fix"
    # A qualifiedName finds its node again: such a row is still made.
    assert res[2]["resolved_op"] == "create" and [o["entity_id"] for o in ops] == [
        res[2]["matched_entity_id"]]


def test_an_exports_urn_uuid_entity_id_no_entity_holds_is_the_new_nodes_id():
    """From another environment: kept as the id, so an entity has one id everywhere. One another
    entity holds is a link between the file's rows; so is any entity_id with identifier=urn."""
    other = "urn:uuid:0192f5a4-7b3c-7d2e-8f1a-2b3c4d5e6f73"
    ops, res = _pointer_run([
        _node_row(0, entity_id=_U.upper(), urn="urn:li:x", displayName="x"),
        _node_row(1, entity_id=_TAKEN, urn="urn:li:y", displayName="y"),
        _node_row(2, entity_id=other, displayName="z"),
    ], taken={_TAKEN})
    assert (ops[0]["entity_id"], ops[0]["payload"]["urn"]) == (_U, "urn:li:x")
    assert ops[1]["entity_id"] == pointer_id("ds1", "urn:li:y")
    assert ops[2]["entity_id"] == ops[2]["payload"]["urn"] == other, "its id is its urn too"
    v7s = iter(f"urn:uuid:0192f5a4-0000-7000-8000-00000000000{i}" for i in range(10))
    _ops, by_urn = resolve_rows([_node_row(0, entity_id=_U, urn="urn:li:x", displayName="x"),
                                 _node_row(1, entity_id=other, displayName="z")],
                                {"urn_to_eid": {}, "node_eids": set()},
                                mint_id=lambda: next(v7s), mint_urn=lambda _t: next(v7s),
                                derive_urn=lambda seed: pointer_id("ds1", seed), identifier="urn")
    assert _ops[0]["entity_id"] == pointer_id("ds1", "urn:li:x")
    assert (by_urn[1]["resolved_op"], by_urn[1]["code"]) == ("invalid", "no_key")


def test_by_urn_a_row_is_found_by_its_entity_id_or_its_urn_and_nothing_else():
    keys = KeyIndex(match={"Table": ["sap_id"]})
    keys.add("Table", {"sap_id": "S1"}, "N3")
    base = {"urn_to_eid": {"urn:li:x": "N1", "A-9": "N4"}, "qname_to_eid": {"db.t": "N2"},
            "node_eids": {"N1", "N2", "N3", "N4", "N5"}, "keys": keys, "edge_to_eid": {},
            "current": {e: {"urn": f"urn:{e}", "entityType": "Table"} for e in
                        ("N1", "N2", "N3", "N4", "N5")}}
    v7s = iter(f"urn:uuid:0192f5a4-0000-7000-8000-00000000000{i}" for i in range(10))
    ops, res = resolve_rows([
        _node_row(0, urn="urn:li:x", displayName="by urn"),
        _node_row(1, entity_id="N5", displayName="by id"),
        _node_row(2, qualifiedName="db.t", displayName="q"),                  # not by these:
        _node_row(3, properties={"sap_id": "S1"}, displayName="k"),
        _node_row(4, properties={"asset_id": "A-9"}, displayName="i"),
        {"_row_index": 5, "kind": "edge", "op": "upsert", "entity_id": "", "edgeType": "FLOWS",
         "sourceUrn": "urn:li:x", "targetQualifiedName": "db.t"},
        {"_row_index": 6, "kind": "edge", "op": "upsert", "entity_id": "", "edgeType": "FLOWS",
         "sourceUrn": "urn:li:x", "target_entity_id": "N5"},
    ], base, mint_id=lambda: next(v7s), mint_urn=lambda _t: next(v7s), identity_prop="asset_id",
        derive_urn=lambda seed: pointer_id("ds1", seed), identifier="urn")
    res = {r["_row_index"]: r for r in res}
    assert [res[i]["matched_entity_id"] for i in (0, 1)] == ["N1", "N5"]
    assert all((res[i]["resolved_op"], res[i]["code"]) == ("invalid", "no_key") for i in (2, 3, 4))
    assert (res[5]["resolved_op"], res[5]["code"]) == ("invalid", "end_not_found")
    edge = next(o for o in ops if o["entity_kind"] == "edge")["payload"]
    assert (edge["sourceEntityId"], edge["targetEntityId"]) == ("N1", "N5")


def test_a_new_edge_takes_the_id_its_ends_and_type_derive():
    from backend.app.services.versioning.import_export.resolve import edge_pointer_id
    derive = lambda s, t, ty: edge_pointer_id("ds1", s, t, ty)      # noqa: E731
    rows = [{"_row_index": 0, "kind": "edge", "op": "upsert", "entity_id": "", "edgeType": "flows",
             "source_entity_id": "N1", "target_entity_id": "N2"},
            {"_row_index": 1, "kind": "edge", "op": "upsert", "entity_id": "", "edgeType": "FLOWS",
             "source_entity_id": "N1", "target_entity_id": "N2", "properties": {"w": 1}}]
    ops, res = resolve_rows(rows, {"node_eids": {"N1", "N2"}}, mint_id=lambda: "minted",
                            derive_edge=derive)
    assert ops[0]["entity_id"] == edge_pointer_id("ds1", "N1", "N2", "FLOWS") != "minted"
    assert edge_pointer_id("ds1", "N1", "N2", "flows") == ops[0]["entity_id"], "type case-free"
    assert edge_pointer_id("ds1", "N2", "N1", "FLOWS") != ops[0]["entity_id"], "ends are ordered"
    assert edge_pointer_id("ds2", "N1", "N2", "FLOWS") != ops[0]["entity_id"]
    # The second row names the same edge: one edge, the second row its update (or refused).
    assert [r["matched_entity_id"] for r in res] == [ops[0]["entity_id"]] * 2


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
    assert res[0]["code"] == "edge_moved" and res[0].get("mentions") == ["N1", "N2", "N3"], (
        "the ends it names, and its edge's, are kept by a replace as any edge row's are")
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


# ── By a matching property (identifier=prop.<name>) ─────────────────────────────────────────────
import pytest  # noqa: E402

from backend.app.services.versioning.import_export.resolve import key_pointer_id  # noqa: E402


def _by_prop(rows, **indexes):
    v7s = iter(f"urn:uuid:0192f5a4-0000-7000-8000-00000000000{i}" for i in range(10))
    base = {"urn_to_eid": {}, "qname_to_eid": {"db.t": "N9"}, "edge_to_eid": {},
            "node_eids": set(), "current": {}}
    ops, res = resolve_rows(rows, {**base, **indexes}, mint_id=lambda: next(v7s),
                            mint_urn=lambda _t: next(v7s), identity_prop="asset_id",
                            derive_urn=lambda seed: pointer_id("ds1", seed),
                            derive_key=lambda v: key_pointer_id("ds1", "ext", v),
                            identifier="prop.ext")
    return ops, {r["_row_index"]: r for r in res}


def test_by_a_property_a_row_is_found_by_its_value_or_its_entity_id_and_nothing_else():
    held = {"urn": "urn:N1", "entityType": "Table", "properties": {"ext": "E1"}}
    ops, res = _by_prop([
        _node_row(0, properties={"ext": "E1", "k": 2}),                      # by its value
        _node_row(1, entity_id="N2", displayName="by id"),
        _node_row(2, urn="urn:N1", qualifiedName="db.t", displayName="no"),  # urn, name: not keys
        {"_row_index": 3, "kind": "edge", "op": "upsert", "entity_id": "", "edgeType": "FLOWS",
         "sourceKeys": {"ext": "E1"}, "target_entity_id": "N2"},
    ], urn_to_eid={"E1": "N1"}, node_eids={"N1", "N2"},
        current={"N1": held, "N2": {"urn": "urn:N2", "entityType": "Table"}})
    assert (res[0]["resolved_op"], res[0]["matched_entity_id"]) == ("update", "N1")
    assert ops[0]["payload"] == {"properties": {"k": 2}}, ops[0]
    assert (res[1]["resolved_op"], res[1]["matched_entity_id"]) == ("update", "N2")
    assert (res[2]["resolved_op"], res[2]["code"]) == ("invalid", "no_key")
    assert "give it one" in res[2]["reasons"][0] and "ext" in res[2]["reasons"][0]
    edge = next(o for o in ops if o["entity_kind"] == "edge")["payload"]
    assert (edge["sourceEntityId"], edge["targetEntityId"]) == ("N1", "N2")


def test_by_a_property_a_value_two_nodes_hold_or_another_nodes_value_is_refused():
    _ops, res = _by_prop([
        _node_row(0, properties={"ext": "DUP"}),
        _node_row(1, entity_id="N2", properties={"ext": "E1"}),               # N1's value
        {"_row_index": 2, "kind": "edge", "op": "upsert", "entity_id": "", "edgeType": "FLOWS",
         "sourceKeys": {"ext": "DUP"}, "target_entity_id": "N2"},
    ], urn_to_eid={"E1": "N1"}, dupes={"DUP": ["N3", "N4"]}, node_eids={"N1", "N2"},
        current={"N2": {"urn": "urn:N2", "entityType": "Table"}})
    assert (res[0]["code"], "N3" in res[0]["reasons"][0]) == ("duplicate_value", True), res[0]
    assert res[1]["code"] == "two_entities", res[1]
    assert res[2]["code"] == "duplicate_value", res[2]


def test_by_a_property_a_new_node_takes_the_id_its_value_derives_unless_a_node_holds_it():
    ops, res = _by_prop([
        _node_row(0, properties={"ext": "NEW"}, displayName="new"),
        _node_row(1, properties={"ext": "MOVED"}, displayName="its id is taken"),
        _node_row(2, properties={"ext": "GONE"}, urn="urn:li:gone", displayName="back"),
    ], taken={key_pointer_id("ds1", "ext", "MOVED")}, restore={"GONE": "ent_D"})
    new, moved, back = ops
    assert new["entity_id"] == new["payload"]["urn"] == key_pointer_id("ds1", "ext", "NEW")
    assert new["payload"]["properties"] == {"ext": "NEW"}, "the value is kept"
    assert moved["entity_id"] != key_pointer_id("ds1", "ext", "MOVED"), "a fresh id, not the taken one"
    assert (back["entity_id"], back["payload"]["urn"]) == ("ent_D", "urn:li:gone"), back
    assert all(r["resolved_op"] == "create" for r in res.values())


def test_by_a_property_values_compare_as_trimmed_text_and_case_counts():
    _ops, res = _by_prop([
        _node_row(0, properties={"ext": "  E1 "}),                 # trimmed: N1's
        _node_row(1, properties={"ext": "e1"}, displayName="e1"),   # another case: another key
        _node_row(2, properties={"ext": 12345}),                    # a number: as its text
    ], urn_to_eid={"E1": "N1", "12345": "N5"}, node_eids={"N1", "N5"},
        current={"N1": {"urn": "urn:N1", "entityType": "Table", "properties": {"ext": "E1"}},
                 "N5": {"urn": "urn:N5", "entityType": "Table", "properties": {"ext": "12345"}}})
    assert res[0]["matched_entity_id"] == "N1" and res[0]["resolved_op"] != "create", res[0]
    assert res[1]["resolved_op"] == "create", res[1]
    assert res[2]["matched_entity_id"] == "N5", res[2]


@pytest.mark.parametrize("value", ["", "   ", PROP_DELETE, ["E1"], {"id": "E1"}, None])
def test_by_a_property_a_blank_removed_or_structured_value_is_no_key(value):
    _ops, res = _by_prop([_node_row(0, properties={"ext": value})], urn_to_eid={"E1": "N1"},
                         node_eids={"N1"})
    assert (res[0]["resolved_op"], res[0]["code"]) == ("invalid", "no_key"), res[0]


def test_by_a_property_one_value_twice_in_a_file_names_one_node():
    ops, res = _by_prop([
        _node_row(0, properties={"ext": "NEW"}, displayName="new"),
        _node_row(1, properties={"ext": "NEW"}, displayName="new"),          # the same again
        _node_row(2, properties={"ext": "NEW"}, displayName="renamed"),      # and changing it
    ])
    assert [res[i]["resolved_op"] for i in range(3)] == ["create", "unchanged", "invalid"], res
    assert res[2]["code"] == "named_already" and "row 1 of this file" in res[2]["reasons"][0]
    assert len([o for o in ops if o["entity_kind"] == "node"]) == 1


def test_by_a_property_an_edge_end_no_node_holds_the_value_of_is_refused():
    ops, res = _by_prop([
        {"_row_index": 0, "kind": "edge", "op": "upsert", "entity_id": "", "edgeType": "FLOWS",
         "sourceKeys": {"ext": "NOPE"}, "target_entity_id": "N2"},
    ], node_eids={"N2"}, current={"N2": {"urn": "urn:N2", "entityType": "Table"}})
    assert (res[0]["resolved_op"], res[0]["code"]) == ("invalid", "end_not_found"), res[0]
    assert ops == []


def test_by_a_property_a_new_nodes_urn_another_node_holds_refuses_the_row():
    """One urn, one node: a new node's urn that a live node holds, or a node an earlier row of the
    file makes, refuses its row, naming that node — the projection keys nodes by their urn."""
    ops, res = _by_prop([
        _node_row(0, properties={"ext": "E2"}, urn="urn:li:orders", displayName="new value"),
        _node_row(1, properties={"ext": "A"}, urn="urn:li:x", displayName="a"),
        _node_row(2, properties={"ext": "B"}, urn="urn:li:x", displayName="b"),        # row 1's
        _node_row(3, properties={"ext": "GONE"}, urn="urn:li:orders", displayName="back"),
        _node_row(4, properties={"ext": "GONE"}, urn="urn:li:gone", displayName="back"),
    ], urn_held={"urn:li:orders": "N1"}, restore={"GONE": "ent_D"})
    assert (res[0]["resolved_op"], res[0]["code"]) == ("invalid", "two_entities"), res[0]
    assert "N1" in res[0]["reasons"][0] and "entity_id" in res[0]["reasons"][0], res[0]
    made = key_pointer_id("ds1", "ext", "A")
    assert (res[1]["resolved_op"], res[1]["matched_entity_id"]) == ("create", made)
    assert (res[2]["code"], made in res[2]["reasons"][0]) == ("two_entities", True), res[2]
    assert res[3]["code"] == "two_entities", "a node brought back takes no other node's urn"
    assert (res[4]["resolved_op"], res[4]["matched_entity_id"]) == ("create", "ent_D"), res[4]
    assert [o["payload"]["urn"] for o in ops] == ["urn:li:x", "urn:li:gone"], ops


# ---- identifier=prop.<name>,urn: the property, then the urn --------------------------------------

def _by_prop_or_urn(rows, identifier="prop.ext,urn", **indexes):
    v7s = iter(f"urn:uuid:0192f5a4-0000-7000-8000-00000000000{i}" for i in range(10))
    base = {"urn_to_eid": {}, "qname_to_eid": {}, "edge_to_eid": {}, "node_eids": set(), "current": {}}
    ops, res = resolve_rows(rows, {**base, **indexes}, mint_id=lambda: next(v7s),
                            mint_urn=lambda _t: next(v7s), identity_prop="asset_id",
                            derive_urn=lambda seed: pointer_id("ds1", seed),
                            derive_edge=lambda s, t, e: f"edge:{s}>{t}:{e}",
                            derive_key=lambda v: key_pointer_id("ds1", "ext", v),
                            identifier=identifier)
    return ops, {r["_row_index"]: r for r in res}


def test_with_urn_a_row_without_the_property_is_found_by_its_urn_and_one_with_it_by_its_value():
    """A top-level container the source has no id for is found by its urn, as identifier=urn finds
    it; a row whose value no node holds yet, by its urn too — that node takes the value, and the
    next import finds it by it. Nothing is refused."""
    domain = {"urn": "urn:svc:domain", "entityType": "Table", "displayName": "Sales"}
    orders = {"urn": "urn:svc:orders", "entityType": "Table", "displayName": "orders"}
    ops, res = _by_prop_or_urn([
        _node_row(0, urn="urn:svc:domain", displayName="Sales"),                          # no ext
        _node_row(1, urn="urn:svc:orders", displayName="orders", properties={"ext": "E1"}),
        _node_row(2, urn="urn:svc:new", displayName="new", properties={"ext": "E2"}),
        _node_row(3, urn="urn:svc:root", displayName="root"),                              # no ext, new
    ], urn_hits={"urn:svc:domain": "D1", "urn:svc:orders": "O1"}, node_eids={"D1", "O1"},
        current={"D1": domain, "O1": orders})
    assert (res[0]["resolved_op"], res[0]["matched_entity_id"]) == ("unchanged", "D1"), res[0]
    assert (res[1]["resolved_op"], res[1]["matched_entity_id"]) == ("update", "O1"), res[1]
    assert any("found by its urn: it takes ext 'E1'" in r for r in res[1]["reasons"]), res[1]
    (adopt,) = [o for o in ops if o["entity_id"] == "O1"]
    assert adopt["payload"]["properties"] == {"ext": "E1"}, "the value is written: found by it next"
    assert (res[2]["resolved_op"], res[2]["matched_entity_id"]) == ("create", key_pointer_id("ds1", "ext", "E2"))
    assert (res[3]["resolved_op"], res[3]["matched_entity_id"]) == ("create", pointer_id("ds1", "urn:svc:root")), (
        "a new node without the property takes the id its urn derives, as identifier=urn makes it")
    assert not any(r["status"] == "invalid" for r in res.values())


def test_with_urn_a_value_and_a_urn_that_name_two_nodes_refuse_the_row_keeping_both():
    ops, res = _by_prop_or_urn([
        _node_row(0, urn="urn:svc:b", displayName="x", properties={"ext": "EA"}),     # EA is A's
        _node_row(1, displayName="no keys at all"),
    ], urn_to_eid={"EA": "A"}, urn_hits={"urn:svc:b": "B"}, node_eids={"A", "B"},
        current={"A": {"urn": "urn:svc:a", "entityType": "Table", "properties": {"ext": "EA"}},
                 "B": {"urn": "urn:svc:b", "entityType": "Table"}})
    assert (res[0]["code"], res[0].get("mentions")) == ("two_entities", ["A", "B"]), res[0]
    assert res[1]["code"] == "no_key" and "no ext and no urn" in res[1]["reasons"][0], res[1]
    assert ops == []


def test_with_urn_a_value_held_twice_is_settled_by_its_urn():
    ops, res = _by_prop_or_urn([
        _node_row(0, urn="urn:svc:b", displayName="b2", properties={"ext": "DUP"}),
        _node_row(1, urn="urn:svc:c", displayName="c", properties={"ext": "DUP"}),
    ], dupes={"DUP": ["A", "B"]}, urn_hits={"urn:svc:b": "B"}, node_eids={"A", "B"},
        current={"B": {"urn": "urn:svc:b", "entityType": "Table", "properties": {"ext": "DUP"}}})
    assert (res[0]["resolved_op"], res[0]["matched_entity_id"]) == ("update", "B"), res[0]
    assert (res[1]["code"], res[1].get("mentions")) == ("duplicate_value", ["A", "B"]), res[1]


def test_by_the_property_alone_a_row_with_only_a_urn_says_how_to_find_it_and_keeps_its_node():
    """Strict prop.ext: the row is refused, its reason and hint say ,urn would find it, and the node
    its urn names is kept by a replace (``mentions``) though the row matched nothing."""
    _ops, res = _by_prop([_node_row(0, urn="urn:svc:domain", displayName="Sales")],
                         urn_hits={"urn:svc:domain": "D1"})
    row = res[0]
    assert (row["code"], row.get("mentions"), row.get("hint")) == ("no_key", ["D1"], "by_urn"), row
    assert "identifier=prop.ext,urn" in row["reasons"][0], row


def test_by_the_property_alone_a_new_rows_urn_on_a_node_without_it_says_to_add_urn():
    _ops, res = _by_prop([_node_row(0, urn="urn:svc:orders", displayName="o", properties={"ext": "E9"})],
                         urn_held={"urn:svc:orders": "O1"}, urn_hits={"urn:svc:orders": "O1"},
                         current={"O1": {"urn": "urn:svc:orders", "entityType": "Table"}})
    row = res[0]
    assert (row["code"], row.get("mentions"), row.get("hint")) == ("two_entities", ["O1"], "by_urn"), row
    assert "holds no ext" in row["reasons"][0] and "prop.ext,urn" in row["reasons"][0], row


def test_with_urn_an_edge_end_without_the_property_is_found_by_its_urn():
    ops, res = _by_prop_or_urn([
        _edge_row(0, sourceUrn="urn:svc:domain", targetKeys={"ext": "E1"}),
        _edge_row(1, sourceUrn="urn:svc:domain", targetUrn="urn:svc:b", targetKeys={"ext": "E1"}),
    ], urn_to_eid={"E1": "O1"}, urn_hits={"urn:svc:domain": "D1", "urn:svc:b": "B"},
        node_eids={"D1", "O1", "B"})
    assert (res[0]["resolved_op"], res[0].get("mentions")) == ("create", ["D1", "O1"]), res[0]
    assert ops[0]["payload"]["sourceEntityId"] == "D1"
    assert res[1]["code"] == "two_entities", "its target's value and urn name two nodes"


def test_by_the_property_alone_an_edge_end_given_by_urn_says_how_to_find_it_and_keeps_both():
    _ops, res = _by_prop([_edge_row(0, sourceUrn="urn:svc:domain", targetKeys={"ext": "E1"})],
                         urn_to_eid={"E1": "O1"}, urn_hits={"urn:svc:domain": "D1"},
                         node_eids={"O1", "D1"}, edge_to_eid={("D1", "O1", "FLOWS"): "EDGE1"})
    row = res[0]
    assert row["code"] == "end_not_found" and "identifier=prop.ext,urn" in row["reasons"][0], row
    assert row.get("mentions") == ["D1", "EDGE1", "O1"], "its ends and the edge they name are kept"


def test_an_edge_whose_end_was_a_refused_node_row_says_which_row_to_fix():
    _ops, res = _by_prop([_edge_row(0, sourceKeys={"ext": "BAD"}, targetKeys={"ext": "E1"})],
                         urn_to_eid={"E1": "O1"}, node_eids={"O1"},
                         refused_names={"BAD": ("line 8", "invalid_type")})
    row = res[0]
    assert row["code"] == "end_refused" and "the file's line 8, which" in row["reasons"][0], row
    assert "invalid_type" in row["reasons"][0] and row.get("mentions") == ["O1"], row


def test_a_refused_edge_row_naming_a_live_edge_by_its_id_keeps_it():
    """Refused for its type, an edge row that names a live edge by its own id keeps that edge and
    its ends, which a replace would otherwise delete — the ends are read before the row's id."""
    held = {"edgeType": "FLOWS", "sourceEntityId": "N1", "targetEntityId": "N2"}
    _ops, res = resolve_rows(
        [_edge_row(0, entity_id="E1", edgeType="NOT_A_TYPE", source_entity_id="N1", target_entity_id="N2")],
        {"urn_to_eid": {}, "qname_to_eid": {}, "edge_to_eid": {}, "node_eids": {"N1", "N2"},
         "edge_eids": {"E1"}, "current": {"E1": held}},
        mint_id=lambda: "x", ontology={"node_types": ["Table"], "edge_types": ["FLOWS"]})
    row = res[0]
    assert row["code"] == "invalid_type" and row["matched_entity_id"] == "E1", row
    assert row.get("mentions") == ["N1", "N2"], row


def test_a_delete_row_with_no_key_its_identifier_reads_is_refused_not_already_gone():
    _ops, res = _by_prop([{"_row_index": 0, "kind": "node", "op": "delete", "entity_id": "",
                           "entityType": "Table", "urn": "urn:svc:x"}])
    assert (res[0]["status"], res[0]["code"]) == ("invalid", "no_key"), res[0]
    assert "mentions" not in res[0], "a refused delete keeps nothing its row meant to delete"
    # It says why as a delete, and — it has a urn — that ,urn would find it, counted as such.
    assert res[0]["reasons"] == [
        "it names nothing identifier=prop.ext finds a node by, so what it would delete can't be told: "
        "give it the ext (or entity_id) of the node to delete. It has a urn: to find a row without "
        "its ext by its urn, send identifier=prop.ext,urn"], res[0]
    assert res[0].get("hint") == "by_urn"


def test_a_delete_row_named_by_a_field_its_type_matches_by_that_finds_nothing_is_already_gone():
    """A delete named only by a field its type matches imports by names what it would delete, as a
    create named so is found again: one that finds nothing is done already, not refused. Named by
    nothing its identifier reads, it is refused as a delete (no_key), with no hint: it has no urn."""
    keys = KeyIndex(match={"Table": ["sap_id"]})
    _ops, res = _pointer_run([
        _node_row(0, op="delete", properties={"sap_id": "S-GONE"}),
        _node_row(1, op="delete", properties={"other": "x"}),
    ], keys=keys)
    assert (res[0]["resolved_op"], res[0]["code"]) == ("unchanged", "already_gone"), res[0]
    assert (res[1]["status"], res[1]["code"]) == ("invalid", "no_key"), res[1]
    assert res[1]["reasons"] == [
        "it names nothing identifier=entity_id finds a node by, so what it would delete can't be "
        "told: give it the urn (or entity_id) of the node to delete"] and "hint" not in res[1]


def test_in_one_pass_an_edge_whose_node_row_was_refused_above_says_so():
    """A dry run resolves nodes and edges together: an edge naming a node row refused in the same
    pass is end_refused, naming that row where its file has it, as across an import's windows."""
    _ops, res = _by_prop([
        _node_row(0, urn="urn:svc:domain", displayName="Sales", _at={"line": 1}),      # no ext
        _node_row(1, urn="urn:svc:a", displayName="a", properties={"ext": "EA"}),
        _edge_row(2, sourceUrn="urn:svc:domain", targetKeys={"ext": "EA"}),
    ])
    assert res[0]["code"] == "no_key"
    assert res[2]["code"] == "end_refused" and res[2]["reasons"] == [
        "its source urn:svc:domain is the node of the file's line 1, which was refused (no_key): fix "
        "that row, and this edge finds it"], res[2]
