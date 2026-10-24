"""POST /admin/workspaces/{ws}/data-sources/{ds}/move — re-home a data source.

A catalog item belongs to exactly ONE workspace (uq_ds_catalog_item) and is
allocated at onboarding. Getting that allocation wrong had no remedy short of
detaching, which is destructive. This is the remedy.

It used to refuse any source with a view on it, because moving the row alone is
wrong: views.data_source_id stays valid, but a view still carries workspace_id = A
while its source now lives in B, and members of A would read B's data through a
workspace-scoped check that no longer describes reality. Now the views go with the
source — trashed ones too, because restoring one later would recreate exactly that.
The full behaviour (access, requests, undo) is in test_data_source_transfers.py.

A versioned source's graph moves with it, first — with its forks, at any depth and those in the
trash too, and their jobs — so a refusal from version control, or a version store that can't be
reached, fails the request before anything else has moved, and a failure after that puts them
back. The graphver cases need a live Postgres (``GRAPHVER_E2E=1``); the others fake the version
store.

A move races nothing that stamps a workspace: a fork, an import, an export or a publish
started in the old workspace waits for the move's lock and is then refused (a job's start
waits for no main write, and an import refused leaves no draft behind), a second move finds
the graph already gone from the workspace it moves from, and enabling version control waits
for the data source's row, which the move holds. Version control holds a move back while a
job is pending or running on the graph or a fork of it, or while an enable that failed waits
to be resumed or cancelled; open drafts and review requests go with it.
"""
import asyncio
import json
import os
from contextlib import asynccontextmanager
from types import SimpleNamespace

import pytest
import pytest_asyncio
from fastapi import HTTPException
from httpx import AsyncClient
from sqlalchemy import event, select, update
from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker, create_async_engine

from backend.app.db.models import (
    Base, OutboxEventORM, ProviderORM, ViewORM, WorkspaceDataSourceORM, WorkspaceORM,
)
from backend.app.db.repositories import view_repo
from backend.app.services.permission_service import PermissionClaims
from backend.app.services.versioning import config, db, models, purge_worker
from backend.app.services.versioning.import_export.service import ImportExportService
from backend.app.services.versioning.models import BranchORM, GraphORM, JobORM
from backend.app.services.versioning.service import GraphVersioningService
from backend.common.models.management import DataSourceMoveRequest, ViewCreateRequest
from tests.common.transfer_world import fake_version_store

VERSIONED = {"graphId": "graph_a", "activeJobs": [], "commits": 3, "openDrafts": [],
             "openReviews": 0, "forks": 0}


@pytest.fixture(autouse=True)
def version_store(request, monkeypatch):
    """The version store runs on Postgres only: faked, answering ``facts`` (None: the source
    isn't versioned) and recording each relocation — unless the test asks for the live one."""
    if "live_store" in request.fixturenames:
        return None
    return fake_version_store(monkeypatch)


_E2E = bool(os.getenv("GRAPHVER_E2E"))
e2e = pytest.mark.skipif(not _E2E, reason="set GRAPHVER_E2E=1 + a live Postgres")


@pytest.fixture(autouse=True)
async def _graphver():
    """The live version store under GRAPHVER_E2E."""
    if not _E2E:
        yield
        return
    db._engine = None                       # an engine cached by another test's loop is unusable
    db._session_factory = None
    await models.create_schema_and_partitions()
    yield
    await db.dispose_engine()


@pytest.fixture
def live_store(monkeypatch):
    """A move against the live version store (``GRAPHVER_E2E``), with only the caches, which
    have nothing to hold here, left out."""
    from backend.app.services import data_source_transfer

    async def _no_caches(**_kw):
        return None
    monkeypatch.setattr(data_source_transfer, "_invalidate_reads", _no_caches)


async def _workspace(client: AsyncClient, name: str) -> str:
    resp = await client.post("/api/v1/admin/workspaces", json={"name": name, "dataSources": []})
    assert resp.status_code == 201
    return resp.json()["id"]


async def _provider(client: AsyncClient, name: str) -> str:
    resp = await client.post(
        "/api/v1/admin/providers", json={"name": name, "providerType": "falkordb"},
    )
    assert resp.status_code in (200, 201)
    return resp.json()["id"]


async def _catalog_item(client: AsyncClient, name: str) -> str:
    provider_id = await _provider(client, f"Prov {name}")
    resp = await client.post("/api/v1/admin/catalog", json={
        "name": name,
        "providerId": provider_id,
        "sourceIdentifier": f"graph_{name}",
    })
    assert resp.status_code in (200, 201)
    return resp.json()["id"]


async def _attach(client: AsyncClient, ws_id: str, item_id: str) -> str:
    resp = await client.post(
        f"/api/v1/admin/workspaces/{ws_id}/data-sources", json={"catalogItemId": item_id},
    )
    assert resp.status_code in (200, 201), resp.text
    return resp.json()["id"]


async def _view_on(session: AsyncSession, ws_id: str, ds_id: str, name: str):
    return await view_repo.create_view(
        session,
        ViewCreateRequest(
            name=name, workspace_id=ws_id, data_source_id=ds_id,
            view_type="graph", visibility="private",
        ),
        user_id="u1",
    )


