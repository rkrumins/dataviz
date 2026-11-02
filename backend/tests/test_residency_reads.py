"""Reads and residency (doc 17): what a person's read of a versioned graph out of FalkorDB asks
for, and what FalkorDB-only work answers meanwhile.

ContextEngine calls ``residency.on_read`` once per engine, before it reads the graph's watermark.
A person's read (a background job passes no viewer) holds the read lease of the graph whose key
serves it — a fork's root — first, so an eviction that has not yet committed sees it and backs off,
and one that has is seen by the read; then the read is noted, and each process flushes what it
noted once a minute, in one UPDATE that never moves a read back. The lease is refreshed at most
every 30 seconds per graph per process, in one round trip, and the read never waits on the broker
for more than about 100 ms. For a read of a
graph whose key is not in FalkorDB — evicted, waiting for room or being
loaded — the read is served from Postgres and the request remembers which graph it is
(``residency.READING``): deep search, node degrees and native queries then answer 503
``graph_loading`` with Retry-After and ask for the load. A Standard or Always graph's load is asked
for by any read, a Coldline graph's only by such FalkorDB-only work or by a canvas read of a graph
larger than the canvas-load threshold. A fork reads through its root, so it is the root's load.
"""
from __future__ import annotations

import asyncio
import time
from types import SimpleNamespace

import pytest

from backend.app.api.v1.endpoints import graph as G
from backend.app.services.feature_flags import feature_flags
from backend.app.services.versioning import cache_manager, config, residency, residency_policy
from backend.app.services.versioning.service import Viewer, serves_head

_VIEWER = Viewer(actor="usr_1", can_read=True)


class _Svc:
    def __init__(self, wms: dict, parents: dict = None, order: list = None):
        self.wms, self.parents, self.order = wms, parents or {}, order

    async def get_graph(self, gid):
        return {"graph_id": gid, "data_source_id": f"ds_{gid}",
                "fork_parent_graph_id": self.parents.get(gid)}

    async def residency_state(self, gid):
        if self.order is not None:
            self.order.append(("state", gid))
        return self.wms[gid]


def _wm(status="idle", residency_class="standard", size=None, fresh=None):
    return {"status": status, "residency": residency_class, "size_bytes": size, "committed": 7,
            "fresh": status == "idle" if fresh is None else fresh}


def _loads(asked) -> list:
    return [x for x in asked if isinstance(x, str)]


def _switch(on: bool) -> None:
    """Graph residency (Admin → Features) as this process's flag cache has it."""
    feature_flags._cache = {**(feature_flags._cache or {}), "residencyEnabled": on}
    feature_flags._cache_ts = time.monotonic()


@pytest.fixture
def asked(monkeypatch, residency_on):
    """The loads asked for, and a clean slate for the request's reading."""
    out = []

    async def request_load(gid):
        out.append(gid)

    async def no_count(graph_id, data_source_id, head):
        return None

    async def lease(gid, ttl=None):
        out.append(("lease", gid, ttl))
        return True

    monkeypatch.setattr(residency, "request_load", request_load)
    monkeypatch.setattr(residency, "_entity_count", no_count)
    monkeypatch.setattr(cache_manager, "acquire_lease", lease)
    monkeypatch.setattr(residency, "_note_read", lambda gid: out.append(("read", gid)))
    residency_policy._MEMO.update(policy=residency_policy.defaults(), at=residency_policy._clock())
    residency.READING.set(None)
    residency._HELD.clear()
    yield out
    residency.READING.set(None)
    residency._HELD.clear()
    residency_policy.invalidate()


async def _read(svc, gid="g", *, viewer=_VIEWER, state=None):
    await residency.on_read(svc, await svc.get_graph(gid), viewer=viewer, state=state)
    return residency.READING.get()


