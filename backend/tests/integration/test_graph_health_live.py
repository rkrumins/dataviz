"""Signals and a graph's health against Postgres and Redis.

* Counts reach Redis by the hour, with their TTL, in one transaction, and read back by window and
  per graph; a flush Redis refuses keeps them until one lands.
* The sweeps that close idle drafts and remove closed drafts' changes count, for their graphs, the
  drafts the graph store's rows say they closed and cleared.
* The health route composes a real graph's watermark, settings and counts, a fork's from its root,
  and the signals route names the graphs counted most.

Its database is its own, built with the upgrade CLI as ``test_versioned_graph_settings_live.py``
builds one, with the graph store's schema in it. Needs ``GRAPHVER_E2E=1``, ``MANAGEMENT_DB_URL``
(a role that may create databases) and Redis (``REDIS_URL``: its database 14, whose signals this
empties). FalkorDB is not needed: nothing is projected, so the database serves every graph.
"""
from __future__ import annotations

import os
import time
from datetime import datetime, timedelta, timezone
from typing import Iterator
from urllib.parse import urlparse

import pytest
from httpx import ASGITransport, AsyncClient
from sqlalchemy import update

from backend.app.auth.dependencies import get_current_user, get_permission_claims
from backend.app.services.permission_service import PermissionClaims
from backend.app.services.settings import signals
from backend.app.services.versioning import config as gv_config, db as gvdb
from backend.app.services.versioning import models
from backend.app.services.versioning.models import BranchORM
from backend.app.services.versioning.service import GraphVersioningService
from backend.auth_service.interface import User
from backend.tests.integration.test_settings_store_live import (  # noqa: F401 — fixtures
    REDIS_URL, data_source, engines_at, provider, scratch_database, seed, upgrade_cli, workspace)

pytestmark = pytest.mark.skipif(not os.getenv("GRAPHVER_E2E"),
                                reason="set GRAPHVER_E2E=1 + a live Postgres and Redis")

_ROOT = PermissionClaims(sid="sess_live", global_perms=("system:admin",))


def _node(eid: str) -> dict:
    return {"op": "create", "entity_kind": "node", "entity_id": eid,
            "payload": {"entityType": "Dataset", "displayName": eid}}


async def _backdate(branch_id: str, days: int) -> None:
    old = (datetime.now(timezone.utc) - timedelta(days=days)).isoformat()
    async with gvdb.graphver_session() as s:
        await s.execute(update(BranchORM).where(BranchORM.id == branch_id).values(updated_at=old))


@pytest.fixture(scope="module")
def health_db() -> Iterator[str]:
    with scratch_database("graph_health") as name:
        upgrade_cli(name, "upgrade")
        seed(name, workspace("ws_1"), provider(), data_source("ds_sweep", "ws_1"),
             data_source("ds_health", "ws_1", label="Health ledger"))
        yield name


@pytest.fixture
async def graph_store(health_db, engines_at):  # noqa: F811 — a fixture
    """The app's engines on this module's database, with the graph store's schema in it."""
    engines_at(health_db)
    await models.create_schema_and_partitions()
    return GraphVersioningService()


@pytest.fixture
async def counts(monkeypatch):
    """Signals written to Redis database 14, emptied of them before and after."""
    import redis.asyncio as aioredis

    client = aioredis.from_url(urlparse(REDIS_URL)._replace(path="/14").geturl(),
                               decode_responses=True)

    async def empty():
        found = [k async for k in client.scan_iter("sig:*")]
        if found:
            await client.delete(*found)

    await empty()
    monkeypatch.setattr(signals, "_redis", lambda: client)
    signals.reset()
    yield client
    signals.reset()
    await empty()
    await client.aclose()


@pytest.fixture
async def client(graph_store, counts):
    """The app over this module's database, signed in as a system administrator."""
    from backend.app.main import app

    async def current_user():
        return User(id="usr_root", email="usr_root@example.com", first_name="Rosa",
                    last_name="Example", role="user", status="active")

    app.dependency_overrides[get_current_user] = current_user
    app.dependency_overrides[get_permission_claims] = lambda: _ROOT
    async with AsyncClient(transport=ASGITransport(app=app, raise_app_exceptions=False),
                           base_url="http://testserver") as c:
        yield c
    app.dependency_overrides.pop(get_current_user, None)
    app.dependency_overrides.pop(get_permission_claims, None)


async def test_counts_reach_redis_by_the_hour_and_read_back_by_window(counts, monkeypatch):
    now = time.time()
    monkeypatch.setattr(signals, "_clock", lambda: now)
    hour = time.strftime("%Y%m%d%H", time.gmtime(now))
    signals.bump("builds.dropped", graph_id="graph_a")
    signals.bump("builds.dropped", graph_id="graph_a", n=2)
    signals.bump("builds.dropped", graph_id="graph_b")
    signals.bump("drafts.idle_closed", n=3)
    assert await signals.flush() == 3
    assert await counts.hgetall(f"sig:builds.dropped:{hour}") == {"n": "4"}
    assert await counts.hgetall(f"sig:builds.dropped:g:{hour}") == {"graph_a": "3",
                                                                   "graph_b": "1"}
    for key in (f"sig:builds.dropped:{hour}", f"sig:builds.dropped:g:{hour}",
                f"sig:drafts.idle_closed:{hour}"):
        assert 8 * 24 * 3600 - 60 < await counts.ttl(key) <= 8 * 24 * 3600, key
    day = await signals.read("24h")
    assert (day["builds.dropped"]["count"], day["builds.dropped"]["byHour"][-1]) == (4, 4)
    assert day["drafts.idle_closed"]["count"] == 3 and day["reads.asked_to_retry"]["count"] == 0
    assert (await signals.read("7d", graph_id="graph_a"))["builds.dropped"]["count"] == 3
    assert (await signals.top_graphs("1h"))["builds.dropped"] == [("graph_a", 3), ("graph_b", 1)]

    # Redis refuses a flush: the counts wait for the next one, which lands them all.
    import redis.asyncio as aioredis
    from redis.exceptions import ConnectionError as RedisConnectionError

    out_of_reach = aioredis.from_url("redis://127.0.0.1:1/0", socket_connect_timeout=0.2)
    signals.bump("builds.dropped", graph_id="graph_b")
    monkeypatch.setattr(signals, "_redis", lambda: out_of_reach)
    assert await signals.flush() == 0
    with pytest.raises((RedisConnectionError, TimeoutError)):
        await signals.read("24h")
    monkeypatch.setattr(signals, "_redis", lambda: counts)
    assert await signals.flush() == 1
    assert (await signals.read("24h", graph_id="graph_b"))["builds.dropped"]["count"] == 2
    await out_of_reach.aclose()


