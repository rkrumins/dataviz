"""
Repository for feature_flags (single-row config). Defaults come from feature_definitions in DB.
"""
import json
from datetime import datetime, timezone
from typing import Any

from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from ..models import FeatureFlagsORM
from .feature_registry_repo import get_definitions_map


CONFIG_ROW_ID = 1


def _defaults_from_definitions(definitions_map: dict[str, Any]) -> dict[str, Any]:
    """Build default values dict from feature_definitions (from DB)."""
    return {key: defn["default"] for key, defn in definitions_map.items()}


async def get_feature_flags(session: AsyncSession) -> tuple[dict[str, Any], str | None]:
    """
    Get current feature flag values and updated_at.
    Defaults come from feature_definitions table; stored values from feature_flags row.
    Returns (values_dict, updated_at_iso). If no flags row exists, returns (defaults, None).
    """
    definitions_map = await get_definitions_map(session)
    defaults = _defaults_from_definitions(definitions_map)

    result = await session.execute(
        select(FeatureFlagsORM).where(FeatureFlagsORM.id == CONFIG_ROW_ID)
    )
    row = result.scalar_one_or_none()
    if not row:
        return (defaults, None)
    config = json.loads(row.config) if row.config else {}
    values = dict(defaults)
    for k, v in config.items():
        if k in values:
            values[k] = v
    return (values, row.updated_at)


async def upsert_feature_flags(session: AsyncSession, values: dict[str, Any]) -> str:
    """
    Upsert the single feature_flags row. values must be full (validated) dict.
    Returns updated_at (ISO string).
    """
    now = datetime.now(timezone.utc).isoformat()
    config_json = json.dumps(values)

    result = await session.execute(
        select(FeatureFlagsORM).where(FeatureFlagsORM.id == CONFIG_ROW_ID)
    )
    row = result.scalar_one_or_none()
    if row:
        row.config = config_json
        row.updated_at = now
        return now
    session.add(
        FeatureFlagsORM(id=CONFIG_ROW_ID, config=config_json, updated_at=now)
    )
    return now