@pytest.mark.parametrize("status, residency_class, size, loads", [
    ("evicted", "standard", None, True),
    ("waiting_capacity", "always", None, True),
    ("evicted", "coldline", 550 * 10, False),               # 10 entities: a canvas reads Postgres
    ("evicted", "coldline", 550 * 600_000, True),           # past the 500,000 threshold
    ("rehydrating", "standard", None, False),               # its load is under way
])
async def test_a_read_of_a_graph_out_of_falkordb_and_the_load_it_asks_for(
        asked, status, residency_class, size, loads):
    reading = await _read(_Svc({"g": _wm(status, residency_class, size)}))
    assert reading == residency.Reading(graph_id="g", state=status, retry_after=60)
    assert _loads(asked) == (["g"] if loads else [])


async def test_a_coldline_graph_whose_count_is_past_the_threshold_loads(asked, monkeypatch):
    """Its nodes and edges at the main head, as graphver counts them, kept per head: the next read
    asks nothing of the database."""
    counted = []

    async def count(graph_id, data_source_id, head):
        counted.append((graph_id, head))
        residency._COUNTS[(graph_id, head)] = 500_001
        return 500_001

    monkeypatch.setattr(residency, "_entity_count", count)
    try:
        await _read(_Svc({"g": _wm("evicted", "coldline")}))
        await _read(_Svc({"g": _wm("evicted", "coldline")}))
        assert _loads(asked) == ["g", "g"] and counted == [("g", 7)]
    finally:
        residency._COUNTS.clear()


async def test_a_resident_graph_asks_for_nothing_and_says_nothing(asked):
    assert await _read(_Svc({"g": _wm()})) is None and _loads(asked) == []


async def test_a_background_read_neither_asks_nor_marks_the_request(asked):
    assert await _read(_Svc({"g": _wm("evicted")}), viewer=None) is None and asked == []


async def test_with_residency_off_a_read_still_says_a_graph_is_out_and_asks_for_its_load(asked):
    """Reads never depend on the switch: what only residency writes — evicted, waiting for room,
    being loaded — is honoured with it off too, while an evicted graph is brought back, and in an
    API process that lags the switch. Off, nothing is held or noted, and the read goes by the state
    it loaded anyway (``state``): no statement of residency's own (``_Svc`` has no states)."""
    _switch(False)
    reading = await _read(_Svc({}), state=_wm("evicted"))
    assert reading == residency.Reading(graph_id="g", state="evicted", retry_after=60)
    assert asked == ["g"]                     # its load, and no lease taken nor read noted
    assert await _read(_Svc({}), state=_wm()) is None


@pytest.mark.parametrize("on", [False, True])
def test_a_graph_being_loaded_serves_no_read_from_falkordb_whatever_the_switch(on):
    """Its key holds main, but not yet the summaries its readers need: Postgres serves it."""
    _switch(on)
    assert serves_head(7, 7, "rehydrating") is False
    assert serves_head(7, 7, "idle") is True and serves_head(0, 7, "evicted") is False


async def test_with_residency_off_a_native_query_and_the_stats_probe_still_see_a_graph_out(
        monkeypatch):
    """A key out of FalkorDB is not read as an empty graph, whatever the switch says."""
    from backend.app.services.versioning.service import GraphVersioningService

    async def by_source(_self, ds):
        return {"graph_id": "g", "data_source_id": ds, "fork_parent_graph_id": None}

    async def state(_self, gid):
        return _wm("evicted")

    monkeypatch.setattr(GraphVersioningService, "get_graph_by_data_source", by_source)
    monkeypatch.setattr(GraphVersioningService, "residency_state", state)
    _switch(False)
    assert await residency.non_resident("ds_g") == "g"


async def test_a_fork_reads_through_its_root(asked):
    svc = _Svc({"root": _wm("evicted")}, parents={"fork2": "fork1", "fork1": "root"})
    reading = await _read(svc, "fork2")
    assert reading.graph_id == "root" and _loads(asked) == ["root"]


