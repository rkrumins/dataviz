"""Version control as a data source's life sees it — needs Postgres.

``main_heads`` is what the data-source list reports with ``include=versioning``: only graphs that
are live, in the workspace asking, and whose "enable version control" job (if any) finished —
each with the head of ``main``. A source that is absent is not versioned there.

A graph in the trash answers none of its routes, and answers them again once restored.

Moving a data source files its graph — and the graph's forks and jobs — under the new workspace,
open drafts and reviews included, unless version control is busy with it; and the reaper files a
graph left behind by an earlier move, with its forks, under its source's workspace, trashing it if
the source is in the trash, without ever removing a source row whose graph still stands. A graph a
job still runs on is re-filed once the job ends.
"""
import asyncio
import os

import pytest
from sqlalchemy import select

from backend.app.services.versioning import db, lifecycle, models, purge_worker
from backend.app.services.versioning.errors import JobActive
from backend.app.services.versioning.service import GraphVersioningService


def _ds() -> str:
    return "ds_" + os.urandom(4).hex()


async def _publish(svc, gid, actor, eid, msg):
    d = await svc.open_draft(graph_id=gid, owner=actor)
    await svc.stage_changes(graph_id=gid, branch_id=d, actor=actor, ops=[
        {"op": "create", "entity_kind": "node", "entity_id": eid,
         "payload": {"entityType": "Dataset", "displayName": eid}}])
    await svc.checkpoint(graph_id=gid, branch_id=d, actor=actor)
    return await svc.publish(graph_id=gid, branch_id=d, actor=actor, message=msg)


async def _main_heads() -> None:
    svc = GraphVersioningService()
    ds_a, ds_b, ds_blank, ds_none = _ds(), _ds(), _ds(), _ds()

    a = (await svc.create_graph(data_source_id=ds_a, workspace_id="ws_a", actor="alice"))["graph_id"]
    head = await _publish(svc, a, "alice", "A", "add A")                 # seq 2
    top = (await svc.commit_log(graph_id=a, limit=1))[0]
    assert top["commit_id"] == head

    heads = await svc.main_heads(workspace_id="ws_a", data_source_ids=[ds_a, ds_none])
    assert heads == {ds_a: {
        "graph_id": a, "kind": "manual", "main_head_commit_seq": 2,
        "main_head_commit_id": head, "main_head_committed_at": top["created_at"],
    }}

    # another workspace's graph is not versioned here
    assert await svc.main_heads(workspace_id="ws_other", data_source_ids=[ds_a]) == {}

    # a graph with only its genesis and no enable job is versioned (a blank model is)
    blank = (await svc.create_graph(data_source_id=ds_blank, workspace_id="ws_a",
                                    actor="alice", kind="blank"))["graph_id"]
    got = await svc.main_heads(workspace_id="ws_a", data_source_ids=[ds_blank])
    assert got[ds_blank]["graph_id"] == blank and got[ds_blank]["main_head_commit_seq"] == 1

    # while version control is still being turned on — or its enable failed — it is not
    b = (await svc.create_graph(data_source_id=ds_b, workspace_id="ws_a", actor="alice"))["graph_id"]
    async with db.graphver_session() as s:
        job = models.JobORM(job_type="bootstrap", graph_id=b, workspace_id="ws_a",
                            data_source_id=ds_b, status="pending")
        s.add(job)
    for status, versioned in (("running", False), ("failed", False), ("completed", True)):
        async with db.graphver_session() as s:
            (await s.get(models.JobORM, job.id)).status = status
        got = await svc.main_heads(workspace_id="ws_a", data_source_ids=[ds_b])
        assert (ds_b in got) is versioned, status

    # a graph in the trash is not
    await purge_worker.tombstone_graphs_for_data_source(
        data_source_id=ds_a, workspace_id="ws_a", actor="alice")
    assert await svc.main_heads(workspace_id="ws_a", data_source_ids=[ds_a]) == {}


