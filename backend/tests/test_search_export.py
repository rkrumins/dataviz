"""Exporting every match of a search — exactly, to a file.

An export reads a search's units as its count does and writes each unit's
matches to a part; the session commits which parts are done, and the
download is the header and the committed parts. Here, against a scripted
graph and an in-memory object store: every match is written once across as
many requests as it takes, values keep their exact form (a 64-bit integer
its digits), a property kept raw is read from ``propertiesRaw``, a walk is
written a page at a time, and an export is served only to its own scope,
through a signed, personal, expiring link.
``tests/integration/test_search_export_live.py`` runs it on FalkorDB.
"""
from __future__ import annotations

import asyncio
import csv
import dataclasses
import io
import json
from types import SimpleNamespace

import pytest
from fastapi import HTTPException
from starlette.requests import Request

from backend.app.api.v1.endpoints import graph as graph_mod
from backend.app.providers.falkordb_search import engine as engine_mod
from backend.app.providers.falkordb_search import export as export_mod
from backend.app.providers.falkordb_search.export import (
    Manifest,
    encode_rows,
    execute_export_session,
    header,
    open_export,
)
from backend.app.providers.falkordb_search.plan import Plan, Unit
from backend.app.providers.falkordb_search.session import MemorySessionStore
from backend.app.services.advanced_search_service import AdvancedSearchService
from backend.app.services.deep_search import SearchRunContext
from backend.app.services.search_downloads import mint_download_token, read_download_token
from backend.app.services.view_scope import EffectiveViewScope
from backend.common.models.search import (
    SearchExportRequest,
    SearchOptions,
    SearchQuery,
    SearchScope,
    export_columns,
)

BIG = 2 ** 63 - 1


# ---------------------------------------------------------------------------
# Rows
# ---------------------------------------------------------------------------

class TestRows:
    def test_csv_writes_each_value_exactly(self):
        cols = ["urn", "n", "f", "ok", "tags", "nested", "missing", "text"]
        body = encode_rows([{"urn": "u1", "n": BIG, "f": 0.1, "ok": True, "tags": ["pii", "gold"],
                             "nested": {"a": 1}, "missing": None, "text": 'say "hi", then go'}],
                           "csv", cols)
        row = next(csv.reader(io.StringIO(body.decode())))
        assert row == ["u1", str(BIG), "0.1", "true", '["pii","gold"]', '{"a":1}', "",
                       'say "hi", then go']

    def test_ndjson_keeps_every_value_as_it_is(self):
        body = encode_rows([{"urn": "u1", "n": -BIG - 1, "l": [1, "a"], "x": None}],
                           "ndjson", ["urn", "n", "l", "x"])
        assert body.decode() == f'{{"urn": "u1", "n": {-BIG - 1}, "l": [1, "a"], "x": null}}\n'

    def test_only_csv_has_a_header(self):
        assert header("csv", ["urn", "owner"]) == b"urn,owner\r\n"
        assert header("ndjson", ["urn", "owner"]) == b""

    def test_a_property_kept_raw_is_read_from_there(self):
        row = [7, json.dumps({"legacy": "yes", "owner": "raw"}), "u1", "U", "Dataset", "q",
               "native", None, json.dumps(["pii"])]
        record = export_mod._record(row, ["urn", "displayName", "entityType", "qualifiedName",
                                          "owner", "legacy", "tags"])
        assert record["owner"] == "native"          # a native value wins
        assert record["legacy"] == "yes"            # a raw one fills in
        assert record["tags"] == ["pii"]            # tags are the list they are

    def test_the_base_columns_come_first_and_nothing_twice(self):
        assert export_columns(["owner", "urn", "owner"]) == [
            "urn", "displayName", "entityType", "qualifiedName", "owner"]

    def test_the_manifest_round_trips(self):
        m = Manifest("csv", ["urn"], "f", [["f/a.part", 3]])
        again = Manifest.from_json(m.to_json())
        assert (again.fmt, again.columns, again.folder, again.parts) == ("csv", ["urn"], "f",
                                                                         [["f/a.part", 3]])


