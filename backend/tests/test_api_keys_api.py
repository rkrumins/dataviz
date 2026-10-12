"""Managing API keys: minting one as yourself, seeing it once, and ending it.

The owner's pages run on a browser session (cookie + bound CSRF token); the
key's own ``/api-keys/self`` runs on the key; the inventory runs on an
administrator. The world and the script's-eye client are shared with
``test_api_key_auth`` (``tests/common/api_key_world.py``).
"""
from __future__ import annotations

import json
import time
from datetime import datetime, timedelta, timezone

import pytest
from sqlalchemy import select

from backend.app.api.v1.endpoints import api_keys as api_keys_endpoints
from backend.app.db.models import (
    ApiKeyORM,
    IdpProviderORM,
    NotificationORM,
    OutboxEventORM,
    UserIdentityORM,
    UserORM,
)
from backend.app.db.repositories import api_key_repo
from backend.app.services import api_key_housekeeping
from backend.auth_service.cookies import ACCESS_COOKIE_NAME, CSRF_COOKIE_NAME
from backend.auth_service.core.password import hash_password
from backend.auth_service.core.tokens import create_access_token
from backend.auth_service.csrf import CSRF_HEADER_NAME, mint_csrf_token
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

PASSWORD = "correct horse battery staple"


@pytest.fixture()
async def client(db_session, monkeypatch):
    api_keys_endpoints.limiter.reset()
    async with api_key_app(db_session, monkeypatch) as http:
        owner = await db_session.get(UserORM, OWNER)
        owner.password_hash = hash_password(PASSWORD)
        await db_session.commit()
        yield http
    api_keys_endpoints.limiter.reset()


def _sign_in(client, user_id: str = OWNER, *, signin: str = "password",
             auth_time: int | None = None) -> dict:
    """A browser session for ``user_id``: its cookies on the client, and the
    CSRF header its writes carry."""
    sid = f"sess_{user_id}_{signin}"
    extra = {"sid": sid, "signin": signin}
    if auth_time is not None:
        extra["auth_time"] = auth_time
    client.cookies.set(ACCESS_COOKIE_NAME, create_access_token(
        user_id=user_id, email=f"{user_id}@example.com", role="workspace_member",
        extra=extra,
    ))
    csrf = mint_csrf_token(sid)
    client.cookies.set(CSRF_COOKIE_NAME, csrf)
    return {CSRF_HEADER_NAME: csrf}


def _in(days: int) -> str:
    return (datetime.now(timezone.utc) + timedelta(days=days)).isoformat()


def _body(**overrides) -> dict:
    body = {
        "name": "nightly sync",
        "permissions": {"views": "read", "data": "none"},
        "resources": "all",
        "expiresAt": _in(30),
        "currentPassword": PASSWORD,
    }
    body.update(overrides)
    return body


async def _create(client, headers, **overrides):
    return await client.post("/api/v1/me/api-keys", json=_body(**overrides), headers=headers)


# ── Minting and seeing it once ──────────────────────────────────────


async def test_a_key_is_shown_once_and_acts_as_its_owner(client, db_session):
    headers = _sign_in(client)
    created = await _create(client, headers)
    assert created.status_code == 201, created.text
    assert created.headers["cache-control"] == "no-store"
    token = created.json()["token"]
    key = created.json()["key"]
    assert token.startswith("nxpat_") and key["prefix"] == token[:14]
    assert key["status"] == "active"

    listed = await client.get("/api/v1/me/api-keys")
    detail = await client.get(f"/api/v1/me/api-keys/{key['id']}")
    for response in (listed, detail):
        assert response.status_code == 200
        assert token not in response.text
        assert "tokenHash" not in response.text and "token_hash" not in response.text
    row = await db_session.get(ApiKeyORM, key["id"])
    assert row.token_hash != token and token not in (row.token_prefix, row.token_hash)

    client.cookies.clear()
    used = await client.get(
        "/api/v1/views/v_a_mine", headers={"Authorization": f"Bearer {token}"},
    )
    assert used.status_code == 200, used.text


