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
from datetime import datetime, timedelta, timezone
from typing import Iterable, Optional

from sqlalchemy import and_, delete, exists, func, or_, select, update
from sqlalchemy.ext.asyncio import AsyncSession
from sqlalchemy.orm import aliased, defer

from backend.app.db.models import (
    ApiKeyORM,
    GroupMemberORM,
    GroupORM,
    ServiceAccountManagerORM,
    ServiceAccountORM,
    UserIdentityORM,
    UserORM,
)
from backend.common.display_name import resolve_display_name
from backend.common.service_accounts import email_for, is_person, is_service_account, new_id


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


# ── The accounts ────────────────────────────────────────────────────

#: Accounts are read for their names and status, never a picture: they have
#: none, and the column holds up to a few hundred KB for people.
_NO_PICTURE = defer(UserORM.avatar_image, raiseload=True)


async def create(
    session: AsyncSession, *, name: str, description: Optional[str], created_by: str,
) -> str:
    """A new, enabled service account with no managers yet. Returns its id."""
    # Here, not at the top: the control plane's sweep imports this module.
    from backend.auth_service.core.password import disabled_password_hash

    account_id = new_id()
    session.add(UserORM(
        id=account_id, email=email_for(account_id), password_hash=disabled_password_hash(),
        first_name=name, last_name="", status="active", signup_source="admin_created",
    ))
    # The users row first: no relationship tells the flush to order the two.
    await session.flush()
    session.add(ServiceAccountORM(
        user_id=account_id, description=description or None, created_by=created_by,
    ))
    await session.flush()
    return account_id


async def get(session: AsyncSession, account_id: str) -> Optional[tuple[UserORM, ServiceAccountORM]]:
    """The account's ``users`` row and its own, or ``None`` for anything that
    is not a live service account."""
    if not is_service_account(account_id):
        return None
    row = (await session.execute(
        select(UserORM, ServiceAccountORM)
        .join(ServiceAccountORM, ServiceAccountORM.user_id == UserORM.id)
        .where(UserORM.id == account_id, UserORM.deleted_at.is_(None))
        .options(_NO_PICTURE)
        # Fresh from the database: ``refresh_standing`` writes around the
        # session, and an answer must show what it just did.
        .execution_options(populate_existing=True)
    )).first()
    return (row[0], row[1]) if row else None


async def list_page(
    session: AsyncSession,
    *,
    q: Optional[str] = None,
    status: Optional[str] = None,
    managed_by: Optional[str] = None,
    seat_of: Optional[str] = None,
    limit: int = 50,
    offset: int = 0,
) -> tuple[list[tuple[UserORM, ServiceAccountORM]], int]:
    """Service accounts by name: those matching ``q`` (name or description),
    ``active`` or ``disabled``; those a person's leaving touches
    (``managed_by``): the ones they manage, themselves or through a live team,
    and the ones they made a key for that still works; or those they hold a
    seat on themselves (``seat_of``)."""
    stmt = (
        select(UserORM, ServiceAccountORM)
        .join(ServiceAccountORM, ServiceAccountORM.user_id == UserORM.id)
        .where(UserORM.deleted_at.is_(None))
    )
    if status == "active":
        stmt = stmt.where(UserORM.status == "active")
    elif status == "disabled":
        stmt = stmt.where(UserORM.status != "active")
    if q:
        pattern = f"%{q.strip().lower()}%"
        stmt = stmt.where(or_(
            func.lower(UserORM.first_name).like(pattern),
            func.lower(func.coalesce(ServiceAccountORM.description, "")).like(pattern),
        ))
    if managed_by:
        stmt = stmt.where(or_(
            ServiceAccountORM.user_id.in_(_seats(managed_by)),
            ServiceAccountORM.user_id.in_(_team_seats(managed_by)),
            ServiceAccountORM.user_id.in_(
                select(ApiKeyORM.user_id).where(ApiKeyORM.created_by == managed_by, _in_date())
            ),
        ))
    if seat_of:
        stmt = stmt.where(ServiceAccountORM.user_id.in_(_seats(seat_of)))
    total = int((await session.execute(
        select(func.count()).select_from(stmt.subquery())
    )).scalar() or 0)
    rows = (await session.execute(
        stmt.order_by(func.lower(UserORM.first_name), UserORM.id)
        .limit(limit).offset(offset).options(_NO_PICTURE)
        .execution_options(populate_existing=True)
    )).all()
    return [(user, account) for user, account in rows], total


