"""Who can read what a conversation is about, and who sees a thread.

``readers_of`` answers for people who are not here — who may be mentioned, who a
question reaches, which watchers hear of one — from role bindings, groups and grants.
A request's own access is decided from its caller's claims. The two must agree, or a
question reaches someone the view would turn away: the parity test holds them together
across every seeded role, grant and visibility tier. Then: who sees a private thread,
which subjects a list may show, and who to ask.
"""
from __future__ import annotations

import pytest
from httpx import AsyncClient
from sqlalchemy import select

from backend.app.db.models import (
    DataRequestORM, DiscussionORM, DiscussionParticipantORM, GroupMemberORM, GroupORM, ResourceGrantORM, ViewORM,
    WorkspaceDataSourceORM,
)
from backend.app.services import view_access
from backend.app.services.discussions import access, readers as rd, routing
from backend.app.services.permission_service import has_permission
from tests.common import discussions_world as w


@pytest.fixture
async def world(db_session):
    await w.seed(db_session)


async def _caller(session, uid: str) -> access.Caller:
    return access.Caller(user=w.user(uid), claims=await w.claims_for(session, uid))


@pytest.mark.asyncio
@pytest.mark.parametrize("view_id", [w.V_PRIV, w.V_WS, w.V_ENT])
async def test_readers_of_a_view_agree_with_can_read_view(world, db_session, view_id):
    view = (await db_session.execute(select(ViewORM).where(ViewORM.id == view_id))).scalar_one()
    readers = await rd.readers_of(db_session, rd.view_subject(view))
    everyone = (*w.PEOPLE, w.BOT)
    said = await readers.among(db_session, everyone)
    for uid in everyone:
        ctx = await view_access.ViewerContext.build(db_session, user=w.user(uid), claims=await w.claims_for(db_session, uid))
        expected = await view_access.can_read_view(db_session, ctx, view) and uid not in (w.CAL, w.BOT)
        assert (uid in said) == expected, (view_id, uid)


@pytest.mark.asyncio
async def test_readers_of_a_data_source_agree_with_its_read_permission(world, db_session):
    subject = await rd.load_subject(db_session, "data_source", w.DS)
    said = await (await rd.readers_of(db_session, subject)).among(db_session, (*w.PEOPLE, w.BOT))
    for uid in (*w.PEOPLE, w.BOT):
        claims = await w.claims_for(db_session, uid)
        expected = has_permission(claims, "workspace:datasource:read", workspace_id=w.WS) and uid not in (w.CAL, w.BOT)
        assert (uid in said) == expected, uid
    # Who that is, spelled out: an expired binding, a suspended account and a service
    # account never count; a group's members and every org-wide role do.
    assert said == {w.ADA, w.BEN, w.WALT, w.OLGA, w.SAM, w.OSCAR, w.GIL}


@pytest.mark.asyncio
async def test_the_tiers_spelled_out(world, db_session):
    async def of(view_id):
        subject = await rd.load_subject(db_session, "view", view_id)
        return await (await rd.readers_of(db_session, subject)).among(db_session, (*w.PEOPLE, w.BOT))

    assert await of(w.V_PRIV) == {w.BEN, w.WALT, w.OLGA, w.SAM, w.GINA, w.RITA}
    assert await of(w.V_WS) == {w.ADA, w.BEN, w.WALT, w.OLGA, w.SAM, w.OSCAR, w.GIL}
    assert await of(w.V_ENT) == set(w.PEOPLE) - {w.CAL}
    # A deleted subject is read by nobody.
    view = (await db_session.execute(select(ViewORM).where(ViewORM.id == w.V_WS))).scalar_one()
    view.deleted_at = w.T0
    await db_session.flush()
    assert await rd.load_subject(db_session, "view", w.V_WS) is None
    assert (await rd.readers_of(db_session, None)).everyone is False


def _thread(tid: str, visibility: str, subject_id: str = w.V_ENT) -> DiscussionORM:
    return DiscussionORM(id=tid, subject_type="view", subject_id=subject_id, visibility=visibility, status="open",
                         asked_by=w.ADA, excerpt="Where does revenue come from?", last_message_by=w.ADA,
                         created_at=w.T0, updated_at=w.T0, last_activity_at=w.T0)


