"""``POST /views/from-members`` — a whole view made from a query's members.

The resolver's fake graph answers, with types (``dom`` a domain, ``tbl_*`` tables,
``col_*`` columns):

    dom ⊃ tbl_a ⊃ {col_a1, col_a2};  dom ⊃ tbl_b ⊃ col_b1
    src3 → src2 → src1 → col_a1 → rep1 → rep2

What the sources reach is worked out (each source's member set) before the view is
saved; what is saved is a curated reference view, its definition, its members — rows
of ``view_members`` at the epoch readers see, never entries of its config — and a state
row saying how keeping it is going.
"""
import asyncio
import json
import time
from contextlib import asynccontextmanager

import pytest
from httpx import AsyncClient
from sqlalchemy import func, select, update
from sqlalchemy.ext.asyncio import AsyncSession

from backend.app.api.v1.endpoints import view_membership as routes
from backend.app.db.models import (
    ViewActivityLogORM,
    ViewMemberORM,
    ViewMembershipStateORM,
    ViewORM,
    ViewVersionORM,
)
from backend.app.services.advanced_search_service import AdvancedSearchService
from backend.app.services.feature_flags import feature_flags
from backend.app.services.live_views import pipeline
from backend.common.models.graph import GraphNode
from backend.common.models.search import SearchHit, SearchResultPage
from backend.common.models.search_view import REST_LAYER_ID
from backend.common.models.view_membership import MACHINE
from backend.tests.fixtures.membership_graph import FakeEngine

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
    row = (await db_session.execute(select(ViewORM).where(ViewORM.id == view_id)
                                    .execution_options(populate_existing=True))).scalar_one()
    return json.loads(row.config)


async def members_of(db_session: AsyncSession, view_id: str) -> dict:
    """A view's members as readers see them (the member table, at ``members_epoch``),
    shaped as the server's entries."""
    state = (await db_session.execute(
        select(ViewMembershipStateORM).where(ViewMembershipStateORM.view_id == view_id)
        .execution_options(populate_existing=True))).scalar_one()
    rows = (await db_session.execute(select(ViewMemberORM).where(
        ViewMemberORM.view_id == view_id, ViewMemberORM.epoch == state.members_epoch))).scalars().all()
    return {r.urn: {"layerId": r.layer_id, "inheritsChildren": r.whole, "assignedBy": MACHINE} for r in rows}


async def entries_of(db_session: AsyncSession, view_id: str) -> dict:
    """What the view holds: its members, and the entries people placed (its config's)."""
    return {**await members_of(db_session, view_id), **assignments_of(await made(db_session, view_id))}


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
    assert assignments_of(config) == {}, "its members are never entries of its config"
    entries = await members_of(db_session, view_id)
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
    assert (await members_of(db_session, resp.json()["view"]["id"]))["dom"]["layerId"] == other
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
    assert {u: e["layerId"] for u, e in (await members_of(db_session, by_type.json()["view"]["id"])).items()} == {
        **{u: domains for u in ("dom", "tbl_a", "tbl_b", "col_a1", "col_a2", "col_b1")},
        "tbl_up": tables, "col_up": tables,
    }

    stages = await test_client.post(URL, json=body(ws, "", layout={"kind": "stages", "nest": False}, sources=[
        {"spec": {"seeds": {"urns": ["col_a1"]}, "expand": {"upstream": 2, "downstream": 1}}}]))
    assert stages.status_code == 201, stages.text
    entries = await members_of(db_session, stages.json()["view"]["id"])
    assert {u: e["layerId"] for u, e in entries.items()} == {
        "src2": "stage-up2", "src1": "stage-up1", "col_a1": "stage-seed", "rep1": "stage-down1"}


async def test_a_trace_kept_with_its_tables_places_each_table_and_its_columns_at_its_stage(
    test_client: AsyncClient, db_session, graph, membership_on,
):
    """A column-grain trace kept with the tables its sources sit in, and what is inside
    them: each table at its column's stage, its columns with it."""
    graph.engine = FakeEngine(containment=True)
    ws = await workspace(test_client)
    resp = await test_client.post(URL, json=body(ws, "", layout={"kind": "stages"}, sources=[{"spec": {
        "seeds": {"urns": ["rpt_c"]},
        "expand": {"upstream": "all", "partnerHosts": True, "partnerLineage": True, "partnerChildren": 1}}}]))
    assert resp.status_code == 201, resp.text
    entries = await members_of(db_session, resp.json()["view"]["id"])
    assert {u: e["layerId"] for u, e in entries.items()} == {
        "rpt_c": "stage-seed",
        **dict.fromkeys(["orders", "ord_id", "ord_amt", "ord_note"], "stage-up1"),
        **dict.fromkeys(["payments", "pay_amt"], "stage-up2"),
    }


