"""POST /admin/workspaces/{ws}/data-sources/{ds}/move — re-home a data source.

A catalog item belongs to exactly ONE workspace (uq_ds_catalog_item) and is
allocated at onboarding. Getting that allocation wrong had no remedy short of
detaching, which is destructive. This is the remedy, restricted to the case where
it is provably safe: nothing is built on the source.

The zero-views rule is not caution, it is correctness:

  * views.data_source_id is ON DELETE SET NULL, so detach-and-re-add does not
    delete the old workspace's views — it silently ORPHANS them.
  * Moving the row in place keeps data_source_id valid, but the view still carries
    workspace_id = A while its source now lives in B. Members of A would read B's
    data through a workspace-scoped RBAC check that no longer describes reality.

Soft-deleted views count, because restoring one would recreate exactly that.

The versioned graph and its forks move with the source, before the management row
does. The graphver cases need a live Postgres (``GRAPHVER_E2E=1``); without it the
move finds no versioned graph.

A move races nothing that stamps a workspace: a fork, an import, an export or a publish
started in the old workspace waits for the move's lock and is then refused (a job's start
waits for no main write, and an import refused leaves no draft behind), a second
move finds the graph already gone from the workspace it moves from, and enabling version
control waits for the data source's row, which the move holds. A move whose graph could
not be put back says so, and how to finish it. Version control also holds a move back, with
the reason, while an enable that failed waits to be resumed or cancelled, or while the graph
or a fork of it has open drafts or review requests, so nothing moves.
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
    Base, OutboxEventORM, ProviderORM, WorkspaceDataSourceORM, WorkspaceORM,
)
from backend.app.db.repositories import view_repo
from backend.app.services.permission_service import PermissionClaims
from backend.app.services.versioning import config, db, models, purge_worker
from backend.app.services.versioning.errors import JobActive
from backend.app.services.versioning.import_export.service import ImportExportService
from backend.app.services.versioning.models import BranchORM, GraphORM, JobORM
from backend.app.services.versioning.service import GraphVersioningService
from backend.common.models.management import DataSourceMoveRequest, ViewCreateRequest


@pytest.fixture
def version_store(monkeypatch):
    """The version store's side of a move, faked: records each call; answers ``graph`` (None:
    the source isn't versioned) or raises ``fail``."""
    state = {"calls": [], "graph": None, "fail": None}

    async def move(_self, ds_id, ws_id, **_kw):
        state["calls"].append((ds_id, ws_id))
        if state["fail"] is not None:
            raise state["fail"]
        return [state["graph"]] if state["graph"] else []

    monkeypatch.setattr(GraphVersioningService, "move_graph_workspace", move)
    return state


_E2E = bool(os.getenv("GRAPHVER_E2E"))
e2e = pytest.mark.skipif(not _E2E, reason="set GRAPHVER_E2E=1 + a live Postgres")


@pytest.fixture(autouse=True)
async def _graphver(monkeypatch):
    """The version store: a live one under GRAPHVER_E2E, otherwise one with no graphs."""
    if not _E2E:
        async def _no_graph(_self, _ds, _ws, **_kw):
            return []
        monkeypatch.setattr(GraphVersioningService, "move_graph_workspace", _no_graph)
        yield
        return
    db._engine = None                       # an engine cached by another test's loop is unusable
    db._session_factory = None
    await models.create_schema_and_partitions()
    yield
    await db.dispose_engine()


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
    assert resp.json()["id"] == ds

    gone = await test_client.get(f"/api/v1/admin/workspaces/{src}")
    assert all(d["id"] != ds for d in gone.json()["dataSources"])

    arrived = await test_client.get(f"/api/v1/admin/workspaces/{dst}")
    assert any(d["id"] == ds for d in arrived.json()["dataSources"])


