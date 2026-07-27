"""Phase 15 — the invite ledger: revocation, seat caps, domain rules, history.

Before the ledger an invite was a bare signed JWT with no server-side
record. That made three things impossible: revoking a link that had
leaked, limiting how many people could use one, and finding out
afterwards who had. A link pasted into the wrong channel worked for
every reader until it expired — up to ninety days — and left no trace.

These tests drive the admin invite endpoints and the public signup
endpoint end-to-end through the conftest test client.
"""
from __future__ import annotations

import asyncio
import json
from datetime import datetime, timedelta, timezone

import pytest
from httpx import AsyncClient

from backend.app.db.models import InviteORM, WorkspaceORM
from backend.app.db.repositories import invite_repo, user_repo


@pytest.fixture(autouse=True)
def _disable_signup_rate_limit():
    """This module fires many signups; the per-IP limit on /auth/signup
    would throttle the later cases. The limit itself is covered
    elsewhere."""
    from backend.app.api.v1.endpoints import auth as _auth_mod
    prev = _auth_mod.limiter.enabled
    _auth_mod.limiter.enabled = False
    yield
    _auth_mod.limiter.enabled = prev


PW = "Sup3r-Str0ng-Pw!9"


async def _mint(test_client, **body):
    return await test_client.post("/api/v1/admin/users/invite", json=body)


async def _signup(test_client, *, email, token=None, password=PW):
    body = {
        "email": email, "password": password,
        "firstName": "New", "lastName": "User",
    }
    if token:
        body["inviteToken"] = token
    return await test_client.post("/api/v1/auth/signup", json=body)


async def _verify(test_client, token):
    return await test_client.get(f"/api/v1/auth/verify-invite?token={token}")


def _resync_csrf(test_client):
    """Echo the CURRENT csrf cookie back as the header, the way the real
    frontend does.

    An invited signup auto-signs-in, and issuing a session rotates the
    CSRF cookie — so this one client, which is impersonating an admin
    AND redeeming invites, ends up sending a header that no longer
    matches its own cookie. A browser re-reads the cookie on every
    state-changing request; this is that, in one line. (The mismatch is
    an artifact of one client playing both parts — a real admin and a
    real invitee are different browsers.)
    """
    from backend.auth_service.cookies import (
        ACCESS_COOKIE_NAME, CSRF_COOKIE_NAME, REFRESH_COOKIE_NAME,
    )
    from backend.tests.conftest import _TEST_CSRF_TOKEN

    # Drop everything the signup's session put on this client — including
    # the second nx_csrf it added on a different domain — then re-pin the
    # fixture's token so the double-submit matches again.
    for cookie in list(test_client.cookies.jar):
        if cookie.name in (ACCESS_COOKIE_NAME, REFRESH_COOKIE_NAME, CSRF_COOKIE_NAME):
            test_client.cookies.jar.clear(cookie.domain, cookie.path, cookie.name)
    test_client.cookies.set(CSRF_COOKIE_NAME, _TEST_CSRF_TOKEN)


# ── the row exists and the token points at it ────────────────────────


@pytest.mark.asyncio
async def test_minting_writes_a_ledger_row_and_token_carries_its_jti(
    test_client: AsyncClient, db_session,
):
    from backend.app.auth.jwt import decode_invite_token

    r = await _mint(test_client, maxUses=5)
    assert r.status_code == 201, r.text
    body = r.json()

    assert body["inviteId"], "response must name the row it created"
    assert body["maxUses"] == 5

    payload = decode_invite_token(body["inviteToken"])
    assert payload["jti"] == body["inviteId"], (
        "the token must point at its ledger row, or nothing can be revoked"
    )

    row = await invite_repo.get(db_session, body["inviteId"])
    assert row is not None
    assert row.max_uses == 5
    assert row.use_count == 0
    assert invite_repo.status_of(row) == "active"


@pytest.mark.asyncio
async def test_redemption_increments_use_count_and_records_who(
    test_client: AsyncClient, db_session,
):
    minted = (await _mint(test_client)).json()

    su = await _signup(
        test_client, email="claimed@example.com", token=minted["inviteToken"],
    )
    assert su.status_code == 201, su.text

    row = await invite_repo.get(db_session, minted["inviteId"])
    await db_session.refresh(row)
    assert row.use_count == 1

    user = await user_repo.get_user_by_email(db_session, "claimed@example.com")
    redemptions = await invite_repo.list_redemptions(db_session, minted["inviteId"])
    assert len(redemptions) == 1
    assert redemptions[0].user_id == user.id
    assert redemptions[0].email == "claimed@example.com"