async def update_details(
    session: AsyncSession, account_id: str, *, name: Optional[str], description: Optional[str],
    set_description: bool,
) -> None:
    """Rename an account, or change what it says it is for."""
    if name is not None:
        (await session.get(UserORM, account_id)).first_name = name
    if set_description:
        (await session.get(ServiceAccountORM, account_id)).description = description or None
    await session.flush()


# ── Managers ────────────────────────────────────────────────────────


@dataclass(frozen=True)
class Manager:
    """A person or a team answering for an account, and whether it counts."""
    type: str                 # "user" | "group"
    id: str                   # the person's or the team's id
    name: str
    email: Optional[str]
    in_good_standing: bool    # a person who could sign in; a team with one
    members_in_good_standing: Optional[int]
    added_at: str
    added_by: Optional[str]


async def managers(
    session: AsyncSession, account_ids: Iterable[str], *,
    now: datetime, window_days: Optional[int], passwords_allowed: bool,
) -> dict[str, list[Manager]]:
    """Each account's managers, people then teams, with their standing."""
    wanted = sorted(set(account_ids))
    out: dict[str, list[Manager]] = {a: [] for a in wanted}
    if not wanted:
        return out
    rules = dict(now=now, window_days=window_days, passwords_allowed=passwords_allowed)
    person = aliased(UserORM)
    for row, first, last, display, email, ok in (await session.execute(
        select(
            ServiceAccountManagerORM, person.first_name, person.last_name, person.display_name,
            person.email, in_good_standing(person, **rules),
        )
        .join(person, person.id == ServiceAccountManagerORM.user_id)
        .where(ServiceAccountManagerORM.service_account_id.in_(wanted))
        .order_by(func.lower(person.first_name), person.id)
    )).all():
        out[row.service_account_id].append(Manager(
            type="user", id=row.user_id, name=resolve_display_name(display, first, last),
            email=email, in_good_standing=bool(ok), members_in_good_standing=None,
            added_at=row.added_at, added_by=row.added_by,
        ))
    member = aliased(UserORM)
    counted = (
        select(func.count(member.id))
        .select_from(GroupMemberORM)
        .join(member, member.id == GroupMemberORM.user_id)
        .where(GroupMemberORM.group_id == ServiceAccountManagerORM.group_id, in_good_standing(member, **rules))
        .scalar_subquery()
    )
    for row, name, deleted_at, count in (await session.execute(
        select(ServiceAccountManagerORM, GroupORM.name, GroupORM.deleted_at, counted)
        .join(GroupORM, GroupORM.id == ServiceAccountManagerORM.group_id)
        .where(ServiceAccountManagerORM.service_account_id.in_(wanted))
        .order_by(func.lower(GroupORM.name), GroupORM.id)
    )).all():
        live = deleted_at is None
        out[row.service_account_id].append(Manager(
            type="group", id=row.group_id, name=name, email=None,
            in_good_standing=live and bool(count), members_in_good_standing=int(count or 0) if live else 0,
            added_at=row.added_at, added_by=row.added_by,
        ))
    return out


async def people_who_can_act(
    session: AsyncSession, account_ids: Iterable[str], *,
    now: datetime, window_days: Optional[int], passwords_allowed: bool,
) -> dict[str, set[str]]:
    """Per account, the people in good standing who answer for it: its
    managers, and the members of its live managing teams."""
    wanted = sorted(set(account_ids))
    out: dict[str, set[str]] = {a: set() for a in wanted}
    if not wanted:
        return out
    rules = dict(now=now, window_days=window_days, passwords_allowed=passwords_allowed)
    person = aliased(UserORM)
    for account_id, user_id in (await session.execute(
        select(ServiceAccountManagerORM.service_account_id, person.id)
        .join(person, person.id == ServiceAccountManagerORM.user_id)
        .where(ServiceAccountManagerORM.service_account_id.in_(wanted), in_good_standing(person, **rules))
    )).all():
        out[account_id].add(user_id)
    member = aliased(UserORM)
    for account_id, user_id in (await session.execute(
        select(ServiceAccountManagerORM.service_account_id, member.id)
        .join(GroupORM, GroupORM.id == ServiceAccountManagerORM.group_id)
        .join(GroupMemberORM, GroupMemberORM.group_id == GroupORM.id)
        .join(member, member.id == GroupMemberORM.user_id)
        .where(
            ServiceAccountManagerORM.service_account_id.in_(wanted),
            GroupORM.deleted_at.is_(None), in_good_standing(member, **rules),
        )
    )).all():
        out[account_id].add(user_id)
    return out


