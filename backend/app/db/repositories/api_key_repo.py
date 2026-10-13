"""Repository: ``api_keys``.

Owns the rows behind API keys: minting, the per-request lookup, the owner's
own list, the admin inventory, revocation, and the "last used" stamp.

Two rules every reader here follows:

* **Owner-scoped reads take the owner.** ``get_for_user`` and
  ``list_for_user`` filter on ``user_id`` in SQL, so another person's key id
  is indistinguishable from one that does not exist — an endpoint built on
  them cannot leak or act on someone else's key by id.
* **Nothing here ever sees a token.** Lookups are by ``token_hash``; the
  token itself exists only in the response that shows it once.

Injected into ``LocalIdentityService`` the same way ``user_repo`` is, since
``auth_service`` may not import ``backend.app``.
"""
from __future__ import annotations

import json
from dataclasses import dataclass
from datetime import datetime, timedelta, timezone
from typing import Iterable, Optional, Sequence

from sqlalchemy import and_, case, false, func, or_, select, update
from sqlalchemy.ext.asyncio import AsyncSession

from backend.app.db.advisory import hold_for_transaction
from backend.app.db.models import ApiKeyORM, UserIdentityORM, UserORM

#: Stored user agents are cut to this. They are a hint for a person reading
#: "last used from", not evidence, and an unbounded header should not grow
#: a row without limit.
_USER_AGENT_MAX = 256


def _now() -> datetime:
    return datetime.now(timezone.utc)


def _clip(value: Optional[str], limit: int = _USER_AGENT_MAX) -> Optional[str]:
    if not value:
        return None
    return value[:limit]


def dumps(value) -> str:
    return json.dumps(value, separators=(",", ":"), sort_keys=True)


def loads(raw: Optional[str], default):
    if not raw:
        return default
    try:
        return json.loads(raw)
    except (TypeError, ValueError):
        return default


# ── Status ──────────────────────────────────────────────────────────


def is_active(key: ApiKeyORM, *, now: Optional[datetime] = None) -> bool:
    """Not revoked and not past its own expiry. Policy (a lifetime cap, an
    owner who must sign in again) is applied on top, by the caller."""
    if key.revoked_at:
        return False
    if key.expires_at:
        return key.expires_at > (now or _now()).isoformat()
    return True


def _active_clause(now_iso: str):
    return and_(
        ApiKeyORM.revoked_at.is_(None),
        or_(ApiKeyORM.expires_at.is_(None), ApiKeyORM.expires_at > now_iso),
    )


#: Statuses of a key that is still in date: it works, or would if its owner
#: signed in again or were reactivated.
LIVE_STATUSES = ("active", "paused", "owner_inactive")


def _expired_clause(now: datetime, max_lifetime_days: Optional[int]):
    """Past its own expiry, or older than the deployment's maximum lifetime."""
    clauses = [and_(
        ApiKeyORM.expires_at.is_not(None), ApiKeyORM.expires_at <= now.isoformat(),
    )]
    if max_lifetime_days is not None:
        clauses.append(
            ApiKeyORM.created_at <= (now - timedelta(days=max_lifetime_days)).isoformat()
        )
    return or_(*clauses)


def _identity_facts():
    """Per owner: how many SSO identities, and their latest sign-in."""
    return (
        select(
            UserIdentityORM.user_id.label("user_id"),
            func.count(UserIdentityORM.id).label("identities"),
            func.max(UserIdentityORM.last_login_at).label("last_login_at"),
        )
        .group_by(UserIdentityORM.user_id)
        .subquery("identity_facts")
    )


def status_expr(
    facts, *, now: datetime, max_lifetime_days: Optional[int],
    sso_window_days: Optional[int],
):
    """The status a key shows, in SQL — ``api_keys.lifecycle_refusal`` in its
    own order — so the inventory's filters and counts agree with every badge
    (``revoked``, ``expired``, ``owner_inactive``, ``paused``, ``active``).
    Needs the key joined to its owner and outer-joined to ``facts``
    (``_identity_facts``)."""
    # Here, not at the top: the control plane's expiry sweep imports this
    # module and starts without the auth service's modules.
    from backend.auth_service.core.password import disabled_password_hash

    has_identity = func.coalesce(facts.c.identities, 0) > 0
    no_password = or_(
        UserORM.password_hash.is_(None),
        UserORM.password_hash == "",
        UserORM.password_hash == disabled_password_hash(),
    )
    paused = and_(~has_identity, no_password)
    if sso_window_days is not None:
        cutoff = (now - timedelta(days=sso_window_days)).isoformat()
        stale = or_(facts.c.last_login_at.is_(None), facts.c.last_login_at < cutoff)
        paused = or_(and_(has_identity, stale), paused)
    return case(
        (ApiKeyORM.revoked_at.is_not(None), "revoked"),
        (_expired_clause(now, max_lifetime_days), "expired"),
        (or_(UserORM.deleted_at.is_not(None), UserORM.status != "active"), "owner_inactive"),
        (paused, "paused"),
        else_="active",
    )


