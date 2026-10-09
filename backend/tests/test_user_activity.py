"""When someone last used the platform — Joined, Last signed in, Last seen,
Last activity in Admin → Users.

Password sign-ins recorded no timestamp anywhere, SSO ones only on the
identity row, and nothing recorded a visit at all. Each is now one column on
``users``, written on paths that run constantly — every sign-in, every
authenticated request, every product event — so what these pin is as much
the COST as the value: one conditional row update per person per window,
never a write per call, and never a bump to ``updated_at``.
"""
from __future__ import annotations

from contextlib import asynccontextmanager
from datetime import datetime, timedelta, timezone

import pytest
from httpx import AsyncClient
from sqlalchemy import select, update

from backend.app.auth.password import hash_password
from backend.app.db.models import UserORM
from backend.app.db.repositories import (
    idp_provider_repo,
    product_event_repo,
    user_identity_repo,
    user_repo,
)
from backend.app.db.repositories.refresh_token_repo import make_refresh_store
from backend.auth_service.activity import RESOLUTION_SECONDS
from backend.auth_service.providers.base import ProviderIdentity
from backend.auth_service.service import LocalIdentityService

_PASSWORD = "C0mpl3x!Passw0rd#"
_LONG_AGO = "2020-01-01T00:00:00+00:00"


async def _row(db_session, user_id: str) -> UserORM:
    db_session.expire_all()
    return (await db_session.execute(
        select(UserORM).where(UserORM.id == user_id)
    )).scalar_one()


async def _backdate(db_session, user_id: str, **values) -> None:
    """Rewind activity columns without bumping ``updated_at`` — an ORM edit
    would fire its ``onupdate`` and muddy the assertion that the touches
    themselves leave it alone."""
    await db_session.execute(
        update(UserORM).where(UserORM.id == user_id)
        .values(**values, updated_at=UserORM.updated_at)
    )
    await db_session.commit()


async def _seed(db_session, email: str) -> str:
    user = await user_repo.create_user(
        db_session, email=email, password_hash=hash_password(_PASSWORD),
        first_name="Act", last_name="Ivity", status="active",
    )
    user.updated_at = _LONG_AGO
    await db_session.commit()
    return user.id


def _service(db_session) -> LocalIdentityService:
    @asynccontextmanager
    async def _factory():
        yield db_session

    return LocalIdentityService(
        session_factory=_factory,
        user_repo=user_repo,
        user_identity_repo=user_identity_repo,
        refresh_store_factory=make_refresh_store,
    )


# ── the repo writes ──────────────────────────────────────────────────


async def test_a_sign_in_stamps_signed_in_and_seen_but_not_updated(db_session):
    uid = await _seed(db_session, "stamp@activity.example")

    await user_repo.touch_last_login(db_session, uid)

    row = await _row(db_session, uid)
    assert row.last_login_at is not None
    assert row.last_seen_at == row.last_login_at
    # A sign-in is not an edit to the account.
    assert row.updated_at == _LONG_AGO


async def test_seen_is_written_once_per_window(db_session):
    uid = await _seed(db_session, "window@activity.example")

    await user_repo.touch_last_seen(
        db_session, uid, resolution_seconds=RESOLUTION_SECONDS,
    )
    first = (await _row(db_session, uid)).last_seen_at
    await user_repo.touch_last_seen(
        db_session, uid, resolution_seconds=RESOLUTION_SECONDS,
    )
    assert (await _row(db_session, uid)).last_seen_at == first

    # Past the window, it moves.
    stale = (datetime.now(timezone.utc) - timedelta(seconds=RESOLUTION_SECONDS + 5))
    await _backdate(db_session, uid, last_seen_at=stale.isoformat())
    await user_repo.touch_last_seen(
        db_session, uid, resolution_seconds=RESOLUTION_SECONDS,
    )
    assert (await _row(db_session, uid)).last_seen_at > stale.isoformat()
    assert (await _row(db_session, uid)).updated_at == _LONG_AGO


# ── last signed in: every kind of sign-in ────────────────────────────


async def test_a_password_sign_in_is_recorded(
    test_client: AsyncClient, db_session,
):
    uid = await _seed(db_session, "pw@activity.example")

    resp = await test_client.post(
        "/api/v1/auth/login",
        json={"email": "pw@activity.example", "password": _PASSWORD},
    )
    assert resp.status_code == 200, resp.text

    assert (await _row(db_session, uid)).last_login_at is not None


