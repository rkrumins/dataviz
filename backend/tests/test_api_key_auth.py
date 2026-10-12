"""API keys on the wire: authenticated as their owner, held to what they cover.

Runs through the real auth dependencies — no override of ``get_current_user``
or ``get_permission_claims`` anywhere in this file — and a client that carries
no CSRF cookie, so the middleware runs as it does for a script. The world and
the client live in ``tests/common/api_key_world.py``.
"""
from __future__ import annotations

import json
import logging
from datetime import datetime, timedelta, timezone

import pytest
from fastapi import HTTPException
from sqlalchemy import delete, select
from sqlalchemy.exc import OperationalError

from backend.app.auth import api_key_auth
from backend.app.db.models import (
    ApiKeyORM,
    NotificationORM,
    OutboxEventORM,
    RoleBindingORM,
    UserIdentityORM,
    UserORM,
)
from backend.app.db.repositories import api_key_repo
from backend.app.services.revocation_service import get_revocation_service
from backend.auth_service.cookies import ACCESS_COOKIE_NAME
from backend.auth_service.core import api_keys
from backend.auth_service.core.tokens import create_access_token
from tests.common.api_key_world import (
    OTHER,
    OWNER,
    api_key_app,
    days_ago,
    error,
    mint,
    prime,
    user_row,
)


@pytest.fixture()
async def client(db_session, monkeypatch):
    async with api_key_app(db_session, monkeypatch) as http:
        yield http


# ── Acting as the owner ─────────────────────────────────────────────


async def test_a_key_acts_as_its_owner(client, db_session):
    key = await mint(db_session, views="read")
    response = await client.get("/api/v1/views/v_a_mine", headers=key.headers)
    assert response.status_code == 200, response.text
    assert response.json()["id"] == "v_a_mine"


async def test_a_key_writes_without_csrf_and_the_change_names_the_key(client, db_session):
    key = await mint(db_session, views="write")
    response = await client.put(
        "/api/v1/views/v_a_mine", json={"name": "Renamed by a script"}, headers=key.headers,
    )
    assert response.status_code == 200, response.text
    events = (await db_session.execute(
        select(OutboxEventORM).where(OutboxEventORM.event_type.like("visualization.view.%"))
    )).scalars().all()
    assert events, "the edit should be on the record"
    assert {json.loads(e.payload).get("api_key_id") for e in events} == {key.id}


async def test_a_key_request_never_rides_a_browser_session(client, db_session):
    """Cookies are dropped from a key request: someone else's session riding
    along neither widens it nor is touched by it."""
    other = create_access_token(
        user_id=OTHER, email=f"{OTHER}@example.com", role="workspace_member",
        extra={"sid": "sess_other"},
    )
    key = await mint(db_session, views="read")
    cookies = {ACCESS_COOKIE_NAME: other}

    # The other person's own private view: their session would open it.
    theirs = await client.get("/api/v1/views/v_a_theirs", headers=key.headers, cookies=cookies)
    assert theirs.status_code in (403, 404)

    # A route that reads the session cookie itself: the cookie alone signs
    # the other person in, and beside a key it is simply not there.
    alone = await client.get("/api/v1/auth/me", cookies=cookies)
    assert alone.status_code == 200 and OTHER in alone.text
    me = await client.get("/api/v1/auth/me", headers=key.headers, cookies=cookies)
    assert me.status_code == 401 and OTHER not in me.text


async def test_a_key_write_from_a_foreign_page_is_refused(client, db_session):
    key = await mint(db_session, views="write")
    response = await client.put(
        "/api/v1/views/v_a_mine", json={"name": "x"},
        headers={**key.headers, "Origin": "https://evil.example"},
    )
    assert response.status_code == 403
    assert error(response) == "csrf_failed"


# ── Refused keys ────────────────────────────────────────────────────


async def _refused(client, headers, code):
    response = await client.get("/api/v1/views/v_a_mine", headers=headers)
    assert response.status_code == 401, response.text
    assert error(response) == code
    assert 'error="invalid_token"' in response.headers["www-authenticate"]
    return response


async def test_a_malformed_or_unknown_key_is_refused(client):
    await _refused(client, {"Authorization": "Bearer nxpat_nonsense"}, "invalid_api_key")
    stranger = api_keys.generate().token
    await _refused(client, {"Authorization": f"Bearer {stranger}"}, "invalid_api_key")


