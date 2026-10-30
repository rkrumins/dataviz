"""Graph residency against Postgres, Redis and this lane's FalkorDB (doc 17).

Needs ``GRAPHVER_E2E=1`` and the live services; the FalkorDB cases also ``RUN_FALKOR_LIVE=1``.
Each case puts the platform settings row back as it found it.
"""
from __future__ import annotations

import os

import pytest

from sqlalchemy import update

from backend.app.api.v1.endpoints import versioning as V
from backend.app.db.engine import get_async_session
from backend.app.db.models import PlatformSettingsORM
from backend.app.services.versioning import config, db, models, residency, residency_policy
from backend.app.services.versioning.cache_manager import CacheManager
from backend.app.services.versioning.messaging import close_broker_redis, get_broker_redis
from backend.app.services.versioning.models import ProjectionStateORM
from backend.app.services.versioning.projection import FalkorProjector
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
