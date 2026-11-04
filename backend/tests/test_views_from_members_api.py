"""``POST /views/from-members`` — a whole view made from a query's members.

The resolver's fake graph answers, with types (``dom`` a domain, ``tbl_*`` tables,
``col_*`` columns):

    dom ⊃ tbl_a ⊃ {col_a1, col_a2};  dom ⊃ tbl_b ⊃ col_b1
    src3 → src2 → src1 → col_a1 → rep1 → rep2

The members are worked out before the view is saved; what is saved is a curated
reference view whose entries the server owns (``assignedBy: "query"``), its
definition beside them, and a state row saying how keeping it is going.
"""
import json
import time
from contextlib import asynccontextmanager

import pytest
from httpx import AsyncClient
from sqlalchemy import func, select
from sqlalchemy.ext.asyncio import AsyncSession

from backend.app.api.v1.endpoints import view_membership as routes
from backend.app.db.models import ViewActivityLogORM, ViewMembershipStateORM, ViewORM, ViewVersionORM
from backend.app.services.advanced_search_service import AdvancedSearchService
from backend.app.services.feature_flags import feature_flags
from backend.app.services.live_views import pipeline
from backend.common.models.graph import GraphNode
from backend.common.models.search import SearchHit, SearchResultPage
from backend.common.models.view_membership import MACHINE
from backend.tests.test_view_membership_resolver import FakeEngine

URL = "/api/v1/views/from-members"
TYPES = {"dom": "domain", "tbl_a": "table", "tbl_b": "table", "tbl_up": "table"}
SOURCE_LAYERS = [
    {"id": "s_dom", "name": "Domains", "order": 0, "entityTypes": ["domain"]},
    {"id": "s_tbl", "name": "Tables", "order": 1, "entityTypes": ["table"]},
    {"id": "s_col", "name": "Columns", "order": 2, "entityTypes": ["column"]},
    {"id": "s_dash", "name": "Dashboards", "order": 3, "entityTypes": ["dashboard"]},
]


class TypedEngine(FakeEngine):
    """The resolver's fake graph, its entities typed; ``gone`` have left the graph."""

    def __init__(self, *args, gone=(), **kwargs):
        super().__init__(*args, **kwargs)
        self.gone = set(gone)

    @staticmethod
    def node(urn):
        kind = TYPES.get(urn) or ("column" if urn.startswith("col_") else "thing")
        return GraphNode(urn=urn, displayName=urn, entityType=kind)

    async def get_nodes_query(self, query):
        return [self.node(u) for u in query.urns if u in self.all and u not in self.gone]

    async def get_descendants(self, urn, depth=5, entity_types=None, limit=100, offset=0):
        found = await super().get_descendants(urn, depth=depth, limit=limit, offset=offset)
        return [self.node(n.urn) for n in found if n.urn not in self.gone]


def flags(**values):
    feature_flags._cache = {**(feature_flags._cache or {}), **values}
    feature_flags._cache_ts = time.monotonic()


@pytest.fixture()
def membership_on():
    flags(viewMembershipEnabled=True, traceEnabled=True)


@pytest.fixture()
def graph(db_session):
    """The graph every route reads, through an overridden engine scope. Swap
    ``graph.engine`` to change what it answers."""
    from backend.app.main import app

    class Graph:
        engine = TypedEngine()
        opened = 0

    @asynccontextmanager
    async def scope(workspace_id, data_source_id, actor):
        Graph.opened += 1
        Graph.engine._db_session = db_session
        yield Graph.engine

    app.dependency_overrides[routes.get_engine_scope] = lambda: scope
    yield Graph
    app.dependency_overrides.pop(routes.get_engine_scope, None)