def _app():
    """The versioning router alone, as a reader of every workspace a request names."""
    from types import SimpleNamespace

    from fastapi import FastAPI, Request

    from backend.app.api.v1.endpoints import versioning
    from backend.app.auth.dependencies import get_current_user, get_permission_claims
    from backend.app.services.permission_service import PermissionClaims

    async def user():
        return SimpleNamespace(id="alice", email="alice@example.com")

    async def claims(request: Request):
        return PermissionClaims(sid="", global_perms=(), ws_perms={
            request.path_params["ws_id"]: ("workspace:datasource:read",)})

    app = FastAPI()
    app.include_router(versioning.router, prefix="/api/v1/{ws_id}/versioning")
    app.dependency_overrides[get_current_user] = user
    app.dependency_overrides[get_permission_claims] = claims
    return app


async def _trashed_graph_answers_nothing() -> None:
    from httpx import ASGITransport, AsyncClient

    svc = GraphVersioningService()
    ds = _ds()
    gid = (await svc.create_graph(data_source_id=ds, workspace_id="ws_a", actor="alice"))["graph_id"]
    async with AsyncClient(transport=ASGITransport(app=_app()), base_url="http://test") as c:
        graph = f"/api/v1/ws_a/versioning/graphs/{gid}"
        assert (await c.get(graph)).status_code == 200

        await purge_worker.tombstone_graphs_for_data_source(
            data_source_id=ds, workspace_id="ws_a", actor="alice")
        assert (await c.get(graph)).status_code == 404
        assert (await c.get(f"{graph}/watermark")).status_code == 404

        assert not (await purge_worker.restore_graphs_for_data_source(
            data_source_id=ds, workspace_id="ws_a")).final
        assert (await c.get(graph)).status_code == 200


async def _graph(gid):
    async with db.graphver_session() as s:
        g = await s.get(models.GraphORM, gid)
        jobs = (await s.execute(select(models.JobORM.workspace_id).where(
            models.JobORM.graph_id == gid))).scalars().all()
        return g.workspace_id, g.deleted_at, g.deleted_by, set(jobs)


