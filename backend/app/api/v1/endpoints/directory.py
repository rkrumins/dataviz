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

``GET /api/v1/directory/people?ids=`` names people a surface already holds
the ids of — who triggered a job, who added a member — for readers without
the admin user list.
"""
from __future__ import annotations

from typing import List, Optional

from fastapi import APIRouter, Depends, HTTPException, Query
from pydantic import BaseModel, ConfigDict, Field
from sqlalchemy import func, or_, select
from sqlalchemy.ext.asyncio import AsyncSession

from backend.app.auth.dependencies import get_current_user
from backend.app.db.engine import get_db_session
from backend.app.db.models import GroupMemberORM, GroupORM, UserORM
from backend.app.db.repositories import user_repo
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


class DirectoryPerson(BaseModel):
    model_config = ConfigDict(populate_by_name=True)

    id: str
    display_name: str = Field(alias="displayName")
    #: Absent for a deleted account: it is named, not contactable.
    email: Optional[str] = None
    deleted: bool = False
    avatar_id: Optional[str] = Field(default=None, alias="avatarId")


#: Ids one request may name.
_MAX_PEOPLE = 100


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


@router.get(
    "/people", response_model=List[DirectoryPerson], response_model_by_alias=True,
)
async def people_by_id(
    ids: str = Query(
        ..., max_length=4000, description="Comma-separated user ids, at most 100.",
    ),
    _user: User = Depends(get_current_user),
    session: AsyncSession = Depends(get_db_session),
) -> List[DirectoryPerson]:
    """Name a batch of people by id, in the order asked.

    A record holds an id — who triggered a job, who added a member — and the
    person reading it needs a name. Unlike the search above, accounts since
    deleted are included and marked, because the id is in a record and "who
    was that?" is the question; their email is not. An id that names nobody
    is simply absent, never "Unknown user".
    """
    wanted = list(dict.fromkeys(i.strip() for i in ids.split(",") if i.strip()))
    if len(wanted) > _MAX_PEOPLE:
        raise HTTPException(422, f"At most {_MAX_PEOPLE} ids at once.")
    found = await user_repo.get_identities_by_ids(session, wanted)
    return [
        DirectoryPerson(
            id=i,
            display_name=found[i]["name"] or found[i]["email"] or i,
            email=None if found[i]["deleted"] else found[i]["email"],
            deleted=found[i]["deleted"],
            avatar_id=found[i].get("avatar_id"),
        )
        for i in wanted if i in found
    ]
