"""``POST /{ws_id}/graph/view-placements`` — where a view the server places draws each entity.

The trace overlay asks it for the views it can't place itself: one made from a query (its
members are rows of their own table, its config holds none) and a subset view (its matches
are found by search). Each URN gets a layer and why: its member row (``member``), an entry
a person placed (``entry``), inside something kept whole (``whole``), the layout
(``layout``), the layer what nothing places waits in (``fallback``), or nowhere (``none``).

The graph is ``fixtures/membership_graph``: ``dom ⊃ tbl_a ⊃ {col_a1, col_a2}``,
``dom ⊃ tbl_b ⊃ col_b1``, ``tbl_up ⊃ col_up``, lineage ``src3 → src2 → src1 → col_a1 →
rep1 → rep2``; ``dom`` a domain, ``tbl_*`` tables, ``col_*`` columns, the rest things.
"""
from __future__ import annotations

import json

import pytest
from fastapi import Request
from httpx import AsyncClient
from sqlalchemy import delete, select, update

from backend.app.api.v1.endpoints import graph_view_placements as route
from backend.app.db.models import ViewMemberORM, ViewMembershipStateORM, ViewORM
from backend.app.services.graph_cache import CacheScope
from backend.tests.test_views_from_members_api import (  # noqa: F401 — fixtures
    SOURCE_LAYERS,
    URL,
    TypedEngine,
    body,
    flags,
    following,
    graph,
    made,
    membership_on,
    source_view,
    workspace,
)


class CountingEngine(TypedEngine):
    """The fake graph, counting the statements a placement reads."""

    def __init__(self, *args, **kwargs):
        super().__init__(*args, **kwargs)
        self.reads = 0

    async def get_nodes_query(self, query):
        self.reads += 1
        return await super().get_nodes_query(query)

    async def get_ancestor_chains(self, urns):
        self.reads += 1
        return await super().get_ancestor_chains(urns)


@pytest.fixture()
def place(test_client: AsyncClient, db_session):
    """POST the URNs for view ``view_id``; the graph read is ``engine`` (a fresh one by default)."""
    from backend.app.api.v1.endpoints.graph import get_context_engine
    from backend.app.main import app

    async def _place(ws, view_id, urns, engine=None):
        engine = engine or CountingEngine()
        engine._db_session = db_session

        async def _engine():
            return engine

        app.dependency_overrides[get_context_engine] = _engine
        try:
            return await test_client.post(f"/api/v1/{ws}/graph/view-placements?viewId={view_id}",
                                          json={"urns": urns})
        finally:
            app.dependency_overrides.pop(get_context_engine, None)

    return _place


def where(resp) -> dict:
    assert resp.status_code == 200, resp.text
    return {u: (p["layerId"], p["source"]) for u, p in resp.json()["placements"].items()}


async def make(client: AsyncClient, ws: str, src: str, **overrides) -> str:
    resp = await client.post(URL, json=body(ws, src, **overrides))
    assert resp.status_code == 201, resp.text
    return resp.json()["view"]["id"]


async def layer_ids(db_session, view_id: str) -> dict:
    """The view's own layers: the source layer each was copied from (or its name) → its id."""
    layers = (await made(db_session, view_id))["layout"]["referenceLayout"]["layers"]
    return {l.get("linkLayerId") or l["name"]: l["id"] for l in layers}


async def write_config(db_session, view_id: str, change) -> None:
    row = (await db_session.execute(select(ViewORM).where(ViewORM.id == view_id))).scalar_one()
    config = json.loads(row.config)
    change(config)
    row.config = json.dumps(config)
    await db_session.commit()


# ── Views made from a query ─────────────────────────────────────────────────


async def test_like_a_view_members_and_what_its_source_view_places(
    test_client: AsyncClient, db_session, graph, membership_on, place,
):
    ws = await workspace(test_client)
    src = await source_view(test_client, ws)
    view_id = await make(test_client, ws, src)
    ids = await layer_ids(db_session, view_id)
    state = (await db_session.execute(select(ViewMembershipStateORM).where(
        ViewMembershipStateORM.view_id == view_id))).scalar_one()

    resp = await place(ws, view_id, ["col_a1", "tbl_up", "col_up", "src1", "col_a1"])
    assert where(resp) == {
        "col_a1": (ids["s_col"], "member"),
        "tbl_up": (ids["s_tbl"], "layout"),       # where the view it was made from places a table
        "col_up": (ids["s_col"], "layout"),
        "src1": (None, "none"),                   # nothing places a thing, and it has no fallback
    }, "each URN once, in the order asked"
    assert list(resp.json()["placements"]) == ["col_a1", "tbl_up", "col_up", "src1"]
    assert resp.json()["epoch"] == state.members_epoch and resp.json()["digest"]