# ── revocation ───────────────────────────────────────────────────────


@pytest.mark.asyncio
async def test_revoked_link_stops_working_immediately(
    test_client: AsyncClient, db_session,
):
    minted = (await _mint(test_client)).json()
    token, invite_id = minted["inviteToken"], minted["inviteId"]

    # Live before revocation.
    assert (await _verify(test_client, token)).json()["valid"] is True

    rev = await test_client.post(f"/api/v1/admin/users/invites/{invite_id}/revoke")
    assert rev.status_code == 200, rev.text
    assert rev.json()["status"] == "revoked"

    # The token is still cryptographically valid — that is the whole
    # point. The ledger is what refuses it.
    v = (await _verify(test_client, token)).json()
    assert v["valid"] is False
    assert v["reason"] == "revoked"

    su = await _signup(test_client, email="toolate@example.com", token=token)
    assert su.status_code == 400
    assert "revoked" in su.json()["detail"].lower()

    assert await user_repo.get_user_by_email(db_session, "toolate@example.com") is None


@pytest.mark.asyncio
async def test_revoke_returns_resolved_names_not_raw_ids(
    test_client: AsyncClient, db_session,
):
    """The revoke response is the same shape the list renders, so it has
    to resolve workspace and group names too — echoing raw ids back into
    a *Names field puts ``grp_a1b2c3`` in front of a human."""
    from backend.app.db.models import GroupORM

    db_session.add(WorkspaceORM(id="ws_rev", name="Revenue"))
    db_session.add(GroupORM(id="grp_rev", name="Revenue Team"))
    await db_session.commit()

    minted = (await _mint(
        test_client, role="workspace_member", workspaceId="ws_rev",
        groupIds=["grp_rev"], allowShareableWithGroups=True,
    )).json()

    r = await test_client.post(
        f"/api/v1/admin/users/invites/{minted['inviteId']}/revoke"
    )
    assert r.status_code == 200, r.text
    assert r.json()["groupNames"] == ["Revenue Team"]
    assert r.json()["workspaceName"] == "Revenue"


@pytest.mark.asyncio
async def test_revoke_is_idempotent_and_keeps_the_first_timestamp(
    test_client: AsyncClient, db_session,
):
    invite_id = (await _mint(test_client)).json()["inviteId"]

    first = await test_client.post(f"/api/v1/admin/users/invites/{invite_id}/revoke")
    second = await test_client.post(f"/api/v1/admin/users/invites/{invite_id}/revoke")

    assert first.status_code == second.status_code == 200
    assert first.json()["revokedAt"] == second.json()["revokedAt"], (
        "the first revocation is the one that happened"
    )


@pytest.mark.asyncio
async def test_revoking_an_unknown_invite_is_404(test_client: AsyncClient):
    r = await test_client.post("/api/v1/admin/users/invites/inv_nope/revoke")
    assert r.status_code == 404


# ── seat caps ────────────────────────────────────────────────────────


@pytest.mark.asyncio
async def test_max_uses_closes_the_link_when_the_seats_run_out(
    test_client: AsyncClient, db_session,
):
    minted = (await _mint(test_client, maxUses=2)).json()
    token = minted["inviteToken"]

    assert (await _signup(test_client, email="seat1@example.com", token=token)).status_code == 201
    assert (await _signup(test_client, email="seat2@example.com", token=token)).status_code == 201

    third = await _signup(test_client, email="seat3@example.com", token=token)
    assert third.status_code == 400
    assert "maximum number of times" in third.json()["detail"]

    assert await user_repo.get_user_by_email(db_session, "seat3@example.com") is None

    v = (await _verify(test_client, token)).json()
    assert v["valid"] is False and v["reason"] == "exhausted"


@pytest.mark.asyncio
async def test_verify_reports_seats_left_so_the_page_can_warn(
    test_client: AsyncClient,
):
    """Being turned away at the door is the worst moment to discover a
    limit existed. The page can only say "2 spots left" if we tell it."""
    minted = (await _mint(test_client, maxUses=3)).json()
    token = minted["inviteToken"]

    v = (await _verify(test_client, token)).json()
    assert v["seatsRemaining"] == 3
    assert v["expiresAt"] == minted["expiresAt"]

    await _signup(test_client, email="seat-a@example.com", token=token)
    assert (await _verify(test_client, token)).json()["seatsRemaining"] == 2


