"""``/views/{id}/membership`` — how a view made from a query is kept, and changed.

Its status (with an ETag), a change to what it is made of (against the definition
hash it was read at), keeping entities out and always including them, and *Refresh
now*: an update applies what changed in the data, keeps where people put members,
holds a large removal until it is confirmed, and keeps the last good members when
the graph answers short or the view would go over its limit.
"""
import json

import pytest
from httpx import AsyncClient
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from backend.app.db.models import ViewActivityLogORM, ViewMembershipStateORM, ViewORM
from backend.app.services.live_views import pipeline
from backend.app.services.permission_service import PermissionClaims
from backend.common.models.view_membership import MACHINE
from backend.tests.test_view_versions import _as, _user
from backend.tests.test_views_from_members_api import (  # noqa: F401 — fixtures
    TypedEngine,
    assignments_of,
    body,
    graph,
    made,
    membership_on,
    source_view,
    workspace,
)

pytestmark = pytest.mark.usefixtures("membership_on")


@pytest.fixture()
async def saved(test_client: AsyncClient, graph):
    """A view of ``dom``'s tables and columns, laid out like the view it came from."""
    ws = await workspace(test_client)
    src = await source_view(test_client, ws)
    resp = await test_client.post("/api/v1/views/from-members", json=body(ws, src, visibility="workspace"))
    assert resp.status_code == 201, resp.text
    return {"ws": ws, "src": src, "id": resp.json()["view"]["id"]}


def url(view_id: str, tail: str = "") -> str:
    return f"/api/v1/views/{view_id}/membership{tail}"


async def status(client: AsyncClient, view_id: str) -> dict:
    resp = await client.get(url(view_id))
    assert resp.status_code == 200, resp.text
    return resp.json()


async def entries(db_session: AsyncSession, view_id: str) -> dict:
    return assignments_of(await made(db_session, view_id))


async def refresh(client: AsyncClient, view_id: str, *, confirm: bool = False):
    return await client.post(url(view_id, "/refresh"), params={"confirmRemovals": "true"} if confirm else None)


async def settle(db_session: AsyncSession, view_id: str) -> None:
    """Let the next *Refresh now* through, as if the last one was a while ago."""
    state = (await db_session.execute(
        select(ViewMembershipStateORM).where(ViewMembershipStateORM.view_id == view_id))).scalar_one()
    state.last_started_at = "2000-01-01T00:00:00+00:00"
    await db_session.commit()


# ── Status ──────────────────────────────────────────────────────────────────


async def test_the_status_has_an_etag_and_a_poll_that_finds_it_unchanged_costs_a_304(
    test_client: AsyncClient, saved,
):
    first = await test_client.get(url(saved["id"]))
    assert first.status_code == 200
    out = first.json()
    assert (out["mode"], out["status"], out["keys"], out["limit"]) == ("live", "ok", 6, 5000)
    assert out["alwaysIncluded"] == [] and out["excluded"] == []
    again = await test_client.get(url(saved["id"]), headers={"If-None-Match": first.headers["etag"]})
    assert again.status_code == 304


async def test_a_view_not_made_from_a_query_says_so(test_client: AsyncClient, saved):
    resp = await test_client.get(url(saved["src"]))
    assert resp.status_code == 404
    assert resp.json()["detail"]["reason"] == "not_made_from_a_query"


async def test_readers_see_how_it_is_kept_but_cannot_change_it(test_client: AsyncClient, saved):
    reader = _user("usr_reader")
    claims = PermissionClaims(sid="s_reader", ws_perms={saved["ws"]: ("workspace:view:read",)})
    with _as(reader, claims):
        current = await status(test_client, saved["id"])
        assert current["readIn"] == []
        put = await test_client.put(url(saved["id"]), json={
            "ifDefinitionHash": current["definitionHash"], "mode": "snapshot"})
        assert put.status_code == 403
        assert (await refresh(test_client, saved["id"])).status_code == 403
        ops = await test_client.post(url(saved["id"], "/members"), json={"exclude": ["col_a1"]})
        assert ops.status_code == 403


# ── Changing what it is made of ─────────────────────────────────────────────


async def test_a_stale_definition_is_refused_with_the_current_one(test_client: AsyncClient, saved):
    resp = await test_client.put(url(saved["id"]), json={"ifDefinitionHash": "stale", "mode": "snapshot"})
    assert resp.status_code == 409
    detail = resp.json()["detail"]
    assert detail["reason"] == "changed"
    assert detail["definitionHash"] == (await status(test_client, saved["id"]))["definitionHash"]


