"""Projection fencing and the held-back retry, against Postgres (FakeFalkor for the cache).

* A held-back graph is retried after a backoff and reaches the committed head with no new commit:
  the failed pass no longer pins ``target`` to the un-advanced seq.
* A publish that lands while a pass fails keeps its target.
* Whatever resets the watermark under a pass wins: a second writer that publishes after a stale
  one claimed leaves the stale one superseded, the watermark lowered to where it started, and the
  worker nudged.
* A move to another key (doc 14 KeyMigration, phase 1) bumps the epoch too: a pass it overtook is
  superseded, and the old key waits in ``retired_keys``. Only this graph's own platform keys move
  or are moved onto; the customer's key and an unpinned graph are refused untouched. The target
  self-heal never moves the pin back, and the data source's readers follow the pin.
* Evict and rebuild bump the epoch; a rebuild clears the backoff.
* A publishing pass leaves its ``_GVProjMeta`` marker (the published seq, its epoch) as its last
  write; a held-back pass leaves the previous one.

Needs ``GRAPHVER_E2E=1`` and Postgres.
"""
import asyncio
import functools
import os
from datetime import datetime, timedelta, timezone

import pytest

from backend.app.services import versioned_sources
from backend.app.services.versioned_sources import physical_key
from backend.app.services.versioning import db, keymigrate, models, projection
from backend.app.services.versioning.cache_manager import CacheManager
from backend.app.services.versioning.errors import (ProjectionKeyInUse, ProjectionKeyInvalid,
                                                    ProjectionNotAdopted)
from backend.app.services.versioning.models import GraphORM, ProjectionStateORM
from backend.app.services.versioning.projection import FalkorProjector
from backend.app.services.versioning.service import GraphVersioningService

from backend.tests.integration.test_versioning_projection import (
    FakeFalkor,
    _assert_matches_main,
    _edit_publish,
    _node,
)

pytestmark = pytest.mark.skipif(not os.getenv("GRAPHVER_E2E"),
                                reason="set GRAPHVER_E2E=1 + a live Postgres to run")


def _create(entity_id: str) -> list:
    return [{"op": "create", "entity_kind": "node", "entity_id": entity_id,
             "payload": _node(entity_id)}]


async def _seed(svc, fake) -> tuple:
    """A pinned graph the platform owns, projected at seq 2, with seq 3 published on top of it.
    Returns ``(graph_id, projector)``."""
    await models.create_schema_and_partitions()
    gid = (await svc.create_graph(data_source_id="ds_" + os.urandom(4).hex(), workspace_id="ws1",
                                  actor="a", falkor_graph_name="gvt_" + os.urandom(3).hex(),
                                  owns_falkor_graph=True))["graph_id"]
    proj = FalkorProjector(graph_client_factory=fake)
    await _edit_publish(svc, gid, "a", _create("A") + _create("B"), "seed")
    await proj.project_graph(gid)
    await _edit_publish(svc, gid, "a", _create("C"), "more")
    row = await _row(gid)
    assert (row["projected"], row["target"], row["head"]) == (2, 3, 3), row
    return gid, proj


async def _row(gid: str) -> dict:
    async with db.graphver_session() as s:
        ps = await s.get(ProjectionStateORM, gid)
        head = (await s.get(GraphORM, gid)).main_head_commit_seq
        return {"projected": ps.projected_commit_seq, "target": ps.target_commit_seq,
                "head": head, "status": ps.status, "epoch": ps.epoch, "name": ps.falkor_graph_name,
                "failed_attempts": ps.failed_attempts, "next_retry_at": ps.next_retry_at,
                "last_error": ps.last_error}


async def _pending_picks(proj, gid: str) -> list:
    """``project_pending``'s real select; only this test's graph is actually projected."""
    picked, real = [], proj.project_graph

    async def only_ours(g):
        picked.append(g)
        return await real(g) if g == gid else {"noop": True}

    proj.project_graph = only_ours
    try:
        await proj.project_pending(limit=100_000)
    finally:
        proj.project_graph = real
    return [g for g in picked if g == gid]


def _short_counts(proj):
    real = proj._falkor_counts

    async def short(client, owned=True):
        n, e = await real(client, owned)
        return max(0, n - 1), e
    return short


