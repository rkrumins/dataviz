"""An export as a view package's format-2 data lines, and what an export holds by type.

Pins: ``stream.native_pages`` writes each entity's stored payload text verbatim beside its identity
(no decode, no re-encode: its exact bytes are in the line), an edge with its ends' URNs and
qualified names; ``rowmodel.normalize`` reads such a line into the same row the flat (format-1)
record of that entity gives, with nested properties as they were stored; ``TypeStats`` counts by
type in the provider-stats shape; a view's export reads only its own entities' payloads; and a
starter template reads one page of each kind, never the whole graph. The snapshot is faked at its
page boundary; integration/test_export_stream.py reads real ones.
"""
from __future__ import annotations

import json
from dataclasses import replace
from typing import Dict, List

from backend.app.services.versioning.import_export import stream
from backend.app.services.versioning.import_export.rowmodel import normalize
from backend.app.services.versioning.import_export.snapshot import Winner


class _Snap:
    """Live entities, served a page at a time; records whose payloads were read."""

    def __init__(self, nodes: List[Winner], edges: List[Winner], page_size: int = 2) -> None:
        self.page_size = page_size
        self._by = {"node": {w.entity_id: w for w in nodes}, "edge": {w.entity_id: w for w in edges}}
        self.payloads_read: List[str] = []
        self.pages_read: Dict[str, int] = {"node": 0, "edge": 0}

    def _serve(self, w: Winner, payload: bool) -> Winner:
        if payload:
            self.payloads_read.append(w.entity_id)
            return w
        return replace(w, payload=None)

    async def iter_live(self, kind, payload=False):
        rows = sorted(self._by[kind].values(), key=lambda w: w.entity_id)
        for i in range(0, len(rows), self.page_size):
            self.pages_read[kind] += 1
            yield [self._serve(w, payload) for w in rows[i:i + self.page_size]]

    async def lookup_live(self, kind, entity_ids, payload=False):
        return {eid: self._serve(self._by[kind][eid], payload) for eid in entity_ids if eid in self._by[kind]}


def node(eid: str, payload: dict, *, text: str = None) -> Winner:
    return Winner(eid, True, f"v_{eid}", "g1", f"h_{eid}", urn=payload.get("urn"),
                  qualified_name=payload.get("qualifiedName"), entity_type=payload.get("entityType"),
                  payload=text if text is not None else json.dumps(payload))


def edge(eid: str, src: str, tgt: str, etype: str = "PRODUCES", **extra) -> Winner:
    payload = {"edgeType": etype, "sourceEntityId": src, "targetEntityId": tgt, **extra}
    return Winner(eid, True, f"v_{eid}", "g1", f"h_{eid}", source_id=src, target_id=tgt, edge_type=etype,
                  payload=json.dumps(payload))


# A payload as Postgres hands JSONB back: its own key order and spacing, kept to the byte.
_ORDERS_TEXT = ('{"urn": "urn:orders", "tags": ["pii", "a,b"], "entityType": "Table", '
                '"properties": {"owner": "team", "schema": {"cols": [{"n": "id"}]}, "rows": 5}, '
                '"displayName": "orders", "qualifiedName": "db.orders"}')


def _graph():
    nodes = [node("n1", json.loads(_ORDERS_TEXT), text=_ORDERS_TEXT),
             node("n2", {"urn": "urn:revenue", "entityType": "Metric", "displayName": "revenue",
                         "qualifiedName": "db.revenue"}),
             node("n3", {"displayName": "untyped"})]
    edges = [edge("e1", "n1", "n2", confidence=0.5, properties={"via": "etl"}),
             edge("e2", "n2", "gone")]                    # an end that isn't live
    return nodes, edges


async def _lines(snap, sel, **kw) -> List[dict]:
    out = b"".join([chunk async for chunk in stream.native_pages(snap, sel, **kw)])
    return [json.loads(line) for line in out.splitlines()], out


