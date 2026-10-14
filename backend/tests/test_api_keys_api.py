"""Managing API keys: minting one as yourself, seeing it once, and ending it.

The owner's pages run on a browser session (cookie + bound CSRF token); the
key's own ``/api-keys/self`` runs on the key; the inventory runs on an
administrator. The world and the script's-eye client are shared with
``test_api_key_auth`` (``tests/common/api_key_world.py``).
"""
from __future__ import annotations

import asyncio
import csv
import io
import json
import re
import time
from contextlib import asynccontextmanager
from datetime import datetime, timedelta, timezone

import pytest
from sqlalchemy import inspect as orm_state, select
from sqlalchemy.exc import InvalidRequestError

from backend.app.api.v1.endpoints import api_keys as api_keys_endpoints
from backend.app.db import engine as db_engine
from backend.app.db.models import (
    ApiKeyORM,
    IdpProviderORM,
    NotificationORM,
    OutboxEventORM,
    UserIdentityORM,
    UserORM,
)
from backend.app.db.repositories import api_key_repo, api_key_usage_repo, app_auth_config_repo
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
    world,
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
             auth_time: int | None = None, proven: bool = False) -> dict:
    """A browser session for ``user_id``: its cookies on the client, and the
    CSRF header its writes carry. ``proven``: the identity provider itself
    asserted ``auth_time``."""
    sid = f"sess_{user_id}_{signin}"
    extra = {"sid": sid, "signin": signin}
    if auth_time is not None:
        extra["auth_time"] = auth_time
        if proven:
            extra["auth_time_proven"] = True
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


async def _preview(client, headers, **overrides):
    draft = _body(**overrides)
    draft.pop("currentPassword")
    return await client.post("/api/v1/me/api-keys/preview", json=draft, headers=headers)


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


async def _passwords_off(db_session, *, window_open: bool = False) -> None:
    """Switch Passwords off, as an administrator enforcing single sign-on
    does — and, with ``window_open``, open the emergency window as one does
    while the identity provider is down."""
    await app_auth_config_repo.update_config(db_session, allow_local_login=False)
    if window_open:
        until = (datetime.now(timezone.utc) + timedelta(hours=2)).isoformat()
        await app_auth_config_repo.set_password_fallback(
            db_session, until=until, by=OTHER, reason="identity provider down",
        )
    await db_session.commit()


async def test_with_passwords_off_a_password_confirms_no_key(client, db_session, monkeypatch):
    """Only the Passwords switch makes a password a lasting way in. While it
    is off — even with the emergency window open, when people sign in with
    one for a few hours — a password session makes no key that would outlive
    the emergency: not created, rotated or renewed. Refused before the
    password is looked at, so a right one and a wrong one get the same
    answer, and nothing is counted against the account."""
    monkeypatch.setattr(api_keys_endpoints, "RATELIMIT_LOGIN_PER_ACCOUNT", "2 per 15 minutes")
    live = await mint(db_session, views="read")
    lapsed = await mint(db_session, views="read", expires_at=days_ago(1))
    headers = _sign_in(client)
    await _passwords_off(db_session, window_open=True)

    refusals = [
        await _create(client, headers),
        await _create(client, headers, currentPassword="not it"),
        await _create(client, headers, currentPassword="still not it"),
        await client.post(
            f"/api/v1/me/api-keys/{live.id}/rotate",
            json={"currentPassword": PASSWORD}, headers=headers,
        ),
    ]
    api_keys_endpoints.limiter.reset()
    refusals.append(await client.post(
        f"/api/v1/me/api-keys/{lapsed.id}/rotate",
        json={"currentPassword": PASSWORD}, headers=headers,
    ))
    for refused in refusals:
        assert refused.status_code == 403, refused.text
        detail = refused.json()["detail"]
        assert (detail["error"], detail["method"], detail["reason"]) == (
            "step_up_unavailable", "password", "passwords_off",
        )

    options = (await client.get("/api/v1/me/api-keys/options")).json()
    assert options["stepUp"] == {"method": "password", "fresh": False}
    assert (options["stepUpAvailable"], options["stepUpReason"]) == (False, "passwords_off")

    # Passwords back on: the same session, and nothing was held against it.
    await app_auth_config_repo.update_config(db_session, allow_local_login=True)
    await db_session.commit()
    assert (await _create(client, headers)).status_code == 201


async def _identity(db_session, kind: str) -> None:
    db_session.add(IdpProviderORM(
        id="idp_corp", slug="corp", display_name="Corp", kind=kind,
        settings="{}", linking_policy="strict",
    ))
    db_session.add(UserIdentityORM(
        user_id=OWNER, provider_id="idp_corp", external_id="sub-owner",
        last_login_at=days_ago(0),
    ))
    await db_session.commit()