async def test_refuses_to_move_a_source_with_a_view(
    test_client: AsyncClient, db_session: AsyncSession, version_store,
):
    """The whole point of the restriction."""
    src = await _workspace(test_client, "Has A View")
    dst = await _workspace(test_client, "Elsewhere")
    ds = await _attach(test_client, src, await _catalog_item(test_client, "Busy"))

    await _view_on(db_session, src, ds, "Revenue Lineage")
    await db_session.commit()

    resp = await test_client.post(
        f"/api/v1/admin/workspaces/{src}/data-sources/{ds}/move",
        json={"targetWorkspaceId": dst},
    )
    assert resp.status_code == 409
    assert "1 view is built on this data source" in resp.json()["detail"]

    # And it did NOT move — nor did anything ask the version store to.
    still = await test_client.get(f"/api/v1/admin/workspaces/{src}")
    assert any(d["id"] == ds for d in still.json()["dataSources"])
    assert version_store["calls"] == []


async def test_a_versioned_source_takes_its_history_with_it(
    test_client: AsyncClient, db_session: AsyncSession, version_store,
):
    src = await _workspace(test_client, "Old Home")
    dst = await _workspace(test_client, "New Home")
    ds = await _attach(test_client, src, await _catalog_item(test_client, "Versioned"))
    version_store["graph"] = "graph_a"

    resp = await test_client.post(
        f"/api/v1/admin/workspaces/{src}/data-sources/{ds}/move",
        json={"targetWorkspaceId": dst},
    )
    assert resp.status_code == 200, resp.text
    assert version_store["calls"] == [(ds, dst)]

    events = (await db_session.execute(select(OutboxEventORM).where(
        OutboxEventORM.event_type == "workspace.datasource.moved"))).scalars().all()
    assert [json.loads(e.payload)["graph_id"] for e in events] == ["graph_a"]


@pytest.mark.parametrize("fail, status", [
    (purge_worker.MoveBlocked("2 open drafts are on this data source's version history."), 409),
    (OSError("connection refused"), 503),
])
async def test_when_its_history_cant_move_the_move_is_refused(
    test_client: AsyncClient, version_store, fail, status,
):
    """What the request answers. That it leaves nothing behind is a property of the request's
    transaction, which this fixture's one shared session can't show (see conftest's
    ``test_client``) — the next test checks it with real transactions."""
    src = await _workspace(test_client, "Stays Put")
    dst = await _workspace(test_client, "Never Reached")
    ds = await _attach(test_client, src, await _catalog_item(test_client, f"Pinned {status}"))
    version_store["fail"] = fail

    resp = await test_client.post(
        f"/api/v1/admin/workspaces/{src}/data-sources/{ds}/move",
        json={"targetWorkspaceId": dst},
    )
    assert resp.status_code == status, resp.text
    assert version_store["calls"] == [(ds, dst)]
    if status == 409:
        assert resp.json()["detail"] == str(fail)       # the reason, as a sentence to act on


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
    purge_worker.MoveBlocked("1 open draft is on this data source's version history."),
    OSError("connection refused"),
])
async def test_when_its_history_cant_move_nothing_moves(scoped_sessions, version_store, fail):
    from backend.app.api.v1.endpoints.workspaces import move_data_source

    async with scoped_sessions() as s:
        s.add_all([
            WorkspaceORM(id="ws_from", name="From"), WorkspaceORM(id="ws_to", name="To"),
            ProviderORM(id="prov_a", name="Store", provider_type="falkordb"),
            WorkspaceDataSourceORM(id="ds_a", workspace_id="ws_from", provider_id="prov_a",
                                   graph_name="orders", is_primary=True),
        ])
    version_store["fail"] = fail

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


