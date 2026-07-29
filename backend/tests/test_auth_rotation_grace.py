"""The rotation grace window, against real transactions.

Refresh-token rotation used to treat any re-presented ``jti`` as a
stolen-chain replay and revoke the whole family. Two tabs refreshing on
the same cookie milliseconds apart was enough to sign a user out
everywhere — and because the winner kept working for the life of its
access token, the logout landed minutes later with no visible cause.

These tests need a file-backed engine for the same reason
``test_auth_revocation_durability`` does: the shared in-memory fixture
puts every session on one StaticPool connection, so there is no second
transaction and nothing to race. The fixtures are duplicated rather than
shared because the two modules pin the grace window to opposite values,
and a shared fixture module would hide that.
"""
from __future__ import annotations

import asyncio
from contextlib import asynccontextmanager

import pytest
import pytest_asyncio
from sqlalchemy import event, select
from sqlalchemy.ext.asyncio import async_sessionmaker, create_async_engine

from backend.app.auth.password import hash_password
from backend.app.db.models import Base, RevokedRefreshJtiORM
from backend.app.db.repositories import user_repo
from backend.app.db.repositories.refresh_token_repo import make_refresh_store
from backend.auth_service.core.tokens import decode_refresh_token
from backend.auth_service.service import (
    InvalidRefreshToken,
    LocalIdentityService,
)


_PASSWORD = "C0mpl3x!Passw0rd#"
_FAMILY_SENTINEL_PREFIX = "family-revoked:"


@pytest_asyncio.fixture()
async def real_engine(tmp_path):
    engine = create_async_engine(f"sqlite+aiosqlite:///{tmp_path / 'grace.db'}")
    agg_path = tmp_path / "aggregation.db"

    @event.listens_for(engine.sync_engine, "connect")
    def _connect(dbapi_conn, _rec):
        dbapi_conn.execute(f"ATTACH DATABASE '{agg_path}' AS aggregation")
        # See test_auth_revocation_durability for why this is required.
        dbapi_conn.isolation_level = None
        # SQLite takes one writer at a time and, by default, the loser
        # fails instantly with "database is locked". Postgres — where
        # this runs in production — makes it block on the primary key
        # until the winner commits, which is precisely the behaviour the
        # grace window relies on. Waiting reproduces that; without it
        # the concurrency test measures SQLite, not the code.
        dbapi_conn.execute("PRAGMA busy_timeout = 5000")

    @event.listens_for(engine.sync_engine, "begin")
    def _begin(conn):
        # IMMEDIATE takes the write lock up front. Deferred transactions
        # would let both racers acquire read locks and then deadlock on
        # the upgrade, which busy_timeout cannot resolve.
        conn.exec_driver_sql("BEGIN IMMEDIATE")

    async with engine.begin() as conn:
        await conn.run_sync(Base.metadata.create_all)
    yield engine
    await engine.dispose()


@pytest_asyncio.fixture()
async def scoped_session_factory(real_engine):
    maker = async_sessionmaker(bind=real_engine, expire_on_commit=False)

    @asynccontextmanager
    async def factory():
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

    return factory


@pytest_asyncio.fixture()
async def service(scoped_session_factory):
    return LocalIdentityService(
        session_factory=scoped_session_factory,
        user_repo=user_repo,
        refresh_store_factory=make_refresh_store,
    )


async def _seed_user(factory, email="grace@example.com") -> str:
    async with factory() as session:
        user = await user_repo.create_user(
            session,
            email=email,
            password_hash=hash_password(_PASSWORD),
            first_name="Grace",
            last_name="Window",
            status="active",
        )
        await user_repo.assign_role(session, user.id, "super_admin")
        return user.id


async def _family_sentinels(real_engine) -> list[str]:
    maker = async_sessionmaker(bind=real_engine, expire_on_commit=False)
    async with maker() as session:
        rows = (await session.execute(select(RevokedRefreshJtiORM.jti))).scalars()
        return [j for j in rows if j.startswith(_FAMILY_SENTINEL_PREFIX)]


async def test_replay_inside_grace_returns_the_same_successor(
    service, scoped_session_factory, real_engine,
):
    """A second refresh on the same token converges rather than killing it."""
    await _seed_user(scoped_session_factory)
    _, tokens = await service.login("grace@example.com", _PASSWORD)

    _, first = await service.refresh(tokens.refresh_token)
    _, replayed = await service.refresh(tokens.refresh_token)

    first_jti = decode_refresh_token(first.refresh_token).jti
    replay_jti = decode_refresh_token(replayed.refresh_token).jti
    assert first_jti == replay_jti, "racers must converge on one successor"

    assert not await _family_sentinels(real_engine), (
        "a concurrent refresh was mistaken for a stolen chain"
    )

    # The shared successor still rotates — the session is fully intact.
    _, third = await service.refresh(replayed.refresh_token)
    assert decode_refresh_token(third.refresh_token).jti != first_jti


async def test_concurrent_refreshes_both_succeed(
    service, scoped_session_factory, real_engine,
):
    """The real shape of the bug: two tabs refreshing at once.

    Both callers present the same cookie simultaneously. Before the
    change one of them was recorded as a replay and the family died.
    """
    await _seed_user(scoped_session_factory, "concurrent@example.com")
    _, tokens = await service.login("concurrent@example.com", _PASSWORD)

    results = await asyncio.gather(
        service.refresh(tokens.refresh_token),
        service.refresh(tokens.refresh_token),
        return_exceptions=True,
    )

    failures = [r for r in results if isinstance(r, BaseException)]
    assert not failures, f"a concurrent refresh was rejected: {failures}"

    jtis = {decode_refresh_token(t.refresh_token).jti for _, t in results}
    assert len(jtis) == 1, f"racers diverged onto separate tokens: {jtis}"
    assert not await _family_sentinels(real_engine)


async def test_replay_outside_grace_still_kills_the_family(
    service, scoped_session_factory, real_engine, monkeypatch,
):
    """The window is a window, not an amnesty.

    A token replayed after it closes is still treated as theft — which
    is the property the whole rotation scheme exists to provide.
    """
    await _seed_user(scoped_session_factory, "thief@example.com")
    _, tokens = await service.login("thief@example.com", _PASSWORD)
    _, rotated = await service.refresh(tokens.refresh_token)

    # Close the window rather than sleeping through it.
    monkeypatch.setattr(
        "backend.auth_service.service.REFRESH_ROTATION_GRACE_SECONDS", 0,
    )

    with pytest.raises(InvalidRefreshToken) as exc:
        await service.refresh(tokens.refresh_token)
    assert "reuse_detected" in str(exc.value)

    assert await _family_sentinels(real_engine), "family was not revoked"

    with pytest.raises(InvalidRefreshToken) as exc:
        await service.refresh(rotated.refresh_token)
    assert "family_revoked" in str(exc.value)


async def test_grace_does_not_resurrect_a_revoked_family(
    service, scoped_session_factory,
):
    """Logout must win over the grace window.

    The family check runs before the claim, so a logged-out session
    cannot refresh its way back in during the window.
    """
    await _seed_user(scoped_session_factory, "loggedout@example.com")
    _, tokens = await service.login("loggedout@example.com", _PASSWORD)
    await service.logout(tokens.refresh_token)

    with pytest.raises(InvalidRefreshToken) as exc:
        await service.refresh(tokens.refresh_token)
    assert "family_revoked" in str(exc.value)
