"""Refresh tokens are valid only while a record says so.

The previous model was a denylist: a refresh token was valid *unless* a
row said otherwise. That put correctness on the denylist being complete
and durable forever — while a sweep deleted from it — so every way the
storage could fail pointed the wrong way. A row lost to an early prune, a
failed write, or a restore from backup made a consumed or revoked token
valid again, silently and in the attacker's favour.

Inverted, the same failures can only sign someone out. These tests pin
the inversion itself, the two things that moved onto the record with it
(``auth_time`` and the successor pointer), and the adoption path that
keeps the deploy from signing out every session already in flight.

Uses a file-backed engine for the same reason
``test_auth_revocation_durability`` does: the shared in-memory fixture
puts every session on one StaticPool connection, so nothing about
committed-vs-uncommitted state can be observed.
"""
from __future__ import annotations

import time
from contextlib import asynccontextmanager
from datetime import datetime, timedelta, timezone

import pytest
import pytest_asyncio
from sqlalchemy import event, select
from sqlalchemy.ext.asyncio import async_sessionmaker, create_async_engine

from backend.app.auth.password import hash_password
from backend.app.db.models import Base, RefreshTokenORM, RevokedRefreshJtiORM
from backend.app.db.repositories import user_repo
from backend.app.db.repositories.refresh_token_repo import make_refresh_store
from backend.auth_service.core.tokens import (
    create_refresh_token,
    decode_refresh_token,
)
from backend.auth_service.service import (
    InvalidRefreshToken,
    LocalIdentityService,
)

_PASSWORD = "C0mpl3x!Passw0rd#"


@pytest_asyncio.fixture()
async def real_engine(tmp_path):
    engine = create_async_engine(f"sqlite+aiosqlite:///{tmp_path / 'records.db'}")
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


@pytest.fixture(autouse=True)
def _no_adoption(monkeypatch):
    """Allow-by-record, unconditionally, unless a test says otherwise.

    Adoption is the migration ramp: it accepts a token that has no record
    and writes the one it should have had. Left on, it would mask every
    assertion in this file — a refused token would be quietly adopted
    instead — so the default here is the end state, and the two tests
    that are *about* adoption turn it back on explicitly.
    """
    monkeypatch.setattr(
        "backend.auth_service.service.REFRESH_ADOPT_RECORDLESS", False,
    )


async def _seed_user(factory, email="records@example.com") -> str:
    async with factory() as session:
        user = await user_repo.create_user(
            session,
            email=email,
            password_hash=hash_password(_PASSWORD),
            first_name="Rec",
            last_name="Ord",
            status="active",
        )
        await user_repo.assign_role(session, user.id, "super_admin")
        return user.id


def _iso_now() -> str:
    return datetime.now(timezone.utc).isoformat()


def _iso_in_days(days: int) -> str:
    return (datetime.now(timezone.utc) + timedelta(days=days)).isoformat()


async def _rows(real_engine) -> list[RefreshTokenORM]:
    maker = async_sessionmaker(bind=real_engine, expire_on_commit=False)
    async with maker() as session:
        return list(
            (await session.execute(select(RefreshTokenORM))).scalars().all()
        )


# ── The inversion ────────────────────────────────────────────────────

async def test_a_refresh_token_with_no_record_is_refused(
    service, scoped_session_factory,
):
    """The whole point, and the thing that was not true before.

    This token is signed by us, unexpired, and in no denylist. Under the
    old model it was therefore *valid* — nothing anywhere had to say so.
    Now silence is refusal.
    """
    await _seed_user(scoped_session_factory, "norecord@example.com")
    forged, _ = create_refresh_token(user_id="usr_nobody", family_id="fam_ghost")

    with pytest.raises(InvalidRefreshToken) as exc:
        await service.refresh(forged)
    assert "no_record" in str(exc.value)


async def test_login_writes_the_record_its_token_depends_on(
    service, scoped_session_factory, real_engine,
):
    """A token minted without a record is a session that dies at its
    first rotation, so the two have to be issued together."""
    user_id = await _seed_user(scoped_session_factory, "login@example.com")
    _, tokens = await service.login("login@example.com", _PASSWORD)

    claims = decode_refresh_token(tokens.refresh_token)
    rows = await _rows(real_engine)
    assert [r.jti for r in rows] == [claims.jti]
    assert rows[0].user_id == user_id
    assert rows[0].family_id == claims.family_id
    assert rows[0].consumed_at is None and rows[0].revoked_at is None

    # And the session it just issued actually rotates.
    _, rotated = await service.refresh(tokens.refresh_token)
    assert rotated.refresh_token != tokens.refresh_token


async def test_rotation_records_the_successor_and_consumes_the_parent(
    service, scoped_session_factory, real_engine,
):
    await _seed_user(scoped_session_factory, "rotate@example.com")
    _, tokens = await service.login("rotate@example.com", _PASSWORD)
    parent_jti = decode_refresh_token(tokens.refresh_token).jti

    _, rotated = await service.refresh(tokens.refresh_token)
    child_jti = decode_refresh_token(rotated.refresh_token).jti

    by_jti = {r.jti: r for r in await _rows(real_engine)}
    assert by_jti[parent_jti].consumed_at is not None
    assert by_jti[parent_jti].successor_jti == child_jti
    # A pointer, not a copy: the successor's own row carries its expiry,
    # so the two cannot drift.
    assert by_jti[child_jti].consumed_at is None