@pytest.fixture()
def search(monkeypatch):
    """A query seed's search: the view it is read in resolves, and finds ``search.hits``."""
    seen = {"hits": ["col_a1"], "scopes": []}

    class _Scope:
        scope_hash = "boundary-1"

    async def resolve_scope(self, requested):
        seen["scopes"].append(requested)
        return _Scope()

    async def run(self, query, *, deadline_ms=None, run_context=None):
        hits = [SearchHit(node=TypedEngine.node(u)) for u in seen["hits"]]
        return SearchResultPage(hits=hits, elapsedMs=1), None

    monkeypatch.setattr(AdvancedSearchService, "resolve_scope", resolve_scope)
    monkeypatch.setattr(AdvancedSearchService, "search", run)
    return seen


async def workspace(client: AsyncClient, name: str = "Live WS") -> str:
    resp = await client.post("/api/v1/admin/workspaces", json={"name": name, "dataSources": []})
    assert resp.status_code == 201, resp.text
    return resp.json()["id"]


async def source_view(client: AsyncClient, ws: str, layers=SOURCE_LAYERS) -> str:
    resp = await client.post("/api/v1/views/", json={
        "name": "Sales overview", "workspaceId": ws, "viewType": "reference", "visibility": "private",
        "config": {"layout": {"type": "reference", "referenceLayout": {"layers": layers, "assignments": {}}},
                   "content": {"entityScope": "all"}},
    })
    assert resp.status_code == 201, resp.text
    return resp.json()["id"]


def body(ws: str, source: str, **overrides) -> dict:
    """Save the tables of ``dom`` (and what is inside them) as a view like ``source``."""
    return {
        "name": "Orders tables", "workspaceId": ws,
        "sources": [{"spec": {"seeds": {"urns": ["dom"]}, "expand": {"children": 2}}}],
        "layout": {"kind": "source", "sourceViewId": source},
        "provenance": {"origin": "narrow", "viewId": source},
        **overrides,
    }


def assignments_of(config: dict) -> dict:
    return config["layout"]["referenceLayout"]["assignments"]


async def made(db_session: AsyncSession, view_id: str) -> dict:
    row = (await db_session.execute(select(ViewORM).where(ViewORM.id == view_id))).scalar_one()
    return json.loads(row.config)


# ── Switches and checks ─────────────────────────────────────────────────────


async def test_the_preview_ships_off(test_client: AsyncClient, graph):
    flags(viewMembershipEnabled=False)
    ws = await workspace(test_client)
    resp = await test_client.post(URL, json=body(ws, "v-any"))
    assert resp.status_code == 403
    assert resp.json()["detail"]["feature"] == "viewMembershipEnabled"


async def test_lineage_answers_to_the_trace_switch(test_client: AsyncClient, graph, membership_on):
    flags(traceEnabled=False)
    ws = await workspace(test_client)
    src = await source_view(test_client, ws)
    resp = await test_client.post(URL, json=body(ws, src, sources=[
        {"spec": {"seeds": {"urns": ["col_a1"]}, "expand": {"upstream": 1}}}]))
    assert resp.status_code == 403
    assert resp.json()["detail"]["feature"] == "traceEnabled"


async def test_the_views_it_names_must_be_there_and_in_its_workspace(
    test_client: AsyncClient, graph, membership_on, search,
):
    ws, other_ws = await workspace(test_client), await workspace(test_client, "Elsewhere")
    src, foreign = await source_view(test_client, ws), await source_view(test_client, other_ws)
    query = {"spec": {"seeds": {"query": {"kind": "text", "value": "orders"}}}, "readIn": "v-nowhere"}

    missing = await test_client.post(URL, json=body(ws, src, sources=[query]))
    assert missing.status_code == 404

    elsewhere = await test_client.post(URL, json=body(ws, src, sources=[{**query, "readIn": foreign}]))
    assert elsewhere.status_code == 422
    # One shape for every refusal: a reason to branch on, words to show.
    assert elsewhere.json()["detail"]["reason"] == "view_other_workspace"
    assert "another workspace" in elsewhere.json()["detail"]["message"]

    no_layers_named = await test_client.post(URL, json=body(ws, src, layout={"kind": "source"}))
    assert no_layers_named.status_code == 422
    assert graph.opened == 0, "nothing is read from the graph for a request refused up front"


