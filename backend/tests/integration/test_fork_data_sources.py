"""A fork is a data source of its own — needs Postgres (management and graphver).

Forking a graph makes a row in ``workspace_data_sources`` keyed by the fork graph's ``dsfork_…``
id, in the parent's workspace and on its provider, naming no FalkorDB graph, with the parent's
governing settings copied. The row commits before the fork graph is made (the two are separate
databases), and is deleted again when the fork cannot be made: no row is ever left without its
graph. The schema refuses a fork row that names a graph, and won't go back below the revision while
fork rows exist.
"""
import asyncio
import json
import os
from types import SimpleNamespace

import pytest
import sqlalchemy as sa
from sqlalchemy import select

from backend.app.services.versioning import config, db, models
from backend.app.services.versioning.service import GraphVersioningService

pytestmark = [pytest.mark.integration, pytest.mark.skipif(
    not os.getenv("GRAPHVER_E2E"), reason="set GRAPHVER_E2E=1 + a live Postgres to run")]

WS = "ws_forks"
R = "workspace:datasource:read"
M = "workspace:datasource:manage"
#: The parent's governing settings, every one set away from its default.
GOVERNING = {"is_restricted": True, "access_level": "write", "identity_property": "id",
             "name_property": "title", "draft_default_visibility": "private",
             "draft_levels": "private_only", "review_self_approval": False,
             "review_self_merge": False}


def _mgmt():
    from backend.app.db.engine import PoolRole, get_session_factory
    return get_session_factory(PoolRole.WEB)()


def _client(perms=(R, M), ws=WS):
    """The versioning router over in-process ASGI, the caller holding ``perms`` in ``ws``."""
    from fastapi import FastAPI
    from httpx import ASGITransport, AsyncClient

    from backend.app.api.v1.endpoints import versioning as V
    from backend.app.auth.dependencies import get_current_user, get_permission_claims
    from backend.app.services.permission_service import PermissionClaims

    async def _user():
        return SimpleNamespace(id="u_forker", email="f@example.com")

    async def _claims():
        return PermissionClaims(sid="", global_perms=(), ws_perms={ws: perms})

    from backend.app.api.v1.endpoints import workspaces as W

    app = FastAPI()
    app.include_router(V.router, prefix="/api/v1/{ws_id}/versioning")
    app.include_router(W.router, prefix="/api/v1/admin/workspaces")
    app.dependency_overrides[get_current_user] = _user
    app.dependency_overrides[get_permission_claims] = _claims
    return AsyncClient(transport=ASGITransport(app=app), base_url="http://test")


async def _parent(svc, label="Sales", pinned=False, **settings):
    """A data source in ``WS`` on a FalkorDB provider (this lane's), with an ontology and
    ``settings``, and its versioned graph — ``pinned`` to the data source's FalkorDB key, a
    ``gvt_`` one the suite's cleanup drops. Returns ``(data source id, graph id)``."""
    from backend.app.db.models import (
        OntologyORM, ProviderORM, WorkspaceDataSourceORM, WorkspaceORM)

    await models.create_schema_and_partitions()
    suffix = os.urandom(4).hex()
    ds_id, prov, key = f"ds_fk_{suffix}", f"prov_fk_{suffix}", f"gvt_fk_{suffix}"
    async with _mgmt() as s:
        if await s.get(WorkspaceORM, WS) is None:
            s.add(WorkspaceORM(id=WS, name="Forks"))
        s.add(ProviderORM(id=prov, name=f"falkor-{suffix}", provider_type="falkordb",
                          host=os.getenv("FALKORDB_HOST", "localhost"),
                          port=int(os.getenv("FALKORDB_PORT", "6379"))))
        s.add(OntologyORM(id=f"ont_fk_{suffix}", name=f"Ontology {suffix}", is_published=True))
        await s.flush()
        s.add(WorkspaceDataSourceORM(
            id=ds_id, workspace_id=WS, provider_id=prov, graph_name=key,
            label=label, ontology_id=f"ont_fk_{suffix}", **settings))
        await s.commit()
    pin = {"falkor_graph_name": key, "falkor_provider": prov, "owns_falkor_graph": True} if pinned else {}
    graph = await svc.create_graph(data_source_id=ds_id, workspace_id=WS, actor="alice", **pin)
    return ds_id, graph["graph_id"]


async def _row(ds_id):
    from backend.app.db.models import WorkspaceDataSourceORM
    async with _mgmt() as s:
        return await s.get(WorkspaceDataSourceORM, ds_id)


async def _fork(c, gid, body=None):
    return await c.post(f"/api/v1/{WS}/versioning/graphs/{gid}/forks", json=body)


def _run(case):
    async def go():
        try:
            await case(GraphVersioningService())
        finally:
            await db.dispose_engine()
    asyncio.run(go())


