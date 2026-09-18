"""Ending the sessions one identity provider minted — precisely.

The primitive the disable switch never had. The properties that make it
usable at all:

* **Provider-scoped, not user-scoped.** A user's password families are
  untouched — their rows carry no ``idp_provider_id`` — so "end what
  corporate.com minted" does not sign the same person out of the
  password session in their other browser for longer than one silent
  access-token re-mint.
* **The row is the kill.** Allow-by-record makes the refresh row the
  token's licence, so stamping ``revoked_at`` means the next rotation
  is refused ``family_revoked`` — no denylist to keep complete.
* **Countable before it happens.** The confirm dialog's number comes
  from the same predicate the sweep uses.
"""
from __future__ import annotations

import time
from contextlib import asynccontextmanager

import pytest
from sqlalchemy import select

from backend.app.db import models as m
from backend.app.db.repositories import user_repo
from backend.app.db.repositories.refresh_token_repo import (
    count_active_provider_users,
    make_refresh_store,
    revoke_provider_tokens,
)
from backend.app.services.revocation_service import revoke_provider_sessions
from backend.auth_service.core import tokens as token_module
from backend.auth_service.interface import InvalidRefreshToken
from backend.auth_service.service import LocalIdentityService

PROVIDER_X = "idp_corp_x"
PROVIDER_Y = "idp_corp_y"


async def _seed_user(session, user_id: str) -> None:
    session.add(m.UserORM(
        id=user_id, email=f"{user_id}@example.com", password_hash="x",
        first_name="U", last_name="Ser", status="active",
        created_at="2024-01-01T00:00:00Z", updated_at="2024-01-01T00:00:00Z",
    ))
    await session.flush()


async def _mint(
    session, *, user_id: str, provider_id: str | None,
    family_id: str | None = None,
) -> tuple[str, object]:
    """A real signed refresh token plus the row that licenses it."""
    auth_time = int(time.time()) - 60 if provider_id else None
    token, claims = token_module.create_refresh_token(
        user_id=user_id, family_id=family_id, auth_time=auth_time,
    )
    store = make_refresh_store(session)
    await store.record_mint(
        jti=claims.jti, family_id=claims.family_id, user_id=user_id,
        auth_time=auth_time, mint_ms=claims.mint_ms,
        expires_at_iso="2099-01-01T00:00:00+00:00",
        idp_provider_id=provider_id,
        idp_checked_at=int(time.time()) if provider_id else None,
    )
    return token, claims


async def _rows_for(session, user_id: str) -> list[m.RefreshTokenORM]:
    return (await session.execute(
        select(m.RefreshTokenORM).where(m.RefreshTokenORM.user_id == user_id)
    )).scalars().all()


# ── the repo sweep ───────────────────────────────────────────────────

@pytest.mark.asyncio
async def test_the_sweep_marks_only_the_named_providers_rows(db_session):
    for uid in ("usr_a", "usr_b", "usr_c"):
        await _seed_user(db_session, uid)
    await _mint(db_session, user_id="usr_a", provider_id=PROVIDER_X)
    await _mint(db_session, user_id="usr_a", provider_id=PROVIDER_X)
    await _mint(db_session, user_id="usr_b", provider_id=PROVIDER_Y)
    await _mint(db_session, user_id="usr_c", provider_id=None)  # password

    users, rows = await revoke_provider_tokens(
        db_session, provider_id=PROVIDER_X,
    )
    assert users == {"usr_a"}
    assert rows == 2
    assert all(r.revoked_at for r in await _rows_for(db_session, "usr_a"))
    assert all(not r.revoked_at for r in await _rows_for(db_session, "usr_b"))
    assert all(not r.revoked_at for r in await _rows_for(db_session, "usr_c"))