async def test_a_read_holds_the_lease_before_it_reads_the_graph_s_state(asked):
    """An eviction checks the lease again after it commits: a read whose lease it misses reads the
    state after that commit, and is served from Postgres."""
    order = []
    await _read(_Svc({"g": _wm()}, order=order))
    lease = asked.index(("lease", "g", config.TRACE_LEASE_TTL_SECS))
    assert lease == 0 and order == [("state", "g")]
    assert asked[1:] == [("read", "g")]


# ── what FalkorDB-only work answers meanwhile ────────────────────────────────────────────────────
async def test_deep_search_on_a_graph_out_of_falkordb_is_a_503_that_asks_for_the_load(asked):
    residency.READING.set(residency.Reading(graph_id="g", state="evicted", retry_after=45))
    exc = G._map_not_implemented(SimpleNamespace(), NotImplementedError("the graph is catching up"))
    assert exc.status_code == 503 and exc.headers == {"Retry-After": "45"}
    assert exc.detail["type"] == "graph_loading" and exc.detail["retryAfter"] == 45
    await asyncio.sleep(0)
    assert _loads(asked) == ["g"]


async def test_deep_search_on_a_graph_in_falkordb_is_refused_as_before(asked):
    exc = G._map_not_implemented(SimpleNamespace(), NotImplementedError("the graph is catching up"))
    assert exc.status_code == 501 and exc.detail == "the graph is catching up" and asked == []


async def test_node_degrees_on_a_graph_out_of_falkordb_is_a_503(asked, monkeypatch):
    class _Engine:
        async def get_node_degrees(self, urns, edge_types, include_rollups=False):
            raise NotImplementedError("a versioned branch cannot count degrees")

    monkeypatch.setattr(G, "_cache_scope", lambda engine: None)
    monkeypatch.setattr(G, "_bounded_compute", lambda engine, fn: fn)
    query = G.NodeDegreeQuery.model_validate({"urns": ["urn:a"]})
    with pytest.raises(G.HTTPException) as caught:
        await G.get_node_degrees(SimpleNamespace(headers={}), query, engine=_Engine())
    assert caught.value.status_code == 501
    residency.READING.set(residency.Reading(graph_id="g", state="waiting_capacity", retry_after=60))
    with pytest.raises(G.HTTPException) as caught:
        await G.get_node_degrees(SimpleNamespace(headers={}), query, engine=_Engine())
    assert caught.value.status_code == 503 and caught.value.detail["type"] == "graph_loading"
    await asyncio.sleep(0)
    assert _loads(asked) == ["g"]


# ── who else reads a key ─────────────────────────────────────────────────────────────────────────
async def test_the_keys_other_readers_hold_are_found_in_two_reads(monkeypatch):
    """A key another live data source reads (by name, or as its dedicated key) through the same
    server, or a catalog entry publishes, is held; the graph's own data source is not another."""
    from backend.app.services import managed_sources

    async def servers(session, provider_id):
        return {None: ["default", "prov_alias"], "default": ["default", "prov_alias"],
                "prov_b": ["prov_b"]}[provider_id]

    reads = []

    class _Session:
        async def execute(self, stmt):
            reads.append(stmt)
            rows = ([("ds_own", "default", "k_own", None), ("ds_other", "prov_alias", None, "k_ded"),
                     ("ds_far", "prov_far", "k_far", None)] if len(reads) == 1
                    else [("prov_b", "k_cat")])
            return SimpleNamespace(all=lambda: rows)

    monkeypatch.setattr(managed_sources, "same_server_providers", servers)
    held = await managed_sources.keys_read_elsewhere(_Session(), [
        (None, "k_own", "ds_own"), ("default", "k_ded", "ds_mine"), ("default", "k_far", "ds_x"),
        ("prov_b", "k_cat", "ds_y"), ("prov_b", "k_free", "ds_z")])
    assert held == {("default", "k_ded"), ("prov_b", "k_cat")} and len(reads) == 2
    assert await managed_sources.keys_read_elsewhere(_Session(), []) == set()