async def test_a_TRASHED_view_also_blocks_the_move(
    test_client: AsyncClient, db_session: AsyncSession,
):
    """The subtle one.

    A soft-deleted view still has a row pointing at the source. Restore it after a
    move and you have a view in workspace A reading a source owned by workspace B —
    exactly the state the rule exists to prevent. So the trash blocks it too.
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
    assert resp.status_code == 409, (
        "a view in the trash can be restored, which would strand it across workspaces"
    )


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


async def test_a_version_store_it_cannot_reach_refuses_the_move(
    test_client: AsyncClient, monkeypatch,
):
    """The graph moves first. If it cannot, nothing moves: no source in B with its
    history stranded in A."""
    async def _down(_self, _ds, _ws, **_kw):
        raise OSError("connection refused")
    monkeypatch.setattr(GraphVersioningService, "move_graph_workspace", _down)

    src = await _workspace(test_client, "Store Down")
    dst = await _workspace(test_client, "Store Down Target")
    ds = await _attach(test_client, src, await _catalog_item(test_client, "Unreachable"))

    resp = await _move(test_client, src, ds, dst)
    assert resp.status_code == 503, resp.text
    assert await _in_workspace(test_client, src, ds)


async def test_a_move_that_fails_to_commit_puts_the_graph_back(
    test_client: AsyncClient, db_session: AsyncSession, monkeypatch,
):
    """The graph has moved when the management commit fails: it is moved back."""
    calls = []

    async def _record(_self, ds_id, ws_id, **_kw):
        calls.append((ds_id, ws_id))
        return ["g_moved"]
    monkeypatch.setattr(GraphVersioningService, "move_graph_workspace", _record)

    src = await _workspace(test_client, "Commit Lost")
    dst = await _workspace(test_client, "Commit Lost Target")
    ds = await _attach(test_client, src, await _catalog_item(test_client, "Lost"))

    commit = db_session.commit
    failed = []

    async def _fail_once():
        if not failed:
            failed.append(True)
            raise RuntimeError("commit lost")
        await commit()
    monkeypatch.setattr(db_session, "commit", _fail_once)

    resp = await _move(test_client, src, ds, dst)
    assert resp.status_code == 503, resp.text
    assert "Nothing has been changed" in resp.json()["detail"]
    assert calls == [(ds, dst), (ds, src)]


async def test_a_move_cancelled_after_the_graph_moved_puts_it_back(
    test_client: AsyncClient, db_session: AsyncSession, monkeypatch,
):
    """A request cancelled once the graph has moved (its time ran out, the client went away)
    still moves the graph back: the source stays in A, so must its history."""
    calls = []

    async def _record(_self, ds_id, ws_id, **_kw):
        calls.append((ds_id, ws_id))
        return ["g_moved"]
    monkeypatch.setattr(GraphVersioningService, "move_graph_workspace", _record)

    src = await _workspace(test_client, "Cancelled")
    dst = await _workspace(test_client, "Cancelled Target")
    ds = await _attach(test_client, src, await _catalog_item(test_client, "Cut Off"))

    commit = db_session.commit
    cancelled = []

    async def _cancel_once():
        if not cancelled:
            cancelled.append(True)
            raise asyncio.CancelledError()
        await commit()
    monkeypatch.setattr(db_session, "commit", _cancel_once)

    await _move(test_client, src, ds, dst)          # the middleware answers for the cancelled handler
    assert calls == [(ds, dst), (ds, src)]


async def test_a_commit_that_landed_but_raised_keeps_the_graph_with_the_source(
    test_client: AsyncClient, db_session: AsyncSession, monkeypatch,
):
    """The management commit lands and only its answer is lost (a connection reset after the
    server committed): the source is in B, so its history stays there and the move succeeds."""
    calls = []

    async def _record(_self, ds_id, ws_id, **_kw):
        calls.append((ds_id, ws_id))
        return ["g_moved"]
    monkeypatch.setattr(GraphVersioningService, "move_graph_workspace", _record)

    src = await _workspace(test_client, "Answer Lost")
    dst = await _workspace(test_client, "Answer Lost Target")
    ds = await _attach(test_client, src, await _catalog_item(test_client, "Landed"))

    commit = db_session.commit
    lost = []

    async def _land_then_fail_once():
        await commit()
        if not lost:
            lost.append(True)
            raise ConnectionResetError("connection reset after COMMIT")
    monkeypatch.setattr(db_session, "commit", _land_then_fail_once)

    resp = await _move(test_client, src, ds, dst)
    assert resp.status_code == 200, resp.text
    assert calls == [(ds, dst)], "the graph is not moved back from where its source now is"
    assert resp.json()["workspaceId"] == dst


async def test_a_graph_that_cannot_be_moved_back_is_recorded_and_the_answer_says_how_to_finish(
    test_client: AsyncClient, db_session: AsyncSession, monkeypatch,
):
    """The commit fails and the move back is refused (a job started on the graph in B): the
    source is in A and its history in B. The answer names both and how to finish the move, and
    the activity log keeps a record of it."""
    async def _one_way(_self, ds_id, ws_id, **_kw):
        if ws_id == src:
            raise JobActive("job_b", "job job_b is still running")
        return ["g_moved"]
    monkeypatch.setattr(GraphVersioningService, "move_graph_workspace", _one_way)

    src = await _workspace(test_client, "Half Moved")
    dst = await _workspace(test_client, "Half Moved Target")
    ds = await _attach(test_client, src, await _catalog_item(test_client, "Split"))

    commit = db_session.commit
    failed = []

    async def _fail_once():
        if not failed:
            failed.append(True)
            raise RuntimeError("commit lost")
        await commit()
    monkeypatch.setattr(db_session, "commit", _fail_once)

    resp = await _move(test_client, src, ds, dst)
    assert resp.status_code == 503, resp.text
    detail = resp.json()["detail"]
    assert "Half Moved" in detail and "Half Moved Target" in detail
    assert "again" in detail
    assert await _in_workspace(test_client, src, ds)

    rows = (await db_session.execute(select(OutboxEventORM).where(
        OutboxEventORM.event_type == "workspace.data_source.move_incomplete"))).scalars().all()
    assert len(rows) == 1
    payload = json.loads(rows[0].payload)
    assert payload["data_source_id"] == ds and payload["workspace_id"] == src
    assert payload["details"] == {"from_workspace_id": src, "to_workspace_id": dst}


@e2e
async def test_work_opened_on_the_moved_graph_does_not_stop_the_move_back(
    test_client: AsyncClient, db_session: AsyncSession, monkeypatch,
):
    """Someone in B opens a draft on the graph between its move and the management commit,
    which then fails: the graph still moves back with the source, draft and all."""
    src = await _workspace(test_client, "Back Home")
    dst = await _workspace(test_client, "Back Target")
    ds = await _attach(test_client, src, await _catalog_item(test_client, "Back"))
    svc, gid = await _graph(ds, src)

    commit = db_session.commit
    failed = []

    async def _draft_then_fail_once():
        if not failed:
            failed.append(True)
            await svc.open_draft(graph_id=gid, owner="carol")
            raise RuntimeError("commit lost")
        await commit()
    monkeypatch.setattr(db_session, "commit", _draft_then_fail_once)

    resp = await _move(test_client, src, ds, dst)
    assert resp.status_code == 503, resp.text
    assert "Nothing has been changed" in resp.json()["detail"]
    assert (await svc.get_graph(gid))["workspace_id"] == src


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


@e2e
async def test_the_versioned_graph_and_its_forks_move_with_the_source(test_client: AsyncClient):
    """History is read through the new workspace's versioning routes, and is gone from the
    old one's — for the graph and for its fork."""
    src = await _workspace(test_client, "Versioned Home")
    dst = await _workspace(test_client, "Versioned Target")
    ds = await _attach(test_client, src, await _catalog_item(test_client, "Versioned"))
    gid, fork = await _versioned(ds, src)

    resp = await _move(test_client, src, ds, dst)
    assert resp.status_code == 200, resp.text

    for g in (gid, fork):
        moved = await test_client.get(f"/api/v1/{dst}/versioning/graphs/{g}/commits")
        assert moved.status_code == 200, moved.text
        assert moved.json()["commits"], "the history moved with the graph"
        left = await test_client.get(f"/api/v1/{src}/versioning/graphs/{g}/commits")
        assert left.status_code == 404


