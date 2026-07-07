"""xlsx adapter — round-trips the generic template through a real .xlsx workbook (Nodes + Edges
sheets), the strategic fix for flat-CSV column fragility. Kind comes from the SHEET (not a column),
identity columns are locked, and a stray value can't silently shift into _op. Needs openpyxl."""
import asyncio

from backend.app.services.versioning.import_export.formats import get_adapter


async def _one(b):
    yield b


async def _run() -> None:
    ad = get_adapter("xlsx")
    records = [
        {"kind": "node", "entity_id": "n1", "urn": "urn:a", "entityType": "Table",
         "displayName": "Orders", "qualifiedName": "sales.orders", "prop.owner": "alice", "_op": ""},
        {"kind": "node", "entity_id": "n2", "urn": "urn:b", "entityType": "Column",
         "displayName": "id", "qualifiedName": "sales.orders.id", "prop.owner": "bob", "_op": ""},
        {"kind": "edge", "entity_id": "e1", "edgeType": "CONTAINS",
         "sourceQualifiedName": "sales.orders", "targetQualifiedName": "sales.orders.id",
         "source_entity_id": "n1", "target_entity_id": "n2", "_op": ""},
    ]
    cols = ["kind", "entity_id", "urn", "entityType", "displayName", "qualifiedName",
            "edgeType", "sourceQualifiedName", "targetQualifiedName", "source_entity_id",
            "target_entity_id", "prop.owner", "_op"]

    async def _recs():
        for r in records:
            yield r

    blob = b"".join([b async for b in ad.write(_recs(), columns=cols)])
    assert blob[:4] == b"PK\x03\x04", "xlsx must be a zip (PK header)"

    parsed = [r async for r in ad.parse(_one(blob))]
    nodes = [r for r in parsed if r.get("kind") == "node"]
    edges = [r for r in parsed if r.get("kind") == "edge"]
    assert len(nodes) == 2 and len(edges) == 1, (len(nodes), len(edges))
    assert nodes[0]["displayName"] == "Orders" and nodes[0]["prop.owner"] == "alice"
    assert nodes[0]["entity_id"] == "n1" and nodes[0]["urn"] == "urn:a"
    assert "edgeType" not in nodes[0], "edge-only columns must not leak into node rows"
    assert edges[0]["edgeType"] == "CONTAINS" and edges[0]["source_entity_id"] == "n1"


def test_import_xlsx():
    asyncio.run(_run())


if __name__ == "__main__":
    asyncio.run(_run())
    print("import xlsx: OK")