async def _run_held_back_graph_is_retried_after_backoff() -> None:
    svc = GraphVersioningService()
    gid, proj = await _seed(svc, FakeFalkor())

    proj._falkor_counts = _short_counts(proj)
    r = await proj.project_graph(gid)
    assert r["verify_error"] and r["projected"] == 2, r
    row = await _row(gid)
    assert row["projected"] == 2 and row["target"] == 3, row      # target is not pinned down
    assert row["failed_attempts"] == 1 and row["next_retry_at"], row

    del proj._falkor_counts                                        # the cause is gone
    assert await _pending_picks(proj, gid) == [], "retried inside its backoff"
    async with db.graphver_session() as s:
        (await s.get(ProjectionStateORM, gid)).next_retry_at = (
            datetime.now(timezone.utc) - timedelta(seconds=1)).isoformat()
    assert await _pending_picks(proj, gid) == [gid]
    row = await _row(gid)
    assert row["projected"] == 3 and row["last_error"] is None, row
    assert row["failed_attempts"] == 0 and row["next_retry_at"] is None, row
    await db.dispose_engine()


def test_a_held_back_graph_is_retried_after_its_backoff():
    asyncio.run(_run_held_back_graph_is_retried_after_backoff())


async def _run_publish_during_a_failing_pass_keeps_its_target() -> None:
    svc = GraphVersioningService()
    gid, proj = await _seed(svc, FakeFalkor())

    async def publish_then_fail(*a, **k):
        await _edit_publish(svc, gid, "a", _create("D"), "landed mid-pass")
        return "forced failure", False

    proj._verify_and_heal = publish_then_fail
    await proj.project_graph(gid)
    row = await _row(gid)
    assert row["projected"] == 2 and row["target"] == row["head"] == 4, row
    await db.dispose_engine()


def test_a_publish_during_a_failing_pass_keeps_its_target():
    asyncio.run(_run_publish_during_a_failing_pass_keeps_its_target())


async def _run_move_mid_pass_is_fenced() -> None:
    # The move takes the graph lock, not the projector's, so it can land mid-pass.
    svc, fake = GraphVersioningService(), FakeFalkor()
    gid, proj = await _seed(svc, fake)
    old, new = (await _row(gid))["name"], keymigrate.owned_key(gid, 1)
    nudged = []

    async def nudge(graph_id):
        nudged.append(graph_id)

    async def move_then_pass(*a, **k):
        res = await svc.move_projection(graph_id=gid, provider="prov_b", key=new, actor="a",
                                        shard_map={})
        assert res["changed"] and res["retiring"]["name"] == old, res
        return None, False

    proj._verify_and_heal = move_then_pass
    real_nudge, projection.nudge_projection = projection.nudge_projection, nudge
    try:
        r = await proj.project_graph(gid)
    finally:
        projection.nudge_projection = real_nudge
    assert r.get("skipped") == "superseded", r
    row = await _row(gid)
    assert (row["name"], row["projected"], row["status"]) == (new, 0, "reseeding"), row
    wm = await svc.projection_watermark(gid)
    assert wm["falkor_provider"] == "prov_b" and wm["owns_falkor_graph"], wm
    assert [(e["name"], e["provider"], e["afterSeq"], e["movedBy"]) for e in wm["retired_keys"]] == [
        (old, None, 3, "a")], wm
    assert nudged == [gid]
    del proj._verify_and_heal
    await proj.project_graph(gid)                         # the next pass reseeds the new key
    assert ((await _row(gid))["projected"], (await _row(gid))["status"]) == (3, "idle")
    await _assert_matches_main(svc, fake, gid)
    await db.dispose_engine()


def test_a_move_mid_pass_is_fenced_and_queues_the_old_key():
    asyncio.run(_run_move_mid_pass_is_fenced())


async def _run_the_self_heal_keeps_a_moved_pin() -> None:
    # The worker's target_resolver re-pins to the data source's key on every pass; after a move
    # that key is the old one, which the move must keep.
    svc, fake = GraphVersioningService(), FakeFalkor()
    gid, _ = await _seed(svc, fake)
    old, new = (await _row(gid))["name"], keymigrate.owned_key(gid, 1)
    await svc.move_projection(graph_id=gid, provider="prov_b", key=new, actor="a", shard_map={})
    before = dict(fake(old).nodes)

    async def resolver(s, graph_id):
        return await s.ensure_projection_target(graph_id=graph_id, falkor_graph_name=old)

    proj = FalkorProjector(graph_client_factory=fake, target_resolver=resolver)
    await proj.project_graph(gid)
    await _edit_publish(svc, gid, "a", _create("D"), "after the move")
    await proj.project_graph(gid)
    row = await _row(gid)
    assert (row["name"], row["projected"]) == (new, 4), row
    await _assert_matches_main(svc, fake, gid)
    assert fake(old).nodes == before                      # the old key is not written
    await db.dispose_engine()


