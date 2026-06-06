"""Repository: ``user_external_attributes``.

Indexed projection of the operator-declared ``claim_mapping.extras``
bucket. The Phase-3 JSON snapshot at ``users.metadata_.attributes``
stays as the canonical "raw" view; this table is the queryable
projection that powers the admin lookup endpoint.

Write path: every SSO login feeds ``upsert_for_user`` with the
extracted attributes; UNIQUE(user_id, key) makes the operation
race-safe.

Read paths:
  * ``get_users_by_attribute(key, value)`` — the help-desk
    "find me ``staff_id=12345``" lookup.
  * ``list_for_user(user_id)`` — the per-user detail view.
"""
from __future__ import annotations

from datetime import datetime, timezone
from typing import Any, Iterable, Optional

from sqlalchemy import delete as sa_delete, select
from sqlalchemy.dialects.postgresql import insert as pg_insert
from sqlalchemy.ext.asyncio import AsyncSession
from sqlalchemy.exc import IntegrityError

from backend.app.db.models import UserExternalAttributeORM


def _now() -> str:
    return datetime.now(timezone.utc).isoformat()


def _normalise_value(v: Any) -> str | None:
    """Flatten multi-valued claims to a CSV; coerce scalars to str.

    Returns ``None`` for empty/missing values so the caller can wipe
    the row instead of writing a blank one."""
    if v is None:
        return None
    if isinstance(v, bool):
        return "true" if v else "false"
    if isinstance(v, (int, float)):
        return str(v)
    if isinstance(v, str):
        s = v.strip()
        return s or None
    if isinstance(v, (list, tuple)):
        parts = [
            _normalise_value(item) for item in v
        ]
        cleaned = [p for p in parts if p]
        return ", ".join(cleaned) if cleaned else None
    if isinstance(v, dict):
        # Nested dicts are not searchable; drop them. Operators who
        # want to index a nested value should configure the mapping
        # path to point at the leaf.
        return None
    return str(v)


async def upsert_for_user(
    session: AsyncSession,
    *,
    user_id: str,
    attributes: dict[str, Any],
    source_provider_id: Optional[str] = None,
) -> dict:
    """Upsert one row per ``key`` in ``attributes``. Empty / unparseable
    values cause the existing row (if any) for that key to be
    removed; new values overwrite in place. Returns a small dict of
    counters for audit.

    NOTE: this method does NOT delete keys not present in
    ``attributes`` — a single SSO login carries the keys that
    provider asserts; other providers' keys stay intact. To wipe a
    user's attributes entirely, call ``clear_for_user``.
    """
    if not attributes:
        return {"upserted": 0, "deleted": 0}

    upserted = 0
    deleted = 0
    now = _now()
    for raw_key, raw_value in attributes.items():
        if not isinstance(raw_key, str) or not raw_key.strip():
            continue
        key = raw_key.strip()
        value = _normalise_value(raw_value)
        if value is None:
            # Empty value -> remove the existing row (if any).
            res = await session.execute(
                sa_delete(UserExternalAttributeORM).where(
                    UserExternalAttributeORM.user_id == user_id,
                    UserExternalAttributeORM.key == key,
                )
            )
            if (res.rowcount or 0) > 0:
                deleted += 1
            continue

        # Try UPDATE first (covers the common "value changed on
        # subsequent login" case). If no row exists, INSERT.
        existing = await session.execute(
            select(UserExternalAttributeORM).where(
                UserExternalAttributeORM.user_id == user_id,
                UserExternalAttributeORM.key == key,
            )
        )
        row = existing.scalar_one_or_none()
        if row is not None:
            row.value = value
            row.source_provider_id = source_provider_id
            row.set_at = now
            upserted += 1
        else:
            try:
                session.add(UserExternalAttributeORM(
                    user_id=user_id,
                    key=key,
                    value=value,
                    source_provider_id=source_provider_id,
                    set_at=now,
                ))
                await session.flush()
                upserted += 1
            except IntegrityError:
                # Lost an INSERT race; fall back to UPDATE.
                await session.rollback()
                row = (await session.execute(
                    select(UserExternalAttributeORM).where(
                        UserExternalAttributeORM.user_id == user_id,
                        UserExternalAttributeORM.key == key,
                    )
                )).scalar_one_or_none()
                if row is not None:
                    row.value = value
                    row.source_provider_id = source_provider_id
                    row.set_at = now
                    upserted += 1
    if upserted or deleted:
        await session.flush()
    return {"upserted": upserted, "deleted": deleted}


async def clear_for_user(session: AsyncSession, user_id: str) -> int:
    """Wipe every attribute row for the user. Returns rowcount.
    Used by the admin "purge" endpoint (not in Phase 4 yet)."""
    res = await session.execute(
        sa_delete(UserExternalAttributeORM).where(
            UserExternalAttributeORM.user_id == user_id,
        )
    )
    return res.rowcount or 0


async def list_for_user(
    session: AsyncSession, user_id: str,
) -> list[UserExternalAttributeORM]:
    res = await session.execute(
        select(UserExternalAttributeORM)
        .where(UserExternalAttributeORM.user_id == user_id)
        .order_by(UserExternalAttributeORM.key)
    )
    return list(res.scalars().all())


async def get_users_by_attribute(
    session: AsyncSession,
    *,
    key: str,
    value: str,
    limit: int = 20,
) -> list[UserExternalAttributeORM]:
    """Help-desk lookup: ``staff_id=12345`` returns the matching
    attribute rows (joined to user in the calling endpoint).

    Uses ``idx_user_external_attributes_key_value``. The limit guards
    against operator typos (key='') from sending pages of unrelated
    rows back."""
    if not key or not value:
        return []
    res = await session.execute(
        select(UserExternalAttributeORM).where(
            UserExternalAttributeORM.key == key,
            UserExternalAttributeORM.value == value,
        ).limit(limit)
    )
    return list(res.scalars().all())


async def search_users_by_attribute_substring(
    session: AsyncSession,
    *,
    needle: str,
    limit: int = 20,
) -> list[UserExternalAttributeORM]:
    """Free-text fan-out: any user whose attribute value contains
    ``needle``. Hits the (key, value) composite index when the
    substring is on the left edge; otherwise sequential within the
    set of indexed attributes (which is small for help-desk use)."""
    if not needle:
        return []
    pattern = f"%{needle}%"
    res = await session.execute(
        select(UserExternalAttributeORM)
        .where(UserExternalAttributeORM.value.ilike(pattern))
        .limit(limit)
    )
    return list(res.scalars().all())
