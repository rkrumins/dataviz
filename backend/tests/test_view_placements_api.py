"""``POST /{ws_id}/graph/view-placements`` — where a view the server places draws each entity.

The canvas asks it for the views it can't place itself: one made from a query (its members
are rows of their own table, its config holds none) and a subset view (its matches are
found by search). Each URN gets a layer and why: its member row (``member``), an entry a
person placed (``entry``), inside something kept whole (``whole``), under the member it
sits in (``inside``), the layout (``layout``), the layer what nothing places waits in
(``fallback``), or nowhere (``none``) — with how many of its containers it is drawn inside
(``inLayer``), and, asked for, its node as its layer's pages list it.

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

    async def _place(ws, view_id, urns, engine=None, **extra):
        engine = engine or CountingEngine()
        engine._db_session = db_session

        async def _engine():
            return engine

        app.dependency_overrides[get_context_engine] = _engine
        try:
            return await test_client.post(f"/api/v1/{ws}/graph/view-placements?viewId={view_id}",
                                          json={"urns": urns, **extra})
        finally:
            app.dependency_overrides.pop(get_context_engine, None)

    return _place


def where(resp) -> dict:
    assert resp.status_code == 200, resp.text
    return {u: (p["layerId"], p["source"]) for u, p in resp.json()["placements"].items()}


def nested(resp) -> dict:
    """Each URN's placement with how many of its containers it is drawn inside."""
    assert resp.status_code == 200, resp.text
    return {u: (p["layerId"], p["source"], p["inLayer"]) for u, p in resp.json()["placements"].items()}


TYPE_LAYERS = [{"id": "c_dom", "name": "Domains", "entityTypes": ["domain"]},
               {"id": "c_tbl", "name": "Tables", "entityTypes": ["table"]},
               {"id": "c_col", "name": "Columns", "entityTypes": ["column"]}]


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


async def test_inside_a_member_it_is_drawn_under_it_in_its_layer(
    test_client: AsyncClient, db_session, graph, membership_on, place,
):
    """What sits inside a member, and is no member itself, is drawn under the nearest
    member it is in — in that member's layer, not where its type would go — nested in
    each container between (``inLayer``). Kept out, it is placed by the layout. An entry
    of a person's own, and a container kept whole, still come first."""
    ws = await workspace(test_client)
    view_id = await make(test_client, ws, "", layers=TYPE_LAYERS, layout={"kind": "custom"},
                         sources=[{"spec": {"seeds": {"urns": ["dom", "tbl_up"]}}}], exclude=["col_b1"])

    def people(config):
        config["layout"]["referenceLayout"]["assignments"] = {
            "col_a2": {"layerId": "c_col", "inheritsChildren": False, "assignedBy": "user"},
        }
    await write_config(db_session, view_id, people)
    assert nested(await place(ws, view_id, ["dom", "tbl_a", "col_a1", "col_a2", "col_b1", "col_up", "src1"])) == {
        "dom": ("c_dom", "member", 0),
        "tbl_a": ("c_dom", "inside", 1),          # under dom, in its layer: not with the tables
        "col_a1": ("c_dom", "inside", 2),         # under tbl_a, under dom
        "col_a2": ("c_col", "entry", 0),          # a person's own entry comes first
        "col_b1": ("c_col", "layout", 0),         # kept out: where its type goes
        "col_up": ("c_tbl", "inside", 1),
        "src1": (None, "none", None),
    }

    # tbl_up kept whole: what is inside it comes with it.
    await db_session.execute(update(ViewMemberORM).where(ViewMemberORM.view_id == view_id,
                                                         ViewMemberORM.urn == "tbl_up").values(whole=True))
    await db_session.commit()
    assert nested(await place(ws, view_id, ["col_up"]))["col_up"] == ("c_tbl", "whole", 1)


