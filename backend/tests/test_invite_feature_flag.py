"""Phase 15 — ``inviteLinksEnabled``: the kill switch, and its posture.

A separate flag from ``signupEnabled``, because the two describe
different doors:

    signupEnabled  inviteLinksEnabled   result
    off            on                   invite-only (the default posture)
    on             on                   open registration plus invites
    off            off                  closed — admin-created accounts only
    on             off                  open registration, no links

Off means off IMMEDIATELY: links already in circulation stop redeeming.
A toggle that only stopped new links would be useless in the situation
it exists for — a link that has leaked.
"""
from __future__ import annotations

from contextlib import asynccontextmanager

import pytest
from httpx import AsyncClient

from backend.app.db.repositories import user_repo


@pytest.fixture(autouse=True)
def _disable_signup_rate_limit():
    from backend.app.api.v1.endpoints import auth as _auth_mod
    prev = _auth_mod.limiter.enabled
    _auth_mod.limiter.enabled = False
    yield
    _auth_mod.limiter.enabled = prev


PW = "Sup3r-Str0ng-Pw!9"


@asynccontextmanager
async def _links(enabled: bool):
    """Force ``inviteLinksEnabled`` for the duration of the block."""
    from backend.app.services import feature_flags as ff_mod

    original = ff_mod.feature_flags.is_enabled_self_session

    async def _stub(key: str, default: bool = False) -> bool:
        if key == "inviteLinksEnabled":
            return enabled
        return await original(key, default=default)

    ff_mod.feature_flags.is_enabled_self_session = _stub
    try:
        yield
    finally:
        ff_mod.feature_flags.is_enabled_self_session = original


@asynccontextmanager
async def _flag_unreadable():
    """Simulate the flag store being unavailable, so the call site's
    ``default`` decides."""
    from backend.app.services import feature_flags as ff_mod

    original = ff_mod.feature_flags.is_enabled_self_session

    async def _stub(key: str, default: bool = False) -> bool:
        return default

    ff_mod.feature_flags.is_enabled_self_session = _stub
    try:
        yield
    finally:
        ff_mod.feature_flags.is_enabled_self_session = original


async def _mint(test_client, **body):
    return await test_client.post("/api/v1/admin/users/invite", json=body)


async def _signup(test_client, *, email, token):
    return await test_client.post("/api/v1/auth/signup", json={
        "email": email, "password": PW,
        "firstName": "Flag", "lastName": "User",
        "inviteToken": token,
    })


# ── creation is refused ──────────────────────────────────────────────


@pytest.mark.asyncio
async def test_minting_is_refused_when_links_are_off(test_client: AsyncClient):
    async with _links(False):
        r = await _mint(test_client)
    assert r.status_code == 403
    assert r.json()["detail"]["feature"] == "inviteLinksEnabled"


# ── the kill switch ──────────────────────────────────────────────────


@pytest.mark.asyncio
async def test_links_already_sent_stop_working_at_once(
    test_client: AsyncClient, db_session,
):
    minted = (await _mint(test_client)).json()
    token = minted["inviteToken"]

    async with _links(False):
        v = await test_client.get(f"/api/v1/auth/verify-invite?token={token}")
        assert v.json()["valid"] is False
        assert v.json()["reason"] == "links_disabled"

        su = await _signup(test_client, email="killed@example.com", token=token)
        assert su.status_code == 400
        assert "turned off" in su.json()["detail"]

    assert await user_repo.get_user_by_email(db_session, "killed@example.com") is None


@pytest.mark.asyncio
async def test_turning_it_back_on_revives_unexpired_links(
    test_client: AsyncClient, db_session,
):
    token = (await _mint(test_client)).json()["inviteToken"]

    async with _links(False):
        assert (await _signup(
            test_client, email="revived@example.com", token=token)).status_code == 400

    async with _links(True):
        r = await _signup(test_client, email="revived@example.com", token=token)
    assert r.status_code == 201, r.text
    assert await user_repo.get_user_by_email(db_session, "revived@example.com") is not None


# ── cleanup survives the switch ──────────────────────────────────────


@pytest.mark.asyncio
async def test_listing_and_revoking_still_work_when_links_are_off(
    test_client: AsyncClient,
):
    """An admin who has just switched links off is precisely the admin
    who needs to see and revoke what is outstanding. Gating the cleanup
    on the same flag would be exactly backwards."""
    invite_id = (await _mint(test_client)).json()["inviteId"]

    async with _links(False):
        listed = await test_client.get("/api/v1/admin/users/invites?status=all")
        assert listed.status_code == 200
        assert any(i["id"] == invite_id for i in listed.json())

        revoked = await test_client.post(
            f"/api/v1/admin/users/invites/{invite_id}/revoke"
        )
        assert revoked.status_code == 200
        assert revoked.json()["status"] == "revoked"


# ── posture: this one fails OPEN ─────────────────────────────────────


@pytest.mark.asyncio
async def test_an_unreadable_flag_still_lets_an_invite_through(
    test_client: AsyncClient, db_session,
):
    """Deliberately the opposite of ``signupEnabled``, which fails
    CLOSED. That flag guards anonymous strangers; this one guards people
    already holding a signed, expiring, capped, revocable credential an
    admin issued on purpose. Failing closed here would black out the
    only entrance an invite-only deployment has, to defend against
    somebody who was already invited.
    """
    token = (await _mint(test_client)).json()["inviteToken"]

    async with _flag_unreadable():
        r = await _signup(test_client, email="failopen@example.com", token=token)

    assert r.status_code == 201, r.text
    assert await user_repo.get_user_by_email(db_session, "failopen@example.com") is not None


def test_the_two_auth_flags_have_opposite_postures():
    """If these ever agree, one of them is wrong — and the reasoning in
    both call sites has stopped applying."""
    from backend.app.config.feature_wiring import FEATURE_WIRING

    assert FEATURE_WIRING["signupEnabled"].posture == "security"
    assert FEATURE_WIRING["signupEnabled"].fail_safe_default is False

    assert FEATURE_WIRING["inviteLinksEnabled"].posture == "capability"
    assert FEATURE_WIRING["inviteLinksEnabled"].fail_safe_default is True


def test_invite_links_ships_on():
    """Self-registration seeds OFF. If invite links seeded off too, a
    fresh deployment would have no way in at all."""
    import json
    from backend.app.config.features_seed import SEED_DEFINITIONS

    row = next(d for d in SEED_DEFINITIONS if d["key"] == "inviteLinksEnabled")
    assert json.loads(row["default_value"]) is True

    signup = next(d for d in SEED_DEFINITIONS if d["key"] == "signupEnabled")
    assert json.loads(signup["default_value"]) is False