@pytest.mark.asyncio
async def test_the_master_sweep_spares_password_families(db_session):
    for uid in ("usr_a", "usr_b", "usr_c"):
        await _seed_user(db_session, uid)
    await _mint(db_session, user_id="usr_a", provider_id=PROVIDER_X)
    await _mint(db_session, user_id="usr_b", provider_id=PROVIDER_Y)
    await _mint(db_session, user_id="usr_c", provider_id=None)

    users, rows = await revoke_provider_tokens(db_session, provider_id=None)
    assert users == {"usr_a", "usr_b"}
    assert rows == 2
    assert all(not r.revoked_at for r in await _rows_for(db_session, "usr_c"))


@pytest.mark.asyncio
async def test_the_count_means_presentable_tokens_only(db_session):
    await _seed_user(db_session, "usr_a")
    await _seed_user(db_session, "usr_b")
    # Live.
    await _mint(db_session, user_id="usr_a", provider_id=PROVIDER_X)
    # Dead three ways: revoked, consumed, expired.
    _, revoked = await _mint(db_session, user_id="usr_b", provider_id=PROVIDER_X)
    _, consumed = await _mint(db_session, user_id="usr_b", provider_id=PROVIDER_X)
    store = make_refresh_store(db_session)
    await store.revoke_family(revoked.family_id)
    row = (await db_session.execute(
        select(m.RefreshTokenORM).where(m.RefreshTokenORM.jti == consumed.jti)
    )).scalar_one()
    row.consumed_at = "2024-01-01T00:00:00+00:00"
    expired_token, expired = await _mint(
        db_session, user_id="usr_b", provider_id=PROVIDER_X,
    )
    exp_row = (await db_session.execute(
        select(m.RefreshTokenORM).where(m.RefreshTokenORM.jti == expired.jti)
    )).scalar_one()
    exp_row.expires_at = "2020-01-01T00:00:00+00:00"
    await db_session.flush()

    assert await count_active_provider_users(
        db_session, provider_id=PROVIDER_X,
    ) == 1


# ── the orchestrator ─────────────────────────────────────────────────

@pytest.mark.asyncio
async def test_the_service_reports_and_audits_the_blast_radius(db_session):
    await _seed_user(db_session, "usr_a")
    await _seed_user(db_session, "usr_b")
    await _mint(db_session, user_id="usr_a", provider_id=PROVIDER_X)
    await _mint(db_session, user_id="usr_b", provider_id=PROVIDER_X)

    outcome = await revoke_provider_sessions(
        PROVIDER_X, session=db_session, reason="provider_sessions_ended:corp",
    )
    assert outcome == {"users": 2, "tokens": 2}

    events = (await db_session.execute(
        select(m.OutboxEventORM).where(
            m.OutboxEventORM.event_type == "user.session_revoked",
        )
    )).scalars().all()
    assert len(events) == 2


# ── the refresh semantics the whole design rests on ──────────────────

@pytest.mark.asyncio
async def test_ended_families_are_refused_and_password_families_survive(
    db_session,
):
    """THE assertion: after ending provider X's sessions, X's family is
    refused at its next rotation while the same user's password family
    rotates on undisturbed — which is exactly the 'switch back to local
    accounts' story."""
    await _seed_user(db_session, "usr_a")
    sso_token, _ = await _mint(
        db_session, user_id="usr_a", provider_id=PROVIDER_X,
    )
    pwd_token, _ = await _mint(db_session, user_id="usr_a", provider_id=None)

    await revoke_provider_sessions(
        PROVIDER_X, session=db_session, reason="provider_sessions_ended:corp",
    )

    @asynccontextmanager
    async def _factory():
        yield db_session

    svc = LocalIdentityService(
        session_factory=_factory,
        user_repo=user_repo,
        refresh_store_factory=make_refresh_store,
    )
    with pytest.raises(InvalidRefreshToken):
        await svc.refresh(sso_token, ambient_cookies={})

    user, tokens = await svc.refresh(pwd_token, ambient_cookies={})
    assert user.id == "usr_a"
    assert tokens.refresh_token


# ── the endpoints ────────────────────────────────────────────────────

async def _make_provider_row(db_session, slug="corp-x", pid=PROVIDER_X):
    db_session.add(m.IdpProviderORM(
        id=pid, slug=slug, display_name="Corp X", kind="backchannel",
        enabled=True,
    ))
    await db_session.commit()


