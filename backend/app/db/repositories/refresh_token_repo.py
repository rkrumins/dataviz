"""SQLAlchemy adapter for ``backend.auth_service.refresh.RefreshStore``.

This adapter is the only piece of refresh-token plumbing that knows about
SQLAlchemy. The auth service depends only on the ``RefreshStore``
protocol; swapping this adapter for a Redis-backed one (or an HTTP call
to the future auth microservice) is a one-line change in app startup.

The model is **allow-by-record**: ``refresh_tokens`` holds one row per
token, written at mint, and a token is refused unless an active row says
otherwise. It replaces the ``revoked_refresh_jti`` denylist, in which a
token was valid unless a row said otherwise — a shape whose correctness
depended on the denylist being complete and durable forever while
``purge_expired`` deleted from it.

The "family" semantics are unchanged in meaning:
  * The chain of refresh tokens issued from one /login session shares a
    ``family_id``. Rotation stamps ``consumed_at`` on one row per
    /refresh call and points ``successor_jti`` at the next.
  * Presenting an already-consumed ``jti`` proves the chain was
    intercepted (outside the grace window); the auth service then
    revokes the whole family.
  * /logout marks every row in the family revoked. There is no longer a
    ``family_revoked:<id>`` sentinel row whose expiry had to be
    hand-sized to outlive the tokens it guarded.
"""
from __future__ import annotations

from datetime import datetime, timezone
from typing import Optional

from sqlalchemy import delete, func, insert, select, update
from sqlalchemy.exc import IntegrityError
from sqlalchemy.ext.asyncio import AsyncSession

from backend.app.db.models import RefreshTokenORM
from backend.auth_service.refresh import RefreshRecord


def _now_iso() -> str:
    return datetime.now(timezone.utc).isoformat()


#: Passes ``revoke_family`` makes before giving up on catching a row that
#: appeared mid-sweep. A refresh in flight when the family is revoked can
#: commit its successor after the UPDATE's scan has passed that point, so
#: one pass can leave exactly one live token behind. The second pass sees
#: it, because the transaction that wrote it has committed by then. Three
#: is a bound, not an expectation — the loop exits as soon as a pass
#: marks nothing.
_REVOKE_FAMILY_PASSES = 3


async def purge_expired(session: AsyncSession, *, batch: int = 5_000) -> int:
    """Delete rows for tokens that can no longer be presented.

    Returns the number deleted. Bounded per call so one sweep cannot hold
    a long transaction on the jobs pool.

    **Safe by construction now, and it was not before.** Against the old
    denylist this same sweep deleted the rows that were the only thing
    making a consumed or revoked token invalid — so an early prune, a
    clock skew, or a restore from backup could bring a dead credential
    back to life. Under allow-by-record a deleted row can only cause a
    refusal, and the rows deleted here are for tokens whose ``expires_at``
    has already passed, so they would be refused for being expired
    anyway.
    """
    cutoff = _now_iso()
    doomed = (
        await session.execute(
            select(RefreshTokenORM.jti)
            .where(RefreshTokenORM.expires_at < cutoff)
            .limit(batch)
        )
    ).scalars().all()
    if not doomed:
        return 0
    await session.execute(
        delete(RefreshTokenORM).where(RefreshTokenORM.jti.in_(doomed))
    )
    return len(doomed)


def _provider_predicate(provider_id: Optional[str]):
    """Rows minted by one IdP row — or by any IdP at all when
    ``provider_id`` is None, which is the master-switch sweep. Local
    password sessions leave the column NULL and are never matched."""
    if provider_id is None:
        return RefreshTokenORM.idp_provider_id.is_not(None)
    return RefreshTokenORM.idp_provider_id == provider_id


async def count_active_provider_users(
    session: AsyncSession, *, provider_id: Optional[str],
) -> int:
    """Distinct users currently holding a live refresh token minted by
    this provider (None = any SSO provider). "Live" means presentable:
    not revoked, not consumed, not expired. This is the number a
    confirm dialog shows before ``revoke_provider_tokens`` — it can
    drift slightly from the real sweep under concurrent logins, which
    is fine for a count and stated where it is served."""
    return (
        await session.execute(
            select(func.count(func.distinct(RefreshTokenORM.user_id))).where(
                _provider_predicate(provider_id),
                RefreshTokenORM.revoked_at.is_(None),
                RefreshTokenORM.consumed_at.is_(None),
                RefreshTokenORM.expires_at > _now_iso(),
            )
        )
    ).scalar_one()