async def test_moves_a_clean_data_source(test_client: AsyncClient):
    src = await _workspace(test_client, "Wrong Home")
    dst = await _workspace(test_client, "Right Home")
    ds = await _attach(test_client, src, await _catalog_item(test_client, "Orders"))

    resp = await test_client.post(
        f"/api/v1/admin/workspaces/{src}/data-sources/{ds}/move",
        json={"targetWorkspaceId": dst},
    )
    assert resp.status_code == 200, resp.text

    # The row KEEPS ITS ID, so stats/polling/aggregation state follow it for free.
    assert resp.json()["dataSource"]["id"] == ds
    assert resp.json()["status"] == "completed"

    gone = await test_client.get(f"/api/v1/admin/workspaces/{src}")
    assert all(d["id"] != ds for d in gone.json()["dataSources"])

    arrived = await test_client.get(f"/api/v1/admin/workspaces/{dst}")
    assert any(d["id"] == ds for d in arrived.json()["dataSources"])


async def _workspace_of(session: AsyncSession, view_id: str) -> str:
    return (await session.execute(
        select(ViewORM.workspace_id).where(ViewORM.id == view_id))).scalar_one()


async def test_a_source_with_a_view_takes_the_view_with_it(
    test_client: AsyncClient, db_session: AsyncSession,
):
    """What the old zero-views rule protected: the view never ends up in one workspace
    reading a source that lives in another."""
    src = await _workspace(test_client, "Has A View")
    dst = await _workspace(test_client, "Elsewhere")
    ds = await _attach(test_client, src, await _catalog_item(test_client, "Busy"))

    view = await _view_on(db_session, src, ds, "Revenue Lineage")
    await db_session.commit()

    resp = await test_client.post(
        f"/api/v1/admin/workspaces/{src}/data-sources/{ds}/move",
        json={"targetWorkspaceId": dst},
    )
    assert resp.status_code == 200, resp.text
    assert resp.json()["viewCount"] == 1
    assert await _workspace_of(db_session, view.id) == dst


async def test_a_versioned_source_takes_its_history_with_it(
    test_client: AsyncClient, db_session: AsyncSession, version_store,
):
    src = await _workspace(test_client, "Old Home")
    dst = await _workspace(test_client, "New Home")
    ds = await _attach(test_client, src, await _catalog_item(test_client, "Versioned"))
    version_store.facts = VERSIONED

    resp = await test_client.post(
        f"/api/v1/admin/workspaces/{src}/data-sources/{ds}/move",
        json={"targetWorkspaceId": dst},
    )
    assert resp.status_code == 200, resp.text
    assert version_store.relocations == [(ds, dst, True)]

    # Both workspaces' record of the move names the graph that went with it.
    events = (await db_session.execute(select(OutboxEventORM).where(
        OutboxEventORM.event_type == "workspace.data_source.moved"))).scalars().all()
    assert {json.loads(e.payload)["details"]["graphId"] for e in events} == {"graph_a"}


@pytest.mark.parametrize("fail, status, error", [
    (purge_worker.MoveBlocked("Version control is busy with this data source."), 409, "graph_busy"),
    (OSError("connection refused"), 503, "version_store_unavailable"),
])
async def test_when_its_history_cant_move_the_move_is_refused(
    test_client: AsyncClient, monkeypatch, version_store, fail, status, error,
):
    """What the request answers when version control turns the graph down after the preview
    passed — or can't be reached. That it leaves nothing behind is a property of the request's
    transaction, which this fixture's one shared session can't show (see conftest's
    ``test_client``) — the next test checks it with real transactions."""
    src = await _workspace(test_client, "Stays Put")
    dst = await _workspace(test_client, "Never Reached")
    ds = await _attach(test_client, src, await _catalog_item(test_client, f"Pinned {status}"))
    version_store.facts = VERSIONED

    async def refuse(**_kw):
        raise fail

    monkeypatch.setattr(purge_worker, "rehome_graph_for_data_source", refuse)
    resp = await test_client.post(
        f"/api/v1/admin/workspaces/{src}/data-sources/{ds}/move",
        json={"targetWorkspaceId": dst},
    )
    assert resp.status_code == status, resp.text
    assert resp.json()["detail"]["error"] == error
    if status == 409:                                   # the reason, as a sentence to act on
        assert resp.json()["detail"]["message"].startswith(str(fail))


@pytest_asyncio.fixture()
async def scoped_sessions(tmp_path):
    """Sessions with production's transaction scope (``engine._session_scope``: commit on
    success, roll back on error) over a file-backed SQLite, where a rollback is real — set up as
    ``test_auth_revocation_durability.py`` explains."""
    engine = create_async_engine(f"sqlite+aiosqlite:///{tmp_path / 'move.db'}")
    aggregation = tmp_path / "aggregation.db"

    @event.listens_for(engine.sync_engine, "connect")
    def _connect(dbapi_conn, _record):
        dbapi_conn.execute(f"ATTACH DATABASE '{aggregation}' AS aggregation")
        dbapi_conn.isolation_level = None

    @event.listens_for(engine.sync_engine, "begin")
    def _begin(conn):
        conn.exec_driver_sql("BEGIN")

    async with engine.begin() as conn:
        await conn.run_sync(Base.metadata.create_all)
    maker = async_sessionmaker(bind=engine, expire_on_commit=False)

    @asynccontextmanager
    async def scope():
        session = maker()
        try:
            try:
                yield session
                await session.commit()
            except Exception:
                await session.rollback()
                raise
        finally:
            await session.close()

    yield scope
    await engine.dispose()


