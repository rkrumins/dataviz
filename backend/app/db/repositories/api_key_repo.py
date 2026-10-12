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

from sqlalchemy import and_, func, or_, select, update
from sqlalchemy.ext.asyncio import AsyncSession

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


async def revoke(
    session: AsyncSession, key_id: str, *, by: Optional[str], reason: str,
) -> bool:
    """Revoke one key. Conditional on it not being revoked already, so two
    revocations racing each other leave the first one's record standing.
    Returns whether this call revoked it."""
    result = await session.execute(
        update(ApiKeyORM)
        .where(ApiKeyORM.id == key_id, ApiKeyORM.revoked_at.is_(None))
        .values(revoked_at=_now().isoformat(), revoked_by=by, revoked_reason=reason)
        .execution_options(synchronize_session=False)
    )
    return bool(result.rowcount)


async def revoke_all_for_user(
    session: AsyncSession, user_id: str, *, by: Optional[str], reason: str,
) -> list[ApiKeyORM]:
    """Revoke every key the principal still holds. Returns the keys revoked."""
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
        .values(revoked_at=now_iso, revoked_by=by, revoked_reason=reason)
        .execution_options(synchronize_session=False)
    )
    return rows


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


async def list_for_user(session: AsyncSession, user_id: str) -> list[ApiKeyORM]:
    return list((await session.execute(
        select(ApiKeyORM)
        .where(ApiKeyORM.user_id == user_id)
        .order_by(ApiKeyORM.created_at.desc())
    )).scalars().all())


async def count_active_for_user(session: AsyncSession, user_id: str) -> int:
    return int((await session.execute(
        select(func.count(ApiKeyORM.id)).where(
            ApiKeyORM.user_id == user_id, _active_clause(_now().isoformat()),
        )
    )).scalar() or 0)


async def list_all(
    session: AsyncSession,
    *,
    owner_id: Optional[str] = None,
    status: Optional[str] = None,
    unused_days: Optional[int] = None,
    search: Optional[str] = None,
    limit: int = 50,
    offset: int = 0,
) -> tuple[list[tuple[ApiKeyORM, UserORM]], int]:
    """The admin inventory, newest first, with each key's principal.

    ``status``: ``active`` | ``expired`` | ``revoked``. ``unused_days``: active
    keys not used (or never used) in that many days — the ones worth asking
    about.
    """
    now = _now()
    now_iso = now.isoformat()
    conditions = []
    if owner_id:
        conditions.append(ApiKeyORM.user_id == owner_id)
    if status == "active":
        conditions.append(_active_clause(now_iso))
    elif status == "expired":
        conditions.append(and_(
            ApiKeyORM.revoked_at.is_(None),
            ApiKeyORM.expires_at.is_not(None),
            ApiKeyORM.expires_at <= now_iso,
        ))
    elif status == "revoked":
        conditions.append(ApiKeyORM.revoked_at.is_not(None))
    if unused_days:
        cutoff = (now - timedelta(days=unused_days)).isoformat()
        conditions.append(_active_clause(now_iso))
        conditions.append(or_(
            and_(ApiKeyORM.last_used_at.is_(None), ApiKeyORM.created_at < cutoff),
            ApiKeyORM.last_used_at < cutoff,
        ))
    if search:
        like = f"%{search.strip().lower()}%"
        conditions.append(or_(
            func.lower(ApiKeyORM.name).like(like),
            func.lower(ApiKeyORM.token_prefix).like(like),
            func.lower(UserORM.email).like(like),
        ))
    base = (
        select(ApiKeyORM, UserORM)
        .join(UserORM, UserORM.id == ApiKeyORM.user_id)
        .where(*conditions)
    )
    total = int((await session.execute(
        select(func.count()).select_from(base.subquery())
    )).scalar() or 0)
    rows = (await session.execute(
        base.order_by(ApiKeyORM.created_at.desc()).limit(limit).offset(offset)
    )).all()
    return [(key, owner) for key, owner in rows], total


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
            ApiKeyORM.expires_at.is_not(None),
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