# ── What it makes ──────────────────────────────────────────────────────────


async def test_like_the_view_it_came_from(test_client: AsyncClient, db_session, graph, membership_on):
    ws = await workspace(test_client)
    src = await source_view(test_client, ws)
    resp = await test_client.post(URL, json=body(ws, src))
    assert resp.status_code == 201, resp.text
    out = resp.json()
    view_id = out["view"]["id"]
    config = await made(db_session, view_id)

    layers = config["layout"]["referenceLayout"]["layers"]
    assert [l["name"] for l in layers] == ["Domains", "Tables", "Columns"], "a layer that holds nothing is left"
    assert [l["linkLayerId"] for l in layers] == ["s_dom", "s_tbl", "s_col"]
    by_name = {l["linkLayerId"]: l["id"] for l in layers}
    entries = assignments_of(config)
    assert {u: e["layerId"] for u, e in entries.items()} == {
        "dom": by_name["s_dom"], "tbl_a": by_name["s_tbl"], "tbl_b": by_name["s_tbl"],
        "col_a1": by_name["s_col"], "col_a2": by_name["s_col"], "col_b1": by_name["s_col"],
    }
    assert all(e["assignedBy"] == MACHINE and e["inheritsChildren"] is False for e in entries.values())
    assert config["content"]["entityScope"] == "curated"
    assert config["membership"]["mode"] == "live"
    assert config["membership"]["provenance"]["origin"] == "narrow"

    assert out["membership"]["status"] == "ok"
    assert out["membership"]["keys"] == 6 and out["membership"]["revision"] == 1
    assert out["membership"]["lastDiff"]["added"] == 6
    state = (await db_session.execute(
        select(ViewMembershipStateORM).where(ViewMembershipStateORM.view_id == view_id))).scalar_one()
    assert (state.status, state.member_count, state.key_count) == ("ok", 6, 6)
    version = (await db_session.execute(
        select(ViewVersionORM).where(ViewVersionORM.view_id == view_id))).scalar_one()
    assert version.source == "create"
    activity = (await db_session.execute(select(ViewActivityLogORM.action).where(
        ViewActivityLogORM.view_id == view_id))).scalars().all()
    assert "created" in activity


async def test_all_the_layers_when_asked_and_a_layer_of_its_own_for_what_nothing_places(
    test_client: AsyncClient, db_session, graph, membership_on,
):
    ws = await workspace(test_client)
    src = await source_view(test_client, ws, layers=SOURCE_LAYERS[1:])        # no layer for domains
    resp = await test_client.post(URL, json=body(ws, src, keep="all"))
    assert resp.status_code == 201, resp.text
    config = await made(db_session, resp.json()["view"]["id"])
    layers = config["layout"]["referenceLayout"]["layers"]
    assert [l["name"] for l in layers] == ["Tables", "Columns", "Dashboards", "Other"]
    other = layers[-1]["id"]
    assert assignments_of(config)["dom"]["layerId"] == other
    assert config["membership"]["layout"]["fallbackLayerId"] == other