@pytest.mark.asyncio
async def test_an_uncapped_link_reports_no_seat_limit(test_client: AsyncClient):
    token = (await _mint(test_client)).json()["inviteToken"]
    assert (await _verify(test_client, token)).json()["seatsRemaining"] is None


@pytest.mark.asyncio
async def test_unlimited_by_default(test_client: AsyncClient):
    token = (await _mint(test_client)).json()["inviteToken"]
    for i in range(4):
        r = await _signup(test_client, email=f"unlimited{i}@example.com", token=token)
        assert r.status_code == 201, r.text


@pytest.mark.asyncio
async def test_concurrent_redemptions_cannot_oversubscribe_one_seat(
    test_client: AsyncClient, db_session,
):
    """The test that catches a read-then-write consume.

    Two people click a one-seat link at the same moment. Under
    read-then-write both would see use_count == 0 and both would be
    admitted, making the cap advisory. Exactly one must win.
    """
    token = (await _mint(test_client, maxUses=1)).json()["inviteToken"]

    results = await asyncio.gather(
        _signup(test_client, email="racer-a@example.com", token=token),
        _signup(test_client, email="racer-b@example.com", token=token),
        return_exceptions=True,
    )
    codes = [r.status_code for r in results if not isinstance(r, Exception)]
    assert codes.count(201) == 1, f"exactly one signup must win, got {codes}"

    created = [
        e for e in ("racer-a@example.com", "racer-b@example.com")
        if await user_repo.get_user_by_email(db_session, e) is not None
    ]
    assert len(created) == 1


@pytest.mark.asyncio
async def test_a_seat_is_not_burned_by_an_existing_email(
    test_client: AsyncClient, db_session,
):
    """Signup answers identically for a taken address to avoid leaking
    which addresses exist. That short-circuit must happen BEFORE the
    seat is claimed, or anyone could drain a link's seats by replaying
    an address they already know."""
    # An address that already exists, created outside the invite flow so
    # the link's single seat is definitely untouched.
    await user_repo.create_user(
        db_session,
        email="squatter@example.com", password_hash="x",
        first_name="Sq", last_name="Uatter", status="active",
    )
    await db_session.commit()

    minted = (await _mint(test_client, maxUses=1)).json()
    token = minted["inviteToken"]

    for _ in range(3):
        r = await _signup(test_client, email="squatter@example.com", token=token)
        assert r.status_code == 201, "the taken-address answer must not change"

    row = await invite_repo.get(db_session, minted["inviteId"])
    await db_session.refresh(row)
    assert row.use_count == 0, "replaying a known address must not spend seats"

    # The seat survived: a genuinely new address can still get in.
    r = await _signup(test_client, email="genuine@example.com", token=token)
    assert r.status_code == 201, r.text
    assert await user_repo.get_user_by_email(db_session, "genuine@example.com") is not None


# ── extend / regenerate ──────────────────────────────────────────────


@pytest.mark.asyncio
async def test_extending_keeps_the_url_working(test_client: AsyncClient, db_session):
    """The point of extend: the link already shared stays valid. Minting
    a replacement was the only option before, which split one invitation
    across two rows and stranded its history on the dead one."""
    minted = (await _mint(test_client, expiresInHours=1)).json()
    token = minted["inviteToken"]

    row = await invite_repo.get(db_session, minted["inviteId"])
    row.expires_at = (datetime.now(timezone.utc) - timedelta(hours=1)).isoformat()
    await db_session.commit()
    assert (await _verify(test_client, token)).json()["reason"] == "expired"

    r = await test_client.post(
        f"/api/v1/admin/users/invites/{minted['inviteId']}/extend",
        json={"expiresInHours": 72},
    )
    assert r.status_code == 200, r.text
    assert r.json()["status"] == "active"

    # Same URL, alive again.
    assert (await _verify(test_client, token)).json()["valid"] is True


@pytest.mark.asyncio
async def test_extending_adds_seats_relative_to_what_was_used(
    test_client: AsyncClient, db_session,
):
    """'Add 2 seats' must mean two more people can join. Adding to the
    original cap would mean nothing at all on a spent link."""
    minted = (await _mint(test_client, maxUses=1)).json()
    token = minted["inviteToken"]
    await _signup(test_client, email="filled@example.com", token=token)
    _resync_csrf(test_client)
    assert (await _verify(test_client, token)).json()["reason"] == "exhausted"

    r = await test_client.post(
        f"/api/v1/admin/users/invites/{minted['inviteId']}/extend",
        json={"expiresInHours": 72, "additionalUses": 2},
    )
    assert r.status_code == 200, r.text
    assert r.json()["maxUses"] == 3          # 1 used + 2 more
    assert r.json()["useCount"] == 1

    assert (await _verify(test_client, token)).json()["seatsRemaining"] == 2