@pytest.mark.parametrize("fail", [
    purge_worker.MoveBlocked("Version control is busy with this data source."),
    OSError("connection refused"),
])
async def test_when_its_history_cant_move_nothing_moves(scoped_sessions, monkeypatch, version_store,
                                                        fail):
    from backend.app.api.v1.endpoints.workspaces import move_data_source

    async with scoped_sessions() as s:
        s.add_all([
            WorkspaceORM(id="ws_from", name="From"), WorkspaceORM(id="ws_to", name="To"),
            ProviderORM(id="prov_a", name="Store", provider_type="falkordb"),
            WorkspaceDataSourceORM(id="ds_a", workspace_id="ws_from", provider_id="prov_a",
                                   graph_name="orders", is_primary=True),
        ])
    version_store.facts = VERSIONED

    async def refuse(**_kw):
        raise fail

    monkeypatch.setattr(purge_worker, "rehome_graph_for_data_source", refuse)
    with pytest.raises(HTTPException) as refused:
        async with scoped_sessions() as s:
            await move_data_source(
                workspace_id="ws_from", ds_id="ds_a",
                req=DataSourceMoveRequest(target_workspace_id="ws_to"),
                user=SimpleNamespace(id="usr_a"),
                claims=PermissionClaims(sid="", global_perms=("system:admin",)),
                session=s,
            )
    assert refused.value.status_code in (409, 503)

    async with scoped_sessions() as s:
        row = await s.get(WorkspaceDataSourceORM, "ds_a")
        assert (row.workspace_id, row.is_primary) == ("ws_from", True)
        assert (await s.execute(select(OutboxEventORM))).scalars().all() == []


async def test_a_TRASHED_view_moves_too(
    test_client: AsyncClient, db_session: AsyncSession,
):
    """The subtle one.

    A soft-deleted view still has a row pointing at the source. Left behind, restoring it
    after the move would give a view in workspace A reading a source owned by workspace B.
    So the trash moves with the source.
    """
    src = await _workspace(test_client, "Has Trash")
    dst = await _workspace(test_client, "Target")
    ds = await _attach(test_client, src, await _catalog_item(test_client, "Trashy"))

    view = await _view_on(db_session, src, ds, "Deleted But Restorable")
    await view_repo.delete_view(db_session, view.id)
    await db_session.commit()

    resp = await test_client.post(
        f"/api/v1/admin/workspaces/{src}/data-sources/{ds}/move",
        json={"targetWorkspaceId": dst},
    )
    assert resp.status_code == 200, resp.text
    assert await _workspace_of(db_session, view.id) == dst


async def test_moving_into_the_same_workspace_is_rejected(test_client: AsyncClient):
    ws = await _workspace(test_client, "Same")
    ds = await _attach(test_client, ws, await _catalog_item(test_client, "Static"))

    resp = await test_client.post(
        f"/api/v1/admin/workspaces/{ws}/data-sources/{ds}/move",
        json={"targetWorkspaceId": ws},
    )
    assert resp.status_code == 422


async def test_unknown_target_workspace_is_404(test_client: AsyncClient):
    src = await _workspace(test_client, "Real")
    ds = await _attach(test_client, src, await _catalog_item(test_client, "Real Source"))

    resp = await test_client.post(
        f"/api/v1/admin/workspaces/{src}/data-sources/{ds}/move",
        json={"targetWorkspaceId": "ws_nope"},
    )
    assert resp.status_code == 404


async def test_a_data_source_from_another_workspace_is_404_not_moved(
    test_client: AsyncClient,
):
    """The ds must belong to the workspace in the path — otherwise anyone with
    admin on ANY workspace could move a source out of one they don't administer."""
    owner = await _workspace(test_client, "Owner")
    bystander = await _workspace(test_client, "Bystander")
    dst = await _workspace(test_client, "Thief")
    ds = await _attach(test_client, owner, await _catalog_item(test_client, "Precious"))

    resp = await test_client.post(
        f"/api/v1/admin/workspaces/{bystander}/data-sources/{ds}/move",
        json={"targetWorkspaceId": dst},
    )
    assert resp.status_code == 404

    still = await test_client.get(f"/api/v1/admin/workspaces/{owner}")
    assert any(d["id"] == ds for d in still.json()["dataSources"])


async def test_bindings_expose_what_the_ui_needs_to_offer_a_move(test_client: AsyncClient):
    """The picker decides "movable" from the catalog listing, so it must carry the
    data source id and the view count."""
    ws = await _workspace(test_client, "Bound WS")
    item = await _catalog_item(test_client, "Listed")
    ds = await _attach(test_client, ws, item)

    resp = await test_client.get("/api/v1/admin/catalog/bindings")
    assert resp.status_code == 200

    row = next(r for r in resp.json() if r["id"] == item)
    assert row["boundWorkspaceId"] == ws
    assert row["boundDataSourceId"] == ds
    assert row["boundViewCount"] == 0


