"""Graph residency against Postgres, Redis and this lane's FalkorDB (doc 17).

Needs ``GRAPHVER_E2E=1`` and the live services; the FalkorDB cases also ``RUN_FALKOR_LIVE=1``.
Each case puts the platform settings row back as it found it.
"""
from __future__ import annotations

import asyncio
import os
from datetime import datetime, timedelta, timezone
from types import SimpleNamespace

import pytest
import redis.asyncio as aioredis
from sqlalchemy import func, select, update

from backend.app.api.v1.endpoints import versioning as V
from backend.app.api.v1.endpoints import versioning_admin as va
from backend.app.db.engine import get_async_session
from backend.app.db.models import PlatformSettingsORM
from backend.app.services.versioning import config, db, models, residency, residency_policy
from backend.app.services.versioning.cache_manager import CacheManager
from backend.app.services.versioning.messaging import close_broker_redis, get_broker_redis
from backend.app.services.versioning.models import ProjectionStateORM
from backend.app.services.versioning.projection import FalkorProjector, make_falkor_graph_factory
from backend.app.services.versioning.residency import CapacityLoop
from backend.app.services.versioning.service import GraphVersioningService
from backend.tests.integration.test_versioning_projection import FakeFalkor

pytestmark = pytest.mark.skipif(not os.getenv("GRAPHVER_E2E"),
                                reason="set GRAPHVER_E2E=1 + live Postgres + Redis to run")


async def _set_policy(**columns) -> dict:
    """Save policy columns on the platform settings row; returns what they were."""
    async with get_async_session() as s:
        row = await s.get(PlatformSettingsORM, 1)
        if row is None:
            row = PlatformSettingsORM(id=1)
            s.add(row)
        before = {name: getattr(row, name) for name in columns}
        for name, value in columns.items():
            setattr(row, name, value)
        await s.commit()
    residency_policy.invalidate()
    return before


@pytest.fixture
async def store():
    await models.create_schema_and_partitions()
    yield GraphVersioningService()
    residency_policy.invalidate()
    await close_broker_redis()
    await db.dispose_engine()


async def _residency(gid: str) -> str:
    async with db.graphver_session() as s:
        return (await s.get(ProjectionStateORM, gid)).residency


async def test_a_new_graph_gets_the_class_the_policy_names(store):
    svc = store
    before = await _set_policy(gv_default_residency="coldline")
    try:
        gid = (await svc.create_graph(data_source_id="ds_" + os.urandom(4).hex(),
                                      workspace_id="ws_res", actor="a"))["graph_id"]
        assert await _residency(gid) == "coldline"
        await _set_policy(gv_default_residency=None)
        other = (await svc.create_graph(data_source_id="ds_" + os.urandom(4).hex(),
                                        workspace_id="ws_res", actor="a"))["graph_id"]
        assert await _residency(other) == "standard"
    finally:
        await _set_policy(**before)


# ── the gate inside project_graph ──────────────────────────────────────────────────────────────
def _hex() -> str:
    return os.urandom(4).hex()


async def _publish(svc, gid: str, *names: str) -> None:
    d = await svc.open_draft(graph_id=gid, owner="a")
    await svc.stage_changes(graph_id=gid, branch_id=d, actor="a", ops=[
        {"op": "create", "entity_kind": "node", "entity_id": n,
         "payload": {"urn": f"urn:{gid}:{n}", "displayName": n, "entityType": "Dataset"}}
        for n in names])
    await svc.checkpoint(graph_id=gid, branch_id=d, actor="a")
    await svc.publish(graph_id=gid, branch_id=d, actor="a", message="seed")


async def _resident(svc, proj) -> str:
    """A graph with its own platform key, projected (so idle, past genesis, evictable)."""
    gid = (await svc.create_graph(data_source_id="ds_" + _hex(), workspace_id="ws_res",
                                  actor="a", falkor_graph_name="gvt_" + _hex(),
                                  owns_falkor_graph=True))["graph_id"]
    await _publish(svc, gid, "A")
    assert not (await proj.project_graph(gid)).get("skipped")
    return gid


async def _ps(gid: str) -> ProjectionStateORM:
    async with db.graphver_session() as s:
        return await s.get(ProjectionStateORM, gid)


async def _dropped(name, provider_id=None):
    pass


