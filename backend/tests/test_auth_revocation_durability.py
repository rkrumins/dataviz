"""Refresh-family revocation must survive the caller's rollback.

Every path in ``LocalIdentityService.refresh`` that rejects a token
revokes the family and then raises. The request-scoped session is rolled
back on the way out (``backend/app/db/engine.py`` ``_session_scope``:
``except Exception: await session.rollback(); raise``), so a revocation
written into that session never reached the database. Reuse detection,
the inactive-user check, the ``sessions_valid_from`` cutoff and the SSO
daily ceiling all revoked into thin air.

**Why this module carries its own engine.** The shared ``db_engine``
fixture in ``conftest.py`` is ``sqlite+aiosqlite://`` — an in-memory
database, which SQLAlchemy backs with a ``StaticPool``. Every session
built on it checks out the *same* DBAPI connection, so "open a second
session" is not a second transaction and there is no independent
rollback to survive. A test written against that engine passes whether
or not the bug is present. These tests use a file-backed SQLite database
so each session gets a real connection and a real transaction, which is
the only way the property under test is observable at all.
"""
from __future__ import annotations

from contextlib import asynccontextmanager

import pytest
import pytest_asyncio
from sqlalchemy import event, select
from sqlalchemy.ext.asyncio import async_sessionmaker, create_async_engine

from backend.app.auth.password import hash_password
from backend.app.db.models import Base, RevokedRefreshJtiORM
from backend.app.db.repositories import user_repo
from backend.app.db.repositories.refresh_token_repo import make_refresh_store
from backend.auth_service.service import (
    InvalidRefreshToken,
    LocalIdentityService,
)


_PASSWORD = "C0mpl3x!Passw0rd#"
_FAMILY_SENTINEL_PREFIX = "family-revoked:"


@pytest_asyncio.fixture()
async def real_engine(tmp_path):
    """File-backed SQLite so sessions get independent connections."""
    engine = create_async_engine(f"sqlite+aiosqlite:///{tmp_path / 'auth.db'}")

    # Same trick as the shared ``db_engine`` fixture: some production
    # models declare ``__table_args__ = ({"schema": "aggregation"},)``
    # for Postgres, and SQLite resolves ``aggregation.<table>`` only
    # against an attached database. Every connection needs its own.
    agg_path = tmp_path / "aggregation.db"

    @event.listens_for(engine.sync_engine, "connect")
    def _attach_aggregation_schema(dbapi_conn, _connection_record):
        dbapi_conn.execute(f"ATTACH DATABASE '{agg_path}' AS aggregation")
        # pysqlite/aiosqlite ships an implicit-transaction mode that
        # COMMITs before a SAVEPOINT and never opens a transaction for
        # plain DML. Under it a rollback has nothing to undo, so a write
        # made in a doomed transaction persists anyway and this whole
        # module would pass with the bug present — which is exactly what
        # happened on the first cut. This is SQLAlchemy's documented
        # workaround ("Serializable isolation / Savepoints / Transactional
        # DDL" in the SQLite dialect docs); Postgres needs none of it.
        dbapi_conn.isolation_level = None

    @event.listens_for(engine.sync_engine, "begin")
    def _emit_begin(conn):
        conn.exec_driver_sql("BEGIN")

    async with engine.begin() as conn:
        await conn.run_sync(Base.metadata.create_all)
    yield engine
    await engine.dispose()


@pytest_asyncio.fixture()
async def scoped_session_factory(real_engine):
    """A faithful copy of production's ``_session_scope``.

    Commit on success, roll back on exception — the behaviour that
    discards a revocation written into the request session.
    """
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


async def _seed_user(scoped_session_factory, email="durable@example.com") -> str:
    async with scoped_session_factory() as session:
        user = await user_repo.create_user(
            session,
            email=email,
            password_hash=hash_password(_PASSWORD),
            first_name="Durable",
            last_name="Tester",
            status="active",
        )
        await user_repo.assign_role(session, user.id, "super_admin")
        return user.id


async def _revoked_rows(real_engine) -> list[str]:
    """Read the revocation table on a connection of its own.

    Reading through the same session that wrote would see uncommitted
    state and defeat the point.
    """
    maker = async_sessionmaker(bind=real_engine, expire_on_commit=False)
    async with maker() as session:
        result = await session.execute(select(RevokedRefreshJtiORM.jti))
        return list(result.scalars().all())


async def test_reuse_detection_persists_the_family_revocation(
    service, scoped_session_factory, real_engine,
):
    """A replayed refresh token must leave a committed family sentinel.

    Before the fix this failed: ``check_and_record_rotation`` revoked the
    family into the request session and ``refresh`` raised immediately,
    so the sentinel was rolled back and the rest of the family stayed
    live — precisely the tokens a thief would be holding.
    """
    await _seed_user(scoped_session_factory)
    _, tokens = await service.login("durable@example.com", _PASSWORD)

    # First rotation consumes the original jti.
    _, rotated = await service.refresh(tokens.refresh_token)

    # Replay the consumed token — reuse detection fires.
    with pytest.raises(InvalidRefreshToken) as exc:
        await service.refresh(tokens.refresh_token)
    assert "reuse_detected" in str(exc.value)

    sentinels = [j for j in await _revoked_rows(real_engine)
                 if j.startswith(_FAMILY_SENTINEL_PREFIX)]
    assert sentinels, (
        "family revocation was rolled back with the caller's transaction — "
        "the stolen family is still live"
    )

    # And the consequence that matters: the legitimately rotated token
    # from the first refresh is now dead too, because its family is.
    with pytest.raises(InvalidRefreshToken) as exc:
        await service.refresh(rotated.refresh_token)
    assert "family_revoked" in str(exc.value)


async def test_inactive_user_revocation_persists(
    service, scoped_session_factory, real_engine,
):
    """Suspending a user must durably kill their refresh family."""
    user_id = await _seed_user(scoped_session_factory, "suspended@example.com")
    _, tokens = await service.login("suspended@example.com", _PASSWORD)

    async with scoped_session_factory() as session:
        orm = await user_repo.get_user_by_id(session, user_id)
        orm.status = "suspended"

    with pytest.raises(InvalidRefreshToken) as exc:
        await service.refresh(tokens.refresh_token)
    assert "user_inactive" in str(exc.value)

    sentinels = [j for j in await _revoked_rows(real_engine)
                 if j.startswith(_FAMILY_SENTINEL_PREFIX)]
    assert sentinels, "inactive-user revocation did not survive the rollback"


async def test_successful_refresh_still_commits_its_rotation(
    service, scoped_session_factory, real_engine,
):
    """The happy path must keep recording consumed jtis.

    Guards the fix from over-correcting: moving revocation out of the
    request session must not stop ordinary rotation from being durable,
    or reuse detection would never fire in the first place.
    """
    await _seed_user(scoped_session_factory, "happy@example.com")
    _, tokens = await service.login("happy@example.com", _PASSWORD)
    await service.refresh(tokens.refresh_token)

    rows = await _revoked_rows(real_engine)
    consumed = [j for j in rows if not j.startswith(_FAMILY_SENTINEL_PREFIX)]
    assert len(consumed) == 1, f"expected one consumed jti, got {rows}"
