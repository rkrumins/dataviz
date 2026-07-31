"""People/group directory for share pickers.

``GET /api/v1/directory`` — available to ANY signed-in user, on
purpose: the share dialog's picker previously called the admin-only
user listing, so a view creator without admin rights saw an empty
picker and couldn't share at all. Sharing is an every-user capability,
so its directory is too.

Scope is deliberately minimal: active users (id, display name, email)
and groups (id, name, member count), search-driven with a hard result
cap. No roles, no bindings, no status detail — those stay on the
admin surfaces.
"""
from __future__ import annotations

from typing import List, Optional

from fastapi import APIRouter, Depends, Query
from pydantic import BaseModel, ConfigDict, Field
from sqlalchemy import func, or_, select
from sqlalchemy.ext.asyncio import AsyncSession

from backend.app.auth.dependencies import get_current_user
from backend.app.db.engine import get_db_session
from backend.app.db.models import GroupMemberORM, GroupORM, UserORM
from backend.auth_service.interface import User

router = APIRouter()


class DirectoryUser(BaseModel):
    model_config = ConfigDict(populate_by_name=True)

    id: str
    display_name: str = Field(alias="displayName")
    email: str


class DirectoryGroup(BaseModel):
    model_config = ConfigDict(populate_by_name=True)

    id: str
    name: str
    member_count: int = Field(alias="memberCount")


class DirectoryResponse(BaseModel):
    users: List[DirectoryUser]
    groups: List[DirectoryGroup]


@router.get("", response_model=DirectoryResponse, response_model_by_alias=True)
async def search_directory(
    q: str = Query("", max_length=200, description="Name/email substring."),
    types: str = Query(
        "user,group",
        description="Comma-separated subject kinds to include: user, group.",
    ),
    limit: int = Query(20, ge=1, le=50),
    _user: User = Depends(get_current_user),
    session: AsyncSession = Depends(get_db_session),
) -> DirectoryResponse:
    wanted = {t.strip() for t in types.split(",") if t.strip()}
    pattern = f"%{q.strip()}%" if q.strip() else "%"

    users: List[DirectoryUser] = []
    if "user" in wanted:
        rows = (await session.execute(
            select(UserORM)
            .where(
                UserORM.status == "active",
                or_(
                    UserORM.first_name.ilike(pattern),
                    UserORM.last_name.ilike(pattern),
                    (UserORM.first_name + " " + UserORM.last_name).ilike(pattern),
                    UserORM.email.ilike(pattern),
                ),
            )
            .order_by(UserORM.first_name, UserORM.last_name)
            .limit(limit)
        )).scalars().all()
        for u in rows:
            display = f"{u.first_name or ''} {u.last_name or ''}".strip() or u.email
            users.append(DirectoryUser(id=u.id, display_name=display, email=u.email))

    groups: List[DirectoryGroup] = []
    if "group" in wanted:
        member_count = (
            select(func.count(GroupMemberORM.user_id))
            .where(GroupMemberORM.group_id == GroupORM.id)
            .scalar_subquery()
        )
        rows = (await session.execute(
            select(GroupORM, member_count)
            .where(GroupORM.name.ilike(pattern))
            .order_by(GroupORM.name)
            .limit(limit)
        )).all()
        groups = [
            DirectoryGroup(id=g.id, name=g.name, member_count=int(count or 0))
            for g, count in rows
        ]

    return DirectoryResponse(users=users, groups=groups)
