"""``POST /{ws_id}/graph/search/view-feed`` — a page of one layer of a subset view.

What it reads is the view's own: its base's scope, its search, the layer's types.
It answers from what is already there before it scans; a scan takes the lane and a
fair-share token; with the lane full a recent answer serves, else a 429; and a page
is shared through the graph cache by everyone asking the same question.
"""
from __future__ import annotations

import json
import time
from datetime import datetime, timezone

import fakeredis.aioredis
import pytest
from httpx import AsyncClient

from backend.app.api.v1.endpoints import graph_view_feed as feed
from backend.app.db.models import ViewORM
from backend.app.services import graph_cache as graph_cache_mod
from backend.app.services.deep_search import NothingReusable, get_deep_search_settings
from backend.app.services.feature_flags import feature_flags
from backend.common.models.graph import GraphNode
from backend.app.services.view_placement import NodeFacts
from backend.common.models.search import AncestorRef, EntityTypePredicate, LayerPredicate, \
    SearchHit, SearchResultPage, TagPredicate
from backend.common.models.search_view import REST_LAYER_ID, SubsetLayer, ViewFeedPage

TABLES = SubsetLayer(id="t", name="Tables", entityTypes=["table"])

BASE = {
    "layoutType": "reference", "content": {"entityScope": "all"},
    "layout": {"referenceLayout": {"layers": [
        {"id": "t", "name": "Tables", "order": 0, "entityTypes": ["table"]},
        {"id": "d", "name": "Dashboards", "order": 1, "entityTypes": ["dashboard"]},
    ], "assignments": {}}},
}


def _flags(**values):
    feature_flags._cache = {**(feature_flags._cache or {}), **values}
    feature_flags._cache_ts = time.monotonic()


def _subset(base_id):
    return {"layoutType": "reference", "content": {"entityScope": "all"},
            "layout": {"referenceLayout": {"layers": [], "assignments": {}}},
            "search": {"v": 1, "predicate": {"kind": "tag", "values": ["pii"]},
                       "within": "view", "readIn": base_id, "layout": "inherit"}}


def _placed(p):
    """A layer filter resolved against the base: the layer its placement names
    (None: any of the base's layers)."""
    assert isinstance(p, LayerPredicate) and p._placement is not None, p
    return p._placement.layer_id


def _hits(n, prefix="n"):
    return [SearchHit(node=GraphNode(urn=f"urn:{prefix}{i}", displayName=f"{prefix}{i}",
                                     entityType="table"),
                      ancestor_path=[AncestorRef(urn="urn:db", display_name="db", entity_type="db")])
            for i in range(n)]


class FeedProvider:
    """The engine's session search, scripted: ``there`` answers a probe (no scan);
    ``scanned`` answers a scan."""
    supports_search_sessions = True

    def __init__(self):
        self.calls = []
        self.there = None
        self.scanned = SearchResultPage(hits=_hits(3), total_count=3, candidate_count=3,
                                        status="complete", session_id="s1", elapsed_ms=1)
        # A scan in flight, as it stands: what answers when no slot is free.
        self.standing = SearchResultPage(hits=_hits(1), total_count=1, candidate_count=1,
                                         status="running", session_id="s1", elapsed_ms=1)
        self.waiting = None

    async def deep_search_session(self, query, *, context):
        self.calls.append((query, context))
        if not context.scan:
            if self.there is None:
                raise NothingReusable("q")
            return self.there
        if self.waiting:
            # Another request holds the scan's lease: this one waits on its commit.
            return self.waiting
        # As the engine does: the request moving the scan on takes the slot.
        async with context.slot() as moving:
            if not moving:
                return self.standing
            return self.scanned


class FeedEngine:
    def __init__(self, provider=None, *, workspace=None):
        self.provider = provider or FeedProvider()
        self._workspace_id = workspace
        self._data_source_id = "ds1" if workspace else None


