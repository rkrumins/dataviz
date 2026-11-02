"""Graph residency against Postgres, Redis and this lane's FalkorDB (doc 17).

Needs ``GRAPHVER_E2E=1`` and the live services; the FalkorDB cases also ``RUN_FALKOR_LIVE=1``.
Each case puts the platform settings row back as it found it.
"""
from __future__ import annotations

import asyncio
import json
import os
import time
from datetime import datetime, timedelta, timezone
from types import SimpleNamespace

import pytest
import redis.asyncio as aioredis
from sqlalchemy import func, select, update

from backend.app.api.v1.endpoints import versioning as V
from backend.app.api.v1.endpoints import versioning_admin as va
from backend.app.db.engine import get_async_session
from backend.app.db.models import PlatformSettingsORM
from backend.app.services.feature_flags import feature_flags
from backend.app.services.versioning import config, db, models, residency, residency_policy
from backend.app.services.versioning.cache_manager import CacheManager
from backend.app.services.versioning.messaging import close_broker_redis, get_broker_redis
from backend.app.services.versioning.models import GraphORM, ProjectionStateORM
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


def _switch(on: bool) -> None:
    """Graph residency as this process's flag cache has it: what the API and a projection pass read
    (conftest's ``residency_on`` primes it on)."""
    feature_flags._cache = {**(feature_flags._cache or {}), "residencyEnabled": on}
    feature_flags._cache_ts = time.monotonic()


async def _in_store(on):
    """Graph residency saved in the feature store, as an admin's save leaves it — what the capacity
    pass reads, itself — the registry seeded so that the switch is defined. None takes the saved
    value away. Returns the value saved before (None: none)."""
    from backend.app.db.models import FeatureFlagsORM
    from backend.app.db.seed_feature_registry import seed_feature_registry

    async with get_async_session() as s:
        await seed_feature_registry(s)
        row = await s.get(FeatureFlagsORM, 1)
        if row is None:
            row = FeatureFlagsORM(id=1, config="{}", version=1)
            s.add(row)
        saved = json.loads(row.config or "{}")
        before = saved.get("residencyEnabled")
        if on is None:
            saved.pop("residencyEnabled", None)
        else:
            saved["residencyEnabled"] = on
        row.config = json.dumps(saved)
        await s.commit()
    return before


async def _leader() -> tuple:
    """What the capacity leader keeps of the switch: since when it saw it on, and its phase."""
    async with get_async_session() as s:
        row = await s.get(PlatformSettingsORM, 1)
    if row is None:
        return None, None
    since = row.gv_residency_on_since
    return (datetime.fromisoformat(since) if since else None), row.gv_residency_phase


@pytest.fixture
async def residency_on(residency_on):
    """conftest's ``residency_on``, and in the feature store too, with its grace long over on the
    platform settings row: what the capacity pass reads itself. Each put back after the case."""
    was = await _in_store(True)
    before = await _set_policy(
        gv_residency_on_since=(datetime.now(timezone.utc) - timedelta(days=1)).isoformat(),
        gv_residency_phase="on")
    yield
    await _set_policy(**before)
    await _in_store(was)


@pytest.fixture
async def store():
    from backend.app.services.aggregation import redis_client

    await models.create_schema_and_partitions()
    redis_client._client = None     # the bus client a pass reads reservations with: this loop's
    yield GraphVersioningService()
    residency_policy.invalidate()
    # A case leaves graphs evicted or behind on purpose; in the trash, no later suite's poll
    # (project_pending, a hundred at a time, most behind first) has to work through them.
    async with db.graphver_session() as s:
        await s.execute(update(GraphORM).where(GraphORM.workspace_id == "ws_res",
                                               GraphORM.deleted_at.is_(None))
                        .values(deleted_at=models._now()))
    await close_broker_redis()
    await db.dispose_engine()


async def _residency(gid: str) -> str:
    async with db.graphver_session() as s:
        return (await s.get(ProjectionStateORM, gid)).residency


async def test_a_new_graph_gets_the_class_the_policy_names(store, monkeypatch):
    """With residency on; off, creating a graph reads no policy, and it is Standard."""
    svc = store
    before = await _set_policy(gv_default_residency="coldline")
    try:
        _switch(False)
        off = (await svc.create_graph(data_source_id="ds_" + os.urandom(4).hex(),
                                      workspace_id="ws_res", actor="a"))["graph_id"]
        assert await _residency(off) == "standard"
        _switch(True)
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


async def _seeded(proj, gid: str) -> None:
    """``gid``'s first seed, made at once as with residency off: with it on, a first seed takes
    its turn in the load queue (``test_a_first_seed_is_admitted_as_a_load``)."""
    was = bool((feature_flags._cache or {}).get("residencyEnabled"))
    _switch(False)
    try:
        assert not (await proj.project_graph(gid)).get("skipped")
    finally:
        _switch(was)


async def _resident(svc, proj, provider=None) -> str:
    """A graph with its own platform key, projected (so idle, past genesis, evictable)."""
    gid = (await svc.create_graph(data_source_id="ds_" + _hex(), workspace_id="ws_res",
                                  actor="a", falkor_graph_name="gvt_" + _hex(),
                                  falkor_provider=provider, owns_falkor_graph=True))["graph_id"]
    await _publish(svc, gid, "A")
    await _seeded(proj, gid)
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


async def test_an_evicted_graph_stays_evicted_whatever_asks_for_a_pass(
        store, residency_on, monkeypatch):
    """With residency on, no caller of project_graph reseeds an evicted graph, nor one waiting
    for room: the poll does not pick it, a nudge and project_now skip it, and ensure_rebuilt and
    an operator's rebuild become a request for a load, which admission decides."""
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


@pytest.mark.parametrize("status, after", [
    ("evicted", "evicted"), ("waiting_capacity", "waiting_capacity"),
    ("rehydrating", "evicted"),                  # its load in flight starts again, admitted again
])
async def test_a_move_of_a_graph_out_of_falkordb_changes_only_its_pin(
        store, residency_on, monkeypatch, status, after):
    """Nothing writes to FalkorDB without admission: moving a graph that is not in FalkorDB
    moves its pin, and its load is asked for again; no pass seeds the new key until the load is
    admitted. A load in flight is fenced off (the epoch) and goes back to the queue."""
    svc, fake = store, FakeFalkor()
    proj = FalkorProjector(graph_client_factory=fake)
    gid = await _resident(svc, proj)
    assert await CacheManager(proj).evict(gid, drop_graph=_dropped) is True
    await _set_ps(gid, status=status, projected_commit_seq=1 if status == "rehydrating" else 0)
    epoch = (await _ps(gid)).epoch
    from backend.app.services.versioning import keymigrate
    key = keymigrate.owned_key(gid, 2)
    try:
        res = await svc.move_projection(graph_id=gid, provider=config.DEFAULT_FALKOR_PROVIDER,
                                        key=key, actor="a", shard_map={})
        assert res["changed"] is True
        ps = await _ps(gid)
        assert (ps.falkor_graph_name, ps.status, ps.projected_commit_seq) == (key, after, 0)
        assert ps.epoch > epoch and ps.rehydrating_since is None
        assert await _load_requested(gid)
        assert await _pending(proj, gid) is False
    finally:
        await get_broker_redis().zrem(residency.LOAD_REQUESTS, gid)
        await _set_ps(gid, status="evicted")     # the schema tests narrow ck_proj_status here


async def test_the_watermark_reset_sends_a_load_in_flight_back_to_the_queue(
        store, residency_on, monkeypatch):
    """A reset after a restore reseeds what FalkorDB holds in place; a load in flight is not
    reseeded outside admission: it goes back to the queue, fenced, and is admitted again. A graph
    out of FalkorDB (watermark 0) has nothing to reset."""
    svc, fake = store, FakeFalkor()
    proj = FalkorProjector(graph_client_factory=fake)
    provider = "p_" + _hex()                     # the reset is scoped to it
    resident, loading, out = (await _resident(svc, proj, provider),
                              await _resident(svc, proj, provider),
                              await _resident(svc, proj, provider))
    await _set_ps(loading, status="rehydrating", projected_commit_seq=1)
    assert await CacheManager(proj).evict(out, drop_graph=_dropped) is True
    try:
        assert set(await svc.reset_projection_watermarks(provider=provider, actor="a",
                                                         dry_run=True)) == {resident, loading}
        assert (await _ps(loading)).status == "rehydrating"            # a dry run changes nothing
        assert set(await svc.reset_projection_watermarks(provider=provider, actor="a")) == {
            resident, loading}
        ps = await _ps(resident)
        assert (ps.status, ps.projected_commit_seq) == ("reseeding", 0)
        ps = await _ps(loading)
        assert (ps.status, ps.projected_commit_seq, ps.rehydrating_since) == ("evicted", 0, None)
        assert await _load_requested(loading) and not await _load_requested(out)
        assert not (await proj.project_graph(resident)).get("skipped")    # reseeded in place
        assert (await _ps(resident)).status == "idle"
    finally:
        await get_broker_redis().zrem(residency.LOAD_REQUESTS, resident, loading, out)


async def test_a_fork_is_skipped_as_a_fork_before_residency_s_gate(
        store, residency_on, monkeypatch):
    """A fork has no FalkorDB copy (doc 17 §6): whatever its row says — here an earlier release's
    copy of it, which the count budget evicted — a pass skips it as a fork before residency's gate
    is asked, the poll never picks it, and neither a rebuild nor a read's rebuild asks for a load
    of it, with residency on or off."""
    svc, proj = store, FalkorProjector(graph_client_factory=FakeFalkor())
    root = await _resident(svc, proj)
    fork = (await svc.fork_graph(parent_graph_id=root, workspace_id="ws_res",
                                 actor="a"))["graph_id"]
    await _set_ps(fork, falkor_graph_name=f"gvt_{_hex()}__fork_{fork}", owns_falkor_graph=True,
                  status="evicted", projected_commit_seq=0)
    assert (await proj.project_graph(fork))["skipped"] == "fork"
    assert await CacheManager(proj).ensure_rebuilt(fork) is False
    assert await svc.request_projection_rebuild(fork) is False
    assert not await _load_requested(fork)
    for flag in (True, False):
        _switch(flag)
        assert await _pending(proj, fork) is False
    assert (await _ps(fork)).status == "evicted"