async def test_a_trace_kept_as_a_view_says_it_came_from_a_trace(
    test_client: AsyncClient, db_session, graph, membership_on,
):
    """The dock's Save as view: the trace's seeds and reach, laid out as lineage
    stages, and its provenance names the trace it was made from."""
    ws = await workspace(test_client)
    resp = await test_client.post(URL, json=body(
        ws, "", layout={"kind": "stages"}, provenance={"origin": "trace"},
        sources=[{"spec": {"seeds": {"urns": ["col_a1"]}, "expand": {"upstream": "all", "downstream": 1}}}]))
    assert resp.status_code == 201, resp.text
    config = await made(db_session, resp.json()["view"]["id"])
    assert config["membership"]["provenance"]["origin"] == "trace"
    assert {"src1", "src2", "rep1"} <= set(await members_of(db_session, resp.json()["view"]["id"])), (
        "the whole way up, one step down")


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
    entries = await members_of(db_session, resp.json()["view"]["id"])
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
    assert (detail["reason"], detail["members"], detail["limit"]) == ("over_cap", 6, 4)
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
    assert (out["keys"], out["members"], out["containers"], out["limit"], out["overCap"]) == (
        6, 6, 0, pipeline.LIVE_VIEW_MAX_MEMBERS, False)
    assert pipeline.LIVE_VIEW_MAX_MEMBERS == 250_000 and out["estimated"] is False
    assert [(l["name"], l["count"], l["kept"], l["linkLayerId"]) for l in out["layers"]] == [
        ("Domains", 1, True, "s_dom"), ("Tables", 2, True, "s_tbl"),
        ("Columns", 3, True, "s_col"), ("Dashboards", 0, False, "s_dash"),
    ]
    every = await preview(ws, src, plan_body(src, keep="all"))
    assert all(l["kept"] for l in every.json()["layers"])
    after = (await db_session.execute(select(func.count()).select_from(ViewORM))).scalar_one()
    assert after == before


async def test_saving_what_was_previewed_makes_the_layers_the_preview_showed(
    test_client: AsyncClient, db_session, graph, membership_on, preview, monkeypatch,
):
    """The preview's draft is kept: saving the same sources and layout makes the very
    layers it showed — the same ids — and works nothing out again."""
    import fakeredis.aioredis

    from backend.app.services import graph_cache as graph_cache_mod

    monkeypatch.setattr(graph_cache_mod, "_cache", graph_cache_mod.GraphCache(fakeredis.aioredis.FakeRedis()))
    real, drafted = pipeline.draft_view, []

    async def draft_view(*args, **kwargs):
        drafted.append(kwargs)
        return await real(*args, **kwargs)

    monkeypatch.setattr(pipeline, "draft_view", draft_view)
    ws = await workspace(test_client)
    src = await source_view(test_client, ws)
    engine = graph.engine = TypedEngine()
    engine._workspace_id = ws
    planned = await preview(ws, src, plan_body(src), engine)
    assert planned.status_code == 200, planned.text
    resp = await test_client.post(URL, json=body(ws, src))
    assert resp.status_code == 201, resp.text
    layers = (await made(db_session, resp.json()["view"]["id"]))["layout"]["referenceLayout"]["layers"]
    assert [l["id"] for l in layers] == [l["id"] for l in planned.json()["layers"] if l["kept"]]
    assert len(drafted) == 1, "worked out once, for the preview"

    other = await test_client.post(URL, json=body(ws, src, keep="all"))
    assert other.status_code == 201 and len(drafted) == 2, "another question, worked out afresh"
    assert drafted[1]["estimate_above"] == pipeline.SAMPLE, "a save places at most a sample"


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


# ── Large sets: worked out across requests ──────────────────────────────────


async def test_while_the_sources_resolve_nothing_is_made_and_the_key_waits_for_the_view(
    test_client: AsyncClient, db_session, graph, membership_on,
):
    ws = await workspace(test_client)
    src = await source_view(test_client, ws)
    headers = {"Idempotency-Key": "large-1"}
    before = (await db_session.execute(select(func.count()).select_from(ViewORM))).scalar_one()
    asked = await test_client.post(URL, json=body(ws, src, waitMs=0), headers=headers)
    assert asked.status_code == 202, asked.text
    out = asked.json()
    assert out["status"] == "resolving"
    assert [(s["status"], s["stage"]) for s in out["sets"]] == [("running", "seeds")] and out["sets"][0]["setId"]
    assert (await db_session.execute(select(func.count()).select_from(ViewORM))).scalar_one() == before
    again = await test_client.post(URL, json=body(ws, src, waitMs=0), headers=headers)
    assert again.status_code == 202 and again.json()["sets"][0]["setId"] == out["sets"][0]["setId"], (
        "the same set, carried on")

    made_ = await test_client.post(URL, json=body(ws, src), headers=headers)
    assert made_.status_code == 201, "a 202 recorded nothing against the key"
    replay = await test_client.post(URL, json=body(ws, src), headers=headers)
    assert (replay.status_code, replay.json()["view"]["id"]) == (200, made_.json()["view"]["id"])


