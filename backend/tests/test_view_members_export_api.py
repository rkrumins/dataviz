"""One layer of a view made from a query, as a file: ``POST /{ws_id}/graph/view-members/export``
then ``GET /{ws_id}/graph/view-members/download``.

The export answers with how many rows the layer holds, the answer they are read at and a
token for them (this layer, that answer, this caller, ten minutes); the download streams
them in name order, a keyset page a read, each with its parent and path from the graph,
CSV cells defused. A file asked for after the view's members were worked out again is
still the answer the token names while it is kept, else 410.
"""
from __future__ import annotations

import base64
import csv
import io
import json
import time
from contextlib import asynccontextmanager

import pytest
from fastapi import Request
from httpx import AsyncClient
from sqlalchemy import delete, update

from backend.app.api.v1.endpoints import graph_member_sets
from backend.app.api.v1.endpoints import graph_view_members_export as route
from backend.app.db.models import ViewMemberORM, ViewMembershipStateORM
from backend.app.db.repositories import view_members_repo
from backend.app.services.search_downloads import MEMBER_SET, VIEW_MEMBERS, mint_download_token
from backend.tests.test_view_members_feed_api import _flags, MembersEngine, views  # noqa: F401 — fixtures
from backend.tests.test_views_from_members_api import following, graph, source_view, workspace  # noqa: F401

COLUMNS = ["urn", "name", "type", "layer", "via", "hops", "whole",
           "parentUrn", "parentName", "parentType", "path", "pathUrns"]


@pytest.fixture()
def on():
    _flags(viewMembershipEnabled=True, graphExportEnabled=True)
    yield
    _flags(viewMembershipEnabled=False)


@pytest.fixture()
def client(test_client: AsyncClient, db_session, monkeypatch):
    """The test client, its graph read through ``client.engine`` and the member table read
    a page per session (``client.pages`` counts them)."""
    from backend.app.api.v1.endpoints.graph import get_context_engine
    from backend.app.db.engine import get_graph_read_db_session
    from backend.app.main import app

    engine = MembersEngine()
    engine._db_session = db_session
    pages = []

    async def engine_dep():
        return engine

    async def engine_call(**_):
        return engine

    async def read_session():
        yield db_session

    @asynccontextmanager
    async def rows_session():
        pages.append(1)
        yield db_session

    app.dependency_overrides[get_context_engine] = engine_dep
    app.dependency_overrides[get_graph_read_db_session] = read_session
    app.dependency_overrides[graph_member_sets.row_sessions] = lambda: rows_session
    monkeypatch.setattr(route, "get_context_engine", engine_call)
    test_client.engine, test_client.pages = engine, pages
    yield test_client
    for dep in (get_context_engine, get_graph_read_db_session, graph_member_sets.row_sessions):
        app.dependency_overrides.pop(dep, None)


async def export(client, ws, view_id, layer="L1"):
    return await client.post(f"/api/v1/{ws}/graph/view-members/export",
                             params={"viewId": view_id, "layerId": layer})


async def download(client, ws, token, fmt="csv"):
    return await client.get(f"/api/v1/{ws}/graph/view-members/download", params={"token": token, "format": fmt})


def table(text: str) -> list:
    return list(csv.reader(io.StringIO(text)))


async def test_a_layer_streams_in_name_order_with_where_each_sits(on, views, client):
    ws, view, _ = await views()
    ready = await export(client, ws, view.id)
    assert ready.status_code == 200, ready.text
    answer = ready.json()
    assert (answer["rows"], answer["epoch"]) == (4, 2) and answer["downloadToken"]

    got = await download(client, ws, answer["downloadToken"])
    assert got.status_code == 200, got.text
    assert got.headers["content-type"].startswith("text/csv")
    assert "attachment" in got.headers["content-disposition"]
    rows = table(got.text)
    assert rows[0] == COLUMNS
    assert [r[0] for r in rows[1:]] == ["urn:2", "urn:4", "urn:1", "urn:3"], "name order, then URN"
    first = dict(zip(COLUMNS, rows[1]))
    assert first == {"urn": "urn:2", "name": "Alpha", "type": "table", "layer": "One", "via": "", "hops": "",
                     "whole": "false", "parentUrn": "urn:db", "parentName": "db", "parentType": "database",
                     "path": "db", "pathUrns": "urn:db"}

    lines = [json.loads(line) for line in (await download(client, ws, answer["downloadToken"], "ndjson")).text.splitlines()]
    assert [list(line) for line in lines] == [COLUMNS] * 4
    assert lines[0]["path"] == ["db"] and lines[0]["pathUrns"] == ["urn:db"] and lines[0]["whole"] is False


async def test_a_page_is_one_short_read_and_cells_never_run_as_formulas(on, views, client, db_session, monkeypatch):
    monkeypatch.setattr(route, "PAGE", 3)
    ws, view, _ = await views()
    await db_session.execute(update(ViewMemberORM).where(ViewMemberORM.urn == "urn:3")
                             .values(name="=HYPERLINK(\"http://x\")"))
    await db_session.commit()
    token = (await export(client, ws, view.id)).json()["downloadToken"]
    rows = table((await download(client, ws, token)).text)
    assert len(rows) == 5 and len(client.pages) == 2, "two pages of three: a session each"
    assert {r[1] for r in rows[1:]} >= {"'=HYPERLINK(\"http://x\")"}