# ── Pruning is safe by construction ──────────────────────────────────

async def test_a_swept_family_stays_revoked(
    service, scoped_session_factory, real_engine,
):
    """The denylist's worst failure mode, made impossible.

    Revoking a family then sweeping its rows used to leave the family's
    tokens valid again — the sentinel was the only thing refusing them.
    Here the sweep removes their licence, so they stay refused.
    """
    from backend.app.db.repositories.refresh_token_repo import purge_expired

    await _seed_user(scoped_session_factory, "swept@example.com")
    _, tokens = await service.login("swept@example.com", _PASSWORD)
    await service.logout(tokens.refresh_token)

    # Age every row past its expiry so the sweep is entitled to take it,
    # then sweep. This is the restore-from-stale-backup shape.
    maker = async_sessionmaker(bind=real_engine, expire_on_commit=False)
    async with maker() as session:
        for row in (await session.execute(select(RefreshTokenORM))).scalars():
            row.expires_at = "2000-01-01T00:00:00+00:00"
        await session.commit()
    async with maker() as session:
        assert await purge_expired(session) >= 1
        await session.commit()

    assert await _rows(real_engine) == []
    with pytest.raises(InvalidRefreshToken):
        await service.refresh(tokens.refresh_token)


async def test_logout_revokes_without_adding_a_row(
    service, scoped_session_factory, real_engine,
):
    await _seed_user(scoped_session_factory, "out@example.com")
    _, tokens = await service.login("out@example.com", _PASSWORD)
    before = len(await _rows(real_engine))

    await service.logout(tokens.refresh_token)

    rows = await _rows(real_engine)
    assert len(rows) == before, "revocation should mark rows, not add one"
    assert all(r.revoked_at is not None for r in rows)


# ── auth_time is the server's fact, not the token's ──────────────────

async def test_the_sso_ceiling_reads_auth_time_from_the_record(
    service, scoped_session_factory, real_engine,
):
    """A token that omits ``auth_time`` must not escape the ceiling.

    As a claim, ``auth_time`` was something the token asserted about
    itself, and its *absence* meant "local password session, ceiling does
    not apply" — so a refresh token without it skipped the 24h SSO
    re-auth check entirely. That was a real bug in this engagement. With
    the value on the record the token cannot drop it: strip the claim and
    the ceiling still fires.
    """
    from backend.auth_service.core.config import SSO_SESSION_MAX_AGE_SECONDS
    from backend.auth_service.interface import SsoReauthRequired

    user_id = await _seed_user(scoped_session_factory, "sso@example.com")
    stale = int(time.time()) - (SSO_SESSION_MAX_AGE_SECONDS + 60)

    # An SSO session whose token has NO auth_time claim, but whose record
    # does — the exact divergence the record exists to settle.
    bare_token, claims = create_refresh_token(
        user_id=user_id, family_id="fam_sso",
    )
    assert claims.auth_time is None, "the token must not carry the claim"

    async with scoped_session_factory() as session:
        await make_refresh_store(session).record_mint(
            jti=claims.jti,
            family_id=claims.family_id,
            user_id=user_id,
            auth_time=stale,
            mint_ms=claims.mint_ms,
            expires_at_iso="2099-01-01T00:00:00+00:00",
        )

    with pytest.raises(SsoReauthRequired):
        await service.refresh(bare_token)


async def test_auth_time_is_carried_onto_the_successor(
    service, scoped_session_factory, real_engine,
):
    """The ceiling measures from the authentication, not the rotation.

    If each successor re-derived ``auth_time`` from "now", a session that
    kept rotating would never reach the ceiling at all — which is the
    failure the ceiling exists to prevent.
    """
    user_id = await _seed_user(scoped_session_factory, "carry@example.com")
    recent = int(time.time()) - 60

    token, claims = create_refresh_token(
        user_id=user_id, family_id="fam_carry", auth_time=recent,
    )
    async with scoped_session_factory() as session:
        await make_refresh_store(session).record_mint(
            jti=claims.jti,
            family_id=claims.family_id,
            user_id=user_id,
            auth_time=recent,
            mint_ms=claims.mint_ms,
            expires_at_iso="2099-01-01T00:00:00+00:00",
        )

    _, rotated = await service.refresh(token)
    child_jti = decode_refresh_token(rotated.refresh_token).jti

    by_jti = {r.jti: r for r in await _rows(real_engine)}
    assert by_jti[child_jti].auth_time == recent


# ── The migration ramp ───────────────────────────────────────────────

