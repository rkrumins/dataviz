"""Repository: ``api_key_usage`` — requests made with each API key, per day.

Written in batches by ``api_key_usage`` (the in-memory counter each API
process keeps), never once per request: every row is an increment added to
whatever the day already holds, so any number of processes can add to the
same key and day without reading first.
"""
from __future__ import annotations

from datetime import date, datetime, timedelta, timezone
from typing import Iterable, Sequence

from sqlalchemy import delete, select
from sqlalchemy.ext.asyncio import AsyncSession

from backend.app.db.models import ApiKeyORM, ApiKeyUsageORM

#: How long a day's counts are kept.
RETENTION_DAYS = 90
_CHUNK = 500
_COUNTS = ("requests", "writes", "refused", "errors")


def _today() -> date:
    return datetime.now(timezone.utc).date()


def _insert(session: AsyncSession):
    if session.get_bind().dialect.name == "sqlite":
        from sqlalchemy.dialects.sqlite import insert
    else:
        from sqlalchemy.dialects.postgresql import insert
    return insert


async def add(
    session: AsyncSession, rows: Sequence[tuple[str, str, int, int, int, int]],
) -> None:
    """Add ``(key_id, day, requests, writes, refused, errors)`` to what each
    key and day already holds. Rows go in key-then-day order, so two
    processes adding overlapping batches take their row locks in the same
    order and cannot deadlock."""
    insert = _insert(session)
    ordered = sorted(rows)
    for start in range(0, len(ordered), _CHUNK):
        chunk = ordered[start:start + _CHUNK]
        stmt = insert(ApiKeyUsageORM).values([
            dict(zip(("key_id", "day", *_COUNTS), row)) for row in chunk
        ])
        stmt = stmt.on_conflict_do_update(
            index_elements=["key_id", "day"],
            set_={
                name: getattr(ApiKeyUsageORM, name) + getattr(stmt.excluded, name)
                for name in _COUNTS
            },
        )
        await session.execute(stmt)


async def by_day(
    session: AsyncSession, key_ids: Iterable[str], *, days: int,
) -> dict[str, dict[str, tuple[int, int, int, int]]]:
    """Per key, per day (``YYYY-MM-DD``), the counts of the last ``days``
    days, today included. Days without a row are absent."""
    ids = sorted(set(key_ids))
    if not ids:
        return {}
    since = (_today() - timedelta(days=days - 1)).isoformat()
    rows = (await session.execute(
        select(ApiKeyUsageORM.key_id, ApiKeyUsageORM.day, *(
            getattr(ApiKeyUsageORM, name) for name in _COUNTS
        )).where(ApiKeyUsageORM.key_id.in_(ids), ApiKeyUsageORM.day >= since)
    )).all()
    out: dict[str, dict[str, tuple[int, int, int, int]]] = {}
    for key_id, day, *counts in rows:
        out.setdefault(key_id, {})[day] = tuple(int(c or 0) for c in counts)
    return out


def last_days(days: int) -> list[str]:
    """The last ``days`` days, oldest first, today last (UTC)."""
    today = _today()
    return [(today - timedelta(days=n)).isoformat() for n in range(days - 1, -1, -1)]


async def prune(session: AsyncSession, *, keep_days: int = RETENTION_DAYS) -> int:
    """Drop counts older than ``keep_days``, and counts of keys that no
    longer exist. Returns how many rows went."""
    cutoff = (_today() - timedelta(days=keep_days)).isoformat()
    old = await session.execute(delete(ApiKeyUsageORM).where(ApiKeyUsageORM.day < cutoff))
    # NOT EXISTS, not NOT IN: an anti-join however many keys there are,
    # where NOT IN falls back to a rescan of every key per row once their
    # ids no longer fit in memory.
    orphans = await session.execute(
        delete(ApiKeyUsageORM).where(
            ~select(ApiKeyORM.id).where(ApiKeyORM.id == ApiKeyUsageORM.key_id).exists()
        )
    )
    return int(old.rowcount or 0) + int(orphans.rowcount or 0)
