"""
Repository for feature_categories and feature_definitions (schema/metadata from DB).
No hardcoded registry — all data comes from the database.
Supports full CRUD for definitions: create, read, update, deprecate (soft delete).
"""
import json
from datetime import datetime, timezone
from typing import Any

from sqlalchemy import select, update
from sqlalchemy.ext.asyncio import AsyncSession

from ..models import FeatureCategoryORM, FeatureDefinitionORM, FeatureRegistryMetaORM


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
            "preview": getattr(row, "preview", True),
            "previewLabel": getattr(row, "preview_label", None) or None,
            "previewFooter": getattr(row, "preview_footer", None) or None,
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
        out.append(_row_to_definition(row))
    return out


async def get_definitions_map(session: AsyncSession) -> dict[str, dict[str, Any]]:
    """Return definitions keyed by feature key, for validation and default values. Includes deprecated."""
    defs = await get_all_definitions(session, include_deprecated=True)
    return {d["key"]: d for d in defs}


async def update_definitions_implemented(
    session: AsyncSession, updates: dict[str, bool]
) -> None:
    """Set implemented flag for given feature keys. Keys must exist in feature_definitions; unknown keys are ignored."""
    if not updates:
        return
    valid_keys = {d["key"] for d in await get_all_definitions(session, include_deprecated=True)}
    for key, value in updates.items():
        if key not in valid_keys:
            continue
        await session.execute(
            update(FeatureDefinitionORM)
            .where(FeatureDefinitionORM.key == key)
            .values(implemented=bool(value))
        )
    await session.flush()


def _row_to_definition(row: FeatureDefinitionORM) -> dict[str, Any]:
    """Map ORM row to API-shaped definition dict."""
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
    return {
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
        "implemented": getattr(row, "implemented", False),
    }


async def category_exists(session: AsyncSession, category_id: str) -> bool:
    """Return True if feature_categories has a row with the given id."""
    r = await session.execute(
        select(FeatureCategoryORM.id).where(FeatureCategoryORM.id == category_id).limit(1)
    )
    return r.scalar_one_or_none() is not None


async def create_definition(
    session: AsyncSession,
    *,
    key: str,
    name: str,
    description: str,
    category_id: str,
    type: str,
    default_value: str,
    user_overridable: bool = False,
    options: str | None = None,
    help_url: str | None = None,
    admin_hint: str | None = None,
    sort_order: int = 0,
    implemented: bool = False,
) -> dict[str, Any]:
    """Insert a new feature definition. Raises ValueError if key exists or category_id invalid."""
    r = await session.execute(select(FeatureDefinitionORM).where(FeatureDefinitionORM.key == key))
    if r.scalar_one_or_none() is not None:
        raise ValueError(f"Feature key already exists: {key}")
    if not await category_exists(session, category_id):
        raise ValueError(f"Category does not exist: {category_id}")
    row = FeatureDefinitionORM(
        key=key,
        name=name,
        description=description,
        category_id=category_id,
        type=type,
        default_value=default_value,
        user_overridable=user_overridable,
        options=options,
        help_url=help_url,
        admin_hint=admin_hint,
        sort_order=sort_order,
        deprecated=False,
        implemented=implemented,
    )
    session.add(row)
    await session.flush()
    return _row_to_definition(row)


async def update_definition(
    session: AsyncSession,
    key: str,
    **fields: Any,
) -> dict[str, Any] | None:
    """Update an existing definition. Only provided fields are updated. Returns updated dict or None if not found."""
    r = await session.execute(select(FeatureDefinitionORM).where(FeatureDefinitionORM.key == key))
    row = r.scalar_one_or_none()
    if row is None:
        return None
    allowed = {
        "name", "description", "category_id", "type", "default_value",
        "user_overridable", "options", "help_url", "admin_hint", "sort_order",
        "deprecated", "implemented",
    }
    for k, v in fields.items():
        if k not in allowed:
            continue
        if k == "category_id" and v is not None and not await category_exists(session, str(v)):
            raise ValueError(f"Category does not exist: {v}")
        setattr(row, k, v)
    await session.flush()
    return _row_to_definition(row)


async def set_definition_deprecated(session: AsyncSession, key: str, deprecated: bool = True) -> bool:
    """Set deprecated flag on a definition. Returns True if found and updated."""
    r = await session.execute(select(FeatureDefinitionORM).where(FeatureDefinitionORM.key == key))
    row = r.scalar_one_or_none()
    if row is None:
        return False
    row.deprecated = deprecated
    await session.flush()
    return True


# --------------------------------------------------------------------------- #
# feature_registry_meta (single row: experimental notice copy)
# --------------------------------------------------------------------------- #


async def get_ui_meta(session: AsyncSession) -> dict[str, Any] | None:
    """Return the single feature_registry_meta row as API-shaped dict, or None if no row."""
    r = await session.execute(select(FeatureRegistryMetaORM).limit(1))
    row = r.scalar_one_or_none()
    if row is None:
        return None
    updated_at = getattr(row, "updated_at", None) or None
    if updated_at == "":
        updated_at = None
    return {
        "experimentalNoticeEnabled": bool(row.experimental_notice_enabled),
        "experimentalNoticeTitle": row.experimental_notice_title or None,
        "experimentalNoticeMessage": row.experimental_notice_message or None,
        "experimentalNoticeUpdatedAt": updated_at,
    }


async def upsert_ui_meta(
    session: AsyncSession,
    *,
    experimental_notice_enabled: bool | None = None,
    experimental_notice_title: str | None = None,
    experimental_notice_message: str | None = None,
) -> dict[str, Any]:
    """Insert or update the single feature_registry_meta row. Returns current API-shaped meta."""
    r = await session.execute(select(FeatureRegistryMetaORM).limit(1))
    row = r.scalar_one_or_none()
    if row is None:
        row = FeatureRegistryMetaORM(id=1)
        session.add(row)
        await session.flush()
    if experimental_notice_enabled is not None:
        row.experimental_notice_enabled = experimental_notice_enabled
    if experimental_notice_title is not None:
        row.experimental_notice_title = experimental_notice_title
    if experimental_notice_message is not None:
        row.experimental_notice_message = experimental_notice_message
    if any(x is not None for x in (experimental_notice_enabled, experimental_notice_title, experimental_notice_message)):
        if hasattr(row, "updated_at"):
            row.updated_at = datetime.now(timezone.utc).isoformat()
    await session.flush()
    updated_at = getattr(row, "updated_at", None) or None
    if updated_at == "":
        updated_at = None
    return {
        "experimentalNoticeEnabled": bool(row.experimental_notice_enabled),
        "experimentalNoticeTitle": row.experimental_notice_title or None,
        "experimentalNoticeMessage": row.experimental_notice_message or None,
        "experimentalNoticeUpdatedAt": updated_at,
    }