# ---------------------------------------------------------------------------
# Sessions, against a scripted graph
# ---------------------------------------------------------------------------

class _Result:
    def __init__(self, rows):
        self.result_set = rows


class _Objects:
    """An in-memory object store."""

    def __init__(self):
        self.blobs = {}
        self.swept = []

    async def put_stream(self, key, chunks):
        data = b""
        async for chunk in chunks:
            data += chunk
        self.blobs[key] = data
        return SimpleNamespace(key=key, size=len(data), exists=True)

    async def open_stream(self, key, *, chunk_size=1 << 20):
        yield self.blobs[key]

    async def delete_prefix(self, prefix):
        self.swept.append(prefix)


COLUMNS = ["urn", "displayName", "entityType", "qualifiedName", "owner", "size"]


class _Graph:
    """``{label: [node, …]}``, a node's position its ID. Answers the raw
    check and the export's unit statements (the predicate is ``all``)."""

    def __init__(self, nodes):
        self.nodes = nodes
        self.statements = []

    async def run(self, cypher, params, timeout_s):
        self.statements.append(cypher)
        if "UNWIND labels(n) AS _l" in cypher:
            return _Result([])
        label = cypher.split("MATCH (n:`", 1)[1].split("`", 1)[0]
        lo, hi = params.get("_lo"), params.get("_hi")
        rows = [[i, n.get("propertiesRaw", "{}"), n["urn"], n["urn"].upper(), label, None,
                 n.get("owner"), n.get("size")]
                for i, n in enumerate(self.nodes[label])
                if (lo is None or i >= lo) and (hi is None or i < hi)]
        if "$_after" in cypher:
            rows = [r for r in rows if r[0] > params["_after"]][:params["_page"]]
        return _Result(rows)


class _Provider:
    _redis = None
    _cache_ns = None

    def __init__(self, graph):
        self.graph = graph

    async def _ro_query(self, cypher, params=None, timeout=None):
        return await self.graph.run(cypher, params or {}, timeout)

    def _get_containment_edge_types(self):
        return ["CONTAINS"]

    def _get_lineage_edge_types(self):
        return []


@pytest.fixture(autouse=True)
def memory_store(monkeypatch):
    from backend.app.providers.falkordb_search import session as session_mod
    store = MemorySessionStore()
    monkeypatch.setattr(session_mod, "_MEMORY", store)
    return store


def _plan(units):
    async def plan(provider, query, compiler, **kw):
        return Plan(list(units))
    return plan


NODES = {
    "Dataset": [{"urn": f"d{i}", "owner": ["ann", "bob"][i % 2], "size": BIG - i}
                for i in range(6)],
    "Column": [{"urn": f"c{i}", "propertiesRaw": json.dumps({"owner": "raw"}) if i < 2 else "{}"}
               for i in range(4)],
}
UNITS = [Unit("range", "Dataset", 0, 3, size=3), Unit("range", "Dataset", 3, None, size=3),
         Unit("range", "Column", size=4)]


def _query():
    return SearchQuery.model_validate({"predicate": {"kind": "all"},
                                       "scope": {"viewId": "v"}, "options": {"results": "hits"}})


async def _follow(provider, objects, *, fmt="csv", scope_hash="h", data_version="1"):
    out, sid, requests = None, None, 0
    context = SearchRunContext(data_version=data_version, scope_hash=scope_hash)
    while True:
        out = await execute_export_session(provider, _query(), context=context, fmt=fmt,
                                           columns=["owner", "size"], wait_ms=0,
                                           session_id=sid, objects=objects)
        sid, requests = out["sessionId"], requests + 1
        if out["status"] == "complete":
            return out, requests
        assert requests < 20


async def _download(provider, objects, sid, scope_hash="h"):
    opened = await open_export(provider, sid, scope_hash=scope_hash, objects=objects)
    assert opened is not None
    answer, body = opened
    return answer, b"".join([chunk async for chunk in body]).decode()