async def test_a_view_larger_than_its_first_turn_is_made_updating_and_says_how_far_it_got(
    test_client: AsyncClient, db_session, graph, membership_on, monkeypatch,
):
    """Saving answers after a first short turn: the view is made, its first pages placed,
    and it says ``updating`` with how far it got — as its status does, and a retry with
    the same key does, while it is under way. Opening it carries the rest on."""
    real = pipeline.read_page

    async def slow(*args, **kwargs):
        await asyncio.sleep(0.2)
        return await real(*args, **kwargs)

    monkeypatch.setattr(pipeline, "PAGE", 2)
    monkeypatch.setattr(pipeline, "CREATE_TURN_SECS", 0.3)
    monkeypatch.setattr(pipeline, "read_page", slow)
    ws = await workspace(test_client)
    src = await source_view(test_client, ws)
    headers = {"Idempotency-Key": "turn-1"}
    resp = await test_client.post(URL, json=body(ws, src), headers=headers)
    assert resp.status_code == 201, resp.text
    view_id = resp.json()["view"]["id"]
    membership = resp.json()["membership"]
    detail = membership["detail"]
    assert (membership["status"], detail["reason"], detail["placed"], detail["members"]) == (
        "updating", "placing", 2, 6), "one page of two placed: the next would not fit the turn"
    assert [s["status"] for s in detail["sets"]] == ["complete"]
    state = (await db_session.execute(select(ViewMembershipStateORM).where(
        ViewMembershipStateORM.view_id == view_id).execution_options(populate_existing=True))).scalar_one()
    assert state.members_epoch is None, "nothing applied yet: readers see no half answer"
    assert state.lease_owner is None, "its turn let go: the next request carries it on"

    status = (await test_client.get(f"/api/v1/views/{view_id}/membership")).json()
    assert (status["status"], status["detail"]) == ("updating", detail)
    replay = await test_client.post(URL, json=body(ws, src), headers=headers)
    assert (replay.status_code, replay.json()["view"]["id"]) == (200, view_id)
    assert (replay.json()["membership"]["status"], replay.json()["membership"]["detail"]) == ("updating", detail)

    monkeypatch.setattr(pipeline, "read_page", real)
    opened = await test_client.post(f"/api/v1/views/{view_id}/membership/refresh", params={"trigger": "open"})
    assert (opened.status_code, opened.json()["outcome"]) == (200, "applied")
    assert len(await members_of(db_session, view_id)) == 6
    assert opened.json()["membership"]["status"] == "ok"


async def test_a_turn_cut_off_lets_go_of_the_view_at_once_and_the_next_carries_it_on(
    test_client: AsyncClient, db_session, db_engine, graph, membership_on, monkeypatch,
):
    """A request cut off mid-page (its tier, or its client gone) frees its lease straight
    away — on a session of its own — keeping how far it got: the next request takes the
    run over at the same epoch rather than wait the lease out."""
    from sqlalchemy.ext.asyncio import async_sessionmaker

    monkeypatch.setattr(pipeline, "_own_session", async_sessionmaker(bind=db_engine, expire_on_commit=False))
    ws = await workspace(test_client)
    src = await source_view(test_client, ws)
    view_id = (await test_client.post(URL, json=body(ws, src))).json()["view"]["id"]
    graph.engine = TypedEngine(gone={"col_b1"})
    real, reading, calls = pipeline.read_page, asyncio.Event(), {"n": 0}

    async def read_page(*args, **kwargs):
        calls["n"] += 1
        if calls["n"] == 2:
            reading.set()
            await asyncio.Event().wait()            # the graph never answers this one
        return await real(*args, **kwargs)

    monkeypatch.setattr(pipeline, "read_page", read_page)
    scope = app_engine_scope()
    turn = asyncio.create_task(pipeline.refresh(view_id, session=db_session, engine_scope=scope, owner="cut",
                                                budget_s=30, page_size=2))
    await reading.wait()
    turn.cancel()
    with pytest.raises(asyncio.CancelledError):
        await turn
    await asyncio.gather(*pipeline._letting_go)
    state = (await db_session.execute(select(ViewMembershipStateORM).where(
        ViewMembershipStateORM.view_id == view_id).execution_options(populate_existing=True))).scalar_one()
    assert (state.lease_owner, state.lease_until, state.status) == (None, None, "updating")
    assert json.loads(state.materialize)["placing"]["placed"] == 2, "its first page stands"

    monkeypatch.setattr(pipeline, "read_page", real)
    out = await pipeline.refresh(view_id, session=db_session, engine_scope=scope, owner="next", budget_s=30,
                                 page_size=2)
    assert (out.outcome, out.diff["removed"]) == ("applied", 1), "taken over at once, not refused as busy"
    after = (await db_session.execute(select(ViewMembershipStateORM).where(
        ViewMembershipStateORM.view_id == view_id).execution_options(populate_existing=True))).scalar_one()
    assert after.members_epoch == state.epoch, "carried on at its epoch"
    assert set(await members_of(db_session, view_id)) == {"dom", "tbl_a", "tbl_b", "col_a1", "col_a2"}


async def test_cut_off_as_it_is_saved_a_new_view_lets_go_of_itself_at_once(
    test_client: AsyncClient, db_session, db_engine, graph, membership_on, monkeypatch,
):
    """Cut off as the transaction that makes it commits — which may land all the same — a new
    view's claim is let go at once: the next request carries its first answer on, never
    waiting the lease out."""
    from sqlalchemy.ext.asyncio import async_sessionmaker

    monkeypatch.setattr(pipeline, "_own_session", async_sessionmaker(bind=db_engine, expire_on_commit=False))
    ws = await workspace(test_client)
    src = await source_view(test_client, ws)
    real_commit, real_record, armed = db_session.commit, routes.view_activity_repo.record_view_activity, {}

    async def record(*args, **kwargs):
        armed["now"] = True
        return await real_record(*args, **kwargs)

    async def commit():
        await real_commit()
        if armed.pop("now", False):
            raise asyncio.CancelledError()

    monkeypatch.setattr(routes.view_activity_repo, "record_view_activity", record)
    monkeypatch.setattr(db_session, "commit", commit)
    cut = await test_client.post(URL, json=body(ws, src))
    assert cut.status_code >= 500, "cut off: it never answered"
    monkeypatch.setattr(db_session, "commit", real_commit)
    await asyncio.gather(*pipeline._letting_go)
    view_id = (await db_session.execute(select(ViewORM.id).where(ViewORM.name == "Orders tables"))).scalar_one()
    state = (await db_session.execute(select(ViewMembershipStateORM).where(
        ViewMembershipStateORM.view_id == view_id).execution_options(populate_existing=True))).scalar_one()
    assert (state.lease_owner, state.lease_until, state.status) == (None, None, "updating")
    assert json.loads(state.materialize)["placing"]["placed"] == 0, "its run kept, for the next request"