async def test_with_passwords_off_a_proven_sso_sign_in_still_mints(client, db_session):
    await _identity(db_session, "oidc")
    await _passwords_off(db_session)
    fresh = _sign_in(client, signin="sso", auth_time=int(time.time()) - 60, proven=True)
    created = await _create(client, fresh, currentPassword=None)
    assert created.status_code == 201, created.text


async def test_an_sso_session_must_prove_a_recent_sign_in(client, db_session):
    await _identity(db_session, "oidc")

    stale = _sign_in(client, signin="sso", auth_time=int(time.time()) - 3600, proven=True)
    refused = await _create(client, stale, currentPassword=None)
    assert refused.status_code == 403
    detail = refused.json()["detail"]
    assert detail["error"] == "step_up_required" and detail["method"] == "sso"
    assert detail["loginUrl"] == "/api/v1/auth/corp/login?next=/me/api-keys&force=1"

    # Just signed in, but the provider didn't say when — a silent re-login
    # from a session it still held proves nothing, and signing in again
    # through the same provider would only do the same.
    silent = _sign_in(client, signin="sso", auth_time=int(time.time()) - 60)
    refused = await _create(client, silent, currentPassword=None)
    assert refused.status_code == 403 and error(refused) == "step_up_unavailable"

    # A sign-in dated in the future proves nothing about the last few minutes.
    ahead = _sign_in(client, signin="sso", auth_time=int(time.time()) + 3600, proven=True)
    refused = await _create(client, ahead, currentPassword=None)
    assert refused.status_code == 403 and error(refused) == "step_up_required"

    proven = _sign_in(client, signin="sso", auth_time=int(time.time()) - 60, proven=True)
    assert (await _create(client, proven, currentPassword=None)).status_code == 201


async def test_a_provider_that_cannot_prove_a_sign_in_needs_the_switch(client, db_session):
    await _identity(db_session, "custom")  # a gateway connection

    stale = _sign_in(client, signin="sso", auth_time=int(time.time()) - 3600)
    refused = await _create(client, stale, currentPassword=None)
    assert refused.status_code == 403 and error(refused) == "step_up_unavailable"
    assert "loginUrl" not in refused.json()["detail"]
    options = (await client.get("/api/v1/me/api-keys/options")).json()
    assert options["stepUpAvailable"] is False

    prime(apiKeySsoRoundTripStepUp=True)
    options = (await client.get("/api/v1/me/api-keys/options")).json()
    assert options["stepUpAvailable"] is True
    refused = await _create(client, stale, currentPassword=None)
    assert error(refused) == "step_up_required" and refused.json()["detail"]["loginUrl"]
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
    reply = await client.delete(f"/api/v1/me/api-keys/{theirs.id}", headers=headers)
    assert reply.status_code == 404
    assert (await db_session.get(ApiKeyORM, theirs.id)).revoked_at is None


@pytest.mark.parametrize("ask", [_create, _preview], ids=["create", "preview"])
@pytest.mark.parametrize("overrides, says", [
    ({"permissions": {"views": "none", "data": "none"}}, "do something"),
    ({"permissions": {"views": "read", "publish": True}}, "Publishing"),
    ({"resources": {"workspaces": [], "views": [], "dataSources": []}}, "at least one"),
    ({"expiresAt": None}, "Choose when"),
    ({"expiresAt": _in(-1)}, "future"),
    ({"neverExpires": True}, "not both"),
    ({"allowedCidrs": ["not-a-network"]}, "not an address"),
    ({"name": "   "}, "needs a name"),
    # Past the last day a date can hold, once moved to UTC.
    ({"expiresAt": "9999-12-31T23:00:00-05:00"}, "too far"),
])
async def test_a_key_must_say_what_it_may_do_and_until_when(client, ask, overrides, says):
    """A preview says no to exactly what creating says no to."""
    headers = _sign_in(client)
    response = await ask(client, headers, **overrides)
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


async def test_keeping_the_old_key_while_rotating_counts_toward_the_limit(client, monkeypatch):
    """A grace period keeps the old key working beside its replacement — one
    more live key for up to a week. At the limit, rotating outright still
    works; rotating with grace is refused like making one more key."""
    monkeypatch.setattr(api_keys_endpoints, "MAX_ACTIVE_KEYS", 1)
    headers = _sign_in(client)
    key = (await _create(client, headers)).json()["key"]
    rotate = f"/api/v1/me/api-keys/{key['id']}/rotate"
    kept = await client.post(rotate, json={"currentPassword": PASSWORD, "graceSeconds": 3600}, headers=headers)
    assert kept.status_code == 409 and error(kept) == "too_many_api_keys"
    assert "without a grace period" in kept.json()["detail"]["message"]
    outright = await client.post(rotate, json={"currentPassword": PASSWORD, "graceSeconds": 0}, headers=headers)
    assert outright.status_code == 200, outright.text