# ── every read FalkorDB serves ───────────────────────────────────────────────────────────────────
async def test_a_native_query_holds_its_graph_before_it_reads_the_watermark(monkeypatch):
    from backend.app.services import versioned_sources
    from backend.app.services.versioning import service as service_module

    order = []

    class _Gv:
        async def get_graph_by_data_source(self, ds):
            return {"graph_id": "g", "data_source_id": ds, "fork_parent_graph_id": None}

        async def projection_watermark(self, gid):
            order.append("watermark")
            return {"fresh": True, "status": "idle", "falkor_provider": None,
                    "falkor_graph_name": "k"}

    async def versioned(**kw):
        return {"ds1"}

    async def hold(svc, graph):
        order.append(("hold", graph["graph_id"]))

    monkeypatch.setattr(versioned_sources, "versioned_data_source_ids", versioned)
    monkeypatch.setattr(service_module, "GraphVersioningService", _Gv)
    monkeypatch.setattr(residency, "hold", hold)
    assert await G._holds_published_graph("ds1", SimpleNamespace()) is True
    assert order == [("hold", "g"), "watermark"]


async def test_a_live_export_reads_as_the_person_it_is_for(monkeypatch):
    """A person's export: its read is recorded and held like a canvas read (an engine built with
    no viewer is a background job's)."""
    from backend.app.api.v1.endpoints import graph_export
    from backend.app.services.context_engine import ContextEngine

    built = {}

    async def get_ds(session, ds_id):
        return SimpleNamespace(workspace_id="ws1")

    async def for_workspace(*a, **kw):
        built.update(kw)
        return SimpleNamespace(provider="p")

    monkeypatch.setattr(graph_export.data_source_repo, "get_data_source_orm", get_ds)
    monkeypatch.setattr(ContextEngine, "for_workspace", for_workspace)
    assert await graph_export._provider("ws1", "ds1", None, SimpleNamespace(id="usr_1")) == "p"
    assert built["viewer"].actor == "usr_1" and built["viewer"].can_read


async def test_the_v2_router_reads_as_the_person_calling_it(monkeypatch):
    from backend.app.api.v2.endpoints import graph as G2
    from backend.app.services.context_engine import ContextEngine

    built = {}

    async def for_workspace(*a, **kw):
        built.update(kw)
        return "engine"

    monkeypatch.setattr(ContextEngine, "for_workspace", for_workspace)
    monkeypatch.setattr(G2, "has_permission", lambda claims, perm, workspace_id=None: True)
    out = await G2.get_context_engine("ws1", dataSourceId="ds1", branchId=None, _admission=None,
                                      session=None, user=SimpleNamespace(id="usr_2"), claims=None)
    assert out == "engine" and built["viewer"].actor == "usr_2" and built["actor"] == "usr_2"


# ── the stats probe ──────────────────────────────────────────────────────────────────────────────
async def test_the_stats_probe_skips_a_graph_out_of_falkordb(monkeypatch):
    """Its key is gone: a probe would read an empty graph and record 0 nodes and 0 edges."""
    from backend.app.services.aggregation.service import AggregationService

    asked = []

    class _Registry:
        async def get_provider_for_workspace(self, *a, **kw):
            asked.append("provider")
            raise AssertionError("the probe must not read FalkorDB")

    async def out(ds_id):
        return "g_evicted"

    monkeypatch.setattr(residency, "non_resident", out)
    probe = SimpleNamespace(_registry=_Registry())
    assert await AggregationService._probe_live_stats(probe, "ws1", "ds1", None) == (
        None, None, None)
    assert asked == []


