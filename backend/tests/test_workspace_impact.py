"""GET /admin/workspaces/{id}/impact — the blast radius of deleting a workspace.

Deleting a workspace is a HARD delete with a DB-level cascade, not the tidy soft
delete the Explorer performs on a view: ``views.workspace_id`` is ON DELETE
CASCADE, so every view in the workspace is destroyed — including ones already
soft-deleted and waiting to be restored. Until now the only guard was a browser
``confirm()`` reading "Delete this workspace and all its data sources?", which
never mentioned the views at all.

These tests pin the numbers that dialog will show. If they drift, the dialog
lies about what it is about to destroy, which is worse than not showing them.
"""
from httpx import AsyncClient
from sqlalchemy.ext.asyncio import AsyncSession

from backend.app.db.models import ViewORM
from backend.app.db.repositories import workspace_repo, view_repo
from backend.common.models.management import ViewCreateRequest


async def _workspace(client: AsyncClient, name: str = "Impact WS") -> str:
    resp = await client.post("/api/v1/admin/workspaces", json={"name": name, "dataSources": []})
    assert resp.status_code == 201
    return resp.json()["id"]


async def _view(session: AsyncSession, ws_id: str, name: str):
    return await view_repo.create_view(
        session,
        ViewCreateRequest(name=name, workspace_id=ws_id, view_type="graph", visibility="private"),
        user_id="u1",
    )


async def test_impact_route_is_reachable(test_client: AsyncClient):
    ws_id = await _workspace(test_client)
    resp = await test_client.get(f"/api/v1/admin/workspaces/{ws_id}/impact")
    assert resp.status_code == 200

    body = resp.json()
    assert body["views"] == []
    assert body["dataSources"] == []
    assert body["memberCount"] == 0


async def test_impact_is_404_for_an_unknown_workspace(test_client: AsyncClient):
    resp = await test_client.get("/api/v1/admin/workspaces/ws_nope/impact")
    assert resp.status_code == 404


async def test_impact_names_the_views_that_will_be_destroyed(
    test_client: AsyncClient, db_session: AsyncSession,
):
    ws_id = await _workspace(test_client, "Has Views")
    await _view(db_session, ws_id, "Revenue Lineage")
    await _view(db_session, ws_id, "Customer 360")
    await db_session.commit()

    resp = await test_client.get(f"/api/v1/admin/workspaces/{ws_id}/impact")
    assert resp.status_code == 200

    names = sorted(v["name"] for v in resp.json()["views"])
    assert names == ["Customer 360", "Revenue Lineage"]


async def test_impact_counts_SOFT_DELETED_views_too(
    test_client: AsyncClient, db_session: AsyncSession,
):
    """The cruel one.

    A soft-deleted view still has a row, and the workspace cascade takes rows —
    so a view someone deleted intending to restore later is destroyed for good by
    this action. If the dialog omitted it, the user would be told less damage
    would happen than actually will.
    """
    ws_id = await _workspace(test_client, "Has Trash")
    view = await _view(db_session, ws_id, "Deleted But Restorable")
    await view_repo.delete_view(db_session, view.id)
    await db_session.commit()

    # Sanity: it IS soft-deleted (the row survives).
    row = await db_session.get(ViewORM, view.id)
    assert row is not None and row.deleted_at is not None

    resp = await test_client.get(f"/api/v1/admin/workspaces/{ws_id}/impact")
    names = [v["name"] for v in resp.json()["views"]]
    assert "Deleted But Restorable" in names, (
        "a soft-deleted view is destroyed by the cascade and must be reported"
    )


async def test_impact_does_not_leak_another_workspaces_views(
    test_client: AsyncClient, db_session: AsyncSession,
):
    mine = await _workspace(test_client, "Mine")
    theirs = await _workspace(test_client, "Theirs")
    await _view(db_session, theirs, "Not Yours")
    await db_session.commit()

    resp = await test_client.get(f"/api/v1/admin/workspaces/{mine}/impact")
    assert resp.json()["views"] == []