async def test_revoking_ends_a_key_at_once(client, db_session):
    headers = _sign_in(client)
    created = (await _create(client, headers)).json()
    revoked = await client.delete(f"/api/v1/me/api-keys/{created['key']['id']}", headers=headers)
    assert revoked.status_code == 204
    client.cookies.clear()
    refused = await client.get(
        "/api/v1/views/v_a_mine", headers={"Authorization": f"Bearer {created['token']}"},
    )
    assert refused.status_code == 401 and error(refused) == "api_key_revoked"


# ── Step-up ─────────────────────────────────────────────────────────


async def test_minting_with_a_password_session_needs_the_password(client, monkeypatch):
    monkeypatch.setattr(api_keys_endpoints, "RATELIMIT_LOGIN_PER_ACCOUNT", "2 per 15 minutes")
    headers = _sign_in(client)
    missing = await _create(client, headers, currentPassword=None)
    assert missing.status_code == 403
    assert missing.json()["detail"] == {
        "error": "step_up_required", "method": "password",
        "message": "Enter your password to confirm it's you.",
    }
    wrong = await _create(client, headers, currentPassword="not it")
    assert wrong.status_code == 403 and error(wrong) == "step_up_failed"
    await _create(client, headers, currentPassword="still not it")
    # Counted per account, so even the right password waits now.
    limited = await _create(client, headers)
    assert limited.status_code == 429


async def test_an_sso_session_must_have_signed_in_recently(client, db_session):
    db_session.add(IdpProviderORM(
        id="idp_corp", slug="corp", display_name="Corp", kind="oidc",
        settings="{}", linking_policy="strict",
    ))
    db_session.add(UserIdentityORM(
        user_id=OWNER, provider_id="idp_corp", external_id="sub-owner",
        last_login_at=days_ago(0),
    ))
    await db_session.commit()

    stale = _sign_in(client, signin="sso", auth_time=int(time.time()) - 3600)
    refused = await _create(client, stale, currentPassword=None)
    assert refused.status_code == 403
    detail = refused.json()["detail"]
    assert detail["error"] == "step_up_required" and detail["method"] == "sso"
    assert detail["loginUrl"] == "/api/v1/auth/corp/login?next=/me/api-keys&force=1"

    fresh = _sign_in(client, signin="sso", auth_time=int(time.time()) - 60)
    assert (await _create(client, fresh, currentPassword=None)).status_code == 201


# ── What a key may be given ─────────────────────────────────────────


async def test_someone_elses_key_is_not_found(client, db_session):
    theirs = await mint(db_session, OTHER, views="read")
    headers = _sign_in(client)
    assert (await client.get(f"/api/v1/me/api-keys/{theirs.id}")).status_code == 404
    rotated = await client.post(
        f"/api/v1/me/api-keys/{theirs.id}/rotate",
        json={"currentPassword": PASSWORD}, headers=headers,
    )
    assert rotated.status_code == 404
    assert (await client.delete(f"/api/v1/me/api-keys/{theirs.id}", headers=headers)).status_code == 404
    assert (await db_session.get(ApiKeyORM, theirs.id)).revoked_at is None


@pytest.mark.parametrize("overrides, says", [
    ({"permissions": {"views": "none", "data": "none"}}, "do something"),
    ({"permissions": {"views": "read", "publish": True}}, "Publishing"),
    ({"resources": {"workspaces": [], "views": [], "dataSources": []}}, "at least one"),
    ({"expiresAt": None}, "Choose when"),
    ({"expiresAt": _in(-1)}, "future"),
    ({"neverExpires": True}, "not both"),
    ({"allowedCidrs": ["not-a-network"]}, "not an address"),
])
async def test_a_key_must_say_what_it_may_do_and_until_when(client, overrides, says):
    headers = _sign_in(client)
    response = await _create(client, headers, **overrides)
    assert response.status_code == 422, response.text
    assert says in response.json()["detail"]["message"]