async def count_active_users(
    session: AsyncSession, *, exclude_user_ids: frozenset[str] | set[str] = frozenset(),
) -> int:
    """Distinct users currently holding ANY live refresh token —
    password and SSO alike. The platform sweep's confirm-dialog number.

    ``exclude_user_ids`` subtracts the system accounts the sweep will
    skip; calling this twice (with and without the set) and taking the
    difference answers "how many system accounts stay signed in".
    Same drift caveat as :func:`count_active_provider_users`.
    """
    clauses = [
        RefreshTokenORM.revoked_at.is_(None),
        RefreshTokenORM.consumed_at.is_(None),
        RefreshTokenORM.expires_at > _now_iso(),
    ]
    if exclude_user_ids:
        clauses.append(RefreshTokenORM.user_id.not_in(exclude_user_ids))
    return (
        await session.execute(
            select(func.count(func.distinct(RefreshTokenORM.user_id)))
            .where(*clauses)
        )
    ).scalar_one()


async def revoke_all_tokens(
    session: AsyncSession, *, exclude_user_ids: frozenset[str] | set[str] = frozenset(),
) -> tuple[set[str], int]:
    """Stamp ``revoked_at`` on every un-revoked refresh row — password
    AND SSO — except rows belonging to ``exclude_user_ids`` (the system
    accounts a platform sweep must leave signed in).

    Multi-pass for the same mid-sweep-rotation reason as
    :func:`revoke_provider_tokens`, and with the same deliberate
    absence of a consumed/expiry filter: marking an already-dead row
    revoked can only ever cause a refusal.

    Returns ``(distinct user_ids touched, rows marked)``.
    """
    def _clauses():
        clauses = [RefreshTokenORM.revoked_at.is_(None)]
        if exclude_user_ids:
            clauses.append(RefreshTokenORM.user_id.not_in(exclude_user_ids))
        return clauses

    users: set[str] = set()
    rows_marked = 0
    for _ in range(_REVOKE_FAMILY_PASSES):
        touched = (
            await session.execute(
                select(func.distinct(RefreshTokenORM.user_id))
                .where(*_clauses())
            )
        ).scalars().all()
        users.update(u for u in touched if u)
        result = await session.execute(
            update(RefreshTokenORM)
            .where(*_clauses())
            .values(revoked_at=_now_iso())
        )
        marked = int(result.rowcount or 0)
        rows_marked += marked
        if marked == 0:
            break
    await session.flush()
    return users, rows_marked


async def revoke_provider_tokens(
    session: AsyncSession, *, provider_id: Optional[str],
) -> tuple[set[str], int]:
    """Stamp ``revoked_at`` on every un-revoked refresh row minted by
    this provider (None = every SSO row), and report who was touched.

    Multi-pass for the same reason ``revoke_family`` is: a rotation in
    flight when the sweep starts can commit its successor after a
    pass's scan has moved past it, and that successor carries the same
    ``idp_provider_id``. The loop exits as soon as a pass marks
    nothing; the pass bound is a backstop, not an expectation.

    Deliberately no consumed/expiry filter on the UPDATE — marking an
    already-dead row revoked can only ever cause a refusal, and the
    belt-and-braces matches ``revoke_family``.

    Returns ``(distinct user_ids touched, rows marked)``.
    """
    users: set[str] = set()
    rows_marked = 0
    for _ in range(_REVOKE_FAMILY_PASSES):
        touched = (
            await session.execute(
                select(func.distinct(RefreshTokenORM.user_id)).where(
                    _provider_predicate(provider_id),
                    RefreshTokenORM.revoked_at.is_(None),
                )
            )
        ).scalars().all()
        users.update(u for u in touched if u)
        result = await session.execute(
            update(RefreshTokenORM)
            .where(
                _provider_predicate(provider_id),
                RefreshTokenORM.revoked_at.is_(None),
            )
            .values(revoked_at=_now_iso())
        )
        marked = int(result.rowcount or 0)
        rows_marked += marked
        if marked == 0:
            break
    await session.flush()
    return users, rows_marked