async def test_a_members_nesting_is_its_rows(test_client: AsyncClient, db_session, graph, membership_on, place):
    """A member says what its row says (the run counted it); moved by a person to another
    layer, it is counted there."""
    ws = await workspace(test_client)
    view_id = await make(test_client, ws, "", layers=TYPE_LAYERS, layout={"kind": "custom"},
                         sources=[{"spec": {"seeds": {"urns": ["dom"]}, "expand": {"children": 2}}}])
    await db_session.execute(update(ViewMemberORM).where(ViewMemberORM.view_id == view_id,
                                                         ViewMemberORM.urn == "col_a1").values(in_layer=7))
    await db_session.commit()

    def moved(config):
        config["membership"]["overrides"] = {"col_a2": {"layerId": "c_dom", "at": "2026-01-01T00:00:00+00:00"}}
    await write_config(db_session, view_id, moved)
    placed = nested(await place(ws, view_id, ["col_a1", "col_a2", "tbl_a"]))
    assert placed["col_a1"] == ("c_col", "member", 7)
    assert placed["col_a2"] == ("c_dom", "member", 0), "tbl_a is drawn with the tables, not in Domains"
    assert placed["tbl_a"][:2] == ("c_tbl", "member")


async def test_with_nodes_each_one_drawn_comes_as_its_layer_lists_it(
    test_client: AsyncClient, db_session, graph, membership_on, place,
):
    ws = await workspace(test_client)
    view_id = await make(test_client, ws, "", layers=[*TYPE_LAYERS, {"id": "c_rest", "name": "Rest", "entityTypes": []}],
                         layout={"kind": "custom", "fallbackLayerId": "c_rest"},
                         sources=[{"spec": {"seeds": {"urns": ["dom"]}}}])
    resp = await place(ws, view_id, ["col_a1", "dom", "src1", "urn:nowhere"], nodes=True)
    assert nested(resp) == {"col_a1": ("c_dom", "inside", 2), "dom": ("c_dom", "member", 0),
                            "src1": ("c_rest", "fallback", 0), "urn:nowhere": ("c_rest", "fallback", 0)}
    nodes = resp.json()["nodes"]
    assert set(nodes) == {"col_a1", "dom", "src1"}, "one the graph doesn't hold has no node"
    assert nodes["col_a1"] == {
        **{k: v for k, v in nodes["col_a1"].items() if k not in ("ancestorPath", "inLayer")},
        "urn": "col_a1", "displayName": "col_a1", "entityType": "column", "inLayer": 2,
        "ancestorPath": [{"urn": "dom", "displayName": "dom", "entityType": "domain"},
                         {"urn": "tbl_a", "displayName": "tbl_a", "entityType": "table"}],
    }
    assert nodes["dom"]["ancestorPath"] == [] and "inLayer" not in nodes["dom"]

    # The same shape a layer's page lists: the member's node, entry for entry.
    from backend.app.api.v1.endpoints.graph import get_context_engine
    from backend.app.main import app

    engine = TypedEngine()
    engine._db_session = db_session
    app.dependency_overrides[get_context_engine] = lambda: engine
    try:
        page = (await test_client.post(f"/api/v1/{ws}/graph/view-members?viewId={view_id}",
                                       json={"layerId": "c_dom"})).json()
    finally:
        app.dependency_overrides.pop(get_context_engine, None)
    assert page["nodes"] == [nodes["dom"]]
    assert (await place(ws, view_id, ["dom"])).json()["nodes"] is None, "asked without nodes: none"


async def test_nodes_for_at_most_five_hundred(test_client: AsyncClient, db_session, graph, membership_on, place):
    ws = await workspace(test_client)
    view_id = await make(test_client, ws, await source_view(test_client, ws))
    over = await place(ws, view_id, [f"u{i}" for i in range(501)], nodes=True)
    assert (over.status_code, over.json()["detail"]["reason"]) == (422, "too_many_nodes")
    assert len(where(await place(ws, view_id, [f"u{i}" for i in range(500)], nodes=True))) == 500
    assert len(where(await place(ws, view_id, [f"u{i}" for i in range(501)]))) == 501


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


async def test_a_subset_says_what_its_matches_are_drawn_inside(
    test_client: AsyncClient, db_session, subsets_on, place,
):
    ws = await workspace(test_client)
    src = await source_view(test_client, ws)
    by_type = await subset(test_client, ws, src, layout="own", rest="Everything else",
                           layers=[{"name": "Data", "entityTypes": ["table", "column"]}])
    placed = nested(await place(ws, by_type, ["col_a1", "tbl_a", "dom"]))
    assert {u: p[2] for u, p in placed.items()} == {"col_a1": 1, "tbl_a": 0, "dom": 0}, \
        "a column under its table, both of the layer's types; the domain in another"
    following_base = await subset(test_client, ws, src)
    placed = nested(await place(ws, following_base, ["col_a1", "tbl_a"]))
    assert placed == {"col_a1": ("s_col", "layout", 0), "tbl_a": ("s_tbl", "layout", 0)}