async def test_switching_keys_off_stops_minting_but_never_revoking(client, db_session):
    existing = await mint(db_session, views="read")
    headers = _sign_in(client)
    prime(apiKeysEnabled=False)
    refused = await _create(client, headers)
    assert refused.status_code == 403 and error(refused) == "api_keys_disabled"
    reply = await client.delete(f"/api/v1/me/api-keys/{existing.id}", headers=headers)
    assert reply.status_code == 204


async def test_an_expiry_is_kept_in_utc_whatever_offset_it_came_in(client, db_session):
    """Expiries are compared as text, and only one offset compares right."""
    headers = _sign_in(client)
    local = (datetime.now(timezone(timedelta(hours=2))) + timedelta(days=10)).replace(microsecond=0)
    created = await _create(client, headers, expiresAt=local.isoformat())
    assert created.status_code == 201, created.text
    row = await db_session.get(ApiKeyORM, created.json()["key"]["id"])
    assert row.expires_at == local.astimezone(timezone.utc).isoformat()


# ── Before a key exists ─────────────────────────────────────────────


async def test_a_preview_shows_what_a_key_would_do_and_makes_nothing(client, db_session):
    headers = _sign_in(client)
    preview = await _preview(
        client, headers, permissions={"views": "write", "data": "read"},
        resources={"views": ["v_b_granted"], "dataSources": ["ds_a"]},
        allowedCidrs=["10.1.2.3", "10.1.2.3/32"],
    )
    assert preview.status_code == 200, preview.text
    body = preview.json()
    assert body["allowedCidrs"] == ["10.1.2.3/32"]
    assert body["expiresAt"].endswith("+00:00")
    access = body["effectiveAccess"]
    assert [(v["id"], v["level"]) for v in access["views"]] == [("v_b_granted", "write")]
    assert [(d["id"], d["level"]) for d in access["dataSources"]] == [("ds_a", "read")]
    assert (body["activeKeys"], body["maxActiveKeys"]) == (0, api_keys_endpoints.MAX_ACTIVE_KEYS)

    assert (await db_session.execute(select(ApiKeyORM))).scalars().all() == []
    assert (await db_session.execute(
        select(OutboxEventORM).where(OutboxEventORM.event_type.like("identity.api_key.%"))
    )).scalars().all() == []
    # Nothing is made, so there is nothing to prove: a password is refused
    # rather than taken somewhere it is not needed.
    with_password = await client.post("/api/v1/me/api-keys/preview", json=_body(), headers=headers)
    assert with_password.status_code == 422


# ── What a key is called ────────────────────────────────────────────


async def test_a_key_can_be_renamed_and_described_but_never_widened(client, db_session):
    headers = _sign_in(client)
    key = (await _create(client, headers)).json()["key"]
    url = f"/api/v1/me/api-keys/{key['id']}"

    renamed = await client.patch(
        url, json={"name": "  nightly export ", "description": "Feeds the warehouse"},
        headers=headers,
    )
    assert renamed.status_code == 200, renamed.text
    assert (renamed.json()["name"], renamed.json()["description"]) == (
        "nightly export", "Feeds the warehouse",
    )
    cleared = await client.patch(url, json={"description": None}, headers=headers)
    assert (cleared.json()["name"], cleared.json()["description"]) == ("nightly export", None)

    # What it may do, where and until when are not this route's to change.
    for change in ({"permissions": {"views": "write"}}, {"expiresAt": _in(400)}, {}):
        reply = await client.patch(url, json=change, headers=headers)
        assert reply.status_code == 422, change

    theirs = await mint(db_session, OTHER, views="read")
    stolen = await client.patch(
        f"/api/v1/me/api-keys/{theirs.id}", json={"name": "mine now"}, headers=headers,
    )
    assert stolen.status_code == 404
    await client.delete(url, headers=headers)
    reply = await client.patch(url, json={"name": "too late"}, headers=headers)
    assert reply.status_code == 409

    payloads = [
        json.loads(e.payload)
        for e in (await db_session.execute(
            select(OutboxEventORM).where(OutboxEventORM.event_type == "identity.api_key.updated")
        )).scalars().all()
    ]
    # Each edit says who made it, as the activity log reads it.
    assert {p["updated_by"] for p in payloads} == {OWNER}
    updates = [p["changes"] for p in payloads]
    assert len(updates) == 2
    assert {
        "name": {"from": "nightly sync", "to": "nightly export"},
        "description": {"from": None, "to": "Feeds the warehouse"},
    } in updates
    assert {"description": {"from": "Feeds the warehouse", "to": None}} in updates


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