async def test_the_sweeps_count_the_drafts_they_close_and_clear_for_their_graph(graph_store,
                                                                                 counts):
    svc = graph_store
    gid = (await svc.create_graph(data_source_id="ds_sweep", workspace_id="ws_1",
                                  actor="usr_root"))["graph_id"]
    idle = await svc.open_draft(graph_id=gid, owner="usr_root")
    merged = await svc.open_draft(graph_id=gid, owner="usr_root")
    await svc.stage_changes(graph_id=gid, branch_id=merged, actor="usr_root", ops=[_node("A")])
    await svc.checkpoint(graph_id=gid, branch_id=merged, actor="usr_root")
    await svc.publish(graph_id=gid, branch_id=merged, actor="usr_root", message="ship")
    await _backdate(idle, 40)
    await _backdate(merged, 40)
    assert await svc.sweep_idle_drafts(ttl_days=30, workspace_ids=["ws_1"]) == [idle]
    assert await svc.sweep_idle_drafts(ttl_days=30, workspace_ids=["ws_1"]) == []
    assert await svc.prune_closed_drafts(older_than_days=30, graph_id=gid) == [merged]
    assert await svc.prune_closed_drafts(older_than_days=30, graph_id=gid) == []
    assert await signals.flush() == 2
    mine = await signals.read("24h", graph_id=gid)
    assert (mine["drafts.idle_closed"]["count"], mine["drafts.changes_removed"]["count"]) == (1, 1)


async def test_a_graphs_health_and_the_signals_route_over_a_real_graph(client, graph_store):
    svc = graph_store
    gid = (await svc.create_graph(data_source_id="ds_health", workspace_id="ws_1",
                                  actor="usr_root"))["graph_id"]
    commit = await svc.apply_ops(graph_id=gid, ops=[_node("A")], actor="usr_root",
                                 message="First rows")
    fork = (await svc.fork_graph(parent_graph_id=gid, workspace_id="ws_1",
                                 actor="usr_root"))["graph_id"]
    signals.bump("reads.asked_to_retry", graph_id=gid, n=2)
    signals.bump("imports.replace_refused_by_guard", graph_id=fork)
    signals.bump("imports.replace_refused_by_guard", graph_id=gid, n=5)
    assert await signals.flush() == 3

    got = await client.get(f"/api/v1/ws_1/versioning/graphs/{gid}/health")
    assert got.status_code == 200, got.text
    body = got.json()
    head = (await svc.projection_watermark(gid))["committed"]
    assert body["head"]["seq"] == head and body["head"]["version"]["commitId"] == commit
    assert body["head"]["version"]["message"] == "First rows" and body["head"]["version"]["at"]
    # Never projected: the database serves its readers, at the head.
    assert body["serving"] == {"seq": head, "version": body["head"]["version"],
                               "source": "database"}
    assert body["versionsBehind"] == 0
    assert body["readMode"]["effective"] in ("latest", "in_place", "beside")
    assert body["readMode"]["source"] in ("default", "env", "platform")
    assert (body["memory"]["loaded"], body["memory"]["class"]) == (False, "standard")
    # No build in flight or kept: none switched within the retire grace in force, and no more.
    assert (body["lastBuild"]["outcome"], body["lastBuild"]["windowSecs"]) == (
        "none", gv_config.RETIRE_GRACE_SECS)
    assert body["progress"] is None and body["follows"] is None
    mine = {s["id"]: s["count24h"] for s in body["signals"]}
    assert mine == {**dict.fromkeys(signals.IDS, 0), "reads.asked_to_retry": 2,
                    "imports.replace_refused_by_guard": 5}
    assert [p["part"] for p in body["problems"]] == ["lastUpdate"]

    forked = (await client.get(f"/api/v1/ws_1/versioning/graphs/{fork}/health")).json()
    assert forked["follows"] == {"graphId": gid, "dataSourceId": "ds_health",
                                 "label": "Health ledger"}
    assert forked["head"]["seq"] == head                     # its root's copy, as it reads it
    assert "follows_root" in {w["code"] for w in forked["readMode"]["why"]}
    theirs = {s["id"]: s["count24h"] for s in forked["signals"]}
    assert (theirs["reads.asked_to_retry"], theirs["imports.replace_refused_by_guard"]) == (2, 1)

    listed = (await client.get("/api/v1/admin/versioning/signals",
                               params={"window": "1h"})).json()
    assert listed["unavailable"] is False
    retried = next(s for s in listed["signals"] if s["id"] == "reads.asked_to_retry")
    assert retried["count"] == 2 and retried["byHour"] == [2]
    assert retried["topGraphs"] == [{"graphId": gid, "dataSourceId": "ds_health",
                                     "name": "Health ledger", "count": 2}]