async def _pending(proj, gid: str) -> bool:
    """Whether the real ``project_pending`` select picks ``gid`` (and only it is projected: the
    shared Postgres holds other graphs)."""
    picked, real = [], proj.project_graph

    async def _only_ours(g, *a, **kw):
        picked.append(g)
        return await real(g) if g == gid else {"noop": True}

    proj.project_graph = _only_ours
    try:
        await proj.project_pending(limit=100_000)
    finally:
        proj.project_graph = real
    return gid in picked


async def _load_requested(gid: str) -> bool:
    return await get_broker_redis().zscore(residency.LOAD_REQUESTS, gid) is not None


async def test_an_evicted_graph_stays_evicted_whatever_asks_for_a_pass(store, monkeypatch):
    """With residency on, no caller of project_graph reseeds an evicted graph, nor one waiting
    for room: the poll does not pick it, a nudge and project_now skip it, and ensure_rebuilt and
    an operator's rebuild become a request for a load, which admission decides."""
    monkeypatch.setattr(config, "RESIDENCY_ENABLED", True)
    svc, fake = store, FakeFalkor()
    proj = FalkorProjector(graph_client_factory=fake)
    gid = await _resident(svc, proj)
    await get_broker_redis().zrem(residency.LOAD_REQUESTS, gid)
    assert await CacheManager(proj).evict(gid, drop_graph=_dropped) is True
    await _publish(svc, gid, "B")                    # the head moves on while it is evicted
    try:
        for status in ("evicted", "waiting_capacity"):
            async with db.graphver_session() as s:
                await s.execute(update(ProjectionStateORM)
                                .where(ProjectionStateORM.graph_id == gid).values(status=status))
            assert await _pending(proj, gid) is False
            assert (await proj.project_graph(gid))["skipped"] == status
            monkeypatch.setattr(V, "_projector", proj)
            await V.project_now(gid)
            ps = await _ps(gid)
            assert (ps.status, ps.projected_commit_seq) == (status, 0)

        assert await CacheManager(proj).ensure_rebuilt(gid) is False
        assert await _load_requested(gid)
        await get_broker_redis().zrem(residency.LOAD_REQUESTS, gid)
        assert await svc.request_projection_rebuild(gid) is True     # asked for: as a load
        await V.rebuild_now(gid)
        assert await _load_requested(gid)
        ps = await _ps(gid)
        assert (ps.status, ps.projected_commit_seq) == ("waiting_capacity", 0)
    finally:
        await get_broker_redis().zrem(residency.LOAD_REQUESTS, gid)


async def test_a_move_keeps_an_evicted_graph_evicted(store, monkeypatch):
    """Moving an evicted graph moves its pin and nothing else: no pass reseeds the new key
    until a load is admitted."""
    monkeypatch.setattr(config, "RESIDENCY_ENABLED", True)
    svc, fake = store, FakeFalkor()
    proj = FalkorProjector(graph_client_factory=fake)
    gid = await _resident(svc, proj)
    assert await CacheManager(proj).evict(gid, drop_graph=_dropped) is True
    from backend.app.services.versioning import keymigrate
    key = keymigrate.owned_key(gid, 2)
    res = await svc.move_projection(graph_id=gid, provider=config.DEFAULT_FALKOR_PROVIDER, key=key,
                                    actor="a", shard_map={})
    assert res["changed"] is True
    ps = await _ps(gid)
    assert (ps.falkor_graph_name, ps.status, ps.projected_commit_seq) == (key, "evicted", 0)
    assert await _pending(proj, gid) is False


async def test_with_residency_off_an_evicted_graph_is_reseeded_as_before(store, monkeypatch):
    monkeypatch.setattr(config, "RESIDENCY_ENABLED", False)
    svc, fake = store, FakeFalkor()
    proj = FalkorProjector(graph_client_factory=fake)
    gid = await _resident(svc, proj)
    assert await CacheManager(proj).evict(gid, drop_graph=_dropped) is True
    assert await _pending(proj, gid) is True
    ps = await _ps(gid)
    assert ps.status == "idle" and ps.projected_commit_seq == ps.target_commit_seq > 0


# ── the capacity loop, live: this lane's FalkorDB with a small maxmemory ──────────────────────
live = pytest.mark.skipif(not os.getenv("RUN_FALKOR_LIVE"),
                          reason="set RUN_FALKOR_LIVE=1 + a live FalkorDB to run")


