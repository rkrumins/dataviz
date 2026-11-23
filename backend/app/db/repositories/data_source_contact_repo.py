"""Repository: data_source_contacts — a data source's named Owner and Stewards.

A save replaces the whole set at once, so every row of one save carries the same
``created_at``; the newest is the set's ``updatedAt``, which an editor sends back
to show what they changed was what they read. No business logic here — who may
change what is ``backend.app.services.data_source_contacts``'s.
"""
from __future__ import annotations

from typing import Iterable, Optional

from sqlalchemy import delete, or_, and_, select
from sqlalchemy.ext.asyncio import AsyncSession

from backend.app.db.models import DataSourceContactORM

STEWARDS_MAX = 10


async def list_for_source(session: AsyncSession, data_source_id: str) -> list[DataSourceContactORM]:
    """The source's named contacts: the Owner first, then people, then groups."""
    rows = (await session.execute(
        select(DataSourceContactORM).where(DataSourceContactORM.data_source_id == data_source_id)
        .order_by(DataSourceContactORM.role, DataSourceContactORM.subject_type.desc(),
                  DataSourceContactORM.subject_id)
    )).scalars().all()
    return list(rows)


def updated_at(rows: Iterable[DataSourceContactORM]) -> Optional[str]:
    """When the set was last saved, or ``None`` when nobody is named."""
    return max((r.created_at for r in rows), default=None)


async def replace(
    session: AsyncSession,
    data_source_id: str,
    *,
    owner: Optional[tuple[str, str]],
    stewards: list[tuple[str, str]],
    added_by: str,
    now: str,
) -> list[DataSourceContactORM]:
    """Replace the set: ``owner`` and each steward are ``(subject_type, subject_id)``."""
    await session.execute(
        delete(DataSourceContactORM).where(DataSourceContactORM.data_source_id == data_source_id)
    )
    rows = [
        DataSourceContactORM(data_source_id=data_source_id, role=role, subject_type=kind,
                             subject_id=sid, added_by=added_by, created_at=now)
        for role, (kind, sid) in ([("owner", owner)] if owner else []) + [("steward", s) for s in stewards]
    ]
    session.add_all(rows)
    await session.flush()
    return rows


async def list_for_people(
    session: AsyncSession, *, user_id: str, group_ids: Iterable[str],
) -> list[DataSourceContactORM]:
    """Every source naming this person — directly, or through a group they are in."""
    direct = and_(DataSourceContactORM.subject_type == "user", DataSourceContactORM.subject_id == user_id)
    groups = sorted(set(group_ids))
    where = or_(direct, and_(DataSourceContactORM.subject_type == "group",
                             DataSourceContactORM.subject_id.in_(groups))) if groups else direct
    rows = (await session.execute(
        select(DataSourceContactORM).where(where).order_by(DataSourceContactORM.data_source_id).limit(500)
    )).scalars().all()
    return list(rows)
