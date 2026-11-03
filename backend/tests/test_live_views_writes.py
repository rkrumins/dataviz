"""A view made from a query keeps its members through every write that touches its layout.

Its members are assignment entries the server owns (``assignedBy: "query"``): they follow the
data, so no copy of the layout a client sends — a canvas save from a page opened before the
last update, a draft, a restored version, an imported file — can add to them or take from
them. Where people put them is theirs, and remembered. With the preview off the view is frozen
as it is: its entries are taken as they are written.
"""
import json
import time

from httpx import AsyncClient
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from backend.app.db.models import ViewMembershipStateORM, ViewORM
from backend.app.db.repositories import view_repo, view_version_repo
from backend.app.services.feature_flags import feature_flags
from backend.app.services.view_transfer.canonical import content_hash, portable_definition
from backend.common.models.management import ViewLayoutUpdateRequest
from backend.common.models.view_membership import MACHINE

LAYERS = [{"id": "l1", "name": "One", "order": 0, "entityTypes": []},
          {"id": "l2", "name": "Two", "order": 1, "entityTypes": []}]
MEMBERSHIP = {"v": 1, "mode": "live", "sources": [{"spec": {"seeds": {"urns": ["urn:seed"]}}}]}


def m(layer, **kw):
    return {"layerId": layer, "inheritsChildren": False, "assignedBy": MACHINE, **kw}


def mine(layer):
    return {"layerId": layer, "inheritsChildren": True, "assignedBy": "user"}


def _preview(on: bool) -> None:
    feature_flags._cache = {**(feature_flags._cache or {}), "viewMembershipEnabled": on}
    feature_flags._cache_ts = time.monotonic()


async def _view(client: AsyncClient, *, mode: str = "live") -> str:
    ws = await client.post("/api/v1/admin/workspaces", json={"name": "Live WS", "dataSources": []})
    assert ws.status_code == 201
    resp = await client.post("/api/v1/views/", json={
        "name": "Made from a query", "workspaceId": ws.json()["id"], "viewType": "reference",
        "config": {
            "layout": {"type": "reference", "referenceLayout": {
                "layers": LAYERS, "assignments": {"urn:a": m("l1"), "urn:b": m("l1"), "urn:mine": mine("l2")}}},
            "content": {"entityScope": "curated"},
            "membership": {**MEMBERSHIP, "mode": mode},
        },
        "visibility": "private",
    })
    assert resp.status_code == 201, resp.text
    return resp.json()["id"]


async def _layout(client: AsyncClient, view_id: str, branch: str | None = None) -> dict:
    resp = await client.get(f"/api/v1/views/{view_id}", params={"branchId": branch} if branch else None)
    assert resp.status_code == 200, resp.text
    return resp.json()["config"]


async def _save(client: AsyncClient, view_id: str, assignments: dict, *, branch: str | None = None, layers=LAYERS):
    resp = await client.put(
        f"/api/v1/views/{view_id}/layout", params={"branchId": branch} if branch else None,
        json={"referenceLayout": {"layers": layers, "assignments": assignments}, "entityScope": "all"},
    )
    assert resp.status_code == 200, resp.text


async def test_a_stale_canvas_save_keeps_the_members_and_remembers_a_move(test_client: AsyncClient):
    _preview(True)
    view_id = await _view(test_client)
    # The page was opened before "urn:b" arrived; it moved "urn:a" and its own entry.
    await _save(test_client, view_id, {"urn:a": {**m("l2"), "orderKey": "a0", "assignedBy": "user",
                                                  "inheritsChildren": True}, "urn:mine": mine("l1")})
    config = await _layout(test_client, view_id)
    assignments = config["layout"]["referenceLayout"]["assignments"]
    assert assignments["urn:a"] == m("l2", orderKey="a0")
    assert assignments["urn:b"] == m("l1")
    assert assignments["urn:mine"] == mine("l1")
    assert config["content"]["entityScope"] == "curated"
    assert config["membership"]["overrides"]["urn:a"]["layerId"] == "l2"


async def test_with_the_preview_off_the_view_is_frozen_as_written(test_client: AsyncClient):
    _preview(False)
    view_id = await _view(test_client)
    await _save(test_client, view_id, {"urn:mine": mine("l1")})
    assignments = (await _layout(test_client, view_id))["layout"]["referenceLayout"]["assignments"]
    assert set(assignments) == {"urn:mine"}


async def test_a_settings_save_keeps_the_definition(test_client: AsyncClient):
    _preview(True)
    view_id = await _view(test_client)
    resp = await test_client.put(f"/api/v1/views/{view_id}", json={
        "name": "Renamed", "config": {"layout": {"type": "reference"}, "content": {}}})
    assert resp.status_code == 200, resp.text
    assert (await _layout(test_client, view_id))["membership"]["sources"] == MEMBERSHIP["sources"]