async def _move(client: AsyncClient, src: str, ds: str, dst: str):
    return await client.post(
        f"/api/v1/admin/workspaces/{src}/data-sources/{ds}/move",
        json={"targetWorkspaceId": dst},
    )


async def _in_workspace(client: AsyncClient, ws: str, ds: str) -> bool:
    resp = await client.get(f"/api/v1/admin/workspaces/{ws}")
    return any(d["id"] == ds for d in resp.json()["dataSources"])


async def test_a_move_that_fails_to_commit_puts_the_graph_back(
    test_client: AsyncClient, db_session: AsyncSession, monkeypatch, version_store,
):
    """The graph has moved when the management commit fails: it is moved back."""
    src = await _workspace(test_client, "Commit Lost")
    dst = await _workspace(test_client, "Commit Lost Target")
    ds = await _attach(test_client, src, await _catalog_item(test_client, "Lost"))
    version_store.facts = VERSIONED

    commit = db_session.commit
    failed = []

    async def _fail_once():
        if not failed:
            failed.append(True)
            raise RuntimeError("commit lost")
        await commit()
    monkeypatch.setattr(db_session, "commit", _fail_once)

    resp = await _move(test_client, src, ds, dst)
    assert resp.status_code == 500, resp.text
    assert version_store.relocations == [(ds, dst, True), (ds, src, False)]
    assert await _in_workspace(test_client, src, ds)


async def test_a_move_cancelled_after_the_graph_moved_puts_it_back(
    test_client: AsyncClient, db_session: AsyncSession, monkeypatch, version_store,
):
    """A request cancelled once the graph has moved (its time ran out, the client went away)
    still moves the graph back: the source stays in A, so must its history."""
    src = await _workspace(test_client, "Cancelled")
    dst = await _workspace(test_client, "Cancelled Target")
    ds = await _attach(test_client, src, await _catalog_item(test_client, "Cut Off"))
    version_store.facts = VERSIONED

    commit = db_session.commit
    cancelled = []

    async def _cancel_once():
        if not cancelled:
            cancelled.append(True)
            raise asyncio.CancelledError()
        await commit()
    monkeypatch.setattr(db_session, "commit", _cancel_once)

    await _move(test_client, src, ds, dst)          # the middleware answers for the cancelled handler
    assert version_store.relocations == [(ds, dst, True), (ds, src, False)]


async def test_a_commit_that_landed_but_raised_keeps_the_graph_with_the_source(
    test_client: AsyncClient, db_session: AsyncSession, monkeypatch, version_store,
):
    """The management commit lands and only its answer is lost (a connection reset after the
    server committed): the source is in B, so its history stays there, and the retry is
    answered with the move it made."""
    src = await _workspace(test_client, "Answer Lost")
    dst = await _workspace(test_client, "Answer Lost Target")
    ds = await _attach(test_client, src, await _catalog_item(test_client, "Landed"))
    version_store.facts = VERSIONED

    commit = db_session.commit
    lost = []

    async def _land_then_fail_once():
        await commit()
        if not lost:
            lost.append(True)
            raise ConnectionResetError("connection reset after COMMIT")
    monkeypatch.setattr(db_session, "commit", _land_then_fail_once)

    assert (await _move(test_client, src, ds, dst)).status_code == 503   # a lost connection's answer
    assert version_store.relocations == [(ds, dst, True)], \
        "the graph is not moved back from where its source now is"
    assert await _in_workspace(test_client, dst, ds)

    retry = await _move(test_client, src, ds, dst)
    assert retry.status_code == 200, retry.text
    assert (retry.json()["status"], retry.json()["toWorkspace"]["id"]) == ("completed", dst)
    assert version_store.relocations == [(ds, dst, True)]


@e2e
async def test_a_failed_move_puts_the_graph_and_its_forks_back(
    test_client: AsyncClient, db_session: AsyncSession, monkeypatch, live_store,
):
    """Someone in B opens a draft on the graph between its move and the management commit,
    which then fails: the graph and its fork still move back with the source, draft and all."""
    src = await _workspace(test_client, "Back Home")
    dst = await _workspace(test_client, "Back Target")
    ds = await _attach(test_client, src, await _catalog_item(test_client, "Back"))
    gid, fork = await _versioned(ds, src)
    svc = GraphVersioningService()

    commit = db_session.commit
    failed, drafts = [], []

    async def _draft_then_fail_once():
        if not failed:
            failed.append(True)
            drafts.append(await svc.open_draft(graph_id=gid, owner="carol"))
            raise RuntimeError("commit lost")
        await commit()
    monkeypatch.setattr(db_session, "commit", _draft_then_fail_once)

    resp = await _move(test_client, src, ds, dst)
    assert resp.status_code == 500, resp.text
    assert await _in_workspace(test_client, src, ds)
    assert await _homes(gid, fork) == {src}
    async with db.graphver_session() as s:
        assert (await s.get(BranchORM, drafts[0])).status == "open"