async def test_a_token_from_before_the_deploy_is_adopted(
    service, scoped_session_factory, real_engine, monkeypatch,
):
    """Every session live at deploy holds a token with no record.

    Refusing them would sign out the entire estate at each session's next
    rotation — a self-inflicted outage on the way to a security
    improvement. Adoption writes the row the token should have had and
    lets it through, which is exactly what the previous model did with
    the same token.
    """
    monkeypatch.setattr(
        "backend.auth_service.service.REFRESH_ADOPT_RECORDLESS", True,
    )
    user_id = await _seed_user(scoped_session_factory, "adopt@example.com")
    legacy, claims = create_refresh_token(user_id=user_id, family_id="fam_old")

    _, rotated = await service.refresh(legacy)

    assert rotated.refresh_token != legacy
    by_jti = {r.jti: r for r in await _rows(real_engine)}
    assert claims.jti in by_jti, "the adopted token was not recorded"
    assert by_jti[claims.jti].consumed_at is not None, (
        "an adopted token must be consumed like any other"
    )


async def test_adoption_does_not_resurrect_a_revoked_family(
    service, scoped_session_factory, monkeypatch,
):
    """The ramp must not be a way back in.

    A family revoked *under this revision* has rows carrying
    ``revoked_at``, so adoption of a sibling token sees them and refuses.

    Note this is NOT the pre-deploy shape — the family here has records.
    For a family revoked before allow-by-record deployed, see
    ``test_adoption_does_not_resurrect_a_legacy_revoked_family``.
    """
    monkeypatch.setattr(
        "backend.auth_service.service.REFRESH_ADOPT_RECORDLESS", True,
    )
    await _seed_user(scoped_session_factory, "revoked@example.com")
    _, tokens = await service.login("revoked@example.com", _PASSWORD)
    family = decode_refresh_token(tokens.refresh_token).family_id
    await service.logout(tokens.refresh_token)

    # A sibling of the revoked family that never had a record.
    orphan, _ = create_refresh_token(user_id="usr_x", family_id=family)

    with pytest.raises(InvalidRefreshToken) as exc:
        await service.refresh(orphan)
    assert "family_revoked" in str(exc.value)


async def test_adoption_does_not_resurrect_a_legacy_revoked_family(
    service, scoped_session_factory, real_engine, monkeypatch,
):
    """The actual shape of a stolen pre-deploy cookie.

    A family killed *before* this revision has **no rows in
    ``refresh_tokens`` at all** — that is what "record-less" means. Its
    revocation lives only in the ``revoked_refresh_jti`` denylist, as a
    ``family-revoked:<id>`` sentinel.

    ``is_family_revoked`` derives its answer from ``refresh_tokens``, so
    for such a family it finds nothing and reports "not revoked", and
    adoption writes the fresh licence the guard exists to withhold. The
    families that reach here are the ones killed by reuse detection — an
    actual detected token theft — and by the SSO re-auth ceiling; a
    user-initiated "sign out everywhere" is separately covered by
    ``users.sessions_valid_from``.
    """
    monkeypatch.setattr(
        "backend.auth_service.service.REFRESH_ADOPT_RECORDLESS", True,
    )
    user_id = await _seed_user(scoped_session_factory, "legacy@example.com")
    family = "fam_killed_before_the_deploy"

    # Exactly what the previous revision wrote when it killed a family,
    # and the only trace such a revocation left behind.
    async with scoped_session_factory() as session:
        session.add(
            RevokedRefreshJtiORM(
                jti=f"family-revoked:{family}",
                family_id=family,
                revoked_at=_iso_now(),
                expires_at=_iso_in_days(8),
            )
        )

    stolen, _ = create_refresh_token(user_id=user_id, family_id=family)

    with pytest.raises(InvalidRefreshToken) as exc:
        await service.refresh(stolen)
    assert "family_revoked" in str(exc.value)

    assert not await _rows(real_engine), (
        "a revoked pre-deploy family must not be granted a record"
    )


async def test_adoption_refuses_an_already_consumed_legacy_token(
    service, scoped_session_factory, monkeypatch,
):
    """Adoption must not re-licence a token that was already rotated away.

    The previous model wrote one denylist row per *consumed* jti — that
    was how it detected a replay. Those tokens have no row in
    ``refresh_tokens`` either, so to the adoption path they look exactly
    like a live pre-deploy session, and every superseded cookie still
    sitting in a browser or a backup becomes spendable once.

    This is the likelier of the two legacy holes: a family revocation
    needs something to have gone wrong first, whereas a consumed jti is
    the ordinary residue of every rotation before the deploy.
    """
    monkeypatch.setattr(
        "backend.auth_service.service.REFRESH_ADOPT_RECORDLESS", True,
    )
    user_id = await _seed_user(scoped_session_factory, "consumed@example.com")
    superseded, claims = create_refresh_token(
        user_id=user_id, family_id="fam_rotated_before_the_deploy",
    )

    # The row the old model left behind when this token was rotated away.
    async with scoped_session_factory() as session:
        session.add(
            RevokedRefreshJtiORM(
                jti=claims.jti,
                family_id=claims.family_id,
                revoked_at=_iso_now(),
                expires_at=_iso_in_days(8),
            )
        )

    with pytest.raises(InvalidRefreshToken):
        await service.refresh(superseded)