@pytest.mark.asyncio
async def test_dry_run_counts_and_writes_nothing(test_client, db_session):
    await _seed_user(db_session, "usr_a")
    await _make_provider_row(db_session)
    await _mint(db_session, user_id="usr_a", provider_id=PROVIDER_X)
    await db_session.commit()

    resp = await test_client.post(
        f"/api/v1/admin/idp-providers/{PROVIDER_X}/end-sessions",
        json={"dryRun": True},
    )
    assert resp.status_code == 200, resp.text
    body = resp.json()
    assert body["usersAffected"] == 1
    assert body["tokensRevoked"] == 0
    assert body["dryRun"] is True
    assert all(not r.revoked_at for r in await _rows_for(db_session, "usr_a"))


@pytest.mark.asyncio
async def test_the_real_run_ends_sessions_and_audits(test_client, db_session):
    await _seed_user(db_session, "usr_a")
    await _make_provider_row(db_session)
    await _mint(db_session, user_id="usr_a", provider_id=PROVIDER_X)
    await db_session.commit()

    resp = await test_client.post(
        f"/api/v1/admin/idp-providers/{PROVIDER_X}/end-sessions", json={},
    )
    assert resp.status_code == 200, resp.text
    body = resp.json()
    assert body["usersAffected"] == 1
    assert body["tokensRevoked"] == 1
    assert all(r.revoked_at for r in await _rows_for(db_session, "usr_a"))

    events = (await db_session.execute(
        select(m.OutboxEventORM).where(
            m.OutboxEventORM.event_type == "idp.provider.sessions_ended",
        )
    )).scalars().all()
    assert len(events) == 1


@pytest.mark.asyncio
async def test_unknown_provider_is_a_404(test_client, db_session):
    resp = await test_client.post(
        "/api/v1/admin/idp-providers/idp_nope/end-sessions", json={},
    )
    assert resp.status_code == 404


@pytest.mark.asyncio
async def test_the_platform_sweep_endpoint_covers_every_sso_row(
    test_client, db_session,
):
    """And is callable with the master switch already off — that is the
    moment an operator reaches for it."""
    await _seed_user(db_session, "usr_a")
    await _seed_user(db_session, "usr_c")
    await _make_provider_row(db_session)
    await _mint(db_session, user_id="usr_a", provider_id=PROVIDER_X)
    await _mint(db_session, user_id="usr_c", provider_id=None)
    await db_session.commit()

    off = await test_client.patch(
        "/api/v1/admin/sso/config", json={"ssoEnabled": False},
    )
    assert off.status_code == 200, off.text

    dry = await test_client.post(
        "/api/v1/admin/sso/config/end-sso-sessions", json={"dryRun": True},
    )
    assert dry.status_code == 200, dry.text
    assert dry.json()["usersAffected"] == 1

    real = await test_client.post(
        "/api/v1/admin/sso/config/end-sso-sessions", json={},
    )
    assert real.status_code == 200, real.text
    assert real.json()["usersAffected"] == 1
    assert all(r.revoked_at for r in await _rows_for(db_session, "usr_a"))
    assert all(not r.revoked_at for r in await _rows_for(db_session, "usr_c"))


# ── the everyone sweep (end-all-sessions) ────────────────────────────