async def test_adopt_moves_the_pin_onto_a_platform_key_and_leaves_the_customer_s_key_alone(
        store, monkeypatch):
    """Adopt swaps the pin to a platform key on the same provider, which the platform owns from
    then, at watermark 0 (reseeding): the customer's key is never retired, and what it held that
    history didn't is no longer flagged — the graph reads its own copy now."""
    from backend.app.services.versioning import keymigrate
    from backend.app.services.versioning.errors import (ProjectionAlreadyAdopted,
                                                        ProjectionKeyInvalid)

    svc, fake = store, FakeFalkor()
    proj = FalkorProjector(graph_client_factory=fake)
    customer = "cust_" + _hex()
    gid = (await svc.create_graph(data_source_id="ds_" + _hex(), workspace_id="ws_res", actor="a",
                                  falkor_graph_name=customer, owns_falkor_graph=False))["graph_id"]
    await _publish(svc, gid, "A")
    await proj.project_graph(gid)
    await _set_ps(gid, external_drift={"at": "2026-10-30T09:00:00+00:00", "nodes": 2, "edges": 0,
                                       "via": "verify"})
    before = await _ps(gid)
    with pytest.raises(ProjectionKeyInvalid):
        await svc.adopt_projection(graph_id=gid, key="other_key", actor="a", shard_map={})
    key = keymigrate.owned_key(gid, 1)
    res = await svc.adopt_projection(graph_id=gid, key=key, actor="a", shard_map={"tag": "t"})
    assert res["from"]["key"] == customer and res["to"]["key"] == key
    assert res["externalDrift"]["nodes"] == 2
    ps = await _ps(gid)
    assert (ps.falkor_graph_name, ps.falkor_provider, ps.owns_falkor_graph) == (
        key, before.falkor_provider, True)
    assert (ps.status, ps.projected_commit_seq, ps.epoch) == ("reseeding", 0, before.epoch + 1)
    assert not ps.retired_keys and ps.external_drift is None and ps.shard_map == {"tag": "t"}
    with pytest.raises(ProjectionAlreadyAdopted):
        await svc.adopt_projection(graph_id=gid, key=keymigrate.owned_key(gid, 2), actor="a",
                                   shard_map={})
    await proj.project_graph(gid)
    assert (await _ps(gid)).status == "idle"


async def test_adopt_waits_for_a_pass_writing_the_customer_s_key(store):
    """Review finding 6: a pass fenced only at its finish would write its window and its marker
    into the customer's key after Adopt committed. Adopt takes the graph's projection lock, as a
    try: while a pass holds it, 409 lock_busy, and nothing changes."""
    from backend.app.services.versioning import keymigrate
    from backend.app.services.versioning.errors import ProjectionPassInFlight

    svc, proj = store, FalkorProjector(graph_client_factory=FakeFalkor())
    gid = (await svc.create_graph(data_source_id="ds_" + _hex(), workspace_id="ws_res", actor="a",
                                  falkor_graph_name="cust_" + _hex(),
                                  owns_falkor_graph=False))["graph_id"]
    await _publish(svc, gid, "A")
    await proj.project_graph(gid)
    before = await _ps(gid)
    async with db.graphver_lock_session() as pass_s:                 # a pass in flight
        lock = func.hashtext(f"gvproj:{gid}")
        assert await pass_s.scalar(select(func.pg_try_advisory_lock(lock)))
        try:
            with pytest.raises(ProjectionPassInFlight) as caught:
                await svc.adopt_projection(graph_id=gid, key=keymigrate.owned_key(gid, 1),
                                           actor="a", shard_map={})
        finally:
            await pass_s.execute(select(func.pg_advisory_unlock(lock)))
    assert (caught.value.status_code, caught.value.detail["type"]) == (409, "lock_busy")
    after = await _ps(gid)
    assert (after.falkor_graph_name, after.owns_falkor_graph, after.epoch) == (
        before.falkor_graph_name, False, before.epoch)
    res = await svc.adopt_projection(graph_id=gid, key=keymigrate.owned_key(gid, 1), actor="a",
                                     shard_map={})
    assert res["to"]["key"] == keymigrate.owned_key(gid, 1)


async def test_a_drop_that_fails_leaves_the_key_to_be_dropped_later(
        store, residency_on, monkeypatch):
    """The graph reads evicted, so nothing would ever drop its key again: it is marked to be
    dropped by the retire pass."""
    svc, fake = store, FakeFalkor()
    proj = FalkorProjector(graph_client_factory=fake)
    gid = await _resident(svc, proj)
    key = (await _ps(gid)).falkor_graph_name

    async def broken(name, provider_id=None):
        raise RuntimeError("LOADING Redis is loading the dataset in memory")

    assert await CacheManager(proj).evict(gid, drop_graph=broken, reason="pressure") is True
    ps = await _ps(gid)
    assert ps.status == "evicted"
    assert [(e["name"], e["movedBy"]) for e in ps.retired_keys] == [(key, "eviction")]


async def test_a_graph_with_no_key_in_falkordb_is_not_in_memory(store, residency_on, monkeypatch):
    """Review finding 8: residencyState read "resident" (In memory) for a graph with no key, and
    for one whose new key a move or an Adopt is writing from nothing (watermark 0)."""
    from backend.app.services.system_status import probes

    svc, proj = store, FalkorProjector(graph_client_factory=FakeFalkor())

    async def states(gid):
        wm = await svc.projection_watermark(gid)
        (row,) = (await probes.list_versioned_graphs(provider=None, status=None, workspace_id=None,
                                                     kind=None, q=gid, cursor=None,
                                                     limit=5))["graphs"]
        return wm["residency_state"], row["residencyState"]

    unpinned = (await svc.create_graph(data_source_id="ds_" + _hex(), workspace_id="ws_res",
                                       actor="a"))["graph_id"]
    assert await states(unpinned) == (None, None)
    gid = await _resident(svc, proj)
    assert await states(gid) == ("resident", "resident")
    await _set_ps(gid, status="reseeding", projected_commit_seq=0)          # a move's new key
    assert await states(gid) == ("rehydrating", "rehydrating")


async def test_an_eviction_never_puts_back_a_watermark_liveness_lowered(
        store, residency_on, monkeypatch):
    """Review finding 11: liveness lowers a graph's watermark without the projection lock. One that
    landed between an eviction's read of the watermark and its compare-and-swap, with a read's
    lease after it, had the eviction put the graph back at the higher watermark, over a key that
    lost what it held. The swap now compares the watermark it read."""
    from backend.app.services.versioning import cache_manager

    svc, proj = store, FalkorProjector(graph_client_factory=FakeFalkor())
    gid = await _resident(svc, proj)
    await get_broker_redis().delete(cache_manager._lease_key(gid))

    async def liveness_resets_then_a_read(ds_id):          # between the read and the swap
        await _set_ps(gid, projected_commit_seq=0, epoch=ProjectionStateORM.epoch + 1)
        await cache_manager.acquire_lease(gid)
        return False

    monkeypatch.setattr(cache_manager, "_rollups_running", liveness_resets_then_a_read)
    try:
        assert await CacheManager(proj).evict(gid, drop_graph=_dropped, reason="pressure") is False
    finally:
        await get_broker_redis().delete(cache_manager._lease_key(gid))
    assert (await _ps(gid)).projected_commit_seq == 0


async def test_a_load_whose_ontology_stays_unreadable_goes_back_to_evicted(
        store, residency_on, monkeypatch):
    """Review 3, finding 3: a load whose ontology cannot be read waits for its summaries, rightly —
    but for good, its key in memory and never evictable (it is not idle). Past 10 passes it goes
    back to evicted (load_stalled) with its key dropped, and the next read asks for it again."""
    from backend.app.services.versioning.projection import UNRESOLVED


    async def unreadable(svc, gid):
        return UNRESOLVED

    async def build(gid, **kw):
        pass

    fake = FakeFalkor()
    svc = store
    gid = await _resident(svc, FalkorProjector(graph_client_factory=fake))
    key = (await _ps(gid)).falkor_graph_name
    proj = FalkorProjector(graph_client_factory=fake, edge_types_resolver=unreadable,
                           on_rollups_stale=build)
    dropped = []

    async def drop(name, provider_id=None):
        dropped.append(name)

    proj.drop_graph = drop
    await _set_ps(gid, status="rehydrating", rehydrating_since=func.now())   # its seed published
    loop = CapacityLoop(proj)
    for _ in range(10):
        await loop.run_once(graph_ids=[gid])
    assert (await _ps(gid)).status == "rehydrating" and dropped == []
    await loop.run_once(graph_ids=[gid])
    ps = await _ps(gid)
    assert (ps.status, ps.evicted_reason, ps.projected_commit_seq) == ("evicted", "load_stalled", 0)
    assert ps.rehydrating_since is None and dropped == [key]


async def test_check_sync_skips_a_graph_out_of_falkordb_and_says_why(
        store, residency_on, monkeypatch):
    """Review finding 10: Check sync scanned an evicted graph's dropped key (everything missing,
    or a 503), and a loading graph's half-written one; an eviction lasts days under residency."""
    from backend.app.services.versioning.reconcile import ProjectionReconciler

    svc, fake = store, FakeFalkor()
    proj = FalkorProjector(graph_client_factory=fake)
    gid = await _resident(svc, proj)
    assert await CacheManager(proj).evict(gid, drop_graph=_dropped) is True
    check = ProjectionReconciler(db.graphver_session, fake)
    for status, why in (("evicted", "out of FalkorDB"), ("waiting_capacity", "out of FalkorDB"),
                        ("rehydrating", "being loaded")):
        await _set_ps(gid, status=status)
        report = await check.reconcile(gid)
        assert why in (report.skipped_reason or ""), (status, report)
        assert report.missing_nodes == [] and report.falkor_nodes == 0


