"""Each place an update's progress is read (``update_progress``), on the unit harness with a Redis in
memory: the watermark (``GET …/versioning/graphs/{g}/watermark``), sync status
(``GET /{ws}/graph/sync-status``), the admin inventory's rows and a graph's health.

* ``progress`` is the update in flight, ``null`` while none is; the time left is derived when read.
* Nothing asks Redis while no update can be in flight (in sync and idle, no build), and the
  inventory reads every row that may have one in a single pipelined round trip.
* A Redis that can't be read leaves ``progress`` null: no request fails for it.
* Health also fills ``lastUpdate`` from the projector's record of its last finished update, checked
  against the graph's last publish.
"""
from __future__ import annotations

import time
from types import SimpleNamespace

import pytest

from backend.app.api.v1.endpoints import graph as graph_ep
from backend.app.api.v1.endpoints import versioning as V
from backend.app.services.system_status import probes
from backend.app.services.versioning import update_progress
from backend.tests.test_update_progress import FakeRedis
from backend.tests.test_versioned_graph_health_api import (  # noqa: F401 — fixtures
    _HEALTH, estate, world)


@pytest.fixture
def redis(monkeypatch):
    fake = FakeRedis()
    monkeypatch.setattr(update_progress, "_redis", lambda: fake)
    update_progress.reset()
    yield fake
    update_progress.reset()


def _iso(epoch: float) -> str:
    return update_progress._iso(epoch)


def _snapshot(**kw) -> dict:
    now = time.time()
    return {"phase": "updating", "unit": "rows", "targetSeq": "8", "targetVersion": "8",
            "startedAt": _iso(now - 120), "updatedAt": _iso(now - 1), "total": "10000",
            "done": "6300", "ratePerSec": "25.000", **kw}


def _wm(**kw) -> dict:
    """A watermark as ``projection_watermark`` answers it."""
    return {"committed": 8, "projected": 7, "fresh": False, "status": "projecting", "served": 7,
            "read_route": {"main": "falkordb", "drafts": "overlay"}, "falkor_provider": None,
            "target": 8, "candidate": None, "read_mode": "in_place", **kw}


class _Svc:
    def __init__(self, wm):
        self.wm = wm

    async def projection_watermark(self, graph_id):
        return dict(self.wm)

    async def get_graph_by_data_source(self, data_source_id):
        return {"graph_id": "g1", "workspace_id": "ws1"}


# ── the watermark ───────────────────────────────────────────────────────────────────────────────

async def test_the_watermark_carries_the_update_in_flight(redis):
    redis.hashes["gvprog:g1"] = _snapshot()
    got = await V.get_watermark("ws1", "g1", _user=None, _meta={}, svc=_Svc(_wm()), session=None)
    progress = got.model_dump(by_alias=True)["progress"]
    assert {k: progress[k] for k in ("phase", "done", "total", "unit", "ratePerSec",
                                     "targetSeq", "targetVersion")} == {
        "phase": "updating", "done": 6300, "total": 10000, "unit": "rows", "ratePerSec": 25.0,
        "targetSeq": 8, "targetVersion": 8}
    # 3,700 rows left at 25 a second, less the second since it was published.
    assert progress["etaSecs"] in (147, 148)
    assert redis.ran == [], "one HGETALL, nothing written"


async def test_an_idle_watermark_in_sync_asks_redis_nothing(redis):
    redis.hashes["gvprog:g1"] = _snapshot()
    calls = []
    original = redis.hgetall

    async def counted(key):
        calls.append(key)
        return await original(key)

    redis.hgetall = counted
    idle = _wm(projected=8, fresh=True, status="idle", served=8)
    got = await V.get_watermark("ws1", "g1", _user=None, _meta={}, svc=_Svc(idle), session=None)
    assert got.progress is None and calls == []
    # A fork's progress is its root's.
    fork = _wm(reads_through="g_root")
    redis.hashes["gvprog:g_root"] = _snapshot(phase="loading")
    got = await V.get_watermark("ws1", "g_fork", _user=None, _meta={}, svc=_Svc(fork),
                                session=None)
    assert got.progress.phase == "loading" and calls == ["gvprog:g_root"]


async def test_a_watermark_whose_progress_cant_be_read_says_none(redis):
    redis.down = True
    got = await V.get_watermark("ws1", "g1", _user=None, _meta={}, svc=_Svc(_wm()), session=None)
    assert got.progress is None and got.committed == 8


# ── sync status ─────────────────────────────────────────────────────────────────────────────────

async def test_sync_status_carries_the_update_in_flight(redis, db_session, monkeypatch):
    from backend.app.services.aggregation import service as aggregation
    from backend.app.services.versioning import service as versioning

    async def no_freshness(*a, **k):
        return SimpleNamespace(rows=[])

    svc = _Svc(_wm(candidate={"id": "build_1", "step": "copying"}, read_mode="beside"))
    monkeypatch.setattr(aggregation, "assemble_fleet_freshness", no_freshness)
    monkeypatch.setattr(versioning.GraphVersioningService, "get_graph_by_data_source",
                        lambda self, ds: svc.get_graph_by_data_source(ds))
    monkeypatch.setattr(versioning.GraphVersioningService, "projection_watermark",
                        lambda self, gid: svc.projection_watermark(gid))
    redis.hashes["gvprog:g1"] = _snapshot(phase="building", total=None, done=None,
                                          ratePerSec=None)
    got = await graph_ep.get_sync_status("ws1", dataSourceId="ds1", session=db_session)
    body = got.model_dump(by_alias=True)
    progress = body["versioned"]["progress"]
    assert (progress["phase"], progress["done"], progress["total"], progress["etaSecs"]) == (
        "building", None, None, None)            # a copy counts no rows: no percentage, no time
    redis.down = True
    got = await graph_ep.get_sync_status("ws1", dataSourceId="ds1", session=db_session)
    assert got.versioned.progress is None