class TestSessions:
    async def test_every_match_is_written_once_across_requests(self, monkeypatch):
        monkeypatch.setattr(export_mod, "make_plan", _plan(UNITS))
        objects, provider = _Objects(), _Provider(_Graph(NODES))
        out, requests = await _follow(provider, objects)
        assert requests > 1 and out["rows"] == 10 and out["columns"] == COLUMNS
        answer, text = await _download(provider, objects, out["sessionId"])
        rows = list(csv.DictReader(io.StringIO(text)))
        assert sorted(r["urn"] for r in rows) == sorted(n["urn"] for ns in NODES.values()
                                                        for n in ns)
        by_urn = {r["urn"]: r for r in rows}
        assert by_urn["d0"]["size"] == str(BIG) and by_urn["d1"]["owner"] == "bob"
        assert by_urn["c0"]["owner"] == "raw" and by_urn["c3"]["owner"] == ""
        assert answer.get("filename", "").endswith(".csv")

    async def test_ndjson_is_one_object_a_line(self, monkeypatch):
        monkeypatch.setattr(export_mod, "make_plan", _plan(UNITS))
        objects, provider = _Objects(), _Provider(_Graph(NODES))
        out, _ = await _follow(provider, objects, fmt="ndjson")
        _, text = await _download(provider, objects, out["sessionId"])
        lines = [json.loads(line) for line in text.splitlines()]
        assert len(lines) == 10 and list(lines[0]) == COLUMNS
        assert {line["urn"]: line["size"] for line in lines}["d5"] == BIG - 5

    async def test_a_unit_read_again_never_writes_over_a_committed_part(self, monkeypatch):
        """A writer whose lease was taken over may still be writing: its
        reading of the unit goes to a part of its own, which no commit names."""
        monkeypatch.setattr(export_mod, "make_plan", _plan(UNITS))
        objects, provider = _Objects(), _Provider(_Graph(NODES))
        out, _ = await _follow(provider, objects)
        _, before = await _download(provider, objects, out["sessionId"])
        written = dict(objects.blobs)
        work = export_mod._ExportWork(
            SimpleNamespace(clamps=[], count=0), export_mod.Context(
                where="true", params={}, sort=None, containment=("CONTAINS",), max_depth=12),
            provider.graph.run, objects,
            Manifest("csv", COLUMNS, next(iter(written)).rsplit("/", 1)[0]))
        rows, key = await work.unit(UNITS[0], 1.0)
        assert rows == 3 and key not in written
        assert all(objects.blobs[k] == v for k, v in written.items())
        _, after = await _download(provider, objects, out["sessionId"])
        assert after == before

    async def test_a_unit_slower_than_the_wait_is_written_once(self, monkeypatch):
        """The dialog follows an export with 2 s waits. A unit that takes
        longer finishes in the request that started it — given up at the
        wait, every request would start it again and none would finish."""
        monkeypatch.setattr(export_mod, "make_plan", _plan(UNITS))
        monkeypatch.setattr(engine_mod, "_GRACE_S", 0.05)
        graph = _Graph(NODES)
        read = graph.run

        async def slow(cypher, params, timeout_s):
            if "RETURN ID(n)" in cypher:
                await asyncio.sleep(0.2)
            return await read(cypher, params, timeout_s)

        graph.run = slow
        objects, provider = _Objects(), _Provider(graph)
        out, _ = await _follow(provider, objects)
        assert out["rows"] == 10
        assert len(objects.blobs) == len(UNITS), "each unit written once"

    async def test_a_unit_has_two_statements_budget(self, monkeypatch):
        """A unit reads, encodes and writes — a walk a page at a time — so it
        gets two statements' budget. A walk under one root can't be split:
        with one statement's, this one would fail the export."""
        from backend.app.services.deep_search import get_deep_search_settings
        settings = dataclasses.replace(get_deep_search_settings(), chunk_timeout_ms=200)
        monkeypatch.setattr(export_mod, "get_deep_search_settings", lambda: settings)
        monkeypatch.setattr(export_mod, "make_plan",
                            _plan([Unit("walk", None, roots=[1], size=6)]))
        graph = _Graph(NODES)

        async def run(cypher, params, timeout_s):
            if "$_after" in cypher:
                await asyncio.sleep(0.3)
            return await _Graph.run(graph, cypher.replace("MATCH (_w)", "MATCH (n:`Dataset`)"),
                                    params, timeout_s)

        graph.run = run
        out, _ = await _follow(_Provider(graph), _Objects())
        assert out["rows"] == 6

    async def test_a_walk_is_written_a_page_at_a_time(self, monkeypatch):
        monkeypatch.setattr(export_mod, "make_plan",
                            _plan([Unit("walk", None, roots=[1], size=6)]))
        monkeypatch.setattr(export_mod, "_WALK_PAGE", 2)
        graph = _Graph(NODES)

        async def run(cypher, params, timeout_s):
            # The walk's statement names no label: read it as Dataset's.
            return await _Graph.run(graph, cypher.replace("MATCH (_w)", "MATCH (n:`Dataset`)"),
                                    params, timeout_s)

        graph.run = run
        objects, provider = _Objects(), _Provider(graph)
        out, _ = await _follow(provider, objects)
        assert out["rows"] == 6
        assert sum("$_after" in c for c in graph.statements) == 4   # 2 + 2 + 2 + 0

    async def test_an_export_of_another_scope_is_never_served(self, monkeypatch):
        monkeypatch.setattr(export_mod, "make_plan", _plan(UNITS))
        objects, provider = _Objects(), _Provider(_Graph(NODES))
        out, _ = await _follow(provider, objects)
        assert await open_export(provider, out["sessionId"], scope_hash="other",
                                 objects=objects) is None
        assert await open_export(provider, "no-such-session", scope_hash="h",
                                 objects=objects) is None

    async def test_starting_an_export_sweeps_old_ones(self, monkeypatch):
        monkeypatch.setattr(export_mod, "make_plan", _plan(UNITS))
        objects = _Objects()
        await _follow(_Provider(_Graph(NODES)), objects)
        assert objects.swept and all(p.startswith("search-exports/") for p in objects.swept)


