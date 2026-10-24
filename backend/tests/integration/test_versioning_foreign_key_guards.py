"""The platform never destroys FalkorDB data it did not create — e2e, needs Postgres + Redis.

* Eviction drops only keys the platform minted, of live graphs past genesis with no unfinished
  bootstrap; ``evict`` re-checks that in the same statement that marks the row, under the
  projector's own lock.
* A graph pinned to a key it does not own starts parked at genesis: its first projection is the
  first commit's window, never a full replay over the data source's graph.
* One key, one versioned graph (``uq_ps_key``): a second claim is refused; a tombstoned holder
  that does not own the key lets go of it.
* Nothing projects into a graph whose version control is still being enabled, or into a
  tombstoned graph's retained pin; a full replay that would delete most of a key the platform
  does not own is refused, and the watermark is held back.

FalkorDB is the in-memory ``FakeFalkor`` of ``test_versioning_projection``. Skipped unless
``GRAPHVER_E2E=1``.
"""
import asyncio
import os

import pytest
from sqlalchemy import delete, func, select, update
from sqlalchemy.exc import IntegrityError

from backend.app.services.versioning import db, models
from backend.app.services.versioning.bootstrap_worker import BootstrapConflict, create_bootstrap_job
from backend.app.services.versioning.cache_manager import CacheManager
from backend.app.services.versioning.messaging import close_broker_redis
from backend.app.services.versioning.models import GraphORM, JobORM, ProjectionStateORM, _now
from backend.app.services.versioning.projection import FalkorProjector
from backend.app.services.versioning.service import ConcurrencyError, GraphVersioningService
from backend.tests.integration.test_versioning_projection import FakeFalkor, _edit_publish, _node

pytestmark = pytest.mark.skipif(not os.getenv("GRAPHVER_E2E"),
                                reason="set GRAPHVER_E2E=1 + live Postgres + Redis to run")


def _name(prefix="gvt_fk_") -> str:
    return prefix + os.urandom(4).hex()


def _ds() -> str:
    return "ds_" + os.urandom(4).hex()


async def _ps(gid):
    async with db.graphver_session() as s:
        ps = await s.get(ProjectionStateORM, gid)
        return ps.status, ps.projected_commit_seq, ps.target_commit_seq


async def _set_ps(gid, **values):
    async with db.graphver_session() as s:
        await s.execute(update(ProjectionStateORM).where(ProjectionStateORM.graph_id == gid)
                        .values(**values))


async def _resident(svc, provider, *, owns=True, publish=True) -> str:
    """A graph on ``provider`` that reads as resident: idle, projected to its head."""
    gid = (await svc.create_graph(data_source_id=_ds(), workspace_id="ws1", actor="a",
                                  falkor_graph_name=_name(), falkor_provider=provider,
                                  owns_falkor_graph=owns))["graph_id"]
    head = 1
    if publish:
        await _edit_publish(svc, gid, "a", [{"op": "create", "entity_kind": "node", "entity_id": "A",
                                             "payload": _node("A")}], "seed")
        head = 2
    await _set_ps(gid, status="idle", projected_commit_seq=head, target_commit_seq=head,
                  last_projected_at=_now())
    return gid


async def _run_eviction_matrix() -> None:
    await models.create_schema_and_partitions()
    svc = GraphVersioningService()
    provider = "prov_fk_" + os.urandom(3).hex()
    g0 = await _resident(svc, provider)
    not_owned = await _resident(svc, provider, owns=False)
    tombstoned = await _resident(svc, provider)
    at_genesis = await _resident(svc, provider, publish=False)
    pending = await _resident(svc, provider)
    failed = await _resident(svc, provider)
    async with db.graphver_session() as s:
        await s.execute(update(GraphORM).where(GraphORM.id == tombstoned).values(deleted_at=_now()))
        for gid, status in ((pending, "pending"), (failed, "failed")):
            s.add(JobORM(job_type="bootstrap", graph_id=gid, workspace_id="ws1", status=status))
    excluded = [not_owned, tombstoned, at_genesis, pending, failed]
    try:
        await _evict_matrix(g0, excluded, provider)
    finally:                                   # no stray bootstrap job for a later test to claim
        async with db.graphver_session() as s:
            await s.execute(delete(JobORM).where(JobORM.graph_id.in_([pending, failed])))
    await close_broker_redis()
    await db.dispose_engine()


