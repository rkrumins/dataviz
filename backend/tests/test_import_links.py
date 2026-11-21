"""Importing links on their own — the parse (no infra).

A file of links between entities a graph already holds needs no entity rows and no ``kind`` column:
a row is a link by what it carries (an ``edgeType`` and no ``entityType``), in CSV, JSON or any
Excel sheet (a workbook of the user's own, "Links" or "Sheet1", read whole when it has no Nodes or
Edges sheet). A bad cell refuses its own row, never the whole file. The rows' resolution is in
test_import_resolve.py, and the import against a database in integration/test_offline_round_trip.py.
"""
import asyncio
import io

import openpyxl

from backend.app.services.versioning.import_export.formats import get_adapter
from backend.app.services.versioning.import_export.import_worker import _normalize_page
from backend.app.services.versioning.import_export.rowmodel import normalize, record_kind


async def _one(b):
    yield b


def _parse(fmt, body):
    async def run():
        return [r async for r in get_adapter(fmt).parse(_one(body))]
    return asyncio.run(run())


def test_a_row_is_a_link_or_an_entity_by_what_it_carries():
    assert record_kind({"edgeType": "FEEDS", "sourceUrn": "urn:a", "targetUrn": "urn:b"}) == "edge"
    assert record_kind({"entityType": "Table", "urn": "urn:a"}) == "node"
    assert record_kind({"kind": "Edge", "entityType": "Table"}) == "edge", "a kind column still decides"
    assert record_kind({"edgeType": "FEEDS", "entityType": "Table"}) == "", "both: neither"
    assert record_kind({"displayName": "x"}) == ""
    assert record_kind({"kind": "dashboard"}) == ""


def test_a_csv_or_json_of_links_needs_no_kind_column():
    csv = b"edgeType,sourceUrn,targetUrn,confidence,prop.via\nFEEDS,urn:a,urn:b,0.9,nightly\n"
    rows, skipped = _normalize_page(_parse("csv", csv))
    assert skipped == 0
    ((kind, row),) = rows
    assert kind == "edge"
    assert (row["edgeType"], row["sourceUrn"], row["targetUrn"], row["confidence"]) == ("FEEDS", "urn:a", "urn:b", 0.9)
    assert row["properties"] == {"via": "nightly"}

    rows, skipped = _normalize_page(_parse("json", b'[{"edgeType": "HAS", "sourceQualifiedName": "orders",'
                                                    b' "targetQualifiedName": "orders.id"}]'))
    assert (skipped, [k for k, _ in rows]) == (0, ["edge"])


def test_a_workbook_of_ones_own_is_read_whole():
    wb = openpyxl.Workbook()
    ws = wb.active
    ws.title = "Links"
    ws.append(["edgeType", "sourceUrn", "targetUrn"])
    ws.append(["FEEDS", "urn:a", "urn:b"])
    ws.append(["FEEDS", "urn:b", "urn:c"])
    other = wb.create_sheet("Instructions")
    other.append(["Not data"])
    buf = io.BytesIO()
    wb.save(buf)
    rows, skipped = _normalize_page(_parse("xlsx", buf.getvalue()))
    assert skipped == 0
    assert [(k, r["sourceUrn"], r["targetUrn"]) for k, r in rows] == [("edge", "urn:a", "urn:b"), ("edge", "urn:b", "urn:c")]


def test_a_bad_cell_refuses_its_row_not_the_file():
    bad = normalize({"edgeType": "FEEDS", "sourceUrn": "urn:a", "targetUrn": "urn:b", "confidence": "high"}, "edge")
    assert bad["op"] == "invalid" and bad["op_error"].startswith("confidence: 'high' isn't a number")
    gone = normalize({"edgeType": "FEEDS", "sourceUrn": "urn:a", "targetUrn": "urn:b", "confidence": "\\N"}, "edge")
    assert gone["op"] == "invalid"
    broken = normalize({"edgeType": "FEEDS", "sourceUrn": "urn:a", "targetUrn": "urn:b",
                        "properties_json": "{not json"}, "edge")
    assert broken["op"] == "invalid" and broken["op_error"].startswith("properties_json isn't valid JSON")
    fine = normalize({"edgeType": "FEEDS", "sourceUrn": "urn:a", "targetUrn": "urn:b", "confidence": "0.5"}, "edge")
    assert fine["op"] == "upsert" and fine["confidence"] == 0.5


def test_a_link_is_named_by_its_type_and_its_ends_source_first():
    from backend.app.services.versioning.import_export.import_worker import _label
    assert _label({"kind": "edge", "edgeType": "FEEDS", "source_entity_id": "e1", "targetUrn": "urn:b"}) \
        == "FEEDS e1 → urn:b", "ends named two ways: still source first"
    assert _label({"kind": "edge", "edgeType": "HAS", "sourceQualifiedName": "orders",
                   "targetKeys": {"sap_id": "7"}}) == "HAS orders → 7"
    assert _label({"kind": "edge", "edgeType": "FEEDS", "entity_id": "E1", "sourceUrn": "urn:a",
                   "targetUrn": "urn:b"}) == "FEEDS urn:a → urn:b", "an exported link: by its ends, not its id"
    assert _label({"kind": "edge", "entity_id": "E1", "op": "delete"}) == "E1", "a delete by id alone"
    assert _label({"kind": "node", "displayName": "orders", "urn": "urn:a"}) == "orders"
