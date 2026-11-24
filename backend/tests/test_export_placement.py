"""A versioned export says where each node sits, when asked (stream.Placer).

Pins: each node's chain is read up the snapshot its records come from, a thousand nodes at a time,
with a memo of the containers met; containers are named by URN (``gv:<entity id>`` for one without,
as the canvas names it) once each; the spreadsheet formats' column pass reads no chain and writes
the columns all the same, a path as one text cell; and, in every format, what an import reads from
the file is what it reads from the same file without them — the same rows, nothing skipped or
refused, no column the record format doesn't know. An edge file that carries them anyway imports as
it would without them, and a property named like one of them (``prop.path``) stays a property. The
snapshot is faked at its page boundary; integration/test_export_stream.py walks real containment,
and integration/test_import_ancestry_matrix.py imports real exports, dry run and applied.
"""
from __future__ import annotations

import csv
import io
import json

import pytest

from backend.app.services.versioning.import_export import contract, stream
from backend.app.services.versioning.import_export.formats import get_adapter
from backend.app.services.versioning.import_export.import_worker import _normalize_page
from backend.common.ancestry_columns import ANCESTRY_COLUMNS
from backend.tests.test_export_native_lines import _Snap, edge, node

FORMATS = ("csv", "tsv", "ndjson", "json", "xlsx")

CONTAINMENT = {"CONTAINS": False, "PART_OF": True}


class _PlacedSnap(_Snap):
    """``_Snap`` with containment: ``parents`` is child → parent, by entity id."""

    def __init__(self, nodes, edges, parents, page_size=2):
        super().__init__(nodes, edges, page_size)
        self.parents = parents
        self.walks = []

    async def containment_ancestors(self, ids, types, child_is_source=frozenset(), parents=None):
        self.walks.append((list(ids), set(types), set(child_is_source)))
        out = {}
        for i in ids:
            chain, p = [], self.parents.get(i)
            while p:
                chain.append(p)
                p = self.parents.get(p)
            out[i] = chain
        return out


def _graph():
    nodes = [node("db", {"urn": "urn:db", "entityType": "Database", "displayName": "Warehouse"}),
             node("sc", {"entityType": "Schema", "displayName": "gold"}),         # no URN
             node("t1", {"urn": "urn:t1", "entityType": "Table", "displayName": "orders",
                         "properties": {"owner": "team"}})]
    edges = [edge("c1", "db", "sc", "CONTAINS"), edge("c2", "sc", "t1", "CONTAINS"),
             edge("l1", "t1", "db", "FEEDS")]
    return _PlacedSnap(nodes, edges, {"sc": "db", "t1": "sc", "lost": "gone"})


async def _records(snap, place=None):
    return [r async for page in stream.record_pages(snap, stream.Selection.of(), place=place) for r in page]


async def test_each_node_says_where_it_sits_up_the_snapshot_it_is_read_from():
    snap = _graph()
    records = {r["entity_id"]: r for r in await _records(snap, stream.Placer(snap, CONTAINMENT))}
    assert snap.walks[0][1:] == ({"CONTAINS", "PART_OF"}, {"PART_OF"}), "the types, each way"
    assert (records["db"]["path"], records["db"]["parentUrn"]) == ([], None), "the top of the graph"
    assert records["sc"]["parentUrn"] == "urn:db" and records["sc"]["parentType"] == "Database"
    t1 = records["t1"]
    assert (t1["parentUrn"], t1["parentName"], t1["parentType"]) == ("gv:sc", "gold", "Schema")
    assert (t1["path"], t1["pathUrns"]) == (["Warehouse", "gold"], ["urn:db", "gv:sc"])
    assert all("path" not in r for r in records.values() if r["kind"] == "edge")
    plain = await _records(_graph())
    assert all("path" not in r for r in plain), "only when asked"


async def test_a_container_outside_the_export_is_named_once_by_a_lookup():
    snap = _graph()
    place = stream.Placer(snap, CONTAINMENT)
    outside = {"kind": "node", "entity_id": "t1", "urn": "urn:t1"}
    await place([outside])
    assert outside["path"] == ["Warehouse", "gold"], "named from their versions"
    assert set(snap.payloads_read) == {"sc", "db"}
    again = {"kind": "node", "entity_id": "t1", "urn": "urn:t1"}
    await place([again])
    assert set(snap.payloads_read) == {"sc", "db"} and len(snap.payloads_read) == 2, "once each"
    lost = {"kind": "node", "entity_id": "lost"}
    await place([lost])
    assert lost["pathUrns"] == ["gv:gone"] and lost["parentName"] == "gv:gone", "a container not live"


