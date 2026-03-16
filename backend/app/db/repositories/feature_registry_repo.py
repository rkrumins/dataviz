"""
Repository for feature_categories and feature_definitions (schema/metadata from DB).
No hardcoded registry — all data comes from the database.
"""
import json
from typing import Any

from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from ..models import FeatureCategoryORM, FeatureDefinitionORM


async def get_all_categories(session: AsyncSession) -> list[dict[str, Any]]:
    """Return all categories as API-shaped dicts (camelCase), ordered by sort_order."""
    r = await session.execute(
        select(FeatureCategoryORM).order_by(FeatureCategoryORM.sort_order)
    )
    rows = r.scalars().all()
    return [
        {
            "id": row.id,
            "label": row.label,
            "icon": row.icon,
            "color": row.color,
            "sortOrder": row.sort_order,
        }
        for row in rows
    ]


async def get_all_definitions(
    session: AsyncSession, include_deprecated: bool = False
) -> list[dict[str, Any]]:
    """Return all feature definitions as API-shaped dicts (camelCase). Excludes deprecated by default."""
    q = select(FeatureDefinitionORM).order_by(FeatureDefinitionORM.sort_order)
    r = await session.execute(q)
    rows = r.scalars().all()
    out = []
    for row in rows:
        if row.deprecated and not include_deprecated:
            continue
        default_val = row.default_value
        try:
            default_val = json.loads(row.default_value)
        except Exception:
            pass
        options = None
        if row.options:
            try:
                options = json.loads(row.options)
            except Exception:
                pass
        out.append({
            "key": row.key,
            "name": row.name,
            "description": row.description,
            "category": row.category_id,
            "type": row.type,
            "default": default_val,
            "userOverridable": row.user_overridable,
            "options": options,
            "helpUrl": row.help_url,
            "adminHint": row.admin_hint,
            "sortOrder": row.sort_order,
            "deprecated": row.deprecated,
        })
    return out


async def get_definitions_map(session: AsyncSession) -> dict[str, dict[str, Any]]:
    """Return definitions keyed by feature key, for validation and default values. Includes deprecated."""
    defs = await get_all_definitions(session, include_deprecated=True)
    return {d["key"]: d for d in defs}