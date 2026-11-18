"""Dates and moments are stored one way, whoever writes them, and survive an export, a spreadsheet
and an import back.

* ``common.moments``: a date as ``YYYY-MM-DD``, a moment in UTC as ``YYYY-MM-DDTHH:MM:SSZ`` (``.sss``
  with milliseconds); no zone reads as UTC; the same moment written another way is the same value.
* Every property write (``property_patch``) stores that form; a moment sent back in another form
  keeps the stored text.
* An import reads an unchanged moment as unchanged, however the file wrote it — Excel's date cells
  and a spreadsheet's own day/month writing included — takes a changed one in the stored form, and
  refuses a date that reads both day-first and month-first.
* An Excel export writes a date or moment in a text cell, so Excel keeps an edit as typed.
"""
import asyncio
import io
import zipfile
from datetime import date, datetime, time, timedelta, timezone

import openpyxl

from backend.app.services.versioning.import_export.formats import get_adapter
from backend.app.services.versioning.import_export.resolve import resolve_rows
from backend.common.moments import (as_like, canonical, from_cell, locale_readings, same_moment)
from backend.common.property_patch import apply_patch, compose_patches, strip_deletes


def test_one_stored_form():
    assert canonical("2026-11-18") == "2026-11-18"
    assert canonical("2026-11-18T05:42:00Z") == "2026-11-18T05:42:00Z"
    assert canonical("2026-11-18 07:42:00+02:00") == "2026-11-18T05:42:00Z"
    assert canonical("2026-11-18T05:42") == "2026-11-18T05:42:00Z"           # no zone: UTC
    assert canonical("2026-11-18T05:42:07.120+00:00") == "2026-11-18T05:42:07.120Z"
    assert canonical("2026-11-18T05:42:07.000Z") == "2026-11-18T05:42:07Z"
    assert canonical("2026-11-18T00:30:00-0130") == "2026-11-18T02:00:00Z"
    for v in ("Finance", "2026-02-30", "18/11/2026", 42, None, "2026-11-18 noon"):
        assert canonical(v) == v


def test_the_same_moment_written_another_way():
    assert same_moment("2026-11-18T05:42:00Z", "2026-11-18 05:42:00.000+00:00")
    assert same_moment("2026-11-18T07:42:00+02:00", "2026-11-18T05:42")
    assert same_moment("2026-11-18", "2026-11-18T00:00:00Z")                 # a date cell's midnight
    assert not same_moment("2026-11-18T05:42:00Z", "2026-11-18T05:43:00Z")
    assert not same_moment("2026-11-18", "Finance")
    assert as_like("2026-11-18T00:00:00", "2026-11-01") == "2026-11-18"        # a date stays a date
    assert as_like("2026-11-18", "2026-11-01T09:00:00Z") == "2026-11-18T00:00:00Z"


def test_spreadsheet_cells_and_writing():
    assert from_cell(datetime(2026, 11, 18, 5, 42)) == "2026-11-18T05:42:00Z"
    assert from_cell(datetime(2026, 11, 18)) == "2026-11-18"
    assert from_cell(datetime(2026, 11, 18, 7, 42, tzinfo=timezone(timedelta(hours=2)))) == "2026-11-18T05:42:00Z"
    assert from_cell(date(2026, 11, 18)) == "2026-11-18"
    assert from_cell(time(5, 42, 7)) == "05:42:07"
    assert from_cell("text") == "text" and from_cell(3) == 3
    assert locale_readings("25/03/2026") == ["2026-03-25"]                     # only day-first is a date
    assert locale_readings("04/03/2026") == ["2026-03-04", "2026-04-03"]
    assert locale_readings("04.03.2026 5:42 PM") == ["2026-03-04T17:42:00Z", "2026-04-03T17:42:00Z"]
    assert locale_readings("2026-03-04") == [] and locale_readings("Finance") == []


def test_every_write_stores_one_form():
    # A create
    created = strip_deletes({"properties": {"due": "2026-11-18 07:42+02:00", "owner": "ana"}})
    assert created["properties"] == {"due": "2026-11-18T05:42:00Z", "owner": "ana"}
    plain = {"properties": {"owner": "ana"}}
    assert strip_deletes(plain) is plain
    # An update
    stored = {"properties": {"due": "2026-11-18T05:42:00Z", "legacy": "2026-11-18T07:42:00+02:00"}}
    out = apply_patch(stored, {"properties": {"due": "2026-11-19 09:00", "since": "2026-01-02T03:04:05+01:00"}})
    assert out["properties"]["due"] == "2026-11-19T09:00:00Z"
    assert out["properties"]["since"] == "2026-01-02T02:04:05Z"
    # The same moment sent back another way keeps the stored text — even an older form.
    same = apply_patch(stored, {"properties": {"legacy": "2026-11-18T05:42:00Z"}})
    assert same["properties"]["legacy"] == "2026-11-18T07:42:00+02:00"
    # Two patches composed
    assert compose_patches({"properties": {"a": "x"}}, {"properties": {"due": "2026-11-18T05:42"}})["properties"]["due"] \
        == "2026-11-18T05:42:00Z"