async def _file(snap, fmt):
    place = stream.Placer(snap, CONTAINMENT)
    body = stream.write_export(
        lambda placed=True: stream.record_pages(snap, stream.Selection.of(), place=place if placed else None),
        fmt=fmt, placed=True)
    return b"".join([chunk async for chunk in body])


async def _written(records, fmt, placed):
    """``records`` as one page of an export in ``fmt``, as the export writes it."""
    async def pages(placed=True):
        yield [dict(r) for r in records]
    return b"".join([chunk async for chunk in stream.write_export(pages, fmt=fmt, placed=placed)])


async def _read(fmt, blob):
    """The file's records, as the import's reader gives them."""
    async def body():
        yield blob
    return [r async for r in get_adapter(fmt).parse(body())]


def _checked(records):
    """``records`` as the import reads them (``import_worker._normalize_page``), having checked
    that each is a record of the format: every column one it names (``unknown_columns``, what a dry
    run reports), every value one it takes, a blank cell being no value."""
    assert contract.unknown_columns(records) == []
    for r in records:
        contract.validate_record({k: v for k, v in r.items() if v not in ("", None)})
    rows, skipped = _normalize_page(records)
    assert skipped == 0 and all(row["op"] == "upsert" for _kind, row in rows), rows
    return rows


async def test_every_format_carries_them_a_path_as_one_cell_in_a_spreadsheet():
    snap = _graph()
    text = (await _file(snap, "csv")).decode("utf-8-sig")
    assert len(snap.walks) == 2, "the column pass reads no chain: two pages of nodes, once"
    rows = {r["entity_id"]: r for r in csv.DictReader(io.StringIO(text))}
    assert rows["t1"]["path"] == "Warehouse / gold" and rows["t1"]["pathUrns"] == "urn:db; gv:sc"
    assert rows["c1"]["path"] == "", "an edge's cells are empty"
    lines = [json.loads(line) for line in (await _file(_graph(), "ndjson")).splitlines()]
    assert lines[2]["pathUrns"] == ["urn:db", "gv:sc"]


@pytest.mark.parametrize("fmt", FORMATS)
async def test_a_file_with_them_imports_exactly_as_the_same_file_without_them(fmt):
    placed = await _read(fmt, await _file(_graph(), fmt))
    body = stream.write_export(lambda: stream.record_pages(_graph(), stream.Selection.of()), fmt=fmt)
    plain = await _read(fmt, b"".join([chunk async for chunk in body]))
    t1 = next(r for r in placed if r.get("entity_id") == "t1")
    assert set(ANCESTRY_COLUMNS) <= set(t1), "the file says where it sits"
    assert not any(set(ANCESTRY_COLUMNS) & set(r) for r in plain), "and without them, nothing does"
    assert _checked(placed) == _checked(plain)


@pytest.mark.parametrize("fmt", FORMATS)
async def test_an_edge_file_that_says_where_its_edges_sit_imports_as_without_it(fmt):
    """An export never says where an edge sits. A file that does anyway — made by hand, a column
    filled down a sheet — is read as it would be without: the same edges, nothing refused."""
    edges = [r for r in await _records(_graph()) if r["kind"] == "edge"]
    stray = [{**r, "parentUrn": "urn:db", "parentName": "Warehouse", "parentType": "Database",
              "path": ["Warehouse", "gold"], "pathUrns": ["urn:db", "gv:sc"]} for r in edges]
    with_them = await _read(fmt, await _written(stray, fmt, placed=True))
    assert all(r["parentUrn"] == "urn:db" for r in with_them), "the file carries them"
    without = await _read(fmt, await _written(edges, fmt, placed=False))
    assert _checked(with_them) == _checked(without)
    assert {row["edgeType"] for _kind, row in _checked(with_them)} == {"CONTAINS", "FEEDS"}


@pytest.mark.parametrize("fmt", FORMATS)
async def test_a_property_named_like_them_stays_a_property(fmt):
    """``prop.path`` and ``prop.parentName`` are a node's own properties, in a file that also says
    where its rows sat or in one that doesn't: only the bare columns are informational."""
    own = {"kind": "node", "urn": "urn:x", "entityType": "Table", "prop.path": "/data/x.csv",
           "prop.parentName": "Ops"}
    placed = {**own, "parentUrn": "urn:db", "parentName": "Warehouse", "parentType": "Database",
              "path": ["Warehouse"], "pathUrns": ["urn:db"]}
    for records, ask in (([placed], True), ([own], False)):
        [(_kind, row)] = _checked(await _read(fmt, await _written(records, fmt, placed=ask)))
        assert row["properties"] == {"path": "/data/x.csv", "parentName": "Ops"}, fmt