# ── creating a fork ──────────────────────────────────────────────────────────────────────────
def test_a_fork_is_a_data_source_with_its_parents_settings(monkeypatch):
    from backend.app.services.activity import recorder

    recorded = []

    async def _record(session, event_type, **fields):
        recorded.append((event_type, fields))
        return True

    monkeypatch.setattr(recorder, "record_for_request", _record)

    async def case(svc):
        parent_ds, gid = await _parent(svc, **GOVERNING)
        async with _client() as c:
            r = await _fork(c, gid, {"name": "  Q3 plan  "})
            assert r.status_code == 201, r.text
            body = r.json()
            ds_id, fork_gid = body["dataSourceId"], body["graphId"]
            assert ds_id.startswith("dsfork_")
            assert (await svc.get_graph(fork_gid))["data_source_id"] == ds_id
            parent, row = await _row(parent_ds), await _row(ds_id)
            assert (row.workspace_id, row.provider_id) == (WS, parent.provider_id)
            assert row.label == "Sales · Q3 plan" and row.graph_name is None
            assert row.fork_of_data_source_id == parent_ds and row.source_mode == "managed"
            assert row.created_by == "u_forker" and not row.is_primary and row.is_active
            assert json.loads(row.extra_config) == {"origin": {
                "kind": "fork", "parentDataSourceId": parent_ds, "parentGraphId": gid}}
            assert row.ontology_id == parent.ontology_id
            for column, value in GOVERNING.items():
                assert getattr(row, column) == value, column
            assert [e for e, _f in recorded] == ["workspace.versioning.fork_created"]

            # Unnamed, it is "Fork" and the end of its id; the list names each fork's source.
            r = await _fork(c, gid)
            assert r.status_code == 201, r.text
            unnamed = r.json()["dataSourceId"]
            assert (await _row(unnamed)).label == f"Sales · Fork {unnamed[-6:]}"
            listed = (await c.get(f"/api/v1/{WS}/versioning/graphs/{gid}/forks")).json()
            assert {(f["dataSourceId"], f["label"]) for f in listed} == {
                (ds_id, "Sales · Q3 plan"), (unnamed, f"Sales · Fork {unnamed[-6:]}")}

            # A name is 1 to 80 characters once trimmed.
            for bad in ("   ", "x" * 81):
                assert (await _fork(c, gid, {"name": bad})).status_code == 422
    _run(case)


def test_a_fork_that_cannot_be_made_leaves_no_data_source(monkeypatch):
    from backend.app.db.models import WorkspaceDataSourceORM
    from backend.app.services.versioning.errors import ForkLimit

    async def forks_of(parent_ds):
        async with _mgmt() as s:
            return (await s.execute(select(WorkspaceDataSourceORM.id).where(
                WorkspaceDataSourceORM.fork_of_data_source_id == parent_ds))).scalars().all()

    async def case(svc):
        parent_ds, gid = await _parent(svc)
        async with _client() as c:
            # Refused before anything is written: the cap, and a trashed parent.
            monkeypatch.setattr(config, "MAX_FORKS_PER_GRAPH", 1)
            assert (await _fork(c, gid)).status_code == 201
            r = await _fork(c, gid)
            assert r.status_code == 409 and r.json()["detail"]["type"] == "fork_limit", r.text
            assert len(await forks_of(parent_ds)) == 1
            monkeypatch.setattr(config, "MAX_FORKS_PER_GRAPH", 10)

            # Refused after the row is written (fork_graph checks again under its lock): the row
            # is deleted, and the refusal answered as before.
            async def refuse(*a, **k):
                raise ForkLimit(1)

            monkeypatch.setattr(GraphVersioningService, "fork_graph", refuse)
            r = await _fork(c, gid)
            assert r.status_code == 409 and r.json()["detail"]["type"] == "fork_limit", r.text
            assert len(await forks_of(parent_ds)) == 1
    _run(case)


def test_fork_graph_takes_only_a_fork_id():
    async def case(svc):
        _parent_ds, gid = await _parent(svc)
        with pytest.raises(ValueError):
            await svc.fork_graph(parent_graph_id=gid, workspace_id=WS, actor="bob",
                                 data_source_id="ds_not_a_fork")
        made = await svc.fork_graph(parent_graph_id=gid, workspace_id=WS, actor="bob",
                                    data_source_id="dsfork_chosen" + os.urandom(3).hex())
        assert made["data_source_id"].startswith("dsfork_chosen")
        minted = await svc.fork_graph(parent_graph_id=gid, workspace_id=WS, actor="bob")
        assert minted["data_source_id"].startswith("dsfork_")
    _run(case)


# ── read and written through version control, never FalkorDB ─────────────────────────────────
async def _falkor_keys(prefix):
    from falkordb.asyncio import FalkorDB
    from redis.asyncio import ConnectionPool

    pool = ConnectionPool(host=os.getenv("FALKORDB_HOST", "localhost"),
                          port=int(os.getenv("FALKORDB_PORT", "6379")), max_connections=2)
    try:
        names = [k.decode() if isinstance(k, bytes) else k
                 for k in await FalkorDB(connection_pool=pool).list_graphs()]
    finally:
        await pool.disconnect()
    return sorted(n for n in names if n.startswith(prefix))