def _inventory(now: datetime, max_lifetime_days, sso_window_days):
    """Keys joined to what their status depends on, and that status."""
    facts = _identity_facts()
    status = status_expr(
        facts, now=now, max_lifetime_days=max_lifetime_days,
        sso_window_days=sso_window_days,
    )
    joined = (
        select(ApiKeyORM, UserORM)
        .join(UserORM, UserORM.id == ApiKeyORM.user_id)
        .outerjoin(facts, facts.c.user_id == ApiKeyORM.user_id)
    )
    return joined, status


# ── Writes ──────────────────────────────────────────────────────────


async def create(
    session: AsyncSession,
    *,
    user_id: str,
    kind: str,
    created_by: Optional[str],
    name: str,
    description: Optional[str],
    token_prefix: str,
    token_hash: str,
    permissions: dict,
    resources,
    allowed_cidrs: Optional[Sequence[str]],
    expires_at: Optional[str],
    created_ip: Optional[str],
    created_user_agent: Optional[str],
    rotated_from: Optional[str] = None,
) -> ApiKeyORM:
    row = ApiKeyORM(
        user_id=user_id,
        kind=kind,
        created_by=created_by,
        name=name,
        description=description or None,
        token_prefix=token_prefix,
        token_hash=token_hash,
        permissions=dumps(permissions),
        resources=dumps(resources),
        allowed_cidrs=dumps(list(allowed_cidrs)) if allowed_cidrs else None,
        expires_at=expires_at,
        created_at=_now().isoformat(),
        created_ip=_clip(created_ip, 64),
        created_user_agent=_clip(created_user_agent),
        rotated_from=rotated_from,
    )
    session.add(row)
    await session.flush()
    return row


async def hold_principal(session: AsyncSession, user_id: str) -> None:
    """Serialise changes to one principal's keys until the transaction ends:
    counting them and minting one, rotating one, revoking them all. Without
    it two requests could each pass the limit, or a rotation racing a
    revocation could leave a live successor of a key just revoked."""
    await hold_for_transaction(session, f"api-keys:{user_id}")


async def revoke(
    session: AsyncSession, key_id: str, *, by: Optional[str], reason: str,
    note: Optional[str] = None,
) -> bool:
    """Revoke one key. Conditional on it not being revoked already, so two
    revocations racing each other leave the first one's record standing.
    Returns whether this call revoked it."""
    result = await session.execute(
        update(ApiKeyORM)
        .where(ApiKeyORM.id == key_id, ApiKeyORM.revoked_at.is_(None))
        .values(
            revoked_at=_now().isoformat(), revoked_by=by, revoked_reason=reason,
            revoked_note=note or None,
        )
        .execution_options(synchronize_session=False)
    )
    return bool(result.rowcount)


async def revoke_all_for_user(
    session: AsyncSession, user_id: str, *, by: Optional[str], reason: str,
    note: Optional[str] = None,
) -> list[ApiKeyORM]:
    """Revoke every key the principal still holds. Returns the keys revoked."""
    await hold_principal(session, user_id)
    rows = list((await session.execute(
        select(ApiKeyORM).where(
            ApiKeyORM.user_id == user_id, ApiKeyORM.revoked_at.is_(None),
        )
    )).scalars().all())
    if not rows:
        return []
    now_iso = _now().isoformat()
    await session.execute(
        update(ApiKeyORM)
        .where(ApiKeyORM.id.in_([r.id for r in rows]), ApiKeyORM.revoked_at.is_(None))
        .values(
            revoked_at=now_iso, revoked_by=by, revoked_reason=reason,
            revoked_note=note or None,
        )
        .execution_options(synchronize_session=False)
    )
    return rows


async def update_details(
    session: AsyncSession, key_id: str, *, name: str, description: Optional[str],
) -> None:
    """Rename a key, or change what it says it is for. Nothing it may do."""
    await session.execute(
        update(ApiKeyORM)
        .where(ApiKeyORM.id == key_id)
        .values(name=name, description=description or None)
        .execution_options(synchronize_session=False)
    )


