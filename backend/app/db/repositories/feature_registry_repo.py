"""
Repository for feature_categories and feature_definitions (schema/metadata from DB).
The PROSE comes from the database (an admin may reword it); the FACTS about where each flag is
enforced come from ``app/config/feature_wiring.py``, because only code can know what the code
does. ``_row_to_definition`` is where the two are joined.
Supports full CRUD for definitions: create, read, update, deprecate (soft delete).
"""
import json
from datetime import datetime, timezone
from typing import Any

from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from backend.app.config.feature_wiring import wiring_payload
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
    # The FACTS about this flag come from code, not from the row — see config/feature_wiring.py.
    # The admin page shows them ("Server-enforced", "what stops working", "what still works"),
    # and they must describe the deployment that is actually running, not what a row once said.
    return {
        "key": row.key,
        "name": row.name,
        "description": row.description,
        "category": row.category_id,
        "type": row.type,
        "default": default_val,
        "options": options,
        "helpUrl": row.help_url,
        "adminHint": row.admin_hint,
        "impactWhenOff": getattr(row, "impact_when_off", None),
        "sortOrder": row.sort_order,
        "deprecated": row.deprecated,
        # Derived, and reconciled into the row on every startup. `implemented` stays in the
        # response for its existing consumers, but it is now a projection of the code rather
        # than a claim about it.
        **wiring_payload(row.key),
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
    options: str | None = None,
    help_url: str | None = None,
    admin_hint: str | None = None,
    impact_when_off: str | None = None,
    sort_order: int = 0,
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
        options=options,
        help_url=help_url,
        admin_hint=admin_hint,
        impact_when_off=impact_when_off,
        sort_order=sort_order,
        deprecated=False,
        # `implemented` is DERIVED (config/feature_wiring.py) and reconciled at startup — a
        # definition invented at runtime has no gate behind it, so it defaults to False.
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
    # `implemented` is absent ON PURPOSE: it states whether a gate exists in the code, and no
    # API caller can make that true or false by saying so.
    allowed = {
        "name", "description", "category_id", "type", "default_value",
        "options", "help_url", "admin_hint", "impact_when_off",
        "sort_order", "deprecated",
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