@e2e
async def test_a_failed_move_puts_the_graph_back_while_a_job_runs_on_it(
    test_client: AsyncClient, db_session: AsyncSession, monkeypatch, live_store,
):
    """Someone in B starts an export on the fork between the graph's move and the management
    commit, which then fails: the graph, its fork and the job still go back with the source.
    Only a person's move waits for a job; left in B, the history would answer there and not
    where its source is."""
    src = await _workspace(test_client, "Busy Home")
    dst = await _workspace(test_client, "Busy Target")
    ds = await _attach(test_client, src, await _catalog_item(test_client, "Busy"))
    gid, fork = await _versioned(ds, src)

    commit = db_session.commit
    jobs = []

    async def _job_then_fail_once():
        if not jobs:
            async with db.graphver_session() as s:
                job = JobORM(job_type="export", graph_id=fork, workspace_id=dst,
                             data_source_id=ds, status="running")
                s.add(job)
            jobs.append(job.id)
            raise RuntimeError("commit lost")
        await commit()
    monkeypatch.setattr(db_session, "commit", _job_then_fail_once)

    resp = await _move(test_client, src, ds, dst)
    assert resp.status_code == 500, resp.text
    assert await _in_workspace(test_client, src, ds)
    assert await _homes(gid, fork) == {src}
    async with db.graphver_session() as s:
        assert (await s.get(JobORM, jobs[0])).workspace_id == src


def _row_locks(session: AsyncSession) -> list:
    """How each read of a data source row on ``session`` locks it: "update", "share" or None."""
    seen = []

    def _on(state):
        if state.is_select and any(d.get("entity") is WorkspaceDataSourceORM
                                   for d in state.statement.column_descriptions):
            arg = state.statement._for_update_arg
            seen.append(None if arg is None else "share" if arg.read else "update")
    event.listen(session.sync_session, "do_orm_execute", _on)
    return seen


async def test_a_move_holds_the_data_source_row_from_its_first_read(
    test_client: AsyncClient, db_session: AsyncSession,
):
    """A second move, or an enable of version control, waits for this one on the row, and then
    finds the source gone from the workspace it was asked in."""
    src = await _workspace(test_client, "Row Held")
    dst = await _workspace(test_client, "Row Held Target")
    ds = await _attach(test_client, src, await _catalog_item(test_client, "Held"))

    locks = _row_locks(db_session)
    assert (await _move(test_client, src, ds, dst)).status_code == 200
    assert locks[0] == "update"


@pytest.mark.parametrize("permanent", [False, True])
async def test_a_delete_holds_the_data_source_row_from_its_first_read(
    test_client: AsyncClient, db_session: AsyncSession, monkeypatch, permanent,
):
    """A delete from the old workspace while a move, undo or accept of the source is in flight
    waits for it on the row, then finds the source gone (404). Read without the lock, it would
    trash or destroy the source where it went, and miss its graph, which went too."""
    ws = await _workspace(test_client, f"Deleting {permanent}")
    ds = await _attach(test_client, ws, await _catalog_item(test_client, f"Doomed {permanent}"))
    await _attach(test_client, ws, await _catalog_item(test_client, f"Kept {permanent}"))

    async def _nothing(**_kw):
        return []
    monkeypatch.setattr(purge_worker, "tombstone_graphs_for_data_source", _nothing)
    monkeypatch.setattr(purge_worker, "purge_graph_for_data_source", _nothing)

    locks = _row_locks(db_session)
    resp = await test_client.delete(f"/api/v1/admin/workspaces/{ws}/data-sources/{ds}",
                                    params={"permanent": str(permanent).lower()})
    assert resp.status_code == 204, resp.text
    assert locks[0] == "update"


async def test_enabling_version_control_holds_the_data_source_row(
    test_client: AsyncClient, db_session: AsyncSession,
):
    """Enable reads the source FOR SHARE and keeps it until its graph and job are committed: a
    move waits for them and moves them along, or wins and the enable finds no source here."""
    from backend.app.api.v1.endpoints.graph import _data_source_in_workspace
    ws = await _workspace(test_client, "Enabling")
    ds = await _attach(test_client, ws, await _catalog_item(test_client, "To Version"))

    locks = _row_locks(db_session)
    await _data_source_in_workspace(db_session, ds, ws)
    assert locks == ["share"]


async def _versioned(ds: str, ws: str):
    svc = GraphVersioningService()
    gid = (await svc.create_graph(data_source_id=ds, workspace_id=ws, actor="u1"))["graph_id"]
    fork = (await svc.fork_graph(parent_graph_id=gid, workspace_id=ws, actor="u1"))["graph_id"]
    return gid, fork


async def _homes(*gids: str) -> set:
    """The workspaces the graphs ``gids`` are filed under."""
    async with db.graphver_session() as s:
        return set((await s.execute(select(GraphORM.workspace_id).where(
            GraphORM.id.in_(gids)))).scalars())