async def _a_move_carries_the_graph() -> None:
    from httpx import ASGITransport, AsyncClient

    svc = GraphVersioningService()
    ds = _ds()
    gid = (await svc.create_graph(data_source_id=ds, workspace_id="ws_a", actor="alice"))["graph_id"]
    await _publish(svc, gid, "alice", "A", "add A")
    async with db.graphver_session() as s:
        s.add(models.JobORM(job_type="export", graph_id=gid, workspace_id="ws_a",
                            data_source_id=ds, status="completed"))

    # version control at work on it holds a person's move back, and nothing is written
    async with db.graphver_session() as s:
        busy = models.JobORM(job_type="export", graph_id=gid, workspace_id="ws_a",
                             data_source_id=ds, status="running")
        s.add(busy)
    with pytest.raises(JobActive, match="busy"):
        await svc.move_graph_workspace(ds, "ws_b", from_workspace_id="ws_a")
    with pytest.raises(purge_worker.MoveBlocked, match="busy"):
        await purge_worker.rehome_graph_for_data_source(data_source_id=ds, to_workspace_id="ws_b")
    assert (await _graph(gid))[0] == "ws_a"
    # ...but not putting back what a failed move changed: the source is where it is. (The
    # reaper, which moves through move_graph_workspace as above, waits for the job.)
    assert await purge_worker.rehome_graph_for_data_source(
        data_source_id=ds, to_workspace_id="ws_b", refuse_busy=False) == gid
    assert await purge_worker.rehome_graph_for_data_source(
        data_source_id=ds, to_workspace_id="ws_a", refuse_busy=False) == gid
    assert (await _graph(gid))[0] == "ws_a"
    async with db.graphver_session() as s:
        (await s.get(models.JobORM, busy.id)).status = "completed"

    # someone's open draft goes with it, still open: the move's preview names its owner if they
    # can't reach the new workspace. The graph and every job move; moving again changes nothing
    draft = await svc.open_draft(graph_id=gid, owner="bob")
    assert await purge_worker.rehome_graph_for_data_source(data_source_id=ds, to_workspace_id="ws_b") == gid
    assert await _graph(gid) == ("ws_b", None, None, {"ws_b"})
    async with db.graphver_session() as s:
        assert (await s.get(models.BranchORM, draft)).status == "open"
    assert await purge_worker.rehome_graph_for_data_source(data_source_id=ds, to_workspace_id="ws_b") == gid
    assert await svc.move_graph_workspace(ds, "ws_b", from_workspace_id="ws_a") == [gid]

    # its history answers where it went, and only there
    async with AsyncClient(transport=ASGITransport(app=_app()), base_url="http://test") as c:
        assert (await c.get(f"/api/v1/ws_b/versioning/graphs/{gid}")).status_code == 200
        assert (await c.get(f"/api/v1/ws_a/versioning/graphs/{gid}")).status_code == 404
    assert (await svc.main_heads(workspace_id="ws_b", data_source_ids=[ds]))[ds]["graph_id"] == gid
    assert await svc.main_heads(workspace_id="ws_a", data_source_ids=[ds]) == {}

    # an external source has nothing to move
    assert await svc.move_graph_workspace(_ds(), "ws_b", from_workspace_id="ws_a") == []
    assert await purge_worker.rehome_graph_for_data_source(
        data_source_id=_ds(), to_workspace_id="ws_b") is None

    # what a move takes, and what holds it back, is every fork too, at any depth: the preview
    # sees what the move refuses
    ds = _ds()
    root = (await svc.create_graph(data_source_id=ds, workspace_id="ws_a", actor="alice"))["graph_id"]
    fork = (await svc.fork_graph(parent_graph_id=root, workspace_id="ws_a", actor="alice"))["graph_id"]
    deeper = (await svc.fork_graph(parent_graph_id=fork, workspace_id="ws_a",
                                   actor="alice"))["graph_id"]
    await svc.open_draft(graph_id=deeper, owner="carol")
    async with db.graphver_session() as s:
        busy = models.JobORM(job_type="export", graph_id=deeper, workspace_id="ws_a",
                             data_source_id=ds, status="running")
        s.add(busy)
    facts = await lifecycle.relocation_facts(ds)
    assert (facts["forks"], facts["activeJobs"]) == (2, ["export"])
    assert [d["owner"] for d in facts["openDrafts"]] == ["carol"]
    with pytest.raises(purge_worker.MoveBlocked, match="busy"):
        await purge_worker.rehome_graph_for_data_source(data_source_id=ds, to_workspace_id="ws_b")
    assert {(await _graph(g))[0] for g in (root, fork, deeper)} == {"ws_a"}
    async with db.graphver_session() as s:
        (await s.get(models.JobORM, busy.id)).status = "completed"
    assert (await lifecycle.relocation_facts(ds))["activeJobs"] == []
    assert await purge_worker.rehome_graph_for_data_source(data_source_id=ds, to_workspace_id="ws_b") == root
    assert {(await _graph(g))[0] for g in (root, fork, deeper)} == {"ws_b"}