from backend.app.services.versioned_sources import physical_key as _real_physical_key  # noqa: E402


def test_a_fork_is_read_and_written_through_version_control_never_falkordb(monkeypatch):
    from backend.app.db.models import WorkspaceDataSourceORM
    from backend.app.providers.draft_overlay_provider import DraftOverlayProvider
    from backend.app.providers.manager import provider_manager
    from backend.app.providers.versioned_branch_provider import VersionedBranchProvider
    from backend.app.services import fork_sources, versioned_sources
    from backend.app.services.context_engine import ContextEngine
    from backend.common.models.graph import GraphNode

    # The suite's conftest makes physical_key the identity; this test is about the real one.
    monkeypatch.setattr(versioned_sources, "physical_key", _real_physical_key)

    def node(urn, name):
        return GraphNode(urn=urn, entityType="Dataset", displayName=name)

    async def case(svc):
        parent_ds, gid = await _parent(svc, pinned=True)
        parent = await _row(parent_ds)
        d = await svc.open_draft(graph_id=gid, owner="alice")
        await svc.stage_changes(graph_id=gid, branch_id=d, actor="alice", ops=[{
            "op": "create", "entity_kind": "node", "entity_id": "urn:fk:A",
            "payload": {"urn": "urn:fk:A", "entityType": "Dataset", "displayName": "A"}}])
        await svc.checkpoint(graph_id=gid, branch_id=d, actor="alice")
        await svc.publish(graph_id=gid, branch_id=d, actor="alice", message="A")
        async with _client() as c:
            fork = (await _fork(c, gid)).json()
        fork_ds, fork_gid = fork["dataSourceId"], fork["graphId"]
        fork_head = (await svc.get_graph(fork_gid))["main_head_commit_seq"]
        parent_head = (await svc.get_graph(gid))["main_head_commit_seq"]

        # A fork reads its root parent's published key, never one of its own.
        assert await versioned_sources.physical_key(fork_ds, parent.provider_id, None) == (
            parent.provider_id, parent.graph_name)
        async with _mgmt() as session:
            # Through the engine: its main is its parent's store with its changes over it — the
            # parent's Postgres reader while its projection lags — and a write is a commit on it.
            engine = await ContextEngine.for_workspace(WS, provider_manager, session,
                                                       data_source_id=fork_ds, actor="u_forker")
            assert type(engine.provider) is DraftOverlayProvider and engine._writes_main
            assert type(engine.provider._base) is VersionedBranchProvider
            await engine.provider.create_node(node("urn:fk:B", "B"))
            assert (await engine.provider.get_node("urn:fk:B")).display_name == "B"
            # Search runs in the parent's store, which is catching up here.
            with pytest.raises(NotImplementedError, match="catching up"):
                await engine.provider.deep_search(None)
            # Through the registry, outside the engine: the parent's key, read only.
            provider = await provider_manager.get_provider(WS, session, fork_ds)
            assert isinstance(provider, fork_sources.ForkReadOnlyProvider)
            with pytest.raises(fork_sources.ForkHasNoStore):
                await provider.create_node(node("urn:fk:C", "C"))
            assert (await session.get(WorkspaceDataSourceORM, fork_ds)).graph_name is None
        assert (await svc.get_graph(fork_gid))["main_head_commit_seq"] == fork_head + 1
        assert (await svc.get_graph(gid))["main_head_commit_seq"] == parent_head
        fmain = await svc.main_branch_id(fork_gid)
        state = await svc.materialize_state(graph_id=fork_gid, branch_id=fmain)
        assert set(state["nodes"]) == {"urn:fk:A", "urn:fk:B"}, state
        # Nothing reached FalkorDB: neither the parent's key nor the fork's was ever written.
        assert await _falkor_keys(parent.graph_name) == []
    _run(case)


# ── the lifecycle: a fork's data source goes where its graph goes ────────────────────────────
def test_the_fork_endpoints_take_its_data_source_through_the_trash_and_away():
    from backend.app.services.versioning.purge_worker import PurgeRunner, create_purge_job
    from backend.tests.integration.test_graph_lifecycle_purge import _nobody, _take

    async def case(svc):
        _parent_ds, gid = await _parent(svc)
        async with _client() as c:
            fork = (await _fork(c, gid)).json()
            ds_id, url = fork["dataSourceId"], f"/api/v1/{WS}/versioning/graphs/{fork['graphId']}"
            assert (await c.delete(url)).status_code == 204
            row = await _row(ds_id)
            assert row.deleted_at is not None and row.deleted_by == "u_forker"
            assert (await c.post(url + "/restore")).status_code == 204
            row = await _row(ds_id)
            assert row.deleted_at is None and row.deleted_by is None
            assert (await c.delete(url)).status_code == 204
        # Its purge takes the row once the graph is gone, never before.
        job = await create_purge_job(graph_id=fork["graphId"], workspace_id=WS, actor="reaper",
                                     require_tombstoned=True)
        assert await _row(ds_id) is not None
        done = await PurgeRunner(None, key_in_use=_nobody).run_job(await _take(job))
        assert done["status"] == "completed", done
        assert await _row(ds_id) is None
    _run(case)


