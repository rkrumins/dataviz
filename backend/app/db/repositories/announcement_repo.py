"""Repository for the announcements table and announcement_config."""
import logging
from datetime import datetime, timezone
from typing import List, Optional

from sqlalchemy import select, delete
from sqlalchemy.ext.asyncio import AsyncSession

from ..models import AnnouncementORM, AnnouncementConfigORM
from backend.common.models.management import (
    AnnouncementCreateRequest,
    AnnouncementUpdateRequest,
    AnnouncementResponse,
    AnnouncementConfigUpdateRequest,
    AnnouncementConfigResponse,
)

logger = logging.getLogger(__name__)


def _to_response(row: AnnouncementORM) -> AnnouncementResponse:
    return AnnouncementResponse(
        id=row.id,
        title=row.title,
        message=row.message,
        bannerType=row.banner_type,
        isActive=row.is_active,
        snoozeDurationMinutes=row.snooze_duration_minutes,
        ctaText=row.cta_text,
        ctaUrl=row.cta_url,
        createdBy=row.created_by,
        updatedBy=row.updated_by,
        createdAt=row.created_at,
        updatedAt=row.updated_at,
    )


async def list_announcements(session: AsyncSession) -> List[AnnouncementResponse]:
    """Return all announcements, newest first."""
    stmt = select(AnnouncementORM).order_by(AnnouncementORM.created_at.desc())
    result = await session.execute(stmt)
    return [_to_response(r) for r in result.scalars().all()]


async def get_active_announcements(session: AsyncSession) -> List[AnnouncementResponse]:
    """Return only active announcements, newest first."""
    stmt = (
        select(AnnouncementORM)
        .where(AnnouncementORM.is_active == True)  # noqa: E712
        .order_by(AnnouncementORM.created_at.desc())
    )
    result = await session.execute(stmt)
    return [_to_response(r) for r in result.scalars().all()]


async def get_announcement(session: AsyncSession, ann_id: str) -> Optional[AnnouncementResponse]:
    """Return a single announcement by ID, or None."""
    result = await session.execute(
        select(AnnouncementORM).where(AnnouncementORM.id == ann_id)
    )
    row = result.scalar_one_or_none()
    return _to_response(row) if row else None


async def create_announcement(
    session: AsyncSession,
    req: AnnouncementCreateRequest,
    created_by: Optional[str] = None,
) -> AnnouncementResponse:
    """Insert a new announcement and return its response."""
    row = AnnouncementORM(
        title=req.title,
        message=req.message,
        banner_type=req.banner_type,
        is_active=req.is_active,
        snooze_duration_minutes=req.snooze_duration_minutes,
        cta_text=req.cta_text,
        cta_url=req.cta_url,
        created_by=created_by,
    )
    session.add(row)
    await session.flush()
    return _to_response(row)


async def update_announcement(
    session: AsyncSession,
    ann_id: str,
    req: AnnouncementUpdateRequest,
    updated_by: Optional[str] = None,
) -> Optional[AnnouncementResponse]:
    """Selectively update fields on an existing announcement. Returns None if not found."""
    result = await session.execute(
        select(AnnouncementORM).where(AnnouncementORM.id == ann_id)
    )
    row = result.scalar_one_or_none()
    if not row:
        return None

    if req.title is not None:
        row.title = req.title
    if req.message is not None:
        row.message = req.message
    if req.banner_type is not None:
        row.banner_type = req.banner_type
    if req.is_active is not None:
        row.is_active = req.is_active
    if req.snooze_duration_minutes is not None:
        row.snooze_duration_minutes = req.snooze_duration_minutes
    if req.cta_text is not None:
        row.cta_text = req.cta_text
    if req.cta_url is not None:
        row.cta_url = req.cta_url

    row.updated_by = updated_by
    row.updated_at = datetime.now(timezone.utc).isoformat()
    await session.flush()
    return _to_response(row)


async def delete_announcement(session: AsyncSession, ann_id: str) -> bool:
    """Hard-delete an announcement. Returns True if a row was deleted."""
    result = await session.execute(
        delete(AnnouncementORM).where(AnnouncementORM.id == ann_id)
    )
    return result.rowcount > 0


# ── Announcement Config (single-row global settings) ─────────────────

def _config_to_response(row: AnnouncementConfigORM) -> AnnouncementConfigResponse:
    return AnnouncementConfigResponse(
        pollIntervalSeconds=row.poll_interval_seconds,
        defaultSnoozeMinutes=row.default_snooze_minutes,
        updatedBy=row.updated_by,
        updatedAt=row.updated_at,
    )


async def get_announcement_config(session: AsyncSession) -> AnnouncementConfigResponse:
    """Return the global announcement config (always exists as row id=1)."""
    result = await session.execute(
        select(AnnouncementConfigORM).where(AnnouncementConfigORM.id == 1)
    )
    row = result.scalar_one_or_none()
    if not row:
        # Seed on first access
        row = AnnouncementConfigORM(id=1)
        session.add(row)
        await session.flush()
    return _config_to_response(row)


async def update_announcement_config(
    session: AsyncSession,
    req: AnnouncementConfigUpdateRequest,
    updated_by: Optional[str] = None,
) -> AnnouncementConfigResponse:
    """Update the global announcement config."""
    result = await session.execute(
        select(AnnouncementConfigORM).where(AnnouncementConfigORM.id == 1)
    )
    row = result.scalar_one_or_none()
    if not row:
        row = AnnouncementConfigORM(id=1)
        session.add(row)

    if req.poll_interval_seconds is not None:
        row.poll_interval_seconds = req.poll_interval_seconds
    if req.default_snooze_minutes is not None:
        row.default_snooze_minutes = req.default_snooze_minutes

    row.updated_by = updated_by
    row.updated_at = datetime.now(timezone.utc).isoformat()
    await session.flush()
    return _config_to_response(row)