async def test_a_draft_cannot_change_what_a_view_is_made_of(test_client: AsyncClient, saved):
    current = await status(test_client, saved["id"])
    resp = await test_client.put(url(saved["id"]), params={"branchId": "draft-1"}, json={
        "ifDefinitionHash": current["definitionHash"], "mode": "snapshot"})
    assert resp.status_code == 409


async def test_changing_the_query_works_the_members_out_again(
    test_client: AsyncClient, db_session, saved, graph,
):
    current = await status(test_client, saved["id"])
    resp = await test_client.put(url(saved["id"]), json={
        "ifDefinitionHash": current["definitionHash"],
        "sources": [{"spec": {"seeds": {"urns": ["tbl_b"]}, "expand": {"children": 1}}}],
    })
    assert resp.status_code == 200, resp.text
    assert resp.json()["status"] == "ok"
    assert set(await entries(db_session, saved["id"])) == {"dom", "tbl_b", "col_b1"}
    row = (await db_session.execute(select(ViewORM).where(ViewORM.id == saved["id"]))).scalar_one()
    assert json.loads(row.config)["membership"]["sources"][0]["spec"]["seeds"]["urns"] == ["tbl_b"]


async def test_freeze_and_resume(test_client: AsyncClient, db_session, saved, graph):
    current = await status(test_client, saved["id"])
    frozen = await test_client.put(url(saved["id"]), json={
        "ifDefinitionHash": current["definitionHash"], "mode": "snapshot"})
    assert frozen.status_code == 200 and frozen.json()["status"] == "frozen"

    graph.engine = TypedEngine(gone={"col_b1"})
    refused = await refresh(test_client, saved["id"])
    assert refused.status_code == 409 and refused.json()["detail"]["reason"] == "frozen"
    assert "col_b1" in await entries(db_session, saved["id"]), "a snapshot keeps its members"

    resumed = await test_client.put(url(saved["id"]), json={
        "ifDefinitionHash": frozen.json()["definitionHash"], "mode": "live"})
    assert resumed.status_code == 200 and resumed.json()["status"] == "ok"
    assert "col_b1" not in await entries(db_session, saved["id"]), "resuming catches up with the data"


# ── Keep out, bring back, always include ────────────────────────────────────


async def test_keeping_out_bringing_back_and_always_including(
    test_client: AsyncClient, db_session, saved, graph,
):
    view_id = saved["id"]
    layers = (await made(db_session, view_id))["layout"]["referenceLayout"]["layers"]
    tables = next(l["id"] for l in layers if l["name"] == "Tables")

    out = await test_client.post(url(view_id, "/members"), json={"exclude": ["col_a1"]})
    assert out.status_code == 200, out.text
    assert out.json()["membership"]["excluded"] == ["col_a1"]
    assert "col_a1" not in await entries(db_session, view_id)
    await settle(db_session, view_id)
    assert (await refresh(test_client, view_id)).json()["outcome"] == "unchanged"
    assert "col_a1" not in await entries(db_session, view_id), "kept out whatever the query finds"

    back = await test_client.post(url(view_id, "/members"), json={"unexclude": ["col_a1"]})
    assert back.status_code == 200
    assert back.json()["membership"]["excluded"] == []
    assert (await entries(db_session, view_id))["col_a1"]["assignedBy"] == MACHINE

    mine = await test_client.post(url(view_id, "/members"), json={
        "include": [{"urn": "tbl_up", "layerId": tables}, {"urn": "col_a2", "layerId": tables}]})
    assert mine.status_code == 200
    assert mine.json()["membership"]["alwaysIncluded"] == ["col_a2", "tbl_up"]
    held = await entries(db_session, view_id)
    assert held["tbl_up"]["assignedBy"] == "user" and held["col_a2"]["layerId"] == tables

    stop = await test_client.post(url(view_id, "/members"), json={"uninclude": ["tbl_up", "col_a2"]})
    assert stop.status_code == 200
    held = await entries(db_session, view_id)
    assert "tbl_up" not in held
    assert held["col_a2"]["assignedBy"] == MACHINE, "a query result comes back as the server's"


async def test_including_in_a_layer_that_is_gone_is_refused(test_client: AsyncClient, saved):
    resp = await test_client.post(url(saved["id"], "/members"), json={
        "include": [{"urn": "tbl_up", "layerId": "nowhere"}]})
    assert resp.status_code == 422


# ── Refresh now ─────────────────────────────────────────────────────────────