def test_the_reaper_keeps_each_forks_data_source_in_step_with_its_graph():
    from datetime import datetime, timedelta, timezone

    from backend.app.services import fork_sources
    from backend.app.services.versioning.purge_worker import Reaper

    async def case(svc):
        parent_ds, gid = await _parent(svc, **GOVERNING)
        reaper = Reaper()
        # A fork made before forks had data sources gets its own, made as the route makes one.
        legacy = await svc.fork_graph(parent_graph_id=gid, workspace_id=WS, actor="bob")
        ds_id, fork_gid = legacy["data_source_id"], legacy["graph_id"]
        assert (await reaper.fork_rows())["created"] >= 1
        parent, row = await _row(parent_ds), await _row(ds_id)
        assert row.label == f"Sales · Fork {ds_id[-6:]}" and row.graph_name is None
        assert (row.fork_of_data_source_id, row.workspace_id, row.provider_id) == (
            parent_ds, WS, parent.provider_id)
        assert row.created_by == "bob" and json.loads(row.extra_config)["origin"] == {
            "kind": "fork", "parentDataSourceId": parent_ds, "parentGraphId": gid}
        assert {c: getattr(row, c) for c in fork_sources.GOVERNING} == {
            c: getattr(parent, c) for c in fork_sources.GOVERNING}
        await reaper.fork_rows()                                   # and only once
        async with _mgmt() as s:
            from backend.app.db.models import WorkspaceDataSourceORM as DS
            assert await s.scalar(select(sa.func.count()).select_from(DS).where(
                DS.id == ds_id)) == 1

        # A graph trashed or restored some other way takes its row along on the next pass.
        await svc.delete_fork(graph_id=fork_gid, workspace_id=WS, actor="bob")
        await reaper.fork_rows()
        assert (await _row(ds_id)).deleted_at is not None
        await svc.restore_fork(graph_id=fork_gid, workspace_id=WS)
        await reaper.fork_rows()
        assert (await _row(ds_id)).deleted_at is None

        # A row whose graph is gone — never made (a crash while forking), or purged — goes once
        # it is ten minutes old: one younger may be a fork still being made.
        old = (datetime.now(timezone.utc) - timedelta(minutes=11)).isoformat()
        async with _mgmt() as s:
            for orphan, created in (("dsfork_orphan_young_" + os.urandom(3).hex(), None),
                                    ("dsfork_orphan_old_" + os.urandom(3).hex(), old)):
                row = fork_sources.fork_row(parent, ds_id=orphan, name="X", parent_graph_id=gid,
                                            actor="u")
                if created:
                    row.created_at = created
                s.add(row)
            await s.commit()
        await reaper.fork_rows()
        async with _mgmt() as s:
            left = set((await s.execute(select(DS.id).where(
                DS.id.like("dsfork_orphan_%")))).scalars())
        assert any(i.startswith("dsfork_orphan_young_") for i in left)
        assert not any(i.startswith("dsfork_orphan_old_") for i in left)
    _run(case)


def test_a_fork_made_while_its_parents_settings_change_takes_the_new_ones():
    """A governing change on the parent listed its forks before the parent's own UPDATE was sent
    (sessions never autoflush): a fork made meanwhile read the parent unblocked, copied the old
    value and kept it for good, its row refusing the column. The change now writes the parent
    first, so a fork made meanwhile reads the parent after it; and the reaper's backfill of a
    fork made before forks had rows reads the parent the same way."""
    from backend.app.db.models import WorkspaceDataSourceORM as DS
    from backend.app.services import fork_sources
    from backend.app.services.versioning.purge_worker import Reaper

    async def change(parent_ds, column):
        """A governing change on the parent, written but not committed: its session."""
        s = _mgmt()
        ds = await s.get(DS, parent_ds)
        before = fork_sources.governing(ds)
        setattr(ds, column, False)
        await fork_sources.follow_parent(s, ds, before)
        return s

    async def case(svc):
        from backend.app.db.repositories import data_source_repo

        async def meanwhile(change_open, made):
            """``made`` (a fork's row being made) running while ``change_open`` is uncommitted."""
            task = asyncio.ensure_future(made)
            await asyncio.wait({task}, timeout=0.5)        # done at once, or waiting for the change
            await change_open.commit()
            await change_open.close()
            await task

        async def fork_route(parent_ds, gid, ds_id):
            async with _mgmt() as b:                       # its read, its row, its commit
                parent = await data_source_repo.get_data_source_orm(b, parent_ds, lock="share")
                b.add(fork_sources.fork_row(parent, ds_id=ds_id, name="race", parent_graph_id=gid,
                                            actor="u"))
                await b.commit()

        parent_ds, gid = await _parent(svc, review_self_approval=True, review_self_merge=True)
        ds_id = "dsfork_race_" + os.urandom(3).hex()
        await meanwhile(await change(parent_ds, "review_self_approval"),
                        fork_route(parent_ds, gid, ds_id))
        assert (await _row(ds_id)).review_self_approval is False

        legacy = await svc.fork_graph(parent_graph_id=gid, workspace_id=WS, actor="bob")
        await meanwhile(await change(parent_ds, "review_self_merge"), Reaper().fork_rows())
        assert (await _row(legacy["data_source_id"])).review_self_merge is False
    _run(case)

