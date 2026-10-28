"""The platform never destroys FalkorDB data it did not create — e2e, needs Postgres + Redis.

* Eviction drops only keys the platform minted, of live graphs past genesis with no unfinished
  bootstrap; ``evict`` re-checks that in the same statement that marks the row, under the
  projector's own lock. Nor does it drop a key another data source or catalog entry reads, or
  one whose readers cannot be asked.
* A graph pinned to a key it does not own starts parked at genesis: its first projection is the
  first commit's window, never a full replay over the data source's graph.
* One key, one versioned graph (``uq_ps_key``): a second claim is refused; a tombstoned holder
  that does not own the key lets go of it.
* A key is one physical graph however it is reached: two provider rows for one server, or the env
  instance as ``'default'`` and as a provider row, hold one key — a second claim through either
  is refused, also when the two race, and "who else reads it" counts both.
* Nothing projects into a graph whose version control is still being enabled, or into a
  tombstoned graph's retained pin; a full replay over a key the platform does not own deletes
  nothing history doesn't hold: it publishes, and flags what it kept (``external_drift``).
* A loader's change notification flags a customer's graph only: nothing else writes to a key the
  platform minted, so there is nothing there to bring into history. Bringing changes in clears the
  flag it began under, and never one raised since.

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


async def _resident_read_by(svc, provider, *others) -> tuple:
    """A resident graph whose key its own data source reads, and so does each of ``others``, each
    in a workspace of its own (a workspace has one live data source per key,
    ``uq_ds_ws_prov_graph_live``). Returns ``(graph id, key)``."""
    from backend.app.db.engine import get_async_session
    from backend.app.db.models import ProviderORM, WorkspaceDataSourceORM, WorkspaceORM

    gid = await _resident(svc, provider)
    async with db.graphver_session() as s:
        own = (await s.get(GraphORM, gid)).data_source_id
        key = (await s.get(ProjectionStateORM, gid)).falkor_graph_name
    async with get_async_session() as s:
        if await s.get(ProviderORM, provider) is None:
            s.add(ProviderORM(id=provider, name=provider, provider_type="falkordb"))
        s.add_all([WorkspaceORM(id="ws_" + ds_id, name=ds_id) for ds_id in (own, *others)])
        await s.flush()
        s.add_all([WorkspaceDataSourceORM(id=ds_id, workspace_id="ws_" + ds_id,
                                          provider_id=provider, graph_name=key)
                   for ds_id in (own, *others)])
        await s.commit()
    return gid, key


async def _run_another_reader() -> None:
    from backend.app.db.engine import close_db

    await models.create_schema_and_partitions()
    svc = GraphVersioningService()
    provider = "prov_fk_" + os.urandom(3).hex()
    shared, _ = await _resident_read_by(svc, provider, _ds())
    alone, alone_key = await _resident_read_by(svc, provider)
    cm = CacheManager(projector=None)
    dropped = []

    async def drop_graph(name, provider_id=None):
        dropped.append(name)

    assert await cm.evict(shared, drop_graph=drop_graph) is False
    assert await _ps(shared) == ("idle", 2, 2) and dropped == []
    # The graph's own data source is no other reader.
    assert await cm.evict(alone, drop_graph=drop_graph) is True
    assert await _ps(alone) == ("evicted", 0, 2) and dropped == [alone_key]
    await close_broker_redis()
    await db.dispose_engine()
    await close_db()


def test_eviction_keeps_a_key_another_data_source_reads():
    asyncio.run(_run_another_reader())


async def _run_readers_unknown() -> None:
    from backend.app.services.versioning import purge_worker

    await models.create_schema_and_partitions()
    svc = GraphVersioningService()
    gid = await _resident(svc, "prov_fk_" + os.urandom(3).hex())
    cm = CacheManager(projector=None)
    dropped = []

    async def drop_graph(name, provider_id=None):
        dropped.append(name)

    async def unanswerable(*_args):
        raise RuntimeError("the management database is unreachable")

    with pytest.MonkeyPatch.context() as m:
        m.setattr(purge_worker, "graph_key_readers", unanswerable)
        assert await cm.evict(gid, drop_graph=drop_graph) is False
    assert await _ps(gid) == ("idle", 2, 2) and dropped == []
    await close_broker_redis()
    await db.dispose_engine()


def test_eviction_keeps_a_key_whose_readers_cannot_be_asked():
    asyncio.run(_run_readers_unknown())


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
    # ...and, being one the log does not hold, is flagged; the pass still publishes.
    assert r["verify_error"] is None and r["projected"] == 2, r
    async with db.graphver_session() as s:
        drift = (await s.get(ProjectionStateORM, pinned)).external_drift
    assert (drift["nodes"], drift["edges"], drift["via"]) == (1, 0, "verify"), drift

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


async def _run_one_key_per_server() -> None:
    from backend.app.db.engine import close_db, get_async_session
    from backend.app.db.models import ProviderORM, WorkspaceDataSourceORM, WorkspaceORM
    from backend.app.services.managed_sources import graph_key_bindings, same_server_providers
    from backend.app.services.projection_target import repair_projection_target

    await models.create_schema_and_partitions()
    svc = GraphVersioningService()
    tag = os.urandom(3).hex()
    host = f"falkor-{tag}.test"
    servers = {"a": (host, 6379), "b": (host, 6379), "elsewhere": (host, 6380),
               "env": (os.getenv("FALKORDB_HOST", "localhost"),
                       int(os.getenv("FALKORDB_PORT", "6379")))}
    ids = {via: f"prov_{via}_{tag}" for via in servers}
    ws, reader, shared = f"ws_fk_{tag}", f"ds_fk_{tag}", _name()
    async with get_async_session() as ms:
        ms.add(WorkspaceORM(id=ws, name=ws))
        ms.add_all([ProviderORM(id=ids[via], name=ids[via], provider_type="falkordb",
                                host=h, port=p) for via, (h, p) in servers.items()])
        await ms.flush()
        ms.add(WorkspaceDataSourceORM(id=reader, workspace_id=ws, provider_id=ids["b"],
                                      graph_name=shared))
        await ms.commit()
        aliases = {via: await same_server_providers(ms, ids[via]) for via in servers}
        aliases["default"] = await same_server_providers(ms, None)
        # Who else reads a key: a data source reaching it through another row for its server.
        assert [b["dataSourceId"] for b in await graph_key_bindings(ms, ids["a"], shared)] \
            == [reader]
        assert await graph_key_bindings(ms, ids["elsewhere"], shared) == []

    async def claim(key, via, session=None):
        return (await svc.create_graph(data_source_id=_ds(), workspace_id="ws1", actor="a",
                                       falkor_graph_name=key, falkor_provider=ids.get(via),
                                       provider_aliases=aliases[via], session=session))["graph_id"]

    # Two provider rows for one server: one key, one versioned graph. Another server's key of
    # the same name is another key.
    key = _name()
    await claim(key, "a")
    with pytest.raises(ConcurrencyError):
        await claim(key, "b")
    assert await claim(key, "elsewhere")

    # The env instance, as 'default' and as a provider row of its own, either way round.
    for first, second in (("default", "env"), ("env", "default")):
        key = _name()
        await claim(key, first)
        with pytest.raises(ConcurrencyError):
            await claim(key, second)

    # Two claims racing for one name serialize on it — where uq_ps_key, keyed by provider id,
    # cannot see them: the second waits for the first's transaction, then finds its pin.
    key = _name()
    async with db.graphver_session() as s:
        await claim(key, "a", session=s)
        racer = asyncio.ensure_future(claim(key, "b"))
        await asyncio.sleep(0.5)
        assert not racer.done()
    with pytest.raises(ConcurrencyError):
        await racer

    # Enabling version control, and the repair that pins an unpinned graph to its data source's
    # graph, ask the same.
    await claim(shared, "a")
    with pytest.raises(BootstrapConflict) as caught:
        await create_bootstrap_job(data_source_id=_ds(), workspace_id="ws1", actor="a",
                                   falkor_graph_name=shared, falkor_provider=ids["b"],
                                   provider_aliases=aliases["b"])
    assert caught.value.detail["type"] == "graph_key_in_use"
    unpinned = (await svc.create_graph(data_source_id=reader, workspace_id=ws, actor="a",
                                       falkor_provider=ids["b"]))["graph_id"]
    await repair_projection_target(svc, unpinned)
    async with db.graphver_session() as s:
        assert (await s.get(ProjectionStateORM, unpinned)).falkor_graph_name is None
    await db.dispose_engine()
    await close_db()


def test_one_key_per_server_whichever_provider_reaches_it():
    asyncio.run(_run_one_key_per_server())


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


async def _run_tombstoned_and_foreign() -> None:
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

    # A full replay over a key the platform does not own deletes nothing history doesn't hold.
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
    assert r.get("verify_error") is None, r
    assert fake.graphs[key].entity_ids() == {"C0", "C1", "C2", "A"}
    async with db.graphver_session() as s:
        ps = await s.get(ProjectionStateORM, gid)
        assert (ps.projected_commit_seq, ps.target_commit_seq, ps.status) == (2, 2, "idle")
        assert ps.last_error is None and ps.failed_attempts == 0
        assert (ps.external_drift["nodes"], ps.external_drift["edges"]) == (3, 0), ps.external_drift
    await db.dispose_engine()


def test_no_reseed_of_a_tombstoned_pin_and_nothing_deleted_from_a_foreign_key():
    asyncio.run(_run_tombstoned_and_foreign())


async def _run_notification_flags() -> None:
    from backend.app.services import versioned_sources

    await models.create_schema_and_partitions()
    svc = GraphVersioningService()
    graphs = {}
    for owns in (False, True):
        ds = _ds()
        graphs[owns] = ds, (await svc.create_graph(
            data_source_id=ds, workspace_id="ws1", actor="a", falkor_graph_name=_name(),
            owns_falkor_graph=owns))["graph_id"]
    for ds, _gid in graphs.values():
        await versioned_sources.flag_external_changes(ds)
    async with db.graphver_session() as s:
        flags = {owns: (await s.get(ProjectionStateORM, gid)).external_drift
                 for owns, (_ds_id, gid) in graphs.items()}
    assert (flags[False] or {}).get("via") == "notification", flags
    assert flags[True] is None, "a key the platform minted was flagged"
    await db.dispose_engine()


def test_a_notification_flags_the_customers_graph_and_never_a_platform_copy():
    asyncio.run(_run_notification_flags())


async def _run_clear_what_was_read() -> None:
    from backend.app.services import versioned_sources

    await models.create_schema_and_partitions()
    svc = GraphVersioningService()
    ds = _ds()
    gid = (await svc.create_graph(data_source_id=ds, workspace_id="ws1", actor="a",
                                  falkor_graph_name=_name()))["graph_id"]

    async def flag():
        await versioned_sources.flag_external_changes(ds)
        return ((await svc.projection_watermark(gid))["external_drift"] or {}).get("at")

    # A notification that arrives while the graph is read is not cleared with what was read.
    read_under = await flag()
    await asyncio.sleep(0.01)
    raised_since = await flag()
    assert raised_since != read_under
    await svc.clear_external_changes(gid, seen_at=read_under)
    assert (await svc.projection_watermark(gid))["external_drift"] is not None
    # Nor when nothing was flagged as the read began.
    await svc.clear_external_changes(gid, seen_at=None)
    assert (await svc.projection_watermark(gid))["external_drift"] is not None
    await svc.clear_external_changes(gid, seen_at=raised_since)
    assert (await svc.projection_watermark(gid))["external_drift"] is None
    await db.dispose_engine()


def test_bringing_changes_in_clears_the_flag_it_began_under_and_no_newer_one():
    asyncio.run(_run_clear_what_was_read())