async def test_a_key_can_only_be_given_what_its_owner_reaches(client):
    headers = _sign_in(client)
    response = await _create(
        client, headers,
        resources={"views": ["v_a_theirs", "v_b_granted"], "dataSources": ["ds_nope", "ds_b"]},
    )
    assert response.status_code == 422
    # A private view of someone else's, and a source that does not exist —
    # but the granted view and a source the owner reads as a viewer are fine.
    assert response.json()["detail"]["unknown"] == {
        "views": ["v_a_theirs"], "dataSources": ["ds_nope"],
    }


async def test_expiry_is_a_choice_inside_the_deployments_policy(client):
    headers = _sign_in(client)
    never = await _create(client, headers, expiresAt=None, neverExpires=True)
    assert never.status_code == 201 and never.json()["key"]["expiresAt"] is None

    prime(apiKeyMaxLifetime="30")
    assert (await _create(client, headers, expiresAt=None, neverExpires=True)).status_code == 422
    assert (await _create(client, headers, expiresAt=_in(60))).status_code == 422
    assert (await _create(client, headers, expiresAt=_in(20))).status_code == 201
    # The cap reaches the key made before it, too.
    listed = (await client.get("/api/v1/me/api-keys")).json()
    capped = next(k for k in listed if k["id"] == never.json()["key"]["id"])
    assert capped["expiresAt"] is not None


async def test_a_person_holds_a_bounded_number_of_keys(client, monkeypatch):
    monkeypatch.setattr(api_keys_endpoints, "MAX_ACTIVE_KEYS", 1)
    headers = _sign_in(client)
    assert (await _create(client, headers)).status_code == 201
    second = await _create(client, headers)
    assert second.status_code == 409 and error(second) == "too_many_api_keys"


async def test_switching_keys_off_stops_minting_but_never_revoking(client, db_session):
    existing = await mint(db_session, views="read")
    headers = _sign_in(client)
    prime(apiKeysEnabled=False)
    refused = await _create(client, headers)
    assert refused.status_code == 403 and error(refused) == "api_keys_disabled"
    assert (await client.delete(f"/api/v1/me/api-keys/{existing.id}", headers=headers)).status_code == 204


# ── Rotation ────────────────────────────────────────────────────────


async def test_rotating_with_no_grace_ends_the_old_key_at_once(client):
    headers = _sign_in(client)
    old = (await _create(client, headers, permissions={"views": "write", "data": "read"})).json()
    rotated = await client.post(
        f"/api/v1/me/api-keys/{old['key']['id']}/rotate",
        json={"currentPassword": PASSWORD}, headers=headers,
    )
    assert rotated.status_code == 200, rotated.text
    new = rotated.json()
    assert new["key"]["rotatedFrom"] == old["key"]["id"]
    assert new["key"]["permissions"] == old["key"]["permissions"]
    assert new["key"]["resources"] == old["key"]["resources"]

    client.cookies.clear()
    stale = await client.get("/api/v1/views/v_a_mine", headers={"Authorization": f"Bearer {old['token']}"})
    assert stale.status_code == 401
    fresh = await client.get("/api/v1/views/v_a_mine", headers={"Authorization": f"Bearer {new['token']}"})
    assert fresh.status_code == 200


async def test_rotating_with_grace_keeps_the_old_key_for_the_overlap_only(client, db_session):
    headers = _sign_in(client)
    old = (await _create(client, headers, expiresAt=None, neverExpires=True)).json()
    rotated = await client.post(
        f"/api/v1/me/api-keys/{old['key']['id']}/rotate",
        json={"currentPassword": PASSWORD, "graceSeconds": 3600}, headers=headers,
    )
    assert rotated.status_code == 200
    # A key that never expired is replaced by one that never expires.
    assert rotated.json()["key"]["expiresAt"] is None
    row = await db_session.get(ApiKeyORM, old["key"]["id"])
    await db_session.refresh(row)
    remaining = datetime.fromisoformat(row.expires_at) - datetime.now(timezone.utc)
    assert timedelta(minutes=55) < remaining <= timedelta(hours=1)
    client.cookies.clear()
    still = await client.get("/api/v1/views/v_a_mine", headers={"Authorization": f"Bearer {old['token']}"})
    assert still.status_code == 200


# ── What a key can do, shown before and after ───────────────────────


