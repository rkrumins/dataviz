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

A versioned source's graph moves with it, last, so a refusal from version control — or a
version store that can't be reached — fails the request and nothing moves.
"""
import json
from contextlib import asynccontextmanager
from types import SimpleNamespace

import pytest
import pytest_asyncio
from fastapi import HTTPException
from httpx import AsyncClient
from sqlalchemy import event, select
from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker, create_async_engine

from backend.app.db.models import (
    Base, OutboxEventORM, ProviderORM, WorkspaceDataSourceORM, WorkspaceORM,
)
from backend.app.db.repositories import view_repo
from backend.app.services.permission_service import PermissionClaims
from backend.app.services.versioning import purge_worker
from backend.common.models.management import DataSourceMoveRequest, ViewCreateRequest


@pytest.fixture(autouse=True)
def version_store(monkeypatch):
    """The version store's side of a move, faked: records each call; answers ``graph`` (None:
    the source isn't versioned) or raises ``fail``."""
    state = {"calls": [], "graph": None, "fail": None}

    async def rehome(*, data_source_id, to_workspace_id, **_kw):
        state["calls"].append((data_source_id, to_workspace_id))
        if state["fail"] is not None:
            raise state["fail"]
        return state["graph"]

    monkeypatch.setattr(purge_worker, "rehome_graph_for_data_source", rehome)
    return state


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