async def test_a_key_is_replaced_once(client):
    """A key in its grace period could otherwise be rotated again and again,
    each time leaving another working key behind."""
    headers = _sign_in(client)
    key = (await _create(client, headers)).json()["key"]["id"]
    rotate = f"/api/v1/me/api-keys/{key}/rotate"
    body = {"currentPassword": PASSWORD, "graceSeconds": 3600}
    reply = await client.post(rotate, json=body, headers=headers)
    assert reply.status_code == 200
    again = await client.post(rotate, json=body, headers=headers)
    assert again.status_code == 409 and error(again) == "api_key_rotated"

    ended = (await _create(client, headers)).json()["key"]["id"]
    await client.delete(f"/api/v1/me/api-keys/{ended}", headers=headers)
    refused = await client.post(f"/api/v1/me/api-keys/{ended}/rotate", json=body, headers=headers)
    assert refused.status_code == 409 and error(refused) == "api_key_revoked"


async def test_an_expired_key_is_renewed_with_nothing_kept(client, db_session, monkeypatch):
    expired = await mint(db_session, views="read", expires_at=days_ago(1))
    (await db_session.get(ApiKeyORM, expired.id)).created_at = days_ago(31)
    await db_session.commit()
    headers = _sign_in(client)

    renewed = await client.post(
        f"/api/v1/me/api-keys/{expired.id}/rotate",
        json={"currentPassword": PASSWORD, "graceSeconds": 86400}, headers=headers,
    )
    assert renewed.status_code == 200, renewed.text
    new = renewed.json()["key"]
    assert new["status"] == "active" and new["rotatedFrom"] == expired.id
    # As long-lived as the old key was.
    lifetime = datetime.fromisoformat(new["expiresAt"]) - datetime.now(timezone.utc)
    assert timedelta(days=29) < lifetime <= timedelta(days=30)
    old = await db_session.get(ApiKeyORM, expired.id)
    await db_session.refresh(old)
    assert old.revoked_reason == "rotated", "an expired key has no grace period to keep"
    event = (await db_session.execute(
        select(OutboxEventORM).where(OutboxEventORM.event_type == "identity.api_key.rotated")
    )).scalars().one()
    payload = json.loads(event.payload)
    assert payload["renewed"] is True and payload["grace_seconds"] == 0

    # Renewing brings a key back, so it counts toward the limit as a new one does.
    monkeypatch.setattr(api_keys_endpoints, "MAX_ACTIVE_KEYS", 1)
    another = await mint(db_session, views="read", expires_at=days_ago(1))
    full = await client.post(
        f"/api/v1/me/api-keys/{another.id}/rotate",
        json={"currentPassword": PASSWORD}, headers=headers,
    )
    assert full.status_code == 409 and error(full) == "too_many_api_keys"


async def test_a_rotated_key_and_its_replacement_point_to_each_other(client):
    headers = _sign_in(client)
    old = (await _create(client, headers)).json()["key"]
    new = (await client.post(
        f"/api/v1/me/api-keys/{old['id']}/rotate",
        json={"currentPassword": PASSWORD}, headers=headers,
    )).json()["key"]
    before = (await client.get(f"/api/v1/me/api-keys/{old['id']}")).json()
    after = (await client.get(f"/api/v1/me/api-keys/{new['id']}")).json()
    assert before["revokedReason"] == "rotated"
    assert before["replacedBy"]["id"] == new["id"] and before["replaces"] is None
    assert after["replaces"]["id"] == old["id"] and after["replacedBy"] is None


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


async def test_the_options_say_where_you_call_from_and_where_to_sign_in_again(client, db_session):
    _sign_in(client)
    options = (await client.get("/api/v1/me/api-keys/options")).json()
    assert options["clientIp"] == "127.0.0.1"
    assert options["ssoSignInUrl"] is None and options["stepUpAvailable"] is True
    await _identity(db_session, "oidc")
    options = (await client.get("/api/v1/me/api-keys/options")).json()
    assert options["ssoSignInUrl"] == "/api/v1/auth/corp/login?next=/me/api-keys&force=1"