@e2e
async def test_a_job_on_a_fork_refuses_the_move(test_client: AsyncClient):
    """A job carries the workspace it was queued in, so nothing moves while one is pending or
    running on the graph or any fork of it."""
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
        assert resp.json()["detail"]["type"] == "job_active"
        assert resp.json()["detail"]["jobId"] == job_id

        assert await _in_workspace(test_client, src, ds)
        for g in (gid, fork):
            still = await test_client.get(f"/api/v1/{src}/versioning/graphs/{g}/commits")
            assert still.status_code == 200, still.text
    finally:
        async with db.graphver_session() as s:
            (await s.get(JobORM, job_id)).status = "cancelled"


@e2e
async def test_impact_in_the_new_workspace_shows_the_versioned_graph(test_client: AsyncClient):
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
async def test_open_work_on_a_fork_holds_the_move_back_but_not_its_finish():
    """A draft or review open on a fork stays with its authors, in the old workspace, as one on
    the graph does: the move is refused and nothing moves. Once the graph is in the target,
    moving the source there again finishes the move, whatever was opened there meanwhile."""
    ds = "ds_" + os.urandom(4).hex()
    gid, fork = await _versioned(ds, "ws_a")
    svc = GraphVersioningService()

    async def _homes():
        async with db.graphver_session() as s:
            return set((await s.execute(select(GraphORM.workspace_id).where(
                GraphORM.id.in_([gid, fork])))).scalars())

    draft = await svc.open_draft(graph_id=fork, owner="bob")
    with pytest.raises(purge_worker.MoveBlocked, match="1 open draft is on this .* abandon it first"):
        await svc.move_graph_workspace(ds, "ws_b", from_workspace_id="ws_a")
    assert await _homes() == {"ws_a"}
    await svc.abandon_draft(graph_id=fork, branch_id=draft, actor="bob")

    pr = await svc.open_pr(source_graph_id=fork, actor="bob")
    with pytest.raises(purge_worker.MoveBlocked, match="1 open review request is on this"):
        await svc.move_graph_workspace(ds, "ws_b", from_workspace_id="ws_a")
    assert await _homes() == {"ws_a"}
    await svc.close_pr(pr_id=pr, actor="bob")

    assert await svc.move_graph_workspace(ds, "ws_b", from_workspace_id="ws_a") == [gid, fork]
    await svc.open_draft(graph_id=gid, owner="carol")
    assert await svc.move_graph_workspace(ds, "ws_b", from_workspace_id="ws_a") == [gid, fork]
    assert await _homes() == {"ws_b"}


