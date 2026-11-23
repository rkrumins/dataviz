"""The streamed export's HTTP surface, for a data source without version control (the live export).

Pins: a data source is exported only through its own workspace; the plan counts entities without
the platform's own bookkeeping and says when there is nothing to export; every format downloads
with its name, its type and nothing cached; csv starts with a byte-order mark; exports take turns,
shared by every worker process of a pod (429 with Retry-After when none frees up in time, and a
turn always comes back); an Excel export a sheet can't hold is refused before its first byte. The versioned routes share these helpers; their
reads are proven against Postgres in tests/integration/test_export_stream.py.
"""
from __future__ import annotations

import asyncio
import csv
import io
import json
from types import SimpleNamespace

import openpyxl
import pytest
from httpx import AsyncClient
from sqlalchemy.ext.asyncio import AsyncSession

from backend.app.api.v1.endpoints import graph_export
from backend.app.db.engine import get_graph_read_db_session
from backend.app.db.models import ProviderORM, WorkspaceDataSourceORM, WorkspaceORM
from backend.app.services.versioning.import_export import stream
from backend.common.models.graph import GraphEdge, GraphNode

NODES = [GraphNode(urn=f"urn:t:{i}", entityType="Table", displayName=f"t{i}", qualifiedName=f"db.t{i}",
                   properties={"owner": "data", "aliases": ["a", "b"]} if i == 0 else {"owner": "data"})
         for i in range(3)]
EDGES = [GraphEdge(id="e1", sourceUrn="urn:t:0", targetUrn="urn:t:1", edgeType="LINEAGE"),
         GraphEdge(id="e2", sourceUrn="urn:t:1", targetUrn="urn:t:2", edgeType="LINEAGE")]


#: Where the tables sit: t0 at the top of the graph, t1 in a warehouse, t2 in a schema inside it.
CHAINS = {"urn:t:0": [], "urn:t:1": ["urn:db"], "urn:t:2": ["urn:gold", "urn:db"]}
CONTAINERS = [GraphNode(urn="urn:db", entityType="Database", displayName="Warehouse"),
              GraphNode(urn="urn:gold", entityType="Schema", displayName="gold")]


class _Provider:
    def __init__(self, nodes=NODES, edges=EDGES):
        self.nodes, self.edges = nodes, edges
        self.chain_reads, self.name_reads = [], []

    async def get_ancestor_chains(self, urns):
        self.chain_reads.append(list(urns))
        return {u: CHAINS[u] for u in urns if u in CHAINS}

    async def get_nodes(self, query):
        self.name_reads.append(list(query.urns))
        return [n for n in CONTAINERS if n.urn in query.urns]

    async def scan_nodes(self, page_size=2000):
        for i in range(0, len(self.nodes), 2):
            yield self.nodes[i:i + 2]

    async def scan_edges(self, page_size=2000):
        if self.edges:
            yield self.edges

    async def get_stats(self):
        # Two of the edges the graph holds are the platform's own rollups.
        return {"nodeCount": len(self.nodes), "edgeCount": len(self.edges) + 2,
                "edgeTypeCounts": {"LINEAGE": len(self.edges), "AGGREGATED": 2}}


@pytest.fixture
async def source(test_client, db_session: AsyncSession, monkeypatch, tmp_path):
    """A workspace with a data source (and a second workspace), served by a fake provider."""
    from backend.app.main import app

    db_session.add(ProviderORM(id="prov_x", name="P", provider_type="falkordb"))
    ws, other = WorkspaceORM(name="Home"), WorkspaceORM(name="Elsewhere")
    db_session.add_all([ws, other])
    await db_session.flush()
    ds = WorkspaceDataSourceORM(workspace_id=ws.id, provider_id="prov_x", graph_name="g", label="Finance",
                                is_primary=True, is_active=True)
    db_session.add(ds)
    await db_session.commit()

    async def _session():
        yield db_session

    app.dependency_overrides[get_graph_read_db_session] = _session
    provider = _Provider()

    async def _for_workspace(ws_id, _manager, _session, *, data_source_id, actor, viewer=None):
        return SimpleNamespace(provider=provider)

    monkeypatch.setattr(graph_export.ContextEngine, "for_workspace", staticmethod(_for_workspace))
    monkeypatch.setattr(stream, "slots", stream.Slots(1, str(tmp_path)))
    yield SimpleNamespace(ws=ws.id, other=other.id, ds=ds.id, provider=provider)
    app.dependency_overrides.pop(get_graph_read_db_session, None)


async def test_a_source_is_exported_only_through_its_own_workspace(test_client: AsyncClient, source):
    for route in ("plan", "stream"):
        resp = await test_client.get(f"/api/v1/{source.other}/graph/export/{route}",
                                     params={"dataSourceId": source.ds})
        assert resp.status_code == 404, (route, resp.text)
    resp = await test_client.get(f"/api/v1/{source.ws}/graph/export/plan", params={"dataSourceId": "ds_nope"})
    assert resp.status_code == 404


