"""The bell: a signed-in user's own notifications.

Every route is scoped to the caller — there is no "read someone else's
notifications" shape here, by construction rather than by check.
"""
from __future__ import annotations

from typing import List, Optional

from fastapi import APIRouter, Body, Depends, Query
from pydantic import BaseModel
from sqlalchemy.ext.asyncio import AsyncSession

from backend.app.auth.dependencies import get_current_user
from backend.app.db.engine import get_db_session
from backend.app.db.repositories import notification_repo
from backend.auth_service.interface import User

router = APIRouter()


class NotificationListResponse(BaseModel):
    items: List[notification_repo.NotificationEntry]
    unread: int


@router.get("", response_model=NotificationListResponse)
async def list_notifications(
    limit: int = Query(30, le=100),
    unread_only: bool = Query(False, alias="unreadOnly"),
    user: User = Depends(get_current_user),
    session: AsyncSession = Depends(get_db_session),
) -> NotificationListResponse:
    """This user's newest notifications, plus the unread badge count."""
    items = await notification_repo.list_for_user(
        session, user.id, limit=limit, unread_only=unread_only,
    )
    return NotificationListResponse(
        items=items,
        unread=await notification_repo.unread_count(session, user.id),
    )


@router.post("/read", response_model=NotificationListResponse)
async def mark_notifications_read(
    ids: Optional[List[str]] = Body(None, embed=True),
    user: User = Depends(get_current_user),
    session: AsyncSession = Depends(get_db_session),
) -> NotificationListResponse:
    """Mark the given notifications read — or all of them when ``ids`` is
    omitted. Ids belonging to anyone else are simply not matched."""
    await notification_repo.mark_read(session, user.id, ids)
    items = await notification_repo.list_for_user(session, user.id)
    return NotificationListResponse(
        items=items,
        unread=await notification_repo.unread_count(session, user.id),
    )
