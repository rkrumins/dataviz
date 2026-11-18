"""``POST /{ws_id}/graph/view-members`` — a page of one layer of a view made from a query.

Its members come from the member table, at the epoch readers see, in name order: a keyset
page at a time, with exactly how many the layer holds, the nodes the canvas draws and where
each sits (root first). Its cursor is signed; a share link reads its own view only; a view
whose members are not worked out yet holds none.
"""
from __future__ import annotations

import json
import time

import pytest
from fastapi import Request
from httpx import AsyncClient

from backend.app.api.v1.endpoints import graph_view_members as feed
from backend.app.db.models import ViewORM
from backend.app.db.repositories import view_members_repo, view_membership_repo
from backend.app.services.feature_flags import feature_flags
from backend.common.models.graph import GraphNode

LAYERS = [{"id": "L1", "name": "One", "order": 0, "entityTypes": []},
          {"id": "L2", "name": "Two", "order": 1, "entityTypes": []}]
MEMBERSHIP = {"v": 1, "mode": "live", "sources": [{"spec": {"seeds": {"urns": ["urn:seed"]}}}]}
#: Members in L1, by name: "beta", "Alpha", "gamma", "alpha" (one name twice, told apart by URN).
NAMES = {"urn:1": "beta", "urn:2": "Alpha", "urn:3": "gamma", "urn:4": "alpha"}


def _flags(**values):
    feature_flags._cache = {**(feature_flags._cache or {}), **values}
    feature_flags._cache_ts = time.monotonic()


class MembersEngine:
    """The graph a page's nodes, paths and container names are read from."""

    def __init__(self, *, chains=True):
        self.chains = chains
        self.calls = []

    async def get_nodes_query(self, query):
        self.calls.append(("nodes", list(query.urns)))
        names = {**NAMES, "urn:db": "db"}
        return [GraphNode(urn=u, displayName=names[u], entityType="database" if u == "urn:db" else "table")
                for u in query.urns if u in names]

    async def get_ancestor_chains(self, urns):
        self.calls.append(("chains", list(urns)))
        if not self.chains:
            raise NotImplementedError("no containment walk on this reader")
        return {u: ["urn:db"] for u in urns}


@pytest.fixture()
def on():
    _flags(viewMembershipEnabled=True)
    yield
    _flags(viewMembershipEnabled=False)


@pytest.fixture()
def views(db_session, test_client):
    async def make(*, answered=True):
        resp = await test_client.post("/api/v1/admin/workspaces", json={"name": "Members WS", "dataSources": []})
        ws = resp.json()["id"]
        config = {"layout": {"type": "reference", "referenceLayout": {"layers": LAYERS, "assignments": {}}},
                  "content": {"entityScope": "curated"}, "membership": MEMBERSHIP}
        view = ViewORM(name="Members", workspace_id=ws, view_type="reference", config=json.dumps(config),
                       visibility="workspace")
        plain = ViewORM(name="Plain", workspace_id=ws, view_type="reference",
                        config=json.dumps({"layout": {"referenceLayout": {"layers": LAYERS}}}), visibility="workspace")
        db_session.add_all([view, plain])
        await db_session.flush()
        state = await view_membership_repo.ensure(db_session, view)
        rows = [{"view_id": view.id, "epoch": 2, "urn": u, "layer_id": "L1", "name": n,
                 "sort_key": view_members_repo.sort_key(n, u), "ord": i, "label": "table", "label_ord": i,
                 "whole": False, "covered": False} for i, (u, n) in enumerate(NAMES.items())]
        rows.append({**rows[0], "urn": "urn:9", "layer_id": "L2", "name": "other", "sort_key": "other",
                     "ord": 9, "label_ord": 9})
        # The last answer, since replaced: never read.
        rows.append({**rows[0], "epoch": 1, "urn": "urn:old", "sort_key": "aaa", "ord": 0, "label_ord": 0})
        await view_members_repo.insert(db_session, rows)
        if answered:
            state.epoch = state.members_epoch = 2
        await db_session.commit()
        return ws, view, plain
    return make


@pytest.fixture()
def post(test_client: AsyncClient, db_session):
    from backend.app.api.v1.endpoints.graph import get_context_engine
    from backend.app.main import app

    async def _post(ws, view_id, body, engine=None):
        engine = engine or MembersEngine()
        engine._db_session = db_session

        async def _override():
            return engine

        app.dependency_overrides[get_context_engine] = _override
        try:
            return await test_client.post(f"/api/v1/{ws}/graph/view-members?viewId={view_id}", json=body)
        finally:
            app.dependency_overrides.pop(get_context_engine, None)

    return _post