async def test_the_stats_probe_never_fails_on_residency_s_read(monkeypatch):
    """Review finding 13: the freshness read is documented never to fail; residency's question
    (``non_resident``, a graphver read) was asked outside the probe's try, and a graphver error
    failed it. Since the switch, that question is asked of every source, so an unreadable answer
    must not cost the probe either (CI's required suite: every probe skipped with graphver
    unreachable). The probe goes ahead, as with residency never turned on; a versioned source's
    own pin read then fails as every read of it does with graphver down."""
    from backend.app.services.aggregation.service import AggregationService

    asked = []

    class _Registry:
        async def get_provider_for_workspace(self, *a, **kw):
            asked.append("provider")
            raise ConnectionError("FalkorDB unreachable")

    async def down(ds_id):
        raise ConnectionError("graphver unreachable")

    monkeypatch.setattr(residency, "non_resident", down)
    probe = SimpleNamespace(_registry=_Registry())
    assert await AggregationService._probe_live_stats(probe, "ws1", "ds1", None) == (
        None, None, None)
    assert asked == ["provider"]


async def test_a_pass_reads_each_lease_briefly_and_stops_asking_once_the_broker_fails(monkeypatch):
    """Review 3, finding 9: a broker that times out rather than refuses cost a pass about 5 s per
    eviction candidate, in turn — 200 candidates, some 17 minutes holding the leader lock. Each
    read is bounded as a person's read is (100 ms), and after the first that fails the pass asks
    no more: every lease it cannot read counts as held."""
    asked = []

    async def stuck(graph_id):
        asked.append(graph_id)
        await asyncio.sleep(5)

    monkeypatch.setattr(cache_manager, "is_pinned", stuck)
    broker: dict = {}
    loop = asyncio.get_running_loop()
    started = loop.time()
    assert [await residency._leased(g, broker) for g in ("g1", "g2", "g3")] == [True] * 3
    assert loop.time() - started < 1 and asked == ["g1"]


# ── read tracking and the read lease ─────────────────────────────────────────────────────────────
async def test_a_person_s_read_holds_the_lease_and_is_noted(asked):
    await _read(_Svc({"g": _wm()}))
    assert asked == [("lease", "g", config.TRACE_LEASE_TTL_SECS), ("read", "g")]


async def test_the_lease_is_refreshed_at_most_every_30_seconds_per_graph(asked, monkeypatch):
    """The lease lasts 120 seconds: refreshed every 30 at most, it is held through every read
    while reads keep coming, at one round trip per graph per half minute."""
    clock = [1000.0]
    monkeypatch.setattr(residency.time, "monotonic", lambda: clock[0])
    for _ in range(3):
        await _read(_Svc({"g": _wm()}))
    clock[0] += 31
    await _read(_Svc({"g": _wm()}))
    assert [x for x in asked if x[0] == "lease"] == [("lease", "g", config.TRACE_LEASE_TTL_SECS)] * 2


async def test_a_read_never_waits_on_the_broker(asked, monkeypatch):
    """A broker that does not answer costs a read about 100 ms, not its 5-10 s timeouts: neither
    the lease nor a load request is waited for longer."""
    async def stuck(*a, **kw):
        await asyncio.sleep(5)

    monkeypatch.setattr(cache_manager, "acquire_lease", stuck)
    monkeypatch.setattr(residency, "request_load", stuck)
    loop = asyncio.get_running_loop()
    started = loop.time()
    reading = await _read(_Svc({"g": _wm("evicted")}))
    assert loop.time() - started < 1 and reading.graph_id == "g"
    assert residency._HELD == {}                          # not held: the next read tries again


async def test_a_fork_s_read_counts_for_its_root_and_holds_the_root(asked):
    svc = _Svc({"root": _wm()}, parents={"fork2": "fork1", "fork1": "root"})
    await _read(svc, "fork2")
    assert asked == [("lease", "root", config.TRACE_LEASE_TTL_SECS), ("read", "root")]