# ---------------------------------------------------------------------------
# The download link
# ---------------------------------------------------------------------------

class TestDownloadToken:
    def test_it_vouches_for_one_export_one_scope_and_one_person(self):
        token = mint_download_token("s1", "h1", "usr_a", "key", now=1000)
        assert read_download_token(token, "usr_a", ["key"], now=1001) == ("s1", "h1")
        assert read_download_token(token, "usr_b", ["key"], now=1001) is None

    def test_it_expires(self):
        token = mint_download_token("s1", "h1", "usr_a", "key", now=1000, ttl_s=60)
        assert read_download_token(token, "usr_a", ["key"], now=1061) is None

    def test_a_tampered_or_foreign_token_is_refused(self):
        token = mint_download_token("s1", "h1", "usr_a", "key", now=1000)
        forged = mint_download_token("s2", "h1", "usr_a", "not-the-key", now=1000)
        assert read_download_token(forged, "usr_a", ["key"], now=1001) is None
        tampered = token[:-1] + ("1" if token.endswith("0") else "0")
        assert read_download_token(tampered, "usr_a", ["key"], now=1001) is None
        assert read_download_token("garbage", "usr_a", ["key"], now=1001) is None

    def test_a_rotated_key_still_verifies(self):
        token = mint_download_token("s1", "h1", "usr_a", "old", now=1000)
        assert read_download_token(token, "usr_a", ["new", "old"], now=1001) == ("s1", "h1")


# ---------------------------------------------------------------------------
# Service and route
# ---------------------------------------------------------------------------

def _eff(roots=()) -> EffectiveViewScope:
    return EffectiveViewScope(
        view_id="v", workspace_id="ws", data_source_id=None, canvas_kind="graph",
        root_urns=tuple(roots), entity_type_allow_list=frozenset({"dataset"}),
        layer_allow_list=frozenset(), max_depth=12, scope_hash="scope-1")