async def test_an_eviction_backs_off_when_a_read_holds_the_graph_after_it_committed(
        store, residency_on, monkeypatch):
    """A read holds the lease before it reads the state; the evictor checks the lease once more
    after its compare-and-swap commits. One whose lease came in between finds the graph as it was,
    key and all; a read that came later reads the evicted state."""
    from backend.app.services.versioning import cache_manager

    svc, fake = store, FakeFalkor()
    proj = FalkorProjector(graph_client_factory=fake)
    gid = await _resident(svc, proj)
    before = await _ps(gid)
    held = iter([False, True])                 # no lease when it looked first; one right after

    async def pinned(graph_id):
        return next(held)

    dropped = []

    async def drop(name, provider_id=None):
        dropped.append(name)

    monkeypatch.setattr(cache_manager, "is_pinned", pinned)
    assert await CacheManager(proj).evict(gid, drop_graph=drop, reason="pressure") is False
    ps = await _ps(gid)
    assert (ps.status, ps.projected_commit_seq, ps.evicted_reason) == (
        "idle", before.projected_commit_seq, None)
    assert ps.epoch > before.epoch and dropped == []


async def test_concurrent_read_flushes_never_wait_on_each_other(store):
    """Another pod's flush holding a row is passed over (its read is as recent as anything this
    one would write), not waited for — so two flushes never deadlock."""
    from sqlalchemy import text as sql

    gids = [await _resident(store, FalkorProjector(graph_client_factory=FakeFalkor()))
            for _ in range(2)]
    async with db.graphver_session() as other:
        await other.execute(sql(
            f'SELECT 1 FROM "{config.graphver_schema()}".projection_state '
            "WHERE graph_id = :g FOR UPDATE"), {"g": gids[0]})
        await _set_ps(gids[1], last_read_at=None)
        residency._READS.update({g: datetime.now(timezone.utc) for g in gids})
        await asyncio.wait_for(residency.flush_reads(), 5)
    assert (await _ps(gids[1])).last_read_at is not None


async def test_the_count_budget_never_evicts_an_always_graph(store):
    """The evictor the count budget used leaves an Always graph alone too, residency on or off (the
    worker no longer runs the count budget at all)."""
    svc, fake = store, FakeFalkor()
    proj = FalkorProjector(graph_client_factory=fake)
    gid = await _resident(svc, proj)
    await _set_ps(gid, residency="always")
    assert await CacheManager(proj).evict(gid, drop_graph=_dropped) is False
    assert (await _ps(gid)).status == "idle"


async def test_with_residency_off_the_poll_never_reseeds_an_evicted_graph_on_its_own(store):
    """Turning residency off brings evicted graphs back through admission, one load per master as
    room allows (the capacity pass's reload, below). The poll reseeding every one at once,
    unadmitted, as it did with the deploy flag off, is gone: no pass reseeds an evicted graph,
    whatever the switch says."""
    svc, proj = store, FalkorProjector(graph_client_factory=FakeFalkor())
    gid = await _resident(svc, proj)
    assert await CacheManager(proj).evict(gid, drop_graph=_dropped) is True
    _switch(False)
    assert await _pending(proj, gid) is False
    assert (await proj.project_graph(gid))["skipped"] == "evicted"
    ps = await _ps(gid)
    assert (ps.status, ps.projected_commit_seq) == ("evicted", 0)


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
    """``n`` graphs projected into real keys, read a moment ago, each measured at 1 byte since its
    projection (so no pass measures it again)."""
    out = []
    for _ in range(n):
        gid = await _resident(svc, proj)
        mine.append(gid)
        now = datetime.now(timezone.utc)
        await _set_ps(gid, last_read_at=now, size_bytes=1, size_measured_at=now)
        out.append(gid)
    return out


def _evicted(p) -> list:
    return [(e.graph_id, e.reason) for e in p.evictions]


def _counting(monkeypatch) -> dict:
    """The counters a pass raises, by name and labels (gauges are not kept)."""
    from backend.app.jobs import metrics

    counted: dict = {}

    class _Sink:
        def increment(self, name, labels, value=1.0):
            key = (name, tuple(sorted(labels.items())))
            counted[key] = counted.get(key, 0) + value

        def gauge_set(self, name, labels, value):
            pass

    monkeypatch.setattr(metrics, "_backend", _Sink())
    return counted