async def test_a_draft_cannot_add_to_or_take_from_the_members(test_client: AsyncClient, any_open_draft):
    _preview(True)
    view_id = await _view(test_client)
    await _save(test_client, view_id, {"urn:a": m("l2"), "urn:forged": m("l1"), "urn:mine": mine("l2")},
                branch="draft-1")
    config = await _layout(test_client, view_id, branch="draft-1")
    assignments = config["layout"]["referenceLayout"]["assignments"]
    assert set(assignments) == {"urn:a", "urn:b", "urn:mine"}
    assert assignments["urn:a"]["layerId"] == "l2"
    published = await _layout(test_client, view_id)
    assert "overrides" not in published["membership"], "a draft's moves are remembered when it is published"


async def test_publishing_a_draft_keeps_its_moves_and_the_members_that_arrived_meanwhile(
    test_client: AsyncClient, any_open_draft, db_session: AsyncSession,
):
    _preview(True)
    view_id = await _view(test_client)
    await _save(test_client, view_id, {"urn:a": m("l2"), "urn:b": m("l1"), "urn:mine": mine("l2")}, branch="draft-1")
    # Meanwhile the data moved on: an update added "urn:c" and dropped "urn:b".
    row = (await db_session.execute(select(ViewORM).where(ViewORM.id == view_id))).scalar_one()
    config = json.loads(row.config)
    config["layout"]["referenceLayout"]["assignments"] = {"urn:a": m("l1"), "urn:c": m("l1"), "urn:mine": mine("l2")}
    row.config = json.dumps(config)
    await db_session.flush()

    assert await view_repo.promote_overlay(db_session, view_id, "draft-1")
    row = (await db_session.execute(select(ViewORM).where(ViewORM.id == view_id))).scalar_one()
    published = json.loads(row.config)
    assignments = published["layout"]["referenceLayout"]["assignments"]
    assert set(assignments) == {"urn:a", "urn:c", "urn:mine"}
    assert assignments["urn:a"]["layerId"] == "l2"
    assert published["membership"]["overrides"]["urn:a"]["layerId"] == "l2"


async def test_a_member_whose_layer_was_deleted_waits_for_its_next_place(
    test_client: AsyncClient, db_session: AsyncSession,
):
    _preview(True)
    view_id = await _view(test_client)
    await _save(test_client, view_id, {"urn:mine": mine("l2")}, layers=[LAYERS[1]])
    assignments = (await _layout(test_client, view_id))["layout"]["referenceLayout"]["assignments"]
    assert assignments["urn:a"]["layerId"] == "l2"
    state = (await db_session.execute(
        select(ViewMembershipStateORM).where(ViewMembershipStateORM.view_id == view_id))).scalar_one()
    assert state.status == "pending"


async def test_a_restored_version_keeps_the_members_until_the_next_update(
    test_client: AsyncClient, db_session: AsyncSession,
):
    _preview(True)
    view_id = await _view(test_client)
    row = (await db_session.execute(select(ViewORM).where(ViewORM.id == view_id))).scalar_one()
    first = await view_version_repo.ensure_baseline(db_session, row)
    await _save(test_client, view_id, {"urn:a": m("l1"), "urn:b": m("l1"), "urn:mine": mine("l1")})
    row = (await db_session.execute(select(ViewORM).where(ViewORM.id == view_id))).scalar_one()
    await view_version_repo.restore(db_session, row, first.version, actor=None)
    restored = json.loads(row.config)
    assignments = restored["layout"]["referenceLayout"]["assignments"]
    assert {"urn:a", "urn:b"} <= set(assignments), "a version holds no members; the view keeps its own"
    assert assignments["urn:mine"]["layerId"] == "l2", "the design itself is restored"


def test_members_are_not_part_of_the_design_of_a_view_kept_up_to_date():
    def config(assignments, mode="live"):
        return {"layout": {"type": "reference", "referenceLayout": {"layers": LAYERS, "assignments": assignments}},
                "content": {"entityScope": "curated"}, "membership": {**MEMBERSHIP, "mode": mode}}

    before = config({"urn:a": m("l1"), "urn:mine": mine("l2")})
    after = config({"urn:a": m("l1"), "urn:b": m("l2"), "urn:mine": mine("l2")})
    assert set(portable_definition(before)["layout"]["referenceLayout"]["assignments"]) == {"urn:mine"}
    assert content_hash(portable_definition(before)) == content_hash(portable_definition(after)), (
        "an update never makes the view look changed")
    frozen = config({"urn:a": m("l1"), "urn:mine": mine("l2")}, mode="snapshot")
    assert set(portable_definition(frozen)["layout"]["referenceLayout"]["assignments"]) == {"urn:a", "urn:mine"}
