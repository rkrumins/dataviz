"""Repository: ``service_accounts`` and ``service_account_managers``.

A service account is a ``users`` row with an ``svc_`` id
(``backend/common/service_accounts.py``) plus a row here. Its keys work while
it has a manager in good standing — a person who could still sign in by the
rule a personal key holds its owner to (``api_keys.person_refusal``), or a team
with such a person in it — and for a grace period after its last one went.

That is decided on every request from one stored fact, ``unmanaged_since``,
which this module keeps current: the routes that change who manages an
account recompute it at once, and the hourly sweep catches what changes with
time alone — a sign-in window lapsing, a team's membership synced from the
identity provider. The request path never evaluates managers.
"""
from __future__ import annotations

from dataclasses import dataclass
from datetime import datetime, timedelta
from typing import Iterable, Optional

from sqlalchemy import and_, exists, or_, select, update
from sqlalchemy.ext.asyncio import AsyncSession
from sqlalchemy.orm import aliased

from backend.app.db.models import (
    GroupMemberORM,
    GroupORM,
    ServiceAccountManagerORM,
    ServiceAccountORM,
    UserIdentityORM,
    UserORM,
)
from backend.common.service_accounts import is_person


# ── Good standing ───────────────────────────────────────────────────


def _signs_in(user, *, now: datetime, window_days: Optional[int], passwords_allowed: bool):
    """SQL: this person has a way to sign in now — the second half of
    ``api_keys.person_refusal``. An SSO identity counts while the provider has
    vouched for them within ``window_days``; without one, a password counts
    while password sign-in is switched on."""
    # Here, not at the top: the control plane's sweep imports this module and
    # starts without the auth service's modules.
    from backend.auth_service.core.password import disabled_password_hash

    identity = aliased(UserIdentityORM)
    has_identity = exists().where(identity.user_id == user.id)
    if window_days is None:
        vouched = has_identity
    else:
        recent = aliased(UserIdentityORM)
        cutoff = (now - timedelta(days=window_days)).isoformat()
        vouched = exists().where(recent.user_id == user.id, recent.last_login_at >= cutoff)
    if not passwords_allowed:
        return vouched
    has_password = and_(
        user.password_hash.is_not(None), user.password_hash != "",
        user.password_hash != disabled_password_hash(),
    )
    return or_(vouched, and_(~has_identity, has_password))


def in_good_standing(user, *, now: datetime, window_days: Optional[int], passwords_allowed: bool):
    """SQL, over a ``users`` alias: ``api_keys.person_refusal(...) is None`` —
    active, not deleted, not a break-glass account, able to sign in — and a
    person, never another service account."""
    return and_(
        user.deleted_at.is_(None), user.status == "active",
        user.is_system_account.is_not(True), is_person(user.id),
        _signs_in(user, now=now, window_days=window_days, passwords_allowed=passwords_allowed),
    )


def managed(account_id, *, now: datetime, window_days: Optional[int], passwords_allowed: bool):
    """SQL: the account has at least one manager in good standing — a person
    who is, or a live team with someone who is."""
    manager = aliased(ServiceAccountManagerORM)
    person = aliased(UserORM)
    member = aliased(UserORM)
    membership = aliased(GroupMemberORM)
    team = aliased(GroupORM)
    standing = dict(now=now, window_days=window_days, passwords_allowed=passwords_allowed)
    person_ok = exists().where(person.id == manager.user_id, in_good_standing(person, **standing))
    team_ok = exists().where(
        team.id == manager.group_id, team.deleted_at.is_(None),
        membership.group_id == team.id, member.id == membership.user_id,
        in_good_standing(member, **standing),
    )
    return exists().where(
        manager.service_account_id == account_id,
        or_(
            and_(manager.user_id.is_not(None), person_ok),
            and_(manager.group_id.is_not(None), team_ok),
        ),
    )


