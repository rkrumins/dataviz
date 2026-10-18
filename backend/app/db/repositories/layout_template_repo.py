"""Repository: layout templates — the ``context_models`` rows with ``is_template``.

Rows only: who may see and change one is ``services/template_access.py``.
Deleting is a soft delete (``deleted_at``), so a restore brings back the same
id with its shares and the views that name it.
"""
import json
from datetime import datetime, timezone
from typing import Any, List, Optional

from sqlalchemy import func, select
from sqlalchemy.ext.asyncio import AsyncSession
from sqlalchemy.sql.elements import ColumnElement

from ..models import ContextModelORM


def layers_of(row: ContextModelORM) -> list:
    try:
        layers = json.loads(row.layers_config or "[]")
    except ValueError:
        return []
    return layers if isinstance(layers, list) else []


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
