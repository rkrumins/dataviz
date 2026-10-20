"""Access reviews: a workspace admin goes through who holds access.

* A review is a snapshot of the grants made here — people's and teams' —
  when it began; the identity provider's and organization-wide access are
  counted, not reviewed. One open review per workspace; admins only.
* Keeping changes nothing. Removing takes the grant away at once, ends the
  person's sessions and tells them why. Nothing else is ever removed.
* A review completes once every grant is decided, or is cancelled; one past
  its due date is flagged to the workspace's admins, once.
"""
from __future__ import annotations

from datetime import datetime, timedelta, timezone

import pytest
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from backend.app.db.models import GroupORM, RoleBindingORM
from backend.app.services import access_housekeeping
from tests.common.workspace_access_world import (
    WS,
    acting_as,
    build_world,
    days_ago,
    events,
    notes,
    seed_steward_catalogue,
)

URL = f"/api/v1/admin/workspaces/{WS}/access-reviews"


@pytest.fixture(autouse=True)
async def _steward_catalogue(db_session: AsyncSession):
    await seed_steward_catalogue(db_session)


@pytest.fixture()
async def world(db_session: AsyncSession, test_client):
    """Finance as ``build_world`` makes it, plus an exception, a grant the
    identity provider made, one that has lapsed, and a team."""
    await build_world(db_session)
    db_session.add(GroupORM(id="grp_audit", name="Auditors"))
    for subject_type, who, role, extra in (
        ("user", "usr_ana", "workspace_viewer", {"idp_exception": True, "granted_by": "usr_wanda"}),
        ("user", "usr_ana", "workspace_member", {"source": "sso"}),
        ("user", "usr_ana", "workspace_data_engineer", {"expires_at": days_ago(1)}),
        ("group", "grp_audit", "workspace_viewer", {}),
    ):
        db_session.add(RoleBindingORM(
            subject_type=subject_type, subject_id=who, role_name=role, scope_type="workspace",
            scope_id=WS, granted_at=days_ago(90), **extra,
        ))
    await db_session.commit()
    return test_client


async def _start(world, session, **body):
    async with acting_as(session, "wanda"):
        return await world.post(URL, json=body)


def _item(review: dict, subject: str, role: str) -> dict:
    [item] = [i for i in review["items"] if (i["subject"]["id"], i["role"]) == (subject, role)]
    return item


async def test_a_review_covers_the_grants_made_here(world, db_session):
    res = await _start(world, db_session, dueInDays=7)
    assert res.status_code == 201, res.text
    review = res.json()
    assert (review["status"], review["startedBy"], review["counts"]["undecided"]) == ("open", "usr_wanda", 5)
    due = datetime.fromisoformat(review["dueAt"]) - datetime.now(timezone.utc)
    assert timedelta(days=6) < due <= timedelta(days=7)
    # Exceptions first; the identity provider's grant and the lapsed one aren't in it.
    assert [(i["subject"]["id"], i["role"], i["origin"]) for i in review["items"]] == [
        ("usr_ana", "workspace_viewer", "exception"),
        ("usr_bob", "workspace_steward", "direct"),
        ("usr_max", "workspace_member", "direct"),
        ("usr_wanda", "workspace_admin", "direct"),
        ("grp_audit", "workspace_viewer", "team"),
    ]
    assert review["notReviewed"] == {"identityProvider": 1, "organizationWide": 1}
    [event] = await events(db_session, "rbac.workspace.access_review_started")
    assert (event["review_id"], event["grants"]) == (review["id"], 5)


async def test_one_open_review_per_workspace_and_only_its_admins_run_them(world, db_session):
    for who in ("bob", "max", "ana"):
        async with acting_as(db_session, who):
            assert (await world.post(URL, json={})).status_code == 403
            assert (await world.get(URL)).status_code == 403
    assert (await _start(world, db_session)).status_code == 201
    assert (await _start(world, db_session)).status_code == 409
    async with acting_as(db_session, "olga"):
        [listed] = (await world.get(URL)).json()
    assert (listed["status"], listed["counts"]["total"], listed["items"]) == ("open", 5, None)


async def test_removing_a_grant_takes_it_away_at_once_and_says_why(world, db_session):
    review = (await _start(world, db_session)).json()
    item = _item(review, "usr_max", "workspace_member")
    url = f"{URL}/{review['id']}/items/{item['id']}"
    async with acting_as(db_session, "wanda"):
        res = await world.post(url, json={"decision": "remove", "note": "Left the team"})
        again = await world.post(url, json={"decision": "keep"})
    assert res.status_code == 200, res.text
    after = _item(res.json(), "usr_max", "workspace_member")
    assert (after["decision"], after["decidedBy"], after["note"], after["current"]) == (
        "remove", "usr_wanda", "Left the team", False,
    )
    assert res.json()["counts"] == {"total": 5, "kept": 0, "removed": 1, "undecided": 4}
    assert again.status_code == 409
    assert await db_session.get(RoleBindingORM, item["bindingId"]) is None
    [note] = await notes(db_session, "workspace.member_removed")
    assert (note.user_id, note.title) == ("usr_max", "You no longer have access to Finance")
    assert note.body.startswith("It was removed in an access review of the workspace.")
    [event] = await events(db_session, "rbac.workspace.member_revoked")
    assert (event["subject_id"], event["via"], event["review_id"]) == ("usr_max", "access_review", review["id"])