async def test_the_plan_counts_entities_not_bookkeeping(test_client: AsyncClient, source):
    plan = (await test_client.get(f"/api/v1/{source.ws}/graph/export/plan",
                                  params={"dataSourceId": source.ds, "format": "xlsx"})).json()
    assert plan["nodes"] == 3 and plan["edges"] == 2, "the two rollup edges aren't the source's"
    assert plan["exact"] is False and plan["empty"] is False and plan["formatLimit"] is None

    source.provider.nodes, source.provider.edges = [], []
    plan = (await test_client.get(f"/api/v1/{source.ws}/graph/export/plan",
                                  params={"dataSourceId": source.ds})).json()
    assert plan["empty"] is True


async def test_every_format_downloads_the_whole_graph(test_client: AsyncClient, source):
    got = {}
    for fmt in ("ndjson", "json", "csv", "tsv", "xlsx"):
        resp = await test_client.get(f"/api/v1/{source.ws}/graph/export/stream",
                                     params={"dataSourceId": source.ds, "format": fmt, "filename": "Finance DWH"})
        assert resp.status_code == 200, (fmt, resp.text)
        assert resp.headers["content-disposition"] == f'attachment; filename="Finance-DWH.{fmt}"'
        assert resp.headers["cache-control"] == "no-store"
        assert resp.headers["content-type"].startswith(stream.MEDIA_TYPES[fmt].split(";")[0])
        got[fmt] = resp.content
    rows = [json.loads(line) for line in got["ndjson"].splitlines()]
    assert [r["kind"] for r in rows] == ["node"] * 3 + ["edge"] * 2
    assert rows[0]["prop.aliases"] == ["a", "b"] and rows[0]["entity_id"] == "" and rows[0]["urn"] == "urn:t:0"
    assert rows[3]["sourceUrn"] == "urn:t:0" and rows[3]["targetUrn"] == "urn:t:1"
    assert json.loads(got["json"]) == rows
    assert got["csv"].startswith("﻿kind,".encode()), "a BOM, so Excel reads it as UTF-8"
    assert got["csv"].decode("utf-8-sig").count("\n") == 6 and got["tsv"].decode("utf-8-sig").count("\n") == 6
    book = openpyxl.load_workbook(io.BytesIO(got["xlsx"]), read_only=True)
    assert [sum(1 for _ in book[s].iter_rows()) for s in ("Nodes", "Edges")] == [4, 3]


async def _download(client, source, fmt, **params):
    resp = await client.get(f"/api/v1/{source.ws}/graph/export/stream",
                            params={"dataSourceId": source.ds, "format": fmt, **params})
    assert resp.status_code == 200, (fmt, resp.text)
    return resp.content


async def _imported(fmt, blob):
    """What an import makes of each row of the file."""
    from backend.app.services.versioning.import_export.formats import get_adapter
    from backend.app.services.versioning.import_export.rowmodel import normalize

    async def body():
        yield blob
    return [normalize(r, r["kind"]) async for r in get_adapter(fmt).parse(body())]


async def test_every_format_says_where_each_entity_sits_when_asked(test_client: AsyncClient, source):
    """``withPath``: each node's parent and path, as the trace's file writes them — lists in
    NDJSON and JSON, ``A / B`` and ``a; b`` in a spreadsheet's cells, empty at the top of the
    graph and on every edge. Read on the pass that writes the file only, and an import of the file
    makes exactly what it makes of one without them."""
    rows = [json.loads(line) for line in (await _download(test_client, source, "ndjson", withPath="true")).splitlines()]
    t0, t1, t2 = rows[:3]
    assert (t0["parentUrn"], t0["path"], t0["pathUrns"]) == (None, [], [])
    assert (t1["parentUrn"], t1["parentName"], t1["parentType"]) == ("urn:db", "Warehouse", "Database")
    assert (t2["path"], t2["pathUrns"]) == (["Warehouse", "gold"], ["urn:db", "urn:gold"])
    assert all("path" not in r for r in rows[3:]), "an edge sits nowhere"
    assert source.provider.name_reads == [["urn:db"], ["urn:gold"]], "each named once, when first met"
    assert json.loads(await _download(test_client, source, "json", withPath="true")) == rows

    source.provider.chain_reads.clear()
    text = (await _download(test_client, source, "csv", withPath="true")).decode("utf-8-sig")
    assert len(source.provider.chain_reads) == 2, "the column pass reads no chain: two node pages"
    table = list(csv.DictReader(io.StringIO(text)))
    header = text.splitlines()[0].split(",")
    at = header.index("baseVersion") + 1
    assert header[at:at + 5] == ["parentUrn", "parentName", "parentType", "path", "pathUrns"]
    assert (table[2]["path"], table[2]["pathUrns"]) == ("Warehouse / gold", "urn:db; urn:gold")
    assert table[0]["path"] == "" and table[3]["path"] == ""

    book = openpyxl.load_workbook(io.BytesIO(await _download(test_client, source, "xlsx", withPath="true")),
                                  read_only=True)
    nodes_header = [c.value for c in next(book["Nodes"].iter_rows(max_row=1))]
    edges_header = [c.value for c in next(book["Edges"].iter_rows(max_row=1))]
    assert "path" in nodes_header and "path" not in edges_header, "the Edges sheet stays clean"
    t2_row = [c.value for c in list(book["Nodes"].iter_rows(min_row=4, max_row=4))[0]]
    assert t2_row[nodes_header.index("path")] == "Warehouse / gold"

    for fmt in ("ndjson", "json", "csv", "tsv", "xlsx"):
        placed = await _download(test_client, source, fmt, withPath="true")
        plain = await _download(test_client, source, fmt)
        assert await _imported(fmt, placed) == await _imported(fmt, plain), fmt
        assert b"pathUrns" in placed or fmt == "xlsx"
        assert b"pathUrns" not in plain, "asked for only"