@pytest.mark.parametrize("kind", ["custom", "template"])
async def test_every_reason_an_entity_is_where_it_is(
    test_client: AsyncClient, db_session, graph, membership_on, place, kind,
):
    """A member (moved by a person: where they put it), an entry a person placed, inside
    a member kept whole or an entry that brings its insides, the layout — its own layers'
    rules — and the fallback."""
    ws = await workspace(test_client)
    layers = [{"id": "c_tbl", "name": "Tables", "entityTypes": ["table"]},
              {"id": "c_col", "name": "Columns", "entityTypes": ["column"]},
              {"id": "c_rest", "name": "Everything else", "entityTypes": []}]
    view_id = await make(test_client, ws, "", layers=layers, layout={
        "kind": kind, "fallbackLayerId": "c_rest", **({"templateId": "tpl-1"} if kind == "template" else {})})
    # tbl_b kept whole, col_b1 no longer a row of its own: it comes with it.
    await db_session.execute(update(ViewMemberORM).where(ViewMemberORM.view_id == view_id,
                                                         ViewMemberORM.urn == "tbl_b").values(whole=True))
    await db_session.execute(delete(ViewMemberORM).where(ViewMemberORM.view_id == view_id,
                                                         ViewMemberORM.urn == "col_b1"))

    def people(config):
        config["layout"]["referenceLayout"]["assignments"] = {
            "rep1": {"layerId": "c_tbl", "inheritsChildren": False, "assignedBy": "user"},
            "tbl_up": {"layerId": "c_rest", "inheritsChildren": True, "assignedBy": "user"},
        }
        config["membership"]["overrides"] = {"col_a2": {"layerId": "c_rest", "at": "2026-01-01T00:00:00+00:00"}}
    await write_config(db_session, view_id, people)

    assert where(await place(ws, view_id, ["col_a1", "col_a2", "rep1", "col_b1", "col_up", "tbl_a", "rep2"])) == {
        "col_a1": ("c_col", "member"),
        "col_a2": ("c_rest", "member"),           # where a person moved it
        "rep1": ("c_tbl", "entry"),
        "col_b1": ("c_tbl", "whole"),             # inside tbl_b, kept whole
        "col_up": ("c_rest", "whole"),            # inside an entry that brings its insides
        "tbl_a": ("c_tbl", "member"),
        "rep2": ("c_rest", "fallback"),           # no layer's rule places a thing
    }


async def test_following_a_view_where_that_view_places_it(
    test_client: AsyncClient, db_session, graph, membership_on, place,
):
    ws = await workspace(test_client)
    src = await source_view(test_client, ws)
    view_id = await following(test_client, ws, src)
    assert where(await place(ws, view_id, ["tbl_a", "tbl_up", "col_up", "src1"])) == {
        "tbl_a": ("s_tbl", "member"),
        "tbl_up": ("s_tbl", "layout"),
        "col_up": ("s_col", "layout"),
        "src1": ("other-matches", "fallback"),    # what it places nowhere, in "Other matches"
    }

    assert (await test_client.delete(f"/api/v1/views/{src}")).status_code in (200, 204)
    gone = await place(ws, view_id, ["tbl_a"])
    assert (gone.status_code, gone.json()["detail"]["reason"]) == (409, "base_missing")