async def _evict_matrix(g0, excluded, provider) -> None:
    cm = CacheManager(projector=None)
    assert await cm.resident_count(provider) == 1
    lru = await cm.lru_candidates(provider=provider, limit=10_000)
    assert lru == [g0], (lru, g0)

    dropped = []

    async def drop_graph(name, provider_id=None):
        dropped.append(name)

    for gid in excluded:
        assert await cm.evict(gid, drop_graph=drop_graph) is False, gid
        assert (await _ps(gid))[0] == "idle", gid
    assert dropped == []

    # A projection holding the projector's lock: the graph is not cold.
    lock_arg = func.hashtext(f"gvproj:{g0}")
    async with db.graphver_lock_session() as holder:
        assert await holder.scalar(select(func.pg_try_advisory_lock(lock_arg)))
        assert await cm.evict(g0, drop_graph=drop_graph) is False
        await holder.execute(select(func.pg_advisory_unlock(lock_arg)))
    assert await _ps(g0) == ("idle", 2, 2) and dropped == []

    # The CAS: a row that is not idle is not evicted.
    await _set_ps(g0, status="projecting")
    assert await cm.evict(g0, drop_graph=drop_graph) is False
    await _set_ps(g0, status="idle")

    assert await cm.evict(g0, drop_graph=drop_graph) is True
    assert await _ps(g0) == ("evicted", 0, 2) and len(dropped) == 1
    assert await cm.evict(g0, drop_graph=drop_graph) is False         # already evicted


def test_eviction_drops_only_minted_live_keys_past_genesis():
    asyncio.run(_run_eviction_matrix())


async def _run_parking_and_claim() -> None:
    await models.create_schema_and_partitions()
    svc = GraphVersioningService()
    fake = FakeFalkor()
    proj = FalkorProjector(graph_client_factory=fake, batch_size=2)

    key = _name()
    fake(key).nodes["urn:X"] = {"urn": "urn:X", "entityId": "X", "_label": "Dataset", "displayName": "x"}
    pinned = (await svc.create_graph(data_source_id=_ds(), workspace_id="ws1", actor="a",
                                     falkor_graph_name=key))["graph_id"]
    owned = (await svc.create_graph(data_source_id=_ds(), workspace_id="ws1", actor="a",
                                    falkor_graph_name=_name(), owns_falkor_graph=True))["graph_id"]
    unpinned = (await svc.create_graph(data_source_id=_ds(), workspace_id="ws1", actor="a"))["graph_id"]
    assert await _ps(pinned) == ("idle", 1, 1)                        # parked: never a full seed
    assert await _ps(owned) == ("idle", 0, 1)
    assert await _ps(unpinned) == ("idle", 0, 1)

    await _edit_publish(svc, pinned, "a", [{"op": "create", "entity_kind": "node", "entity_id": "A",
                                            "payload": _node("A")}], "seed")
    r = await proj.project_graph(pinned)
    assert fake.graphs[key].entity_ids() == {"X", "A"}                 # the source's node survives
    # ...and, being one the log does not hold, keeps reads on Postgres until it is imported.
    assert "extra entities" in (r["verify_error"] or ""), r

    # One key, one versioned graph — per provider.
    with pytest.raises(ConcurrencyError):
        await svc.create_graph(data_source_id=_ds(), workspace_id="ws1", actor="a",
                               falkor_graph_name=key)
    other = (await svc.create_graph(data_source_id=_ds(), workspace_id="ws1", actor="a",
                                    falkor_graph_name=key, falkor_provider="prov_other_"
                                    + os.urandom(3).hex()))["graph_id"]
    assert other
    # ...and the index holds it when the check is bypassed.
    with pytest.raises(IntegrityError):
        await _set_ps(owned, falkor_graph_name=key)

    # A tombstoned holder that does not own the key lets go of it.
    async with db.graphver_session() as s:
        await s.execute(update(GraphORM).where(GraphORM.id == pinned).values(deleted_at=_now()))
    taker = (await svc.create_graph(data_source_id=_ds(), workspace_id="ws1", actor="a",
                                    falkor_graph_name=key))["graph_id"]
    async with db.graphver_session() as s:
        assert (await s.get(ProjectionStateORM, pinned)).falkor_graph_name is None
        assert (await s.get(ProjectionStateORM, taker)).falkor_graph_name == key

    # Enabling version control onto a key another versioned graph projects into is a 409.
    with pytest.raises(BootstrapConflict) as caught:
        await create_bootstrap_job(data_source_id=_ds(), workspace_id="ws1", actor="a",
                                   falkor_graph_name=key)
    assert caught.value.detail["type"] == "graph_key_in_use"
    await db.dispose_engine()