async def set_expiry(session: AsyncSession, key_id: str, expires_at: str) -> None:
    """Bring a key's expiry forward — rotation's grace period. Never pushes
    it later: a rotation must not extend the old key's life."""
    await session.execute(
        update(ApiKeyORM)
        .where(
            ApiKeyORM.id == key_id,
            or_(ApiKeyORM.expires_at.is_(None), ApiKeyORM.expires_at > expires_at),
        )
        .values(expires_at=expires_at)
        .execution_options(synchronize_session=False)
    )


async def touch_last_used(
    session: AsyncSession,
    key_id: str,
    *,
    ip: Optional[str],
    user_agent: Optional[str],
    resolution_seconds: int,
) -> None:
    """Stamp "last used". Conditional on the previous stamp being older than
    the resolution, so however many workers ask, a key gets one write per
    window — the cluster-wide half of the throttle ``ActivityGate`` starts."""
    now = _now()
    cutoff = (now - timedelta(seconds=resolution_seconds)).isoformat()
    await session.execute(
        update(ApiKeyORM)
        .where(
            ApiKeyORM.id == key_id,
            or_(ApiKeyORM.last_used_at.is_(None), ApiKeyORM.last_used_at < cutoff),
        )
        .values(
            last_used_at=now.isoformat(),
            last_used_ip=_clip(ip, 64),
            last_used_user_agent=_clip(user_agent),
        )
        .execution_options(synchronize_session=False)
    )


# ── Reads ───────────────────────────────────────────────────────────


@dataclass(frozen=True)
class AuthRow:
    """Everything one request needs to decide whether a key is honoured,
    read in one round trip."""

    key: ApiKeyORM
    owner: UserORM
    #: How many SSO identities the owner has, and when they last signed in
    #: through any of them. The IdP vouching for its user recently is what
    #: keeps an SSO owner's keys alive.
    identity_count: int
    idp_last_login_at: Optional[str]


async def find_for_auth(session: AsyncSession, token_hash: str) -> Optional[AuthRow]:
    identity_count = (
        select(func.count(UserIdentityORM.id))
        .where(UserIdentityORM.user_id == ApiKeyORM.user_id)
        .scalar_subquery()
    )
    idp_last_login = (
        select(func.max(UserIdentityORM.last_login_at))
        .where(UserIdentityORM.user_id == ApiKeyORM.user_id)
        .scalar_subquery()
    )
    row = (await session.execute(
        select(ApiKeyORM, UserORM, identity_count, idp_last_login)
        .join(UserORM, UserORM.id == ApiKeyORM.user_id)
        .where(ApiKeyORM.token_hash == token_hash)
    )).first()
    if row is None:
        return None
    key, owner, count, last_login = row
    return AuthRow(
        key=key, owner=owner,
        identity_count=int(count or 0), idp_last_login_at=last_login,
    )


async def get(session: AsyncSession, key_id: str) -> Optional[ApiKeyORM]:
    return await session.get(ApiKeyORM, key_id)


async def get_for_user(
    session: AsyncSession, user_id: str, key_id: str,
) -> Optional[ApiKeyORM]:
    return (await session.execute(
        select(ApiKeyORM).where(
            ApiKeyORM.id == key_id, ApiKeyORM.user_id == user_id,
        )
    )).scalar_one_or_none()


#: How long an ended key stays in its owner's list by default.
HISTORY_DAYS = 90
_HISTORY_MAX = 500


async def list_for_user(
    session: AsyncSession, user_id: str, *, history: bool = False,
) -> list[ApiKeyORM]:
    """The principal's keys, newest first: those still in date, and those
    that ended in the last ``HISTORY_DAYS`` — or, with ``history``, every one
    (bounded)."""
    stmt = select(ApiKeyORM).where(ApiKeyORM.user_id == user_id)
    if not history:
        cutoff = (_now() - timedelta(days=HISTORY_DAYS)).isoformat()
        stmt = stmt.where(or_(
            and_(
                ApiKeyORM.revoked_at.is_(None),
                or_(ApiKeyORM.expires_at.is_(None), ApiKeyORM.expires_at >= cutoff),
            ),
            ApiKeyORM.revoked_at >= cutoff,
        ))
    return list((await session.execute(
        stmt.order_by(ApiKeyORM.created_at.desc(), ApiKeyORM.id).limit(_HISTORY_MAX)
    )).scalars().all())


async def count_active_for_user(
    session: AsyncSession, user_id: str, *, max_lifetime_days: Optional[int] = None,
) -> int:
    """Keys still in date — what the per-person limit counts. A paused key
    counts: it comes back when its owner signs in."""
    return int((await session.execute(
        select(func.count(ApiKeyORM.id)).where(
            ApiKeyORM.user_id == user_id,
            ApiKeyORM.revoked_at.is_(None),
            ~_expired_clause(_now(), max_lifetime_days),
        )
    )).scalar() or 0)


