"""Update progress and time left (``update_progress``) from real projection passes, against Postgres
and Redis, with the in-memory FalkorDB of ``test_versioning_projection``.

* While a pass writes, its snapshot is in Redis (``gvprog:<graph id>``): the phase, the rows done of
  its total, the version it writes, with a TTL; the watermark's ``progress`` reads it back.
* A pass that publishes deletes its snapshot and records the last update (``gvlast:<graph id>``):
  the version, the rows its progress counted, how long it took, with a 30-day TTL. Checked against
  the graph's real watermark, it is the last update; after a later publish whose record is lost, it
  is not shown as one.
* A graph's first seed is ``seeding``; a window into the copy readers read is ``updating``.
* A Redis out of reach fails no pass, and slows none.

Needs ``GRAPHVER_E2E=1``, ``MANAGEMENT_DB_URL`` and Redis (``REDIS_URL``: its database 14, whose
progress keys this empties).
"""
from __future__ import annotations

import asyncio
import os
import time
from urllib.parse import urlparse

import pytest

from backend.app.services.versioning import db, models, update_progress
from backend.app.services.versioning.projection import FalkorProjector
from backend.app.services.versioning.service import GraphVersioningService
from backend.tests.integration.test_versioning_projection import (
    FakeFalkor, FakeGraph, _edit_publish, _node)

pytestmark = pytest.mark.skipif(not os.getenv("GRAPHVER_E2E"),
                                reason="set GRAPHVER_E2E=1 + a live Postgres and Redis")

REDIS_URL = os.getenv("REDIS_URL", "redis://localhost:6380/0")


class SlowGraph(FakeGraph):
    """A FakeGraph each of whose statements takes 20 ms, so a pass lasts long enough to watch."""

    async def query(self, cypher, params=None):
        await asyncio.sleep(0.02)
        return await super().query(cypher, params)


class SlowFalkor(FakeFalkor):
    def __call__(self, name, provider_id=None):
        return self.graphs.setdefault(name, SlowGraph())


def _creates(prefix: str, n: int) -> list:
    return [{"op": "create", "entity_kind": "node", "entity_id": f"{prefix}{i}",
             "payload": _node(f"{prefix} {i}")} for i in range(n)]


async def _redis():
    import redis.asyncio as aioredis

    client = aioredis.from_url(urlparse(REDIS_URL)._replace(path="/14").geturl(),
                               decode_responses=True)

    async def empty():
        found = [k async for k in client.scan_iter("gv*:graph_*")]
        if found:
            await client.delete(*found)

    await empty()
    return client, empty


async def _graph(svc, name: str) -> str:
    created = await svc.create_graph(data_source_id="ds_" + os.urandom(4).hex(),
                                     workspace_id="ws1", actor="alice", falkor_graph_name=name,
                                     owns_falkor_graph=True)
    return created["graph_id"]


async def _settled() -> None:
    for _ in range(200):
        if all(t.done() for t in list(update_progress._writers.values())):
            return
        await asyncio.sleep(0.01)
    raise AssertionError("progress writes still running")


async def _run_progress_while_a_pass_writes() -> None:
    await models.create_schema_and_partitions()
    client, empty = await _redis()
    update_progress.reset()
    saved = (update_progress._redis, update_progress.EVERY_SECS)
    update_progress._redis, update_progress.EVERY_SECS = (lambda: client), 0.1
    try:
        svc, fake = GraphVersioningService(), SlowFalkor()
        proj = FalkorProjector(graph_client_factory=fake, batch_size=2)
        gid = await _graph(svc, "gvt_prog_" + os.urandom(3).hex())
        await _edit_publish(svc, gid, "alice", _creates("A", 4), "seed")
        assert (await proj.project_graph(gid))["projected"] == 2     # the first seed
        await _settled()
        first = await client.hgetall(f"gvlast:{gid}")
        assert (first["seq"], first["phase"], first["rows"]) == ("2", "seeding", "4"), first
        assert await client.exists(f"gvprog:{gid}") == 0

        # A window of 40 changes, written two at a time, 20 ms a statement: watched while it runs.
        await _edit_publish(svc, gid, "alice", _creates("B", 40), "grow")
        head = (await svc.projection_watermark(gid))["committed"]
        task = asyncio.create_task(proj.project_graph(gid))
        seen, read_back = [], None
        while not task.done():
            snap = await client.hgetall(f"gvprog:{gid}")
            if snap:
                seen.append(snap)
                assert 0 < await client.ttl(f"gvprog:{gid}") <= update_progress.TTL_SECS
                wm = await svc.projection_watermark(gid)
                read_back = await update_progress.for_watermark(gid, wm) or read_back
            await asyncio.sleep(0.05)
        assert (await task)["projected"] == head
        await _settled()
        assert seen, "a snapshot was published while the pass wrote"
        assert {s["phase"] for s in seen} == {"updating"}
        assert {s["targetSeq"] for s in seen} == {str(head)} and {s["total"] for s in seen} == {"40"}
        done = [int(s["done"]) for s in seen]
        assert done == sorted(done) and 0 <= done[0] and done[-1] <= 40
        assert read_back is not None and read_back["phase"] == "updating"
        assert read_back["total"] == 40 and read_back["targetVersion"] == head

        assert await client.exists(f"gvprog:{gid}") == 0, "its snapshot goes once it publishes"
        last = await client.hgetall(f"gvlast:{gid}")
        assert (last["seq"], last["phase"], last["rows"]) == (str(head), "updating", "40"), last
        assert float(last["durationSecs"]) > 0.5 and float(last["ratePerSec"]) > 0
        assert 29 * 24 * 3600 < await client.ttl(f"gvlast:{gid}") <= 30 * 24 * 3600

        # Against the real watermark: it is the last update.
        wm = await svc.projection_watermark(gid)
        progress, shown, why = await update_progress.read_health(gid, wm)
        assert progress is None and why is None
        assert shown == {"finishedAt": last["finishedAt"],
                         "durationSecs": float(last["durationSecs"]), "rows": 40,
                         "ratePerSec": float(last["ratePerSec"])}

        # A later publish whose record never reached Redis: the one kept is not shown as the last.
        update_progress._redis = lambda: _OUT_OF_REACH
        await _edit_publish(svc, gid, "alice", _creates("C", 2), "more")
        began = time.monotonic()
        assert (await proj.project_graph(gid))["projected"] == head + 1   # Redis away: it publishes
        assert time.monotonic() - began < 5, "a Redis out of reach slows no pass"
        await _settled()
        update_progress._redis = lambda: client               # back: version head's record is kept
        progress, shown, why = await update_progress.read_health(
            gid, await svc.projection_watermark(gid))
        assert shown is None and why == update_progress.OLDER_RECORD
    finally:
        update_progress._redis, update_progress.EVERY_SECS = saved
        update_progress.reset()
        await empty()
        await client.aclose()
        await db.dispose_engine()


class _OutOfReach:
    """A Redis no command reaches."""

    def pipeline(self, transaction=True):
        return self

    def __getattr__(self, name):
        return lambda *a, **k: self

    async def execute(self):
        raise ConnectionError("Redis is out of reach")


_OUT_OF_REACH = _OutOfReach()


def test_progress_while_a_pass_writes_and_the_last_update_once_it_publishes():
    asyncio.run(_run_progress_while_a_pass_writes())
