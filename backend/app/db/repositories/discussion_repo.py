"""Repository: discussions, discussion_messages, discussion_participants and watches —
the ``collaboration`` domain's tables.

No business logic here — ``backend.app.services.discussions`` owns access, routing,
notifications and outbox events. This module wraps the tables' reads and writes.
"""
from __future__ import annotations

from datetime import datetime, timezone
from typing import Optional

from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from backend.app.db.models import DiscussionORM, DiscussionParticipantORM


def now_iso() -> str:
    return datetime.now(timezone.utc).isoformat()


async def get(session: AsyncSession, discussion_id: str) -> Optional[DiscussionORM]:
    """One thread, deleted or not."""
    return (await session.execute(
        select(DiscussionORM).where(DiscussionORM.id == discussion_id)
    )).scalar_one_or_none()


async def participant(
    session: AsyncSession, discussion_id: str, user_id: str,
) -> Optional[DiscussionParticipantORM]:
    return (await session.execute(
        select(DiscussionParticipantORM).where(
            DiscussionParticipantORM.discussion_id == discussion_id,
            DiscussionParticipantORM.user_id == user_id,
        )
    )).scalar_one_or_none()