async def test_your_list_keeps_ended_keys_for_ninety_days(client, db_session):
    live = await mint(db_session, views="read")
    revoked_lately = await mint(db_session, views="read")
    revoked_long_ago = await mint(db_session, views="read")
    expired_long_ago = await mint(db_session, views="read", expires_at=days_ago(120))
    for key in (revoked_lately, revoked_long_ago):
        await api_key_repo.revoke(db_session, key.id, by=OWNER, reason="owner")
    (await db_session.get(ApiKeyORM, revoked_long_ago.id)).revoked_at = days_ago(120)
    await db_session.commit()
    _sign_in(client)

    recent = {k["id"] for k in (await client.get("/api/v1/me/api-keys")).json()}
    assert recent == {live.id, revoked_lately.id}
    everything = {k["id"] for k in (await client.get("/api/v1/me/api-keys?history=all")).json()}
    assert everything == {live.id, revoked_lately.id, revoked_long_ago.id, expired_long_ago.id}


async def test_a_keys_use_is_on_its_card_and_in_its_detail(client, db_session):
    key = await mint(db_session, views="read")
    yesterday, today = api_key_usage_repo.last_days(2)
    await api_key_usage_repo.add(db_session, [
        (key.id, today, 10, 3, 1, 2), (key.id, yesterday, 5, 0, 0, 0),
    ])
    await db_session.commit()
    _sign_in(client)

    card = next(k for k in (await client.get("/api/v1/me/api-keys")).json() if k["id"] == key.id)
    assert card["usage"] == {
        "requests30d": 15, "writes30d": 3, "refused30d": 1, "errors30d": 2,
        "daily14": [0] * 12 + [5, 10],
    }
    detail = (await client.get(f"/api/v1/me/api-keys/{key.id}")).json()
    assert len(detail["usageDays"]) == 30
    assert detail["usageDays"][-1] == {
        "day": today, "requests": 10, "writes": 3, "refused": 1, "errors": 2,
    }


async def test_a_new_keys_first_call_is_watched_with_one_light_read(client, db_session):
    """The page that shows a new key asks every few seconds whether it has
    been used: when and from where, and nothing more — only of your own."""
    key = await mint(db_session, views="read")
    theirs = await mint(db_session, OTHER, views="read")
    _sign_in(client)

    assert (await client.get(f"/api/v1/me/api-keys/{key.id}/last-use")).json() == {
        "lastUsedAt": None, "lastUsedIp": None, "lastUsedUserAgent": None,
    }
    await api_key_repo.touch_last_used(
        db_session, key.id, ip="198.51.100.7", user_agent="curl/8.5.0", resolution_seconds=0,
    )
    await db_session.commit()
    seen = (await client.get(f"/api/v1/me/api-keys/{key.id}/last-use")).json()
    assert (seen["lastUsedIp"], seen["lastUsedUserAgent"]) == ("198.51.100.7", "curl/8.5.0")
    assert seen["lastUsedAt"]
    assert (await client.get(f"/api/v1/me/api-keys/{theirs.id}/last-use")).status_code == 404


# ── A key on itself ─────────────────────────────────────────────────


async def test_a_key_can_describe_and_end_itself_whatever_its_state(client, db_session):
    expired = await mint(
        db_session, views="read", expires_at=days_ago(1), resources={"views": ["v_a_mine"]},
    )
    described = await client.get("/api/v1/api-keys/self", headers=expired.headers)
    assert described.status_code == 200, described.text
    assert described.json()["status"] == "expired" and described.json()["id"] == expired.id
    # What it is and why it stopped — not whose it was or what it reached:
    # a key that no longer works may be in hands it was never meant for.
    assert {k: described.json()[k] for k in ("userId", "permissions", "resources")} == {
        "userId": None, "permissions": None, "resources": None,
    }
    working = await mint(db_session, views="read")
    described = (await client.get("/api/v1/api-keys/self", headers=working.headers)).json()
    assert described["userId"] == OWNER and described["resources"] == "all"

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
    reply = await client.delete("/api/v1/api-keys/self", headers=paused.headers)
    assert reply.status_code == 204


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

    reply = await test_client.delete(f"/api/v1/admin/api-keys/{theirs.id}")
    assert reply.status_code == 204
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


@pytest.fixture()
async def admin(test_client, db_session, monkeypatch):
    """An administrator's client over the key world. The export reads each
    page in a session of its own: here, the test's."""
    @asynccontextmanager
    async def _sessions():
        yield db_session

    monkeypatch.setattr(db_engine, "get_async_session", _sessions)
    await world(db_session)
    return test_client


def _ids(response) -> list[str]:
    assert response.status_code == 200, response.text
    return [item["id"] for item in response.json()["items"]]