# ── the admin inventory ─────────────────────────────────────────────────────────────────────────

async def test_the_inventory_reads_its_pages_progress_in_one_round_trip(redis, monkeypatch):
    """Of a page, only the rows that may have an update in flight are read, all in one pipeline;
    a fork's progress is its root's row's, and an idle graph in sync, an unloaded one or one
    waiting for room asks nothing."""
    rows = [_row("g_busy", status="projecting", lag=3),
            _row("g_build", candidate_state={"step": "copying"}),
            _row("g_idle"),
            _row("g_out", status="evicted", lag=4),
            _row("g_fork", fork_parent_graph_id="g_busy")]
    redis.hashes["gvprog:g_busy"] = _snapshot()
    reads = await _inventory_progress(rows, monkeypatch)
    assert reads["g_busy"]["done"] == 6300 and reads["g_build"] is None
    assert {k for k, v in reads.items() if v is None} == {"g_build", "g_idle", "g_out", "g_fork"}
    assert redis.ran == [(False, [("hgetall", "gvprog:g_busy"), ("hgetall", "gvprog:g_build")])]
    redis.down = True
    assert all(v is None for v in (await _inventory_progress(rows, monkeypatch)).values())


def _row(gid: str, **kw) -> SimpleNamespace:
    """An inventory row as its query answers it: idle and in sync unless ``kw`` says otherwise."""
    return SimpleNamespace(**{
        "id": gid, "status": "idle", "lag": 0, "candidate_state": None,
        "fork_parent_graph_id": None, "data_source_id": f"ds_{gid}", "workspace_id": "ws1",
        "owns_falkor_graph": True, "read_mode": None, "retired_keys": None,
        "residency": "standard", "evicted_reason": None, "last_read_at": None,
        "size_bytes": None, "rehydrating_since": None, "projected_commit_seq": 3,
        "falkor_graph_name": f"gvt_{gid}", **kw})


async def _inventory_progress(rows, monkeypatch) -> dict:
    """``list_versioned_graphs`` over ``rows`` (its queries stood in for): each row's progress."""
    async def present(**_kw):
        return []

    async def directory(ids):
        return {}

    class _Session:
        async def __aenter__(self):
            return self

        async def __aexit__(self, *exc):
            return False

        async def execute(self, stmt):
            return SimpleNamespace(all=lambda: rows, scalar_one=lambda: len(rows))

    from backend.app.services.versioning import build_policy, candidates, db

    async def resolved():
        return {}

    monkeypatch.setattr(probes, "_present_data_source_ids", present)
    monkeypatch.setattr(probes, "_resolve_data_sources", directory)
    monkeypatch.setattr(probes, "_projection_row", lambda r, info: {"graphId": r.id})
    monkeypatch.setattr(db, "graphver_session", lambda: _Session())
    monkeypatch.setattr(build_policy, "resolve", resolved)
    monkeypatch.setattr(build_policy, "read_mode_for", lambda **k: SimpleNamespace(
        declared=None, effective="latest", source="default", why=()))
    monkeypatch.setattr(candidates, "block", lambda r: None)
    monkeypatch.setattr(probes, "_projection_rows", lambda forks=False: (_Stmt(), None, {}))
    listed = await probes.list_versioned_graphs(provider=None, status=None, workspace_id=None,
                                                kind=None, q=None, cursor=None, limit=50)
    return {g["graphId"]: g["progress"] for g in listed["graphs"]}


class _Stmt:
    """Enough of a select for the inventory to narrow, order and count it."""

    def where(self, *a):
        return self

    def with_only_columns(self, *a):
        return self

    def order_by(self, *a):
        return self

    def limit(self, *a):
        return self


# ── health ──────────────────────────────────────────────────────────────────────────────────────
# Over HTTP on the health harness (its world: graph g_1 serves version 7 of 9, last published at
# 12:30): what it says of the update in flight and of the last one, from the projector's records.

async def test_health_says_the_update_in_flight_and_the_last_one_that_finished(
        world, test_client):  # noqa: F811
    world.redis.hashes["gvprog:g_1"] = _snapshot(targetSeq="9", targetVersion="9")
    world.redis.hashes["gvlast:g_1"] = {
        "finishedAt": "2026-11-16T12:30:00.042000+00:00", "durationSecs": "84.2",
        "rows": "12000", "ratePerSec": "142.518", "seq": "7", "phase": "updating"}
    body = (await test_client.get(_HEALTH.format("g_1"))).json()
    assert (body["progress"]["phase"], body["progress"]["done"], body["progress"]["total"],
            body["progress"]["targetVersion"]) == ("updating", 6300, 10000, 9)
    assert body["progress"]["etaSecs"] is not None
    assert body["lastUpdate"] == {"finishedAt": "2026-11-16T12:30:00.042000+00:00",
                                  "durationSecs": 84.2, "rows": 12000, "ratePerSec": 142.518}
    assert body["problems"] == []


async def test_health_never_shows_an_older_update_as_the_last(world, test_client):  # noqa: F811
    # Version 6's record: version 7's was lost, so the record kept is not the last update.
    world.redis.hashes["gvlast:g_1"] = {
        "finishedAt": "2026-11-16T11:00:00+00:00", "durationSecs": "12.0", "rows": "40",
        "ratePerSec": "3.333", "seq": "6", "phase": "updating"}
    body = (await test_client.get(_HEALTH.format("g_1"))).json()
    assert body["lastUpdate"] is None and body["progress"] is None
    assert body["problems"] == [{"part": "lastUpdate", "message": update_progress.OLDER_RECORD}]