async def test_an_invalid_key_is_refused_even_where_anonymous_is_fine(client):
    """``GET /views/{id}`` serves anonymous callers; a bad key is still a 401,
    never a quiet fall back to anonymous."""
    stranger = api_keys.generate().token
    response = await client.get(
        "/api/v1/views/v_a_ws", headers={"Authorization": f"Bearer {stranger}"},
    )
    assert response.status_code == 401


async def test_revoked_and_expired_keys_are_refused(client, db_session):
    revoked = await mint(db_session, views="read")
    await api_key_repo.revoke(db_session, revoked.id, by=OWNER, reason="owner")
    await db_session.commit()
    await _refused(client, revoked.headers, "api_key_revoked")

    expired = await mint(db_session, views="read", expires_at=days_ago(1))
    await _refused(client, expired.headers, "api_key_expired")


async def test_the_maximum_lifetime_applies_to_keys_that_already_exist(client, db_session):
    key = await mint(db_session, views="read")
    (await db_session.get(ApiKeyORM, key.id)).created_at = days_ago(40)
    await db_session.commit()
    assert (await client.get("/api/v1/views/v_a_mine", headers=key.headers)).status_code == 200
    prime(apiKeyMaxLifetime="30")
    await _refused(client, key.headers, "api_key_expired")


async def test_a_suspended_owners_keys_stop_at_once(client, db_session):
    key = await mint(db_session, views="read")
    (await db_session.get(UserORM, OWNER)).status = "suspended"
    await db_session.commit()
    await _refused(client, key.headers, "api_key_owner_inactive")


async def test_an_sso_owner_who_stops_signing_in_has_their_keys_paused(client, db_session):
    db_session.add(user_row("usr_sso", password=False))
    db_session.add(RoleBindingORM(
        subject_type="user", subject_id="usr_sso", role_name="workspace_member",
        scope_type="workspace", scope_id="ws_a",
    ))
    identity = UserIdentityORM(
        user_id="usr_sso", provider_id="idp_corp", external_id="sub-1",
        last_login_at=days_ago(40),
    )
    db_session.add(identity)
    await db_session.commit()
    key = await mint(db_session, "usr_sso", views="read")

    await _refused(client, key.headers, "owner_reauth_required")

    # Signing in again resumes the key; nothing was revoked.
    identity.last_login_at = days_ago(1)
    await db_session.commit()
    assert (await client.get("/api/v1/views/v_a_ws", headers=key.headers)).status_code == 200

    # And the window is the admin's to choose.
    identity.last_login_at = days_ago(40)
    await db_session.commit()
    prime(apiKeySsoSignInWindow="off")
    assert (await client.get("/api/v1/views/v_a_ws", headers=key.headers)).status_code == 200


async def test_an_owner_nobody_can_sign_in_as_has_no_working_keys(client, db_session):
    db_session.add(user_row("usr_nobody", password=False))
    await db_session.commit()
    key = await mint(db_session, "usr_nobody", views="read")
    await _refused(client, key.headers, "owner_reauth_required")


async def test_a_key_limited_to_networks_is_refused_elsewhere(client, db_session):
    # The test transport connects from 127.0.0.1.
    outside = await mint(db_session, views="read", allowed_cidrs=["10.0.0.0/8"])
    await _refused(client, outside.headers, "api_key_ip_not_allowed")
    inside = await mint(db_session, views="read", allowed_cidrs=["127.0.0.0/8"])
    assert (await client.get("/api/v1/views/v_a_mine", headers=inside.headers)).status_code == 200


async def test_a_revoked_key_presented_again_is_misuse_recorded_once_and_told_to_its_owner(
    client, db_session,
):
    key = await mint(db_session, views="read")
    await api_key_repo.revoke(db_session, key.id, by=OWNER, reason="owner")
    await db_session.commit()
    for _ in range(3):
        await _refused(client, key.headers, "api_key_revoked")

    events = (await db_session.execute(
        select(OutboxEventORM).where(OutboxEventORM.event_type == "identity.api_key.misuse")
    )).scalars().all()
    assert len(events) == 1, "sampled: one record per key, reason and hour"
    assert events[0].aggregate_type == "user" and events[0].aggregate_id == OWNER
    payload = json.loads(events[0].payload)
    assert payload["key_id"] == key.id and payload["reason"] == "revoked"
    assert key.token not in events[0].payload

    notes = (await db_session.execute(
        select(NotificationORM).where(NotificationORM.user_id == OWNER)
    )).scalars().all()
    assert [n.kind for n in notes] == ["api_key_misuse"]