@pytest.mark.asyncio
async def test_revoke_all_tokens_spares_system_accounts(db_session):
    """The platform sweep marks password AND SSO rows — and skips every
    row belonging to a system account, whatever kind it is."""
    from backend.app.db.repositories.refresh_token_repo import (
        count_active_users,
        revoke_all_tokens,
    )

    for uid in ("usr_pw", "usr_sso", "usr_sys"):
        await _seed_user(db_session, uid)
    await user_repo.set_system_account(db_session, "usr_sys", True)
    await _mint(db_session, user_id="usr_pw", provider_id=None)
    await _mint(db_session, user_id="usr_sso", provider_id=PROVIDER_X)
    await _mint(db_session, user_id="usr_sys", provider_id=None)
    await _mint(db_session, user_id="usr_sys", provider_id=PROVIDER_X)

    system_ids = await user_repo.system_account_ids(db_session)
    assert system_ids == {"usr_sys"}
    assert await count_active_users(db_session) == 3
    assert await count_active_users(
        db_session, exclude_user_ids=system_ids,
    ) == 2

    users, rows = await revoke_all_tokens(
        db_session, exclude_user_ids=system_ids,
    )
    assert users == {"usr_pw", "usr_sso"}
    assert rows == 2
    assert all(r.revoked_at for r in await _rows_for(db_session, "usr_pw"))
    assert all(r.revoked_at for r in await _rows_for(db_session, "usr_sso"))
    assert all(not r.revoked_at for r in await _rows_for(db_session, "usr_sys"))


@pytest.mark.asyncio
async def test_the_bulk_cutoff_stamps_everyone_but_system_accounts(db_session):
    """The rotation half of the pair: every non-deleted user gets
    ``sessions_valid_from``, except the excluded system accounts."""
    for uid in ("usr_pw", "usr_sys"):
        await _seed_user(db_session, uid)
    await user_repo.set_system_account(db_session, "usr_sys", True)

    cutoff = await user_repo.revoke_sessions_from_now_for_all(
        db_session,
        exclude_user_ids=await user_repo.system_account_ids(db_session),
    )
    assert cutoff

    ordinary = (await db_session.execute(
        select(m.UserORM).where(m.UserORM.id == "usr_pw")
    )).scalar_one()
    system = (await db_session.execute(
        select(m.UserORM).where(m.UserORM.id == "usr_sys")
    )).scalar_one()
    assert ordinary.sessions_valid_from == cutoff
    assert system.sessions_valid_from is None


@pytest.mark.asyncio
async def test_end_all_sessions_endpoint_counts_sweeps_and_audits(
    test_client, db_session,
):
    """Dry run answers the dialog (affected + how many system accounts
    stay signed in) and writes nothing; the real run stamps rows and the
    per-user cutoff, spares the system account, and leaves one audit
    event."""
    await _seed_user(db_session, "usr_a")
    await _seed_user(db_session, "usr_sys")
    await user_repo.set_system_account(db_session, "usr_sys", True)
    await _make_provider_row(db_session)
    await _mint(db_session, user_id="usr_a", provider_id=PROVIDER_X)
    await _mint(db_session, user_id="usr_a", provider_id=None)
    await _mint(db_session, user_id="usr_sys", provider_id=None)
    await db_session.commit()

    dry = await test_client.post(
        "/api/v1/admin/sso/config/end-all-sessions", json={"dryRun": True},
    )
    assert dry.status_code == 200, dry.text
    body = dry.json()
    assert body["usersAffected"] == 1
    assert body["systemAccountsSkipped"] == 1
    assert body["tokensRevoked"] == 0
    assert body["dryRun"] is True
    assert all(not r.revoked_at for r in await _rows_for(db_session, "usr_a"))

    real = await test_client.post(
        "/api/v1/admin/sso/config/end-all-sessions", json={},
    )
    assert real.status_code == 200, real.text
    body = real.json()
    assert body["usersAffected"] == 1
    assert body["tokensRevoked"] == 2
    assert body["systemAccountsSkipped"] == 1
    assert all(r.revoked_at for r in await _rows_for(db_session, "usr_a"))
    assert all(not r.revoked_at for r in await _rows_for(db_session, "usr_sys"))

    ordinary = (await db_session.execute(
        select(m.UserORM).where(m.UserORM.id == "usr_a")
    )).scalar_one()
    system = (await db_session.execute(
        select(m.UserORM).where(m.UserORM.id == "usr_sys")
    )).scalar_one()
    assert ordinary.sessions_valid_from is not None
    assert system.sessions_valid_from is None

    events = (await db_session.execute(
        select(m.OutboxEventORM).where(
            m.OutboxEventORM.event_type == "auth.config.all_sessions_ended",
        )
    )).scalars().all()
    assert len(events) == 1
