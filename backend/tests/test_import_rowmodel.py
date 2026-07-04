"""rowmodel — the flat-column <-> normalized-row mapping that makes the template generic (no infra).

One shared column schema across xlsx/csv/ndjson: locked identity (entity_id/urn/baseVersion), core
fields per kind, dynamic ``prop.<name>`` columns + a ``properties_json`` overflow, and ``_op``.
``normalize`` turns a flat file record into the pipeline's normalized row (properties assembled,
empty cells dropped so a blank never blanks a field, tags/confidence coerced); ``denormalize_*``
does the reverse for export, spilling nested/complex property values into ``properties_json``.
Pure — runs under the per-file runner.
"""
import json

from backend.app.services.versioning.import_export.rowmodel import (
    denormalize_edge,
    denormalize_node,
    normalize,
)


def _run() -> None:
    # ---- node: prop.* + properties_json assemble; _op blank -> upsert; tags/baseVersion ----
    raw = {
        "entity_id": "ent_1", "urn": "urn:x", "entityType": "Table",
        "displayName": "Orders", "qualifiedName": "sales.orders",
        "prop.owner": "alice", "prop.pii": "true",
        "properties_json": '{"nested": {"a": 1}}',
        "tags": "a, b", "baseVersion": "h1", "_op": "",
    }
    n = normalize(raw, "node")
    assert n["kind"] == "node" and n["op"] == "upsert"
    assert n["entity_id"] == "ent_1" and n["urn"] == "urn:x" and n["entityType"] == "Table"
    assert n["displayName"] == "Orders" and n["qualifiedName"] == "sales.orders"
    assert n["properties"] == {"owner": "alice", "pii": "true", "nested": {"a": 1}}
    assert n["tags"] == ["a", "b"] and n["baseVersion"] == "h1"

    # ---- _op=delete -> op delete ----
    assert normalize({"entity_id": "e", "_op": "delete"}, "node")["op"] == "delete"

    # ---- empty cells are DROPPED (a blank never blanks a field; PATCH semantics) ----
    n2 = normalize({"entity_id": "e", "urn": "u", "displayName": "", "prop.x": ""}, "node")
    assert "displayName" not in n2 and n2["properties"] == {}

    # ---- edge: core fields + confidence coercion; new row has empty entity_id ----
    e = normalize({
        "entity_id": "", "edgeType": "LINEAGE",
        "sourceQualifiedName": "a", "targetQualifiedName": "b",
        "confidence": "0.9", "prop.k": "v", "_op": "",
    }, "edge")
    assert e["kind"] == "edge" and e["edgeType"] == "LINEAGE"
    assert e["sourceQualifiedName"] == "a" and e["targetQualifiedName"] == "b"
    assert e["confidence"] == 0.9 and e["properties"] == {"k": "v"}
    assert e["op"] == "upsert" and e.get("entity_id", "") == ""

    # ---- denormalize node: scalars -> prop.<name>, nested -> properties_json overflow ----
    rec = denormalize_node(
        "ent_1", "h1",
        {"urn": "urn:x", "entityType": "Table", "displayName": "Orders",
         "qualifiedName": "sales.orders",
         "properties": {"owner": "alice", "nested": {"a": 1}}, "tags": ["a", "b"]},
    )
    assert rec["entity_id"] == "ent_1" and rec["baseVersion"] == "h1"
    assert rec["urn"] == "urn:x" and rec["entityType"] == "Table"
    assert rec["prop.owner"] == "alice"
    assert json.loads(rec["properties_json"]) == {"nested": {"a": 1}}
    assert rec["tags"] == "a, b"

    # ---- round-trip: denormalize -> normalize reconstructs core + properties ----
    back = normalize(rec, "node")
    assert back["urn"] == "urn:x" and back["entityType"] == "Table"
    assert back["properties"] == {"owner": "alice", "nested": {"a": 1}}

    # ---- denormalize edge carries both endpoint entity_ids and qualified names ----
    erec = denormalize_edge(
        "ev_1", "h2",
        {"edgeType": "LINEAGE", "sourceEntityId": "ent_a", "targetEntityId": "ent_b",
         "confidence": 0.8, "properties": {"k": "v"}},
        source_qname="a", target_qname="b",
    )
    assert erec["entity_id"] == "ev_1" and erec["edgeType"] == "LINEAGE"
    assert erec["source_entity_id"] == "ent_a" and erec["target_entity_id"] == "ent_b"
    assert erec["sourceQualifiedName"] == "a" and erec["targetQualifiedName"] == "b"
    assert erec["prop.k"] == "v"


def test_import_rowmodel():
    _run()


if __name__ == "__main__":
    _run()
    print("import rowmodel: OK")