@pytest.mark.asyncio
async def test_regenerating_kills_every_url_already_handed_out(
    test_client: AsyncClient, db_session,
):
    """The line between regenerate and extend. If the old URL survived,
    rotation would be theatre."""
    minted = (await _mint(test_client)).json()
    old_token = minted["inviteToken"]
    assert (await _verify(test_client, old_token)).json()["valid"] is True

    r = await test_client.post(
        f"/api/v1/admin/users/invites/{minted['inviteId']}/regenerate",
        json={"expiresInHours": 72},
    )
    assert r.status_code == 200, r.text
    new_token = r.json()["inviteToken"]
    assert new_token != old_token
    assert r.json()["inviteId"] == minted["inviteId"]   # same invitation

    old = (await _verify(test_client, old_token)).json()
    assert old["valid"] is False
    assert old["reason"] == "superseded", (
        "the holder of a stale URL must be told it was replaced, not sent "
        "chasing an 'invalid link'"
    )
    assert (await _verify(test_client, new_token)).json()["valid"] is True

    su = await _signup(test_client, email="stale@example.com", token=old_token)
    assert su.status_code == 400
    assert "replaced" in su.json()["detail"]


@pytest.mark.asyncio
async def test_regenerating_preserves_the_invitation_and_its_history(
    test_client: AsyncClient, db_session,
):
    from backend.app.db.models import GroupORM, WorkspaceORM

    db_session.add(WorkspaceORM(id="ws_rot", name="Rotation"))
    db_session.add(GroupORM(id="grp_rot", name="Rotators"))
    await db_session.commit()

    minted = (await _mint(
        test_client, role="workspace_member", workspaceId="ws_rot",
        groupIds=["grp_rot"], allowShareableWithGroups=True, maxUses=5,
    )).json()
    await _signup(test_client, email="early@example.com", token=minted["inviteToken"])
    _resync_csrf(test_client)

    r = await test_client.post(
        f"/api/v1/admin/users/invites/{minted['inviteId']}/regenerate",
        json={"expiresInHours": 72},
    )
    assert r.status_code == 200, r.text
    assert r.json()["role"] == "workspace_member"
    assert r.json()["workspaceId"] == "ws_rot"
    assert r.json()["maxUses"] == 5

    # The redemption that happened before the rotation is still attached.
    hist = await test_client.get(
        f"/api/v1/admin/users/invites/{minted['inviteId']}/redemptions"
    )
    assert [row["email"] for row in hist.json()] == ["early@example.com"]

    listed = await test_client.get("/api/v1/admin/users/invites?status=all")
    row = next(i for i in listed.json() if i["id"] == minted["inviteId"])
    assert row["useCount"] == 1


@pytest.mark.asyncio
async def test_a_revoked_link_can_be_neither_extended_nor_regenerated(
    test_client: AsyncClient,
):
    """Revocation is a decision. Reviving it by extending would undo
    that decision without anybody choosing to."""
    invite_id = (await _mint(test_client)).json()["inviteId"]
    await test_client.post(f"/api/v1/admin/users/invites/{invite_id}/revoke")

    for verb in ("extend", "regenerate"):
        r = await test_client.post(
            f"/api/v1/admin/users/invites/{invite_id}/{verb}",
            json={"expiresInHours": 72},
        )
        assert r.status_code == 409, f"{verb}: {r.text}"
        assert "revoked" in r.json()["detail"].lower()


@pytest.mark.asyncio
async def test_extend_and_regenerate_404_for_an_unknown_link(test_client: AsyncClient):
    for verb in ("extend", "regenerate"):
        r = await test_client.post(
            f"/api/v1/admin/users/invites/inv_nope/{verb}",
            json={"expiresInHours": 72},
        )
        assert r.status_code == 404


# ── expiry ───────────────────────────────────────────────────────────


@pytest.mark.asyncio
async def test_expired_row_is_reported_as_expired(test_client: AsyncClient, db_session):
    minted = (await _mint(test_client)).json()
    row = await invite_repo.get(db_session, minted["inviteId"])
    row.expires_at = (datetime.now(timezone.utc) - timedelta(hours=1)).isoformat()
    await db_session.commit()

    v = (await _verify(test_client, minted["inviteToken"])).json()
    assert v["valid"] is False and v["reason"] == "expired"


