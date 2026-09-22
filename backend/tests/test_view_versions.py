"""View versions: checkpoints of a view's design, history, compare and restore."""
from __future__ import annotations

import contextlib
import json

from fastapi import HTTPException, status
from httpx import AsyncClient
from sqlalchemy import select

from backend.app.auth.dependencies import get_current_user, get_optional_user, get_permission_claims
from backend.app.db.models import ViewActivityLogORM, ViewLayoutOverlayORM, ViewORM, ViewVersionORM
from backend.app.db.repositories import view_repo, view_version_repo
from backend.app.services.permission_service import PermissionClaims
from backend.auth_service.interface import User


async def _workspace(client: AsyncClient) -> str:
    resp = await client.post("/api/v1/admin/workspaces", json={"name": "Versions WS", "dataSources": []})
    assert resp.status_code == 201
    return resp.json()["id"]


async def _view(client: AsyncClient, ws_id: str, *, visibility: str = "private") -> str:
    resp = await client.post("/api/v1/views/", json={
        "name": "Finance lineage",
        "workspaceId": ws_id,
        "viewType": "reference",
        "visibility": visibility,
        "config": {"icon": "Layout", "content": {"visibleEntityTypes": ["domain"]},
                   "layout": {"type": "reference"}},
    })
    assert resp.status_code == 201
    return resp.json()["id"]


def _layout(assignments=None, *, checkpoint=None):
    body = {"referenceLayout": {
        "layers": [{"id": "l1", "name": "Sources", "entityTypes": [], "order": 0},
                   {"id": "l2", "name": "Marts", "entityTypes": [], "order": 1}],
        "assignments": assignments if assignments is not None else {
            "urn:a": {"layerId": "l1", "inheritsChildren": True}},
    }}
    if checkpoint:
        body["checkpoint"] = checkpoint
    return body


async def test_a_wizard_create_records_version_one(test_client: AsyncClient):
    ws = await _workspace(test_client)
    vid = await _view(test_client, ws)
    resp = await test_client.put(f"/api/v1/views/{vid}/layout", json=_layout(checkpoint={"source": "create"}))
    assert resp.status_code == 200

    history = (await test_client.get(f"/api/v1/views/{vid}/versions")).json()
    assert [v["version"] for v in history["items"]] == [1]
    first = history["items"][0]
    assert first["source"] == "create"
    assert first["name"] == "Finance lineage" and first["icon"] == "Layout"
    assert first["stats"]["layers"] == 2 and first["stats"]["assignments"] == 1
    assert first["contentHash"].startswith("sha256:")
    assert history["workingCopy"]["dirty"] is False
    assert history["portableId"].startswith("pv_")


async def test_saving_an_unchanged_design_writes_nothing(test_client: AsyncClient):
    ws = await _workspace(test_client)
    vid = await _view(test_client, ws)
    await test_client.put(f"/api/v1/views/{vid}/layout", json=_layout(checkpoint={"source": "create"}))
    await test_client.put(f"/api/v1/views/{vid}/layout", json=_layout(checkpoint={"source": "wizard"}))
    manual = (await test_client.post(f"/api/v1/views/{vid}/versions", json={})).json()
    assert manual["created"] is False and manual["version"]["version"] == 1
    history = (await test_client.get(f"/api/v1/views/{vid}/versions")).json()
    assert len(history["items"]) == 1


async def test_a_view_without_history_gets_a_baseline(test_client: AsyncClient):
    ws = await _workspace(test_client)
    vid = await _view(test_client, ws)
    status_before = (await test_client.get(f"/api/v1/views/{vid}/versions/status")).json()
    assert status_before["headVersion"] is None and status_before["dirty"] is False
    history = (await test_client.get(f"/api/v1/views/{vid}/versions")).json()
    assert [(v["version"], v["source"]) for v in history["items"]] == [(1, "baseline")]