async def test_the_detail_shows_what_the_key_can_do_right_now(client, db_session):
    headers = _sign_in(client)
    created = await _create(
        client, headers,
        permissions={"views": "write", "data": "write"},
        resources={"views": ["v_b_granted"], "dataSources": ["ds_a"]},
    )
    assert created.status_code == 201, created.text
    detail = (await client.get(f"/api/v1/me/api-keys/{created.json()['key']['id']}")).json()
    access = detail["effectiveAccess"]
    assert access["views"] == [{
        "id": "v_b_granted", "name": "v_b_granted", "workspaceId": "ws_b", "level": "write",
    }]
    assert [(d["id"], d["level"]) for d in access["dataSources"]] == [("ds_a", "write")]
    by_ws = {w["id"]: w for w in access["workspaces"]}
    # Only a viewer in ws_b: the grant, not the workspace, is what edits the view.
    assert by_ws["ws_b"]["views"] == "read" and by_ws["ws_a"]["data"] == "write"


async def test_the_pickers_offer_everything_the_owner_reaches_with_their_level(client):
    _sign_in(client)
    views = (await client.get("/api/v1/me/api-keys/resources?type=view")).json()
    levels = {v["id"]: v["level"] for v in views}
    assert levels["v_b_granted"] == "write"      # through the editor grant
    assert levels["v_b_other"] == "read"         # a viewer in ws_b
    assert levels["v_a_ws"] == "write"           # a member in ws_a
    assert "v_a_theirs" not in levels            # private to someone else: not readable
    sources = {
        d["id"]: d["level"]
        for d in (await client.get("/api/v1/me/api-keys/resources?type=data_source")).json()
    }
    assert sources == {"ds_a": "write", "ds_a2": "write", "ds_b": "read"}


async def test_the_options_say_how_to_confirm_and_what_is_in_reach(client):
    _sign_in(client)
    options = (await client.get("/api/v1/me/api-keys/options")).json()
    assert options["stepUp"] == {"method": "password", "fresh": False}
    assert options["policy"]["enabled"] is True and options["policy"]["ssoSignInWindowDays"] == 30
    by_ws = {w["id"]: (w["views"], w["data"]) for w in options["workspaces"]}
    assert by_ws == {"ws_a": ("write", "write"), "ws_b": ("read", "read")}


# ── A key on itself ─────────────────────────────────────────────────


async def test_a_key_can_describe_and_end_itself_whatever_its_state(client, db_session):
    expired = await mint(db_session, views="read", expires_at=days_ago(1))
    described = await client.get("/api/v1/api-keys/self", headers=expired.headers)
    assert described.status_code == 200, described.text
    assert described.json()["status"] == "expired" and described.json()["id"] == expired.id

    # A read-only key may still end itself.
    ended = await client.delete("/api/v1/api-keys/self", headers=expired.headers)
    assert ended.status_code == 204
    assert (await client.get("/api/v1/api-keys/self", headers=expired.headers)).status_code == 401
    row = await db_session.get(ApiKeyORM, expired.id)
    await db_session.refresh(row)
    assert row.revoked_reason == "self"


async def test_a_paused_key_cannot_act_but_can_end_itself(client, db_session):
    paused = await mint(db_session, views="read", allowed_cidrs=["10.0.0.0/8"])
    assert (await client.get("/api/v1/views/v_a_mine", headers=paused.headers)).status_code == 401
    described = await client.get("/api/v1/api-keys/self", headers=paused.headers)
    assert described.json()["status"] == "ip_not_allowed"
    assert (await client.delete("/api/v1/api-keys/self", headers=paused.headers)).status_code == 204


async def test_the_self_endpoints_are_for_keys(client):
    _sign_in(client)
    response = await client.get("/api/v1/api-keys/self")
    assert response.status_code == 401


# ── On the record ───────────────────────────────────────────────────


