"""The starter template: a few real rows from the graph, never the whole graph.

``build_template`` serves a download from the web tier. It used to materialize the graph's whole
state — every payload decoded, on the event loop — to show five rows; it reads one page of each
kind from published main now, and falls back to worked examples for an empty graph.
"""
from __future__ import annotations

import csv
import io

from backend.app.services.versioning.import_export import service as service_module
from backend.app.services.versioning.import_export.service import ImportExportService
from backend.tests.test_export_native_lines import _Snap, edge, node


def _service():
    return ImportExportService(versioning=object(), store=object())     # nothing materializes


def _rows(blob: bytes):
    return list(csv.DictReader(io.StringIO(blob.decode("utf-8"))))


async def test_the_template_reads_one_page_of_each_kind(monkeypatch):
    nodes = [node(f"n{i:02}", {"urn": f"urn:{i}", "entityType": "Table", "displayName": f"t{i}",
                               "properties": {"owner": "team"}}) for i in range(40)]
    edges = [edge(f"e{i:02}", f"n{i:02}", f"n{i + 1:02}") for i in range(39)]
    opened = []

    async def open_snapshot(**kwargs):
        opened.append(kwargs)
        snap.page_size = kwargs["page_size"]
        return snap

    snap = _Snap(nodes, edges)
    monkeypatch.setattr(service_module, "open_snapshot", open_snapshot)
    rows = _rows(await _service().build_template(graph_id="g1", export_format="csv", limit=5))

    assert opened == [{"graph_id": "g1", "page_size": 5}], "published main, a page of five"
    assert [r["kind"] for r in rows] == ["node"] * 5 + ["edge"] * 5
    assert rows[0]["prop.owner"] == "team" and rows[5]["sourceUrn"] == "urn:0"
    assert snap.pages_read == {"node": 1, "edge": 1}


async def test_an_empty_graphs_template_holds_worked_examples(monkeypatch):
    async def open_snapshot(**_kwargs):
        return _Snap([], [])

    monkeypatch.setattr(service_module, "open_snapshot", open_snapshot)
    rows = _rows(await _service().build_template(graph_id="g1", export_format="csv"))
    assert [r["kind"] for r in rows] == ["node", "node", "edge"]
    assert rows[0]["displayName"] == "Example table"