@e2e
async def test_the_versioned_graph_and_its_forks_move_with_the_source(
    test_client: AsyncClient, live_store,
):
    """The preview says the fork goes too. History is read through the new workspace's
    versioning routes, and is gone from the old one's — for the graph and for its fork."""
    src = await _workspace(test_client, "Versioned Home")
    dst = await _workspace(test_client, "Versioned Target")
    ds = await _attach(test_client, src, await _catalog_item(test_client, "Versioned"))
    gid, fork = await _versioned(ds, src)

    preview = await test_client.get(f"/api/v1/admin/workspaces/{src}/data-sources/{ds}/move-preview",
                                    params={"to": dst})
    assert preview.status_code == 200, preview.text
    assert preview.json()["versioning"]["forks"] == 1
    assert {n["code"]: n["message"] for n in preview.json()["notes"]}["forks"] == \
        "1 fork of its version history moves with it."

    resp = await _move(test_client, src, ds, dst)
    assert resp.status_code == 200, resp.text

    for g in (gid, fork):
        moved = await test_client.get(f"/api/v1/{dst}/versioning/graphs/{g}/commits")
        assert moved.status_code == 200, moved.text
        assert moved.json()["commits"], "the history moved with the graph"
        left = await test_client.get(f"/api/v1/{src}/versioning/graphs/{g}/commits")
        assert left.status_code == 404


@e2e
async def test_undoing_a_move_brings_the_graph_and_its_forks_back(
    test_client: AsyncClient, live_store,
):
    """An undo is a move back: the graph and its forks, those in the trash too, go with it."""
    src = await _workspace(test_client, "Undo Home")
    dst = await _workspace(test_client, "Undo Target")
    ds = await _attach(test_client, src, await _catalog_item(test_client, "Undone"))
    gid, fork = await _versioned(ds, src)
    svc = GraphVersioningService()
    trashed = (await svc.fork_graph(parent_graph_id=gid, workspace_id=src, actor="u1"))["graph_id"]
    await svc.delete_fork(graph_id=trashed, workspace_id=src, actor="u1")

    moved = await _move(test_client, src, ds, dst)
    assert moved.status_code == 200, moved.text
    assert await _homes(gid, fork, trashed) == {dst}

    undone = await test_client.post(
        f"/api/v1/admin/data-source-transfers/{moved.json()['id']}/undo")
    assert undone.status_code == 200, undone.text
    assert undone.json()["status"] == "undone"
    assert await _in_workspace(test_client, src, ds)
    assert await _homes(gid, fork, trashed) == {src}


@e2e
async def test_a_job_on_a_fork_refuses_the_move(test_client: AsyncClient, live_store):
    """A job carries the workspace it was queued in, so nothing moves while one is pending or
    running on the graph or any fork of it — named before anything is changed."""
    src = await _workspace(test_client, "Busy Home")
    dst = await _workspace(test_client, "Busy Target")
    ds = await _attach(test_client, src, await _catalog_item(test_client, "Busy Graph"))
    gid, fork = await _versioned(ds, src)
    async with db.graphver_session() as s:
        job = JobORM(job_type="export", graph_id=fork, workspace_id=src, status="running")
        s.add(job)
        await s.flush()
        job_id = job.id
    try:
        resp = await _move(test_client, src, ds, dst)
        assert resp.status_code == 409, resp.text
        detail = resp.json()["detail"]
        assert detail["error"] == "blocked"
        assert [i["code"] for i in detail["issues"]] == ["graph_busy"]

        assert await _in_workspace(test_client, src, ds)
        for g in (gid, fork):
            still = await test_client.get(f"/api/v1/{src}/versioning/graphs/{g}/commits")
            assert still.status_code == 200, still.text
    finally:
        async with db.graphver_session() as s:
            (await s.get(JobORM, job_id)).status = "cancelled"


@e2e
async def test_a_job_started_after_the_check_refuses_the_move_with_graph_busy(
    test_client: AsyncClient, monkeypatch, live_store,
):
    """A job queued on a fork between the preview's check and the graph's move meets the move's
    lock and refusal instead: 409 graph_busy, and nothing has moved."""
    from backend.app.services.versioning import lifecycle

    src = await _workspace(test_client, "Late Job Home")
    dst = await _workspace(test_client, "Late Job Target")
    ds = await _attach(test_client, src, await _catalog_item(test_client, "Late Job"))
    gid, fork = await _versioned(ds, src)
    checked = lifecycle.relocation_facts
    jobs = []

    async def _then_a_job_starts(ds_id):
        facts = await checked(ds_id)
        ie = ImportExportService(GraphVersioningService(), store=None)
        jobs.append((await ie.create_export_job(workspace_id=src, data_source_id=ds,
                                                graph_id=fork, actor="u1"))["job_id"])
        return facts
    monkeypatch.setattr(lifecycle, "relocation_facts", _then_a_job_starts)
    try:
        resp = await _move(test_client, src, ds, dst)
        assert resp.status_code == 409, resp.text
        assert resp.json()["detail"]["error"] == "graph_busy"
        assert resp.json()["detail"]["message"].startswith("Version control is busy")
        assert await _in_workspace(test_client, src, ds)
        assert await _homes(gid, fork) == {src}
    finally:
        async with db.graphver_session() as s:
            for job_id in jobs:
                (await s.get(JobORM, job_id)).status = "cancelled"