async def test_by_top_level_type_and_by_lineage_stage(
    test_client: AsyncClient, db_session, graph, membership_on, place,
):
    ws = await workspace(test_client)
    by_type = await make(test_client, ws, "", layout={"kind": "auto"}, exclude=["col_b1"])
    domains = (await layer_ids(db_session, by_type))["Domains"]
    assert where(await place(ws, by_type, ["tbl_a", "col_b1", "col_up"])) == {
        "tbl_a": (domains, "member"),
        "col_b1": (domains, "layout"),            # kept out, but its top-level container is a domain
        "col_up": (None, "none"),                 # under a table: no layer holds tables here
    }

    stages = await make(test_client, ws, "", layout={"kind": "stages", "nest": False}, sources=[
        {"spec": {"seeds": {"urns": ["col_a1"]}, "expand": {"upstream": 1, "downstream": 1}}}])
    engine = CountingEngine()
    assert where(await place(ws, stages, ["src1", "col_a1", "rep2", "tbl_a"], engine)) == {
        "src1": ("stage-up1", "member"), "col_a1": ("stage-seed", "member"),
        "rep2": (None, "none"), "tbl_a": (None, "none"),   # a stage holds only what the view does
    }
    assert engine.reads == 1, "the chains alone: a stage places nothing it doesn't hold"


async def test_a_member_is_where_its_layer_feed_serves_it(
    test_client: AsyncClient, db_session, graph, membership_on, place,
):
    """Parity: every member's placement is the layer whose feed lists it."""
    from backend.app.api.v1.endpoints.graph import get_context_engine
    from backend.app.main import app

    ws = await workspace(test_client)
    src = await source_view(test_client, ws)
    view_id = await make(test_client, ws, src, keep="all")
    fed = {}
    engine = TypedEngine()
    engine._db_session = db_session

    async def _engine():
        return engine

    app.dependency_overrides[get_context_engine] = _engine
    try:
        for layer in (await made(db_session, view_id))["layout"]["referenceLayout"]["layers"]:
            page = await test_client.post(f"/api/v1/{ws}/graph/view-members?viewId={view_id}",
                                          json={"layerId": layer["id"], "limit": 500})
            assert page.status_code == 200, page.text
            fed.update({n["urn"]: layer["id"] for n in page.json()["nodes"]})
    finally:
        app.dependency_overrides.pop(get_context_engine, None)
    assert len(fed) == 6
    placed = where(await place(ws, view_id, sorted(fed)))
    assert {u: layer for u, (layer, _source) in placed.items()} == fed
    assert {source for _layer, source in placed.values()} == {"member"}


# ── Subset views ───────────────────────────────────────────────────────────


@pytest.fixture()
def subsets_on():
    flags(searchViewsEnabled=True)
    yield
    flags(searchViewsEnabled=False)


async def subset(client: AsyncClient, ws: str, base: str, **over) -> str:
    resp = await client.post("/api/v1/views/from-search", json={
        "name": "Tagged", "workspaceId": ws, "predicate": {"kind": "tag", "values": ["pii"]}, "readIn": base,
        **over})
    assert resp.status_code == 201, resp.text
    return resp.json()["view"]["id"]


async def test_a_subset_that_follows_its_base_places_as_the_base_does(
    test_client: AsyncClient, db_session, subsets_on, place,
):
    ws = await workspace(test_client)
    src = await source_view(test_client, ws)
    hand = {"tbl_b": {"layerId": "s_dash", "assignedBy": "user"}}
    assert (await test_client.put(f"/api/v1/views/{src}/layout", json={
        "referenceLayout": {"layers": SOURCE_LAYERS, "assignments": hand}})).status_code == 200
    view_id = await subset(test_client, ws, src, hiddenLayers=["s_dom"])
    assert where(await place(ws, view_id, ["tbl_a", "tbl_b", "col_b1", "dom", "src1"])) == {
        "tbl_a": ("s_tbl", "layout"),
        "tbl_b": ("s_dash", "layout"),            # by hand in the base
        "col_b1": ("s_dash", "layout"),           # inside it, as the base's canvas draws it
        "dom": (None, "none"),                    # its layer is hidden here
        "src1": ("other-matches", "fallback"),
    }
    assert (await test_client.delete(f"/api/v1/views/{src}")).status_code in (200, 204)
    gone = await place(ws, view_id, ["tbl_a"])
    assert (gone.status_code, gone.json()["detail"]["reason"]) == (409, "base_missing")


async def test_a_subset_with_its_own_layers_places_by_type(
    test_client: AsyncClient, db_session, subsets_on, place,
):
    ws = await workspace(test_client)
    src = await source_view(test_client, ws)
    view_id = await subset(test_client, ws, src, layout="own",
                           layers=[{"name": "Tables", "entityTypes": ["table"]}], rest="Everything else")
    stored = (await made(db_session, view_id))["layout"]["referenceLayout"]["layers"]
    tables, rest = (next(l["id"] for l in stored if l["name"] == n) for n in ("Tables", "Everything else"))
    assert where(await place(ws, view_id, ["tbl_up", "col_up"])) == {
        "tbl_up": (tables, "layout"), "col_up": (rest, "fallback")}
    no_rest = await subset(test_client, ws, src, layout="own",
                           layers=[{"name": "Tables", "entityTypes": ["table"]}], rest=None)
    assert where(await place(ws, no_rest, ["col_up"])) == {"col_up": (None, "none")}