def app_engine_scope():
    from backend.app.main import app

    return app.dependency_overrides[routes.get_engine_scope]()


def test_a_turn_and_applying_it_end_inside_the_tier_a_views_request_is_cut_off_at(monkeypatch):
    from backend.app.main import _TimeoutMiddleware

    monkeypatch.delenv("HTTP_TIMEOUT_DEFAULT_SECS", raising=False)
    tier = _TimeoutMiddleware(lambda *a: None)._resolve_timeout("/api/v1/views/v-1/membership/refresh")
    assert tier == 30
    assert routes._budget_s() + pipeline.APPLY_RESERVE_S < tier
    assert pipeline.CREATE_TURN_SECS <= routes._budget_s()


async def test_a_preview_waits_on_its_sets_too(test_client: AsyncClient, membership_on, preview):
    ws = await workspace(test_client)
    src = await source_view(test_client, ws)
    resp = await preview(ws, src, plan_body(src, waitMs=0))
    assert resp.status_code == 202 and resp.json()["status"] == "resolving"


async def test_a_preview_of_a_large_set_places_its_first_members_and_says_so(
    test_client: AsyncClient, membership_on, preview, monkeypatch,
):
    monkeypatch.setattr(pipeline, "ESTIMATE_ABOVE", 2)
    monkeypatch.setattr(pipeline, "SAMPLE", 3)
    ws = await workspace(test_client)
    src = await source_view(test_client, ws)
    out = (await preview(ws, src, plan_body(src))).json()
    assert (out["estimated"], out["members"], out["overCap"]) == (True, 6, False)
    counts = {l["name"]: (l["count"], l["kept"]) for l in out["layers"]}
    # The first three (dom, tbl_a, tbl_b), scaled to all six; a layer of its own for what they did not see.
    assert counts["Domains"] == (2, True) and counts["Tables"] == (4, True) and counts["Other"][1] is True


# ── Following a view: a subset of it, in its layers as it has them now ─────


def follow(src: str) -> dict:
    return {"kind": "follow", "sourceViewId": src}


@pytest.fixture()
def data(monkeypatch):
    """A data version the graph says (one it can't say is never taken as unchanged)."""
    async def version(engine):
        return "v1"

    monkeypatch.setattr(pipeline, "search_data_version", version)


async def following(client: AsyncClient, ws: str, src: str) -> str:
    resp = await client.post(URL, json=body(ws, src, layout=follow(src)))
    assert resp.status_code == 201, resp.text
    return resp.json()["view"]["id"]


async def opened(client: AsyncClient, db_session: AsyncSession, view_id: str) -> dict:
    """The view opened, past the 30 seconds an open after an update answers ``recent``."""
    await db_session.execute(update(ViewMembershipStateORM).where(ViewMembershipStateORM.view_id == view_id)
                             .values(last_started_at="2000-01-01T00:00:00+00:00"))
    await db_session.commit()
    resp = await client.post(f"/api/v1/views/{view_id}/membership/refresh", params={"trigger": "open"})
    assert resp.status_code == 200, resp.text
    return resp.json()


async def served(client: AsyncClient, view_id: str) -> list:
    resp = await client.get(f"/api/v1/views/{view_id}")
    assert resp.status_code == 200, resp.text
    return resp.json()["config"]["layout"]["referenceLayout"]["layers"]


async def test_a_preview_that_follows_a_view_offers_every_layer_it_has(
    test_client: AsyncClient, membership_on, preview,
):
    ws = await workspace(test_client)
    src = await source_view(test_client, ws)
    resp = await preview(ws, src, plan_body(src, layout=follow(src)))
    assert resp.status_code == 200, resp.text
    assert [(l["id"], l["name"], l["count"], l["kept"]) for l in resp.json()["layers"]] == [
        ("s_dom", "Domains", 1, True), ("s_tbl", "Tables", 2, True), ("s_col", "Columns", 3, True),
        ("s_dash", "Dashboards", 0, True), ("other-matches", "Other matches", 0, True),
    ], "its layers, every one kept, and Other matches for what it places nowhere"


