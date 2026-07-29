"""SQLAlchemy adapter for ``backend.auth_service.refresh.RefreshStore``.

This adapter is the only piece of refresh-token plumbing that knows about
SQLAlchemy. The auth service depends only on the ``RefreshStore``
protocol; swapping this adapter for a Redis-backed one (or an HTTP call
to the future auth microservice) is a one-line change in app startup.

The "family" semantics:
  * The chain of refresh tokens issued from one /login session shares a
    ``family_id``. Rotation marks one ``jti`` consumed per /refresh call.
  * Detecting an already-consumed ``jti`` proves the chain was
    intercepted; the auth service then revokes the whole family.
  * /logout writes a sentinel ``family_revoked:<family_id>`` row so any
    future refresh inside that family is rejected without needing to
    enumerate per-jti entries.
"""
from __future__ import annotations

from datetime import datetime, timedelta, timezone

from sqlalchemy import delete, insert, select
from sqlalchemy.exc import IntegrityError
from sqlalchemy.ext.asyncio import AsyncSession

from backend.app.db.models import RevokedRefreshJtiORM
from backend.auth_service.core.config import JWT_REFRESH_EXPIRY_DAYS
from backend.auth_service.refresh import RotationRecord


# Sentinel jti that marks an entire family as revoked. Picking a prefix
# that can never be issued (real jti's are 22-char base64) keeps the
# semantics in the table itself rather than requiring a side-table.
_FAMILY_SENTINEL_PREFIX = "family-revoked:"


def _family_sentinel(family_id: str) -> str:
    return f"{_FAMILY_SENTINEL_PREFIX}{family_id}"


def _now_iso() -> str:
    return datetime.now(timezone.utc).isoformat()


# A family sentinel has to outlive every token that could still be
# presented against it — the newest possible member of that family was
# minted moments before the revocation, so it expires one refresh TTL
# from now. Beyond that the sentinel is guarding against tokens that
# would be refused for being expired anyway.
#
# It used to be stamped year 9999 so the sweep would skip it, on the
# reasoning that a dead family is dead forever. True, and it made every
# revocation a permanent row: the one kind of row that accumulates for
# the life of the deployment and can never be reclaimed.
_SENTINEL_GRACE_DAYS = 1


def _sentinel_expiry_iso() -> str:
    return (
        datetime.now(timezone.utc)
        + timedelta(days=JWT_REFRESH_EXPIRY_DAYS + _SENTINEL_GRACE_DAYS)
    ).isoformat()


async def purge_expired(session: AsyncSession, *, batch: int = 5_000) -> int:
    """Delete revocation rows whose tokens can no longer be presented.

    Returns the number deleted. Bounded per call so one sweep cannot
    hold a long transaction on the jobs pool.

    Nothing pruned this table before. ``expires_at`` was written from the
    start and documented as the GC marker, but no sweep ever read it, so
    the table grew by one row per rotation for the life of the
    deployment — at a 15-minute access TTL that is roughly
    ``users x tabs x 32`` rows a day, forever. Reads stay fast because
    they are primary-key lookups; it is storage and vacuum pressure
    rather than latency, which is exactly why nobody noticed.
    """
    cutoff = datetime.now(timezone.utc).isoformat()
    doomed = (
        await session.execute(
            select(RevokedRefreshJtiORM.jti)
            .where(RevokedRefreshJtiORM.expires_at < cutoff)
            .limit(batch)
        )
    ).scalars().all()
    if not doomed:
        return 0
    await session.execute(
        delete(RevokedRefreshJtiORM).where(RevokedRefreshJtiORM.jti.in_(doomed))
    )
    return len(doomed)