async def test_a_native_line_carries_the_stored_payload_verbatim():
    nodes, edges = _graph()
    tally, stats = {}, stream.TypeStats()
    lines, raw = await _lines(_Snap(nodes, edges), stream.Selection.of(), tally=tally, stats=stats)

    assert _ORDERS_TEXT.encode() in raw, "the payload's own bytes, never decoded and encoded again"
    first = lines[0]
    assert (first["kind"], first["entity_id"], first["baseVersion"]) == ("node", "n1", "h_n1")
    assert first["payload"] == json.loads(_ORDERS_TEXT)
    by_id = {line["entity_id"]: line for line in lines}
    assert by_id["e1"]["sourceUrn"] == "urn:orders" and by_id["e1"]["targetUrn"] == "urn:revenue"
    assert by_id["e1"]["sourceQualifiedName"] == "db.orders" and by_id["e1"]["targetQualifiedName"] == "db.revenue"
    assert "targetUrn" not in by_id["e2"], "an end that isn't live has no name to carry"
    assert [line["kind"] for line in lines] == ["node", "node", "node", "edge", "edge"]
    assert (tally["node"], tally["edge"]) == (3, 2)
    assert stats.as_dict() == {"nodeCount": 3, "edgeCount": 2,
                               "entityTypeCounts": {"Table": 1, "Metric": 1, "Entity": 1},
                               "edgeTypeCounts": {"PRODUCES": 2}}


async def test_a_native_line_reads_back_as_the_row_its_flat_record_gives():
    """Format 1 (flat records) and format 2 (native lines) of the same entities normalize alike —
    except that format 2 keeps what a flat record can't: the tags as the list they are."""
    nodes, edges = _graph()
    sel = stream.Selection.of()
    native, _ = await _lines(_Snap(nodes, edges), sel)
    flat = [r async for page in stream.record_pages(_Snap(nodes, edges), sel) for r in page]

    for v2, v1 in zip(native, flat):
        a, b = normalize(v2, v2["kind"], native=True), normalize(v1, v1["kind"], native=True)
        if a.get("tags") or b.get("tags"):
            assert a["tags"] == ["pii", "a,b"] and b["tags"] == ["pii", "a", "b"], \
                "a comma inside a tag survives only the native line"
            a, b = {k: v for k, v in a.items() if k != "tags"}, {k: v for k, v in b.items() if k != "tags"}
        assert a == b, (v2["entity_id"], a, b)
    assert normalize(native[0], "node", native=True)["properties"]["schema"] == {"cols": [{"n": "id"}]}


async def test_a_views_export_reads_only_its_own_entities_payloads():
    nodes, edges = _graph()
    snap = _Snap(nodes + [node(f"z{i}", {"urn": f"urn:z{i}", "entityType": "Table"}) for i in range(6)],
                 edges + [edge("e9", "z1", "z2")])
    sel = stream.Selection.of(keep={"n1", "n2"})
    records = [r async for page in stream.record_pages(snap, sel) for r in page]

    assert sorted(r["entity_id"] for r in records) == ["e1", "n1", "n2"]
    assert sorted(snap.payloads_read) == ["e1", "n1", "n2"], "no payload of an entity it doesn't hold"
    native, _ = await _lines(snap, sel)
    assert sorted(line["entity_id"] for line in native) == ["e1", "n1", "n2"]


async def test_type_stats_count_by_type_in_the_provider_shape_once_per_pass():
    nodes, edges = _graph()
    snap, stats = _Snap(nodes, edges), stream.TypeStats()
    for _ in range(2):                       # a spreadsheet takes two passes: counted once
        [p async for p in stream.record_pages(snap, stream.Selection.of(), stats=stats)]
    assert stats.as_dict()["nodeCount"] == 3
    assert stats.as_dict()["entityTypeCounts"] == {"Table": 1, "Metric": 1, "Entity": 1}


async def test_a_starter_template_reads_one_page_of_each_kind():
    nodes = [node(f"n{i}", {"urn": f"urn:{i}", "entityType": "Table"}) for i in range(10)]
    edges = [edge(f"e{i}", f"n{i}", f"n{i + 1}") for i in range(9)]
    snap = _Snap(nodes, edges, page_size=3)
    records = await stream.first_records(snap, 3)

    assert [r["kind"] for r in records] == ["node"] * 3 + ["edge"] * 3
    assert snap.pages_read == {"node": 1, "edge": 1}
    assert records[3]["sourceUrn"] == "urn:0" and records[3]["targetUrn"] == "urn:1"
    assert await stream.first_records(_Snap([], []), 3) == []