async def test_a_view_that_follows_another_is_served_its_layers_as_they_are_now(
    test_client: AsyncClient, db_session, graph, membership_on,
):
    ws = await workspace(test_client)
    src = await source_view(test_client, ws)
    resp = await test_client.post(URL, json=body(ws, src, layout=follow(src)))
    assert resp.status_code == 201, resp.text
    view_id = resp.json()["view"]["id"]
    assert resp.json()["membership"]["follows"] == {"viewId": src, "name": "Sales overview", "available": True}
    config = await made(db_session, view_id)
    assert config["layout"]["referenceLayout"]["layers"] == [], "never stored"
    row = (await db_session.execute(select(ViewORM).where(ViewORM.id == view_id))).scalar_one()
    assert row.subset_of == src, "among its subsets"
    assert {u: e["layerId"] for u, e in (await members_of(db_session, view_id)).items()} == {
        "dom": "s_dom", "tbl_a": "s_tbl", "tbl_b": "s_tbl", "col_a1": "s_col", "col_a2": "s_col", "col_b1": "s_col",
    }, "in its layers, where it places them"
    assert [l["id"] for l in await served(test_client, view_id)] == [
        "s_dom", "s_tbl", "s_col", "s_dash", "other-matches"]

    renamed = [{**l, "name": "Every table"} if l["id"] == "s_tbl" else l for l in SOURCE_LAYERS]
    assert (await test_client.put(f"/api/v1/views/{src}/layout", json={
        "referenceLayout": {"layers": renamed, "assignments": {}}})).status_code == 200
    assert [l["name"] for l in await served(test_client, view_id)][:3] == ["Domains", "Every table", "Columns"]


async def test_each_member_is_where_the_view_it_follows_places_it_by_hand_too(
    test_client: AsyncClient, db_session, graph, membership_on,
):
    """What people placed by hand in the view it follows — one entity in another layer
    than its type's, one with everything inside it — is where the follower draws it."""
    ws = await workspace(test_client)
    src = await source_view(test_client, ws)
    hand = {"tbl_b": {"layerId": "s_dash", "assignedBy": "user"},
            "tbl_a": {"layerId": "s_dom", "inheritsChildren": True, "assignedBy": "user"}}
    assert (await test_client.put(f"/api/v1/views/{src}/layout", json={
        "referenceLayout": {"layers": SOURCE_LAYERS, "assignments": hand}})).status_code == 200
    view_id = await following(test_client, ws, src)
    assert {u: e["layerId"] for u, e in (await members_of(db_session, view_id)).items()} == {
        "dom": "s_dom", "tbl_a": "s_dom", "col_a1": "s_dom", "col_a2": "s_dom",
        # A column of a table placed by hand goes with it, past its own type's layer — as
        # the canvas draws it (placement conformance: hand-chain-beats-own-rule-and-stamp).
        "tbl_b": "s_dash", "col_b1": "s_dash",
    }
    assert (await made(db_session, view_id))["layout"]["referenceLayout"]["assignments"] == {}, (
        "placed by the view it follows, never copied into this one")


async def test_where_the_view_it_follows_places_things_is_followed_when_it_is_next_opened(
    test_client: AsyncClient, db_session, graph, membership_on, data,
):
    ws = await workspace(test_client)
    src = await source_view(test_client, ws)
    view_id = await following(test_client, ws, src)
    assert (await opened(test_client, db_session, view_id))["detail"] == {"reason": "up_to_date"}

    renamed = [{**l, "name": "Every table"} if l["id"] == "s_tbl" else l for l in SOURCE_LAYERS]
    await test_client.put(f"/api/v1/views/{src}/layout", json={"referenceLayout": {"layers": renamed,
                                                                                    "assignments": {}}})
    assert (await opened(test_client, db_session, view_id))["detail"] == {"reason": "up_to_date"}, (
        "a rename needs nothing")

    moved = [{**l, "entityTypes": ["domain", "table"]} if l["id"] == "s_dom"
             else {**l, "entityTypes": []} if l["id"] == "s_tbl" else l for l in SOURCE_LAYERS]
    await test_client.put(f"/api/v1/views/{src}/layout", json={"referenceLayout": {"layers": moved,
                                                                                    "assignments": {}}})
    out = await opened(test_client, db_session, view_id)
    assert (out["outcome"], out["diff"]["moved"], out["diff"]["added"]) == ("applied", 2, 0)
    entries = await members_of(db_session, view_id)
    assert (entries["tbl_a"]["layerId"], entries["tbl_b"]["layerId"]) == ("s_dom", "s_dom")
    assert (await opened(test_client, db_session, view_id))["detail"] == {"reason": "up_to_date"}


async def test_with_the_view_it_follows_gone_it_keeps_its_members_and_shows_no_layers(
    test_client: AsyncClient, db_session, graph, membership_on,
):
    ws = await workspace(test_client)
    src = await source_view(test_client, ws)
    view_id = await following(test_client, ws, src)
    assert (await test_client.delete(f"/api/v1/views/{src}")).status_code in (200, 204)
    out = await opened(test_client, db_session, view_id)
    membership = out["membership"]
    assert (out["outcome"], membership["status"], membership["detail"]) == (
        "source_missing", "source_missing", {"reason": "base_missing"})
    assert membership["follows"] == {"viewId": src, "name": None, "available": False}
    assert len(await members_of(db_session, view_id)) == 6, "its members kept"
    assert await served(test_client, view_id) == [], "the canvas says its base is gone"


async def test_a_subset_or_a_view_made_from_a_query_can_not_be_followed(
    test_client: AsyncClient, graph, membership_on, preview,
):
    ws = await workspace(test_client)
    src = await source_view(test_client, ws)
    follower = await following(test_client, ws, src)
    listed = (await test_client.post(URL, json=body(ws, src))).json()["view"]["id"]
    for base, reason in ((follower, "base_is_subset"), (listed, "base_is_list")):
        resp = await test_client.post(URL, json=body(ws, base, layout=follow(base)))
        assert (resp.status_code, resp.json()["detail"]["reason"]) == (422, reason), resp.text
        assert resp.json()["detail"]["message"]
        previewed = await preview(ws, base, plan_body(base, layout=follow(base)))
        assert (previewed.status_code, previewed.json()["detail"]["reason"]) == (422, reason), previewed.text
    unnamed = await test_client.post(URL, json=body(ws, src, layout={"kind": "follow"}))
    assert unnamed.status_code == 422, "a follow layout names the view it follows"