@pytest.mark.asyncio
async def test_a_private_thread_is_seen_by_the_people_in_it_its_maintainers_and_admins(world, db_session):
    db_session.add_all([_thread("dis_open", "open"), _thread("dis_priv", "private")])
    await db_session.flush()
    db_session.add(DiscussionParticipantORM(discussion_id="dis_priv", user_id=w.ADA, joined_via="asked"))
    db_session.add(DiscussionParticipantORM(discussion_id="dis_priv", user_id=w.EVE, joined_via="mentioned"))
    await db_session.commit()
    subject = await rd.load_subject(db_session, "view", w.V_ENT)
    seen = {}
    for uid in w.PEOPLE:
        caller = await _caller(db_session, uid)
        for tid in ("dis_open", "dis_priv"):
            thread = await db_session.get(DiscussionORM, tid)
            part = (await db_session.execute(select(DiscussionParticipantORM).where(
                DiscussionParticipantORM.discussion_id == tid, DiscussionParticipantORM.user_id == uid,
            ))).scalar_one_or_none()
            seen[(uid, tid)] = await access.thread_visible(db_session, caller, thread, subject, participant=part)
    assert {u for u in w.PEOPLE if seen[(u, "dis_open")]} == set(w.PEOPLE)
    # Ada asked, Eve was mentioned, Ben made the view, Walt runs Finance; Olga and Sam
    # administer everything. Gina's editor grant is on another view.
    assert {u for u in w.PEOPLE if seen[(u, "dis_priv")]} == {w.ADA, w.EVE, w.BEN, w.WALT, w.OLGA, w.SAM}


@pytest.mark.asyncio
async def test_an_editor_grant_maintains_the_view_and_a_data_contact_the_source(world, db_session):
    view = await rd.load_subject(db_session, "view", w.V_PRIV)
    gina = await _caller(db_session, w.GINA)
    rita = await _caller(db_session, w.RITA)
    assert await access.sees_every_private_thread(db_session, gina, view)
    assert not await access.sees_every_private_thread(db_session, rita, view)   # a viewer grant only
    source = await rd.load_subject(db_session, "data_source", w.DS)
    ada = await _caller(db_session, w.ADA)
    assert not await access.sees_every_private_thread(db_session, ada, source)
    db_session.add(DataRequestORM(workspace_id=w.WS, requested_by=w.EVE, title="Ledger", system="dbt",
                                  contact_ids=f'["{w.ADA}"]', status="connected", data_source_id=w.DS,
                                  resolved_at=w.T0, created_at=w.T0, updated_at=w.T0))
    await db_session.flush()
    assert await access.sees_every_private_thread(db_session, ada, source)   # derived: she knows the data


@pytest.mark.asyncio
async def test_readable_subject_ids_answers_for_many_at_once(world, db_session):
    refs = {("view", w.V_PRIV), ("view", w.V_WS), ("view", w.V_ENT), ("view", "view_nope"),
            ("data_source", w.DS), ("data_source", w.DS_OPS)}
    assert await access.readable_subject_ids(db_session, await _caller(db_session, w.ADA), refs) == {
        ("view", w.V_WS), ("view", w.V_ENT), ("data_source", w.DS)}
    assert await access.readable_subject_ids(db_session, await _caller(db_session, w.EVE), refs) == {
        ("view", w.V_ENT), ("data_source", w.DS_OPS)}
    assert await access.readable_subject_ids(db_session, await _caller(db_session, w.SAM), refs) == refs - {
        ("view", "view_nope")}


# ── Who to ask ─────────────────────────────────────────────────────────


@pytest.mark.asyncio
async def test_who_to_ask_about_a_view_names_its_owners_and_its_datas(world, db_session, test_client: AsyncClient):
    with w.acting(w.ADA, await w.claims_for(db_session, w.ADA)):
        r = await test_client.get(f"/api/v1/discussions/subjects/view/{w.V_WS}/people")
    assert r.status_code == 200, r.text
    body = r.json()
    assert [(p["personId"], p["via"], p["canRead"]) for p in body["viewOwners"]] == [(w.BEN, "creator", True)]
    assert body["dataContacts"] == {
        "owner": {"personId": w.BEN, "via": "created_source", "groupId": None, "groupName": None, "canRead": True},
        "stewards": [], "provenance": "derived",
    }
    assert body["fallback"] == [] and body["truncated"] == 0
    assert body["people"][w.BEN]["displayName"] == "Ben T"