#: How many members of its managing teams hear about an account when nobody
#: closer does: enough that someone acts, few enough that a team of thousands
#: is not paged about every key.
TEAM_AUDIENCE = 25


async def who_answers(
    session: AsyncSession, account_id: str, *, maker: Optional[str],
    now: datetime, window_days: Optional[int], passwords_allowed: bool,
) -> set[str]:
    """Who hears about a service account: its direct managers in good standing,
    and, about a key, whoever made it while they can still act for it. Failing
    those, up to :data:`TEAM_AUDIENCE` members in good standing of its live
    managing teams, the most recently active first. Empty when nobody can act
    for it."""
    rules = dict(now=now, window_days=window_days, passwords_allowed=passwords_allowed)
    person = aliased(UserORM)
    out = set((await session.execute(
        select(person.id)
        .join(ServiceAccountManagerORM, ServiceAccountManagerORM.user_id == person.id)
        .where(ServiceAccountManagerORM.service_account_id == account_id, in_good_standing(person, **rules))
    )).scalars())
    member = aliased(UserORM)
    in_a_team = (
        select(member.id, member.last_active_at)
        .select_from(ServiceAccountManagerORM)
        .join(GroupORM, GroupORM.id == ServiceAccountManagerORM.group_id)
        .join(GroupMemberORM, GroupMemberORM.group_id == GroupORM.id)
        .join(member, member.id == GroupMemberORM.user_id)
        .where(
            ServiceAccountManagerORM.service_account_id == account_id,
            GroupORM.deleted_at.is_(None), in_good_standing(member, **rules),
        )
    )
    if maker and maker not in out:
        if (await session.execute(in_a_team.where(member.id == maker).limit(1))).first():
            out.add(maker)
    if not out:
        out = {row.id for row in (await session.execute(
            in_a_team.distinct()
            .order_by(member.last_active_at.desc().nulls_last(), member.id)
            .limit(TEAM_AUDIENCE)
        )).all()}
    return out


async def add_manager(
    session: AsyncSession, account_id: str, *, user_id: Optional[str] = None,
    group_id: Optional[str] = None, added_by: Optional[str],
) -> bool:
    """Appoint a person or a team. Returns whether they were not one already."""
    subject = (
        ServiceAccountManagerORM.user_id == user_id if user_id
        else ServiceAccountManagerORM.group_id == group_id
    )
    if (await session.execute(
        select(ServiceAccountManagerORM.id)
        .where(ServiceAccountManagerORM.service_account_id == account_id, subject)
    )).first() is not None:
        return False
    session.add(ServiceAccountManagerORM(
        service_account_id=account_id, user_id=user_id, group_id=group_id, added_by=added_by,
    ))
    await session.flush()
    return True


async def remove_manager(
    session: AsyncSession, account_id: str, *, user_id: Optional[str] = None,
    group_id: Optional[str] = None,
) -> bool:
    subject = (
        ServiceAccountManagerORM.user_id == user_id if user_id
        else ServiceAccountManagerORM.group_id == group_id
    )
    result = await session.execute(
        delete(ServiceAccountManagerORM)
        .where(ServiceAccountManagerORM.service_account_id == account_id, subject)
        .execution_options(synchronize_session=False)
    )
    return bool(result.rowcount)


async def is_manager(session: AsyncSession, account_id: str, user_id: str) -> bool:
    """Whether this person manages the account, themselves or through a live
    team they are in."""
    team_member = exists().where(
        GroupMemberORM.group_id == ServiceAccountManagerORM.group_id,
        GroupMemberORM.user_id == user_id,
        GroupORM.id == ServiceAccountManagerORM.group_id, GroupORM.deleted_at.is_(None),
    )
    return (await session.execute(
        select(ServiceAccountManagerORM.id).where(
            ServiceAccountManagerORM.service_account_id == account_id,
            or_(ServiceAccountManagerORM.user_id == user_id, team_member),
        ).limit(1)
    )).first() is not None