# ── Refusals, links and the cache ──────────────────────────────────────────


async def test_refusals(test_client: AsyncClient, db_session, graph, membership_on, place):
    ws = await workspace(test_client)
    src = await source_view(test_client, ws)
    ordinary = await place(ws, src, ["dom"])
    assert (ordinary.status_code, ordinary.json()["detail"]["reason"]) == (422, "not_served_view")
    view_id = await make(test_client, ws, src)
    assert (await place(ws, view_id, [f"u{i}" for i in range(2001)])).status_code == 422
    assert (await place(ws, view_id, [])).status_code == 422
    missing = await place(ws, "view-nowhere", ["dom"])
    assert (missing.status_code, missing.json()["detail"]["reason"]) == (404, "view_not_found")
    assert len(where(await place(ws, view_id, [f"u{i}" for i in range(2000)]))) == 2000


async def test_a_link_places_in_its_own_view_only(test_client: AsyncClient, db_session, graph, membership_on, place):
    from backend.app.api.v1.endpoints.graph import _view_reader
    from backend.app.main import app

    ws = await workspace(test_client)
    view_id = await make(test_client, ws, await source_view(test_client, ws))

    def link(to: str, readable: bool):
        def reader(request: Request):
            request.state.view_capability = to

            async def can_read(_view):
                return readable
            return can_read
        return reader

    try:
        app.dependency_overrides[_view_reader] = link("view-somewhere-else", True)
        other = await place(ws, view_id, ["dom"])
        assert (other.status_code, other.json()["detail"]["reason"]) == (403, "link_other_view")
        app.dependency_overrides[_view_reader] = link(view_id, False)
        unread = await place(ws, view_id, ["dom"])
        assert (unread.status_code, unread.json()["detail"]["reason"]) == (404, "view_not_found")
        app.dependency_overrides[_view_reader] = link(view_id, True)
        assert where(await place(ws, view_id, ["dom"]))["dom"][1] == "member"
    finally:
        app.dependency_overrides.pop(_view_reader, None)


async def test_an_answer_is_cached_under_what_decides_it(
    test_client: AsyncClient, db_session, graph, membership_on, place, monkeypatch,
):
    class Cache:
        def __init__(self):
            self.kept, self.asked = {}, []

        async def get_or_compute(self, *, scope, endpoint, params, compute, model_cls, **_):
            self.asked.append((endpoint, params))
            key = json.dumps(params, sort_keys=True, default=str)
            if key not in self.kept:
                self.kept[key] = await compute()
            return self.kept[key]

    cache = Cache()
    monkeypatch.setattr(route, "get_graph_cache", lambda: cache)
    monkeypatch.setattr(route, "_cache_scope", lambda engine: CacheScope(workspace_id="w", data_source_id="d"))
    ws = await workspace(test_client)
    view_id = await make(test_client, ws, await source_view(test_client, ws))

    first, again = CountingEngine(), CountingEngine()
    assert where(await place(ws, view_id, ["tbl_up", "dom"], first)) == where(
        await place(ws, view_id, ["dom", "tbl_up", "dom"], again))
    assert first.reads and again.reads == 0, "the same URNs, however asked: one answer"
    endpoint, params = cache.asked[0]
    assert endpoint == "view.placements"
    assert set(params) == {"view", "epoch", "updated_at", "digest", "urns", "data_version"}
    assert params["view"] == view_id and params["epoch"] is not None

    # The view's members worked out again (to none, here): another answer.
    await db_session.execute(update(ViewMembershipStateORM).where(ViewMembershipStateORM.view_id == view_id)
                             .values(members_epoch=ViewMembershipStateORM.members_epoch + 1))
    await db_session.commit()
    later = CountingEngine()
    assert where(await place(ws, view_id, ["dom"], later))["dom"][1] == "layout"
    assert later.reads and cache.asked[-1][1]["epoch"] == params["epoch"] + 1