def test_a_view_made_on_a_fork_while_its_parent_moves_goes_with_it():
    """A view is made holding its source's row FOR KEY SHARE. A move locked the parent's row
    alone and changed its forks' with a plain UPDATE, which does not wait for a key share: a view
    made on a fork meanwhile committed in the old workspace after the move had taken the views,
    and stayed there, its fork gone. The move now locks the forks' rows, after the parent's, and
    waits for the view, which it then takes along."""
    from sqlalchemy import update

    from backend.app.db.models import ViewORM, WorkspaceORM
    from backend.app.db.repositories import data_source_repo, view_repo
    from backend.common.models.management import ViewCreateRequest
    from backend.app.services import data_source_transfer as T

    async def move(parent_ds, to_ws):
        """The move's own writes to the parent, its forks and the views on them."""
        async with _mgmt() as m:
            ds = await T._lock_live(m, parent_ds)
            ds.workspace_id = to_ws
            await m.flush()
            sources = await T._carry_forks(m, ds, to_ws, "now")
            await m.execute(update(ViewORM).where(ViewORM.data_source_id.in_(sources))
                            .values(workspace_id=to_ws).execution_options(synchronize_session=False))
            await m.commit()

    async def case(svc):
        parent_ds, gid = await _parent(svc)
        async with _client() as c:
            fork_ds = (await _fork(c, gid)).json()["dataSourceId"]
        to_ws = "ws_forks_" + os.urandom(3).hex()
        async with _mgmt() as s:
            s.add(WorkspaceORM(id=to_ws, name="Elsewhere"))
            await s.commit()
        async with _mgmt() as v:                       # a view being made on the fork
            assert await data_source_repo.hold_in_workspace(v, fork_ds, WS)
            view = await view_repo.create_view(v, ViewCreateRequest(
                name="On the fork", workspace_id=WS, data_source_id=fork_ds, view_type="graph",
                visibility="private"), user_id="u1")
            moving = asyncio.ensure_future(move(parent_ds, to_ws))
            await asyncio.wait({moving}, timeout=0.5)
            await v.commit()
        await moving
        async with _mgmt() as s:
            assert (await s.get(ViewORM, view.id)).workspace_id == to_ws
        assert (await _row(fork_ds)).workspace_id == to_ws
    _run(case)

def test_the_reaper_never_undoes_a_trash_and_a_restore_it_did_not_see(monkeypatch):
    """The reaper read a fork's row live and its graph trashed (a trash between its two writes),
    and tombstoned the row where it was still live. When the trash's row and then a restore of
    graph and row landed between those reads and that write, it tombstoned a restored fork. It now
    decides each row under the row's lock, from its graph as it is then."""
    from backend.app.services.versioning import purge_worker

    async def case(svc):
        _parent_ds, gid = await _parent(svc)
        async with _client() as c:
            fork = (await _fork(c, gid)).json()
        ds_id, fgid = fork["dataSourceId"], fork["graphId"]
        await svc.delete_fork(graph_id=fgid, workspace_id=WS, actor="u")    # the row: not yet

        url = os.environ["MANAGEMENT_DB_URL"].replace("+asyncpg", "+psycopg2")
        gv_url = os.environ.get("GRAPHVER_DB_URL", url).replace("+asyncpg", "+psycopg2")
        real_now = purge_worker._now

        def landed_meanwhile():
            """The trash's row, then a restore — graph, then row: after the reads, before the
            write (the reaper takes ``now`` between the two)."""
            with sa.create_engine(url).begin() as m:
                m.execute(sa.text("UPDATE workspace_data_sources SET deleted_at = :t WHERE id = :i"),
                          {"t": real_now(), "i": ds_id})
            with sa.create_engine(gv_url).begin() as g:
                g.execute(sa.text(f'UPDATE "{config.graphver_schema()}".graphs SET deleted_at = NULL, '
                                  "deleted_by = NULL WHERE id = :i"), {"i": fgid})
            with sa.create_engine(url).begin() as m:
                m.execute(sa.text("UPDATE workspace_data_sources SET deleted_at = NULL WHERE id = :i"),
                          {"i": ds_id})
            monkeypatch.setattr(purge_worker, "_now", real_now)
            return real_now()

        monkeypatch.setattr(purge_worker, "_now", landed_meanwhile)
        await purge_worker.Reaper().fork_rows()
        assert (await svc.get_graph(fgid))["deleted_at"] is None
        assert (await _row(ds_id)).deleted_at is None
    _run(case)