async def test_the_lifecycle_is_on_the_owners_record(client, db_session):
    headers = _sign_in(client)
    created = (await _create(client, headers)).json()
    rotated = (await client.post(
        f"/api/v1/me/api-keys/{created['key']['id']}/rotate",
        json={"currentPassword": PASSWORD}, headers=headers,
    )).json()
    await client.delete(f"/api/v1/me/api-keys/{rotated['key']['id']}", headers=headers)

    events = (await db_session.execute(
        select(OutboxEventORM).where(OutboxEventORM.event_type.like("identity.api_key.%"))
    )).scalars().all()
    assert sorted(e.event_type for e in events) == [
        "identity.api_key.created", "identity.api_key.revoked", "identity.api_key.rotated",
    ]
    assert {(e.aggregate_type, e.aggregate_id) for e in events} == {("user", OWNER)}
    for event in events:
        assert created["token"] not in event.payload and rotated["token"] not in event.payload

    activity = (await client.get("/api/v1/users/me/activity")).json()
    assert {"identity.api_key.created", "identity.api_key.rotated",
            "identity.api_key.revoked"} <= {item["eventType"] for item in activity}


# ── Administrators ──────────────────────────────────────────────────


async def test_administrators_see_and_revoke_everyones_keys(test_client, db_session):
    for uid in (OWNER, OTHER):
        db_session.add(user_row(uid))
    await db_session.commit()
    mine = await mint(db_session, OWNER, views="read", name="owner key")
    theirs = await mint(db_session, OTHER, views="read", name="other key")

    listed = await test_client.get("/api/v1/admin/api-keys")
    assert listed.status_code == 200, listed.text
    body = listed.json()
    assert body["total"] == 2
    assert {item["owner"]["id"] for item in body["items"]} == {OWNER, OTHER}
    only = (await test_client.get(f"/api/v1/admin/api-keys?ownerId={OWNER}")).json()
    assert [item["id"] for item in only["items"]] == [mine.id]

    assert (await test_client.delete(f"/api/v1/admin/api-keys/{theirs.id}")).status_code == 204
    revoked = await db_session.get(ApiKeyORM, theirs.id)
    await db_session.refresh(revoked)
    assert revoked.revoked_reason == "admin"
    told = (await db_session.execute(
        select(NotificationORM).where(NotificationORM.user_id == OTHER)
    )).scalars().all()
    assert [n.kind for n in told] == ["api_key_revoked_by_admin"]

    await mint(db_session, OWNER, views="read")
    everything = await test_client.post(f"/api/v1/admin/users/{OWNER}/api-keys/revoke-all")
    assert everything.status_code == 200 and everything.json() == {"revoked": 2}
    assert (await test_client.get("/api/v1/admin/api-keys?status=active")).json()["total"] == 0


# ── Expiry reminders ────────────────────────────────────────────────


async def test_owners_hear_a_week_ahead_once_and_not_for_short_lived_keys(db_session):
    db_session.add(user_row(OWNER))
    await db_session.commit()
    soon = await mint(db_session, views="read", name="soon",
                      expires_at=(datetime.now(timezone.utc) + timedelta(days=3)).isoformat())
    (await db_session.get(ApiKeyORM, soon.id)).created_at = days_ago(60)
    brief = await mint(db_session, views="read", name="brief",
                       expires_at=(datetime.now(timezone.utc) + timedelta(days=3)).isoformat())
    later = await mint(db_session, views="read", name="later",
                       expires_at=(datetime.now(timezone.utc) + timedelta(days=30)).isoformat())
    await db_session.commit()

    assert await api_key_housekeeping.remind_once(db_session) == 1
    assert await api_key_housekeeping.remind_once(db_session) == 0
    notes = (await db_session.execute(
        select(NotificationORM).where(NotificationORM.user_id == OWNER)
    )).scalars().all()
    assert [(n.kind, n.resource_id) for n in notes] == [("api_key_expiring", soon.id)]
    marked = {
        k.id: k.expiry_reminded_at
        for k in (await db_session.execute(select(ApiKeyORM))).scalars().all()
    }
    assert marked[soon.id] and marked[brief.id] and marked[later.id] is None
    events = (await db_session.execute(
        select(OutboxEventORM).where(OutboxEventORM.event_type == "identity.api_key.expiring")
    )).scalars().all()
    assert [json.loads(e.payload)["key_id"] for e in events] == [soon.id]