async def test_a_lookup_that_cannot_answer_is_503_never_401(client, db_session, monkeypatch):
    key = await mint(db_session, views="read")

    async def _down(*_args, **_kwargs):
        raise OperationalError("SELECT", {}, Exception("connection refused"))

    monkeypatch.setattr(api_key_repo, "find_for_auth", _down)
    response = await client.get("/api/v1/views/v_a_mine", headers=key.headers)
    assert response.status_code == 503
    assert response.headers.get("retry-after")


async def test_switching_keys_off_stops_every_key(client, db_session):
    key = await mint(db_session, views="read")
    prime(apiKeysEnabled=False)
    await _refused(client, key.headers, "api_keys_disabled")


async def test_no_key_is_honoured_while_authorization_is_switched_off(
    client, db_session, monkeypatch,
):
    key = await mint(db_session, views="read")
    monkeypatch.setenv("RBAC_ENFORCE_VIEWS", "false")
    response = await client.get("/api/v1/views/v_a_mine", headers=key.headers)
    assert response.status_code == 503


# ── The surface ─────────────────────────────────────────────────────


async def test_endpoints_off_the_surface_are_refused(client, db_session):
    key = await mint(db_session, views="write", data="write")
    for path in ("/api/v1/users/me", "/api/v1/admin/users", "/api/v1/views/audience"):
        response = await client.get(path, headers=key.headers)
        assert response.status_code == 403, path
        assert error(response) == "api_key_not_allowed", path
        assert 'error="insufficient_scope"' in response.headers["www-authenticate"]


async def test_a_read_only_key_only_reads(client, db_session):
    key = await mint(db_session, views="read", data="read")
    response = await client.put("/api/v1/views/v_a_mine", json={"name": "x"}, headers=key.headers)
    assert response.status_code == 403
    assert error(response) == "api_key_read_only"
    create = await client.post(
        "/api/v1/ws_a/graph/nodes/create?dataSourceId=ds_a", json={}, headers=key.headers,
    )
    assert error(create) == "api_key_read_only"
    # A search is a POST that changes nothing: through every gate.
    search = await client.post(
        "/api/v1/ws_a/graph/search?dataSourceId=ds_a", json={"query": "orders"},
        headers=key.headers,
    )
    assert search.status_code == 418, search.text


# ── Views: honoured by every path, held to the selection ────────────


async def test_a_key_on_one_granted_view_edits_that_view_and_nothing_else(client, db_session):
    """A workspace viewer with an editor grant on one view: a key limited to
    that view edits it — and reaches nothing else in the workspace."""
    key = await mint(db_session, views="write", resources={"views": ["v_b_granted"]})

    assert (await client.get("/api/v1/views/v_b_granted", headers=key.headers)).status_code == 200
    edit = await client.put(
        "/api/v1/views/v_b_granted", json={"description": "kept current by CI"},
        headers=key.headers,
    )
    assert edit.status_code == 200, edit.text

    sibling = await client.get("/api/v1/views/v_b_other", headers=key.headers)
    assert sibling.status_code == 403 and error(sibling) == "api_key_out_of_scope"

    listed = await client.get("/api/v1/views/", headers=key.headers)
    assert listed.status_code == 200
    assert [v["id"] for v in listed.json()["items"]] == ["v_b_granted"]

    created = await client.post(
        "/api/v1/views/",
        json={"name": "new", "workspaceId": "ws_b", "viewType": "graph", "config": {}},
        headers=key.headers,
    )
    assert created.status_code == 403


async def test_the_workspace_feed_needs_the_whole_workspace(client, db_session):
    key = await mint(db_session, views="read", resources={"views": ["v_a_ws"]})
    response = await client.get("/api/v1/views/workspace/ws_a/activity", headers=key.headers)
    assert response.status_code == 403 and error(response) == "api_key_out_of_scope"


# ── Data: the capability gate, held to the selection ────────────────


