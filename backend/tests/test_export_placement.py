"""A versioned export says where each node sits, when asked (stream.Placer).

Pins: each node's chain is read up the snapshot its records come from, a thousand nodes at a time,
with a memo of the containers met; containers are named by URN (``gv:<entity id>`` for one without,
as the canvas names it) once each; the spreadsheet formats' column pass reads no chain and writes
the columns all the same, a path as one text cell; and what an import makes of the file is what it
makes of the same file without them. The snapshot is faked at its page boundary;
integration/test_export_stream.py walks real containment.
"""
from __future__ import annotations

import csv
import io
import json

from backend.app.services.versioning.import_export import stream
from backend.app.services.versioning.import_export.formats import get_adapter
from backend.app.services.versioning.import_export.rowmodel import normalize
from backend.tests.test_export_native_lines import _Snap, edge, node

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


async def _imported(fmt, blob):
    async def body():
        yield blob
    return [normalize(r, r["kind"]) async for r in get_adapter(fmt).parse(body())]


async def test_every_format_carries_them_and_imports_as_without_them():
    snap = _graph()
    text = (await _file(snap, "csv")).decode("utf-8-sig")
    assert len(snap.walks) == 2, "the column pass reads no chain: two pages of nodes, once"
    rows = {r["entity_id"]: r for r in csv.DictReader(io.StringIO(text))}
    assert rows["t1"]["path"] == "Warehouse / gold" and rows["t1"]["pathUrns"] == "urn:db; gv:sc"
    assert rows["c1"]["path"] == "", "an edge's cells are empty"
    lines = [json.loads(line) for line in (await _file(_graph(), "ndjson")).splitlines()]
    assert lines[2]["pathUrns"] == ["urn:db", "gv:sc"]
    for fmt in ("csv", "tsv", "ndjson", "json", "xlsx"):
        placed = await _imported(fmt, await _file(_graph(), fmt))
        body = stream.write_export(lambda: stream.record_pages(_graph(), stream.Selection.of()), fmt=fmt)
        plain = await _imported(fmt, b"".join([chunk async for chunk in body]))
        assert placed == plain, fmt