def test_the_reaper_removes_orphan_rows_one_at_a_time_deepest_first():
    """Orphan rows (no graph, ten minutes old) went in one statement: a row another fork's row
    still names failed it on RESTRICT, every pass, and a fork's fork could be deleted after its
    parent. Each now goes on its own, the deepest first, and one that fails is left alone."""
    from datetime import datetime, timedelta, timezone

    from backend.app.db.models import WorkspaceDataSourceORM as DS
    from backend.app.services import fork_sources
    from backend.app.services.versioning.purge_worker import Reaper

    async def case(svc):
        parent_ds, gid = await _parent(svc)
        parent = await _row(parent_ds)
        old = (datetime.now(timezone.utc) - timedelta(minutes=11)).isoformat()
        tag = os.urandom(3).hex()
        held, holds, alone, top, under = (f"dsfork_orph_{n}_{tag}" for n in
                                          ("held", "holds", "alone", "top", "under"))
        async with _mgmt() as s:
            for ds_id, of in ((held, parent), (alone, parent), (top, parent)):
                row = fork_sources.fork_row(of, ds_id=ds_id, name="X", parent_graph_id=gid, actor="u")
                row.created_at = old
                s.add(row)
            await s.flush()
            for ds_id, of in ((holds, held), (under, top)):
                row = fork_sources.fork_row(await s.get(DS, of), ds_id=ds_id, name="Y",
                                            parent_graph_id=gid, actor="u")
                row.created_at = old
                s.add(row)
            await s.commit()
        await svc.create_graph(data_source_id=holds, workspace_id=WS, actor="u")   # not an orphan

        out = await Reaper().fork_rows()
        assert out["removed"] >= 3
        assert [await _row(i) is None for i in (alone, under, top, held, holds)] == [
            True, True, True, False, False]
    _run(case)


def test_an_expired_parent_waits_for_the_fork_rows_that_name_it(caplog):
    """A parent's graph with nothing past its genesis is purged whatever forks it has: they read
    nothing of it. Its expired row was then deleted while fork rows still named it, and failed on
    RESTRICT on every pass of the reaper. It now waits for them."""
    import logging
    from datetime import datetime, timedelta, timezone

    from backend.app.services.versioning.purge_worker import (
        PurgeRunner, Reaper, create_purge_job, tombstone_graphs_for_data_source)
    from backend.tests.integration.test_graph_lifecycle_purge import _nobody, _take

    async def case(svc):
        parent_ds, gid = await _parent(svc)
        async with _client() as c:
            fork = (await _fork(c, gid)).json()
        assert (await svc.get_graph(gid))["main_head_commit_seq"] <= 1
        await tombstone_graphs_for_data_source(data_source_id=parent_ds, workspace_id=WS, actor="u")
        expired = (datetime.now(timezone.utc) - timedelta(days=config.PURGE_GRACE_DAYS + 1)).isoformat()
        async with _mgmt() as s:
            row = await s.get(__import__("backend.app.db.models", fromlist=["x"])
                              .WorkspaceDataSourceORM, parent_ds)
            row.deleted_at, row.deleted_by = expired, "u"
            await s.commit()
        job = await create_purge_job(graph_id=gid, workspace_id=WS, actor="u",
                                     require_tombstoned=True)
        assert (await PurgeRunner(None, key_in_use=_nobody).run_job(await _take(job)))[
            "status"] == "completed"

        with caplog.at_level(logging.ERROR, logger="backend.app.services.versioning.purge_worker"):
            await Reaper().run_once()
        assert not [r for r in caplog.records if r.levelno >= logging.ERROR], caplog.text
        assert await _row(parent_ds) is not None and await _row(fork["dataSourceId"]) is not None
    _run(case)

async def _view_on(ds_id, name, draft=None):
    """A view on ``ds_id``, pinned to ``draft`` (one of its drafts) when given: its id."""
    from backend.app.db.models import ViewORM
    from backend.app.db.repositories import view_repo
    from backend.common.models.management import ViewCreateRequest

    async with _mgmt() as s:
        view = await view_repo.create_view(s, ViewCreateRequest(
            name=name, workspace_id=WS, data_source_id=ds_id, view_type="graph",
            visibility="private"), user_id="u1")
        (await s.get(ViewORM, view.id)).draft_branch_id = draft
        await s.commit()
        return view.id


async def _view(view_id):
    from backend.app.db.models import ViewORM
    async with _mgmt() as s:
        v = await s.get(ViewORM, view_id)
        return v.data_source_id, v.draft_branch_id, v.deleted_at