def test_a_key_the_platform_does_not_own_is_parked_and_claimed_once():
    asyncio.run(_run_parking_and_claim())


async def _run_bootstrap_fence() -> None:
    await models.create_schema_and_partitions()
    svc = GraphVersioningService()
    fake = FakeFalkor()
    proj = FalkorProjector(graph_client_factory=fake, batch_size=2)
    key = _name()
    for i in range(4):
        fake(key).nodes[f"urn:S{i}"] = {"urn": f"urn:S{i}", "entityId": f"S{i}", "_label": "Dataset",
                                        "displayName": f"s{i}"}
    job = await create_bootstrap_job(data_source_id=_ds(), workspace_id="ws1", actor="a",
                                     falkor_graph_name=key)
    gid = job["graph_id"]

    with pytest.raises(ConcurrencyError):
        await svc.request_projection_rebuild(gid)
    assert await _ps(gid) == ("idle", 1, 1)
    with pytest.raises(ConcurrencyError):
        await svc.ensure_projection_target(graph_id=gid, falkor_graph_name=_name())
    async with db.graphver_session() as s:
        assert (await s.get(ProjectionStateORM, gid)).falkor_graph_name == key

    await _set_ps(gid, projected_commit_seq=0)
    r = await proj.project_graph(gid)
    assert r.get("skipped") == "bootstrapping", r
    assert len(fake.graphs[key].nodes) == 4
    await db.dispose_engine()


def test_nothing_projects_while_version_control_is_being_enabled():
    asyncio.run(_run_bootstrap_fence())


async def _run_tombstoned_and_refused() -> None:
    await models.create_schema_and_partitions()
    svc = GraphVersioningService()
    fake = FakeFalkor()
    proj = FalkorProjector(graph_client_factory=fake, batch_size=2)

    # A tombstoned graph keeps its pin for the undo window; nothing reseeds it.
    gone = await _resident(svc, None)
    async with db.graphver_session() as s:
        await s.execute(update(GraphORM).where(GraphORM.id == gone).values(deleted_at=_now()))
    await _set_ps(gone, projected_commit_seq=0)
    selected = []

    async def record(graph_id):
        selected.append(graph_id)
        return {}

    pending = FalkorProjector(graph_client_factory=fake)
    pending.project_graph = record
    await pending.project_pending(limit=100_000)
    assert gone not in selected
    r = await proj.project_graph(gone)
    assert r.get("skipped") == "deleted", r
    assert fake.graphs == {}

    # A full replay that would delete most of a key the platform does not own is refused.
    key = _name()
    gid = (await svc.create_graph(data_source_id=_ds(), workspace_id="ws1", actor="a",
                                  falkor_graph_name=key))["graph_id"]
    for i in range(3):
        fake(key).nodes[f"urn:C{i}"] = {"urn": f"urn:C{i}", "entityId": f"C{i}", "_label": "Dataset",
                                        "displayName": f"c{i}"}
    await _edit_publish(svc, gid, "a", [{"op": "create", "entity_kind": "node", "entity_id": "A",
                                         "payload": _node("A")}], "seed")
    await proj.project_graph(gid)
    assert fake.graphs[key].entity_ids() == {"C0", "C1", "C2", "A"}
    assert await svc.request_projection_rebuild(gid) is True
    r = await proj.project_graph(gid)
    assert "refusing" in (r.get("verify_error") or ""), r
    async with db.graphver_session() as s:
        ps = await s.get(ProjectionStateORM, gid)
        assert (ps.projected_commit_seq, ps.target_commit_seq, ps.status) == (0, 2, "idle")
        assert "refusing" in ps.last_error and ps.failed_attempts == 1 and ps.next_retry_at
    assert fake.graphs[key].entity_ids() == {"C0", "C1", "C2", "A"}
    assert "refusing" in ((await proj.project_graph(gid)).get("verify_error") or "")
    assert fake.graphs[key].entity_ids() == {"C0", "C1", "C2", "A"}
    await db.dispose_engine()


def test_no_reseed_of_a_tombstoned_pin_or_over_a_foreign_key():
    asyncio.run(_run_tombstoned_and_refused())
