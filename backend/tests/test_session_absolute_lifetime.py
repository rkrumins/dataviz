"""A session cannot outlive its ceilings, however often it rotates.

Rotation mints a brand-new refresh token on every use, with a fresh
``JWT_REFRESH_EXPIRY_DAYS`` window, and nothing looked at when the
family started. So the 7-day refresh TTL bounded a *token*, never a
*session*: any session that rotated at least once a week lived
indefinitely. A refresh cookie exfiltrated once was a permanent
credential, and the only thing that could end it was an explicit
revocation nobody had a reason to perform.

The SSO ceiling did not cover this. It fires only when ``auth_time`` is
set, and local password logins deliberately leave it NULL — so the
sessions with no IdP conditional access in front of them were precisely
the ones with no ceiling.

Two bounds, because they answer different questions: ABSOLUTE caps a
single sign-in from the family's first mint, IDLE caps an unused one
from the previous rotation.

Uses a file-backed engine for the same reason
``test_auth_refresh_records`` does — the shared in-memory fixture puts
every session on one connection, so committed state cannot be observed.
"""
from __future__ import annotations

import time
from contextlib import asynccontextmanager

import pytest
import pytest_asyncio
from sqlalchemy import event, select
from sqlalchemy.ext.asyncio import async_sessionmaker, create_async_engine

from backend.app.auth.password import hash_password
from backend.app.db.models import Base, RefreshTokenORM
from backend.app.db.repositories import user_repo
from backend.app.db.repositories.refresh_token_repo import make_refresh_store
from backend.auth_service.service import (
    InvalidRefreshToken,
    LocalIdentityService,
)

_PASSWORD = "C0mpl3x!Passw0rd#"


@pytest_asyncio.fixture()
async def real_engine(tmp_path):
    engine = create_async_engine(f"sqlite+aiosqlite:///{tmp_path / 'life.db'}")
    agg_path = tmp_path / "aggregation.db"

    @event.listens_for(engine.sync_engine, "connect")
    def _connect(dbapi_conn, _rec):
        dbapi_conn.execute(f"ATTACH DATABASE '{agg_path}' AS aggregation")
        dbapi_conn.isolation_level = None
        dbapi_conn.execute("PRAGMA busy_timeout = 5000")

    @event.listens_for(engine.sync_engine, "begin")
    def _begin(conn):
        conn.exec_driver_sql("BEGIN IMMEDIATE")

    async with engine.begin() as conn:
        await conn.run_sync(Base.metadata.create_all)
    yield engine
    await engine.dispose()


@pytest_asyncio.fixture()
async def factory(real_engine):
    maker = async_sessionmaker(bind=real_engine, expire_on_commit=False)

    @asynccontextmanager
    async def _factory():
        session = maker()
        try:
            try:
                yield session
                await session.commit()
            except Exception:
                await session.rollback()
                raise
        finally:
            await session.close()

    return _factory


@pytest_asyncio.fixture()
async def service(factory):
    return LocalIdentityService(
        session_factory=factory,
        user_repo=user_repo,
        refresh_store_factory=make_refresh_store,
    )


@pytest.fixture(autouse=True)
def _no_adoption(monkeypatch):
    """Allow-by-record, so a refused token is not silently re-adopted."""
    monkeypatch.setattr(
        "backend.auth_service.service.REFRESH_ADOPT_RECORDLESS", False,
    )


async def _seed(factory, email="life@example.com") -> str:
    async with factory() as session:
        user = await user_repo.create_user(
            session, email=email,
            password_hash=hash_password(_PASSWORD),
            first_name="Life", last_name="Time", status="active",
        )
        return user.id


async def _age_family(real_engine, *, by_seconds: int) -> None:
    """Backdate every row in the family, simulating elapsed time.

    Rewriting the stored mint instants rather than sleeping: the bounds
    are hours, and freezing the clock would have to cover both the
    service and the store.
    """
    maker = async_sessionmaker(bind=real_engine, expire_on_commit=False)
    async with maker() as session:
        for row in (await session.execute(select(RefreshTokenORM))).scalars():
            row.mint_ms = row.mint_ms - by_seconds * 1000
        await session.commit()


# ── Absolute ceiling ─────────────────────────────────────────────────

async def test_a_session_past_the_absolute_ceiling_cannot_rotate(
    service, factory, real_engine, monkeypatch,
):
    monkeypatch.setattr(
        "backend.auth_service.service.SESSION_ABSOLUTE_MAX_SECONDS", 3600,
    )
    monkeypatch.setattr(
        "backend.auth_service.service.SESSION_IDLE_MAX_SECONDS", 0,
    )
    await _seed(factory)
    _user, tokens = await service.login("life@example.com", _PASSWORD)

    await _age_family(real_engine, by_seconds=3601)

    with pytest.raises(InvalidRefreshToken) as err:
        await service.refresh(tokens.refresh_token)
    assert "session_expired" in str(err.value)


