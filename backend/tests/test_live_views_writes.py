"""A view made from a query keeps its members through every write that touches its layout.

Its members are rows of ``view_members`` the server owns: they follow the data, so no copy of
the layout a client sends — a canvas save from a page opened before the last update, a draft,
a restored version, an imported file — can add to them or take from them, and none of them is
ever an entry of the view's config. Where people put them is theirs: an entry a canvas save
sends for a member is a move, applied to it at once and remembered (``membership.overrides``)
so every update keeps it. With the preview off the view is left as it is: its entries are
taken as they are written.
"""
import json
import time

from httpx import AsyncClient
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from backend.app.db.models import ViewMemberORM, ViewMembershipStateORM, ViewORM
from backend.app.db.repositories import view_members_repo, view_membership_repo, view_repo, view_version_repo
from backend.app.services.feature_flags import feature_flags
from backend.app.services.view_transfer.canonical import content_hash, portable_definition
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


async def _members(session: AsyncSession, view_id: str, placed: dict) -> None:
    """The view's members as an applied answer leaves them: rows at a new epoch, swapped in."""
    row = (await session.execute(select(ViewORM).where(ViewORM.id == view_id))).scalar_one()
    state = await view_membership_repo.ensure(session, row)
    state.epoch = epoch = state.epoch + 1
    await view_members_repo.insert(session, [
        {"view_id": view_id, "epoch": epoch, "urn": urn, "layer_id": layer, "sort_key": urn, "ord": i,
         "label": "", "label_ord": i, "whole": False, "covered": False}
        for i, (urn, layer) in enumerate(sorted(placed.items()))])
    state.members_epoch, state.member_count, state.status = epoch, len(placed), "ok"
    await session.commit()


async def _view(client: AsyncClient, session: AsyncSession, *, mode: str = "live") -> str:
    """A view as ``POST /views/from-members`` leaves one: its definition — which only that
    route writes (``POST /views`` drops one sent with it) — the entries people placed, and
    its members in the member table."""
    ws = await client.post("/api/v1/admin/workspaces", json={"name": "Live WS", "dataSources": []})
    assert ws.status_code == 201
    resp = await client.post("/api/v1/views/", json={
        "name": "Made from a query", "workspaceId": ws.json()["id"], "viewType": "reference",
        "config": {
            "layout": {"type": "reference", "referenceLayout": {
                "layers": LAYERS, "assignments": {"urn:mine": mine("l2")}}},
            "content": {"entityScope": "curated"},
        },
        "visibility": "private",
    })
    assert resp.status_code == 201, resp.text
    row = (await session.execute(select(ViewORM).where(ViewORM.id == resp.json()["id"]))).scalar_one()
    config = json.loads(row.config)
    config["membership"] = {**MEMBERSHIP, "mode": mode}
    row.config = json.dumps(config)
    await session.commit()
    await _members(session, row.id, {"urn:a": "l1", "urn:b": "l1"})
    return row.id


async def _layout(client: AsyncClient, view_id: str, branch: str | None = None) -> dict:
    resp = await client.get(f"/api/v1/views/{view_id}", params={"branchId": branch} if branch else None)
    assert resp.status_code == 200, resp.text
    return resp.json()["config"]


async def _placed(session: AsyncSession, view_id: str) -> dict:
    """Where each member sits, at the epoch readers see."""
    state = (await session.execute(select(ViewMembershipStateORM).where(ViewMembershipStateORM.view_id == view_id)
                                   .execution_options(populate_existing=True))).scalar_one()
    rows = (await session.execute(select(ViewMemberORM).where(
        ViewMemberORM.view_id == view_id, ViewMemberORM.epoch == state.members_epoch)
        .execution_options(populate_existing=True))).scalars().all()
    return {r.urn: (r.layer_id, r.order_key) for r in rows}


async def _save(client: AsyncClient, view_id: str, assignments: dict, *, branch: str | None = None, layers=LAYERS):
    resp = await client.put(
        f"/api/v1/views/{view_id}/layout", params={"branchId": branch} if branch else None,
        json={"referenceLayout": {"layers": layers, "assignments": assignments}, "entityScope": "all"},
    )
    assert resp.status_code == 200, resp.text


async def test_a_canvas_save_moves_a_member_remembers_it_and_stores_only_peoples_entries(
    test_client: AsyncClient, db_session: AsyncSession,
):
    _preview(True)
    view_id = await _view(test_client, db_session)
    # The page was opened before "urn:b" arrived; it moved "urn:a" (rewriting its marker, as
    # the canvas does) and its own entry, and echoes a member that has since left.
    await _save(test_client, view_id, {"urn:a": {**m("l2"), "orderKey": "a0", "assignedBy": "user",
                                                  "inheritsChildren": True},
                                       "urn:left": m("l1"), "urn:mine": mine("l1")})
    config = await _layout(test_client, view_id)
    assert config["layout"]["referenceLayout"]["assignments"] == {"urn:mine": mine("l1")}
    assert config["content"]["entityScope"] == "curated"
    assert config["membership"]["overrides"]["urn:a"]["layerId"] == "l2"
    assert await _placed(db_session, view_id) == {"urn:a": ("l2", "a0"), "urn:b": ("l1", None)}