async def test_a_layer_pages_its_members_in_name_order_with_an_exact_count(on, views, post):
    ws, view, _ = await views()
    first = await post(ws, view.id, {"layerId": "L1", "limit": 3})
    assert first.status_code == 200, first.text
    page = first.json()
    assert [n["urn"] for n in page["nodes"]] == ["urn:2", "urn:4", "urn:1"], "alpha, alpha, beta: by name, then URN"
    assert (page["totalCount"], page["countStatus"], page["status"], page["delivered"]) == (4, "exact", "complete", 3)
    assert (page["sessionId"], page["stale"], page["asOf"], page["capped"]) == (None, False, None, False)
    assert page["nodes"][0]["ancestorPath"] == [{"urn": "urn:db", "displayName": "db", "entityType": "database"}]
    assert page["cursor"]

    rest = (await post(ws, view.id, {"layerId": "L1", "limit": 3, "cursor": page["cursor"]})).json()
    assert [n["urn"] for n in rest["nodes"]] == ["urn:3"]
    assert (rest["cursor"], rest["delivered"], rest["totalCount"]) == (None, 4, 4)
    other = (await post(ws, view.id, {"layerId": "L2"})).json()
    assert [n["urn"] for n in other["nodes"]] == ["urn:9"] and other["totalCount"] == 1


async def test_one_page_is_one_read_of_the_table_and_three_graph_statements(on, views, post):
    ws, view, _ = await views()
    engine = MembersEngine()
    await post(ws, view.id, {"layerId": "L1"}, engine)
    assert [kind for kind, _ in engine.calls] == ["nodes", "chains", "nodes"]


async def test_a_cursor_is_signed(on, views, post):
    ws, view, _ = await views()
    cursor = (await post(ws, view.id, {"layerId": "L1", "limit": 1})).json()["cursor"]
    payload, _, tag = cursor.partition(".")
    import base64

    forged = json.loads(base64.urlsafe_b64decode(payload + "=" * (-len(payload) % 4)))
    forged["d"] = 0
    raw = base64.urlsafe_b64encode(json.dumps(forged).encode()).decode().rstrip("=")
    resp = await post(ws, view.id, {"layerId": "L1", "cursor": f"{raw}.{tag}"})
    assert resp.status_code == 400 and resp.json()["detail"]["reason"] == "bad_cursor"
    other_layer = await post(ws, view.id, {"layerId": "L2", "cursor": cursor})
    assert other_layer.status_code == 400, "a cursor is good for its own layer only"


async def test_a_layer_lists_at_most_its_cap(on, views, post, monkeypatch):
    monkeypatch.setattr(feed, "VIEW_MEMBERS_FEED_MAX_ROWS", 2)
    ws, view, _ = await views()
    page = (await post(ws, view.id, {"layerId": "L1"})).json()
    assert (len(page["nodes"]), page["capped"], page["cursor"], page["totalCount"]) == (2, True, None, 4)


async def test_a_share_link_reads_its_own_view_only(on, views, post):
    from backend.app.api.v1.endpoints.graph import _view_reader
    from backend.app.main import app

    ws, view, _ = await views()

    def link_to_another_view(request: Request):
        request.state.view_capability = "view-somewhere-else"

        async def can_read(_view):
            return True
        return can_read

    app.dependency_overrides[_view_reader] = link_to_another_view
    try:
        resp = await post(ws, view.id, {"layerId": "L1"})
    finally:
        app.dependency_overrides.pop(_view_reader, None)
    assert resp.status_code == 403 and resp.json()["detail"]["reason"] == "link_other_view"


async def test_a_view_not_worked_out_yet_holds_no_members(on, views, post):
    ws, view, _ = await views(answered=False)
    page = (await post(ws, view.id, {"layerId": "L1"})).json()
    assert (page["nodes"], page["totalCount"], page["status"], page["cursor"]) == ([], 0, "complete", None)


async def test_a_reader_with_no_containment_walk_ships_nodes_without_their_path(on, views, post):
    ws, view, _ = await views()
    page = (await post(ws, view.id, {"layerId": "L1"}, MembersEngine(chains=False))).json()
    assert len(page["nodes"]) == 4 and all("ancestorPath" not in n for n in page["nodes"])


async def test_with_the_preview_off_a_view_keeps_the_members_it_last_had(views, post):
    """The switch stops list views being made and updated; one already made still
    shows its members, which only this feed can read."""
    _flags(viewMembershipEnabled=False)
    ws, view, _ = await views()
    page = await post(ws, view.id, {"layerId": "L1"})
    assert page.status_code == 200, page.text
    assert page.json()["totalCount"] == 4


async def test_refusals(views, post):
    ws, view, plain = await views()
    _flags(viewMembershipEnabled=True)
    try:
        not_one = await post(ws, plain.id, {"layerId": "L1"})
        assert not_one.status_code == 404 and not_one.json()["detail"]["reason"] == "not_made_from_a_query"
        assert (await post(ws, "view-nowhere", {"layerId": "L1"})).status_code == 404
        assert (await post(ws, view.id, {"layerId": "L1", "limit": 501})).status_code == 422
    finally:
        _flags(viewMembershipEnabled=False)