@pytest.fixture
async def falkor():
    """The FalkorDB the projector writes to, as a plain client for INFO and CONFIG; maxmemory is
    always put back to 0 (unlimited)."""
    client = aioredis.Redis(host=os.getenv("FALKORDB_HOST", "localhost"),
                            port=int(os.getenv("FALKORDB_PORT", "6379")), decode_responses=True)
    try:
        yield client
    finally:
        await client.config_set("maxmemory", 0)
        await client.aclose()


@pytest.fixture
async def mine():
    """The graphs a case makes, left evicted (never waiting nor loading) and out of the load
    queue whatever the case did: the schema tests narrow ck_proj_status on this store."""
    made: list = []
    yield made
    if made:
        async with db.graphver_session() as s:
            await s.execute(update(ProjectionStateORM)
                            .where(ProjectionStateORM.graph_id.in_(made),
                                   ProjectionStateORM.status.in_(("waiting_capacity",
                                                                  "rehydrating")))
                            .values(status="evicted", projected_commit_seq=0))
        await get_broker_redis().zrem(residency.LOAD_REQUESTS, *made)


async def _used(falkor) -> int:
    return int((await falkor.info("memory"))["used_memory"])


async def _set_ps(gid: str, **values) -> None:
    async with db.graphver_session() as s:
        await s.execute(update(ProjectionStateORM)
                        .where(ProjectionStateORM.graph_id == gid).values(**values))


async def _live_graphs(svc, proj, mine, n: int) -> list:
    """``n`` graphs projected into real keys, read a moment ago, each measured at 1 byte."""
    now = datetime.now(timezone.utc)
    out = []
    for _ in range(n):
        gid = await _resident(svc, proj)
        mine.append(gid)
        await _set_ps(gid, last_read_at=now, size_bytes=1, size_measured_at=now)
        out.append(gid)
    return out


def _evicted(p) -> list:
    return [(e.graph_id, e.reason) for e in p.evictions]