async def test_by_type_and_by_lineage_stage(test_client: AsyncClient, db_session, graph, membership_on):
    ws = await workspace(test_client)
    by_type = await test_client.post(URL, json=body(ws, "", layout={"kind": "auto"}, sources=[
        {"spec": {"seeds": {"urns": ["dom", "tbl_up"]}, "expand": {"children": 2}}}]))
    assert by_type.status_code == 201, by_type.text
    config = await made(db_session, by_type.json()["view"]["id"])
    layers = config["layout"]["referenceLayout"]["layers"]
    assert [l["name"] for l in layers] == ["Domains", "Tables"], "a layer per top-level type, the most held first"
    domains, tables = (l["id"] for l in layers)
    assert {u: e["layerId"] for u, e in assignments_of(config).items()} == {
        **{u: domains for u in ("dom", "tbl_a", "tbl_b", "col_a1", "col_a2", "col_b1")},
        "tbl_up": tables, "col_up": tables,
    }

    stages = await test_client.post(URL, json=body(ws, "", layout={"kind": "stages", "nest": False}, sources=[
        {"spec": {"seeds": {"urns": ["col_a1"]}, "expand": {"upstream": 2, "downstream": 1}}}]))
    assert stages.status_code == 201, stages.text
    config = await made(db_session, stages.json()["view"]["id"])
    entries = assignments_of(config)
    assert {u: e["layerId"] for u, e in entries.items()} == {
        "src2": "stage-up2", "src1": "stage-up1", "col_a1": "stage-seed", "rep1": "stage-down1"}


async def test_a_snapshot_is_frozen_from_the_start(test_client: AsyncClient, db_session, graph, membership_on):
    ws = await workspace(test_client)
    src = await source_view(test_client, ws)
    resp = await test_client.post(URL, json=body(ws, src, mode="snapshot"))
    assert resp.status_code == 201, resp.text
    assert resp.json()["membership"]["status"] == "frozen"
    assert resp.json()["membership"]["mode"] == "snapshot"


async def test_a_query_is_searched_in_the_view_it_names(
    test_client: AsyncClient, db_session, graph, membership_on, search,
):
    ws = await workspace(test_client)
    src = await source_view(test_client, ws)
    search["hits"] = ["col_a1", "col_b1"]
    resp = await test_client.post(URL, json=body(ws, src, sources=[
        {"spec": {"seeds": {"query": {"kind": "text", "value": "orders"}}}, "readIn": src}]))
    assert resp.status_code == 201, resp.text
    entries = assignments_of(await made(db_session, resp.json()["view"]["id"]))
    assert {"col_a1", "col_b1"} <= set(entries)
    assert search["scopes"] and search["scopes"][0].view_id == src
    assert resp.json()["membership"]["readIn"] == [{"viewId": src, "name": "Sales overview", "available": True}]


# ── What it refuses to make ─────────────────────────────────────────────────


async def test_over_the_limit_nothing_is_made(
    test_client: AsyncClient, db_session, graph, membership_on, monkeypatch,
):
    monkeypatch.setattr(pipeline, "entry_limit", lambda: 4)
    ws = await workspace(test_client)
    src = await source_view(test_client, ws)
    before = (await db_session.execute(select(func.count()).select_from(ViewORM))).scalar_one()
    resp = await test_client.post(URL, json=body(ws, src))
    assert resp.status_code == 422
    detail = resp.json()["detail"]
    assert (detail["reason"], detail["keys"], detail["limit"]) == ("over_cap", 6, 4)
    assert "at most 4" in detail["message"]
    after = (await db_session.execute(select(func.count()).select_from(ViewORM))).scalar_one()
    assert after == before


async def test_a_short_answer_saves_nothing_and_says_when_to_retry(
    test_client: AsyncClient, db_session, graph, membership_on,
):
    graph.engine = TypedEngine(step_gives_up="timeout")
    ws = await workspace(test_client)
    resp = await test_client.post(URL, json=body(ws, "", layout={"kind": "auto"}, sources=[
        {"spec": {"seeds": {"urns": ["col_a1"]}, "expand": {"upstream": 1}}}]))
    assert resp.status_code == 503
    assert resp.headers["retry-after"] == "30"
    assert resp.json()["detail"]["reason"] == "short_answer"


# ── Retries ─────────────────────────────────────────────────────────────────


