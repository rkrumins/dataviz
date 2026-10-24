"""Native queries through a view share, and what the view tells the UI.

A share can opt in to letting its holder query the view's data source. Only
someone who may query that source themselves can turn it on (no one hands on
a reach they don't have); anyone who manages the shares can turn it off. The
choice travels with the share's outbox event, its activity line and the
recipient's notification. The view's access envelope says whether the caller
may query its source (``canQueryDataSource``) and offer that on a share
(``canGrantSourceQuery``), so the UI never derives it from claims.
"""
from __future__ import annotations

import json

import pytest
from httpx import AsyncClient
from sqlalchemy import select

from backend.app.db.models import (
    NotificationORM,
    OutboxEventORM,
    ProviderORM,
    ResourceGrantORM,
    UserORM,
    ViewORM,
    WorkspaceDataSourceORM,
    WorkspaceORM,
)
from backend.app.db.repositories import grant_repo
from backend.app.services.permission_service import PermissionClaims
from backend.tests.test_views_scoping_regressions import _auth, _user

WS = "ws_share_nq"
DS = "ds_share_nq"
VIEW = "view_share_nq"
OWNER = _user("usr_nq_owner")
GUEST = _user("usr_nq_guest")
OUTSIDER = _user("usr_nq_outsider")

_AUTHOR = ("workspace:view:create", "workspace:view:edit", "workspace:view:delete",
           "workspace:view:read", "workspace:datasource:read")
OWNER_CLAIMS = PermissionClaims(sid="s_nq_owner", ws_perms={WS: _AUTHOR + ("workspace:native-query:read",)})
# An owner whose role has had the native query permission taken away.
OWNER_WITHOUT = PermissionClaims(sid="s_nq_owner_without", ws_perms={WS: _AUTHOR})
EMPTY = PermissionClaims(sid="s_nq_empty")


@pytest.fixture
async def estate(db_session):
    db_session.add(WorkspaceORM(id=WS, name="Sharing"))
    db_session.add(ProviderORM(id="prov_share_nq", name="P", provider_type="falkordb"))
    db_session.add(WorkspaceDataSourceORM(id=DS, workspace_id=WS, provider_id="prov_share_nq",
                                          label="Source", graph_name="g", is_primary=True))
    db_session.add(ViewORM(id=VIEW, name="Pipelines", workspace_id=WS, data_source_id=DS,
                           visibility="private", created_by=OWNER.id))
    db_session.add(ViewORM(id="view_share_nq_ent", name="Everyone", workspace_id=WS,
                           data_source_id=DS, visibility="enterprise", created_by=OWNER.id))
    db_session.add(UserORM(id=GUEST.id, email=GUEST.email, password_hash="x", first_name="G",
                           last_name="U", status="active", created_at="2024-01-01T00:00:00Z",
                           updated_at="2024-01-01T00:00:00Z"))
    await db_session.commit()


async def envelope(client, view_id=VIEW):
    r = await client.get(f"/api/v1/views/{view_id}")
    assert r.status_code == 200, r.text
    return r.json()["access"]


async def share(client, **body):
    return await client.post(f"/api/v1/views/{VIEW}/grants",
                             json={"subjectType": "user", "subjectId": GUEST.id, "role": "viewer",
                                   **body})


# ── the envelope ────────────────────────────────────────────────────────


async def test_an_owner_who_may_query_may_offer_it_on_a_share(test_client: AsyncClient,
                                                             db_session, estate):
    with _auth(user=OWNER, claims=OWNER_CLAIMS):
        access = await envelope(test_client)
    assert (access["canQueryDataSource"], access["canGrantSourceQuery"]) == (True, True)


async def test_without_the_permission_neither(test_client: AsyncClient, db_session, estate):
    with _auth(user=OWNER, claims=OWNER_WITHOUT):
        access = await envelope(test_client)
    assert (access["canQueryDataSource"], access["canGrantSourceQuery"]) == (False, False)


async def test_an_org_wide_view_lets_no_one_query_its_source(test_client: AsyncClient, db_session,
                                                            estate):
    with _auth(user=OUTSIDER, claims=EMPTY):
        access = await envelope(test_client, "view_share_nq_ent")
    assert (access["canQueryDataSource"], access["canGrantSourceQuery"]) == (False, False)


