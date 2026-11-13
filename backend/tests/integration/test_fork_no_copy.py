"""A fork has no FalkorDB copy of its own — Postgres, and FalkorDB for the old copies.

A fork was projected into ``<parent key>__fork_<id>``: a whole second copy of its parent that
almost nothing read, kept for the fork's undo window after it was trashed. A fork now reads through
its root's store, so ``fork_graph`` pins no key, the projector never projects a fork whatever its
row says, and its watermark says it reads through its root, as fresh as the root is; Check sync has
nothing to compare. A copy an earlier release made is dropped by the reaper, only once
``GRAPHVER_DROP_FORK_COPIES`` is set, and only by the purge's rules for a key: ours, the name minted
for the fork, nothing else projecting into it or reading it.
"""
import os

import pytest

from backend.app.services.versioning import config, db
from backend.app.services.versioning.models import ProjectionStateORM
from backend.app.services.versioning.projection import FalkorProjector
from backend.tests.integration.test_fork_overlay_delta import _n, _run
from backend.tests.integration.test_versioning_projection import FakeFalkor

pytestmark = [pytest.mark.integration, pytest.mark.skipif(
    not os.getenv("GRAPHVER_E2E"), reason="set GRAPHVER_E2E=1 + a live Postgres to run")]


async def _pin(gid, **values):
    async with db.graphver_session() as s:
        ps = await s.get(ProjectionStateORM, gid)
        for column, value in values.items():
            setattr(ps, column, value)


async def _ps(gid):
    async with db.graphver_session() as s:
        ps = await s.get(ProjectionStateORM, gid)
        return ps.falkor_graph_name, ps.falkor_provider, ps.owns_falkor_graph, ps.status


async def _root(svc, key, **pin):
    gid = (await svc.create_graph(data_source_id="ds_" + os.urandom(4).hex(), workspace_id="ws1",
                                  actor="alice", falkor_graph_name=key, owns_falkor_graph=True,
                                  **pin))["graph_id"]
    await svc.apply_ops(graph_id=gid, actor="alice", message="seed", ops=[_n("A"), _n("B")])
    return gid


def test_a_fork_is_never_projected():
    from backend.app.services.versioning.cache_manager import CacheManager
    from backend.app.services.versioning.reconcile import ProjectionReconciler

    async def case(svc):
        key = "gvt_nc_" + os.urandom(4).hex()
        root = await _root(svc, key)
        fake = FakeFalkor()
        projector = FalkorProjector(graph_client_factory=fake)
        await projector.project_graph(root)
        fid = (await svc.fork_graph(parent_graph_id=root, workspace_id="ws1", actor="bob"))["graph_id"]
        assert await _ps(fid) == (None, None, False, "idle")
        await svc.apply_ops(graph_id=fid, actor="bob", message="own", ops=[_n("N")])

        # Not even a copy an earlier release pinned: no pass, catch-up, rebuild or reseed.
        await _pin(fid, falkor_graph_name=f"{key}__fork_{fid}", owns_falkor_graph=True)
        assert (await projector.project_graph(fid))["skipped"] == "fork"
        await projector.project_pending()
        assert await svc.request_projection_rebuild(fid) is False
        await _pin(fid, status="evicted")
        assert await CacheManager(projector).ensure_rebuilt(fid) is False
        assert (await _ps(fid))[3] == "evicted"
        assert f"{key}__fork_{fid}" not in fake.graphs

        # Its watermark is its root's: what it reads through, as fresh as that is.
        await _pin(fid, falkor_graph_name=None, owns_falkor_graph=False, status="idle")
        wm, root_wm = await svc.projection_watermark(fid), await svc.projection_watermark(root)
        assert wm["reads_through"] == root and wm["fresh"] is root_wm["fresh"] is True
        assert (wm["committed"], wm["projected"], wm["status"]) == (
            root_wm["committed"], root_wm["projected"], root_wm["status"])
        assert (wm["falkor_graph_name"], wm["falkor_provider"], wm["owns_falkor_graph"]) == (
            None, None, False)
        assert wm["read_route"] == {"main": "falkordb", "drafts": "overlay"}
        await svc.apply_ops(graph_id=root, actor="alice", message="more", ops=[_n("C")])
        wm = await svc.projection_watermark(fid)
        # Behind its head, the root's key holds its last version whole: the fork reads it there.
        assert wm["fresh"] is False and wm["read_route"]["main"] == "falkordb"
        assert wm["served"] == root_wm["committed"]
        # Part-way through a window it holds none whole: the fork reads its root from Postgres.
        await _pin(root, window_rows=300_000)
        wm = await svc.projection_watermark(fid)
        assert wm["served"] is None and wm["read_route"]["main"] == "postgres"
        await _pin(root, window_rows=None)

        # Nor does the fleet's list show it catching up on a projection it does not have.
        from backend.app.services.system_status.probes import list_versioned_graphs
        listed = await list_versioned_graphs(provider=None, status=None, workspace_id="ws1",
                                             kind="fork", q=fid, cursor=None, limit=5)
        assert [(g["graphId"], g["lag"]) for g in listed["graphs"]] == [(fid, 0)]
        assert (await list_versioned_graphs(provider=None, status="lagging", workspace_id="ws1",
                                            kind="fork", q=fid, cursor=None, limit=5))["graphs"] == []

        # Check sync has nothing of a fork's to compare.
        report = await ProjectionReconciler(db.graphver_session, fake).reconcile(fid)
        assert report.skipped_reason == "a fork reads through its parent's graph", report
        assert f"{key}__fork_{fid}" not in fake.graphs
    _run(case)