@live
async def test_pressure_evicts_coldline_before_standard_and_never_always(
        store, falkor, mine, monkeypatch):
    """At 85 % of maxmemory the master must come down to 70 %: the Coldline graph is enough,
    so the Standard one stays, and the Always one — idle for a month and the largest — is never
    a candidate. The evicted graph stays evicted across the poll."""
    monkeypatch.setattr(config, "RESIDENCY_ENABLED", True)
    svc, proj = store, FalkorProjector(graph_client_factory=make_falkor_graph_factory())
    cold, std, always = await _live_graphs(svc, proj, mine, 3)
    used = await _used(falkor)
    await _set_ps(cold, residency="coldline", size_bytes=used // 4)
    await _set_ps(std, size_bytes=used // 4)
    await _set_ps(always, residency="always", size_bytes=used,
                  last_read_at=datetime.now(timezone.utc) - timedelta(days=30))
    await falkor.config_set("maxmemory", int(used / 0.85))
    p = await CapacityLoop(proj).run_once(graph_ids=[cold, std, always])
    assert _evicted(p) == [(cold, "pressure")]
    ps = await _ps(cold)
    assert (ps.status, ps.evicted_reason, ps.projected_commit_seq) == ("evicted", "pressure", 0)
    assert ps.falkor_graph_name not in await falkor.execute_command("GRAPH.LIST")
    assert (await _ps(std)).status == "idle" and (await _ps(always)).status == "idle"
    await falkor.config_set("maxmemory", 0)
    await _publish(svc, cold, "B")
    assert await _pending(proj, cold) is False
    assert (await _ps(cold)).status == "evicted"


@live
async def test_idle_graphs_go_by_class_and_eviction_off_stops_it(store, falkor, mine, monkeypatch):
    monkeypatch.setattr(config, "RESIDENCY_ENABLED", True)
    svc, proj = store, FalkorProjector(graph_client_factory=make_falkor_graph_factory())
    cold, std = await _live_graphs(svc, proj, mine, 2)
    two_hours = datetime.now(timezone.utc) - timedelta(hours=2)
    await _set_ps(cold, residency="coldline", last_read_at=two_hours)
    await _set_ps(std, last_read_at=two_hours)                     # well inside its 7 days
    before = await _set_policy(gv_eviction_enabled=False)
    try:
        p = await CapacityLoop(proj).run_once(graph_ids=[cold, std])
        assert p.evictions == [] and (await _ps(cold)).status == "idle"
        await _set_policy(gv_eviction_enabled=None)
        p = await CapacityLoop(proj).run_once(graph_ids=[cold, std])
        assert _evicted(p) == [(cold, "idle_coldline")]
        assert (await _ps(cold)).evicted_reason == "idle_coldline"
        assert (await _ps(std)).status == "idle"
    finally:
        await _set_policy(**before)


@live
async def test_lowering_the_start_mark_through_the_admin_route_evicts_at_the_next_pass(
        store, falkor, mine, monkeypatch):
    monkeypatch.setattr(config, "RESIDENCY_ENABLED", True)
    svc, proj = store, FalkorProjector(graph_client_factory=make_falkor_graph_factory())
    (gid,) = await _live_graphs(svc, proj, mine, 1)
    used = await _used(falkor)
    await _set_ps(gid, size_bytes=used // 4)
    await falkor.config_set("maxmemory", int(used / 0.6))
    loop = CapacityLoop(proj)
    assert (await loop.run_once(graph_ids=[gid])).evictions == []      # 60 % < 80 %
    before = await _set_policy(gv_high_water_pct=None, gv_low_water_pct=None)
    try:
        async with get_async_session() as session:
            out = await va.put_residency_policy({"highWaterPct": 55, "lowWaterPct": 50},
                                                user=SimpleNamespace(id="usr_admin"),
                                                session=session)
        assert out["values"]["highWaterPct"]["effective"] == 55
        assert _evicted(await loop.run_once(graph_ids=[gid])) == [(gid, "pressure")]
    finally:
        await _set_policy(**before)


@live
async def test_admission_holds_a_load_that_does_not_fit_and_starts_it_when_room_appears(
        store, falkor, mine, monkeypatch):
    monkeypatch.setattr(config, "RESIDENCY_ENABLED", True)
    svc, proj = store, FalkorProjector(graph_client_factory=make_falkor_graph_factory())
    (gid,) = await _live_graphs(svc, proj, mine, 1)
    assert await CacheManager(proj).evict(gid, drop_graph=proj.drop_graph) is True
    used = await _used(falkor)
    await _set_ps(gid, size_bytes=used)                    # x1.3 needs more than the 30 % left
    await falkor.config_set("maxmemory", used * 2)
    await residency.request_load(gid)
    loop = CapacityLoop(proj)
    p = await loop.run_once(graph_ids=[gid])
    assert p.loads == [] and [(w.graph_id, w.reason) for w in p.waits] == [(gid, "capacity")]
    assert (await _ps(gid)).status == "waiting_capacity"
    assert (await loop.run_once(graph_ids=[gid])).waits[0].reason == "capacity"   # tried again
    await falkor.config_set("maxmemory", used * 10)                       # room appears
    p = await loop.run_once(graph_ids=[gid])
    assert [x.graph_id for x in p.loads] == [gid]
    ps = await _ps(gid)
    assert (ps.status, ps.projected_commit_seq) == ("rehydrating", 0)
    assert not await _load_requested(gid)


@live
async def test_a_projected_key_is_measured(store, falkor, mine, monkeypatch):
    """A key that was never measured, or was projected since, is measured on the next pass."""
    monkeypatch.setattr(config, "RESIDENCY_ENABLED", True)
    svc, proj = store, FalkorProjector(graph_client_factory=make_falkor_graph_factory())
    (gid,) = await _live_graphs(svc, proj, mine, 1)
    await _set_ps(gid, size_bytes=None, size_measured_at=None)
    await CapacityLoop(proj).run_once(graph_ids=[gid])
    ps = await _ps(gid)
    assert ps.size_bytes is not None and ps.size_measured_at is not None


async def test_one_pass_at_a_time_across_workers(store, monkeypatch):
    monkeypatch.setattr(config, "RESIDENCY_ENABLED", True)
    proj = FalkorProjector(graph_client_factory=FakeFalkor())
    async with db.graphver_lock_session() as other:
        assert await other.scalar(select(func.pg_try_advisory_lock(func.hashtext("gvresidency"))))
        try:
            assert await CapacityLoop(proj).run_once(graph_ids=[]) is None
        finally:
            await other.execute(select(func.pg_advisory_unlock(func.hashtext("gvresidency"))))
    assert await CapacityLoop(proj).run_once(graph_ids=[]) is not None


# ── loading a graph again ──────────────────────────────────────────────────────────────────────
class _LiveProvider:
    """What the registry hands a read FalkorDB serves (the live provider), stubbed: only which
    store serves the read is under test here."""
    name = "live"

    async def deep_search_discover(self, *, sample_per_label=200):
        return {"labels": {}, "served": "falkordb"}


class _Registry:
    async def get_provider_for_workspace(self, workspace_id, session, data_source_id=None):
        return _LiveProvider()

    def admit_graph_request(self, source_key):
        return None

    def release_graph_request(self, source_key):
        return None


@pytest.fixture
def plain_engine(monkeypatch):
    """ContextEngine's routing with the management side stubbed: no ontology, no data source
    row, no versioned write-through."""
    from backend.app.db.repositories import data_source_repo
    from backend.app.services.context_engine import ContextEngine

    async def nothing(*a, **kw):
        return None

    monkeypatch.setattr(config, "VERSIONED_WRITES_ENABLED", False)
    monkeypatch.setattr(ContextEngine, "_resolve_ontology", nothing)
    monkeypatch.setattr(data_source_repo, "get_data_source_orm", nothing)
    return ContextEngine


async def _served_by(engine_cls, ds: str, viewer) -> str:
    async with db.graphver_session() as session:
        engine = await engine_cls.for_workspace("ws_res", _Registry(), session,
                                                data_source_id=ds, viewer=viewer)
    served = getattr(engine.provider, "_inner", engine.provider)     # write-through wraps it
    return "falkordb" if isinstance(served, _LiveProvider) else "postgres"


async def _loads(loop, proj, gid: str) -> None:
    """The load the capacity loop admits, as the projection lane runs it: the pass that seeds the
    key (the lane's nudge), then the pass that sees it done."""
    await proj.project_graph(gid)
    await loop.run_once(graph_ids=[gid])


@live
async def test_a_read_reloads_a_standard_graph(store, falkor, mine, plain_engine, monkeypatch):
    """Reads are served from Postgres while the graph is evicted and while it loads, and from
    FalkorDB once its key holds everything again."""
    from backend.app.services.versioning.service import Viewer

    monkeypatch.setattr(config, "RESIDENCY_ENABLED", True)
    svc, proj = store, FalkorProjector(graph_client_factory=make_falkor_graph_factory())
    (gid,) = await _live_graphs(svc, proj, mine, 1)
    ds = (await svc.get_graph(gid))["data_source_id"]
    reader = Viewer(actor="usr_reader", can_read=True)
    assert await _served_by(plain_engine, ds, reader) == "falkordb"
    # The read FalkorDB served holds the graph's read lease: no eviction while it may be reading.
    lease = f"versioning:lease:{gid}"
    assert await CacheManager(proj).is_pinned(gid)
    assert 0 < await get_broker_redis().ttl(lease) <= config.TRACE_LEASE_TTL_SECS
    assert await CacheManager(proj).evict(gid, drop_graph=proj.drop_graph) is False
    await get_broker_redis().delete(lease)                 # its time runs out
    assert await CacheManager(proj).evict(gid, drop_graph=proj.drop_graph) is True

    assert await _served_by(plain_engine, ds, None) == "postgres"
    assert not await _load_requested(gid)                  # a background read asks for nothing
    assert await _served_by(plain_engine, ds, reader) == "postgres"
    assert await _load_requested(gid)                      # a person's read does
    loop = CapacityLoop(proj)
    assert [x.graph_id for x in (await loop.run_once(graph_ids=[gid])).loads] == [gid]
    await proj.project_graph(gid)                          # the seed: the key holds main again…
    ps = await _ps(gid)
    assert ps.status == "rehydrating" and ps.projected_commit_seq == ps.target_commit_seq
    assert (await svc.projection_watermark(gid))["fresh"] is False
    assert await _served_by(plain_engine, ds, reader) == "postgres"     # …but reads wait for it
    await loop.run_once(graph_ids=[gid])
    ps = await _ps(gid)
    assert (ps.status, ps.evicted_reason) == ("idle", None) and ps.last_read_at is not None
    assert await _served_by(plain_engine, ds, reader) == "falkordb"
    graph = await make_falkor_graph_factory()(ps.falkor_graph_name)
    rows = (await graph.ro_query("MATCH (n) WHERE n.urn IS NOT NULL RETURN count(n)")).result_set
    assert rows[0][0] == 1


@live
async def test_a_deep_search_loads_a_coldline_graph(store, falkor, mine, plain_engine, monkeypatch):
    """Coldline: a canvas read of a small graph stays on Postgres and loads nothing, but deep
    search needs FalkorDB — 503 graph_loading with Retry-After, and the load asked for — and
    answers once the graph is loaded."""
    from httpx import ASGITransport, AsyncClient

    from backend.tests.integration.test_api_graph_draft_journey import _build_app

    monkeypatch.setattr(config, "RESIDENCY_ENABLED", True)
    svc, proj = store, FalkorProjector(graph_client_factory=make_falkor_graph_factory())
    (gid,) = await _live_graphs(svc, proj, mine, 1)
    await _set_ps(gid, residency="coldline")
    ds = (await svc.get_graph(gid))["data_source_id"]
    assert await CacheManager(proj).evict(gid, drop_graph=proj.drop_graph) is True
    app, graph_routes = _build_app()
    monkeypatch.setattr(graph_routes, "provider_manager", _Registry())
    path = f"/api/v1/ws_res/graph/search/discover?dataSourceId={ds}"
    async with AsyncClient(transport=ASGITransport(app=app), base_url="http://test") as client:
        r = await client.get(path)
        assert r.status_code == 503, r.text
        assert r.json()["detail"]["type"] == "graph_loading" and r.headers["Retry-After"]
        for _ in range(50):
            if await _load_requested(gid):
                break
            await asyncio.sleep(0.02)
        assert await _load_requested(gid)
        loop = CapacityLoop(proj)
        await loop.run_once(graph_ids=[gid])
        await _loads(loop, proj, gid)
        r = await client.get(path)
        assert r.status_code == 200 and r.json()["served"] == "falkordb"


@live
async def test_a_reloaded_key_serves_reads_only_once_its_summaries_are_built(
        store, falkor, mine, monkeypatch):
    """A graph whose ontology has lineage needs the summaries a build stamps into its key: its
    load stays rehydrating (reads on Postgres) until the stamp is there, and the build is asked
    for meanwhile."""
    monkeypatch.setattr(config, "RESIDENCY_ENABLED", True)
    asked: list = []

    async def lineage(svc, gid):
        return ({"CONTAINS"}, {"FLOWS_TO"}, {}, "shared")

    async def build(gid):
        asked.append(gid)

    factory = make_falkor_graph_factory()
    plain = FalkorProjector(graph_client_factory=factory)
    svc = store
    (gid,) = await _live_graphs(svc, plain, mine, 1)
    proj = FalkorProjector(graph_client_factory=factory, edge_types_resolver=lineage,
                           on_rollups_stale=build)
    assert await CacheManager(proj).evict(gid, drop_graph=proj.drop_graph) is True
    await residency.request_load(gid)
    loop = CapacityLoop(proj)
    await loop.run_once(graph_ids=[gid])
    await _loads(loop, proj, gid)
    assert (await _ps(gid)).status == "rehydrating" and gid in asked
    assert (await svc.projection_watermark(gid))["fresh"] is False
    graph = await factory((await _ps(gid)).falkor_graph_name)
    await graph.query("MERGE (m:_AggMeta {id: 'singleton'})")      # the build's stamp
    await loop.run_once(graph_ids=[gid])
    assert (await _ps(gid)).status == "idle"
    assert (await svc.projection_watermark(gid))["fresh"] is True


# ── read tracking ──────────────────────────────────────────────────────────────────────────────
async def test_reads_are_flushed_in_one_update_that_never_moves_a_read_back(store):
    svc = store
    g1, g2 = [(await svc.create_graph(data_source_id="ds_" + _hex(), workspace_id="ws_res",
                                      actor="a"))["graph_id"] for _ in range(2)]
    now = datetime.now(timezone.utc).replace(microsecond=0)
    await _set_ps(g2, last_read_at=now + timedelta(minutes=1))
    residency._READS.clear()
    residency._READS.update({g1: now, g2: now - timedelta(hours=1)})
    assert await residency.flush_reads() == 2 and residency._READS == {}
    assert (await _ps(g1)).last_read_at == now
    assert (await _ps(g2)).last_read_at == now + timedelta(minutes=1)
    assert await residency.flush_reads() == 0