# ── A subset of a view made from a query: placed by its base's member rows ──


async def _subset_of_list(test_client: AsyncClient, db_session):
    """A view made from a query — ``dom`` and ``tbl_up`` its members, in layers by type —
    and its scope as a subset of it resolves it, the tables' layer hidden."""
    from types import SimpleNamespace

    from backend.app.services.search_views import layers_of
    from backend.app.services.view_scope import MemberLayers

    ws = await workspace(test_client)
    base = await make(test_client, ws, "", layers=TYPE_LAYERS, layout={"kind": "custom"},
                      sources=[{"spec": {"seeds": {"urns": ["dom", "tbl_up"]}}}])
    epoch = (await db_session.execute(select(ViewMembershipStateORM.members_epoch).where(
        ViewMembershipStateORM.view_id == base))).scalar_one()
    shown = [layer for layer in layers_of(await made(db_session, base), add_rest=True) if layer.id != "c_tbl"]
    eff = SimpleNamespace(scope_hash="boundary", subset_layers=tuple(shown), subset_placement=None,
                          subset_members=MemberLayers(view_id=base, epoch=epoch))
    return base, epoch, eff


async def test_a_subset_of_a_view_made_from_a_query_is_placed_by_its_members(
    test_client: AsyncClient, db_session, graph, membership_on,
):
    """Each shown layer holds what its base draws there — its members, its entries and
    what is inside its members, under them — and "Other matches" the rest; what the base
    draws in a layer the subset hides is nowhere."""
    from backend.app.services.live_views import where as served

    base, epoch, eff = await _subset_of_list(test_client, db_session)

    def people(config):
        config["layout"]["referenceLayout"]["assignments"] = {
            "src2": {"layerId": "c_col", "inheritsChildren": True, "assignedBy": "user"}}
    await write_config(db_session, base, people)
    engine = TypedEngine()
    engine._db_session = db_session
    placed = await served.place_in_subset(
        engine, eff, ["dom", "tbl_a", "col_a1", "tbl_up", "col_up", "src2", "src1"], session=db_session)
    assert placed == {
        "dom": ("c_dom", "member", 0),
        "tbl_a": ("c_dom", "inside", 1),
        "col_a1": ("c_dom", "inside", 2),
        "tbl_up": (None, "none", None),          # its layer is hidden here
        "col_up": (None, "none", None),          # and so is what is inside it
        "src2": ("c_col", "entry", 0),
        "src1": ("other-matches", "fallback", 0),
    }

    # Its base's answer is in what decides placing, so a cached answer turns over.
    later = type(eff)(**{**vars(eff), "subset_members": type(eff.subset_members)(view_id=base, epoch=epoch + 1)})
    assert served.subset_digest(later) != served.subset_digest(eff)
    with pytest.raises(ValueError):
        await served.place_in_subset(engine, eff, ["dom"])


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
    assert set(params) == {"view", "epoch", "updated_at", "digest", "urns", "nodes", "data_version"}
    assert params["view"] == view_id and params["epoch"] is not None and params["nodes"] is False
    with_nodes = CountingEngine()
    await place(ws, view_id, ["tbl_up", "dom"], with_nodes, nodes=True)
    assert with_nodes.reads and cache.asked[-1][1]["nodes"] is True, "with nodes: an answer of its own"

    # The view's members worked out again (to none, here): another answer.
    await db_session.execute(update(ViewMembershipStateORM).where(ViewMembershipStateORM.view_id == view_id)
                             .values(members_epoch=ViewMembershipStateORM.members_epoch + 1))
    await db_session.commit()
    later = CountingEngine()
    assert where(await place(ws, view_id, ["dom"], later))["dom"][1] == "layout"
    assert later.reads and cache.asked[-1][1]["epoch"] == params["epoch"] + 1
