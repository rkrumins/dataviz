"""The import template is the record format made concrete for one data source.

``build_template`` reads nothing of the graph — a template never carries a real entity, which
importing it as it is would change. From the data source's ontology it lays out every column a file
can carry (each type's properties, the identifier property, the fields an edge's ends are found by)
and a worked row of each entity type and an edge of each relationship type, pointing at its nodes by
example urns. Every row passes the record contract and reads back through the importer; a workbook
says what each column means on its Columns sheet; CSV starts with a BOM.
"""
from __future__ import annotations

import csv
import io

import openpyxl

from backend.app.services.versioning.import_export import contract
from backend.app.services.versioning.import_export.formats import get_adapter
from backend.app.services.versioning.import_export.rowmodel import normalize
from backend.app.services.versioning.import_export.service import ImportExportService

ONTOLOGY = {
    "node_types": ["Table", "Column"], "edge_types": ["CONTAINS"],
    "fields": {"Table": [{"id": "owner", "name": "Owner", "type": "text", "required": True},
                         {"id": "sap_id", "name": "SAP id", "type": "text", "key": True}],
               "Column": [{"id": "rows", "name": "Rows", "type": "number"}]},
    "edge_ends": {"CONTAINS": {"source": ["Table"], "target": ["Column"]}},
    "keys": {"Table": ["sap_id"]},
}


def _service():
    return ImportExportService(versioning=object(), store=object())     # reads no graph


def _csv(blob: bytes):
    assert blob.startswith("﻿".encode()), "a BOM: a spreadsheet reads it as UTF-8"
    return list(csv.DictReader(io.StringIO(blob.decode("utf-8-sig"))))


async def test_a_template_has_a_row_of_each_type_and_a_column_of_each_property():
    blob = await _service().build_template(export_format="csv", ontology=ONTOLOGY,
                                           identity_property="asset_id")
    rows = _csv(blob)
    assert [(r["kind"], r["entityType"] or r["edgeType"]) for r in rows] == [
        ("node", "Column"), ("node", "Table"), ("edge", "CONTAINS")]
    columns = list(rows[0])
    for column in ("prop.owner", "prop.sap_id", "prop.rows", "prop.asset_id",
                   "source.asset_id", "target.asset_id", "source.sap_id", "target.sap_id"):
        assert column in columns, column
    assert columns[-1] == "_op"
    column, table, edge = rows
    assert (edge["sourceUrn"], edge["targetUrn"]) == (table["urn"], column["urn"]), \
        "an edge joins example nodes of the types it may join"
    assert table["urn"].startswith("urn:example:") and table["entity_id"] == ""

    # Every row passes the contract, and the importer reads every row back.
    async def body():
        yield blob
    for record in [r async for r in get_adapter("csv").parse(body())]:
        contract.validate_record({k: v for k, v in record.items() if v not in ("", None)})
        assert not normalize(record, record["kind"]).get("op_error"), record


async def test_without_an_ontology_a_template_holds_worked_examples():
    rows = _csv(await _service().build_template(export_format="csv"))
    assert [r["kind"] for r in rows] == ["node", "node", "edge"]
    assert rows[0]["displayName"] == "Example table"


async def test_a_workbook_template_says_what_each_column_means():
    blob = await _service().build_template(export_format="xlsx", ontology=ONTOLOGY,
                                           identity_property="asset_id")
    book = openpyxl.load_workbook(io.BytesIO(blob))
    assert book.sheetnames == ["Instructions", "Nodes", "Edges", "Columns"]
    explained = {row[0].value: row[3].value for row in book["Columns"].iter_rows(min_row=2)}
    for sheet in ("Nodes", "Edges"):
        for header in next(book[sheet].iter_rows(max_row=1)):
            assert header.value in explained and explained[header.value], header.value
    assert "pointer" in explained["urn"] and "reserved" in explained["prop.asset_id"]
    assert "required for a new Table" in explained["prop.owner"]
