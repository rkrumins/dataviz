"""A change list as CSV: one row per change, or one per changed field and property — each named
as the app names it, bookkeeping left out, and no cell a spreadsheet would run as a formula."""
from backend.app.services.versioning import change_csv
from backend.app.services.versioning.change_csv import cell, change_row, field_changes, field_rows, filename


def test_each_property_that_changed_is_its_own_change():
    rows = field_changes(
        {"displayName": "orders", "version": "v1", "childCount": 3,
         "properties": {"owner": "ana", "Technical/Physical/format": "csv", "keep": 1}},
        {"displayName": "Orders", "version": "v2", "childCount": 4,
         "properties": {"owner": "bo", "Technical/Physical/format": "parquet", "keep": 1, "pii": True}},
        "node")
    assert rows == [
        ("Name", "", "orders", "Orders"),
        ("owner", "", "ana", "bo"),
        ("pii", "", None, True),
        ("format", "Technical/Physical", "csv", "parquet"),
    ]


def test_an_added_entity_lists_what_it_has_and_empty_is_unchanged():
    assert field_changes(None, {"displayName": "New", "entityType": "Table", "urn": "u"}, "node") == [
        ("Name", "", None, "New"), ("Type", "", None, "Table")]
    assert field_changes({"description": None, "tags": []}, {"description": ""}, "node") == []


def test_an_edge_reads_as_a_relationship_with_its_flattened_properties():
    rows = field_changes({"edgeType": "FEEDS", "sourceEntityId": "a", "targetEntityId": "b", "note": "x"},
                         {"edgeType": "FEEDS", "sourceEntityId": "a", "targetEntityId": "c", "properties": {"note": "y"}},
                         "edge")
    assert [r[0] for r in rows] == ["To", "note"]


def test_no_cell_runs_as_a_formula():
    assert cell("=HYPERLINK(\"x\")") == "'=HYPERLINK(\"x\")"
    assert cell("+1") == "'+1" and cell("-2") == "'-2" and cell("@SUM(A1)") == "'@SUM(A1)"
    assert cell("ok") == "ok" and cell(None) == "" and cell(True) == "Yes"
    assert cell(["pii", "gdpr"]) == "pii; gdpr"
    assert cell({"b": 1, "a": 2}) == '{"a": 2, "b": 1}'


def test_rows_name_a_change_and_its_fields():
    node = {"entityId": "e1", "kind": "node", "status": "modified", "type": "Table",
            "displayName": "Orders", "qualifiedName": "db.orders", "urn": "urn:orders"}
    assert change_row(node) == ["Entity", "Edited", "Table", "Orders", "db.orders", "urn:orders", "e1", "", ""]
    edge = {"entityId": "x1", "kind": "edge", "status": "added", "type": "FEEDS",
            "sourceEntityId": "a", "targetEntityId": "b", "sourceName": "Orders", "targetName": None}
    assert change_row(edge) == ["Relationship", "Added", "FEEDS", "", "", "", "x1", "Orders", "b"]
    rows = list(field_rows(node, {"description": "=1"}, {"description": "Daily"}))
    assert rows == [change_row(node) + ["Description", "", "'=1", "Daily"]]
    assert list(field_rows(node, {"version": "1"}, {"version": "2"})) == [change_row(node) + ["", "", "", ""]]
    assert len(change_csv.FIELD_COLUMNS) == len(rows[0])


def test_its_file_is_named_for_what_it_holds():
    assert filename({"branch_id": "br_1"}, "changes") == "changes-draft-br_1.csv"
    assert filename({"from_seq": 41, "to_seq": 42}, "properties") == "changes-r41-r42-properties.csv"
