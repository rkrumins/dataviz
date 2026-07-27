"""Phase 15 — one email-pinned link per address, from one set of settings.

Onboarding a team meant repeating the same form once per person. Every
link comes out pinned to its recipient rather than one shared link,
because a pinned link is separately revocable and each redemption is
attributable to the person it was meant for — a shared link tells you
only that somebody used it.

Partial success is the normal case and is reported per row: one address
already having an account must not cost the other nineteen theirs.
"""
from __future__ import annotations

import pytest
from httpx import AsyncClient

from backend.app.auth.jwt import decode_invite_token
from backend.app.db.models import GroupORM, WorkspaceORM
from backend.app.db.repositories import invite_repo, user_repo


@pytest.fixture(autouse=True)
def _disable_signup_rate_limit():
    from backend.app.api.v1.endpoints import auth as _auth_mod
    prev = _auth_mod.limiter.enabled
    _auth_mod.limiter.enabled = False
    yield
    _auth_mod.limiter.enabled = prev


async def _bulk(test_client, emails, **body):
    return await test_client.post(
        "/api/v1/admin/users/invite/bulk", json={"emails": emails, **body},
    )


def _by_email(payload):
    """First row per address — a repeated address yields a second
    'duplicate' row, and keeping the last would hide the real outcome."""
    out = {}
    for r in payload["results"]:
        out.setdefault(r["email"], r)
    return out


@pytest.mark.asyncio
async def test_one_pinned_link_per_address(test_client: AsyncClient, db_session):
    r = await _bulk(test_client, ["a@x.com", "b@x.com", "c@x.com"])
    assert r.status_code == 201, r.text
    body = r.json()
    assert body["created"] == 3
    assert body["skipped"] == 0

    rows = _by_email(body)
    for email in ("a@x.com", "b@x.com", "c@x.com"):
        assert rows[email]["outcome"] == "created"
        # Pinned, so the link cannot be forwarded to somebody else.
        payload = decode_invite_token(rows[email]["inviteToken"])
        assert payload["email"] == email

        stored = await invite_repo.get(db_session, rows[email]["inviteId"])
        assert stored.email == email

    # Separately revocable — three rows, not one.
    ids = {rows[e]["inviteId"] for e in ("a@x.com", "b@x.com", "c@x.com")}
    assert len(ids) == 3


@pytest.mark.asyncio
async def test_the_links_actually_work(test_client: AsyncClient, db_session):
    r = await _bulk(test_client, ["worker@x.com"])
    token = _by_email(r.json())["worker@x.com"]["inviteToken"]

    su = await test_client.post("/api/v1/auth/signup", json={
        "email": "worker@x.com", "password": "Sup3r-Str0ng-Pw!9",
        "firstName": "W", "lastName": "Orker", "inviteToken": token,
    })
    assert su.status_code == 201, su.text
    assert await user_repo.get_user_by_email(db_session, "worker@x.com") is not None


@pytest.mark.asyncio
async def test_one_bad_address_does_not_cost_the_others_their_invitations(
    test_client: AsyncClient, db_session,
):
    await user_repo.create_user(
        db_session, email="taken@x.com", password_hash="x",
        first_name="Ta", last_name="Ken", status="active",
    )
    await db_session.commit()

    r = await _bulk(test_client, [
        "good1@x.com", "taken@x.com", "not-an-email",
        "good2@x.com", "good1@x.com",
    ])
    assert r.status_code == 201, r.text
    body = r.json()
    rows = _by_email(body)

    assert body["created"] == 2
    assert rows["good1@x.com"]["outcome"] == "created"
    assert rows["good2@x.com"]["outcome"] == "created"
    assert rows["taken@x.com"]["outcome"] == "already_a_user"
    assert rows["not-an-email"]["outcome"] == "invalid_email"
    # Listed twice — the second mention is reported, not silently dropped.
    assert any(
        r_["outcome"] == "duplicate" for r_ in body["results"]
    )


@pytest.mark.asyncio
async def test_an_existing_account_gets_no_link(test_client: AsyncClient, db_session):
    """A link for a taken address could never be redeemed — signup
    refuses one — so minting it would hand over a dead URL."""
    await user_repo.create_user(
        db_session, email="already@x.com", password_hash="x",
        first_name="Al", last_name="Ready", status="active",
    )
    await db_session.commit()

    r = await _bulk(test_client, ["already@x.com"])
    row = _by_email(r.json())["already@x.com"]
    assert row["outcome"] == "already_a_user"
    assert row["inviteToken"] is None


@pytest.mark.asyncio
async def test_settings_apply_to_every_link(test_client: AsyncClient, db_session):
    db_session.add(WorkspaceORM(id="ws_bulk", name="Bulk"))
    db_session.add(GroupORM(id="grp_bulk", name="Bulk Team"))
    await db_session.commit()

    r = await _bulk(
        test_client, ["m1@x.com", "m2@x.com"],
        role="workspace_member", workspaceId="ws_bulk",
        groupIds=["grp_bulk"], expiresInHours=24,
    )
    assert r.status_code == 201, r.text
    rows = _by_email(r.json())

    for email in ("m1@x.com", "m2@x.com"):
        stored = await invite_repo.get(db_session, rows[email]["inviteId"])
        assert stored.role == "workspace_member"
        assert stored.workspace_id == "ws_bulk"
        assert invite_repo.group_ids_of(stored) == ["grp_bulk"]


@pytest.mark.asyncio
async def test_groups_need_no_override_because_every_link_is_pinned(
    test_client: AsyncClient, db_session,
):
    """A single invite with groups demands an email pin or an explicit
    shareable override. Here the pin is there by construction, so the
    rule is satisfied without an opt-in."""
    db_session.add(GroupORM(id="grp_auto", name="Auto"))
    await db_session.commit()

    r = await _bulk(test_client, ["g1@x.com"], groupIds=["grp_auto"])
    assert r.status_code == 201, r.text
    assert _by_email(r.json())["g1@x.com"]["outcome"] == "created"


@pytest.mark.asyncio
async def test_bad_settings_fail_the_whole_batch(test_client: AsyncClient):
    """Settings are wrong for everybody, not for one row — reporting a
    bad role twenty times would bury the one thing that needs fixing."""
    r = await _bulk(test_client, ["x@x.com"], role="no_such_role")
    assert r.status_code == 400
    assert "Unknown role" in r.json()["detail"]


@pytest.mark.asyncio
async def test_the_kill_switch_covers_bulk_too(test_client: AsyncClient):
    from backend.app.services import feature_flags as ff_mod

    original = ff_mod.feature_flags.is_enabled_self_session

    async def _off(key, default=False):
        return False if key == "inviteLinksEnabled" else await original(key, default=default)

    ff_mod.feature_flags.is_enabled_self_session = _off
    try:
        r = await _bulk(test_client, ["x@x.com"])
    finally:
        ff_mod.feature_flags.is_enabled_self_session = original

    assert r.status_code == 403
    assert r.json()["detail"]["feature"] == "inviteLinksEnabled"


@pytest.mark.asyncio
async def test_an_empty_list_is_rejected(test_client: AsyncClient):
    assert (await _bulk(test_client, [])).status_code == 422


@pytest.mark.asyncio
async def test_the_batch_is_bounded(test_client: AsyncClient):
    assert (await _bulk(test_client, [f"u{i}@x.com" for i in range(201)])).status_code == 422