def test_the_views_on_a_fork_go_to_its_parent_when_its_row_goes():
    """When a fork's row was deleted — its purge done, the reaper's orphan pass, its parent's
    permanent delete — the views on it fell to no data source, so they read the workspace's
    default. They now go to the fork's nearest live ancestor (its parent; up a fork of a fork),
    losing the fork's draft they were pinned to; a view in the trash stays there."""
    from datetime import datetime, timedelta, timezone

    from backend.app.db.models import ViewORM
    from backend.app.services import fork_sources
    from backend.app.services.versioning.purge_worker import PurgeRunner, Reaper, create_purge_job
    from backend.tests.integration.test_graph_lifecycle_purge import _nobody, _take

    async def case(svc):
        parent_ds, gid = await _parent(svc)
        async with _client() as c:
            fork = (await _fork(c, gid)).json()
            fork_ds, fgid = fork["dataSourceId"], fork["graphId"]
            draft = await svc.open_draft(graph_id=fgid, owner="u1")
            pinned, trashed = await _view_on(fork_ds, "Pinned", draft), await _view_on(fork_ds, "Old")
            async with _mgmt() as s:
                (await s.get(ViewORM, trashed)).deleted_at = "2026-10-01T00:00:00+00:00"
                await s.commit()
            assert (await c.delete(f"/api/v1/{WS}/versioning/graphs/{fgid}")).status_code == 204
        job = await create_purge_job(graph_id=fgid, workspace_id=WS, actor="u",
                                     require_tombstoned=True)
        assert (await PurgeRunner(None, key_in_use=_nobody).run_job(await _take(job)))[
            "status"] == "completed"
        assert await _row(fork_ds) is None
        assert await _view(pinned) == (parent_ds, None, None)
        assert await _view(trashed) == (parent_ds, None, "2026-10-01T00:00:00+00:00")

        # A fork of a fork whose row the reaper removes (no graph, ten minutes old): its views go
        # to the fork above it, the nearest that is live.
        async with _client() as c:
            mid = (await _fork(c, gid)).json()["dataSourceId"]
        old = (datetime.now(timezone.utc) - timedelta(minutes=11)).isoformat()
        leaf = "dsfork_leaf_" + os.urandom(3).hex()
        async with _mgmt() as s:
            from backend.app.db.models import WorkspaceDataSourceORM as DS
            row = fork_sources.fork_row(await s.get(DS, mid), ds_id=leaf, name="L",
                                        parent_graph_id="g", actor="u")
            row.created_at = old
            s.add(row)
            await s.commit()
        on_leaf = await _view_on(leaf, "On the leaf", "draft_of_the_leaf")
        await Reaper().fork_rows()
        assert await _row(leaf) is None
        assert await _view(on_leaf) == (mid, None, None)

        # A parent's permanent delete takes its trashed forks' rows with its own: their views
        # lose the forks' drafts and, with no live ancestor left, read the default as its own do.
        held_ds, held = await _parent(svc)
        async with _client() as c:
            gone = (await _fork(c, held)).json()
            on_gone = await _view_on(gone["dataSourceId"], "On a fork", "draft_of_the_fork")
            assert (await c.delete(f"/api/v1/{WS}/versioning/graphs/{gone['graphId']}")).status_code == 204
            r = await c.delete(f"/api/v1/admin/workspaces/{WS}/data-sources/{held_ds}",
                               params={"permanent": "true"})
            assert r.status_code == 204, r.text
        assert await _view(on_gone) == (None, None, None)
    _run(case)

def test_the_reapers_expiry_of_a_forks_row_sends_its_views_to_the_parent(monkeypatch):
    """A fork's row past its undo window whose graph is gone — its purge finished, and a crash
    came before ``_drop_fork_row`` — is deleted by the reaper's expiry pass, which took no care of
    the views on it: they fell to no data source, and read the workspace's default. They go to the
    fork's parent, losing the fork's draft, as when the purge deletes the row itself."""
    from datetime import datetime, timedelta, timezone

    from backend.app.db.models import WorkspaceDataSourceORM as DS
    from backend.app.services.versioning import purge_worker
    from backend.app.services.versioning.purge_worker import PurgeRunner, Reaper, create_purge_job
    from backend.tests.integration.test_graph_lifecycle_purge import _nobody, _take

    async def crashed(ds_id):
        return None

    async def case(svc):
        parent_ds, gid = await _parent(svc)
        async with _client() as c:
            fork = (await _fork(c, gid)).json()
            fork_ds, fgid = fork["dataSourceId"], fork["graphId"]
            draft = await svc.open_draft(graph_id=fgid, owner="u1")
            pinned = await _view_on(fork_ds, "Pinned", draft)
            assert (await c.delete(f"/api/v1/{WS}/versioning/graphs/{fgid}")).status_code == 204
        monkeypatch.setattr(purge_worker, "_drop_fork_row", crashed)
        job = await create_purge_job(graph_id=fgid, workspace_id=WS, actor="u",
                                     require_tombstoned=True)
        assert (await PurgeRunner(None, key_in_use=_nobody).run_job(await _take(job)))[
            "status"] == "completed"
        async with _mgmt() as s:
            row = await s.get(DS, fork_ds)
            row.deleted_at = (datetime.now(timezone.utc) - timedelta(days=400)).isoformat()
            await s.commit()
        await Reaper().run_once()
        assert await _row(fork_ds) is None
        assert await _view(pinned) == (parent_ds, None, None)
    _run(case)