async def test_an_sso_sign_in_is_recorded(db_session):
    provider = await idp_provider_repo.create_provider(
        db_session, slug="act-oidc", display_name="Act", kind="oidc",
        settings={"issuer": "https://idp", "client_id": "c",
                  "client_secret": "s", "redirect_uri": "https://app/cb"},
        claim_mapping={}, linking_policy="strict",
    )
    await db_session.flush()

    user, _tokens = await _service(db_session).complete_sso_login(
        ProviderIdentity(
            provider="oidc", external_id="sub-act", email="sso@activity.example",
            first_name="S", last_name="O", raw_claims={"email_verified": True},
        ),
        provider_id=provider.id, provider_slug=provider.slug,
        linking_policy="strict",
    )

    assert (await _row(db_session, user.id)).last_login_at is not None


async def test_a_renewal_is_not_a_sign_in(db_session):
    uid = await _seed(db_session, "renew@activity.example")
    svc = _service(db_session)
    _user, tokens = await svc.login("renew@activity.example", _PASSWORD)
    await _backdate(db_session, uid, last_login_at=_LONG_AGO)

    await svc.refresh(tokens.refresh_token)

    assert (await _row(db_session, uid)).last_login_at == _LONG_AGO


# ── last seen: every authenticated request, gated ────────────────────


async def test_an_authenticated_request_is_seen_once_per_window(db_session):
    uid = await _seed(db_session, "seen@activity.example")
    svc = _service(db_session)
    _user, tokens = await svc.login("seen@activity.example", _PASSWORD)
    await _backdate(db_session, uid, last_seen_at=_LONG_AGO)

    assert await svc.validate_session(tokens.access_token) is not None
    seen = (await _row(db_session, uid)).last_seen_at
    assert seen > _LONG_AGO

    # Inside the window the process gate holds: no write at all, even
    # though the row has been put back — this is every request.
    await _backdate(db_session, uid, last_seen_at=_LONG_AGO)
    assert await svc.validate_session(tokens.access_token) is not None
    assert (await _row(db_session, uid)).last_seen_at == _LONG_AGO


# ── last activity: what Activity analytics counts ────────────────────


async def test_a_product_event_is_activity(db_session):
    uid = await _seed(db_session, "active@activity.example")

    await product_event_repo.record(
        db_session, event_type="graph.search", actor_id=uid, payload=None,
    )
    await db_session.commit()

    row = await _row(db_session, uid)
    assert row.last_active_at is not None
    assert row.updated_at == _LONG_AGO


async def test_an_event_without_an_actor_touches_nobody(db_session):
    await product_event_repo.record(
        db_session, event_type="docs.search_miss", actor_id=None, payload=None,
    )
    await db_session.commit()


# ── Admin → Users ────────────────────────────────────────────────────


async def test_the_admin_list_reports_and_sorts_by_last_seen(
    test_client: AsyncClient, db_session,
):
    def _user(uid, seen):
        return UserORM(
            id=uid, email=f"{uid}@lastseen.example", password_hash="x",
            first_name="L", last_name="S", status="active",
            created_at=_LONG_AGO, updated_at=_LONG_AGO,
            last_seen_at=seen, last_login_at=seen, last_active_at=seen,
        )

    db_session.add_all([
        _user("usr_seen_old", "2026-01-01T00:00:00+00:00"),
        _user("usr_seen_new", "2026-09-01T00:00:00+00:00"),
        _user("usr_seen_never", None),
    ])
    await db_session.commit()

    for order, expected in (
        ("desc", ["new", "old", "never"]),
        # Never-seen accounts sort last in BOTH directions.
        ("asc", ["old", "new", "never"]),
    ):
        resp = await test_client.get(
            "/api/v1/admin/users",
            params={"search": "lastseen.example", "sort": "lastSeenAt",
                    "order": order},
        )
        assert resp.status_code == 200, resp.text
        assert [u["id"].removeprefix("usr_seen_") for u in resp.json()] == expected

    by_id = {u["id"]: u for u in resp.json()}
    assert by_id["usr_seen_new"]["lastSeenAt"] == "2026-09-01T00:00:00+00:00"
    assert by_id["usr_seen_new"]["lastLoginAt"] == "2026-09-01T00:00:00+00:00"
    assert by_id["usr_seen_new"]["lastActiveAt"] == "2026-09-01T00:00:00+00:00"
    assert by_id["usr_seen_never"]["lastSeenAt"] is None


@pytest.mark.parametrize("sort", ["lastSeenAt", "lastLoginAt"])
async def test_the_new_sorts_are_accepted(test_client: AsyncClient, sort):
    resp = await test_client.get("/api/v1/admin/users", params={"sort": sort})
    assert resp.status_code == 200, resp.text
