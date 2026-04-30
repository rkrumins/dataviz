"""Repository: groups and group_members.

Groups are global (workspace-independent) — see the RBAC design plan.
The same group can be bound to many workspaces with different roles
through ``role_bindings``.
"""
from __future__ import annotations

from datetime import datetime, timezone
from typing import Optional

from sqlalchemy import select, delete, func
from sqlalchemy.ext.asyncio import AsyncSession

from backend.app.db.models import GroupORM, GroupMemberORM


def _now() -> str:
    return datetime.now(timezone.utc).isoformat()


# ── Groups ────────────────────────────────────────────────────────────

async def create_group(
    session: AsyncSession,
    name: str,
    description: Optional[str] = None,
    source: str = "local",
    external_id: Optional[str] = None,
) -> GroupORM:
    group = GroupORM(
        name=name.strip(),
        description=description,
        source=source,
        external_id=external_id,
    )
    session.add(group)
    await session.flush()
    return group


async def get_group_by_id(session: AsyncSession, group_id: str) -> Optional[GroupORM]:
    result = await session.execute(
        select(GroupORM).where(
            GroupORM.id == group_id,
            GroupORM.deleted_at.is_(None),
        )
    )
    return result.scalar_one_or_none()


async def get_group_by_name(session: AsyncSession, name: str) -> Optional[GroupORM]:
    result = await session.execute(
        select(GroupORM).where(
            GroupORM.name == name.strip(),
            GroupORM.deleted_at.is_(None),
        )
    )
    return result.scalar_one_or_none()


async def list_groups(
    session: AsyncSession,
    limit: int = 100,
    offset: int = 0,
) -> list[GroupORM]:
    stmt = (
        select(GroupORM)
        .where(GroupORM.deleted_at.is_(None))
        .order_by(GroupORM.name)
        .limit(limit)
        .offset(offset)
    )
    result = await session.execute(stmt)
    return list(result.scalars().all())


async def update_group(
    session: AsyncSession,
    group_id: str,
    *,
    name: Optional[str] = None,
    description: Optional[str] = None,
) -> Optional[GroupORM]:
    group = await get_group_by_id(session, group_id)
    if group is None:
        return None
    if name is not None:
        group.name = name.strip()
    if description is not None:
        group.description = description
    group.updated_at = _now()
    await session.flush()
    return group


async def soft_delete_group(session: AsyncSession, group_id: str) -> bool:
    group = await get_group_by_id(session, group_id)
    if group is None:
        return False
    group.deleted_at = _now()
    group.updated_at = _now()
    await session.flush()
    return True


# ── Membership ────────────────────────────────────────────────────────

async def add_member(
    session: AsyncSession,
    group_id: str,
    user_id: str,
    added_by: Optional[str] = None,
) -> GroupMemberORM:
    member = GroupMemberORM(
        group_id=group_id,
        user_id=user_id,
        added_by=added_by,
    )
    session.add(member)
    await session.flush()
    return member


async def remove_member(
    session: AsyncSession, group_id: str, user_id: str
) -> bool:
    result = await session.execute(
        delete(GroupMemberORM).where(
            GroupMemberORM.group_id == group_id,
            GroupMemberORM.user_id == user_id,
        )
    )
    return (result.rowcount or 0) > 0


async def list_group_members(
    session: AsyncSession, group_id: str
) -> list[GroupMemberORM]:
    result = await session.execute(
        select(GroupMemberORM)
        .where(GroupMemberORM.group_id == group_id)
        .order_by(GroupMemberORM.added_at)
    )
    return list(result.scalars().all())


async def get_user_groups(session: AsyncSession, user_id: str) -> list[str]:
    """Return the group ids the user belongs to.

    Hot path — called on every login by the PermissionResolver. The
    composite (user_id) index on group_members makes this an O(k) probe
    where k is the number of groups for the user.
    """
    result = await session.execute(
        select(GroupMemberORM.group_id).where(GroupMemberORM.user_id == user_id)
    )
    return list(result.scalars().all())


async def count_members(session: AsyncSession, group_id: str) -> int:
    result = await session.execute(
        select(func.count())
        .select_from(GroupMemberORM)
        .where(GroupMemberORM.group_id == group_id)
    )
    return result.scalar_one()