class SQLAlchemyRefreshStore:
    """Implements ``RefreshStore`` against the management DB."""

    def __init__(self, session: AsyncSession):
        self._session = session

    async def record_mint(
        self,
        *,
        jti: str,
        family_id: str,
        user_id: str,
        auth_time: Optional[int],
        mint_ms: int,
        expires_at_iso: str,
        revoked_at_iso: Optional[str] = None,
        idp_provider_id: Optional[str] = None,
        idp_checked_at: Optional[int] = None,
    ) -> bool:
        """Write the row that makes a freshly minted token usable.

        Returns True when this call inserted it, False when a row was
        already there. A duplicate ``jti`` is not an error to escalate:
        the row exists, which is the state we wanted.

        The insert runs inside a SAVEPOINT so a duplicate unwinds only
        itself. Calling ``session.rollback()`` here would discard the
        caller's ENTIRE transaction — on a refresh that used to mean the
        SSO role-binding reconciliation writes vanished along with it.
        """
        try:
            async with self._session.begin_nested():
                await self._session.execute(
                    insert(RefreshTokenORM).values(
                        jti=jti,
                        family_id=family_id,
                        user_id=user_id,
                        auth_time=auth_time,
                        mint_ms=mint_ms,
                        expires_at=expires_at_iso,
                        created_at=_now_iso(),
                        revoked_at=revoked_at_iso,
                        idp_provider_id=idp_provider_id,
                        idp_checked_at=idp_checked_at,
                    )
                )
            return True
        except IntegrityError:
            return False

    async def get_record(self, jti: str) -> Optional[RefreshRecord]:
        row = (
            await self._session.execute(
                select(RefreshTokenORM).where(RefreshTokenORM.jti == jti)
            )
        ).scalar_one_or_none()
        if row is None:
            return None
        return RefreshRecord(
            jti=row.jti,
            family_id=row.family_id,
            user_id=row.user_id,
            auth_time=row.auth_time,
            mint_ms=row.mint_ms,
            expires_at_iso=row.expires_at,
            created_at_iso=row.created_at,
            consumed_at_iso=row.consumed_at,
            successor_jti=row.successor_jti,
            revoked_at_iso=row.revoked_at,
            idp_provider_id=row.idp_provider_id,
            idp_checked_at=row.idp_checked_at,
        )

    async def touch_idp_check(self, jti: str, *, checked_at: int) -> bool:
        """Record a SUCCESSFUL upstream liveness confirmation.

        Never called on a failure. The value is the anchor the outage
        grace window measures from, so advancing it when the gateway did
        not answer would let an outage renew the very allowance it
        should be spending down — the session would ride out an
        indefinite outage one grace window at a time.
        """
        result = await self._session.execute(
            update(RefreshTokenORM)
            .where(RefreshTokenORM.jti == jti)
            .values(idp_checked_at=int(checked_at))
        )
        return bool(result.rowcount)

    async def consume(self, jti: str, *, successor_jti: str) -> bool:
        """Rotate this token away, atomically.

        Returns True when this call consumed it, False when someone else
        already had. The conditional UPDATE is the whole concurrency
        control: ``consumed_at IS NULL`` is evaluated and written in one
        statement, with no window between checking and writing, and a
        concurrent caller blocks on the row until this transaction
        commits and then matches nothing.

        ``revoked_at IS NULL`` is in the same predicate on purpose — a
        family revoked between the caller's read and this write must not
        be rotated through the gap.
        """
        result = await self._session.execute(
            update(RefreshTokenORM)
            .where(
                RefreshTokenORM.jti == jti,
                RefreshTokenORM.consumed_at.is_(None),
                RefreshTokenORM.revoked_at.is_(None),
            )
            .values(consumed_at=_now_iso(), successor_jti=successor_jti)
        )
        return (result.rowcount or 0) > 0

    async def revoke_family(self, family_id: str) -> bool:
        """Kill every token in the family.

        Returns True when anything was marked.

        Repeated until a pass marks nothing: a rotation in flight when
        this runs can commit its successor row after this UPDATE's scan
        has moved past it, leaving one live token in a family that is
        supposed to be dead. The next pass sees that row, because the
        transaction that wrote it has committed. Bounded so a pathological
        loop cannot hold the connection.
        """
        marked = False
        for _ in range(_REVOKE_FAMILY_PASSES):
            result = await self._session.execute(
                update(RefreshTokenORM)
                .where(
                    RefreshTokenORM.family_id == family_id,
                    RefreshTokenORM.revoked_at.is_(None),
                )
                .values(revoked_at=_now_iso())
            )
            if not (result.rowcount or 0):
                break
            marked = True
        return marked

    async def is_family_revoked(self, family_id: str) -> bool:
        """Whether this family has been killed.

        Derived from the rows rather than from a sentinel: any revoked
        member means the family is revoked, because revocation always
        marks all of them. Only consulted for a token that has no row of
        its own — one minted before allow-by-record — since otherwise its
        own ``revoked_at`` answers directly.
        """
        row = (
            await self._session.execute(
                select(RefreshTokenORM.jti).where(
                    RefreshTokenORM.family_id == family_id,
                    RefreshTokenORM.revoked_at.is_not(None),
                ).limit(1)
            )
        ).scalar_one_or_none()
        return row is not None

    async def family_started_ms(self, family_id: str) -> Optional[int]:
        """When this session first signed in, in epoch milliseconds.

        The earliest mint in the family, which is the original login —
        every later row is a rotation of it. This is what the absolute
        session ceiling measures from; the presented token's own
        ``mint_ms`` cannot serve, because rotation resets it and that is
        exactly how a session came to live forever.

        ``None`` when the family has no rows, which under allow-by-record
        the caller has already refused.
        """
        return (
            await self._session.execute(
                select(func.min(RefreshTokenORM.mint_ms)).where(
                    RefreshTokenORM.family_id == family_id,
                )
            )
        ).scalar_one_or_none()


def make_refresh_store(session: AsyncSession) -> SQLAlchemyRefreshStore:
    """Factory used at app startup to wire ``LocalIdentityService``."""
    return SQLAlchemyRefreshStore(session)