async def test_keeping_changes_nothing_and_can_still_become_removing(world, db_session):
    review = (await _start(world, db_session)).json()
    item = _item(review, "grp_audit", "workspace_viewer")
    url = f"{URL}/{review['id']}/items/{item['id']}"
    async with acting_as(db_session, "wanda"):
        kept = await world.post(url, json={"decision": "keep"})
        assert _item(kept.json(), "grp_audit", "workspace_viewer")["decision"] == "keep"
        assert await db_session.get(RoleBindingORM, item["bindingId"]) is not None
        removed = await world.post(url, json={"decision": "remove"})
    assert _item(removed.json(), "grp_audit", "workspace_viewer")["decision"] == "remove"
    assert await db_session.get(RoleBindingORM, item["bindingId"]) is None
    assert await notes(db_session, "workspace.member_removed") == []  # a team hears nothing


async def test_a_grant_made_again_since_is_not_the_one_reviewed(world, db_session):
    review = (await _start(world, db_session)).json()
    item = _item(review, "usr_max", "workspace_member")
    old = await db_session.get(RoleBindingORM, item["bindingId"])
    await db_session.delete(old)
    await db_session.flush()
    db_session.add(RoleBindingORM(
        subject_type="user", subject_id="usr_max", role_name="workspace_member",
        scope_type="workspace", scope_id=WS,
    ))
    await db_session.commit()
    async with acting_as(db_session, "wanda"):
        res = await world.post(f"{URL}/{review['id']}/items/{item['id']}", json={"decision": "remove"})
    assert res.status_code == 200, res.text
    still = (await db_session.execute(select(RoleBindingORM).where(
        RoleBindingORM.subject_id == "usr_max", RoleBindingORM.scope_id == WS,
    ))).scalars().all()
    assert len(still) == 1


async def test_a_review_completes_once_every_grant_is_decided(world, db_session):
    review = (await _start(world, db_session)).json()
    done = f"{URL}/{review['id']}/complete"
    async with acting_as(db_session, "wanda"):
        early = await world.post(done)
        for i in review["items"]:
            decision = "remove" if i["subject"]["id"] == "usr_ana" else "keep"
            await world.post(f"{URL}/{review['id']}/items/{i['id']}", json={"decision": decision})
        res = await world.post(done)
        late = await world.post(f"{URL}/{review['id']}/items/{review['items'][1]['id']}", json={"decision": "remove"})
    assert (early.status_code, early.json()["detail"]) == (409, "5 grant(s) still need a decision")
    assert res.status_code == 200, res.text
    assert (res.json()["status"], res.json()["completedBy"]) == ("completed", "usr_wanda")
    assert late.status_code == 409
    [event] = await events(db_session, "rbac.workspace.access_review_completed")
    assert (event["kept"], event["removed"]) == (4, 1)
    assert (await _start(world, db_session)).status_code == 201  # the next one can start


async def test_cancelling_keeps_what_was_already_removed(world, db_session):
    review = (await _start(world, db_session)).json()
    item = _item(review, "usr_max", "workspace_member")
    async with acting_as(db_session, "wanda"):
        await world.post(f"{URL}/{review['id']}/items/{item['id']}", json={"decision": "remove"})
        res = await world.post(f"{URL}/{review['id']}/cancel")
        twice = await world.post(f"{URL}/{review['id']}/cancel")
    assert (res.status_code, res.json()["status"]) == (200, "cancelled")
    assert twice.status_code == 409
    assert await db_session.get(RoleBindingORM, item["bindingId"]) is None
    assert len(await events(db_session, "rbac.workspace.access_review_cancelled")) == 1


async def test_a_review_past_its_due_date_is_flagged_once(world, db_session):
    review = (await _start(world, db_session)).json()
    assert await access_housekeeping.flag_overdue_reviews(db_session) == 0
    later = datetime.now(timezone.utc) + timedelta(days=15)
    assert await access_housekeeping.flag_overdue_reviews(db_session, now=later) == 1
    [note] = await notes(db_session, "access_review.overdue")
    assert (note.user_id, note.title, note.body) == (
        "usr_wanda", "The access review of Finance is past its due date", "5 of 5 grants still need a decision.",
    )
    assert note.resource_id == review["id"]
    assert await access_housekeeping.flag_overdue_reviews(db_session, now=later) == 0


async def test_another_workspaces_review_is_not_found_here(world, db_session):
    review = (await _start(world, db_session)).json()
    async with acting_as(db_session, "olga"):
        res = await world.get(f"/api/v1/admin/workspaces/ws_ops/access-reviews/{review['id']}")
    assert res.status_code == 404