async def test_spreadsheets_add_the_property_columns_asked_for(test_client: AsyncClient, source):
    resp = await test_client.get(f"/api/v1/{source.ws}/graph/export/stream",
                                 params={"dataSourceId": source.ds, "format": "csv", "props": "steward, pii"})
    header = resp.content.decode("utf-8-sig").splitlines()[0].split(",")
    assert "prop.steward" in header and "prop.pii" in header and "prop.owner" in header


async def _turn_comes_back():
    turn = await stream.slots.acquire(0)
    assert turn is not None, "the export gave its turn back"
    stream.slots.release(turn)


async def test_exports_take_turns_and_always_give_them_back(test_client: AsyncClient, source, monkeypatch):
    monkeypatch.setattr(stream, "SLOT_WAIT_S", 0.3)
    held = await stream.slots.acquire(0)                        # someone else's export holds the turn
    busy = await test_client.get(f"/api/v1/{source.ws}/graph/export/stream", params={"dataSourceId": source.ds})
    assert busy.status_code == 429 and busy.headers["retry-after"] == "120"
    assert busy.json()["detail"]["code"] == "EXPORTS_BUSY"

    monkeypatch.setattr(stream, "SLOT_WAIT_S", 10)
    waiting = asyncio.create_task(test_client.get(f"/api/v1/{source.ws}/graph/export/stream",
                                                  params={"dataSourceId": source.ds}))
    await asyncio.sleep(0.3)
    assert not waiting.done(), "it waits for a turn"
    stream.slots.release(held)                                  # a turn frees up: the waiting one goes
    ok = await waiting
    assert ok.status_code == 200 and len(ok.content.splitlines()) == 5
    await _turn_comes_back()


async def test_an_export_job_takes_its_turn_too(source, monkeypatch):
    async def body():
        yield b"rows"

    monkeypatch.setattr(stream, "SLOT_WAIT_S", 0.3)
    held = await stream.slots.acquire(0)
    with pytest.raises(stream.ExportsBusy):
        [c async for c in stream.in_turn(body())]
    stream.slots.release(held)
    assert [c async for c in stream.in_turn(body())] == [b"rows"]
    await _turn_comes_back()


async def test_a_turn_is_shared_by_every_worker_process_of_a_pod(tmp_path):
    first, second = stream.Slots(1, str(tmp_path)), stream.Slots(1, str(tmp_path))   # two workers' own
    turn = await first.acquire(0)
    assert turn is not None and await second.acquire(0.3) is None, "the pod's only turn is taken"
    first.release(turn)
    turn = await second.acquire(0)
    assert turn is not None, "and it frees up for any worker"
    second.release(turn)


async def test_an_excel_export_a_sheet_cannot_hold_is_refused_before_it_starts(
        test_client: AsyncClient, source, monkeypatch):
    monkeypatch.setattr(stream, "EXCEL_MAX_ROWS", 2)
    resp = await test_client.get(f"/api/v1/{source.ws}/graph/export/stream",
                                 params={"dataSourceId": source.ds, "format": "xlsx"})
    assert resp.status_code == 422 and resp.json()["detail"]["code"] == "EXCEL_ROW_LIMIT"
    assert "CSV or NDJSON" in resp.json()["detail"]["message"]
    await _turn_comes_back()
    plan = (await test_client.get(f"/api/v1/{source.ws}/graph/export/plan",
                                  params={"dataSourceId": source.ds, "format": "xlsx"})).json()
    assert plan["formatLimit"] and "3 nodes" in plan["formatLimit"]