def test_unparseable_expiry_fails_closed():
    """The opposite of binding_repo, deliberately: here expires_at is
    NOT NULL and always set, so garbage means corruption — and reading
    corruption as "never expires" would make a link immortal."""
    assert invite_repo.is_expired("not-a-timestamp") is True
    assert invite_repo.is_expired("") is True


# ── domain restriction ───────────────────────────────────────────────


@pytest.mark.asyncio
async def test_domain_restricted_link_admits_only_that_domain(
    test_client: AsyncClient, db_session,
):
    minted = (await _mint(test_client, emailDomain="company.com")).json()
    token = minted["inviteToken"]
    assert minted["emailDomain"] == "company.com"

    bad = await _signup(test_client, email="outsider@other.com", token=token)
    assert bad.status_code == 400
    assert "domain" in bad.json()["detail"].lower()
    assert await user_repo.get_user_by_email(db_session, "outsider@other.com") is None

    ok = await _signup(test_client, email="insider@company.com", token=token)
    assert ok.status_code == 201, ok.text


@pytest.mark.asyncio
async def test_leading_at_is_accepted_in_the_domain_field(test_client: AsyncClient):
    r = await _mint(test_client, emailDomain="@company.com")
    assert r.status_code == 201
    assert r.json()["emailDomain"] == "company.com"


@pytest.mark.asyncio
async def test_a_malformed_domain_is_rejected(test_client: AsyncClient):
    r = await _mint(test_client, emailDomain="not-a-domain")
    assert r.status_code == 422


@pytest.mark.asyncio
async def test_an_email_pin_supersedes_a_domain(test_client: AsyncClient, db_session):
    """A pin is strictly narrower, so storing both would keep a
    constraint that can never bind."""
    minted = (await _mint(
        test_client, email="one@company.com", emailDomain="company.com",
    )).json()
    assert minted["emailDomain"] is None

    row = await invite_repo.get(db_session, minted["inviteId"])
    assert row.email == "one@company.com"
    assert row.email_domain is None


# ── admin list + redemption history ──────────────────────────────────


@pytest.mark.asyncio
async def test_list_reports_usage_and_never_leaks_a_token(
    test_client: AsyncClient, db_session,
):
    minted = (await _mint(test_client, maxUses=3)).json()
    await _signup(test_client, email="hist1@example.com", token=minted["inviteToken"])

    r = await test_client.get("/api/v1/admin/users/invites")
    assert r.status_code == 200, r.text
    row = next(i for i in r.json() if i["id"] == minted["inviteId"])

    assert row["useCount"] == 1
    assert row["redemptionCount"] == 1
    assert row["maxUses"] == 3
    assert row["status"] == "active"
    assert "inviteToken" not in row and "token" not in row, (
        "a read-only list must not become a place to harvest credentials"
    )


@pytest.mark.asyncio
async def test_redemption_history_names_who_came_in(test_client: AsyncClient, db_session):
    minted = (await _mint(test_client)).json()
    await _signup(test_client, email="who1@example.com", token=minted["inviteToken"])
    await _signup(test_client, email="who2@example.com", token=minted["inviteToken"])

    r = await test_client.get(
        f"/api/v1/admin/users/invites/{minted['inviteId']}/redemptions"
    )
    assert r.status_code == 200, r.text
    emails = {row["email"] for row in r.json()}
    assert emails == {"who1@example.com", "who2@example.com"}

    user = await user_repo.get_user_by_email(db_session, "who1@example.com")
    assert any(row["userId"] == user.id for row in r.json())


@pytest.mark.asyncio
async def test_list_filters_by_status(test_client: AsyncClient):
    live = (await _mint(test_client)).json()
    dead = (await _mint(test_client)).json()
    await test_client.post(f"/api/v1/admin/users/invites/{dead['inviteId']}/revoke")

    active_ids = {i["id"] for i in (await test_client.get(
        "/api/v1/admin/users/invites?status=active")).json()}
    revoked_ids = {i["id"] for i in (await test_client.get(
        "/api/v1/admin/users/invites?status=revoked")).json()}
    all_ids = {i["id"] for i in (await test_client.get(
        "/api/v1/admin/users/invites?status=all")).json()}

    assert live["inviteId"] in active_ids and dead["inviteId"] not in active_ids
    assert dead["inviteId"] in revoked_ids
    assert {live["inviteId"], dead["inviteId"]} <= all_ids