def test_a_forks_read_route_is_where_its_reads_come_from(monkeypatch):
    """A fork reads through its root's store, so its watermark's route is the root's: FalkorDB
    while the root's projection holds its head. Past the ceiling its own layered reads in Postgres
    serve it, whatever the root's projection holds, and its route says Postgres (``reads_from``)."""
    async def case(svc):
        root = await _root(svc, "gvt_nc_" + os.urandom(4).hex())
        await FalkorProjector(graph_client_factory=FakeFalkor()).project_graph(root)
        fid = (await svc.fork_graph(parent_graph_id=root, workspace_id="ws1", actor="bob"))["graph_id"]
        await svc.apply_ops(graph_id=fid, actor="bob", message="own", ops=[_n("N")])
        wm = await svc.projection_watermark(fid)
        assert wm["read_route"] == {"main": "falkordb", "drafts": "overlay"}

        monkeypatch.setattr(config, "FORK_REWIND_MAX", 0)
        wm = await svc.projection_watermark(fid)
        assert (wm["read_route"], wm["fresh"]) == ({"main": "postgres", "drafts": "overlay"}, True)
        assert wm["reads_from"] == "postgres"
        root_wm = await svc.projection_watermark(root)
        assert (root_wm["read_route"]["main"], root_wm.get("reads_from")) == ("falkordb", None)
    _run(case)


def test_a_forks_old_copy_is_neither_behind_nor_checked():
    """A fork reads through its root's store and is never projected, so the fleet inventory says
    it is behind on nothing; but only while it had no key: one still pinned to a copy an earlier
    release made (until GRAPHVER_DROP_FORK_COPIES) showed as lagging, more with every commit on
    it. And the liveness check read that copy's marker, and lowered the fork's watermark once the
    copy was lost. Every fork is behind on nothing now, and the liveness check leaves forks out."""
    from backend.app.services.system_status.probes import list_versioned_graphs

    async def case(svc):
        key = "gvt_nc_" + os.urandom(4).hex()
        root = await _root(svc, key)
        fake = FakeFalkor()
        projector = FalkorProjector(graph_client_factory=fake)
        await projector.project_graph(root)
        fid = (await svc.fork_graph(parent_graph_id=root, workspace_id="ws1", actor="bob"))["graph_id"]
        for name in ("N", "M", "O"):
            await svc.apply_ops(graph_id=fid, actor="bob", message=name, ops=[_n(name)])
        # A copy an earlier release projected at the fork's second commit, lost since.
        await _pin(fid, falkor_graph_name=f"{key}__fork_{fid}", owns_falkor_graph=True,
                   projected_commit_seq=2)
        listed = await list_versioned_graphs(provider=None, status=None, workspace_id="ws1",
                                             kind="fork", q=fid, cursor=None, limit=5)
        assert [(g["graphId"], g["lag"]) for g in listed["graphs"]] == [(fid, 0)]
        assert fid not in {r["graph_id"] for r in await projector.check_liveness()}
        assert f"{key}__fork_{fid}" not in fake.graphs              # its copy is not even read
        async with db.graphver_session() as s:
            ps = await s.get(ProjectionStateORM, fid)
            assert (ps.projected_commit_seq, ps.last_error) == (2, None)
    _run(case)


@pytest.mark.skipif(os.getenv("RUN_FALKOR_LIVE") != "1", reason="set RUN_FALKOR_LIVE=1")
def test_a_forks_old_copy_is_dropped_only_when_asked_and_only_if_it_is_ours(monkeypatch):
    from falkordb.asyncio import FalkorDB
    from redis.asyncio import ConnectionPool

    from backend.app.services.versioning.purge_worker import Reaper

    async def case(svc):
        pool = ConnectionPool(host=os.getenv("FALKORDB_HOST", "localhost"),
                              port=int(os.getenv("FALKORDB_PORT", "6379")), max_connections=4)
        handle, names = FalkorDB(connection_pool=pool), {}
        try:
            key = "gvt_nc_" + os.urandom(4).hex()
            root = await _root(svc, key)
            forks = [(await svc.fork_graph(parent_graph_id=root, workspace_id="ws1",
                                           actor="bob"))["graph_id"] for _ in range(4)]
            ours, shared, read, customer = forks
            names.update({f: f"{key}__fork_{f}" for f in forks})
            for f in forks:                         # copies as an earlier release projected them
                await _pin(f, falkor_graph_name=names[f], owns_falkor_graph=f != customer,
                           projected_commit_seq=2)
                await handle.select_graph(names[f]).query(
                    "CREATE (:Table {urn: 'A'}) MERGE (m:_GVProjMeta {id: 'meta'}) SET m.seq = 2")
            other = await _root(svc, "gvt_nc_" + os.urandom(4).hex())
            await _pin(other, falkor_graph_name=names[shared], falkor_provider="prov_elsewhere")

            async def readers(provider, name, exclude_ds):
                return [{"dataSourceId": "ds_reader"}] if name == names[read] else []

            reaper = Reaper(graph_factory=lambda name, provider=None: handle.select_graph(name),
                            key_in_use=readers)

            async def present():
                listed = {k.decode() if isinstance(k, bytes) else k
                          for k in await handle.list_graphs()}
                return {f for f in forks if names[f] in listed}

            assert await reaper.fork_copies() == 0                      # not asked
            assert await present() == set(forks)
            monkeypatch.setattr(config, "DROP_FORK_COPIES", True)
            for _ in range(2):                                          # and again: no change
                assert await reaper.fork_copies() >= 0
                assert await present() == {shared, read, customer}
                assert await _ps(ours) == (None, None, False, "idle")
                for f in (shared, read, customer):
                    assert (await _ps(f))[0] == names[f]
        finally:
            for f in names:
                try:
                    await handle.select_graph(names[f]).delete()
                except Exception:
                    pass  # cleanup is best effort: the key may already be gone
            await pool.disconnect()
    _run(case)
