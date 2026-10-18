"""Repository: layout templates — the ``context_models`` rows with ``is_template``.

Rows only: who may see and change one is ``services/template_access.py``.
Deleting is a soft delete (``deleted_at``), so a restore brings back the same
id with its shares and the views that name it. Every version of a template's
layers is kept in ``layout_template_versions``; ``version`` names the newest.
"""
import json
from datetime import datetime, timezone
from typing import Any, List, Optional

from sqlalchemy import delete, func, select
from sqlalchemy.ext.asyncio import AsyncSession
from sqlalchemy.sql.elements import ColumnElement

from ..models import ContextModelORM, LayoutTemplateFavouriteORM, LayoutTemplateVersionORM


def _json_list(text: Optional[str]) -> list:
    try:
        layers = json.loads(text or "[]")
    except ValueError:
        return []
    return layers if isinstance(layers, list) else []


def layers_of(row: ContextModelORM | LayoutTemplateVersionORM) -> list:
    """A template's layers, or one version's."""
    return _json_list(row.layers_config if isinstance(row, ContextModelORM) else row.layers)


async def list_templates(
    session: AsyncSession, where: ColumnElement[bool], *, limit: int,
) -> tuple[List[ContextModelORM], int]:
    """The rows ``where`` admits, most recently changed first, and how many there are."""
    rows = await session.execute(
        select(ContextModelORM).where(where)
        .order_by(ContextModelORM.updated_at.desc(), ContextModelORM.id)
        .limit(limit)
    )
    total = await session.scalar(select(func.count()).select_from(ContextModelORM).where(where))
    return list(rows.scalars().all()), int(total or 0)


async def get_template(session: AsyncSession, template_id: str) -> Optional[ContextModelORM]:
    """The template, deleted or not; None when there is no such template."""
    row = await session.get(ContextModelORM, template_id)
    return row if row is not None and row.is_template else None


async def create_template(
    session: AsyncSession,
    *,
    name: str,
    description: Optional[str],
    category: Optional[str],
    visibility: str,
    workspace_id: Optional[str],
    layers: list,
    created_by: str,
) -> ContextModelORM:
    row = ContextModelORM(
        name=name,
        description=description,
        category=category,
        is_template=True,
        visibility=visibility,
        workspace_id=workspace_id,
        layers_config=json.dumps(layers),
        created_by=created_by,
    )
    session.add(row)
    await session.flush()
    await add_version(session, row, created_by=created_by)
    return row


async def update_template(
    session: AsyncSession, row: ContextModelORM, changes: dict[str, Any],
) -> ContextModelORM:
    """Apply ``changes`` — column name → value, with ``layers`` as a list."""
    for column, value in changes.items():
        if column == "layers":
            row.layers_config = json.dumps(value)
        else:
            setattr(row, column, value)
    await session.flush()
    return row


async def set_deleted(
    session: AsyncSession, row: ContextModelORM, deleted_by: Optional[str],
) -> ContextModelORM:
    """Soft-delete ``row`` as ``deleted_by``; None restores it."""
    row.deleted_at = datetime.now(timezone.utc).isoformat() if deleted_by else None
    row.deleted_by = deleted_by
    await session.flush()
    return row


async def add_version(
    session: AsyncSession, row: ContextModelORM, *,
    created_by: Optional[str], change_note: Optional[str] = None,
) -> LayoutTemplateVersionORM:
    """Keep ``row``'s layers as its version ``row.version`` — called when a
    template is made and whenever its layers change."""
    version = LayoutTemplateVersionORM(
        template_id=row.id, version=row.version, name=row.name,
        layers=row.layers_config or "[]", change_note=change_note, created_by=created_by,
    )
    session.add(version)
    await session.flush()
    return version


async def list_versions(session: AsyncSession, template_id: str) -> List[LayoutTemplateVersionORM]:
    """Every version of a template, newest first."""
    rows = await session.execute(
        select(LayoutTemplateVersionORM)
        .where(LayoutTemplateVersionORM.template_id == template_id)
        .order_by(LayoutTemplateVersionORM.version.desc())
    )
    return list(rows.scalars().all())


async def get_version(
    session: AsyncSession, template_id: str, version: int,
) -> Optional[LayoutTemplateVersionORM]:
    return await session.scalar(
        select(LayoutTemplateVersionORM).where(
            LayoutTemplateVersionORM.template_id == template_id,
            LayoutTemplateVersionORM.version == version,
        )
    )


async def favourite_ids(session: AsyncSession, user_id: str, ids: List[str]) -> set:
    """Which of ``ids`` are ``user_id``'s favourites."""
    if not ids:
        return set()
    rows = await session.execute(
        select(LayoutTemplateFavouriteORM.template_id).where(
            LayoutTemplateFavouriteORM.user_id == user_id,
            LayoutTemplateFavouriteORM.template_id.in_(ids),
        )
    )
    return {tid for (tid,) in rows.all()}


async def set_favourite(session: AsyncSession, template_id: str, user_id: str, on: bool) -> bool:
    """Make it a favourite or not; True when that changed anything."""
    if not on:
        result = await session.execute(delete(LayoutTemplateFavouriteORM).where(
            LayoutTemplateFavouriteORM.template_id == template_id,
            LayoutTemplateFavouriteORM.user_id == user_id,
        ))
        return bool(result.rowcount)
    if await favourite_ids(session, user_id, [template_id]):
        return False
    session.add(LayoutTemplateFavouriteORM(template_id=template_id, user_id=user_id))
    await session.flush()
    return True


def set_promotion_request(row: ContextModelORM, *, requested_by: Optional[str], note: Optional[str]) -> None:
    """Record a request to offer ``row`` to everyone, or clear it (``requested_by=None``)."""
    row.promotion_requested_by = requested_by
    row.promotion_requested_at = datetime.now(timezone.utc).isoformat() if requested_by else None
    row.promotion_request_note = note if requested_by else None