async def test_the_inventorys_counts_agree_with_its_lists(admin, db_session):
    """Every number on the administrators' page is the length of the list
    it opens."""
    soon = await mint(db_session, OWNER, views="read", expires_at=_in(3))
    await mint(db_session, OWNER, views="read")
    idle = await mint(db_session, OWNER, views="read")
    row = await db_session.get(ApiKeyORM, idle.id)
    row.created_at, row.last_used_at = days_ago(200), days_ago(100)
    await mint(db_session, OWNER, views="read", expires_at=days_ago(1))
    revoked = await mint(db_session, OWNER, views="read")
    await api_key_repo.revoke(db_session, revoked.id, by=OWNER, reason="owner")
    db_session.add(user_row("usr_gone", status="suspended"))
    db_session.add(user_row("usr_nopw", password=False))
    await db_session.commit()
    await mint(db_session, "usr_gone", views="read")
    await mint(db_session, "usr_nopw", views="read")

    stats = (await admin.get("/api/v1/admin/api-keys/stats")).json()
    assert stats["byStatus"] == {
        "active": 3, "paused": 1, "ownerInactive": 1, "expired": 1, "revoked": 1,
    }
    assert (
        stats["total"], stats["expiringSoon"], stats["neverExpires"],
        stats["unused90"], stats["revoked30d"],
    ) == (7, 1, 4, 1, 1)

    async def listed(query: str) -> int:
        return (await admin.get(f"/api/v1/admin/api-keys?{query}")).json()["total"]

    assert await listed("") == stats["total"]
    for value, alias in (
        ("active", "active"), ("paused", "paused"), ("owner_inactive", "ownerInactive"),
        ("expired", "expired"), ("revoked", "revoked"),
    ):
        assert await listed(f"status={value}") == stats["byStatus"][alias], value
    for focus, alias in (
        ("expiring_soon", "expiringSoon"), ("never_expires", "neverExpires"),
        ("unused", "unused90"), ("recently_revoked", "revoked30d"),
    ):
        assert await listed(f"focus={focus}") == stats[alias], focus
    assert _ids(await admin.get("/api/v1/admin/api-keys?focus=expiring_soon")) == [soon.id]
    assert _ids(await admin.get("/api/v1/admin/api-keys?focus=unused")) == [idle.id]
    narrowed = (await admin.get("/api/v1/admin/api-keys/stats?ownerId=usr_gone")).json()
    assert narrowed["total"] == 1 and narrowed["byStatus"]["ownerInactive"] == 1


async def test_a_key_past_the_lifetime_cap_is_expired_all_over_the_inventory(admin, db_session):
    old = await mint(db_session, OWNER, views="read")
    (await db_session.get(ApiKeyORM, old.id)).created_at = days_ago(40)
    await db_session.commit()
    young = await mint(db_session, OWNER, views="read")
    prime(apiKeyMaxLifetime="30")

    assert _ids(await admin.get("/api/v1/admin/api-keys?status=active")) == [young.id]
    expired = (await admin.get("/api/v1/admin/api-keys?status=expired")).json()["items"]
    assert [(k["id"], k["status"]) for k in expired] == [(old.id, "expired")]
    stats = (await admin.get("/api/v1/admin/api-keys/stats")).json()
    assert (stats["byStatus"]["active"], stats["byStatus"]["expired"]) == (1, 1)
    assert stats["neverExpires"] == 0


async def test_the_inventory_search_finds_the_text_as_typed(admin, db_session):
    """``%`` and ``_`` are characters someone typed, not wildcards."""
    percent = await mint(db_session, views="read", name="50% sample")
    await mint(db_session, views="read", name="500 rows")
    underscore = await mint(db_session, views="read", name="etl_load")
    await mint(db_session, views="read", name="etl-load")

    assert _ids(await admin.get("/api/v1/admin/api-keys", params={"q": "50%"})) == [percent.id]
    assert _ids(await admin.get("/api/v1/admin/api-keys", params={"q": "ETL_"})) == [underscore.id]
    stats = (await admin.get("/api/v1/admin/api-keys/stats", params={"q": "50%"})).json()
    assert stats["total"] == 1


async def test_an_owners_picture_is_never_read_with_their_keys(admin, db_session):
    """A provider's picture is kept in the user row — up to a few hundred KB
    of it. A key request, the inventory and the export read the owner
    without it (and asking for it is an error, not a quiet second read)."""
    owner = await db_session.get(UserORM, OWNER)
    owner.avatar_image, owner.avatar_image_type = "A" * 300_000, "image/png"
    await db_session.commit()
    key = await mint(db_session, views="read")
    token_hash = (await db_session.get(ApiKeyORM, key.id)).token_hash

    async def by_token():
        return (await api_key_repo.find_for_auth(db_session, token_hash)).owner

    async def listed():
        return (await api_key_repo.list_all(db_session))[0][0][1]

    async def exported():
        return (await api_key_repo.get_with_owners(db_session, [key.id]))[0][1]

    for read_owner in (by_token, listed, exported):
        db_session.expunge_all()  # each read starts from the database, not the last one
        read = await read_owner()
        assert read.id == OWNER and "avatar_image" not in orm_state(read).dict, read_owner
        with pytest.raises(InvalidRequestError):
            read.avatar_image  # noqa: B018 — the read is the test
    listed = (await admin.get("/api/v1/admin/api-keys")).json()["items"]
    assert listed[0]["owner"]["hasImage"] is True