async def test_like_a_view_that_follows_another_copies_the_layers_it_is_served(
    test_client: AsyncClient, db_session, graph, membership_on, preview,
):
    """Its own config stores no layers: "Like" copies those of the view it follows, as it
    shows them — and it still can't be followed itself."""
    ws = await workspace(test_client)
    src = await source_view(test_client, ws)
    follower = await following(test_client, ws, src)

    planned = await preview(ws, follower, plan_body(follower, keep="all"))
    assert planned.status_code == 200, planned.text
    assert [(l["name"], l["linkLayerId"], l["count"]) for l in planned.json()["layers"]][:3] == [
        ("Domains", "s_dom", 1), ("Tables", "s_tbl", 2), ("Columns", "s_col", 3)]

    made_like = await test_client.post(URL, json=body(ws, follower, keep="all"))
    assert made_like.status_code == 201, made_like.text
    view_id = made_like.json()["view"]["id"]
    layers = (await made(db_session, view_id))["layout"]["referenceLayout"]["layers"]
    assert [(l["name"], l["linkLayerId"]) for l in layers] == [
        ("Domains", "s_dom"), ("Tables", "s_tbl"), ("Columns", "s_col"), ("Dashboards", "s_dash"),
        ("Other matches", "other-matches")], "the base's, and the fallback layer it is served"
    by_link = {l["linkLayerId"]: l["id"] for l in layers}
    assert {u: e["layerId"] for u, e in (await members_of(db_session, view_id)).items()} == {
        "dom": by_link["s_dom"], "tbl_a": by_link["s_tbl"], "tbl_b": by_link["s_tbl"],
        "col_a1": by_link["s_col"], "col_a2": by_link["s_col"], "col_b1": by_link["s_col"],
    }

    refused = await test_client.post(URL, json=body(ws, follower, layout=follow(follower)))
    assert (refused.status_code, refused.json()["detail"]["reason"]) == (422, "base_is_subset")
    previewed = await preview(ws, follower, plan_body(follower, layout=follow(follower)))
    assert (previewed.status_code, previewed.json()["detail"]["reason"]) == (422, "base_is_subset")


async def test_its_layers_are_changed_in_the_view_it_follows(
    test_client: AsyncClient, db_session, graph, membership_on,
):
    ws = await workspace(test_client)
    src = await source_view(test_client, ws)
    view_id = await following(test_client, ws, src)
    before = await members_of(db_session, view_id)
    resp = await test_client.put(f"/api/v1/views/{view_id}/layout", json={
        "referenceLayout": {"layers": SOURCE_LAYERS[:1], "assignments": {}}})
    assert resp.status_code == 422 and "the view it follows" in resp.json()["detail"]
    assert (await made(db_session, view_id))["layout"]["referenceLayout"]["layers"] == []
    assert await members_of(db_session, view_id) == before, "nothing written"

    status = (await test_client.get(f"/api/v1/views/{view_id}/membership")).json()
    changed = await test_client.put(f"/api/v1/views/{view_id}/membership", json={
        "ifDefinitionHash": status["definitionHash"], "layout": {"kind": "auto"}})
    assert (changed.status_code, changed.json()["detail"]["reason"]) == (422, "layout_fixed")


async def test_a_reader_who_can_not_open_the_view_it_follows_reads_it_all_the_same(
    test_client: AsyncClient, db_session, graph, membership_on, monkeypatch,
):
    from backend.app.api.v1.endpoints.graph import get_context_engine
    from backend.app.main import app
    from backend.app.services import view_access

    ws = await workspace(test_client)
    src = await source_view(test_client, ws)
    view_id = await following(test_client, ws, src)
    monkeypatch.setenv("RBAC_ENFORCE_VIEWS", "1")
    real = view_access.can_read_view

    async def not_the_base(session, ctx, view):
        return view.id != src and await real(session, ctx, view)

    monkeypatch.setattr(view_access, "can_read_view", not_the_base)
    assert (await test_client.get(f"/api/v1/views/{src}")).status_code in (403, 404)
    out = await opened(test_client, db_session, view_id)
    assert out["membership"]["follows"] == {"viewId": src, "name": None, "available": True}
    assert [l["id"] for l in await served(test_client, view_id)][:3] == ["s_dom", "s_tbl", "s_col"]

    engine = TypedEngine()
    engine._db_session = db_session

    async def _engine():
        return engine

    app.dependency_overrides[get_context_engine] = _engine
    try:
        page = await test_client.post(f"/api/v1/{ws}/graph/view-members?viewId={view_id}", json={"layerId": "s_col"})
    finally:
        app.dependency_overrides.pop(get_context_engine, None)
    assert page.status_code == 200, page.text
    assert page.json()["totalCount"] == 3


# ── Following a view: what people put in it, over what that view places ─────


async def status_of(db_session: AsyncSession, view_id: str) -> tuple:
    state = (await db_session.execute(
        select(ViewMembershipStateORM).where(ViewMembershipStateORM.view_id == view_id)
        .execution_options(populate_existing=True))).scalar_one()
    return state.status, json.loads(state.status_detail) if state.status_detail else None