async def test_a_key_on_one_data_source_must_name_it(client, db_session):
    key = await mint(db_session, data="read", resources={"dataSources": ["ds_a"]})

    ok = await client.get("/api/v1/ws_a/graph/stats?dataSourceId=ds_a", headers=key.headers)
    assert ok.status_code == 200, ok.text

    # The workspace's primary is not this key's to assume…
    unnamed = await client.get("/api/v1/ws_a/graph/stats", headers=key.headers)
    assert unnamed.status_code == 403 and error(unnamed) == "api_key_out_of_scope"

    # …and a sibling source in the same workspace stays closed, although the
    # owner's role reads it and the key's claims hold the workspace.
    sibling = await client.get("/api/v1/ws_a/graph/stats?dataSourceId=ds_a2", headers=key.headers)
    assert sibling.status_code == 403 and error(sibling) == "api_key_out_of_scope"


async def test_a_view_key_reads_its_views_data_and_only_that(client, db_session):
    key = await mint(db_session, views="read", resources={"views": ["v_a_ws"]})
    through = "/api/v1/ws_a/graph/stats?viewId=v_a_ws"

    assert (await client.get(f"{through}&dataSourceId=ds_a", headers=key.headers)).status_code == 200
    other = await client.get(f"{through}&dataSourceId=ds_a2", headers=key.headers)
    assert other.status_code == 403 and error(other) == "api_key_out_of_scope"


async def test_writing_data_needs_the_source_itself_not_a_view_of_it(client, db_session):
    key = await mint(
        db_session, views="read", data="write",
        resources={"views": ["v_a_ws"], "dataSources": ["ds_a2"]},
    )
    write = "/api/v1/ws_a/graph/nodes/create"
    # Through the view: refused, a view opens reads only.
    through_view = await client.post(
        f"{write}?viewId=v_a_ws&dataSourceId=ds_a", json={}, headers=key.headers,
    )
    assert through_view.status_code == 403 and error(through_view) == "api_key_out_of_scope"
    # On the source the key covers: through every gate to the handler.
    covered = await client.post(f"{write}?dataSourceId=ds_a2", json={}, headers=key.headers)
    assert covered.status_code == 418, covered.text


async def test_a_resource_named_against_the_wrong_workspace_is_not_found(client, db_session):
    key = await mint(db_session, views="read", data="read")
    response = await client.get("/api/v1/ws_b/graph/stats?dataSourceId=ds_a", headers=key.headers)
    assert response.status_code == 404


async def test_a_graph_is_held_to_the_key_by_its_data_source(client, db_session):
    key = await mint(db_session, data="read", resources={"dataSources": ["ds_a"]})
    mine = await client.get("/api/v1/ws_a/versioning/graphs/g_a", headers=key.headers)
    assert mine.status_code == 200, mine.text
    sibling = await client.get("/api/v1/ws_a/versioning/graphs/g_a2", headers=key.headers)
    assert sibling.status_code == 403 and error(sibling) == "api_key_out_of_scope"


# ── A key's claims follow its owner ─────────────────────────────────


async def test_losing_a_role_reaches_the_key_on_the_next_request(client, db_session):
    key = await mint(db_session, views="read")
    assert (await client.get("/api/v1/views/v_a_ws", headers=key.headers)).status_code == 200

    await db_session.execute(delete(RoleBindingORM).where(
        RoleBindingORM.subject_id == OWNER, RoleBindingORM.scope_id == "ws_a",
    ))
    await db_session.commit()
    # What any change to a person's roles already does to their sessions.
    await get_revocation_service().revoke_all_user_sessions(OWNER)

    assert (await client.get("/api/v1/views/v_a_ws", headers=key.headers)).status_code in (403, 404)


# ── Limits, records, headers ────────────────────────────────────────


async def test_a_key_has_its_own_rate_limit(client, db_session, monkeypatch):
    monkeypatch.setattr(api_key_auth, "RATELIMIT_API_KEY", "2/minute")
    key = await mint(db_session, views="read")
    for _ in range(2):
        assert (await client.get("/api/v1/views/v_a_mine", headers=key.headers)).status_code == 200
    limited = await client.get("/api/v1/views/v_a_mine", headers=key.headers)
    assert limited.status_code == 429
    assert int(limited.headers["retry-after"]) >= 1
    # Another key is not held back by this one.
    other = await mint(db_session, views="read")
    assert (await client.get("/api/v1/views/v_a_mine", headers=other.headers)).status_code == 200


