"""A data source's data contacts: its Owner and Stewards.

These pin who may change what — anyone who manages the source changes the Stewards;
only a workspace admin or the current Owner changes the Owner — that a source naming
nobody shows who it was derived from until the first save writes them down, that an
editor working from an old copy is told so, what a contact may be, that nothing is
saved while the switch is off, and that each change is recorded and the people named
are told.
"""
from __future__ import annotations

import json

import pytest
from httpx import AsyncClient

from backend.app.db.models import DataRequestORM, GroupMemberORM, GroupORM
from tests.common import discussions_world as w

URL = f"/api/v1/admin/workspaces/{w.WS}/data-sources/{w.DS}/contacts"


@pytest.fixture
async def world(db_session):
    await w.seed(db_session)
    # Ada and Gil were named as the people who know the ledger when it was asked for.
    db_session.add(DataRequestORM(workspace_id=w.WS, requested_by=w.EVE, title="Ledger", system="dbt",
                                  contact_ids=json.dumps([w.ADA, w.GIL]), status="connected", data_source_id=w.DS,
                                  resolved_at=w.T0, created_at=w.T0, updated_at=w.T0))
    await db_session.commit()


@pytest.fixture
def on():
    w.switch(True)


async def _get(client, db_session, uid=w.BEN):
    with w.acting(uid, await w.claims_for(db_session, uid)):
        return await client.get(URL)


async def _put(client, db_session, uid, body):
    with w.acting(uid, await w.claims_for(db_session, uid)):
        return await client.put(URL, json=body)


def _u(uid):
    return {"subjectType": "user", "subjectId": uid}


@pytest.mark.asyncio
async def test_a_source_naming_nobody_shows_who_it_was_derived_from(world, db_session, test_client: AsyncClient):
    r = await _get(test_client, db_session, w.ADA)
    assert r.status_code == 200, r.text
    body = r.json()
    assert body["provenance"] == "derived" and body["updatedAt"] is None
    assert body["owner"] == {"subjectType": "user", "subjectId": w.BEN, "name": "Ben T", "memberCount": None,
                             "via": "created_source"}
    assert [(s["subjectId"], s["via"]) for s in body["stewards"]] == [(w.ADA, "data_request"), (w.GIL, "data_request")]
    assert body["canEdit"] is False and body["canEditOwner"] is False      # a Viewer, and the switch is off
    # Someone who can't read the workspace's sources can't read them either.
    assert (await _get(test_client, db_session, w.EVE)).status_code == 403


@pytest.mark.asyncio
async def test_nothing_is_saved_while_the_switch_is_off(world, db_session, test_client: AsyncClient):
    r = await _put(test_client, db_session, w.WALT, {"owner": _u(w.WALT), "stewards": [], "expectedUpdatedAt": None})
    assert r.status_code == 403 and r.json()["detail"]["type"] == "feature_disabled"
    assert (await _get(test_client, db_session)).json()["provenance"] == "derived"


@pytest.mark.asyncio
async def test_the_first_save_writes_them_down_and_tells_the_people_named(world, on, db_session, test_client):
    got = (await _get(test_client, db_session)).json()
    assert got["canEdit"] and got["canEditOwner"]          # Ben manages the source and is its derived Owner
    r = await _put(test_client, db_session, w.BEN, {
        "owner": _u(w.BEN), "stewards": [_u(w.ADA), {"subjectType": "group", "subjectId": w.G_VIEWERS}],
        "expectedUpdatedAt": None,
    })
    assert r.status_code == 200, r.text
    body = r.json()
    assert body["provenance"] == "named" and body["updatedAt"]
    assert body["owner"]["via"] == "named_owner"
    assert [(s["subjectType"], s["name"], s["memberCount"]) for s in body["stewards"]] == [
        ("user", "Ada T", None), ("group", "Finance viewers", 1)]
    [event] = await w.events(db_session, "workspace.data_source.contacts_changed")
    payload = json.loads(event.payload)
    assert payload["owner"] == ["user", w.BEN] and payload["actor_id"] == w.BEN
    # Ada is told; Ben did it himself, and a group's members are not told one by one.
    [told] = await w.notifications(db_session, w.ADA, "data_source.contact_added")
    assert told.resource_type == "data_source" and told.resource_id == w.DS
    assert await w.notifications(db_session, w.BEN, "data_source.contact_added") == []
    assert await w.notifications(db_session, w.GIL, "data_source.contact_added") == []
    # Saving the same set again changes nothing and says nothing.
    again = await _put(test_client, db_session, w.BEN, {
        "owner": _u(w.BEN), "stewards": [_u(w.ADA), {"subjectType": "group", "subjectId": w.G_VIEWERS}],
        "expectedUpdatedAt": body["updatedAt"],
    })
    assert again.status_code == 200 and again.json()["updatedAt"] == body["updatedAt"]
    assert len(await w.events(db_session, "workspace.data_source.contacts_changed")) == 1