async def served_entries(client: AsyncClient, view_id: str) -> dict:
    resp = await client.get(f"/api/v1/views/{view_id}")
    assert resp.status_code == 200, resp.text
    return {u: e["layerId"] for u, e in resp.json()["config"]["layout"]["referenceLayout"]["assignments"].items()}


async def test_a_member_moved_by_hand_in_a_follower_is_placed_where_it_was_put(
    test_client: AsyncClient, db_session, graph, membership_on,
):
    """Its canvas sends its entries, never layers. A member moved into a layer it is
    served — "Other matches" among them — is placed there at once and remembered, and a
    save that moves nothing leaves every member where it is. An entity put in a layer it
    isn't served is refused; with the view it follows gone, so is every save."""
    ws = await workspace(test_client)
    src = await source_view(test_client, ws)
    view_id = await following(test_client, ws, src)
    url = f"/api/v1/views/{view_id}/layout"
    before = await members_of(db_session, view_id)
    resp = await test_client.put(url, json={"referenceLayout": {"layers": [], "assignments": {}}})
    assert resp.status_code == 200, resp.text
    assert await members_of(db_session, view_id) == before, "no layers stored is no layer deleted"

    resp = await test_client.put(url, json={"referenceLayout": {"layers": [], "assignments": {
        "tbl_a": {"layerId": "s_dash"}, "col_b1": {"layerId": REST_LAYER_ID},
        "tbl_up": {"layerId": "s_tbl", "inheritsChildren": True, "assignedBy": "user"}}}})
    assert resp.status_code == 200, resp.text
    placed = await members_of(db_session, view_id)
    assert {u: e["layerId"] for u, e in placed.items()} == {
        "dom": "s_dom", "tbl_a": "s_dash", "tbl_b": "s_tbl", "col_a1": "s_col", "col_a2": "s_col",
        "col_b1": REST_LAYER_ID}
    config = await made(db_session, view_id)
    assert config["layout"]["referenceLayout"]["layers"] == []
    assert {u: e["layerId"] for u, e in assignments_of(config).items()} == {"tbl_up": "s_tbl"}, (
        "a member is never an entry; an entity people placed is theirs")
    assert {u: o["layerId"] for u, o in config["membership"]["overrides"].items()} == {
        "tbl_a": "s_dash", "col_b1": REST_LAYER_ID}, "remembered"

    nowhere = await test_client.put(url, json={"referenceLayout": {"layers": [], "assignments": {
        "tbl_up": {"layerId": "s_nowhere", "assignedBy": "user"}}}})
    assert nowhere.status_code == 422 and "s_nowhere" in nowhere.json()["detail"]

    assert (await test_client.delete(f"/api/v1/views/{src}")).status_code in (200, 204)
    gone = await test_client.put(url, json={"referenceLayout": {"layers": [], "assignments": {}}})
    assert gone.status_code == 422 and "view it follows" in gone.json()["detail"]
    assert await members_of(db_session, view_id) == placed, "nothing written"


async def test_always_include_in_a_follower_names_a_layer_it_is_served(
    test_client: AsyncClient, db_session, graph, membership_on,
):
    """An entity always included goes in a layer the view is served — "Other matches"
    among them — and is served there beside that view's layers: its own entry, never a
    member. The view it follows gone, there is no layer to include anything in."""
    ws = await workspace(test_client)
    src = await source_view(test_client, ws)
    view_id = await following(test_client, ws, src)
    url = f"/api/v1/views/{view_id}/membership/members"
    nowhere = await test_client.post(url, json={"include": [{"urn": "col_b1", "layerId": "s_nowhere"}]})
    assert (nowhere.status_code, nowhere.json()["detail"]["reason"]) == (422, "invalid_member_ops")

    resp = await test_client.post(url, json={"include": [{"urn": "col_b1", "layerId": "s_dash"},
                                                         {"urn": "tbl_up", "layerId": REST_LAYER_ID}]})
    assert resp.status_code == 200, resp.text
    assert "col_b1" not in await members_of(db_session, view_id)
    assert [l["id"] for l in await served(test_client, view_id)] == [
        "s_dom", "s_tbl", "s_col", "s_dash", REST_LAYER_ID]
    assert await served_entries(test_client, view_id) == {"col_b1": "s_dash", "tbl_up": REST_LAYER_ID}
    assert (await test_client.post(url, json={"exclude": ["col_a1"]})).status_code == 200

    assert (await test_client.delete(f"/api/v1/views/{src}")).status_code in (200, 204)
    gone = await test_client.post(url, json={"include": [{"urn": "col_a2", "layerId": "s_col"}]})
    assert (gone.status_code, gone.json()["detail"]["reason"]) == (422, "invalid_member_ops")
    assert (await test_client.post(url, json={"unexclude": ["col_a1"]})).status_code == 200