def _seats(user_id: str):
    """The accounts a person holds a seat on themselves."""
    return select(ServiceAccountManagerORM.service_account_id).where(
        ServiceAccountManagerORM.user_id == user_id,
    )


def _team_seats(user_id: str):
    """The accounts a person manages through a live team they are in."""
    return (
        select(ServiceAccountManagerORM.service_account_id)
        .join(GroupORM, GroupORM.id == ServiceAccountManagerORM.group_id)
        .join(GroupMemberORM, GroupMemberORM.group_id == GroupORM.id)
        .where(GroupMemberORM.user_id == user_id, GroupORM.deleted_at.is_(None))
    )


async def managed_accounts(session: AsyncSession, user_id: str) -> list[str]:
    """Accounts this person manages, themselves or through a live team."""
    return sorted(set((await session.execute(
        _seats(user_id).union(_team_seats(user_id))
    )).scalars().all()))


async def teams_through(
    session: AsyncSession, account_ids: Iterable[str], user_id: str,
) -> dict[str, list[str]]:
    """Per account, the live teams through which a person manages it, by name."""
    wanted = sorted(set(account_ids))
    out: dict[str, list[str]] = {a: [] for a in wanted}
    for account_id, name in (await session.execute(
        select(ServiceAccountManagerORM.service_account_id, GroupORM.name)
        .join(GroupORM, GroupORM.id == ServiceAccountManagerORM.group_id)
        .join(GroupMemberORM, GroupMemberORM.group_id == GroupORM.id)
        .where(
            ServiceAccountManagerORM.service_account_id.in_(wanted),
            GroupMemberORM.user_id == user_id, GroupORM.deleted_at.is_(None),
        )
        .order_by(func.lower(GroupORM.name), GroupORM.id)
    )).all() if wanted else []:
        out[account_id].append(name)
    return out


async def accounts_managed_by_team(session: AsyncSession, group_id: str) -> list[str]:
    return list((await session.execute(
        select(ServiceAccountManagerORM.service_account_id)
        .where(ServiceAccountManagerORM.group_id == group_id)
    )).scalars().all())


def _in_date():
    """A key neither revoked nor expired."""
    return and_(
        ApiKeyORM.revoked_at.is_(None),
        or_(ApiKeyORM.expires_at.is_(None), ApiKeyORM.expires_at > datetime.now(timezone.utc).isoformat()),
    )


async def live_keys_created_by(
    session: AsyncSession, account_ids: Iterable[str], user_id: str,
) -> dict[str, list[ApiKeyORM]]:
    """Per account, its keys still in date that this person made — the ones
    to rotate when they leave, since they may have kept a copy."""
    wanted = sorted(set(account_ids))
    out: dict[str, list[ApiKeyORM]] = {a: [] for a in wanted}
    for key in await live_keys_made(session, by=user_id, account_ids=wanted) if wanted else []:
        out[key.user_id].append(key)
    return out


async def live_keys_made(
    session: AsyncSession, *, by: Optional[str] = None, by_team: Optional[str] = None,
    account_ids: Optional[Iterable[str]] = None,
) -> list[ApiKeyORM]:
    """Service accounts' keys still in date that a person (``by``), or anyone
    in a team (``by_team``), made: on ``account_ids``, or on any account."""
    makers = (
        select(GroupMemberORM.user_id).where(GroupMemberORM.group_id == by_team) if by_team
        else [by]
    )
    stmt = (
        select(ApiKeyORM)
        .join(ServiceAccountORM, ServiceAccountORM.user_id == ApiKeyORM.user_id)
        .where(ApiKeyORM.created_by.in_(makers), _in_date())
    )
    if account_ids is not None:
        stmt = stmt.where(ApiKeyORM.user_id.in_(sorted(set(account_ids))))
    return list((await session.execute(
        stmt.order_by(ApiKeyORM.user_id, ApiKeyORM.created_at, ApiKeyORM.id)
    )).scalars().all())