async def test_canvas_edits_show_as_unsaved_until_saved(test_client: AsyncClient, db_session):
    ws = await _workspace(test_client)
    vid = await _view(test_client, ws)
    await test_client.put(f"/api/v1/views/{vid}/layout", json=_layout(checkpoint={"source": "create"}))
    # A canvas autosave: a layout write with no checkpoint.
    moved = {"urn:a": {"layerId": "l2", "inheritsChildren": True},
             "urn:b": {"layerId": "l1", "inheritsChildren": True}}
    await test_client.put(f"/api/v1/views/{vid}/layout", json=_layout(moved))
    state = (await test_client.get(f"/api/v1/views/{vid}/versions/status")).json()
    assert state["headVersion"] == 1 and state["dirty"] is True and state["designChanged"] is True

    history = (await test_client.get(f"/api/v1/views/{vid}/versions")).json()
    summary = history["workingCopy"]["summary"]["assignments"]
    assert summary["added"] == 1 and summary["moved"] == 1

    saved = (await test_client.post(f"/api/v1/views/{vid}/versions", json={"message": "Split marts"})).json()
    assert saved["created"] is True and saved["version"]["version"] == 2
    assert saved["version"]["source"] == "manual" and saved["version"]["message"] == "Split marts"
    assert (await test_client.get(f"/api/v1/views/{vid}/versions/status")).json()["dirty"] is False

    actions = (await db_session.execute(
        select(ViewActivityLogORM.action).where(ViewActivityLogORM.view_id == vid))).scalars().all()
    assert "version_saved" in actions


async def test_compare_two_versions_and_a_version_with_now(test_client: AsyncClient):
    ws = await _workspace(test_client)
    vid = await _view(test_client, ws)
    await test_client.put(f"/api/v1/views/{vid}/layout", json=_layout(checkpoint={"source": "create"}))
    await test_client.put(f"/api/v1/views/{vid}/layout", json=_layout(
        {"urn:a": {"layerId": "l2", "inheritsChildren": True}}, checkpoint={"source": "wizard"}))
    diff = (await test_client.get(f"/api/v1/views/{vid}/versions/compare", params={"from": 1, "to": 2})).json()["diff"]
    assert diff["assignments"]["moved"] == 1
    assert diff["assignments"]["samples"]["moved"] == [{"urn": "urn:a", "from": "l1", "to": "l2"}]
    assert diff["identical"] is False
    now = (await test_client.get(f"/api/v1/views/{vid}/versions/compare", params={"from": 2})).json()["diff"]
    assert now["identical"] is True


async def test_restore_is_a_new_version_and_never_loses_unsaved_work(test_client: AsyncClient):
    ws = await _workspace(test_client)
    vid = await _view(test_client, ws)
    await test_client.put(f"/api/v1/views/{vid}/layout", json=_layout(checkpoint={"source": "create"}))
    await test_client.put(f"/api/v1/views/{vid}/layout", json=_layout(
        {"urn:z": {"layerId": "l2", "inheritsChildren": True}}, checkpoint={"source": "wizard"}))
    # Unsaved work on top of v2.
    await test_client.put(f"/api/v1/views/{vid}/layout", json=_layout(
        {"urn:unsaved": {"layerId": "l1", "inheritsChildren": True}}))

    result = (await test_client.post(f"/api/v1/views/{vid}/versions/1/restore")).json()
    assert result["snapshot"]["version"] == 3 and result["snapshot"]["source"] == "snapshot"
    assert result["version"]["version"] == 4 and result["version"]["source"] == "restore"
    assert result["version"]["provenance"]["restoredFrom"] == 1

    history = (await test_client.get(f"/api/v1/views/{vid}/versions")).json()["items"]
    by_number = {v["version"]: v for v in history}
    assert by_number[4]["contentHash"] == by_number[1]["contentHash"], "the restored design is v1's"
    assert result["view"]["config"]["layout"]["referenceLayout"]["assignments"].keys() == {"urn:a"}

    snapshot = (await test_client.get(f"/api/v1/views/{vid}/versions/3")).json()
    assert "urn:unsaved" in snapshot["definition"]["layout"]["referenceLayout"]["assignments"]


async def test_restore_of_a_missing_version_is_404(test_client: AsyncClient):
    ws = await _workspace(test_client)
    vid = await _view(test_client, ws)
    assert (await test_client.post(f"/api/v1/views/{vid}/versions/9/restore")).status_code == 404
    assert (await test_client.get(f"/api/v1/views/{vid}/versions/9")).status_code == 404


async def test_a_draft_write_is_never_a_version(test_client: AsyncClient, db_session):
    ws = await _workspace(test_client)
    vid = await _view(test_client, ws)
    resp = await test_client.put(
        f"/api/v1/views/{vid}/layout", params={"branchId": "br_draft"},
        json=_layout(checkpoint={"source": "wizard"}),
    )
    assert resp.status_code == 200
    count = (await db_session.execute(
        select(ViewVersionORM).where(ViewVersionORM.view_id == vid))).scalars().all()
    assert count == []