async def has_successor(session: AsyncSession, key_id: str) -> bool:
    """Whether a rotation already replaced this key."""
    return (await session.execute(
        select(ApiKeyORM.id).where(ApiKeyORM.rotated_from == key_id).limit(1)
    )).first() is not None


async def successor_of(session: AsyncSession, key_id: str) -> Optional[ApiKeyORM]:
    return (await session.execute(
        select(ApiKeyORM).where(ApiKeyORM.rotated_from == key_id)
        .order_by(ApiKeyORM.created_at.desc()).limit(1)
    )).scalar_one_or_none()


#: Days ahead "expiring soon" looks, and back "unused" and "recently
#: revoked" look — the admin page's focus filters.
SOON_DAYS = 7
UNUSED_DAYS = 90
RECENT_DAYS = 30


def _focus_clause(
    focus: str, *, now: datetime, status, max_lifetime_days: Optional[int],
    unused_days: int = UNUSED_DAYS,
):
    live = status.in_(LIVE_STATUSES)
    if focus == "expiring_soon":
        soon = now + timedelta(days=SOON_DAYS)
        within = [and_(ApiKeyORM.expires_at.is_not(None), ApiKeyORM.expires_at <= soon.isoformat())]
        if max_lifetime_days is not None:
            within.append(
                ApiKeyORM.created_at
                <= (soon - timedelta(days=max_lifetime_days)).isoformat()
            )
        return and_(live, or_(*within))
    if focus == "never_expires":
        if max_lifetime_days is not None:
            return false()
        return and_(live, ApiKeyORM.expires_at.is_(None))
    if focus == "unused":
        cutoff = (now - timedelta(days=unused_days)).isoformat()
        return and_(live, or_(
            and_(ApiKeyORM.last_used_at.is_(None), ApiKeyORM.created_at < cutoff),
            ApiKeyORM.last_used_at < cutoff,
        ))
    if focus == "recently_revoked":
        return ApiKeyORM.revoked_at >= (now - timedelta(days=RECENT_DAYS)).isoformat()
    raise ValueError(f"unknown focus {focus!r}")


def _search_clause(search: str):
    like = f"%{search.strip().lower()}%"
    return or_(
        func.lower(ApiKeyORM.name).like(like),
        func.lower(ApiKeyORM.token_prefix).like(like),
        func.lower(UserORM.email).like(like),
    )


def _order(sort: str, order: str):
    """Explicit about where keys that were never used, or never expire, go:
    the two databases default to opposite ends."""
    descending = order == "desc"
    if sort == "name":
        column = func.lower(ApiKeyORM.name)
        return [column.desc() if descending else column.asc()]
    if sort == "lastUsed":
        column = ApiKeyORM.last_used_at
        # Most recent first ends with the never-used; least recent first
        # starts with them — they are the stalest of all.
        return [column.desc().nulls_last() if descending else column.asc().nulls_first()]
    if sort == "expires":
        column = ApiKeyORM.expires_at
        return [column.desc().nulls_first() if descending else column.asc().nulls_last()]
    column = ApiKeyORM.created_at
    return [column.desc() if descending else column.asc()]


async def list_all(
    session: AsyncSession,
    *,
    owner_id: Optional[str] = None,
    status: Optional[str] = None,
    focus: Optional[str] = None,
    unused_days: Optional[int] = None,
    search: Optional[str] = None,
    sort: str = "created",
    order: str = "desc",
    max_lifetime_days: Optional[int] = None,
    sso_window_days: Optional[int] = None,
    limit: int = 50,
    offset: int = 0,
) -> tuple[list[tuple[ApiKeyORM, UserORM]], int]:
    """The admin inventory, with each key's principal.

    ``status``: any status a key shows (``status_expr``). ``focus``:
    ``expiring_soon`` | ``never_expires`` | ``unused`` | ``recently_revoked``.
    ``unused_days``: live keys not used (or never used) in that many days.
    """
    base = _filtered(
        owner_id=owner_id, status=status, focus=focus, unused_days=unused_days,
        search=search, max_lifetime_days=max_lifetime_days, sso_window_days=sso_window_days,
    )
    total = int((await session.execute(
        select(func.count()).select_from(base.subquery())
    )).scalar() or 0)
    rows = (await session.execute(
        base.order_by(*_order(sort, order), ApiKeyORM.id).limit(limit).offset(offset)
    )).all()
    return [(key, owner) for key, owner in rows], total