async def test_the_inventory_sorts_never_used_and_never_expiring_keys_where_they_belong(
    admin, db_session,
):
    lately = await mint(db_session, OWNER, views="read", name="beta", expires_at=_in(10))
    long_ago = await mint(db_session, OWNER, views="read", name="Alpha", expires_at=_in(5))
    never = await mint(db_session, OWNER, views="read", name="gamma")
    (await db_session.get(ApiKeyORM, lately.id)).last_used_at = days_ago(1)
    (await db_session.get(ApiKeyORM, long_ago.id)).last_used_at = days_ago(50)
    await db_session.commit()

    async def order(query: str) -> list[str]:
        return _ids(await admin.get(f"/api/v1/admin/api-keys?{query}"))

    # Never used is the stalest of all; never expiring, the furthest off.
    assert await order("sort=lastUsed&order=desc") == [lately.id, long_ago.id, never.id]
    assert await order("sort=lastUsed&order=asc") == [never.id, long_ago.id, lately.id]
    assert await order("sort=expires&order=asc") == [long_ago.id, lately.id, never.id]
    assert await order("sort=expires&order=desc") == [never.id, lately.id, long_ago.id]
    assert await order("sort=name&order=asc") == [long_ago.id, lately.id, never.id]


async def test_an_administrator_sees_one_key_in_full(admin, db_session):
    key = await mint(db_session, OWNER, views="read", resources={"views": ["v_a_ws"]})
    detail = await admin.get(f"/api/v1/admin/api-keys/{key.id}")
    assert detail.status_code == 200, detail.text
    body = detail.json()
    assert body["owner"]["id"] == OWNER and body["status"] == "active"
    assert [(v["id"], v["level"]) for v in body["effectiveAccess"]["views"]] == [("v_a_ws", "read")]
    assert len(body["usageDays"]) == 30 and body["replaces"] is None
    assert (await admin.get("/api/v1/admin/api-keys/apk_nope")).status_code == 404


async def test_an_administrator_can_say_why_they_revoked_a_key(admin, db_session):
    key = await mint(db_session, OWNER, views="read", name="nightly")
    revoked = await admin.post(
        f"/api/v1/admin/api-keys/{key.id}/revoke", json={"note": "  Found in a public repo  "},
    )
    assert revoked.status_code == 204, revoked.text
    row = await db_session.get(ApiKeyORM, key.id)
    await db_session.refresh(row)
    assert (row.revoked_reason, row.revoked_note) == ("admin", "Found in a public repo")
    told = (await db_session.execute(
        select(NotificationORM).where(NotificationORM.user_id == OWNER)
    )).scalars().one()
    assert told.body.endswith("The administrator said: “Found in a public repo”")
    event = (await db_session.execute(
        select(OutboxEventORM).where(OutboxEventORM.event_type == "identity.api_key.revoked")
    )).scalars().one()
    assert json.loads(event.payload)["note"] == "Found in a public repo"
    listed = (await admin.get(f"/api/v1/admin/api-keys?ownerId={OWNER}")).json()["items"]
    assert listed[0]["revokedNote"] == "Found in a public repo"

    other = await mint(db_session, OTHER, views="read")
    too_long = await admin.post(
        f"/api/v1/admin/api-keys/{other.id}/revoke", json={"note": "x" * 501},
    )
    assert too_long.status_code == 422
    await mint(db_session, OTHER, views="read")
    everything = await admin.post(
        f"/api/v1/admin/users/{OTHER}/api-keys/revoke-all", json={"note": "Left the company"},
    )
    assert everything.status_code == 200 and everything.json() == {"revoked": 2}
    told = (await db_session.execute(
        select(NotificationORM).where(NotificationORM.user_id == OTHER)
    )).scalars().one()
    assert "Left the company" in told.body