def test_the_self_heal_keeps_a_moved_pin():
    asyncio.run(_run_the_self_heal_keeps_a_moved_pin())


async def _run_reads_follow_the_pin() -> None:
    # The management DB keeps naming the data source's key; its readers are routed to the pin.
    # ``physical_key`` is imported above, before conftest makes it the identity.
    svc = GraphVersioningService()
    gid, proj = await _seed(svc, FakeFalkor())
    ds = (await svc.get_graph(gid))["data_source_id"]
    old, new = (await _row(gid))["name"], keymigrate.owned_key(gid, 1)
    versioned_sources.reset_cache()
    assert await physical_key(ds, "prov_ds", old) == ("prov_ds", old)
    await svc.move_projection(graph_id=gid, provider="prov_b", key=new, actor="a", shard_map={})
    assert await physical_key(ds, "prov_ds", old) == ("prov_b", new)
    await svc.move_projection(graph_id=gid, provider="default", key=old, actor="a", shard_map={})
    assert await physical_key(ds, "prov_ds", old) == ("prov_ds", old)
    assert await physical_key("ds_unversioned", "prov_ds", "k") == ("prov_ds", "k")
    await proj.project_graph(gid)                         # leave the row idle for later tests
    await db.dispose_engine()


def test_reads_follow_the_pin():
    asyncio.run(_run_reads_follow_the_pin())


async def _run_a_move_touches_only_what_it_may() -> None:
    svc = GraphVersioningService()
    gid, proj = await _seed(svc, FakeFalkor())
    old = (await _row(gid))["name"]
    move = functools.partial(svc.move_projection, actor="a", shard_map={})

    # Already there: nothing is bumped.
    before = await _row(gid)
    assert (await move(graph_id=gid, provider="default", key=old))["changed"] is False
    assert await _row(gid) == before
    with pytest.raises(ProjectionKeyInvalid):              # not this graph's platform key
        await move(graph_id=gid, provider="prov_b", key="nexus_lineage")
    with pytest.raises(ProjectionKeyInvalid):
        await move(graph_id=gid, provider="prov_b", key=keymigrate.owned_key("graph_other", 1))

    # The customer's own key, and an unpinned graph, never move.
    cust = (await svc.create_graph(data_source_id="ds_" + os.urandom(4).hex(), workspace_id="ws1",
                                   actor="a", falkor_graph_name="cust_" + os.urandom(3).hex()))
    cust_before = await _row(cust["graph_id"])
    with pytest.raises(ProjectionNotAdopted) as info:
        await move(graph_id=cust["graph_id"], provider="prov_b",
                   key=keymigrate.owned_key(cust["graph_id"], 1))
    assert info.value.detail["reason"] == "customer_key"
    assert await _row(cust["graph_id"]) == cust_before
    async with db.graphver_session() as s:
        ps = await s.get(ProjectionStateORM, cust["graph_id"])
        ps.falkor_graph_name, ps.owns_falkor_graph = f"gv_{cust['graph_id']}", True
    with pytest.raises(ProjectionNotAdopted) as info:
        await move(graph_id=cust["graph_id"], provider="prov_b",
                   key=keymigrate.owned_key(cust["graph_id"], 1))
    assert info.value.detail["reason"] == "unpinned"

    # A key another graph pins is refused; a move back onto our own retired key is not.
    first = keymigrate.owned_key(gid, 1)
    assert (await move(graph_id=gid, provider="prov_b", key=first))["changed"]
    async with db.graphver_session() as s:
        (await s.get(ProjectionStateORM, cust["graph_id"])).falkor_provider = "prov_c"
        (await s.get(ProjectionStateORM, cust["graph_id"])).falkor_graph_name = (
            keymigrate.owned_key(gid, 2))
    with pytest.raises(ProjectionKeyInUse):
        await move(graph_id=gid, provider="prov_c", key=keymigrate.owned_key(gid, 2))
    epoch = (await _row(gid))["epoch"]
    back = await move(graph_id=gid, provider="default", key=old)
    assert back["changed"] and back["retiring"]["name"] == first, back
    row = await _row(gid)
    assert (row["name"], row["epoch"]) == (old, epoch + 1), row
    wm = await svc.projection_watermark(gid)
    assert [(e["name"], e["provider"]) for e in wm["retired_keys"]] == [(first, "prov_b")], wm
    await proj.project_graph(gid)                         # and reconciles back into the old key
    assert ((await _row(gid))["projected"], (await _row(gid))["status"]) == (3, "idle")
    await db.dispose_engine()