async def test_list_reports_view_counts_without_a_request_per_card(
    test_client: AsyncClient, db_session: AsyncSession,
):
    """The cards show "N views" — the count rides along with the list."""
    ws_id = await _workspace(test_client, "Counted")
    await _view(db_session, ws_id, "One")
    await _view(db_session, ws_id, "Two")
    await db_session.commit()

    rows = await workspace_repo.list_workspaces(db_session)
    counted = next(w for w in rows if w.id == ws_id)

    assert counted.view_count == 2
    assert counted.member_count == 0


async def test_view_count_excludes_soft_deleted_views(
    test_client: AsyncClient, db_session: AsyncSession,
):
    """The CARD count is what you can still open, so trash is excluded — unlike
    the IMPACT list, which must include it because the cascade destroys it."""
    ws_id = await _workspace(test_client, "Half Trash")
    keep = await _view(db_session, ws_id, "Keep")
    gone = await _view(db_session, ws_id, "Gone")
    await view_repo.delete_view(db_session, gone.id)
    await db_session.commit()

    rows = await workspace_repo.list_workspaces(db_session)
    counted = next(w for w in rows if w.id == ws_id)
    assert counted.view_count == 1

    impact = await workspace_repo.get_workspace_impact(db_session, ws_id)
    impact_names = sorted(v.name for v in impact.views)
    assert impact_names == ["Gone", "Keep"], "the cascade takes both — say so"
    assert keep.id != gone.id


# ── Exclusive ownership ────────────────────────────────────────────────────
#
# `uq_ds_catalog_item` is a UNIQUE constraint on workspace_data_sources
# .catalog_item_id: a catalog item belongs to exactly ONE workspace. That is not
# an edge case, it is the model — in this instance all 37 catalog items are
# allocated and none are free.
#
# The UI offered already-owned items anyway (the workspace detail page filters on
# permittedWorkspaces, which says who MAY use an item, not who HAS it), so picking
# one hit the constraint. The handler only recognised uq_ds_ws_prov_graph, so the
# IntegrityError went unhandled → 500.


async def _provider(client: AsyncClient, name: str = "Impact Provider") -> str:
    resp = await client.post(
        "/api/v1/admin/providers",
        json={"name": name, "providerType": "falkordb"},
    )
    assert resp.status_code in (200, 201), resp.text
    return resp.json()["id"]


async def _catalog_item(client: AsyncClient, name: str = "Shared Asset") -> str:
    provider_id = await _provider(client, f"Prov for {name}")
    resp = await client.post("/api/v1/admin/catalog", json={
        "name": name,
        "providerId": provider_id,
        "sourceIdentifier": f"graph_{name.replace(' ', '_')}",
    })
    assert resp.status_code in (200, 201), resp.text
    return resp.json()["id"]


async def test_attaching_an_already_owned_catalog_item_is_a_409_not_a_500(
    test_client: AsyncClient,
):
    """The click-path that used to return an unhandled IntegrityError."""
    owner = await _workspace(test_client, "Owner WS")
    other = await _workspace(test_client, "Other WS")
    item = await _catalog_item(test_client)

    first = await test_client.post(
        f"/api/v1/admin/workspaces/{owner}/data-sources",
        json={"catalogItemId": item},
    )
    assert first.status_code in (200, 201), first.text

    # The second workspace tries to take it.
    second = await test_client.post(
        f"/api/v1/admin/workspaces/{other}/data-sources",
        json={"catalogItemId": item},
    )
    assert second.status_code == 409, (
        f"expected a clean conflict, got {second.status_code}: {second.text}"
    )
    # And it names who has it, so the UI can say so.
    assert "Owner WS" in second.json()["detail"]


async def test_attaching_the_same_item_twice_to_the_SAME_workspace_is_a_409(
    test_client: AsyncClient,
):
    ws = await _workspace(test_client, "Double Add")
    item = await _catalog_item(test_client, "Double Asset")

    assert (await test_client.post(
        f"/api/v1/admin/workspaces/{ws}/data-sources", json={"catalogItemId": item},
    )).status_code in (200, 201)

    again = await test_client.post(
        f"/api/v1/admin/workspaces/{ws}/data-sources", json={"catalogItemId": item},
    )
    assert again.status_code == 409