async def test_the_export_is_a_spreadsheet_that_cannot_run_anything(admin, db_session):
    formula = '=HYPERLINK("https://evil.example","Open")'
    await mint(db_session, OWNER, views="read", name=formula)
    await mint(
        db_session, OWNER, views="write", data="read", name="plain",
        allowed_cidrs=["10.0.0.0/8"],
    )
    response = await admin.get("/api/v1/admin/api-keys/export.csv?sort=name&order=asc")
    assert response.status_code == 200, response.text
    assert response.headers["content-type"].startswith("text/csv")
    assert re.fullmatch(
        r'attachment; filename="api-keys-\d{8}\.csv"', response.headers["content-disposition"],
    )
    assert response.headers["x-total-count"] == "2"
    assert response.headers["cache-control"] == "no-store"
    rows = list(csv.DictReader(io.StringIO(response.text)))
    # Shown as text by any spreadsheet, never run.
    assert [r["name"] for r in rows] == ["'" + formula, "plain"]
    plain = rows[1]
    assert (plain["views"], plain["data"], plain["networks"], plain["reaches"]) == (
        "write", "read", "10.0.0.0/8", "everything",
    )
    assert plain["owner_email"] == f"{OWNER}@example.com" and plain["status"] == "active"

    # Filtered as the list is.
    none = await admin.get("/api/v1/admin/api-keys/export.csv?status=revoked")
    assert none.headers["x-total-count"] == "0"
    assert list(csv.reader(io.StringIO(none.text))) == [list(api_keys_endpoints._CSV_COLUMNS)]


async def test_the_export_quotes_every_cell_for_any_separator(admin, db_session):
    """Spreadsheets in many locales split on ``;``, not ``,``. Unquoted, a
    name with a ``;`` in it would become two cells, the second beginning
    with whatever followed — a formula the neutralising quote never saw."""
    await mint(db_session, OWNER, views="read", name='nightly;=HYPERLINK("x")')
    response = await admin.get("/api/v1/admin/api-keys/export.csv")
    header, row = response.text.splitlines()[:2]
    assert header.startswith('"id","name",')
    assert '"nightly;=HYPERLINK(""x"")"' in row and row.startswith('"')


async def test_the_export_pages_through_the_keys_it_listed_first(admin, db_session, monkeypatch):
    """Which keys, in what order, is read once; their rows a page at a time."""
    monkeypatch.setattr(api_keys_endpoints, "_EXPORT_PAGE", 2)
    for name in ("c", "a", "e", "b", "d"):
        await mint(db_session, OWNER, views="read", name=name)
    response = await admin.get("/api/v1/admin/api-keys/export.csv?sort=name&order=asc")
    assert response.headers["x-total-count"] == "5"
    assert [r["name"] for r in csv.DictReader(io.StringIO(response.text))] == list("abcde")


async def test_a_third_export_at_once_is_told_to_retry(admin):
    """An export streams past the request deadline, reading as it goes; two
    run at once per process, and a third is refused before a byte is sent."""
    exports, release = api_keys_endpoints._EXPORTS, asyncio.Event()
    streaming = [asyncio.Event() for _ in range(2)]

    async def _streams(started: asyncio.Event):
        async with exports.slot():
            started.set()
            await release.wait()

    holders = [asyncio.create_task(_streams(started)) for started in streaming]
    try:
        for started in streaming:
            await asyncio.wait_for(started.wait(), 5)
        busy = await admin.get("/api/v1/admin/api-keys/export.csv")
        assert busy.status_code == 429
        assert busy.headers["retry-after"] == "30"
    finally:
        release.set()
        await asyncio.gather(*holders)
    assert (await admin.get("/api/v1/admin/api-keys/export.csv")).status_code == 200


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


async def test_a_prune_that_fails_does_not_take_the_reminders_with_it(db_session, monkeypatch):
    """Usage pruning runs after the reminders in the same pass. When it
    fails — a timeout on a large table — the reminders already sent stay
    sent, rather than rolling back and failing again on every pass."""
    db_session.add(user_row(OWNER))
    await db_session.commit()
    soon = await mint(db_session, views="read",
                      expires_at=(datetime.now(timezone.utc) + timedelta(days=3)).isoformat())
    (await db_session.get(ApiKeyORM, soon.id)).created_at = days_ago(60)
    await db_session.commit()

    shutdown = asyncio.Event()

    async def _times_out(_session):
        shutdown.set()
        raise TimeoutError("canceling statement due to statement timeout")

    @asynccontextmanager
    async def _transaction():
        # As the jobs pool's sessions are: committed if the block ends, rolled back if it raises.
        try:
            yield db_session
            await db_session.commit()
        except BaseException:
            await db_session.rollback()
            raise

    monkeypatch.setattr(api_key_usage_repo, "prune", _times_out)
    await asyncio.wait_for(
        api_key_housekeeping.run_sweeper(_transaction, shutdown, interval=3600), timeout=10,
    )
    notes = (await db_session.execute(
        select(NotificationORM.resource_id).where(NotificationORM.kind == "api_key_expiring")
    )).scalars().all()
    assert notes == [soon.id]
    assert (await db_session.get(ApiKeyORM, soon.id)).expiry_reminded_at