async def test_with_the_preview_off_the_view_is_left_as_written(
    test_client: AsyncClient, db_session: AsyncSession,
):
    _preview(False)
    view_id = await _view(test_client, db_session)
    await _save(test_client, view_id, {"urn:mine": mine("l1")})
    assignments = (await _layout(test_client, view_id))["layout"]["referenceLayout"]["assignments"]
    assert set(assignments) == {"urn:mine"}
    assert await _placed(db_session, view_id) == {"urn:a": ("l1", None), "urn:b": ("l1", None)}


async def test_a_settings_save_keeps_the_definition(
    test_client: AsyncClient, db_session: AsyncSession,
):
    _preview(True)
    view_id = await _view(test_client, db_session)
    resp = await test_client.put(f"/api/v1/views/{view_id}", json={
        "name": "Renamed", "config": {"layout": {"type": "reference"}, "content": {}}})
    assert resp.status_code == 200, resp.text
    assert (await _layout(test_client, view_id))["membership"]["sources"] == MEMBERSHIP["sources"]


async def test_a_draft_keeps_its_moves_of_members_and_can_add_none(
    test_client: AsyncClient, db_session: AsyncSession, any_open_draft,
):
    _preview(True)
    view_id = await _view(test_client, db_session)
    await _save(test_client, view_id, {"urn:a": m("l2"), "urn:forged": m("l1"), "urn:mine": mine("l2")},
                branch="draft-1")
    config = await _layout(test_client, view_id, branch="draft-1")
    assignments = config["layout"]["referenceLayout"]["assignments"]
    assert set(assignments) == {"urn:a", "urn:mine"}, "its move of a member, and its own entry"
    assert assignments["urn:a"]["layerId"] == "l2"
    published = await _layout(test_client, view_id)
    assert "overrides" not in published["membership"], "a draft's moves are remembered when it is published"
    assert await _placed(db_session, view_id) == {"urn:a": ("l1", None), "urn:b": ("l1", None)}


async def test_publishing_a_draft_applies_its_moves_to_the_members_there_are_now(
    test_client: AsyncClient, any_open_draft, db_session: AsyncSession,
):
    _preview(True)
    view_id = await _view(test_client, db_session)
    await _save(test_client, view_id, {"urn:a": m("l2"), "urn:b": m("l1"), "urn:mine": mine("l2")}, branch="draft-1")
    # Meanwhile the data moved on: an update added "urn:c" and dropped "urn:b".
    await _members(db_session, view_id, {"urn:a": "l1", "urn:c": "l1"})

    assert await view_repo.promote_overlay(db_session, view_id, "draft-1")
    row = (await db_session.execute(select(ViewORM).where(ViewORM.id == view_id))).scalar_one()
    published = json.loads(row.config)
    assert published["layout"]["referenceLayout"]["assignments"] == {"urn:mine": mine("l2")}
    assert published["membership"]["overrides"]["urn:a"]["layerId"] == "l2"
    assert await _placed(db_session, view_id) == {"urn:a": ("l2", None), "urn:c": ("l1", None)}


async def test_a_member_whose_layer_was_deleted_waits_for_its_next_place(
    test_client: AsyncClient, db_session: AsyncSession,
):
    _preview(True)
    view_id = await _view(test_client, db_session)
    await _save(test_client, view_id, {"urn:mine": mine("l2")}, layers=[LAYERS[1]])
    assert await _placed(db_session, view_id) == {"urn:a": ("l2", None), "urn:b": ("l2", None)}
    state = (await db_session.execute(
        select(ViewMembershipStateORM).where(ViewMembershipStateORM.view_id == view_id)
        .execution_options(populate_existing=True))).scalar_one()
    assert state.status == "pending"


async def test_a_restored_version_keeps_the_members(
    test_client: AsyncClient, db_session: AsyncSession,
):
    _preview(True)
    view_id = await _view(test_client, db_session)
    row = (await db_session.execute(select(ViewORM).where(ViewORM.id == view_id))).scalar_one()
    first = await view_version_repo.ensure_baseline(db_session, row)
    await _save(test_client, view_id, {"urn:mine": mine("l1")})
    row = (await db_session.execute(select(ViewORM).where(ViewORM.id == view_id))).scalar_one()
    await view_version_repo.restore(db_session, row, first.version, actor=None)
    restored = json.loads(row.config)
    assert restored["layout"]["referenceLayout"]["assignments"] == {"urn:mine": mine("l2")}, (
        "the design itself is restored")
    assert await _placed(db_session, view_id) == {"urn:a": ("l1", None), "urn:b": ("l1", None)}, (
        "a version holds no members; the view keeps its own")


def test_members_carried_as_entries_are_not_part_of_the_design():
    def config(assignments, mode="live"):
        return {"layout": {"type": "reference", "referenceLayout": {"layers": LAYERS, "assignments": assignments}},
                "content": {"entityScope": "curated"}, "membership": {**MEMBERSHIP, "mode": mode}}

    before = config({"urn:a": m("l1"), "urn:mine": mine("l2")})
    after = config({"urn:a": m("l1"), "urn:b": m("l2"), "urn:mine": mine("l2")})
    assert set(portable_definition(before)["layout"]["referenceLayout"]["assignments"]) == {"urn:mine"}
    assert content_hash(portable_definition(before)) == content_hash(portable_definition(after)), (
        "an update never makes the view look changed")
    frozen = config({"urn:a": m("l1"), "urn:mine": mine("l2")}, mode="snapshot")
    assert set(portable_definition(frozen)["layout"]["referenceLayout"]["assignments"]) == {"urn:mine"}, (
        "a snapshot's members are data too: its member table keeps them")