async def test_what_people_put_in_a_follower_outlasts_how_the_view_it_follows_places_things(
    test_client: AsyncClient, db_session, graph, membership_on, monkeypatch,
):
    """A member moved by hand stays where it was put however the members are placed again
    — the data moving on, or the view it follows placing things another way — and an
    entity always included stays in its layer. Put in a layer that view then deletes,
    either is in "Other matches" from the next time the view is opened."""
    data = {"version": "v1"}

    async def version(engine):
        return data["version"]

    monkeypatch.setattr(pipeline, "search_data_version", version)
    ws = await workspace(test_client)
    src = await source_view(test_client, ws)
    view_id = await following(test_client, ws, src)
    assert (await test_client.put(f"/api/v1/views/{view_id}/layout", json={"referenceLayout": {
        "layers": [], "assignments": {"tbl_a": {"layerId": "s_dash"}}}})).status_code == 200
    assert (await test_client.post(f"/api/v1/views/{view_id}/membership/members", json={
        "include": [{"urn": "col_b1", "layerId": "s_dash"}]})).status_code == 200

    async def placed() -> dict:
        return {u: e["layerId"] for u, e in (await members_of(db_session, view_id)).items()}

    async def base_layers(layers: list) -> None:
        resp = await test_client.put(f"/api/v1/views/{src}/layout",
                                     json={"referenceLayout": {"layers": layers, "assignments": {}}})
        assert resp.status_code == 200, resp.text

    columns_with_tables = [{**l, "entityTypes": ["table", "column"]} if l["id"] == "s_tbl"
                           else {**l, "entityTypes": []} if l["id"] == "s_col" else l for l in SOURCE_LAYERS]
    await base_layers(columns_with_tables)
    assert (await opened(test_client, db_session, view_id))["outcome"] == "applied"
    assert await placed() == {"dom": "s_dom", "tbl_a": "s_dash", "tbl_b": "s_tbl", "col_a1": "s_tbl",
                              "col_a2": "s_tbl"}, "placed again, and the one moved by hand where it was put"
    assert await served_entries(test_client, view_id) == {"col_b1": "s_dash"}

    data["version"] = "v2"
    assert (await opened(test_client, db_session, view_id))["outcome"] in ("applied", "unchanged")
    assert (await placed())["tbl_a"] == "s_dash", "the data moving on moves it nowhere"

    await base_layers([l for l in columns_with_tables if l["id"] != "s_dash"])
    out = await opened(test_client, db_session, view_id)
    assert (out["outcome"], out["membership"]["status"]) == ("applied", "ok")
    assert (await placed())["tbl_a"] == REST_LAYER_ID
    assert await served_entries(test_client, view_id) == {"col_b1": REST_LAYER_ID}
    assert [l["id"] for l in await served(test_client, view_id)] == ["s_dom", "s_tbl", "s_col", REST_LAYER_ID]


async def test_a_follower_is_out_of_date_once_the_view_it_follows_places_things_another_way(
    test_client: AsyncClient, db_session, graph, membership_on, data, view_portability_enabled,
):
    """Each view made from a query that follows it is pending until it is next opened —
    not a snapshot, not one a run is working out now, and never a subset of it. A rename
    changes nothing; the next open places the members again."""
    from backend.app.db.repositories import view_membership_repo
    from backend.app.db.repositories.view_membership_repo import later_iso

    ws = await workspace(test_client)
    src = await source_view(test_client, ws)
    live = await following(test_client, ws, src)
    running = await following(test_client, ws, src)
    resp = await test_client.post(URL, json=body(ws, src, layout=follow(src), mode="snapshot"))
    assert resp.status_code == 201, resp.text
    snapshot = resp.json()["view"]["id"]
    db_session.add(ViewORM(name="PII in sales", workspace_id=ws, view_type="reference", subset_of=src,
                           config=json.dumps({"search": {"readIn": src, "layout": "inherit"}})))
    await db_session.execute(update(ViewMembershipStateORM).where(ViewMembershipStateORM.view_id == running)
                             .values(status="updating", lease_until=later_iso(300)))
    await db_session.commit()
    assert sorted(await view_membership_repo.followers(db_session, src)) == sorted([live, running, snapshot])

    async def statuses() -> list:
        return [await status_of(db_session, v) for v in (live, running, snapshot)]

    before = await statuses()
    assert [s for s, _ in before] == ["ok", "updating", "frozen"]
    saved = (await test_client.post(f"/api/v1/views/{src}/versions", json={"message": "As it was"})).json()
    renamed = [{**l, "name": "Every table"} if l["id"] == "s_tbl" else l for l in SOURCE_LAYERS]
    assert (await test_client.put(f"/api/v1/views/{src}/layout", json={
        "referenceLayout": {"layers": renamed, "assignments": {}}})).status_code == 200
    assert await statuses() == before, "a rename places nothing another way"

    moved = [{**l, "entityTypes": ["domain", "table"]} if l["id"] == "s_dom"
             else {**l, "entityTypes": []} if l["id"] == "s_tbl" else l for l in renamed]
    assert (await test_client.put(f"/api/v1/views/{src}/layout", json={
        "referenceLayout": {"layers": moved, "assignments": {}}})).status_code == 200
    assert await statuses() == [("pending", {"reason": "base_changed"}), before[1], before[2]]
    status = (await test_client.get(f"/api/v1/views/{live}/membership")).json()
    assert (status["status"], status["detail"]) == ("pending", {"reason": "base_changed"})

    out = await opened(test_client, db_session, live)
    assert (out["outcome"], out["diff"]["moved"], out["membership"]["status"]) == ("applied", 2, "ok")
    assert (await opened(test_client, db_session, live))["detail"] == {"reason": "up_to_date"}

    restored = await test_client.post(f"/api/v1/views/{src}/versions/{saved['version']['version']}/restore")
    assert restored.status_code == 200, restored.text
    assert await status_of(db_session, live) == ("pending", {"reason": "base_changed"}), "a version restored too"