@e2e
async def test_open_work_on_a_trashed_fork_does_not_hold_the_move_back():
    """A trashed fork keeps its drafts and reviews, but no route reaches them to publish or
    abandon them: they do not hold the move back, and the fork moves with its graph."""
    ds = "ds_" + os.urandom(4).hex()
    gid, fork = await _versioned(ds, "ws_a")
    svc = GraphVersioningService()
    draft = await svc.open_draft(graph_id=fork, owner="bob")
    await svc.open_draft_mr(graph_id=fork, branch_id=draft, actor="bob")
    await svc.delete_fork(graph_id=fork, workspace_id="ws_a", actor="bob")
    assert await svc.move_graph_workspace(ds, "ws_b", from_workspace_id="ws_a") == [gid, fork]


@e2e
async def test_a_draft_opened_during_the_move_holds_it_back():
    """A draft that opens while the move counts open work is waited for and counted: it does not
    open unseen in the workspace the graph is leaving."""
    ds = "ds_" + os.urandom(4).hex()
    svc, gid = await _graph(ds, "ws_a")
    async with db.graphver_session() as s:        # open_draft, its transaction not yet committed
        await svc._add_draft(s, graph_id=gid, owner="bob")
        move = asyncio.ensure_future(svc.move_graph_workspace(ds, "ws_b", from_workspace_id="ws_a"))
        await asyncio.sleep(0.5)
        assert not move.done(), "the move did not wait for the draft being opened"
    with pytest.raises(purge_worker.MoveBlocked, match="1 open draft is on this"):
        await move
    assert (await svc.get_graph(gid))["workspace_id"] == "ws_a"


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