def _idx(props):
    return {"urn_to_eid": {"urn:A": "ent_A"}, "qname_to_eid": {"a": "ent_A"}, "edge_to_eid": {},
            "node_eids": {"ent_A"}, "edge_eids": set(),
            "current": {"ent_A": {"urn": "urn:A", "entityType": "Table", "displayName": "A",
                                  "qualifiedName": "a", "properties": props}}}


def _row(props):
    return {"_row_index": 0, "kind": "node", "op": "upsert", "entity_id": "", "urn": "urn:A",
            "entityType": "Table", "displayName": "A", "qualifiedName": "a", "properties": props}


def test_import_reads_dates_back_as_they_are():
    stored = {"due": "2026-11-18T05:42:00Z", "certified": "2026-03-04"}
    # Unchanged, however the file wrote them: another ISO form, a date cell's text, Excel's writing.
    for back in ({"due": "2026-11-18 05:42:00+00:00", "certified": "2026-03-04"},
                 {"due": "2026-11-18T07:42:00+02:00", "certified": "04/03/2026"},
                 {"due": "18/11/2026 05:42", "certified": "2026-03-04T00:00:00"}):
        ops, res = resolve_rows([_row(back)], _idx(stored), mint_id=lambda: "x")
        assert res[0]["resolved_op"] == "unchanged" and ops == [], (back, res)

    # Changed: taken in the stored form and kind.
    ops, res = resolve_rows([_row({"due": "2026-11-19 06:00", "certified": "25/03/2026"})], _idx(stored),
                            mint_id=lambda: "x")
    assert res[0]["resolved_op"] == "update"
    assert ops[0]["payload"]["properties"] == {"due": "2026-11-19T06:00:00Z", "certified": "2026-03-25"}

    # A spreadsheet date that reads two ways, neither the stored one, is refused with what to do.
    ops, res = resolve_rows([_row({"certified": "05/03/2026"})], _idx(stored), mint_id=lambda: "x")
    assert res[0]["resolved_op"] == "invalid" and res[0]["code"] == "ambiguous_date" and ops == []
    assert "YYYY-MM-DD" in res[0]["reasons"][0]


async def _one(b):
    yield b


def test_excel_round_trip():
    ad = get_adapter("xlsx")

    async def run():
        async def recs():
            yield {"kind": "node", "entity_id": "n1", "urn": "urn:A", "prop.due": "2026-11-18T05:42:00Z",
                   "prop.owner": "ana", "_op": ""}
        blob = b"".join([b async for b in ad.write(recs(), columns=["kind", "entity_id", "urn", "prop.due", "prop.owner", "_op"])])
        # The moment is in a text cell (Excel's "@"), the plain text is not.
        with zipfile.ZipFile(io.BytesIO(blob)) as z:
            sheet = "".join(z.read(n).decode() for n in z.namelist() if n.startswith("xl/worksheets/sheet"))
            styles = z.read("xl/styles.xml").decode()
        assert 's="4" t="inlineStr"><is><t xml:space="preserve">2026-11-18T05:42:00Z' in sheet
        assert 'numFmtId="49"' in styles
        untouched = [r async for r in ad.parse(_one(blob))]
        assert untouched[0]["prop.due"] == "2026-11-18T05:42:00Z"

        # Retyped in Excel, it comes back as a date cell: read as text in the stored form, never a
        # datetime object (which the import could not store).
        wb = openpyxl.Workbook()
        ws = wb.active
        ws.title = "Nodes"
        ws.append(["entity_id", "prop.due", "prop.certified", "prop.at"])
        ws.append(["n1", datetime(2026, 11, 19, 6, 0), datetime(2026, 3, 25), time(9, 30)])
        out = io.BytesIO()
        wb.save(out)
        parsed = [r async for r in ad.parse(_one(out.getvalue()))]
        assert parsed[0]["prop.due"] == "2026-11-19T06:00:00Z"
        assert parsed[0]["prop.certified"] == "2026-03-25"
        assert parsed[0]["prop.at"] == "09:30:00"

    asyncio.run(run())
