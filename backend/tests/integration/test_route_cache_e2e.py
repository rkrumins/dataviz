"""Each process reads a versioned graph's route from Postgres once per change to it, against a live
Postgres and Redis (``versioning.route_cache``).

A route this process keeps is read again as soon as a write made in another process moves it: a
publish, a projection, a read-mode change, an eviction, a load's end, a trash. Until then this
process routes every read by what it keeps, with no statement to Postgres. An eviction whose
readers can't be told keeps its key. A write no process was told of (a raw SQL statement) is seen
once the route ages out.
"""
import asyncio
import contextlib
import os

import pytest
from sqlalchemy import event, text

from backend.app.services.versioning import config as vconfig
from backend.app.services.versioning import db, models, route_cache
from backend.app.services.versioning.cache_manager import CacheManager
from backend.app.services.versioning.models import GraphORM, ProjectionStateORM, _now
from backend.app.services.versioning.projection import FalkorProjector
from backend.app.services.versioning.service import GraphVersioningService
from backend.tests.integration.test_versioning_projection import FakeFalkor

pytestmark = [pytest.mark.integration, pytest.mark.skipif(
    not os.getenv("GRAPHVER_E2E"), reason="set GRAPHVER_E2E=1 + a live Postgres and Redis to run")]


def _node(eid: str) -> dict:
    return {"op": "create", "entity_kind": "node", "entity_id": eid,
            "payload": {"urn": eid, "entityType": "Table", "displayName": eid}}


@contextlib.contextmanager
def _elsewhere():
    """A write made by another process: what this one keeps is as it was before the write. Only the
    graph's token in Redis can tell it."""
    kept = (dict(route_cache._SNAPS), dict(route_cache._SOURCES), dict(route_cache._NONE))
    yield
    for mine, before in zip((route_cache._SNAPS, route_cache._SOURCES, route_cache._NONE), kept):
        mine.clear()
        mine.update(before)


async def _graph(svc) -> tuple:
    ds = "ds_" + os.urandom(4).hex()
    g = await svc.create_graph(data_source_id=ds, workspace_id="ws1", actor="u",
                               falkor_graph_name="gvt_" + os.urandom(3).hex(),
                               owns_falkor_graph=True)
    await svc.apply_ops(graph_id=g["graph_id"], actor="u", message="seed", ops=[_node("A")])
    return ds, g["graph_id"]


async def _route(ds) -> dict:
    snap = await route_cache.route_of_source(ds)
    return None if snap is None else {**await snap.state(), "graph_id": snap.graph_id}


def _run(case):
    async def go():
        await models.create_schema_and_partitions()
        try:
            await case(GraphVersioningService())
        finally:
            route_cache.reset()
            await db.dispose_engine()
    asyncio.run(go())


def test_a_kept_route_moves_with_each_write_made_elsewhere():
    async def case(svc):
        ds, gid = await _graph(svc)
        fake = FakeFalkor()
        await FalkorProjector(graph_client_factory=fake).project_graph(gid)
        head = (await _route(ds))["committed"]
        assert (await _route(ds))["served"] == head

        with _elsewhere():                                         # a publish
            await svc.apply_ops(graph_id=gid, actor="u", message="b", ops=[_node("B")])
        assert ((await _route(ds))["committed"], (await _route(ds))["served"]) == (head + 1, None)

        with _elsewhere():                                         # its projection
            await FalkorProjector(graph_client_factory=fake).project_graph(gid)
        assert (await _route(ds))["served"] == head + 1

        with _elsewhere():                                         # a read mode
            await svc.set_read_mode(gid, "in_place")
        assert (await _route(ds))["read_mode"] == "in_place"
        with _elsewhere():
            await svc.apply_ops(graph_id=gid, actor="u", message="c", ops=[_node("C")])
        assert (await _route(ds))["served"] == head + 1, "in place: the version its key holds"
        with _elsewhere():
            await FalkorProjector(graph_client_factory=fake).project_graph(gid)
        assert (await _route(ds))["served"] == head + 2

        dropped = []

        async def _drop(name, provider_id=None):
            dropped.append(name)
        with _elsewhere():                                         # an eviction
            assert await CacheManager(FalkorProjector(graph_client_factory=fake)).evict(
                gid, drop_graph=_drop)
        assert dropped and (await _route(ds))["status"] == "evicted"
        assert (await _route(ds))["served"] is None

        with _elsewhere():                                         # a load, and its end
            async with db.graphver_session() as s:
                (await s.get(ProjectionStateORM, gid)).status = "rehydrating"
        assert (await _route(ds))["status"] == "rehydrating"
        with _elsewhere():
            await FalkorProjector(graph_client_factory=fake).project_graph(gid)
            async with db.graphver_session() as s:
                (await s.get(ProjectionStateORM, gid)).status = "idle"
        assert (await _route(ds))["served"] == head + 2

        with _elsewhere():                                         # a trash
            async with db.graphver_session() as s:
                (await s.get(GraphORM, gid)).deleted_at = _now()
        assert await _route(ds) is None
    _run(case)


def test_a_steady_read_routes_with_no_statement_to_postgres():
    async def case(svc):
        ds, gid = await _graph(svc)
        await FalkorProjector(graph_client_factory=FakeFalkor()).project_graph(gid)
        await _route(ds)
        await _route(ds)                                           # warm
        sent = []

        def record(conn, cursor, statement, params, context, executemany):
            sent.append(statement)
        engines = (db.get_engine().sync_engine, db.get_route_engine().sync_engine)
        for engine in engines:
            event.listen(engine, "before_cursor_execute", record)
        try:
            for _ in range(50):
                assert (await _route(ds))["graph_id"] == gid
        finally:
            for engine in engines:
                event.remove(engine, "before_cursor_execute", record)
        assert sent == [], sent
        # A source with no versioned graph is remembered, too.
        assert await _route("ds_none_" + os.urandom(3).hex()) is None
    _run(case)


def test_an_eviction_its_readers_cannot_be_told_keeps_its_key(monkeypatch):
    async def case(svc):
        ds, gid = await _graph(svc)
        fake = FakeFalkor()
        await FalkorProjector(graph_client_factory=fake).project_graph(gid)
        before = await _route(ds)
        dropped = []

        async def _drop(name, provider_id=None):
            dropped.append(name)

        async def _unheard(*a, **kw):
            return False
        monkeypatch.setattr(route_cache, "announce", _unheard)
        assert not await CacheManager(FalkorProjector(graph_client_factory=fake)).evict(
            gid, drop_graph=_drop)
        assert dropped == []
        async with db.graphver_session() as s:
            ps = await s.get(ProjectionStateORM, gid)
            assert (ps.status, ps.projected_commit_seq) == ("idle", before["projected"])
    _run(case)


def test_a_write_no_process_was_told_of_is_seen_once_the_route_ages_out(monkeypatch):
    monkeypatch.setattr(vconfig, "ROUTE_CACHE_SECS", 0.5)

    async def case(svc):
        ds, gid = await _graph(svc)
        assert (await _route(ds))["read_mode"] == "latest"
        async with db.graphver_session() as s:                     # a raw statement: unnoticed
            await s.execute(text("UPDATE graphver.projection_state SET read_mode = 'beside' "
                                 "WHERE graph_id = :g"), {"g": gid})
        assert (await _route(ds))["read_mode"] == "latest"
        await asyncio.sleep(0.6)
        assert (await _route(ds))["read_mode"] == "beside"
    _run(case)