@pytest.fixture()
def on():
    _flags(searchViewsEnabled=True)
    yield
    _flags(searchViewsEnabled=False)


@pytest.fixture()
def views(db_session, test_client):
    async def make(*, base_config=BASE, deleted=False):
        resp = await test_client.post("/api/v1/admin/workspaces", json={"name": "Feed WS", "dataSources": []})
        ws = resp.json()["id"]
        base = ViewORM(name="Base", workspace_id=ws, data_source_id=None, view_type="reference",
                       config=json.dumps(base_config), visibility="workspace",
                       deleted_at="2026-01-01" if deleted else None)
        db_session.add(base)
        await db_session.flush()
        sub = ViewORM(name="PII", workspace_id=ws, data_source_id=None, view_type="reference",
                      config=json.dumps(_subset(base.id)), visibility="workspace")
        plain = ViewORM(name="Plain", workspace_id=ws, data_source_id=None, view_type="reference",
                        config=json.dumps(BASE), visibility="workspace")
        db_session.add_all([sub, plain])
        await db_session.commit()
        return ws, base, sub, plain
    return make


@pytest.fixture()
def post(test_client: AsyncClient, db_session):
    from backend.app.api.v1.endpoints.graph import get_context_engine
    from backend.app.main import app

    async def _post(ws, view_id, body, engine):
        engine._db_session = db_session

        async def _override():
            return engine

        app.dependency_overrides[get_context_engine] = _override
        try:
            return await test_client.post(
                f"/api/v1/{ws}/graph/search/view-feed?viewId={view_id}", json=body)
        finally:
            app.dependency_overrides.pop(get_context_engine, None)

    return _post


@pytest.fixture()
def charged(monkeypatch):
    seen = []

    async def charge(engine, endpoint):
        seen.append(endpoint)

    monkeypatch.setattr(feed, "_enforce_fair_share", charge)
    return seen


class TestRefusals:
    async def test_the_preview_off_refuses(self, views, post):
        _flags(searchViewsEnabled=False)
        ws, _base, sub, _plain = await views()
        resp = await post(ws, sub.id, {"layerId": "t"}, FeedEngine())
        assert resp.status_code == 403
        assert resp.json()["detail"]["feature"] == "searchViewsEnabled"

    async def test_only_a_subset_view_has_a_feed(self, on, views, post):
        ws, _base, _sub, plain = await views()
        resp = await post(ws, plain.id, {"layerId": "t"}, FeedEngine())
        assert resp.status_code == 409 and resp.json()["detail"]["reason"] == "not_a_subset"

    async def test_a_layer_it_has_not(self, on, views, post):
        ws, _base, sub, _plain = await views()
        resp = await post(ws, sub.id, {"layerId": "nope"}, FeedEngine())
        assert resp.status_code == 404

    async def test_a_base_gone_is_a_conflict_never_a_wider_search(self, on, views, post):
        ws, _base, sub, _plain = await views(deleted=True)
        engine = FeedEngine()
        resp = await post(ws, sub.id, {"layerId": "t"}, engine)
        assert resp.status_code == 409 and resp.json()["detail"]["reason"] == "base_missing"
        assert engine.provider.calls == []