async def test_an_update_applies_what_changed_as_data_not_as_an_edit(
    test_client: AsyncClient, db_session, saved, graph,
):
    view_id = saved["id"]
    before = (await db_session.execute(select(ViewORM).where(ViewORM.id == view_id))).scalar_one()
    edited_at = before.updated_at
    await settle(db_session, view_id)
    graph.engine = TypedEngine(gone={"col_b1"})
    resp = await refresh(test_client, view_id)
    assert resp.status_code == 200, resp.text
    out = resp.json()
    assert out["outcome"] == "applied"
    assert (out["diff"]["added"], out["diff"]["removed"]) == (0, 1)
    assert out["membership"]["revision"] == 2 and out["membership"]["keys"] == 5
    row = (await db_session.execute(
        select(ViewORM).where(ViewORM.id == view_id).execution_options(populate_existing=True))).scalar_one()
    assert row.updated_at == edited_at, "an update is the data moving, not someone editing the view"
    assert row.data_updated_at is not None
    actions = (await db_session.execute(select(ViewActivityLogORM.action).where(
        ViewActivityLogORM.view_id == view_id))).scalars().all()
    assert "data_changed" in actions


async def test_refresh_now_at_most_every_30_seconds(test_client: AsyncClient, db_session, saved):
    await settle(db_session, saved["id"])
    assert (await refresh(test_client, saved["id"])).status_code == 200
    again = await refresh(test_client, saved["id"])
    assert again.status_code == 429
    assert 1 <= int(again.headers["retry-after"]) <= 30


async def test_where_people_put_members_survives_an_update(
    test_client: AsyncClient, db_session, saved, graph,
):
    view_id = saved["id"]
    config = await made(db_session, view_id)
    layout = config["layout"]["referenceLayout"]
    tables = next(l["id"] for l in layout["layers"] if l["name"] == "Tables")
    moved = {**layout["assignments"], "col_a1": {**layout["assignments"]["col_a1"], "layerId": tables}}
    put = await test_client.put(f"/api/v1/views/{view_id}/layout", json={
        "referenceLayout": {"layers": layout["layers"], "assignments": moved}})
    assert put.status_code == 200, put.text

    await settle(db_session, view_id)
    graph.engine = TypedEngine(gone={"col_b1"})
    assert (await refresh(test_client, view_id)).json()["outcome"] == "applied"
    assert (await entries(db_session, view_id))["col_a1"]["layerId"] == tables


async def test_a_large_removal_waits_to_be_confirmed(
    test_client: AsyncClient, db_session, saved, graph, monkeypatch,
):
    monkeypatch.setattr(pipeline, "MASS_REMOVAL_MIN", 3)
    view_id = saved["id"]
    await settle(db_session, view_id)
    graph.engine = TypedEngine(gone={"tbl_a", "col_a1", "col_a2", "tbl_b", "col_b1"})
    held = await refresh(test_client, view_id)
    assert held.json()["outcome"] == "held"
    assert (held.json()["detail"]["removed"], held.json()["detail"]["of"]) == (5, 6)
    assert held.json()["membership"]["status"] == "held"
    assert len(await entries(db_session, view_id)) == 6, "nothing is removed until it is confirmed"

    applied = await refresh(test_client, view_id, confirm=True)
    assert applied.status_code == 200, applied.text
    assert applied.json()["outcome"] == "applied"
    assert set(await entries(db_session, view_id)) == {"dom"}
    assert applied.json()["membership"]["status"] == "ok"


async def test_a_short_answer_keeps_the_last_good_members(
    test_client: AsyncClient, db_session, graph,
):
    ws = await workspace(test_client)
    made_ = await test_client.post("/api/v1/views/from-members", json=body(
        ws, "", layout={"kind": "stages"},
        sources=[{"spec": {"seeds": {"urns": ["col_a1"]}, "expand": {"upstream": 1}}}]))
    assert made_.status_code == 201, made_.text
    view_id = made_.json()["view"]["id"]
    held = await entries(db_session, view_id)

    graph.engine = TypedEngine(step_gives_up="timeout")
    await settle(db_session, view_id)
    resp = await refresh(test_client, view_id)
    assert resp.json()["outcome"] == "deferred"
    assert resp.json()["membership"]["status"] == "pending"
    assert await entries(db_session, view_id) == held


async def test_over_the_limit_keeps_the_last_good_members(
    test_client: AsyncClient, db_session, saved, graph, monkeypatch,
):
    view_id = saved["id"]
    held = await entries(db_session, view_id)
    monkeypatch.setattr(pipeline, "entry_limit", lambda: 3)
    await settle(db_session, view_id)
    resp = await refresh(test_client, view_id)
    assert resp.json()["outcome"] == "over_cap"
    assert resp.json()["membership"]["status"] == "over_cap"
    assert resp.json()["membership"]["detail"]["limit"] == 3
    assert await entries(db_session, view_id) == held