def _service(provider, eff=None) -> AdvancedSearchService:
    svc = AdvancedSearchService(SimpleNamespace(provider=provider), session=None,
                                workspace_id="ws")

    async def resolve(requested):
        return eff or _eff()

    async def guard(scope):
        return None

    svc._resolve_scope = resolve
    svc._guard_view_data_source = guard
    return svc


class _Exporter:
    def __init__(self, status="complete"):
        self.status = status
        self.seen = {}

    async def deep_search_export(self, query, *, context, fmt, columns, wait_ms,
                                 session_id=None):
        self.seen.update(types=query.scope.entity_types, scope_hash=context.scope_hash,
                         fmt=fmt, columns=columns, wait=wait_ms, sid=session_id)
        return {"sessionId": "s1", "status": self.status, "rows": 3, "format": fmt,
                "columns": export_columns(columns), "filename": "search-export-x.csv"}


class TestService:
    async def test_the_export_reads_the_resolved_scope_and_its_link_is_the_callers(self):
        exporter = _Exporter()
        request = SearchExportRequest.model_validate({
            "scope": {"viewId": "v"}, "predicate": {"kind": "all"}, "format": "ndjson",
            "columns": ["owner"], "waitMs": 400, "sessionId": "prev"})
        out = await _service(exporter).export(request, principal="usr_a")
        assert exporter.seen == {"types": ["dataset"], "scope_hash": "scope-1", "fmt": "ndjson",
                                 "columns": ["owner"], "wait": 400, "sid": "prev"}
        from backend.auth_service.core import config as auth_config
        assert read_download_token(out.download_token, "usr_a",
                                   [auth_config.JWT_SECRET_KEY]) == ("s1", "scope-1")

    async def test_a_running_export_has_no_link_yet(self):
        request = SearchExportRequest.model_validate({
            "scope": {"viewId": "v"}, "predicate": {"kind": "all"}})
        out = await _service(_Exporter(status="running")).export(request, principal="usr_a")
        assert out.status == "running" and out.download_token is None

    async def test_roots_all_outside_the_view_export_nothing(self):
        request = SearchExportRequest.model_validate({
            "scope": {"viewId": "v", "rootUrns": ["urn:elsewhere"]},
            "predicate": {"kind": "all"}})
        out = await _service(SimpleNamespace(), _eff(roots=())).export(request)
        assert out.status == "complete" and out.rows == 0

    async def test_a_predicate_is_checked_as_a_searchs_is(self):
        from backend.app.services.advanced_search_service import ValidationError
        request = SearchExportRequest.model_validate({
            "scope": {"viewId": "v"},
            "predicate": {"kind": "property", "key": "size", "op": "gt", "value": "abc",
                          "valueType": "number"}})
        with pytest.raises(ValidationError):
            await _service(_Exporter()).export(request)


def _request(view_capability=None) -> Request:
    state = {} if view_capability is None else {"view_capability": view_capability}
    return Request({"type": "http", "headers": [], "state": state})


class TestRoute:
    async def test_a_share_link_stays_inside_its_view(self):
        body = SearchExportRequest.model_validate({
            "scope": {"viewId": "view-1", "scopeMode": "data_source"},
            "predicate": {"kind": "all"}})
        with pytest.raises(HTTPException) as exc:
            await graph_mod.search_export(body=body, request=_request("view-1"), ws_id="ws",
                                          engine=SimpleNamespace(provider=None), session=None)
        assert exc.value.status_code == 403

    async def test_a_download_needs_a_link_for_this_person_and_export(self):
        from backend.auth_service.core import config as auth_config
        token = mint_download_token("s1", "scope-1", "usr_a", auth_config.JWT_SECRET_KEY)
        for sid, user in (("s1", SimpleNamespace(id="usr_b")),
                          ("s2", SimpleNamespace(id="usr_a"))):
            with pytest.raises(HTTPException) as exc:
                await graph_mod.search_export_download(
                    session_id=sid, token=token, ws_id="ws", engine=SimpleNamespace(provider=None),
                    session=None, user=user)
            assert exc.value.status_code == 403