async def test_the_access_log_names_the_key_and_never_the_token(client, db_session, caplog):
    key = await mint(db_session, views="read")
    with caplog.at_level(logging.INFO):
        response = await client.get("/api/v1/views/v_a_mine", headers=key.headers)
    assert response.status_code == 200
    access = [r for r in caplog.records if r.name == "synodic.access"]
    assert access and access[-1].authMethod == "api_key"
    assert access[-1].apiKeyId == key.id and access[-1].userId == OWNER
    for record in caplog.records:
        assert key.token not in record.getMessage()
        assert key.token not in json.dumps(record.__dict__, default=str)


async def test_a_client_can_see_its_keys_expiry_coming(client, db_session):
    expires = (datetime.now(timezone.utc) + timedelta(days=10)).isoformat()
    key = await mint(db_session, views="read", expires_at=expires)
    response = await client.get("/api/v1/views/v_a_mine", headers=key.headers)
    assert response.headers["x-api-key-expires-at"] == expires


async def test_use_is_stamped_on_the_key_not_on_the_person(client, db_session):
    key = await mint(db_session, views="read")
    assert (await client.get("/api/v1/views/v_a_mine", headers=key.headers)).status_code == 200
    row = await db_session.get(ApiKeyORM, key.id)
    await db_session.refresh(row)
    assert row.last_used_at and row.last_used_ip == "127.0.0.1"
    owner = await db_session.get(UserORM, OWNER)
    await db_session.refresh(owner)
    assert owner.last_seen_at is None


# ── Imports that name a view ────────────────────────────────────────


async def test_an_import_may_only_name_a_view_the_caller_can_edit(client, db_session):
    """Pre-existing, for people too: an import's ``viewId`` has the worker
    write into that view's layout, and the view was never checked."""
    imports = "/api/v1/ws_a/versioning/graphs/g_a/imports"
    # May change data, not views: an import may not rewrite a view for it.
    data_only = await mint(db_session, views="read", data="write")
    refused = await client.post(f"{imports}?viewId=v_a_mine", content=b"", headers=data_only.headers)
    assert refused.status_code == 403, refused.text

    full = await mint(db_session, views="write", data="write")
    elsewhere = await client.post(f"{imports}?viewId=v_b_other", content=b"", headers=full.headers)
    assert elsewhere.status_code == 404
    mine = await client.post(f"{imports}?viewId=v_a_mine", content=b"", headers=full.headers)
    assert mine.status_code == 418, mine.text


async def test_the_import_view_check_holds_for_a_browser_session_too(client, db_session):
    from types import SimpleNamespace

    from backend.app.api.v1.endpoints.versioning import _check_import_view
    from backend.app.services.permission_service import resolve

    owner = SimpleNamespace(id=OWNER)
    claims = await resolve(db_session, OWNER)
    with pytest.raises(HTTPException) as other_workspace:
        await _check_import_view(db_session, "ws_a", "v_b_other", owner, claims)
    assert other_workspace.value.status_code == 404
    # Only a viewer in ws_b, with no grant on this view.
    with pytest.raises(HTTPException) as not_editable:
        await _check_import_view(db_session, "ws_b", "v_b_other", owner, claims)
    assert not_editable.value.status_code == 403
    # An editor grant is enough.
    await _check_import_view(db_session, "ws_b", "v_b_granted", owner, claims)


def test_single_flight_never_shares_a_keys_answer_with_its_owners_session():
    from types import SimpleNamespace

    from backend.app.api.v1.endpoints.views import _flight_principal
    from backend.app.services.permission_service import PermissionClaims, key_scope_from_profile

    user = SimpleNamespace(id=OWNER)
    session_claims = PermissionClaims(sid="s1", global_perms=(), ws_perms={})
    key_claims = PermissionClaims(
        sid="", global_perms=(), ws_perms={},
        key_scope=key_scope_from_profile(
            "apk_1", kind="personal", permissions={"views": "read"}, resources="all",
        ),
    )
    assert _flight_principal(user, session_claims) != _flight_principal(user, key_claims)