async def test_a_token_is_for_its_caller_its_layer_and_ten_minutes(on, views, client):
    from backend.auth_service.core import config as auth_config

    ws, view, _ = await views()
    answer = (await export(client, ws, view.id)).json()
    key = auth_config.JWT_SECRET_KEY
    pinned = json.dumps([2, "L1"])
    payload = answer["downloadToken"].partition(".")[0]
    me = json.loads(base64.urlsafe_b64decode(payload + "=" * (-len(payload) % 4)))["u"]
    for token in (
        mint_download_token(view.id, pinned, "usr_someone_else", key, purpose=VIEW_MEMBERS),
        mint_download_token(view.id, pinned, me, key, purpose=VIEW_MEMBERS, now=time.time() - 601, ttl_s=600),
        mint_download_token(view.id, pinned, me, key, purpose=MEMBER_SET),
        answer["downloadToken"] + "x",
        "nonsense",
    ):
        resp = await download(client, ws, token)
        assert (resp.status_code, resp.json()["detail"]["reason"]) == (403, "link_expired"), resp.text
    assert (await download(client, ws, answer["downloadToken"])).status_code == 200


async def test_the_answer_a_token_names_is_read_while_it_is_kept(on, views, client, db_session):
    ws, view, _ = await views()
    token = (await export(client, ws, view.id)).json()["downloadToken"]
    # The members worked out again: epoch 3 holds one member of its own.
    await view_members_repo.insert(db_session, [{
        "view_id": view.id, "epoch": 3, "urn": "urn:new", "layer_id": "L1", "name": "new",
        "sort_key": view_members_repo.sort_key("new", "urn:new"), "ord": 0, "label": "table", "label_ord": 0,
        "whole": False, "covered": False}])
    await db_session.execute(update(ViewMembershipStateORM).where(ViewMembershipStateORM.view_id == view.id)
                             .values(epoch=3, members_epoch=3))
    await db_session.commit()
    kept = table((await download(client, ws, token)).text)
    assert [r[0] for r in kept[1:]] == ["urn:2", "urn:4", "urn:1", "urn:3"], "the answer the token names"

    await db_session.execute(delete(ViewMemberORM).where(ViewMemberORM.view_id == view.id, ViewMemberORM.epoch == 2))
    await db_session.commit()
    gone = await download(client, ws, token)
    assert (gone.status_code, gone.json()["detail"]["reason"]) == (410, "epoch_gone")
    fresh = (await export(client, ws, view.id)).json()
    assert (fresh["rows"], fresh["epoch"]) == (1, 3)


async def test_refusals(on, views, client):
    from backend.app.api.v1.endpoints.graph import _view_reader
    from backend.app.main import app

    ws, view, plain = await views()
    unknown = await export(client, ws, view.id, layer="L9")
    assert (unknown.status_code, unknown.json()["detail"]["reason"]) == (404, "no_such_layer")
    not_one = await export(client, ws, plain.id)
    assert (not_one.status_code, not_one.json()["detail"]["reason"]) == (404, "not_made_from_a_query")
    token = (await export(client, ws, view.id)).json()["downloadToken"]
    assert (await download(client, ws, token, "xlsx")).status_code == 422

    def link_to_another_view(request: Request):
        request.state.view_capability = "view-somewhere-else"

        async def can_read(_view):
            return True
        return can_read

    app.dependency_overrides[_view_reader] = link_to_another_view
    try:
        other = await export(client, ws, view.id)
    finally:
        app.dependency_overrides.pop(_view_reader, None)
    assert (other.status_code, other.json()["detail"]["reason"]) == (403, "link_other_view")

    _flags(graphExportEnabled=False)
    for resp in (await export(client, ws, view.id), await download(client, ws, token)):
        assert resp.status_code == 403 and resp.json()["detail"]["feature"] == "graphExportEnabled"


def test_the_download_runs_as_long_as_the_file_takes():
    from backend.app.main import _TimeoutMiddleware

    mw = _TimeoutMiddleware(None)
    assert mw._is_sse_path("/api/v1/ws_1/graph/view-members/download")
    assert not mw._is_sse_path("/api/v1/ws_1/graph/view-members/export")
    assert not mw._is_sse_path("/api/v1/ws_1/graph/view-members")


async def test_a_view_that_follows_another_exports_the_layers_it_is_served(on, client, graph):
    ws = await workspace(client)
    src = await source_view(client, ws)
    view_id = await following(client, ws, src)
    ready = (await export(client, ws, view_id, layer="s_tbl")).json()
    assert ready["rows"] == 2
    rows = table((await download(client, ws, ready["downloadToken"])).text)
    assert [(r[0], r[3]) for r in rows[1:]] == [("tbl_a", "Tables"), ("tbl_b", "Tables")], "its layer's name there"

    assert (await client.delete(f"/api/v1/views/{src}")).status_code in (200, 204)
    gone = await export(client, ws, view_id, layer="s_tbl")
    assert (gone.status_code, gone.json()["detail"]["reason"]) == (409, "base_missing")
    rows = table((await download(client, ws, ready["downloadToken"])).text)
    assert [(r[0], r[3]) for r in rows[1:]] == [("tbl_a", "s_tbl"), ("tbl_b", "s_tbl")], "its members are kept"