async def test_the_lease_is_taken_in_one_round_trip(monkeypatch):
    calls = []

    class _Pipe:
        def __init__(self):
            self.queued = []

        def incr(self, key):
            self.queued.append(("INCR", key))

        def expire(self, key, ttl):
            self.queued.append(("EXPIRE", key, ttl))

        async def execute(self):
            calls.append(list(self.queued))

        async def __aenter__(self):
            return self

        async def __aexit__(self, *exc):
            return False

    class _Broker:
        def pipeline(self, transaction=True):
            return _Pipe()

    monkeypatch.setattr(cache_manager, "get_broker_redis", lambda: _Broker())
    assert await cache_manager.acquire_lease("g", ttl=120) is True
    assert calls == [[("INCR", "versioning:lease:g"), ("EXPIRE", "versioning:lease:g", 120)]]


async def test_a_background_read_is_not_noted(asked):
    await _read(_Svc({"g": _wm()}), viewer=None)
    assert asked == []


async def test_with_residency_off_no_read_is_noted(asked):
    _switch(False)
    await _read(_Svc({"g": _wm()}), state=_wm())
    assert asked == []


async def test_reads_are_noted_once_a_graph_and_kept_when_a_flush_fails(monkeypatch):
    """The map keeps each graph's latest read; a flush that cannot write puts the reads back,
    keeping a later one noted meanwhile, for the next flush."""
    residency._READS.clear()
    monkeypatch.setattr(residency, "_ensure_flusher", lambda: None)
    residency._note_read("g1")
    first = residency._READS["g1"]
    residency._note_read("g1")
    residency._note_read("g2")
    assert set(residency._READS) == {"g1", "g2"} and residency._READS["g1"] >= first

    class _Broken:
        async def __aenter__(self):
            raise RuntimeError("graphver is down")

        async def __aexit__(self, *exc):
            return False

    monkeypatch.setattr(residency.db, "graphver_session", lambda: _Broken())
    assert await residency.flush_reads() == 0
    assert set(residency._READS) == {"g1", "g2"}
    residency._READS.clear()


# ── the watermark route ──────────────────────────────────────────────────────────────────────────
class _NoKeyVersioning:
    """A graph with no FalkorDB key yet: what ``projection_watermark`` answers for one."""

    async def get_graph(self, graph_id):
        return {"graph_id": graph_id, "workspace_id": "ws_a", "data_source_id": "ds_a",
                "kind": "manual", "main_head_commit_seq": 3, "deleted_at": None,
                "fork_parent_graph_id": None}

    async def projection_watermark(self, graph_id):
        from backend.app.services.versioning.service import residency_state_of, serves_head

        return {"committed": 3, "projected": 0, "target": 3, "status": "idle",
                "fresh": serves_head(0, 3, "idle"),
                "read_route": {"main": "postgres", "drafts": "overlay"},
                "falkor_graph_name": None, "falkor_provider": None, "owns_falkor_graph": False,
                "residency": "standard", "residency_state": residency_state_of("idle", 0, None,
                                                                               graph_id)}


@pytest.mark.parametrize("on", [False, True])
async def test_the_watermark_of_a_graph_with_no_key_answers_with_no_residency_state(
        test_client, monkeypatch, on):
    """Review 3, finding 2: a graph with no key has no residency state (null), and the route typed
    it as a string, so GET …/watermark answered 500 for every such graph — with residency off too,
    where nothing may change."""
    from backend.app.api.v1.endpoints.versioning import get_versioning_service
    from backend.app.main import app

    _switch(on)
    app.dependency_overrides[get_versioning_service] = _NoKeyVersioning
    try:
        r = await test_client.get("/api/v1/ws_a/versioning/graphs/graph_a/watermark")
    finally:
        app.dependency_overrides.pop(get_versioning_service, None)
    assert r.status_code == 200, r.text
    assert (r.json()["residencyState"], r.json()["projectionKey"]) == (None, None)