@e2e
async def test_impact_in_the_new_workspace_shows_the_versioned_graph(
    test_client: AsyncClient, live_store,
):
    src = await _workspace(test_client, "Impact Home")
    dst = await _workspace(test_client, "Impact Target")
    ds = await _attach(test_client, src, await _catalog_item(test_client, "Impactful"))
    await _versioned(ds, src)

    assert (await _move(test_client, src, ds, dst)).status_code == 200

    resp = await test_client.get(f"/api/v1/admin/workspaces/{dst}/data-sources/{ds}/impact")
    assert resp.status_code == 200, resp.text
    versioning = resp.json()["versioning"]
    assert versioning["versioned"] is True
    assert versioning["forks"] == 1


async def _write_during_move(gid: str, ws: str, write):
    """Start ``write`` while a move of ``gid`` into ``ws`` holds the graph's lock, then commit the
    move. Returns the write, which must have waited for the move."""
    async with db.graphver_session() as s:
        await GraphVersioningService._lock_graph(s, gid)
        await GraphVersioningService._lock_move(s, gid)
        await s.execute(update(GraphORM).where(GraphORM.id == gid).values(workspace_id=ws))
        task = asyncio.ensure_future(write())
        await asyncio.sleep(0.5)
        waited = not task.done()
    assert waited, "the write did not wait for the move"
    return task


async def _graph(ds: str, ws: str):
    svc = GraphVersioningService()
    created = await svc.create_graph(data_source_id=ds, workspace_id=ws, actor="u1")
    return svc, created["graph_id"]


@e2e
async def test_a_fork_started_during_the_move_is_refused_not_left_in_the_old_workspace():
    ds = "ds_" + os.urandom(4).hex()
    svc, gid = await _graph(ds, "ws_old")
    fork = await _write_during_move(gid, "ws_new", lambda: svc.fork_graph(
        parent_graph_id=gid, workspace_id="ws_old", actor="u1"))
    with pytest.raises(ValueError):
        await fork
    async with db.graphver_session() as s:
        assert (await s.scalar(select(GraphORM.id).where(
            GraphORM.fork_parent_graph_id == gid))) is None


@e2e
@pytest.mark.parametrize("kind", ["import", "export", "publish"])
async def test_a_job_started_during_the_move_is_refused_not_left_in_the_old_workspace(kind):
    ds = "ds_" + os.urandom(4).hex()
    svc, gid = await _graph(ds, "ws_old")
    draft = await svc.open_draft(graph_id=gid, owner="u1")
    ie = ImportExportService(svc, store=None)
    start = {
        "import": lambda: ie.create_import_job(
            workspace_id="ws_old", data_source_id=ds, graph_id=gid, actor="u1",
            import_format="ndjson", branch_id=draft),
        "export": lambda: ie.create_export_job(
            workspace_id="ws_old", data_source_id=ds, graph_id=gid, actor="u1"),
        "publish": lambda: ie.create_publish_job(
            workspace_id="ws_old", data_source_id=ds, graph_id=gid, branch_id=draft,
            actor="u1", message="big"),
    }[kind]
    job = await _write_during_move(gid, "ws_new", start)
    with pytest.raises(ValueError):
        await job
    async with db.graphver_session() as s:
        assert (await s.scalar(select(JobORM.id).where(JobORM.graph_id == gid))) is None


@e2e
async def test_an_import_into_a_new_draft_refused_by_the_move_leaves_no_draft():
    """The draft an import opens is opened with its job, after the workspace check: an import
    the move refuses leaves no empty draft on the graph in the new workspace."""
    ds = "ds_" + os.urandom(4).hex()
    svc, gid = await _graph(ds, "ws_old")
    ie = ImportExportService(svc, store=None)
    job = await _write_during_move(gid, "ws_new", lambda: ie.create_import_job(
        workspace_id="ws_old", data_source_id=ds, graph_id=gid, actor="u1",
        import_format="ndjson"))
    with pytest.raises(ValueError):
        await job
    async with db.graphver_session() as s:
        assert (await s.scalar(select(BranchORM.id).where(
            BranchORM.graph_id == gid, BranchORM.kind == "draft"))) is None


@e2e
@pytest.mark.parametrize("kind", ["import", "new-draft import", "export", "publish"])
async def test_a_job_does_not_wait_for_a_long_main_write(kind, monkeypatch):
    """A publish, resync or bulk ingest holds the graph's lock for its whole squash: starting a
    job meanwhile neither waits for it nor fails with lock_busy. Only a move fences jobs."""
    monkeypatch.setattr(config, "GRAPH_LOCK_TIMEOUT_MS", 300)
    ds = "ds_" + os.urandom(4).hex()
    svc, gid = await _graph(ds, "ws_a")
    draft = await svc.open_draft(graph_id=gid, owner="u1")
    ie = ImportExportService(svc, store=None)
    start = {
        "import": lambda: ie.create_import_job(
            workspace_id="ws_a", data_source_id=ds, graph_id=gid, actor="u1",
            import_format="ndjson", branch_id=draft),
        "new-draft import": lambda: ie.create_import_job(
            workspace_id="ws_a", data_source_id=ds, graph_id=gid, actor="u1",
            import_format="ndjson"),
        "export": lambda: ie.create_export_job(
            workspace_id="ws_a", data_source_id=ds, graph_id=gid, actor="u1"),
        "publish": lambda: ie.create_publish_job(
            workspace_id="ws_a", data_source_id=ds, graph_id=gid, branch_id=draft,
            actor="u1", message="big"),
    }[kind]
    async with db.graphver_session() as s:          # the main write, still running
        await GraphVersioningService._lock_graph(s, gid)
        created = await asyncio.wait_for(start(), 3)
    assert created["job_id"]