def test_a_parents_permanent_delete_purges_its_trashed_forks_first():
    from backend.app.services.versioning.models import JobORM

    async def jobs_of(*gids):
        async with db.graphver_session() as s:
            return {j.graph_id: j.id for j in (await s.execute(select(JobORM).where(
                JobORM.job_type == "purge", JobORM.graph_id.in_(gids)))).scalars()}

    async def case(svc):
        parent_ds, gid = await _parent(svc)
        held_ds, held = await _parent(svc)
        async with _client() as c:
            fork = (await _fork(c, gid)).json()
            assert (await c.delete(f"/api/v1/{WS}/versioning/graphs/{fork['graphId']}")).status_code == 204
            r = await c.delete(f"/api/v1/admin/workspaces/{WS}/data-sources/{parent_ds}",
                               params={"permanent": "true"})
            assert r.status_code == 204, r.text
            jobs = await jobs_of(gid, fork["graphId"])
            assert set(jobs) == {gid, fork["graphId"]} and jobs[fork["graphId"]] < jobs[gid]
            assert await _row(fork["dataSourceId"]) is None and await _row(parent_ds) is None

            # A live fork still holds its parent back, rows and all.
            live = (await _fork(c, held)).json()
            r = await c.delete(f"/api/v1/admin/workspaces/{WS}/data-sources/{held_ds}",
                               params={"permanent": "true"})
            assert r.status_code == 409 and r.json()["detail"]["type"] == "live_forks", r.text
            assert await _row(live["dataSourceId"]) is not None and await _row(held_ds) is not None
    _run(case)


# ── the schema ───────────────────────────────────────────────────────────────────────────────
_REVISION = "20261030_1200_ds_fork_of"


def _migration():
    import importlib.util
    from pathlib import Path

    path = Path(__file__).resolve().parents[2] / "alembic" / "versions" / f"{_REVISION}.py"
    spec = importlib.util.spec_from_file_location(path.stem, path)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def test_the_fork_column_migrates_both_ways_and_names_no_graph():
    """The check refuses a fork row that names a graph; the downgrade refuses while fork rows
    exist, and drops the column once none do; the upgrade is safe to re-run."""
    from alembic.migration import MigrationContext
    from alembic.operations import Operations

    url = os.environ["MANAGEMENT_DB_URL"].replace("+asyncpg", "+psycopg2")
    engine = sa.create_engine(url)
    migration = _migration()

    def run(conn, step):
        with Operations.context(MigrationContext.configure(conn)):
            getattr(migration, step)()

    def columns(conn):
        return {c["name"] for c in sa.inspect(conn).get_columns("workspace_data_sources")}

    async def seed():
        await _parent(GraphVersioningService())

    asyncio.run(seed())
    asyncio.run(db.dispose_engine())
    with engine.connect() as conn:
        trans = conn.begin()
        try:
            ws, prov = conn.execute(sa.text(
                "SELECT workspace_id, provider_id FROM workspace_data_sources "
                "WHERE workspace_id = :ws LIMIT 1"), {"ws": WS}).one()
            insert = sa.text(
                "INSERT INTO workspace_data_sources (id, workspace_id, provider_id, graph_name, "
                "fork_of_data_source_id, is_primary, is_active, is_restricted, write_back_enabled, "
                "aggregation_status, aggregation_edge_count, created_at, updated_at) VALUES "
                "(:id, :ws, :prov, :graph, :parent, false, true, false, false, 'none', 0, "
                "'2026-10-30', '2026-10-30')")
            parent = conn.execute(sa.text("SELECT id FROM workspace_data_sources "
                                          "WHERE workspace_id = :ws LIMIT 1"), {"ws": ws}).scalar()
            with pytest.raises(sa.exc.IntegrityError, match="ck_ds_fork_no_key"):
                with conn.begin_nested():
                    conn.execute(insert, {"id": "dsfork_named", "ws": ws, "prov": prov,
                                          "graph": "a_key", "parent": parent})
            conn.execute(insert, {"id": "dsfork_schema", "ws": ws, "prov": prov, "graph": None,
                                  "parent": parent})
            with pytest.raises(RuntimeError, match="fork data source row"):
                with conn.begin_nested():
                    run(conn, "downgrade")
            conn.execute(sa.text("DELETE FROM workspace_data_sources "
                                 "WHERE fork_of_data_source_id IS NOT NULL"))
            run(conn, "downgrade")
            assert "fork_of_data_source_id" not in columns(conn)
            run(conn, "upgrade")
            run(conn, "upgrade")                                       # idempotent
            assert "fork_of_data_source_id" in columns(conn)
            assert "idx_ds_fork_of" in {i["name"] for i in sa.inspect(conn).get_indexes(
                "workspace_data_sources")}
        finally:
            trans.rollback()
    engine.dispose()