class SQLAlchemyRefreshStore:
    """Implements ``RefreshStore`` against the management DB."""

    def __init__(self, session: AsyncSession):
        self._session = session

    async def is_jti_revoked(self, jti: str) -> bool:
        result = await self._session.execute(
            select(RevokedRefreshJtiORM.jti).where(RevokedRefreshJtiORM.jti == jti)
        )
        return result.scalar_one_or_none() is not None

    async def is_family_revoked(self, family_id: str) -> bool:
        sentinel = _family_sentinel(family_id)
        result = await self._session.execute(
            select(RevokedRefreshJtiORM.jti).where(RevokedRefreshJtiORM.jti == sentinel)
        )
        return result.scalar_one_or_none() is not None

    async def get_rotation(self, jti: str):
        """Read back what a consumed ``jti`` rotated into.

        Returns a :class:`RotationRecord` or None. Used by the grace
        window: a refresh that lost the race re-mints this successor
        instead of being treated as a stolen-chain replay.
        """
        result = await self._session.execute(
            select(
                RevokedRefreshJtiORM.revoked_at,
                RevokedRefreshJtiORM.successor_jti,
                RevokedRefreshJtiORM.successor_exp,
                RevokedRefreshJtiORM.successor_mint_ms,
            ).where(RevokedRefreshJtiORM.jti == jti)
        )
        row = result.one_or_none()
        if row is None or row.successor_jti is None:
            return None
        return RotationRecord(
            revoked_at_iso=row.revoked_at,
            successor_jti=row.successor_jti,
            successor_exp=row.successor_exp,
            successor_mint_ms=row.successor_mint_ms,
        )

    async def claim_jti(
        self,
        jti: str,
        family_id: str,
        expires_at_iso: str,
        *,
        successor_jti: str,
        successor_exp: int,
        successor_mint_ms: int,
    ) -> bool:
        """Consume ``jti`` and record what it rotated into, atomically.

        Returns True when this call won the row, False when someone else
        already had it. The primary key is the whole concurrency
        control: the INSERT either lands or conflicts, with no window
        between checking and writing. The previous SELECT-then-INSERT
        let two refreshes on different replicas both pass the check.

        The successor is written in this same statement on purpose — a
        loser blocks on the index until the winner commits and is then
        guaranteed to read a successor that exists.
        """
        return await self._insert_ignore(
            jti=jti,
            family_id=family_id,
            expires_at_iso=expires_at_iso,
            successor_jti=successor_jti,
            successor_exp=successor_exp,
            successor_mint_ms=successor_mint_ms,
        )

    async def _insert_ignore(
        self, *, jti: str, family_id: str, expires_at_iso: str, **successor,
    ) -> bool:
        """Insert a revocation row, swallowing duplicates.

        Returns True when this call inserted the row, False when it was
        already there.

        Implemented as INSERT + IntegrityError catch so the same code
        runs on SQLite (dev/tests) and Postgres (prod) without a
        dialect-specific dispatch. A duplicate is benign — the jti is
        already revoked, which is exactly the state we wanted.

        The insert runs inside a SAVEPOINT so a duplicate unwinds only
        itself. It used to call ``session.rollback()``, which discarded
        the caller's ENTIRE transaction — on a refresh that meant the
        SSO role-binding reconciliation writes vanished along with it.
        """
        try:
            async with self._session.begin_nested():
                await self._session.execute(
                    insert(RevokedRefreshJtiORM).values(
                        jti=jti,
                        family_id=family_id,
                        revoked_at=_now_iso(),
                        expires_at=expires_at_iso,
                        **successor,
                    )
                )
            return True
        except IntegrityError:
            return False

    async def revoke_jti(
        self, jti: str, family_id: str, expires_at_iso: str,
    ) -> bool:
        return await self._insert_ignore(
            jti=jti, family_id=family_id, expires_at_iso=expires_at_iso,
        )

    async def revoke_family(self, family_id: str) -> bool:
        return await self._insert_ignore(
            jti=_family_sentinel(family_id),
            family_id=family_id,
            expires_at_iso=_sentinel_expiry_iso(),
        )


def make_refresh_store(session: AsyncSession) -> SQLAlchemyRefreshStore:
    """Factory used at app startup to wire ``LocalIdentityService``."""
    return SQLAlchemyRefreshStore(session)