class TestAnswers:
    async def test_the_layer_is_the_views_search_placed_as_its_base_places(self, on, views, post,
                                                                            charged):
        ws, _base, sub, _plain = await views()
        engine = FeedEngine()
        resp = await post(ws, sub.id, {"layerId": "t", "waitMs": 2500}, engine)
        assert resp.status_code == 200, resp.text
        query, context = engine.provider.calls[-1]
        placed, pii = query.predicate.children
        assert _placed(placed) == "t" and pii == TagPredicate(values=["pii"])
        # Placed as the base places them, a layer can hold any type the base does.
        assert query.scope.entity_types == ["dashboard", "table"]
        assert query.scope.scope_mode == "view"
        options = query.options
        assert (options.page_size, options.sort, options.sort_dir) == (200, "displayName", "asc")
        assert options.include_ancestor_path and options.wait_ms == 2500
        page = resp.json()
        assert [n["urn"] for n in page["nodes"]] == ["urn:n0", "urn:n1", "urn:n2"]
        assert page["nodes"][0]["ancestorPath"][0]["urn"] == "urn:db"
        assert page["totalCount"] == 3 and page["status"] == "complete" and not page["capped"]

    async def test_a_hidden_layer_has_no_feed(self, on, views, post, db_session):
        ws, _base, sub, _plain = await views()
        config = json.loads(sub.config)
        config["search"]["hiddenLayers"] = ["t"]
        sub.config = json.dumps(config)
        await db_session.commit()
        resp = await post(ws, sub.id, {"layerId": "t"}, FeedEngine())
        assert resp.status_code == 404

    async def test_what_is_there_answers_without_a_scan(self, on, views, post, charged):
        ws, _base, sub, _plain = await views()
        engine = FeedEngine()
        engine.provider.there = SearchResultPage(
            hits=_hits(1), total_count=1, status="complete", stale=True,
            as_of=datetime.now(timezone.utc).isoformat(), session_id="old", elapsed_ms=1)
        page = (await post(ws, sub.id, {"layerId": "t"}, engine)).json()
        assert len(engine.provider.calls) == 1 and engine.provider.calls[0][1].scan is False
        assert engine.provider.calls[0][1].reuse_s == get_deep_search_settings().view_feed_reuse_seconds
        assert page["stale"] and page["asOf"] and charged == []

    async def test_nothing_there_scans_in_the_lane_charging_the_share(self, on, views, post, charged):
        ws, _base, sub, _plain = await views()
        engine = FeedEngine()
        await post(ws, sub.id, {"layerId": "t"}, engine)
        assert [c.scan for _q, c in engine.provider.calls] == [False, True]
        assert charged == ["view-feed"]

    async def test_continuing_a_running_scan_moves_it_on(self, on, views, post, charged):
        ws, _base, sub, _plain = await views()
        engine = FeedEngine()
        await post(ws, sub.id, {"layerId": "t", "sessionId": "s1"}, engine)
        assert [c.scan for _q, c in engine.provider.calls] == [True]
        assert engine.provider.calls[0][0].options.session_id == "s1"
        assert charged == ["view-feed"], "moving a scan on takes a slot and a token"

    async def test_waiting_on_another_requests_scan_holds_no_slot(self, on, views, post, charged):
        # Hundreds reading a scan in flight: only the one holding its lease is in a slot.
        ws, _base, sub, _plain = await views()
        engine = FeedEngine()
        engine.provider.waiting = engine.provider.standing
        page = (await post(ws, sub.id, {"layerId": "t", "sessionId": "s1"}, engine)).json()
        assert page["status"] == "running" and charged == []

    async def test_a_scan_in_flight_with_no_slot_free_answers_as_it_stands(self, on, views, post,
                                                                          charged, monkeypatch):
        ws, _base, sub, _plain = await views()

        class Full:
            def locked(self):
                return True

        monkeypatch.setattr(feed, "_lane", lambda: Full())
        engine = FeedEngine()
        resp = await post(ws, sub.id, {"layerId": "t", "sessionId": "s1"}, engine)
        assert resp.status_code == 200, "never a 429 for a scan already under way"
        assert resp.json()["status"] == "running" and len(resp.json()["nodes"]) == 1
        assert charged == []

    async def test_refresh_asks_for_this_data(self, on, views, post, charged):
        ws, _base, sub, _plain = await views()
        engine = FeedEngine()
        await post(ws, sub.id, {"layerId": "t", "refresh": True}, engine)
        assert {c.reuse_s for _q, c in engine.provider.calls} == {0}

    async def test_a_full_lane_serves_anything_recent_then_429(self, on, views, post, charged,
                                                               monkeypatch):
        ws, _base, sub, _plain = await views()

        class Full:
            def locked(self):
                return True

        monkeypatch.setattr(feed, "_lane", lambda: Full())
        engine = FeedEngine()
        resp = await post(ws, sub.id, {"layerId": "t"}, engine)
        assert resp.status_code == 429 and resp.headers.get("Retry-After")
        assert [(c.scan, c.reuse_s) for _q, c in engine.provider.calls][-1] == (
            False, get_deep_search_settings().session_ttl_seconds)

        old = SearchResultPage(hits=_hits(2), total_count=2, status="complete", stale=True,
                               as_of=datetime.now(timezone.utc).isoformat(), elapsed_ms=1)
        calls = {"n": 0}

        async def probe(query, *, context):
            calls["n"] += 1
            if context.reuse_s == get_deep_search_settings().session_ttl_seconds:
                return old
            raise NothingReusable("q")

        engine.provider.deep_search_session = probe
        resp = await post(ws, sub.id, {"layerId": "t"}, engine)
        assert resp.status_code == 200 and len(resp.json()["nodes"]) == 2 and charged == []

    async def test_a_layer_placed_by_hand_holds_what_its_base_places_there(self, on, views, post,
                                                                            charged):
        # The "oracle" case: layers that list no types, their entities placed by hand.
        base = {**BASE, "layout": {"referenceLayout": {"layers": [
            {"id": "src", "name": "Source systems"}, {"id": "rep", "name": "Reporting"}],
            "assignments": {"urn:db:oracle": {"layerId": "src"},
                            "urn:bi:sales": {"layerId": "rep"}}}}}
        ws, _base, sub, _plain = await views(base_config=base)
        engine = FeedEngine()
        page = (await post(ws, sub.id, {"layerId": "src"}, engine)).json()
        placed, pii = engine.provider.calls[-1][0].predicate.children
        assert _placed(placed) == "src" and pii == TagPredicate(values=["pii"])
        assert placed._placement.spec.explicit["urn:db:oracle"].layer_id == "src"
        assert page["totalCount"] == 3
        # Other matches: what the base places in none of its layers.
        await post(ws, sub.id, {"layerId": REST_LAYER_ID}, engine)
        rest = engine.provider.calls[-1][0].predicate.children[0]
        assert rest.op == "not" and _placed(rest.children[0]) is None

    async def test_other_matches_reads_every_type_its_base_does(self, on, views, post, charged):
        wider = {**BASE, "content": {"entityScope": "all",
                                     "visibleEntityTypes": ["table", "dashboard", "column"]}}
        ws, _base, sub, _plain = await views(base_config=wider)
        engine = FeedEngine()
        await post(ws, sub.id, {"layerId": REST_LAYER_ID}, engine)
        query = engine.provider.calls[-1][0]
        rest = query.predicate.children[0]
        assert rest.op == "not" and _placed(rest.children[0]) is None
        assert query.scope.entity_types == ["column", "dashboard", "table"]

    async def test_placed_by_type_a_layer_that_can_hold_nothing_is_not_searched(
            self, on, views, post, monkeypatch):
        from backend.app.services import advanced_search_service as svc_mod
        monkeypatch.setattr(svc_mod, "LAYER_FILTER_MAX_HAND_PLACED", 0)
        base = {**BASE, "layout": {"referenceLayout": {"layers": [
            {"id": "t", "name": "Tables", "entityTypes": ["table"]},
            {"id": "e", "name": "Empty", "entityTypes": []}],
            "assignments": {"urn:t:1": {"layerId": "e"}}}}}
        ws, _base, sub, _plain = await views(base_config=base)
        engine = FeedEngine()
        page = (await post(ws, sub.id, {"layerId": "e"}, engine)).json()
        assert engine.provider.calls == [] and page["totalCount"] == 0 and page["nodes"] == []
        # The rest of its layers, by type.
        await post(ws, sub.id, {"layerId": "t"}, engine)
        assert engine.provider.calls[-1][0].predicate.children[0] == EntityTypePredicate(
            values=["table"])

    async def test_a_layer_lists_no_more_than_the_cap(self, on, views, post, charged, monkeypatch):
        monkeypatch.setenv("DEEP_SEARCH_VIEW_FEED_MAX_ROWS", "200")
        get_deep_search_settings.cache_clear()
        try:
            ws, _base, sub, _plain = await views()
            engine = FeedEngine()
            engine.provider.scanned = SearchResultPage(
                hits=_hits(200), total_count=80_412, candidate_count=80_412, status="complete",
                cursor="engine-cursor", elapsed_ms=1)
            page = (await post(ws, sub.id, {"layerId": "t"}, engine)).json()
            assert page["delivered"] == 200 and page["capped"] and page["cursor"] is None
            assert page["totalCount"] == 80_412
        finally:
            monkeypatch.delenv("DEEP_SEARCH_VIEW_FEED_MAX_ROWS")
            get_deep_search_settings.cache_clear()

    async def test_a_cursor_carries_what_the_layer_listed(self, on, views, post, charged):
        ws, _base, sub, _plain = await views()
        engine = FeedEngine()
        engine.provider.scanned = SearchResultPage(
            hits=_hits(200), total_count=500, status="complete", cursor="c1", elapsed_ms=1)
        first = (await post(ws, sub.id, {"layerId": "t"}, engine)).json()
        assert first["delivered"] == 200 and first["cursor"]
        engine.provider.scanned = SearchResultPage(
            hits=_hits(200, "m"), total_count=500, status="complete", cursor="c2", elapsed_ms=1)
        second = (await post(ws, sub.id, {"layerId": "t", "cursor": first["cursor"]}, engine)).json()
        assert engine.provider.calls[-1][0].options.cursor == "c1"
        assert second["delivered"] == 400
        bad = await post(ws, sub.id, {"layerId": "t", "cursor": "%%%"}, engine)
        assert bad.status_code == 400

    async def test_a_cursor_cant_be_made_up_or_borrowed(self, on, views, post, charged):
        """Signed: a count reset to page past the cap, a position nobody was given
        (each would start a scan of its own), or another layer's cursor is refused."""
        import base64 as b64
        import json as js

        ws, _base, sub, _plain = await views()
        engine = FeedEngine()
        engine.provider.scanned = SearchResultPage(
            hits=_hits(200), total_count=5000, status="complete", cursor="c1", elapsed_ms=1)
        issued = (await post(ws, sub.id, {"layerId": "t"}, engine)).json()["cursor"]
        payload, tag = issued.split(".")
        assert js.loads(b64.urlsafe_b64decode(payload + "=" * (-len(payload) % 4))) == {"c": "c1", "d": 200}

        def forged(state):
            raw = b64.urlsafe_b64encode(js.dumps(state, separators=(",", ":")).encode()).decode().rstrip("=")
            return f"{raw}.{tag}"

        calls = len(engine.provider.calls)
        for cursor in (forged({"c": "c1", "d": 0}), forged({"c": "anywhere", "d": 200}),
                       payload,  # unsigned, as cursors were before
                       issued):  # good for layer t only
            layer = "d" if cursor == issued else "t"
            resp = await post(ws, sub.id, {"layerId": layer, "cursor": cursor}, engine)
            assert resp.status_code == 400, (cursor, resp.text)
        assert len(engine.provider.calls) == calls, "nothing searched for a cursor refused"
        # The one it was issued for still pages on.
        assert (await post(ws, sub.id, {"layerId": "t", "cursor": issued}, engine)).status_code == 200