def test_a_move_touches_only_what_it_may():
    asyncio.run(_run_a_move_touches_only_what_it_may())


async def _run_stale_writer_is_superseded() -> None:
    # Two passes over one graph with the single-flight lock bypassed — what a pass whose lock
    # connection died looks like to the next one. The stale pass claims first and is still
    # writing when the second claims, publishes, and returns.
    svc = GraphVersioningService()
    gid, proj = await _seed(svc, FakeFalkor())
    real_verify = proj._verify_and_heal
    stale_in_verify, release = asyncio.Event(), asyncio.Event()
    nudged = []

    async def nudge(graph_id):
        nudged.append(graph_id)

    async def verify(*a, **k):
        if not stale_in_verify.is_set():
            stale_in_verify.set()
            await release.wait()
        return await real_verify(*a, **k)

    proj._verify_and_heal = verify
    real_nudge, projection.nudge_projection = projection.nudge_projection, nudge
    try:
        stale = asyncio.ensure_future(proj._project_graph_locked(gid))
        await asyncio.wait_for(stale_in_verify.wait(), 10)
        fresh = await proj._project_graph_locked(gid)
        assert fresh["projected"] == 3 and not fresh.get("skipped"), fresh
        release.set()
        r = await stale
    finally:
        projection.nudge_projection = real_nudge
    assert r.get("skipped") == "superseded", r
    row = await _row(gid)
    assert row["projected"] <= 2, row                    # lowered to where the stale pass began
    assert nudged == [gid]
    await proj.project_graph(gid)                         # and the next pass converges
    assert (await _row(gid))["projected"] == 3
    await db.dispose_engine()


def test_a_stale_writer_is_superseded_and_lowers_the_watermark():
    asyncio.run(_run_stale_writer_is_superseded())


async def _run_evict_and_rebuild_bump_the_epoch() -> None:
    svc = GraphVersioningService()
    gid, proj = await _seed(svc, FakeFalkor())
    await proj.project_graph(gid)
    before = await _row(gid)

    async def drop(name, provider_id=None):
        return None

    assert await CacheManager(proj).evict(gid, drop_graph=drop) is True
    evicted = await _row(gid)
    assert evicted["epoch"] == before["epoch"] + 1, (before, evicted)

    async with db.graphver_session() as s:                # a pass that failed, backing off
        ps = await s.get(ProjectionStateORM, gid)
        ps.status, ps.failed_attempts = "idle", 3
        ps.next_retry_at = (datetime.now(timezone.utc) + timedelta(hours=1)).isoformat()
    assert await svc.request_projection_rebuild(gid) is True
    rebuilt = await _row(gid)
    assert rebuilt["epoch"] == evicted["epoch"] + 1, rebuilt
    assert rebuilt["failed_attempts"] == 0 and rebuilt["next_retry_at"] is None, rebuilt
    await db.dispose_engine()


def test_evict_and_rebuild_bump_the_epoch():
    asyncio.run(_run_evict_and_rebuild_bump_the_epoch())


async def _run_the_marker_follows_what_was_published() -> None:
    svc = GraphVersioningService()
    fake = FakeFalkor()
    gid, proj = await _seed(svc, fake)
    seeded = await _row(gid)
    graph = fake.graphs[seeded["name"]]
    assert graph.proj_meta == {"seq": 2, "epoch": seeded["epoch"]}, graph.proj_meta

    proj._falkor_counts = _short_counts(proj)
    await proj.project_graph(gid)                         # held back: the marker stays at 2
    assert graph.proj_meta == {"seq": 2, "epoch": seeded["epoch"]}, graph.proj_meta

    del proj._falkor_counts
    await proj.project_graph(gid)                         # a direct pass is not held by backoff
    row = await _row(gid)
    assert row["projected"] == 3 and graph.proj_meta == {"seq": 3, "epoch": row["epoch"]}, (
        row, graph.proj_meta)
    await db.dispose_engine()


def test_the_marker_follows_what_was_published():
    asyncio.run(_run_the_marker_follows_what_was_published())