@pytest.mark.asyncio
async def test_who_to_ask_says_who_cannot_open_it(world, db_session, test_client: AsyncClient):
    with w.acting(w.SAM, await w.claims_for(db_session, w.SAM)):
        r = await test_client.get(f"/api/v1/discussions/subjects/view/{w.V_PRIV}/people")
    owners = {(p["personId"], p["via"], p["canRead"]) for p in r.json()["viewOwners"]}
    assert owners == {(w.BEN, "creator", True), (w.GINA, "editor_grant", True)}
    # A data source naming and deriving nobody falls back to its workspace's admins.
    with w.acting(w.EVE, await w.claims_for(db_session, w.EVE)):
        r = await test_client.get(f"/api/v1/discussions/subjects/data_source/{w.DS_OPS}/people")
    body = r.json()
    assert body["viewOwners"] == [] and body["dataContacts"]["owner"]["personId"] == w.EVE


@pytest.mark.asyncio
async def test_a_subject_you_cannot_open_is_not_found(world, db_session, test_client: AsyncClient):
    with w.acting(w.EVE, await w.claims_for(db_session, w.EVE)):
        for path in (f"view/{w.V_PRIV}", f"view/{w.V_WS}", f"data_source/{w.DS}", "view/view_nope"):
            r = await test_client.get(f"/api/v1/discussions/subjects/{path}/people")
            assert r.status_code == 404, path
            assert r.json()["detail"]["type"] == "not_found"


@pytest.mark.asyncio
async def test_routing_reaches_readers_and_says_why_it_missed_the_rest(world, db_session):
    subject = await rd.load_subject(db_session, "view", w.V_WS)
    readers = await rd.readers_of(db_session, subject)
    wta = await routing.who_to_ask(db_session, subject, readers)
    routed = await routing.route(db_session, subject, wta, view_owners=True, data_contacts=True,
                                 recipient_ids=[w.EVE, w.CAL, w.BOT, w.GIL, w.ADA], asker_id=w.ADA, readers=readers)
    assert routed.reached == [w.BEN, w.GIL]
    assert dict(routed.not_reached) == {w.EVE: "cannot_read", w.CAL: "inactive", w.BOT: "not_a_person"}
    assert routed.used_fallback is False


@pytest.mark.asyncio
async def test_a_source_with_nobody_to_ask_falls_back_to_its_admins_then_org_admins(world, db_session):
    ds = await db_session.get(WorkspaceDataSourceORM, w.DS)
    ds.created_by = None
    await db_session.flush()
    subject = await rd.load_subject(db_session, "data_source", w.DS)
    readers = await rd.readers_of(db_session, subject)
    wta = await routing.who_to_ask(db_session, subject, readers)
    assert wta.provenance == "fallback" and [(r.person_id, r.via) for r in wta.fallback] == [(w.WALT, "workspace_admin")]
    routed = await routing.route(db_session, subject, wta, view_owners=False, data_contacts=True,
                                 recipient_ids=[], asker_id=w.ADA, readers=readers)
    assert routed.reached == [w.WALT] and routed.used_fallback
    # Ops has no admins of its own: its Org Admins (Olga; Sam's Super Admin role carries it too).
    ops = await rd.load_subject(db_session, "data_source", w.DS_OPS)
    assert [(r.person_id, r.via) for r in await routing.fallback(db_session, ops.workspace_id,
                                                                  await rd.readers_of(db_session, ops))] == [
        (w.OLGA, "org_admin"), (w.SAM, "org_admin")]


@pytest.mark.asyncio
async def test_a_big_group_is_cut_at_fifty_and_counted(world, db_session):
    db_session.add(GroupORM(id="grp_big", name="Everyone in finance"))
    for i in range(120):
        w.add_user(db_session, f"usr_m{i:03d}")
    await db_session.flush()
    db_session.add_all([GroupMemberORM(group_id="grp_big", user_id=f"usr_m{i:03d}") for i in range(120)])
    db_session.add(ResourceGrantORM(resource_type="view", resource_id=w.V_ENT, subject_type="group",
                                    subject_id="grp_big", role_name="editor"))
    await db_session.flush()
    subject = await rd.load_subject(db_session, "view", w.V_ENT)
    wta = await routing.who_to_ask(db_session, subject, await rd.readers_of(db_session, subject))
    editors = [r for r in wta.view_owners if r.via == "editor_grant"]
    assert len(editors) == 50 and wta.truncated == 70 and wta.cut_groups == ["grp_big"]
    assert {r.group_name for r in editors} == {"Everyone in finance"}