@live
async def test_pressure_evicts_coldline_before_standard_and_never_always(
        store, falkor, mine, residency_on, monkeypatch):
    """At 85 % of maxmemory the master must come down to 70 %: the Coldline graph is enough,
    so the Standard one stays, and the Always one — idle for a month and the largest — is never
    a candidate. The evicted graph stays evicted across the poll."""
    svc, proj = store, FalkorProjector(graph_client_factory=make_falkor_graph_factory())
    cold, std, always = await _live_graphs(svc, proj, mine, 3)
    used = await _used(falkor)
    await _set_ps(cold, residency="coldline", size_bytes=used // 4)
    await _set_ps(std, size_bytes=used // 4)
    await _set_ps(always, residency="always", size_bytes=used,
                  last_read_at=datetime.now(timezone.utc) - timedelta(days=30))
    await falkor.config_set("maxmemory", int(used / 0.85))
    counted = _counting(monkeypatch)
    p = await CapacityLoop(proj).run_once(graph_ids=[cold, std, always])
    assert _evicted(p) == [(cold, "pressure")]
    assert counted == {("versioning_residency_evictions_total", (("reason", "pressure"),)): 1}
    ps = await _ps(cold)
    assert (ps.status, ps.evicted_reason, ps.projected_commit_seq) == ("evicted", "pressure", 0)
    assert ps.falkor_graph_name not in await falkor.execute_command("GRAPH.LIST")
    assert (await _ps(std)).status == "idle" and (await _ps(always)).status == "idle"
    await falkor.config_set("maxmemory", 0)
    await _publish(svc, cold, "B")
    assert await _pending(proj, cold) is False
    assert (await _ps(cold)).status == "evicted"


@live
async def test_the_idle_clock_starts_when_residency_first_runs(
        store, falkor, mine, residency_on, monkeypatch):
    """A graph with no read on record — every graph, the day residency is turned on — is never
    idle: the pass starts its idle clock instead. A graph read daily but last published ten days
    ago is not evicted on the first pass."""
    svc, proj = store, FalkorProjector(graph_client_factory=make_falkor_graph_factory())
    (gid,) = await _live_graphs(svc, proj, mine, 1)
    now = datetime.now(timezone.utc)
    await _set_ps(gid, last_read_at=None,
                  last_projected_at=(now - timedelta(days=10)).isoformat())
    p = await CapacityLoop(proj).run_once(graph_ids=[gid])
    ps = await _ps(gid)
    assert p.evictions == [] and ps.status == "idle"
    assert ps.last_read_at is not None and ps.last_read_at >= now - timedelta(minutes=1)


@live
async def test_a_graph_queued_by_the_loop_is_queued_once_and_keeps_its_place(
        store, falkor, mine, residency_on, monkeypatch):
    """An Always graph out of FalkorDB, or a waiting graph whose request the broker lost, is
    queued once (ZADD NX), not behind every request each pass."""
    svc, proj = store, FalkorProjector(graph_client_factory=make_falkor_graph_factory())
    (gid,) = await _live_graphs(svc, proj, mine, 1)
    assert await CacheManager(proj).evict(gid, drop_graph=proj.drop_graph) is True
    used = await _used(falkor)
    await _set_ps(gid, residency="always", size_bytes=used)       # it waits for room
    await falkor.config_set("maxmemory", used * 2)
    await get_broker_redis().zrem(residency.LOAD_REQUESTS, gid)
    loop = CapacityLoop(proj)
    assert (await loop.run_once(graph_ids=[gid])).waits[0].reason == "capacity"
    first = await get_broker_redis().zscore(residency.LOAD_REQUESTS, gid)
    assert first is not None
    await asyncio.sleep(0.05)
    await loop.run_once(graph_ids=[gid])
    assert await get_broker_redis().zscore(residency.LOAD_REQUESTS, gid) == first


@live
async def test_idle_graphs_go_by_class_and_eviction_off_stops_it(
        store, falkor, mine, residency_on, monkeypatch):
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
async def test_no_eviction_while_a_rollup_job_for_the_source_is_pending_or_running(
        store, falkor, mine, residency_on, monkeypatch):
    """A rollup job writes the graph's key; evicted under it, the key comes back with a summaries
    stamp the next load would trust. Neither the plan nor the evictor takes such a graph."""
    from backend.app.services.aggregation.models import AggregationJobORM

    svc, proj = store, FalkorProjector(graph_client_factory=make_falkor_graph_factory())
    (gid,) = await _live_graphs(svc, proj, mine, 1)
    await _set_ps(gid, residency="coldline",
                  last_read_at=datetime.now(timezone.utc) - timedelta(hours=2))
    ds = (await svc.get_graph(gid))["data_source_id"]
    async with get_async_session() as s:
        job = AggregationJobORM(data_source_id=ds, status="running")
        s.add(job)
        await s.commit()
        job_id = job.id
    try:
        assert (await CapacityLoop(proj).run_once(graph_ids=[gid])).evictions == []
        assert await CacheManager(proj).evict(gid, drop_graph=proj.drop_graph,
                                              reason="idle_coldline") is False
        async with get_async_session() as s:
            (await s.get(AggregationJobORM, job_id)).status = "completed"
            await s.commit()
        assert _evicted(await CapacityLoop(proj).run_once(graph_ids=[gid])) == [
            (gid, "idle_coldline")]
    finally:
        async with get_async_session() as s:
            await s.delete(await s.get(AggregationJobORM, job_id))
            await s.commit()


@live
async def test_a_reload_never_trusts_a_summaries_stamp_left_in_a_key_it_had(
        store, falkor, mine, residency_on, monkeypatch):
    """A rollup job that ran against the evicted key put it back, stamp and all: the load seeds a
    key without it, so the stamp is not taken for this load's summaries."""

    async def lineage(svc, gid):
        return ({"CONTAINS"}, {"FLOWS_TO"}, {}, "shared")

    async def build(gid, **_kw):
        pass

    factory = make_falkor_graph_factory()
    svc = store
    (gid,) = await _live_graphs(svc, FalkorProjector(graph_client_factory=factory), mine, 1)
    proj = FalkorProjector(graph_client_factory=factory, edge_types_resolver=lineage,
                           on_rollups_stale=build)
    old = (await _ps(gid)).falkor_graph_name
    assert await CacheManager(proj).evict(gid, drop_graph=proj.drop_graph) is True
    stale = await factory(old)
    await stale.query("MERGE (m:_AggMeta {id: 'singleton'})")         # the job's stamp
    await residency.request_load(gid)
    loop = CapacityLoop(proj)
    await loop.run_once(graph_ids=[gid])
    await _loads(loop, proj, gid)
    ps = await _ps(gid)
    assert ps.status == "rehydrating" and ps.falkor_graph_name != old
    names = await falkor.execute_command("GRAPH.LIST")
    if old in names:
        await stale.delete()


@live
async def test_each_load_asks_for_its_own_summaries_build_and_asks_again_while_it_waits(
        store, falkor, mine, residency_on, monkeypatch):
    """The rollup hook's ask was keyed by graph and watermark, and the aggregation service
    answers a repeated key within the hour with the job it already ran: a second load at the
    same commit never got its summaries, and stayed rehydrating. Each load asks under its own key
    (its epoch), and asks again under a new one every few passes without the stamp."""
    from backend.app.services.projection_target import make_rollup_rebuild_hook

    keys: list = []

    class _Aggregation:
        async def trigger(self, ds_id, request, source, session):
            keys.append(request.idempotency_key)

    async def lineage(svc, gid):
        return ({"CONTAINS"}, {"FLOWS_TO"}, {}, "shared")

    factory = make_falkor_graph_factory()
    svc = store
    (gid,) = await _live_graphs(svc, FalkorProjector(graph_client_factory=factory), mine, 1)
    proj = FalkorProjector(graph_client_factory=factory, edge_types_resolver=lineage,
                           on_rollups_stale=make_rollup_rebuild_hook(lambda: _Aggregation()))
    loop = CapacityLoop(proj)
    for _ in range(2):                                   # two loads, at the same commit
        assert await CacheManager(proj).evict(gid, drop_graph=proj.drop_graph) is True
        await residency.request_load(gid)
        await loop.run_once(graph_ids=[gid])
        await _loads(loop, proj, gid)
        assert (await _ps(gid)).status == "rehydrating"
        graph = await factory((await _ps(gid)).falkor_graph_name)
        await graph.query("MERGE (m:_AggMeta {id: 'singleton'})")      # the build ran
        await loop.run_once(graph_ids=[gid])
        assert (await _ps(gid)).status == "idle"
    assert len(keys) == 2 and keys[0] != keys[1]
    assert await CacheManager(proj).evict(gid, drop_graph=proj.drop_graph) is True
    await residency.request_load(gid)
    await loop.run_once(graph_ids=[gid])
    await _loads(loop, proj, gid)
    for _ in range(residency._REASK_PASSES):              # no stamp comes
        await loop.run_once(graph_ids=[gid])
    assert len(keys) == 4 and len(set(keys)) == 4


@live
async def test_a_moved_graph_s_old_key_is_dropped_while_the_graph_is_out_of_falkordb(
        store, falkor, mine, residency_on, monkeypatch):
    """Evicted within the move's grace period, the graph's watermark is 0 and never reaches the
    move's: it counts as caught up, since nothing reads the old key then."""
    from backend.app.services.versioning import keymigrate

    svc, proj = store, FalkorProjector(graph_client_factory=make_falkor_graph_factory())
    (gid,) = await _live_graphs(svc, proj, mine, 1)
    old = (await _ps(gid)).falkor_graph_name
    new = keymigrate.owned_key(gid, 1)
    await svc.move_projection(graph_id=gid, provider=config.DEFAULT_FALKOR_PROVIDER, key=new,
                              actor="a", shard_map={})
    await proj.project_graph(gid)
    assert await CacheManager(proj).evict(gid, drop_graph=proj.drop_graph) is True

    async def nobody(provider, name, ds):
        return []

    later = (datetime.now(timezone.utc) + timedelta(days=1)).isoformat()
    out = await keymigrate.retire_moved_keys(proj, key_in_use=nobody, now=later)
    assert [(r["key"], r["verdict"]) for r in out if r["graphId"] == gid] == [(old, "dropped")]
    assert old not in await falkor.execute_command("GRAPH.LIST")


@live
async def test_lowering_the_start_mark_through_the_admin_route_evicts_at_the_next_pass(
        store, falkor, mine, residency_on, monkeypatch):
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
        store, falkor, mine, residency_on, monkeypatch):
    svc, proj = store, FalkorProjector(graph_client_factory=make_falkor_graph_factory())
    (gid,) = await _live_graphs(svc, proj, mine, 1)
    assert await CacheManager(proj).evict(gid, drop_graph=proj.drop_graph) is True
    used = await _used(falkor)
    await _set_ps(gid, size_bytes=used)                    # x1.3 needs more than the 30 % left
    await falkor.config_set("maxmemory", used * 2)
    await residency.request_load(gid)
    loop = CapacityLoop(proj)
    counted = _counting(monkeypatch)
    p = await loop.run_once(graph_ids=[gid])
    assert p.loads == [] and [(w.graph_id, w.reason) for w in p.waits] == [(gid, "capacity")]
    assert (await _ps(gid)).status == "waiting_capacity"
    assert (await loop.run_once(graph_ids=[gid])).waits[0].reason == "capacity"   # tried again
    await falkor.config_set("maxmemory", used * 10)                       # room appears
    p = await loop.run_once(graph_ids=[gid])
    assert [x.graph_id for x in p.loads] == [gid]
    assert counted == {                                      # one wait, counted as it began
        ("versioning_residency_load_waits_total", (("reason", "capacity"),)): 1,
        ("versioning_residency_loads_total", (("outcome", "started"),)): 1}
    ps = await _ps(gid)
    assert (ps.status, ps.projected_commit_seq) == ("rehydrating", 0)
    assert ps.rehydrating_since is not None                  # how long it has been loading
    assert (await svc.projection_watermark(gid))["rehydrating_since"] == ps.rehydrating_since
    assert not await _load_requested(gid)


@live
async def test_a_reload_seeds_a_fresh_key_placed_on_the_master_with_the_most_room(
        store, falkor, mine, residency_on, monkeypatch):
    """Its key went with its eviction: the load pins a fresh platform key that hashes to the
    master the plan chose — here one master, so the first free one — and the key it had goes to
    retired_keys, for the retire pass to drop should the eviction not have. Reads then serve the
    new key."""
    from backend.app.services.versioning import keymigrate

    svc, proj = store, FalkorProjector(graph_client_factory=make_falkor_graph_factory())
    (gid,) = await _live_graphs(svc, proj, mine, 1)
    old = (await _ps(gid)).falkor_graph_name
    assert await CacheManager(proj).evict(gid, drop_graph=proj.drop_graph) is True
    await residency.request_load(gid)
    loop = CapacityLoop(proj)
    p = await loop.run_once(graph_ids=[gid])
    assert [x.graph_id for x in p.loads] == [gid]
    ps = await _ps(gid)
    assert (ps.falkor_graph_name, ps.status) == (keymigrate.owned_key(gid, 1), "rehydrating")
    assert ps.shard_map["chosenBy"] == "residency" and ps.shard_map["master"] == p.loads[0].endpoint
    assert [(e["name"], e["movedBy"]) for e in ps.retired_keys] == [(old, "residency")]
    await _loads(loop, proj, gid)
    ps = await _ps(gid)
    assert ps.status == "idle" and ps.projected_commit_seq == ps.target_commit_seq
    names = await falkor.execute_command("GRAPH.LIST")
    assert keymigrate.owned_key(gid, 1) in names and old not in names
    assert (await svc.projection_watermark(gid))["read_route"]["main"] == "falkordb"


async def _content(graph) -> tuple:
    """What a FalkorDB key holds, to compare: its node and edge counts, and every node's labels and
    properties in order."""
    nodes = (await graph.query("MATCH (n) RETURN count(n)")).result_set[0][0]
    edges = (await graph.query("MATCH ()-[r]->() RETURN count(r)")).result_set[0][0]
    rows = (await graph.query(
        "MATCH (n) RETURN labels(n), properties(n) ORDER BY n.urn, n.name")).result_set
    return nodes, edges, [(sorted(lbl), sorted(props.items())) for lbl, props in rows]


async def _urns(graph) -> set:
    return {r[0] for r in (await graph.query(
        "MATCH (n) WHERE n.urn IS NOT NULL RETURN n.urn")).result_set}


@live
async def test_adopt_never_touches_the_customer_s_key_through_an_eviction_and_a_reload(
        store, falkor, mine, residency_on, monkeypatch):
    """The customer's key holds what another tool wrote and what version control projected there
    before Adopt. After Adopt, and after the platform key is evicted and loaded again, it holds
    exactly that: same counts, same nodes, same properties."""
    from backend.app.services.versioning import keymigrate

    factory = make_falkor_graph_factory()
    svc, proj = store, FalkorProjector(graph_client_factory=factory)
    customer = "cust_" + _hex()
    theirs = await factory(customer)
    await theirs.query(
        "CREATE (:Dataset {urn: 'urn:cust:orders', displayName: 'Orders', owner: 'ops'})"
        "-[:FLOWS_TO {kind: 'etl'}]->(:Dataset {urn: 'urn:cust:revenue', displayName: 'Revenue'})")
    try:
        gid = (await svc.create_graph(data_source_id="ds_" + _hex(), workspace_id="ws_res",
                                      actor="a", falkor_graph_name=customer,
                                      owns_falkor_graph=False))["graph_id"]
        mine.append(gid)
        await _publish(svc, gid, "A", "B")
        await proj.project_graph(gid)          # version control writes their key, until Adopt
        before = await _content(theirs)
        assert {"urn:cust:orders", "urn:cust:revenue", f"urn:{gid}:A"} <= await _urns(theirs)
        key = keymigrate.owned_key(gid, 1)
        await svc.adopt_projection(graph_id=gid, key=key, actor="a", shard_map={})
        await proj.project_graph(gid)          # the platform key, seeded from Postgres
        ps = await _ps(gid)
        assert (ps.falkor_graph_name, ps.owns_falkor_graph, ps.status) == (key, True, "idle")
        assert await _urns(await factory(key)) == {f"urn:{gid}:A", f"urn:{gid}:B"}   # history
        assert await _content(theirs) == before
        assert await CacheManager(proj).evict(gid, drop_graph=proj.drop_graph) is True
        assert await _content(theirs) == before
        await residency.request_load(gid)
        loop = CapacityLoop(proj)
        await loop.run_once(graph_ids=[gid])
        await _loads(loop, proj, gid)
        ps = await _ps(gid)
        assert ps.status == "idle" and keymigrate.is_owned_key(gid, ps.falkor_graph_name)
        assert customer not in {e["name"] for e in ps.retired_keys or []}
        assert await _content(theirs) == before
    finally:
        await theirs.delete()


@live
async def test_a_graph_never_measured_is_estimated_from_its_own_history(
        store, falkor, mine, residency_on, monkeypatch):
    """Its estimate is its nodes and edges at the main head, as graphver counts them, times the
    bytes per entity — not the data source's statistics, which a probe of an evicted key zeroes."""
    svc, proj = store, FalkorProjector(graph_client_factory=make_falkor_graph_factory())
    (gid,) = await _live_graphs(svc, proj, mine, 1)                  # one node in its history
    assert await CacheManager(proj).evict(gid, drop_graph=proj.drop_graph) is True
    await _set_ps(gid, size_bytes=None, size_measured_at=None)
    await residency.request_load(gid)
    decided, _snap = await residency.preview(residency_policy.defaults(), graph_ids=[gid])
    assert [(x.graph_id, x.bytes) for x in decided.loads] == [(gid, 1 * 550)]


@live
async def test_a_key_under_the_measurement_s_resolution_is_left_unmeasured(
        store, falkor, mine, residency_on, monkeypatch):
    """GRAPH.MEMORY USAGE answers in whole MiB, so a small key reads 0: that is no size, and
    the graph keeps its estimate rather than a size of 0."""
    from backend.app.providers.shard_capacity import read_graph_memory

    svc, proj = store, FalkorProjector(graph_client_factory=make_falkor_graph_factory())
    (gid,) = await _live_graphs(svc, proj, mine, 1)
    key = (await _ps(gid)).falkor_graph_name
    client, mode = await residency._provider_client(config.DEFAULT_FALKOR_PROVIDER, key)
    assert await read_graph_memory(client, mode=mode, graph_key=key, timeout=5) == 0
    await _set_ps(gid, size_bytes=None, size_measured_at=None)
    await CapacityLoop(proj).run_once(graph_ids=[gid])
    ps = await _ps(gid)
    assert ps.size_bytes is None and ps.size_measured_at is not None


@live
async def test_a_projected_key_is_measured(store, falkor, mine, residency_on, monkeypatch):
    """A key that was never measured, or was projected since, is measured on the next pass (this
    one is under the reading's resolution, so it has no size)."""
    svc, proj = store, FalkorProjector(graph_client_factory=make_falkor_graph_factory())
    (gid,) = await _live_graphs(svc, proj, mine, 1)
    await _set_ps(gid, size_bytes=5, size_measured_at=None)
    await CapacityLoop(proj).run_once(graph_ids=[gid])
    ps = await _ps(gid)
    assert ps.size_measured_at is not None and ps.size_bytes != 5


async def test_admission_and_its_commit_hold_off_a_pass_and_each_other(
        store, residency_on, monkeypatch):
    """Review finding 2: a move's or an Adopt's admission and its commit are one step against the
    capacity pass and each other (the pass's leader lock), so neither a load the pass starts nor
    another route's write is admitted between the two. A route waits a while for a pass, then
    answers lock_busy."""
    from backend.app.services.versioning.errors import LockBusy

    proj = FalkorProjector(graph_client_factory=FakeFalkor())
    async with residency.admitting():
        assert await CapacityLoop(proj).run_once(graph_ids=[]) is None
        with pytest.raises(LockBusy):
            async with residency.admitting(wait_s=0.3):
                pass
    assert await CapacityLoop(proj).run_once(graph_ids=[]) is not None


async def test_one_pass_at_a_time_across_workers(store, residency_on, monkeypatch):
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
async def test_a_broker_outage_holds_every_graph_and_fails_no_pass(store, falkor, mine,
                                                                   residency_on, monkeypatch):
    """Review finding 13: a pass reads each candidate's read lease from the broker, and an outage
    there raised out of gather: every pass failed, so no load started, and Adopt, move, Always and
    the preview answered 500. A lease that cannot be read now counts as held — nothing is evicted
    for want of it — and the pass goes on."""
    from backend.app.services.versioning import cache_manager

    proj = FalkorProjector(graph_client_factory=make_falkor_graph_factory())
    (gid,) = await _live_graphs(store, proj, mine, 1)
    await _set_ps(gid, last_read_at=datetime.now(timezone.utc) - timedelta(days=30))

    async def down(graph_id):
        raise ConnectionError("Error 111 connecting to the broker")

    monkeypatch.setattr(cache_manager, "is_pinned", down)
    (graph,) = (await residency.gather(graph_ids=[gid])).graphs
    assert graph.leased is True
    decided = await CapacityLoop(proj).run_once(graph_ids=[gid])
    assert decided is not None and decided.evictions == []
    assert (await _ps(gid)).status == "idle"


@live
async def test_a_copy_admitted_is_reserved_until_it_is_released(
        store, falkor, mine, residency_on, monkeypatch):
    """Review 3, finding 4: a package seed's copy was admitted outside the capacity lock and held
    nothing while it was written, so the next pass saw its master free and unreserved. Admitted
    under the lock, its estimate is reserved on its master (the governor's ledger, renewed while
    it runs, gone with a dead holder) and every pass counts it, until it is released."""
    from backend.app.services.aggregation.admission import AggregationAdmission
    from backend.app.services.aggregation.redis_client import get_redis

    proj = FalkorProjector(graph_client_factory=make_falkor_graph_factory())
    (gid,) = await _live_graphs(store, proj, mine, 1)
    ps = await _ps(gid)
    before = {m.endpoint: m.reserved for m in (await residency.gather(graph_ids=[gid])).masters}
    admitted, held = await residency.admit_copy(gid, ps.falkor_provider, ps.falkor_graph_name,
                                                "job_copy_test")
    try:
        assert admitted.fits and held is not None
        after = {m.endpoint: m.reserved for m in (await residency.gather(graph_ids=[gid])).masters}
        assert after[admitted.master] > before[admitted.master]
    finally:
        await AggregationAdmission(get_redis()).release(held)
    released = {m.endpoint: m.reserved for m in (await residency.gather(graph_ids=[gid])).masters}
    assert released[admitted.master] == before[admitted.master]


@live
async def test_a_first_seed_is_admitted_as_a_load(store, falkor, mine, residency_on, monkeypatch):
    """Review finding 12: with residency on, the first seed of a key the platform owns — a new
    graph's whole main, written in one go — was never admitted. It takes its turn in the load
    queue now, and the capacity loop seeds it as a load: onto the master with room for it."""
    proj = FalkorProjector(graph_client_factory=make_falkor_graph_factory())
    gid = (await store.create_graph(data_source_id="ds_" + _hex(), workspace_id="ws_res",
                                    actor="a", falkor_graph_name="gvt_" + _hex(),
                                    owns_falkor_graph=True))["graph_id"]
    mine.append(gid)
    await _publish(store, gid, "A")
    assert (await proj.project_graph(gid))["skipped"] == "waiting_capacity"
    assert (await _ps(gid)).status == "waiting_capacity" and await _load_requested(gid)
    loop = CapacityLoop(proj)
    assert [x.graph_id for x in (await loop.run_once(graph_ids=[gid])).loads] == [gid]
    await _loads(loop, proj, gid)
    ps = await _ps(gid)
    assert ps.status == "idle" and ps.projected_commit_seq == ps.target_commit_seq > 1


@live
async def test_a_first_seed_s_wait_is_logged_and_counted(
        store, falkor, mine, residency_on, monkeypatch, caplog):
    """Review 3, finding 12: a first seed goes straight to waiting_capacity (the projector queues
    it), and a pass logged and counted a wait only as a graph went from evicted to waiting, so a new
    graph's wait was never told. It is, once, with the reason the pass found."""
    proj = FalkorProjector(graph_client_factory=make_falkor_graph_factory())
    gid = (await store.create_graph(data_source_id="ds_" + _hex(), workspace_id="ws_res",
                                    actor="a", falkor_graph_name="gvt_" + _hex(),
                                    owns_falkor_graph=True))["graph_id"]
    mine.append(gid)
    await _publish(store, gid, "A")
    assert (await proj.project_graph(gid))["skipped"] == "waiting_capacity"
    await falkor.config_set("maxmemory", await _used(falkor) * 100 // 80)   # no room under 80 %
    counted = _counting(monkeypatch)
    loop = CapacityLoop(proj)
    with caplog.at_level("WARNING"):
        decided = await loop.run_once(graph_ids=[gid])
        await loop.run_once(graph_ids=[gid])
    assert [(w.graph_id, w.reason) for w in decided.waits] == [(gid, "capacity")]
    assert counted == {("versioning_residency_load_waits_total", (("reason", "capacity"),)): 1}
    assert sum(f"graph {gid} waits for room" in r.getMessage() for r in caplog.records) == 1


@live
async def test_the_retire_pass_drops_a_key_an_eviction_could_not(
        store, falkor, mine, residency_on, monkeypatch):
    """Review finding 3: the graph's own row still names the key its eviction could not drop, and
    the retire pass kept it for that ("PROTECTED: graph … projects into it") and forgot it, so the
    key held its memory for good. Out of FalkorDB — evicted, or waiting for room — nothing writes
    or reads it, and the pass holds the graph's projection lock: it is dropped."""
    from backend.app.services.versioning import keymigrate

    proj = FalkorProjector(graph_client_factory=make_falkor_graph_factory())

    async def broken(name, provider_id=None):
        raise RuntimeError("LOADING Redis is loading the dataset in memory")

    async def nobody(provider, name, ds_id):
        return []

    for out in ("evicted", "waiting_capacity"):
        (gid,) = await _live_graphs(store, proj, mine, 1)
        key = (await _ps(gid)).falkor_graph_name
        assert await CacheManager(proj).evict(gid, drop_graph=broken, reason="pressure") is True
        await _set_ps(gid, status=out)
        assert await falkor.exists(key)
        retired = [r for r in await keymigrate.retire_moved_keys(proj, key_in_use=nobody)
                   if r["graphId"] == gid]
        assert [(r["key"], r["verdict"]) for r in retired] == [(key, "dropped")], retired
        assert not await falkor.exists(key) and not (await _ps(gid)).retired_keys


@live
@pytest.mark.parametrize("residency_class", ["standard", "always"])
async def test_a_key_the_master_lost_is_evicted_not_reseeded_outside_admission(
        store, falkor, mine, residency_on, monkeypatch, residency_class):
    """A master that restarts without its data loses every key it held, and liveness used to
    lower them all to 0 for the poll to reseed at once, unadmitted. With residency on such a graph
    is evicted (lost): a Standard one loads on its next read, an Always one is queued by the next
    pass, and each load is admitted like any other."""
    factory = make_falkor_graph_factory()
    svc, proj = store, FalkorProjector(graph_client_factory=factory)
    (gid,) = await _live_graphs(svc, proj, mine, 1)
    await _publish(svc, gid, "B")
    await proj.project_graph(gid)                        # past genesis, a marker at seq 3
    await _set_ps(gid, residency=residency_class)
    await (await factory((await _ps(gid)).falkor_graph_name)).delete()      # the master lost it
    await proj.check_liveness()
    ps = await _ps(gid)
    assert (ps.status, ps.evicted_reason, ps.projected_commit_seq) == ("evicted", "lost", 0)
    assert await _pending(proj, gid) is False
    if residency_class == "always":
        await get_broker_redis().zrem(residency.LOAD_REQUESTS, gid)
        decided = await CapacityLoop(proj).run_once(graph_ids=[gid])
        assert [x.graph_id for x in decided.loads] == [gid]


@live
async def test_a_read_holds_its_graph_before_the_engine_reads_the_watermark(
        store, falkor, mine, plain_engine, residency_on, monkeypatch):
    from backend.app.services.versioning import cache_manager
    from backend.app.services.versioning.service import GraphVersioningService, Viewer

    svc, proj = store, FalkorProjector(graph_client_factory=make_falkor_graph_factory())
    (gid,) = await _live_graphs(svc, proj, mine, 1)
    ds = (await svc.get_graph(gid))["data_source_id"]
    await get_broker_redis().delete(cache_manager._lease_key(gid))
    getattr(residency, "_HELD", {}).clear()
    held_then = []
    real = GraphVersioningService.projection_watermark

    async def watermark(self, graph_id):
        held_then.append(await cache_manager.is_pinned(graph_id))
        return await real(self, graph_id)

    monkeypatch.setattr(GraphVersioningService, "projection_watermark", watermark)
    assert await _served_by(plain_engine, ds, Viewer(actor="usr_1", can_read=True)) == "falkordb"
    assert held_then and all(held_then)


@live
async def test_a_read_reloads_a_standard_graph(
        store, falkor, mine, plain_engine, residency_on, monkeypatch):
    """Reads are served from Postgres while the graph is evicted and while it loads, and from
    FalkorDB once its key holds everything again."""
    from backend.app.services.versioning.service import Viewer

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
async def test_a_deep_search_loads_a_coldline_graph(
        store, falkor, mine, plain_engine, residency_on, monkeypatch):
    """Coldline: a canvas read of a small graph stays on Postgres and loads nothing, but deep
    search needs FalkorDB — 503 graph_loading with Retry-After, and the load asked for — and
    answers once the graph is loaded."""
    from httpx import ASGITransport, AsyncClient

    from backend.tests.integration.test_api_graph_draft_journey import _build_app

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
        store, falkor, mine, residency_on, monkeypatch):
    """A graph whose ontology has lineage needs the summaries a build stamps into its key: its
    load stays rehydrating (reads on Postgres) until the stamp is there, and the build is asked
    for meanwhile."""
    asked: list = []

    async def lineage(svc, gid):
        return ({"CONTAINS"}, {"FLOWS_TO"}, {}, "shared")

    async def build(gid, **_kw):
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
    counted = _counting(monkeypatch)
    await loop.run_once(graph_ids=[gid])
    ps = await _ps(gid)
    assert (ps.status, ps.rehydrating_since) == ("idle", None)
    assert counted == {("versioning_residency_loads_total", (("outcome", "completed"),)): 1}
    assert (await svc.projection_watermark(gid))["fresh"] is True


# ── forks: no key of their own; they read through their root's store ────────────────────────────
@live
async def test_a_fork_has_no_residency_of_its_own(store, residency_on, monkeypatch):
    """A fork has no key (doc 17 §6). Its watermark is its root's, so the root's residency state
    shows through ``readsThrough``, with no class of the fork's own; and what the capacity loop
    reads — which its policy preview and its metrics read too — never counts a fork, not even one
    an earlier release's copy is still pinned to."""
    svc, proj = store, FalkorProjector(graph_client_factory=FakeFalkor())
    root = await _resident(svc, proj)
    fork = (await svc.fork_graph(parent_graph_id=root, workspace_id="ws_res",
                                 actor="a"))["graph_id"]
    await _set_ps(fork, falkor_graph_name=f"gvt_{_hex()}__fork_{fork}", owns_falkor_graph=True)
    assert await CacheManager(proj).evict(root, drop_graph=_dropped) is True
    wm = await svc.projection_watermark(fork)
    assert (wm["reads_through"], wm["residency"], wm["residency_state"]) == (root, None, "evicted")
    out = (await V._watermark_model(None, wm)).model_dump(by_alias=True)
    assert (out["readsThrough"], out["residency"], out["residencyState"]) == (root, None, "evicted")
    assert [g.graph_id for g in (await residency.gather(graph_ids=[root, fork])).graphs] == [root]


@pytest.fixture
async def forked(store):
    """``make(projector)``: a root made as a data source on this lane's FalkorDB provider, its
    graph pinned to the data source's key and projected, and a fork of it made as the fork route
    makes one — ``(root data source, root graph, fork data source, fork graph)``. Making it needs
    the Forks switch; the case then reads it with the switch off, as reading a fork does not. Both
    graphs are in the trash after the case, and out of the load queue."""
    from backend.app.services.feature_flags import feature_flags
    from backend.tests.integration.test_fork_data_sources import _client, _fork, _parent

    made: list = []

    async def make(proj):
        root_ds, root = await _parent(store, pinned=True)
        made.append(root)
        await _publish(store, root, "A")
        await _seeded(proj, root)
        flags = dict(feature_flags._cache or {})
        feature_flags._cache, feature_flags._cache_ts = ({**flags, "forksEnabled": True},
                                                         time.monotonic())
        try:
            async with _client() as c:
                fork = (await _fork(c, root)).json()
        finally:
            feature_flags._cache = {**flags, "forksEnabled": False}
        made.append(fork["graphId"])
        return root_ds, root, fork["dataSourceId"], fork["graphId"]

    yield make
    if made:
        async with db.graphver_session() as s:
            await s.execute(update(GraphORM).where(GraphORM.id.in_(made),
                                                   GraphORM.deleted_at.is_(None))
                            .values(deleted_at=models._now()))
        await get_broker_redis().zrem(residency.LOAD_REQUESTS, *made)


@pytest.fixture
def fork_engine(monkeypatch):
    """ContextEngine with ontology resolution stubbed: a fork's engine is built before any
    write-through, and only which store its reads go through is under test here."""
    from backend.app.services.context_engine import ContextEngine

    async def nothing(*a, **kw):
        return None

    monkeypatch.setattr(ContextEngine, "_resolve_ontology", nothing)
    return ContextEngine


async def _fork_engine(engine_cls, ds: str, viewer):
    """The engine a request on the fork's data source ``ds`` builds; its root's FalkorDB provider is
    the registry's stub, which serves any key."""
    async with db.graphver_session() as session:
        return await engine_cls.for_workspace("ws_forks", _Registry(), session,
                                              data_source_id=ds, viewer=viewer)


def _through(engine) -> str:
    """Which of its root's stores a fork's read goes through: the root's FalkorDB provider, or the
    root's Postgres reader."""
    return "falkordb" if isinstance(engine.provider._base, _LiveProvider) else "postgres"


async def _loading(root: str) -> None:
    """The root's load seeded its key to its head, but the key does not serve reads yet."""
    await _set_ps(root, status="rehydrating",
                  projected_commit_seq=(await GraphVersioningService().projection_watermark(
                      root))["committed"])


async def _past_the_ceiling(svc, fork: str, monkeypatch) -> None:
    """The fork changed more than ``GRAPHVER_FORK_REWIND_MAX`` entities: it reads its own rows."""
    await svc.apply_ops(graph_id=fork, actor="a", message="own", ops=[
        {"op": "create", "entity_kind": "node", "entity_id": "N",
         "payload": {"urn": f"urn:{fork}:N", "displayName": "N", "entityType": "Dataset"}}])
    monkeypatch.setattr(config, "FORK_REWIND_MAX", 0)


@pytest.mark.parametrize("residency_class, loads", [("standard", True), ("always", True),
                                                    ("coldline", False)])
async def test_a_person_s_read_of_a_fork_counts_for_its_root_and_asks_for_its_load(
        store, forked, fork_engine, residency_on, monkeypatch, residency_class, loads):
    """A person's read of a fork holds its root's read lease and counts for its root, as it reads
    through the root's FalkorDB store. With the root out of FalkorDB the fork reads the root's
    Postgres, and the read asks for the root's load — a Standard or an Always one's; a small
    Coldline root waits for work only FalkorDB can do. While the root's load is not done the fork
    reads Postgres, as reads of the root do. A fork past the ceiling reads its own rows in
    Postgres, nothing of its root's: its read holds nothing, counts for nothing, and asks for no
    load."""
    from backend.app.providers.versioned_branch_provider import VersionedBranchProvider
    from backend.app.services.versioning import cache_manager
    from backend.app.services.versioning.service import Viewer

    proj = FalkorProjector(graph_client_factory=FakeFalkor())
    _root_ds, root, fork_ds, fork = await forked(proj)
    reader, broker = Viewer(actor="usr_reader", can_read=True), get_broker_redis()
    await broker.delete(cache_manager._lease_key(root), cache_manager._lease_key(fork))
    residency._HELD.clear()
    residency._READS.clear()

    assert _through(await _fork_engine(fork_engine, fork_ds, reader)) == "falkordb"
    assert await cache_manager.is_pinned(root) and not await cache_manager.is_pinned(fork)
    assert set(residency._READS) == {root}
    await residency.flush_reads()
    assert (await _ps(root)).last_read_at is not None and (await _ps(fork)).last_read_at is None

    await broker.delete(cache_manager._lease_key(root))
    assert await CacheManager(proj).evict(root, drop_graph=_dropped) is True
    await _set_ps(root, residency=residency_class)       # out of FalkorDB, whatever put it out
    assert _through(await _fork_engine(fork_engine, fork_ds, reader)) == "postgres"
    assert await _load_requested(root) is loads and not await _load_requested(fork)
    await _loading(root)
    assert _through(await _fork_engine(fork_engine, fork_ds, reader)) == "postgres"
    await _set_ps(root, status="idle")
    assert _through(await _fork_engine(fork_engine, fork_ds, reader)) == "falkordb"

    await _past_the_ceiling(store, fork, monkeypatch)
    await _set_ps(root, status="evicted", projected_commit_seq=0)
    await broker.delete(cache_manager._lease_key(root))
    await broker.zrem(residency.LOAD_REQUESTS, root)
    residency._HELD.clear()
    residency._READS.clear()
    residency.READING.set(None)
    engine = await _fork_engine(fork_engine, fork_ds, reader)
    assert isinstance(engine.provider, VersionedBranchProvider) and engine.provider._gid == fork
    assert not await cache_manager.is_pinned(root) and residency._READS == {}
    assert not await _load_requested(root) and residency.READING.get() is None


async def test_falkordb_only_work_on_a_fork_answers_as_its_root_would(
        store, forked, fork_engine, residency_on, monkeypatch):
    """Deep search on a fork runs in its root's store. While the root is out of FalkorDB — evicted,
    or loading until its key serves reads — it answers as a search of the root would: 503
    graph_loading with Retry-After, asking for the root's load (a Coldline root's too), and
    ``non_resident`` names the root (a native query on a fork is 501 whatever the root's state:
    test_native_query_api). Once the root is loaded, the fork's own rules again: its search runs
    in the root's store, its note saying the fork's own changes are not in it. A fork past the ceiling reads
    nothing of its root's: its search is the fork's 501 whatever the root's state, and asks for
    no load."""
    from httpx import ASGITransport, AsyncClient

    from backend.app.providers.draft_overlay_provider import FORK_SEARCH_NOTE
    from backend.app.services.versioning.service import Viewer
    from backend.tests.integration.test_api_graph_draft_journey import _build_app

    proj = FalkorProjector(graph_client_factory=FakeFalkor())
    _root_ds, root, fork_ds, fork = await forked(proj)
    await _set_ps(root, residency="coldline")
    app, graph_routes = _build_app()
    monkeypatch.setattr(graph_routes, "provider_manager", _Registry())
    path = f"/api/v1/ws_forks/graph/search/discover?dataSourceId={fork_ds}"
    async with AsyncClient(transport=ASGITransport(app=app), base_url="http://test") as client:
        assert (await client.get(path)).json()["served"] == "falkordb"
        assert await residency.non_resident(fork_ds) is None
        await get_broker_redis().delete(f"versioning:lease:{root}")        # the read's lease ends
        assert await CacheManager(proj).evict(root, drop_graph=_dropped) is True
        for out in ("evicted", "rehydrating"):
            if out == "rehydrating":
                await _loading(root)
            await get_broker_redis().zrem(residency.LOAD_REQUESTS, root)
            r = await client.get(path)
            assert r.status_code == 503, (out, r.text)
            assert r.json()["detail"]["type"] == "graph_loading" and r.headers["Retry-After"]
            for _ in range(50):
                if await _load_requested(root):
                    break
                await asyncio.sleep(0.02)
            assert await _load_requested(root)
            assert await residency.non_resident(fork_ds) == root
        await _set_ps(root, status="idle")
        r = await client.get(path)
        assert r.status_code == 200 and r.json()["served"] == "falkordb"
        reader = Viewer(actor="usr_reader", can_read=True)
        engine = await _fork_engine(fork_engine, fork_ds, reader)
        assert engine.provider.search_scope_note == FORK_SEARCH_NOTE
        assert await residency.non_resident(fork_ds) is None

        await _past_the_ceiling(store, fork, monkeypatch)
        await _set_ps(root, status="evicted", projected_commit_seq=0)
        await get_broker_redis().zrem(residency.LOAD_REQUESTS, root)
        r = await client.get(path)
        assert r.status_code == 501 and "fork" in r.text, r.text
        await asyncio.sleep(0.1)                     # what a refusal would ask for, asked by now
        assert not await _load_requested(root)
        assert await residency.non_resident(fork_ds) is None


async def test_a_fork_never_serves_an_answer_cached_from_its_root_s_evicted_key(
        store, forked, fork_engine, residency_on, monkeypatch):
    """A fork's cached answers are keyed by the store it read and that store's seqs
    (``_cache_scope``). Evicting its root moves the key — the root's projected seq goes to 0, the
    reads to Postgres — and it stays moved while the root's load is not done, so no answer built
    on the evicted key is served meanwhile. Loaded again onto its key at the same seqs, the root
    holds what the answers were built on."""
    from backend.app.api.v1.endpoints.graph import _cache_scope
    from backend.app.services.versioning.service import Viewer

    proj = FalkorProjector(graph_client_factory=FakeFalkor())
    _root_ds, root, fork_ds, _fork = await forked(proj)
    reader = Viewer(actor="usr_reader", can_read=True)

    async def scope():
        return _cache_scope(await _fork_engine(fork_engine, fork_ds, reader))

    resident = await scope()
    assert await scope() == resident
    await get_broker_redis().delete(f"versioning:lease:{root}")
    assert await CacheManager(proj).evict(root, drop_graph=_dropped) is True
    assert await scope() != resident
    await _loading(root)
    assert await scope() != resident
    await _set_ps(root, status="idle")
    assert await scope() == resident


async def test_what_residency_adds_to_a_person_s_read(store, forked, fork_engine):
    """Warm, a person's read costs the same statements with residency on or off: whether the
    graph's key is in FalkorDB is read from the watermark the read loads anyway — reads never
    depend on the switch. A fork's read plan reads its root's state before anything holds it; with
    residency on, the root's read lease is then held and its state read once more, after the hold.
    The read lease and the read's note cost none: the broker at most every 30 seconds, and
    memory."""
    from sqlalchemy import event

    from backend.app.services.versioning.service import Viewer

    proj = FalkorProjector(graph_client_factory=FakeFalkor())
    root_ds, _root, fork_ds, _fork = await forked(proj)
    reader = Viewer(actor="usr_reader", can_read=True)

    async def cost(ds: str, on: bool) -> int:
        _switch(on)
        await _fork_engine(fork_engine, ds, reader)               # warm, the lease held
        sent: list = []

        def record(conn, cursor, statement, *_):
            sent.append(statement)

        engine = db.get_engine().sync_engine
        event.listen(engine, "before_cursor_execute", record)
        try:
            await _fork_engine(fork_engine, ds, reader)
        finally:
            event.remove(engine, "before_cursor_execute", record)
        return len(sent)

    assert await cost(root_ds, True) == await cost(root_ds, False)
    assert await cost(fork_ds, True) == await cost(fork_ds, False) + 1


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


# ── the switch, as each capacity pass reads it ──────────────────────────────────────────────────
_LIFECYCLE = ("platform.residency.grace_started", "platform.residency.evictions_allowed",
              "platform.residency.turned_off", "platform.residency.reload_finished")


async def _events(*types: str, since: str) -> list:
    """The activity events of these types recorded since ``since``, oldest first: (type, payload)."""
    from backend.app.db.models import OutboxEventORM

    async with get_async_session() as s:
        rows = (await s.execute(
            select(OutboxEventORM).where(OutboxEventORM.event_type.in_(types),
                                         OutboxEventORM.created_at >= since)
            .order_by(OutboxEventORM.created_at))).scalars().all()
    return [(r.event_type, json.loads(r.payload)) for r in rows]


async def test_a_switch_that_cannot_be_read_evicts_and_loads_nothing(
        store, residency_on, monkeypatch):
    """The worker takes no decision it cannot undo on a switch it could not read: the pass does
    nothing — no eviction, no load — and leaves what the leader keeps of the switch as it is."""
    from backend.app.services.feature_flags import FeatureFlagService

    svc, proj = store, FalkorProjector(graph_client_factory=FakeFalkor())
    idle, out = await _resident(svc, proj), await _resident(svc, proj)
    assert await CacheManager(proj).evict(out, drop_graph=_dropped) is True
    await _set_ps(idle, residency="coldline",
                  last_read_at=datetime.now(timezone.utc) - timedelta(days=30))
    await residency.request_load(out)

    async def unreadable(*_a, **_kw):
        raise ConnectionError("the management database is down")

    monkeypatch.setattr(FeatureFlagService, "is_enabled", unreadable)
    before = await _leader()
    try:
        assert await CapacityLoop(proj).run_once(graph_ids=[idle, out]) is None
        assert (await _ps(idle)).status == "idle" and (await _ps(out)).status == "evicted"
        assert await _leader() == before
    finally:
        await get_broker_redis().zrem(residency.LOAD_REQUESTS, out)


async def test_the_leader_starts_the_grace_ends_it_and_clears_it_with_no_restart(store):
    """One capacity loop, never restarted, follows an admin's switch pass by pass. Seeing it on, the
    leader starts the grace period on the platform settings row — and every graph's idle clock,
    since reads are not noted while it is off; GRACE_SECS later it ends it, once. Seeing it off, it
    clears it and brings back what is out of FalkorDB until nothing is; then the pass idles."""
    svc, proj = store, FalkorProjector(graph_client_factory=FakeFalkor())
    gid = await _resident(svc, proj)
    await _set_ps(gid, last_read_at=datetime.now(timezone.utc) - timedelta(days=7))
    assert await residency.out_of_falkordb() == 0, "the store holds graphs out of FalkorDB already"
    t0 = models._now()
    was = await _in_store(False)
    before = await _set_policy(gv_residency_on_since=None, gv_residency_phase=None)
    loop = CapacityLoop(proj)
    try:
        assert await loop.run_once(graph_ids=[]) is None          # off, nothing out: it idles
        assert await _leader() == (None, None)

        await _in_store(True)                                     # an admin turns it on
        started = datetime.now(timezone.utc)
        assert await loop.run_once(graph_ids=[]) is not None
        since, phase = await _leader()
        assert phase == "grace" and since >= started - timedelta(seconds=1)
        assert (await _ps(gid)).last_read_at >= started - timedelta(seconds=1)
        await loop.run_once(graph_ids=[])
        assert await _leader() == (since, "grace")                # started once
        ended = since - timedelta(seconds=residency_policy.GRACE_SECS + 1)
        await _set_policy(gv_residency_on_since=ended.isoformat())
        await loop.run_once(graph_ids=[])
        assert await _leader() == (ended, "on")

        assert await CacheManager(proj).evict(gid, drop_graph=_dropped) is True
        await _in_store(False)                                    # and off again
        assert await loop.run_once(graph_ids=[]) is not None
        assert await _leader() == (None, "reloading")
        ps = await _ps(gid)                                       # its load done, as a pass ends one
        await _set_ps(gid, status="idle", projected_commit_seq=ps.target_commit_seq)
        assert await loop.run_once(graph_ids=[]) is None
        assert await _leader() == (None, None)
        assert await loop.run_once(graph_ids=[]) is None

        # Each change in the activity log once, as the system's, filed under the switch.
        events = await _events(*_LIFECYCLE, since=t0)
        assert [(t, p.get("details")) for t, p in events] == [
            ("platform.residency.grace_started", {
                "onSince": since.isoformat(), "graceSecs": residency_policy.GRACE_SECS,
                "evictionsFrom": (since + timedelta(seconds=residency_policy.GRACE_SECS))
                .isoformat()}),
            ("platform.residency.evictions_allowed", {"onSince": ended.isoformat()}),
            ("platform.residency.turned_off", {"toBringBack": 1}),
            ("platform.residency.reload_finished", None),
        ]
        assert all("actor_id" not in p and p["target_label"] == "Graph residency"
                   for _t, p in events)
    finally:
        await _set_policy(**before)
        await _in_store(was)


@live
async def test_no_eviction_within_the_grace_period_and_eviction_after_it(
        store, falkor, mine, residency_on):
    """The first eviction waits GRACE_SECS after the leader first saw the switch on — anchored on
    the platform settings row, so the same for every worker and across restarts — by which time
    every API process takes read leases and notes reads. Loads and admission go on meanwhile."""
    svc, proj = store, FalkorProjector(graph_client_factory=make_falkor_graph_factory())
    (cold,) = await _live_graphs(svc, proj, mine, 1)
    await _set_ps(cold, residency="coldline",
                  last_read_at=datetime.now(timezone.utc) - timedelta(hours=2))
    t0 = models._now()
    now = datetime.now(timezone.utc)
    await _set_policy(gv_residency_on_since=now.isoformat(), gv_residency_phase="grace")
    loop = CapacityLoop(proj)
    p = await loop.run_once(graph_ids=[cold])
    assert p.evictions == [] and (await _ps(cold)).status == "idle"
    assert await _leader() == (now, "grace")
    ended = now - timedelta(seconds=residency_policy.GRACE_SECS + 1)
    await _set_policy(gv_residency_on_since=ended.isoformat())
    p = await loop.run_once(graph_ids=[cold])
    assert _evicted(p) == [(cold, "idle_coldline")]
    assert await _leader() == (ended, "on")
    assert [t for t, _p in await _events(*_LIFECYCLE, since=t0)] == [
        "platform.residency.evictions_allowed"]
    meta = await svc.get_graph(cold)
    (evicted,) = [p["details"] for _t, p in await _events("platform.versioning.graph_evicted",
                                                          since=t0)
                  if p["details"]["graphId"] == cold]
    assert evicted == {"graphId": cold, "workspaceId": "ws_res",
                       "dataSourceId": meta["data_source_id"], "master": p.evictions[0].endpoint,
                       "bytes": p.evictions[0].bytes, "reason": "idle_coldline"}


@live
async def test_turned_off_it_brings_evicted_graphs_back_through_admission_one_at_a_time(
        store, falkor, mine):
    """Off, a pass only loads: every evicted graph, through the load queue and admission — one load
    per master at a time, as room allows — and evicts nothing, not even an idle Coldline graph.
    No pass reseeds one on its own meanwhile, and its reads go to Postgres until it is back."""
    svc, proj = store, FalkorProjector(graph_client_factory=make_falkor_graph_factory())
    first, second, cold = await _live_graphs(svc, proj, mine, 3)
    for gid in (first, second):
        assert await CacheManager(proj).evict(gid, drop_graph=proj.drop_graph) is True
    await _set_ps(cold, residency="coldline",
                  last_read_at=datetime.now(timezone.utc) - timedelta(days=30))
    assert await residency.out_of_falkordb() == 2
    t0 = models._now()
    was = await _in_store(False)
    before = await _set_policy(                                   # it was on until now
        gv_residency_on_since=(datetime.now(timezone.utc) - timedelta(days=1)).isoformat(),
        gv_residency_phase="on")
    scope = [first, second, cold]
    loop = CapacityLoop(proj)
    try:
        p = await loop.run_once(graph_ids=scope)
        assert p.evictions == [] and (await _ps(cold)).status == "idle"
        assert await _leader() == (None, "reloading")
        (load,) = p.loads                                         # one master: one load
        other = second if load.graph_id == first else first
        assert (await _ps(load.graph_id)).status == "rehydrating"
        assert [(w.graph_id, w.reason) for w in p.waits] == [(other, "queued")]
        assert await _pending(proj, other) is False
        assert (await svc.projection_watermark(other))["fresh"] is False

        await proj.project_graph(load.graph_id)                   # its seed, as the lane runs it
        p = await loop.run_once(graph_ids=scope)
        assert (await _ps(load.graph_id)).status == "idle"        # done…
        assert [x.graph_id for x in p.loads] == [other]           # …and the next one starts
        await proj.project_graph(other)
        await loop.run_once(graph_ids=scope)
        assert (await _ps(other)).status == "idle"
        assert await loop.run_once(graph_ids=scope) is None       # nothing left out: it idles
        assert await _leader() == (None, None)
        assert [(t, p.get("details")) for t, p in await _events(*_LIFECYCLE, since=t0)] == [
            ("platform.residency.turned_off", {"toBringBack": 2}),
            ("platform.residency.reload_finished", None)]
        loaded = {p["details"]["graphId"]: p["details"]
                  for _t, p in await _events("platform.versioning.graph_loaded", since=t0)}
        assert set(loaded) == {first, second}
        assert all(d["master"] and d["secs"] >= 0 and "bytes" in d for d in loaded.values())
    finally:
        await _set_policy(**before)
        await _in_store(was)


async def test_with_residency_off_a_person_s_read_still_says_a_graph_is_out_and_asks_for_it(
        store, plain_engine):
    """Reads never depend on the switch. Off, a person's read of a graph still out of FalkorDB —
    being brought back, or read in an API process that lags the switch — reads it from Postgres,
    tells the request's FalkorDB-only work so (503 graph_loading) and asks for its load; it holds
    no read lease and notes no read."""
    from backend.app.services.versioning import cache_manager
    from backend.app.services.versioning.service import Viewer

    svc, proj = store, FalkorProjector(graph_client_factory=FakeFalkor())
    gid = await _resident(svc, proj)
    ds = (await svc.get_graph(gid))["data_source_id"]
    assert await CacheManager(proj).evict(gid, drop_graph=_dropped) is True
    await get_broker_redis().zrem(residency.LOAD_REQUESTS, gid)
    residency._READS.pop(gid, None)
    residency.READING.set(None)
    try:
        assert await _served_by(plain_engine, ds, Viewer(actor="usr_reader", can_read=True)) == (
            "postgres")
        reading = residency.READING.get()
        assert (reading.graph_id, reading.state) == (gid, "evicted")
        assert await _load_requested(gid)
        assert not await cache_manager.is_pinned(gid) and gid not in residency._READS
    finally:
        residency.READING.set(None)
        await get_broker_redis().zrem(residency.LOAD_REQUESTS, gid)