@e2e
async def test_a_second_move_from_the_old_workspace_finds_the_graph_gone():
    """Two moves of one source to different workspaces: the second is refused, so the graph
    cannot end in one workspace and the source in the other. Moving it again to where its graph
    already is goes through: that finishes a move whose source did not follow."""
    from backend.app.services.versioning.errors import GraphMoved
    ds = "ds_" + os.urandom(4).hex()
    gid, fork = await _versioned(ds, "ws_a")
    svc = GraphVersioningService()
    assert await svc.move_graph_workspace(ds, "ws_b", from_workspace_id="ws_a") == [gid, fork]
    with pytest.raises(GraphMoved):
        await svc.move_graph_workspace(ds, "ws_c", from_workspace_id="ws_a")
    assert (await svc.get_graph(gid))["workspace_id"] == "ws_b"
    assert await svc.move_graph_workspace(ds, "ws_b", from_workspace_id="ws_a") == [gid, fork]


@e2e
async def test_open_work_on_a_fork_moves_with_it():
    """A draft or review open on a fork goes with the fork, as one on the graph does: still
    open, answered in the new workspace."""
    ds = "ds_" + os.urandom(4).hex()
    gid, fork = await _versioned(ds, "ws_a")
    svc = GraphVersioningService()

    draft = await svc.open_draft(graph_id=fork, owner="bob")
    pr = await svc.open_pr(source_graph_id=fork, actor="bob")
    assert await svc.move_graph_workspace(ds, "ws_b", from_workspace_id="ws_a") == [gid, fork]
    assert await _homes(gid, fork) == {"ws_b"}
    async with db.graphver_session() as s:
        assert (await s.get(BranchORM, draft)).status == "open"
    assert (await svc.get_pr(pr))["status"] not in ("merged", "closed")


@e2e
async def test_open_work_on_a_trashed_fork_moves_with_it():
    """A trashed fork moves with its graph, its drafts and reviews too, so restoring it brings
    them back where its graph is."""
    ds = "ds_" + os.urandom(4).hex()
    gid, fork = await _versioned(ds, "ws_a")
    svc = GraphVersioningService()
    draft = await svc.open_draft(graph_id=fork, owner="bob")
    await svc.open_draft_mr(graph_id=fork, branch_id=draft, actor="bob")
    await svc.delete_fork(graph_id=fork, workspace_id="ws_a", actor="bob")
    assert await svc.move_graph_workspace(ds, "ws_b", from_workspace_id="ws_a") == [gid, fork]


@e2e
async def test_a_draft_opened_during_the_move_is_waited_for_and_moves_with_it():
    """A draft that opens while the move takes the graph's row finishes first, then moves with
    the graph: it does not open unseen in the workspace the graph is leaving."""
    ds = "ds_" + os.urandom(4).hex()
    svc, gid = await _graph(ds, "ws_a")
    async with db.graphver_session() as s:        # open_draft, its transaction not yet committed
        draft = await svc._add_draft(s, graph_id=gid, owner="bob")
        move = asyncio.ensure_future(svc.move_graph_workspace(ds, "ws_b", from_workspace_id="ws_a"))
        await asyncio.sleep(0.5)
        assert not move.done(), "the move did not wait for the draft being opened"
    assert await move == [gid]
    assert (await svc.get_graph(gid))["workspace_id"] == "ws_b"
    async with db.graphver_session() as s:
        assert (await s.get(BranchORM, draft)).status == "open"


@e2e
async def test_an_enable_that_failed_holds_the_move_back():
    """A failed enable is resumed or cancelled where it was started, not moved half-done."""
    ds = "ds_" + os.urandom(4).hex()
    svc, gid = await _graph(ds, "ws_a")
    async with db.graphver_session() as s:
        job = JobORM(job_type="bootstrap", graph_id=gid, workspace_id="ws_a", data_source_id=ds,
                     status="failed")
        s.add(job)
    with pytest.raises(purge_worker.MoveBlocked, match="didn't finish. Resume or cancel it first"):
        await svc.move_graph_workspace(ds, "ws_b", from_workspace_id="ws_a")
    assert (await svc.get_graph(gid))["workspace_id"] == "ws_a"
    async with db.graphver_session() as s:
        (await s.get(JobORM, job.id)).status = "cancelled"
    assert await svc.move_graph_workspace(ds, "ws_b", from_workspace_id="ws_a") == [gid]