@pytest.mark.parametrize("opted_in", [True, False])
async def test_a_guest_may_query_only_through_a_share_that_opts_in(test_client: AsyncClient,
                                                                   db_session, estate, opted_in):
    await grant_repo.create_grant(db_session, resource_type="view", resource_id=VIEW,
                                  subject_type="user", subject_id=GUEST.id, role_name="viewer",
                                  can_query_source=opted_in)
    await db_session.commit()
    with _auth(user=GUEST, claims=EMPTY):
        access = await envelope(test_client)
    assert access["canQueryDataSource"] is opted_in
    assert access["canGrantSourceQuery"] is False


# ── the share API ───────────────────────────────────────────────────────


async def test_sharing_with_the_opt_in_records_and_tells_it(test_client: AsyncClient, db_session,
                                                           estate):
    with _auth(user=OWNER, claims=OWNER_CLAIMS):
        r = await share(test_client, canQuerySource=True)
        listed = await test_client.get(f"/api/v1/views/{VIEW}/grants")
    assert r.status_code == 201, r.text
    assert r.json()["canQuerySource"] is True
    assert listed.json()[0]["canQuerySource"] is True
    event = (await db_session.execute(
        select(OutboxEventORM).where(OutboxEventORM.event_type == "rbac.view.grant_added")
    )).scalar_one()
    assert json.loads(event.payload)["can_query_source"] is True
    note = (await db_session.execute(
        select(NotificationORM).where(NotificationORM.user_id == GUEST.id)
    )).scalar_one()
    assert "read-only queries on its data source" in note.body


async def test_only_someone_who_may_query_can_turn_it_on(test_client: AsyncClient, db_session,
                                                        estate):
    with _auth(user=OWNER, claims=OWNER_WITHOUT):
        refused = await share(test_client, canQuerySource=True)
        plain = await share(test_client)
    assert refused.status_code == 403
    assert refused.json()["detail"]["permission"] == "workspace:native-query:read"
    assert plain.status_code == 201 and plain.json()["canQuerySource"] is False


async def test_changing_a_share(test_client: AsyncClient, db_session, estate):
    with _auth(user=OWNER, claims=OWNER_CLAIMS):
        grant_id = (await share(test_client)).json()["grantId"]
    url = f"/api/v1/views/{VIEW}/grants/{grant_id}"
    with _auth(user=OWNER, claims=OWNER_WITHOUT):
        refused = await test_client.put(url, json={"canQuerySource": True})
        nothing = await test_client.put(url, json={})
    assert refused.status_code == 403 and nothing.status_code == 422
    with _auth(user=OWNER, claims=OWNER_CLAIMS):
        on = await test_client.put(url, json={"canQuerySource": True})
    assert on.status_code == 200 and on.json()["canQuerySource"] is True
    with _auth(user=OWNER, claims=OWNER_WITHOUT):
        # Turning it off, or changing only the role, takes no more than managing shares.
        role = await test_client.put(url, json={"role": "editor"})
        off = await test_client.put(url, json={"canQuerySource": False})
    assert role.status_code == 200 and role.json()["canQuerySource"] is True
    assert off.status_code == 200 and off.json()["canQuerySource"] is False
    updates = (await db_session.execute(
        select(OutboxEventORM).where(OutboxEventORM.event_type == "rbac.view.grant_updated")
    )).scalars().all()
    payloads = [json.loads(u.payload) for u in updates]
    assert [(p["role"], p["can_query_source"]) for p in payloads] == [
        ("viewer", True), ("editor", True), ("editor", False),
    ]


async def test_only_a_view_share_can_opt_in(db_session, estate):
    with pytest.raises(ValueError):
        await grant_repo.create_grant(db_session, resource_type="layout_template",
                                      resource_id="tpl_1", subject_type="user",
                                      subject_id=GUEST.id, role_name="viewer",
                                      can_query_source=True)
    grant = await grant_repo.create_grant(db_session, resource_type="view", resource_id=VIEW,
                                          subject_type="user", subject_id=GUEST.id,
                                          role_name="viewer")
    assert grant.can_query_source is False
    stored = await db_session.get(ResourceGrantORM, grant.id)
    assert stored.can_query_source is False