class TestCache:
    @pytest.fixture()
    def cache(self):
        cache = graph_cache_mod.GraphCache(fakeredis.aioredis.FakeRedis())
        graph_cache_mod._cache = cache
        yield cache
        graph_cache_mod.reset_graph_cache_for_tests()

    async def test_everyone_asking_the_same_shares_one_answer(self, on, views, post, charged, cache):
        ws, _base, sub, _plain = await views()
        engine = FeedEngine(workspace=ws)
        one = (await post(ws, sub.id, {"layerId": "t"}, engine)).json()
        two = (await post(ws, sub.id, {"layerId": "t"}, engine)).json()
        assert one == two and [c.scan for _q, c in engine.provider.calls] == [False, True]

    def test_a_recent_page_is_kept_no_longer_than_its_window_and_never_as_fallback(self):
        as_of = datetime.fromtimestamp(time.time() - 100, tz=timezone.utc).isoformat()
        page = SearchResultPage(hits=_hits(1), status="complete", stale=True, as_of=as_of,
                                elapsed_ms=1)
        built = feed._feed_page(TABLES, None, page, 0, 2000, 300, "b")
        assert 130 <= built.cache_ttl_s <= 141 and built.lkg is False
        fresh = feed._feed_page(TABLES, None, page.model_copy(update={"stale": False, "as_of": None}),
                                0, 2000, 300, "b")
        assert fresh.cache_ttl_s is None and fresh.lkg is True

    def test_a_page_whose_paths_ran_late_is_kept_for_seconds(self):
        page = SearchResultPage(hits=_hits(1), status="complete", elapsed_ms=1)
        page._paths_left_out = True
        built = feed._feed_page(TABLES, None, page, 0, 2000, 300, "b")
        # Degraded: the cache keeps it for seconds, never as last-known-good.
        assert built.degraded_detail == "paths"
        assert feed._feed_page(TABLES, None, page.model_copy(), 0, 2000, 300, "b").degraded_detail == "paths"

    async def test_each_row_says_how_many_of_its_containers_share_its_layer(self, on, views, post):
        # oracle_prod is placed in Source systems by hand; sales inherits it there.
        base = {**BASE, "layout": {"referenceLayout": {"layers": [
            {"id": "src", "name": "Source systems"}, {"id": "rep", "name": "Reporting"}],
            "assignments": {"urn:db:oracle": {"layerId": "src"}, "urn:bi:x": {"layerId": "rep"}}}}}
        ws, _base, sub, _plain = await views(base_config=base)

        def ref(urn, kind):
            out = AncestorRef(urn=urn, display_name=urn, entity_type=kind)
            out._facts = NodeFacts(urn=urn, entity_type=kind)
            return out

        inside = SearchHit(node=GraphNode(urn="urn:t:orders", displayName="oracle_orders", entityType="table"),
                           ancestor_path=[ref("urn:db:oracle", "database"), ref("urn:s:sales", "schema")])
        elsewhere = SearchHit(node=GraphNode(urn="urn:t:x", displayName="x", entityType="table"),
                              ancestor_path=[ref("urn:bi:x", "folder")])
        engine = FeedEngine()
        engine.provider.scanned = SearchResultPage(hits=[inside, elsewhere], total_count=2, candidate_count=2,
                                                   status="complete", session_id="s1", elapsed_ms=1)
        page = (await post(ws, sub.id, {"layerId": "src"}, engine)).json()
        rows = {n["urn"]: n for n in page["nodes"]}
        assert rows["urn:t:orders"]["inLayer"] == 2
        assert "inLayer" not in rows["urn:t:x"]          # its container is drawn in Reporting

    async def test_the_cache_honours_the_hints(self):
        redis = fakeredis.aioredis.FakeRedis()
        cache = graph_cache_mod.GraphCache(redis)
        page = ViewFeedPage(layer_id="t", nodes=[{"urn": "a"}], stale=True)
        page._ttl_s = 7
        await cache._set("k", page, None, graph_cache_mod.ENDPOINT_VIEW_FEED)
        assert 0 < await redis.ttl("k") <= 7