async def list_ids(
    session: AsyncSession,
    *,
    sort: str = "created",
    order: str = "desc",
    limit: int,
    **filters,
) -> list[str]:
    """The ids ``list_all`` would list, in its order, at most ``limit`` — read
    once, so an export paging through them sees one moment of the table, not
    a page of each."""
    base = _filtered(**filters)
    return list((await session.execute(
        base.with_only_columns(ApiKeyORM.id)
        .order_by(*_order(sort, order), ApiKeyORM.id).limit(limit)
    )).scalars().all())


async def get_with_owners(
    session: AsyncSession, key_ids: list[str],
) -> list[tuple[ApiKeyORM, UserORM]]:
    """These keys with their owners, in the order given. A key gone since its
    id was read is left out."""
    rows = (await session.execute(
        select(ApiKeyORM, UserORM)
        .join(UserORM, UserORM.id == ApiKeyORM.user_id)
        .where(ApiKeyORM.id.in_(key_ids))
    )).all()
    found = {key.id: (key, owner) for key, owner in rows}
    return [found[i] for i in key_ids if i in found]


def _filtered(
    *,
    owner_id: Optional[str] = None,
    status: Optional[str] = None,
    focus: Optional[str] = None,
    unused_days: Optional[int] = None,
    search: Optional[str] = None,
    max_lifetime_days: Optional[int] = None,
    sso_window_days: Optional[int] = None,
):
    """The inventory, narrowed by ``list_all``'s filters."""
    now = _now()
    base, key_status = _inventory(now, max_lifetime_days, sso_window_days)
    conditions = []
    if owner_id:
        conditions.append(ApiKeyORM.user_id == owner_id)
    if status:
        conditions.append(key_status == status)
    if focus:
        conditions.append(_focus_clause(
            focus, now=now, status=key_status, max_lifetime_days=max_lifetime_days,
        ))
    if unused_days:
        conditions.append(_focus_clause(
            "unused", now=now, status=key_status, max_lifetime_days=max_lifetime_days,
            unused_days=unused_days,
        ))
    if search:
        conditions.append(_search_clause(search))
    return base.where(*conditions)


async def stats(
    session: AsyncSession,
    *,
    owner_id: Optional[str] = None,
    search: Optional[str] = None,
    max_lifetime_days: Optional[int] = None,
    sso_window_days: Optional[int] = None,
) -> dict[str, int]:
    """The inventory's counts — per status, and per focus — in one row, over
    the same owner and search filters the list takes."""
    now = _now()
    base, key_status = _inventory(now, max_lifetime_days, sso_window_days)

    def _count(condition):
        return func.coalesce(func.sum(case((condition, 1), else_=0)), 0)

    columns = [func.count(ApiKeyORM.id).label("total")]
    for name in ("active", "paused", "owner_inactive", "expired", "revoked"):
        columns.append(_count(key_status == name).label(name))
    for name, focus in (
        ("expiring_soon", "expiring_soon"), ("never_expires", "never_expires"),
        ("unused", "unused"), ("recently_revoked", "recently_revoked"),
    ):
        columns.append(_count(_focus_clause(
            focus, now=now, status=key_status, max_lifetime_days=max_lifetime_days,
        )).label(name))
    stmt = base.with_only_columns(*columns)
    if owner_id:
        stmt = stmt.where(ApiKeyORM.user_id == owner_id)
    if search:
        stmt = stmt.where(_search_clause(search))
    row = (await session.execute(stmt)).one()
    return {key: int(value or 0) for key, value in row._mapping.items()}


async def due_for_expiry_reminder(
    session: AsyncSession, *, within: timedelta, batch: int,
) -> list[ApiKeyORM]:
    """Active keys expiring inside ``within`` that the sweep has not looked
    at yet. The sweep decides which deserve a reminder and marks every row it
    took, so each key is considered once."""
    now = _now()
    return list((await session.execute(
        select(ApiKeyORM)
        .where(
            _active_clause(now.isoformat()),
            # Bounded on both sides in one place, so the expiry index serves
            # the range instead of every expired key ever made.
            ApiKeyORM.expires_at > now.isoformat(),
            ApiKeyORM.expires_at <= (now + within).isoformat(),
            ApiKeyORM.expiry_reminded_at.is_(None),
        )
        .order_by(ApiKeyORM.expires_at)
        .limit(batch)
    )).scalars().all())


async def mark_reminded(session: AsyncSession, key_ids: Iterable[str]) -> None:
    ids = list(key_ids)
    if not ids:
        return
    await session.execute(
        update(ApiKeyORM)
        .where(ApiKeyORM.id.in_(ids))
        .values(expiry_reminded_at=_now().isoformat())
        .execution_options(synchronize_session=False)
    )