async def test_a_retry_with_the_same_key_answers_with_the_view_it_made(
    test_client: AsyncClient, db_session, graph, membership_on,
):
    ws = await workspace(test_client)
    src = await source_view(test_client, ws)
    headers = {"Idempotency-Key": "save-1"}
    first = await test_client.post(URL, json=body(ws, src), headers=headers)
    again = await test_client.post(URL, json=body(ws, src), headers=headers)
    assert (first.status_code, again.status_code) == (201, 200)
    assert again.json()["view"]["id"] == first.json()["view"]["id"]
    named = (await db_session.execute(
        select(func.count()).select_from(ViewORM).where(ViewORM.name == "Orders tables"))).scalar_one()
    assert named == 1
    other = await test_client.post(URL, json=body(ws, src), headers={"Idempotency-Key": "save-2"})
    assert other.status_code == 201 and other.json()["view"]["id"] != first.json()["view"]["id"]


# ── The preview: POST /{ws}/graph/members/plan ─────────────────────────────


@pytest.fixture()
def preview(test_client: AsyncClient, db_session):
    """POST a plan body for workspace ``ws``, previewed from view ``src``."""
    from backend.app.api.v1.endpoints.graph import get_context_engine
    from backend.app.main import app

    async def _preview(ws, src, payload, engine=None):
        engine = engine or TypedEngine()
        engine._db_session = db_session

        async def _engine():
            return engine

        app.dependency_overrides[get_context_engine] = _engine
        try:
            return await test_client.post(f"/api/v1/{ws}/graph/members/plan?viewId={src}", json=payload)
        finally:
            app.dependency_overrides.pop(get_context_engine, None)

    return _preview


def plan_body(src: str, **overrides) -> dict:
    return {"sources": [{"spec": {"seeds": {"urns": ["dom"]}, "expand": {"children": 2}}}],
            "layout": {"kind": "source", "sourceViewId": src}, **overrides}


async def test_a_preview_counts_each_layer_and_saves_nothing(
    test_client: AsyncClient, db_session, membership_on, preview,
):
    ws = await workspace(test_client)
    src = await source_view(test_client, ws)
    before = (await db_session.execute(select(func.count()).select_from(ViewORM))).scalar_one()
    resp = await preview(ws, src, plan_body(src))
    assert resp.status_code == 200, resp.text
    out = resp.json()
    assert (out["keys"], out["members"], out["containers"], out["limit"], out["overCap"]) == (6, 6, 0, 5000, False)
    assert [(l["name"], l["count"], l["kept"], l["linkLayerId"]) for l in out["layers"]] == [
        ("Domains", 1, True, "s_dom"), ("Tables", 2, True, "s_tbl"),
        ("Columns", 3, True, "s_col"), ("Dashboards", 0, False, "s_dash"),
    ]
    every = await preview(ws, src, plan_body(src, keep="all"))
    assert all(l["kept"] for l in every.json()["layers"])
    after = (await db_session.execute(select(func.count()).select_from(ViewORM))).scalar_one()
    assert after == before


async def test_a_preview_over_the_limit_says_so(
    test_client: AsyncClient, membership_on, preview, monkeypatch,
):
    monkeypatch.setattr(pipeline, "entry_limit", lambda: 4)
    ws = await workspace(test_client)
    src = await source_view(test_client, ws)
    out = (await preview(ws, src, plan_body(src))).json()
    assert (out["overCap"], out["keys"], out["limit"]) == (True, 6, 4)


async def test_a_preview_answers_to_the_switches(test_client: AsyncClient, preview):
    flags(viewMembershipEnabled=False)
    ws = await workspace(test_client)
    src = await source_view(test_client, ws)
    assert (await preview(ws, src, plan_body(src))).status_code == 403
    flags(viewMembershipEnabled=True, traceEnabled=False)
    lineage = await preview(ws, src, plan_body(src, sources=[
        {"spec": {"seeds": {"urns": ["col_a1"]}, "expand": {"downstream": 1}}}]))
    assert lineage.status_code == 403
    assert lineage.json()["detail"]["feature"] == "traceEnabled"