async def refresh_standing(
    session: AsyncSession,
    *,
    now: datetime,
    window_days: Optional[int],
    passwords_allowed: bool,
    account_ids: Optional[Iterable[str]] = None,
) -> list[str]:
    """Bring ``unmanaged_since`` up to date — for these accounts, or every one.
    An account found with no manager in good standing is stamped ``now`` (once:
    a stamp already there is when it was first noticed); one that has a manager
    again is cleared, with its reminder. Returns the accounts that have just
    lost their last manager, so the caller can tell the administrators."""
    stmt = select(
        ServiceAccountORM.user_id, ServiceAccountORM.unmanaged_since,
        managed(
            ServiceAccountORM.user_id, now=now, window_days=window_days,
            passwords_allowed=passwords_allowed,
        ).label("managed"),
    )
    if account_ids is not None:
        wanted = sorted(set(account_ids))
        if not wanted:
            return []
        stmt = stmt.where(ServiceAccountORM.user_id.in_(wanted))
    rows = (await session.execute(stmt)).all()
    lost = [r.user_id for r in rows if not r.managed and r.unmanaged_since is None]
    regained = [r.user_id for r in rows if r.managed and r.unmanaged_since is not None]
    if lost:
        await session.execute(
            update(ServiceAccountORM)
            .where(ServiceAccountORM.user_id.in_(lost), ServiceAccountORM.unmanaged_since.is_(None))
            .values(unmanaged_since=now.isoformat())
            .execution_options(synchronize_session=False)
        )
    if regained:
        await session.execute(
            update(ServiceAccountORM)
            .where(ServiceAccountORM.user_id.in_(regained))
            .values(unmanaged_since=None, pause_reminded_at=None)
            .execution_options(synchronize_session=False)
        )
    return lost


@dataclass(frozen=True)
class Unmanaged:
    """An enabled service account with no manager, as the administrators are
    told about it."""
    id: str
    name: str
    unmanaged_since: str


async def unmanaged_accounts(
    session: AsyncSession, account_ids: Iterable[str],
) -> list[Unmanaged]:
    """These accounts, where they are enabled and still have no manager."""
    wanted = sorted(set(account_ids))
    if not wanted:
        return []
    rows = (await session.execute(
        select(ServiceAccountORM.user_id, UserORM.first_name, ServiceAccountORM.unmanaged_since)
        .join(UserORM, UserORM.id == ServiceAccountORM.user_id)
        .where(
            ServiceAccountORM.user_id.in_(wanted),
            ServiceAccountORM.unmanaged_since.is_not(None),
            UserORM.status == "active", UserORM.deleted_at.is_(None),
        )
    )).all()
    return [Unmanaged(id=r[0], name=r[1], unmanaged_since=r[2]) for r in rows]


async def due_pause_reminder(
    session: AsyncSession, *, now: datetime, grace_days: int, ahead: timedelta,
) -> list[Unmanaged]:
    """Enabled accounts whose keys pause within ``ahead`` for want of a
    manager, and whose administrators have not been reminded yet. None when
    there is no grace to warn within."""
    if grace_days <= 0:
        return []
    pauses_by = (now - timedelta(days=grace_days) + ahead).isoformat()
    paused_by = (now - timedelta(days=grace_days)).isoformat()
    rows = (await session.execute(
        select(ServiceAccountORM.user_id, UserORM.first_name, ServiceAccountORM.unmanaged_since)
        .join(UserORM, UserORM.id == ServiceAccountORM.user_id)
        .where(
            ServiceAccountORM.unmanaged_since.is_not(None),
            ServiceAccountORM.unmanaged_since <= pauses_by,
            ServiceAccountORM.unmanaged_since > paused_by,
            ServiceAccountORM.pause_reminded_at.is_(None),
            UserORM.status == "active", UserORM.deleted_at.is_(None),
        )
    )).all()
    return [Unmanaged(id=r[0], name=r[1], unmanaged_since=r[2]) for r in rows]


async def mark_pause_reminded(session: AsyncSession, account_ids: list[str], *, now: datetime) -> None:
    if not account_ids:
        return
    await session.execute(
        update(ServiceAccountORM)
        .where(ServiceAccountORM.user_id.in_(account_ids))
        .values(pause_reminded_at=now.isoformat())
        .execution_options(synchronize_session=False)
    )
