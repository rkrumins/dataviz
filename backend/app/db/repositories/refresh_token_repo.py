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

from datetime import datetime, timezone

from sqlalchemy import insert, select
from sqlalchemy.exc import IntegrityError
from sqlalchemy.ext.asyncio import AsyncSession

from backend.app.db.models import RevokedRefreshJtiORM


# Sentinel jti that marks an entire family as revoked. Picking a prefix
# that can never be issued (real jti's are 22-char base64) keeps the
# semantics in the table itself rather than requiring a side-table.
_FAMILY_SENTINEL_PREFIX = "family-revoked:"


def _family_sentinel(family_id: str) -> str:
    return f"{_FAMILY_SENTINEL_PREFIX}{family_id}"


def _now_iso() -> str:
    return datetime.now(timezone.utc).isoformat()


def _far_future_iso() -> str:
    # Family-revoked sentinels never expire (the family is dead forever).
    # Use year 9999 so the GC sweep skips them.
    return "9999-12-31T23:59:59+00:00"


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

    async def _insert_ignore(self, *, jti: str, family_id: str, expires_at_iso: str) -> None:
        """Insert a revocation row, swallowing duplicates.

        Implemented as INSERT + IntegrityError catch so the same code
        runs on SQLite (dev/tests) and Postgres (prod) without a
        dialect-specific dispatch. A duplicate is benign — the jti is
        already revoked, which is exactly the state we wanted.
        """
        try:
            await self._session.execute(
                insert(RevokedRefreshJtiORM).values(
                    jti=jti,
                    family_id=family_id,
                    revoked_at=_now_iso(),
                    expires_at=expires_at_iso,
                )
            )
            await self._session.flush()
        except IntegrityError:
            await self._session.rollback()

    async def revoke_jti(
        self, jti: str, family_id: str, expires_at_iso: str,
    ) -> None:
        await self._insert_ignore(
            jti=jti, family_id=family_id, expires_at_iso=expires_at_iso,
        )

    async def revoke_family(self, family_id: str) -> None:
        await self._insert_ignore(
            jti=_family_sentinel(family_id),
            family_id=family_id,
            expires_at_iso=_far_future_iso(),
        )


def make_refresh_store(session: AsyncSession) -> SQLAlchemyRefreshStore:
    """Factory used at app startup to wire ``LocalIdentityService``."""
    return SQLAlchemyRefreshStore(session)