async def test_rotation_does_not_reset_the_absolute_clock(
    service, factory, real_engine, monkeypatch,
):
    """The defect in one assertion.

    Each rotation minted a token with a fresh 7-day window, so the only
    thing bounding the session was the newest token's own expiry. Here
    the family is aged past the ceiling and then rotated once
    successfully before the ceiling applies — proving the measurement
    survives a rotation rather than restarting with it.
    """
    monkeypatch.setattr(
        "backend.auth_service.service.SESSION_ABSOLUTE_MAX_SECONDS", 3600,
    )
    monkeypatch.setattr(
        "backend.auth_service.service.SESSION_IDLE_MAX_SECONDS", 0,
    )
    await _seed(factory)
    _user, tokens = await service.login("life@example.com", _PASSWORD)

    # Half an hour in: still fine, and this rotation writes a NEW row
    # whose own mint is now.
    await _age_family(real_engine, by_seconds=1800)
    _user, rotated = await service.refresh(tokens.refresh_token)

    # Another 45 minutes. The newest token is minutes old; the FAMILY is
    # past the ceiling, and that is what has to decide.
    await _age_family(real_engine, by_seconds=2700)
    with pytest.raises(InvalidRefreshToken) as err:
        await service.refresh(rotated.refresh_token)
    assert "session_expired" in str(err.value)


async def test_a_session_inside_the_absolute_ceiling_still_rotates(
    service, factory, real_engine, monkeypatch,
):
    monkeypatch.setattr(
        "backend.auth_service.service.SESSION_ABSOLUTE_MAX_SECONDS", 3600,
    )
    monkeypatch.setattr(
        "backend.auth_service.service.SESSION_IDLE_MAX_SECONDS", 0,
    )
    await _seed(factory)
    _user, tokens = await service.login("life@example.com", _PASSWORD)
    await _age_family(real_engine, by_seconds=60)

    _user, rotated = await service.refresh(tokens.refresh_token)
    assert rotated.refresh_token != tokens.refresh_token


# ── Idle ceiling ─────────────────────────────────────────────────────

async def test_an_idle_session_cannot_rotate(
    service, factory, real_engine, monkeypatch,
):
    monkeypatch.setattr(
        "backend.auth_service.service.SESSION_ABSOLUTE_MAX_SECONDS", 0,
    )
    monkeypatch.setattr(
        "backend.auth_service.service.SESSION_IDLE_MAX_SECONDS", 600,
    )
    await _seed(factory)
    _user, tokens = await service.login("life@example.com", _PASSWORD)

    await _age_family(real_engine, by_seconds=601)

    with pytest.raises(InvalidRefreshToken) as err:
        await service.refresh(tokens.refresh_token)
    assert "session_idle" in str(err.value)


async def test_activity_resets_the_idle_clock(
    service, factory, real_engine, monkeypatch,
):
    """Idle is measured from the LAST rotation, unlike absolute."""
    monkeypatch.setattr(
        "backend.auth_service.service.SESSION_ABSOLUTE_MAX_SECONDS", 0,
    )
    monkeypatch.setattr(
        "backend.auth_service.service.SESSION_IDLE_MAX_SECONDS", 600,
    )
    await _seed(factory)
    _user, tokens = await service.login("life@example.com", _PASSWORD)

    await _age_family(real_engine, by_seconds=300)
    _user, rotated = await service.refresh(tokens.refresh_token)   # activity

    # 5 more minutes since that rotation — under the bound, even though
    # the session is now 10 minutes old.
    await _age_family(real_engine, by_seconds=300)
    _user, again = await service.refresh(rotated.refresh_token)
    assert again.refresh_token != rotated.refresh_token


# ── Disabling ────────────────────────────────────────────────────────

async def test_zero_disables_both_bounds(
    service, factory, real_engine, monkeypatch,
):
    """A deployment that has accepted the old behaviour keeps it."""
    monkeypatch.setattr(
        "backend.auth_service.service.SESSION_ABSOLUTE_MAX_SECONDS", 0,
    )
    monkeypatch.setattr(
        "backend.auth_service.service.SESSION_IDLE_MAX_SECONDS", 0,
    )
    await _seed(factory)
    _user, tokens = await service.login("life@example.com", _PASSWORD)

    await _age_family(real_engine, by_seconds=86400 * 365)
    _user, rotated = await service.refresh(tokens.refresh_token)
    assert rotated.refresh_token != tokens.refresh_token


# ── The shipped defaults ─────────────────────────────────────────────

def test_the_defaults_are_the_agreed_policy():
    """12h idle / 7d absolute, so a change is a deliberate one."""
    from backend.auth_service.core import config

    assert config.SESSION_IDLE_MAX_SECONDS == 12 * 3600
    assert config.SESSION_ABSOLUTE_MAX_SECONDS == 168 * 3600