@pytest.mark.asyncio
async def test_only_an_admin_or_the_current_owner_changes_the_owner(world, on, db_session, test_client):
    # A manager who isn't the Owner (Rita, made a Member) keeps the Owner and changes the Stewards.
    db_session.add(w.bind(w.RITA, "workspace_member", w.WS))
    await db_session.commit()
    r = await _put(test_client, db_session, w.RITA, {"owner": _u(w.RITA), "stewards": [], "expectedUpdatedAt": None})
    assert r.status_code == 403 and r.json()["detail"]["type"] == "owner_locked"
    r = await _put(test_client, db_session, w.RITA, {"owner": _u(w.BEN), "stewards": [_u(w.RITA)],
                                                     "expectedUpdatedAt": None})
    assert r.status_code == 200, r.text
    assert r.json()["canEditOwner"] is False
    stamp = r.json()["updatedAt"]
    # The workspace's admin changes it, and so may the Owner himself.
    r = await _put(test_client, db_session, w.WALT, {"owner": _u(w.WALT), "stewards": [], "expectedUpdatedAt": stamp})
    assert r.status_code == 200, r.text
    r = await _put(test_client, db_session, w.WALT, {"owner": _u(w.BEN), "stewards": [],
                                                     "expectedUpdatedAt": r.json()["updatedAt"]})
    assert r.status_code == 200
    r = await _put(test_client, db_session, w.BEN, {"owner": None, "stewards": [_u(w.ADA)],
                                                    "expectedUpdatedAt": r.json()["updatedAt"]})
    assert r.status_code == 200 and r.json()["owner"] is None and r.json()["provenance"] == "named"
    # Naming nobody at all goes back to what the source derives.
    r = await _put(test_client, db_session, w.WALT, {"owner": None, "stewards": [],
                                                     "expectedUpdatedAt": r.json()["updatedAt"]})
    assert r.json()["provenance"] == "derived" and r.json()["owner"]["via"] == "created_source"


@pytest.mark.asyncio
async def test_a_save_from_an_old_copy_is_stale(world, on, db_session, test_client):
    first = await _put(test_client, db_session, w.WALT, {"owner": _u(w.BEN), "stewards": [_u(w.ADA)],
                                                         "expectedUpdatedAt": None})
    assert first.status_code == 200
    late = await _put(test_client, db_session, w.WALT, {"owner": _u(w.BEN), "stewards": [],
                                                        "expectedUpdatedAt": None})
    assert late.status_code == 409
    detail = late.json()["detail"]
    assert detail["type"] == "stale"
    assert [s["subjectId"] for s in detail["current"]["stewards"]] == [w.ADA]


@pytest.mark.asyncio
async def test_what_a_contact_may_be(world, on, db_session, test_client):
    many = [_u(f"usr_s{i:02d}") for i in range(11)]
    for s in many:
        w.add_user(db_session, s["subjectId"])
    db_session.add(GroupORM(id="grp_huge", name="Everyone"))
    await db_session.flush()
    for i in range(51):
        db_session.add(GroupMemberORM(group_id="grp_huge", user_id=f"usr_h{i:02d}"))
    await db_session.commit()

    async def refused(body):
        r = await _put(test_client, db_session, w.WALT, {"owner": None, "expectedUpdatedAt": None, **body})
        assert r.status_code == 422, r.text
        return r.json()["detail"]["type"]

    assert await refused({"stewards": many}) == "too_many"
    assert await refused({"stewards": [_u(w.CAL)]}) == "not_active"             # suspended
    assert await refused({"stewards": [_u(w.BOT)]}) == "not_active"             # a service account
    assert await refused({"stewards": [{"subjectType": "group", "subjectId": "grp_gone"}]}) == "not_active"
    assert await refused({"stewards": [{"subjectType": "group", "subjectId": "grp_huge"}]}) == "group_too_large"
    # Ten is fine; the Owner named as a Steward too is named once.
    r = await _put(test_client, db_session, w.WALT, {"owner": many[0], "stewards": many[:10], "expectedUpdatedAt": None})
    assert r.status_code == 200 and len(r.json()["stewards"]) == 9


@pytest.mark.asyncio
async def test_a_viewer_or_a_service_account_cannot_change_them(world, on, db_session, test_client):
    r = await _put(test_client, db_session, w.ADA, {"owner": None, "stewards": [], "expectedUpdatedAt": None})
    assert r.status_code == 403
    r = await _put(test_client, db_session, w.BOT, {"owner": _u(w.BEN), "stewards": [], "expectedUpdatedAt": None})
    assert r.status_code == 403 and r.json()["detail"]["type"] == "person_required"
    # A source in another workspace, or none at all, is not found here.
    with w.acting(w.SAM, await w.claims_for(db_session, w.SAM)):
        r = await test_client.get(f"/api/v1/admin/workspaces/{w.WS}/data-sources/{w.DS_OPS}/contacts")
    assert r.status_code == 404