async def test_a_client_cannot_claim_a_server_source(test_client: AsyncClient):
    ws = await _workspace(test_client)
    vid = await _view(test_client, ws)
    resp = await test_client.put(f"/api/v1/views/{vid}/layout", json=_layout(checkpoint={"source": "import"}))
    assert resp.status_code == 422


async def test_promoting_a_draft_records_a_version(test_client: AsyncClient, db_session):
    ws = await _workspace(test_client)
    vid = await _view(test_client, ws)
    await test_client.put(f"/api/v1/views/{vid}/layout", json=_layout(checkpoint={"source": "create"}))
    await test_client.put(
        f"/api/v1/views/{vid}/layout", params={"branchId": "br_1"},
        json=_layout({"urn:a": {"layerId": "l2", "inheritsChildren": True}}),
    )
    assert await view_repo.promote_overlay(db_session, vid, "br_1", actor="usr_test000000")
    versions = (await db_session.execute(
        select(ViewVersionORM).where(ViewVersionORM.view_id == vid).order_by(ViewVersionORM.version)
    )).scalars().all()
    assert [(v.version, v.source) for v in versions] == [(1, "create"), (2, "promote")]
    assert json.loads(versions[1].provenance) == {"branchId": "br_1"}
    assert (await db_session.execute(select(ViewLayoutOverlayORM))).scalars().all() == []


async def test_checkpoint_repo_numbers_versions_and_links_parents(db_session):
    row = ViewORM(id="view_repo1", name="R", workspace_id="ws_x", view_type="graph",
                  config=json.dumps({"layout": {"type": "graph"}}))
    db_session.add(row)
    await db_session.flush()
    v1, created1 = await view_version_repo.checkpoint(db_session, row, source="manual")
    row.config = json.dumps({"layout": {"type": "graph"}, "filters": {"fieldFilters": [1]}})
    v2, created2 = await view_version_repo.checkpoint(db_session, row, source="manual")
    assert (v1.version, created1, v2.version, created2, v2.parent_version) == (1, True, 2, True, 1)
    again, created3 = await view_version_repo.checkpoint(db_session, row, source="manual")
    assert again.version == 2 and created3 is False
    forced, created4 = await view_version_repo.checkpoint(db_session, row, source="import", force=True,
                                                          request_id="req-1")
    assert forced.version == 3 and created4 is True
    assert (await view_version_repo.find_by_request_id(db_session, "req-1")).version == 3


# ── Permissions ─────────────────────────────────────────────────────────────


def _user(uid: str) -> User:
    return User(id=uid, email=f"{uid}@example.com", first_name="T", last_name="U", role="user",
                status="active", created_at="2024-01-01T00:00:00Z", updated_at="2024-01-01T00:00:00Z")


@contextlib.contextmanager
def _as(user: User, claims: PermissionClaims):
    from backend.app.main import app

    async def _current():
        return user

    async def _optional():
        return user

    def _claims():
        return claims

    prev = {dep: app.dependency_overrides.get(dep)
            for dep in (get_current_user, get_optional_user, get_permission_claims)}
    app.dependency_overrides[get_current_user] = _current
    app.dependency_overrides[get_optional_user] = _optional
    app.dependency_overrides[get_permission_claims] = _claims
    try:
        yield
    finally:
        for dep, fn in prev.items():
            if fn is None:
                app.dependency_overrides.pop(dep, None)
            else:
                app.dependency_overrides[dep] = fn


async def test_readers_see_history_but_cannot_save_or_restore(test_client: AsyncClient):
    ws = await _workspace(test_client)
    vid = await _view(test_client, ws, visibility="workspace")
    await test_client.put(f"/api/v1/views/{vid}/layout", json=_layout(checkpoint={"source": "create"}))

    reader = _user("usr_reader")
    claims = PermissionClaims(sid="s_reader", ws_perms={ws: ("workspace:view:read",)})
    with _as(reader, claims):
        assert (await test_client.get(f"/api/v1/views/{vid}/versions")).status_code == 200
        assert (await test_client.get(f"/api/v1/views/{vid}/versions/status")).status_code == 200
        assert (await test_client.post(f"/api/v1/views/{vid}/versions", json={})).status_code == 403
        assert (await test_client.post(f"/api/v1/views/{vid}/versions/1/restore")).status_code == 403

    outsider = _user("usr_outsider")
    with _as(outsider, PermissionClaims(sid="s_out")):
        assert (await test_client.get(f"/api/v1/views/{vid}/versions")).status_code in (404, 503)