async def _the_reaper_refiles_graphs_left_behind() -> None:
    """The management side is a SQLite holding the data sources' table: the reaper reads it by
    id alone, never joined to the version store."""
    from sqlalchemy.ext.asyncio import async_sessionmaker, create_async_engine

    from backend.app.db.models import WorkspaceDataSourceORM as DS

    engine = create_async_engine("sqlite+aiosqlite://")
    async with engine.begin() as conn:
        await conn.run_sync(lambda c: DS.__table__.create(c))
    sessions = async_sessionmaker(engine, expire_on_commit=False)

    svc = GraphVersioningService()
    moved, trashed, home, expired, busy = _ds(), _ds(), _ds(), _ds(), _ds()
    gids = {ds: (await svc.create_graph(data_source_id=ds, workspace_id="ws_a", actor="alice"))["graph_id"]
            for ds in (moved, trashed, home, expired, busy)}
    fork = (await svc.fork_graph(parent_graph_id=gids[moved], workspace_id="ws_a",
                                 actor="alice"))["graph_id"]
    async with db.graphver_session() as s:
        job = models.JobORM(job_type="export", graph_id=gids[busy], workspace_id="ws_a",
                            data_source_id=busy, status="running")
        held = models.JobORM(job_type="export", graph_id=gids[expired], workspace_id="ws_a",
                             data_source_id=expired, status="running")
        s.add_all([job, held])
    # work open on a graph and its fork moves with them: the source already lives elsewhere
    await svc.open_draft(graph_id=gids[moved], owner="bob")
    await svc.open_pr(source_graph_id=fork, actor="bob")
    async with sessions() as s:
        s.add_all([
            DS(id=moved, workspace_id="ws_b", provider_id="prov_a", graph_name=moved),
            DS(id=busy, workspace_id="ws_b", provider_id="prov_a", graph_name=busy),
            DS(id=trashed, workspace_id="ws_b", provider_id="prov_a", graph_name=trashed,
               deleted_at="2026-10-19T00:00:00+00:00"),
            DS(id=home, workspace_id="ws_a", provider_id="prov_a", graph_name=home),
            # past its grace period, its graph busy with a job — so not yet re-filed
            DS(id=expired, workspace_id="ws_b", provider_id="prov_a", graph_name=expired,
               deleted_at="2026-01-01T00:00:00+00:00"),
        ])
        await s.commit()
    result = await purge_worker.Reaper(app_session_factory=sessions).run_once()
    assert result["rehomed"] >= 2

    assert (await _graph(gids[moved]))[:3] == ("ws_b", None, None)
    assert (await _graph(fork))[:3] == ("ws_b", None, None)     # a fork goes with its graph
    workspace, deleted_at, deleted_by, _jobs = await _graph(gids[trashed])
    assert (workspace, deleted_by) == ("ws_b", "reaper") and deleted_at is not None
    assert (await _graph(gids[home]))[:2] == ("ws_a", None)

    # the expired source's graph stands, filed elsewhere: its row is kept, not removed
    assert (await _graph(gids[expired]))[0] == "ws_a"
    async with sessions() as s:
        assert await s.get(DS, expired) is not None

    # a graph a job runs on stays, job and all, until the job ends; then it is re-filed
    assert await _graph(gids[busy]) == ("ws_a", None, None, {"ws_a"})
    async with db.graphver_session() as s:
        (await s.get(models.JobORM, job.id)).status = "completed"
    await purge_worker.Reaper(app_session_factory=sessions).run_once()
    assert await _graph(gids[busy]) == ("ws_b", None, None, {"ws_b"})
    async with db.graphver_session() as s:
        (await s.get(models.JobORM, held.id)).status = "cancelled"
    await engine.dispose()


async def _run(*steps) -> None:
    await models.create_schema_and_partitions()
    try:
        for step in steps:
            await step()
    finally:
        await db.dispose_engine()


@pytest.mark.skipif(not os.getenv("GRAPHVER_E2E"), reason="set GRAPHVER_E2E=1 + a live Postgres to run")
def test_main_heads_report_only_graphs_whose_version_control_is_on():
    asyncio.run(_run(_main_heads))


@pytest.mark.skipif(not os.getenv("GRAPHVER_E2E"), reason="set GRAPHVER_E2E=1 + a live Postgres to run")
def test_main_heads_answer_the_same_one_source_per_read(monkeypatch):
    from backend.app.services.versioning import service

    monkeypatch.setattr(service, "_HEADS_PER_READ", 1)
    asyncio.run(_run(_main_heads))


@pytest.mark.skipif(not os.getenv("GRAPHVER_E2E"), reason="set GRAPHVER_E2E=1 + a live Postgres to run")
def test_a_graph_in_the_trash_answers_none_of_its_routes():
    asyncio.run(_run(_trashed_graph_answers_nothing))


@pytest.mark.skipif(not os.getenv("GRAPHVER_E2E"), reason="set GRAPHVER_E2E=1 + a live Postgres to run")
def test_a_moved_source_takes_its_graph_unless_version_control_holds_it():
    asyncio.run(_run(_a_move_carries_the_graph))


@pytest.mark.skipif(not os.getenv("GRAPHVER_E2E"), reason="set GRAPHVER_E2E=1 + a live Postgres to run")
def test_the_reaper_refiles_graphs_an_earlier_move_left_behind():
    asyncio.run(_run(_the_reaper_refiles_graphs_left_behind))