@pytest.mark.asyncio
async def test_redemptions_for_an_unknown_invite_is_404(test_client: AsyncClient):
    r = await test_client.get("/api/v1/admin/users/invites/inv_nope/redemptions")
    assert r.status_code == 404


# ── signup_source ────────────────────────────────────────────────────


@pytest.mark.asyncio
async def test_invited_users_are_recorded_as_invited(test_client: AsyncClient, db_session):
    """``create_user`` always accepted signup_source and documented that
    the invite flow passes 'invite'; the call site never did, so every
    invited account claimed to be a self-registration."""
    token = (await _mint(test_client)).json()["inviteToken"]
    await _signup(test_client, email="sourced@example.com", token=token)

    user = await user_repo.get_user_by_email(db_session, "sourced@example.com")
    assert user.signup_source == "invite"


# ── group payload round-trip ─────────────────────────────────────────


@pytest.mark.asyncio
async def test_group_ids_survive_the_ledger_round_trip(test_client: AsyncClient, db_session):
    from backend.app.db.models import GroupORM

    db_session.add(GroupORM(id="grp_ledger", name="Ledger Team"))
    await db_session.commit()

    minted = (await _mint(
        test_client, groupIds=["grp_ledger"], allowShareableWithGroups=True,
    )).json()

    row = await invite_repo.get(db_session, minted["inviteId"])
    assert json.loads(row.group_ids) == ["grp_ledger"]
    assert row.shareable_groups_override is True

    v = (await _verify(test_client, minted["inviteToken"])).json()
    assert v["groupNames"] == ["Ledger Team"]

    await _signup(test_client, email="grouped@example.com", token=minted["inviteToken"])
    user = await user_repo.get_user_by_email(db_session, "grouped@example.com")
    from backend.app.db.repositories import group_repo
    assert "grp_ledger" in await group_repo.get_user_groups(db_session, user.id)


def test_the_migration_and_the_orm_agree():
    """Tests build their schema with ``create_all`` (the ORM); production
    builds it with Alembic. Nothing forces the two to match, so a column
    added to one and not the other passes every test here and fails on
    deploy. Apply the migration to a blank database and compare.
    """
    import importlib.util
    from pathlib import Path

    import sqlalchemy as sa
    from alembic.migration import MigrationContext
    from alembic.operations import Operations

    from backend.app.db.models import InviteORM, InviteRedemptionORM

    # Every migration touching these tables, in order. Append here when
    # you add another — that is the point of the test: a column added to
    # the ORM and not to a migration passes every other test in the suite
    # and fails on deploy.
    versions = Path(__file__).resolve().parents[1] / "alembic" / "versions"
    chain = [
        "20260727_1200_invites.py",
        "20260727_1400_invite_tokenver.py",
    ]
    migrations = []
    for name in chain:
        spec = importlib.util.spec_from_file_location(f"_m_{name}", versions / name)
        mod = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(mod)
        migrations.append(mod)

    engine = sa.create_engine("sqlite://")
    with engine.connect() as conn:
        for mod in migrations:
            with Operations.context(MigrationContext.configure(conn)):
                mod.upgrade()
        inspector = sa.inspect(conn)

        for model in (InviteORM, InviteRedemptionORM):
            migrated = {c["name"] for c in inspector.get_columns(model.__tablename__)}
            declared = {c.name for c in model.__table__.columns}
            assert migrated == declared, (
                f"{model.__tablename__}: migration has {sorted(migrated - declared)} "
                f"that the ORM does not; ORM has {sorted(declared - migrated)} "
                f"that the migration does not"
            )

        # And it must roll back cleanly, or a bad deploy cannot be undone.
        for mod in reversed(migrations):
            with Operations.context(MigrationContext.configure(conn)):
                mod.downgrade()
        assert "invites" not in sa.inspect(conn).get_table_names()


def test_corrupt_group_json_does_not_take_down_a_signup():
    """A malformed list must cost the user their groups, not their
    account — an admin can fix a missing membership, but nobody hears
    about a signup that 500'd."""
    row = InviteORM(id="inv_x", group_ids="{not json", expires_at="", created_by="a")
    assert invite_repo.group_ids_of(row) == []
    row.group_ids = '["ok", 42, null]'
    assert invite_repo.group_ids_of(row) == ["ok"]
