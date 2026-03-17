"""
Repository for feature_flags (single-row config). Defaults come from feature_definitions in DB.
Values are only returned for non-deprecated definitions by default.
"""
import json
from datetime import datetime, timezone
from typing import Any

from sqlalchemy import select, update
from sqlalchemy.ext.asyncio import AsyncSession

from ..models import FeatureFlagsORM
from .feature_registry_repo import get_all_definitions, get_definitions_map


CONFIG_ROW_ID = 1


def _defaults_from_definitions(definitions_map: dict[str, Any]) -> dict[str, Any]:
    """Build default values dict from feature_definitions (from DB)."""
    return {key: defn["default"] for key, defn in definitions_map.items()}


async def get_feature_flags(
    session: AsyncSession, include_deprecated: bool = False
) -> tuple[dict[str, Any], str | None, int]:
    """
    Get current feature flag values, updated_at, and version (for optimistic concurrency).
    When include_deprecated=False (default), only keys for non-deprecated definitions are returned.
    Returns (values_dict, updated_at_iso, version). If no flags row exists, returns (defaults, None, 0).
    """
    definitions_map = await get_definitions_map(session)
    all_defaults = _defaults_from_definitions(definitions_map)
    if not include_deprecated:
        defs_list = await get_all_definitions(session, include_deprecated=False)
        valid_keys = {d["key"] for d in defs_list}
        defaults = {k: v for k, v in all_defaults.items() if k in valid_keys}
    else:
        defaults = all_defaults

    result = await session.execute(
        select(FeatureFlagsORM).where(FeatureFlagsORM.id == CONFIG_ROW_ID)
    )
    row = result.scalar_one_or_none()
    if not row:
        return (defaults, None, 0)
    config = json.loads(row.config) if row.config else {}
    values = dict(defaults)
    for k, v in config.items():
        if k in values:
            values[k] = v
    if not include_deprecated:
        values = {k: v for k, v in values.items() if k in defaults}
    version = getattr(row, "version", 0)
    return (values, row.updated_at, version)


class ConcurrencyConflictError(Exception):
    """Raised when feature_flags version does not match expected (optimistic concurrency)."""


async def upsert_feature_flags(
    session: AsyncSession, values: dict[str, Any], expected_version: int
) -> tuple[str, int]:
    """
    Upsert the single feature_flags row. values must be full (validated) dict.
    expected_version must match current row version or 0 if no row (prevents mid-air collision).
    Uses atomic UPDATE ... WHERE version = :expected so concurrent requests cannot both succeed.
    Returns (updated_at_iso, new_version). Raises ConcurrencyConflictError if version mismatch.
    """
    now = datetime.now(timezone.utc).isoformat()
    config_json = json.dumps(values)
    new_version = expected_version + 1

    # Atomic update: only one writer can match (WHERE id=1 AND version=expected_version).
    stmt = (
        update(FeatureFlagsORM)
        .where(
            FeatureFlagsORM.id == CONFIG_ROW_ID,
            FeatureFlagsORM.version == expected_version,
        )
        .values(config=config_json, updated_at=now, version=new_version)
    )
    result = await session.execute(stmt)
    await session.flush()

    if result.rowcount == 1:
        return (now, new_version)

    # No row updated: either no row yet (expected_version 0) or version mismatch.
    if expected_version == 0:
        # Try insert for first-time creation (single row, id=1).
        try:
            session.add(
                FeatureFlagsORM(
                    id=CONFIG_ROW_ID,
                    config=config_json,
                    updated_at=now,
                    version=0,
                )
            )
            await session.flush()
            return (now, 0)
        except Exception:
            # Row was created by another request (e.g. duplicate key); treat as conflict.
            raise ConcurrencyConflictError(
                "Feature flags were updated elsewhere (expected version 0, row was just created). Reload and try again."
            )

    # Version mismatch or row missing: report current version so client can reload.
    row_result = await session.execute(
        select(FeatureFlagsORM).where(FeatureFlagsORM.id == CONFIG_ROW_ID)
    )
    row = row_result.scalar_one_or_none()
    current_version = getattr(row, "version", 0) if row else 0
    raise ConcurrencyConflictError(
        f"Feature flags were updated elsewhere (expected version {expected_version}, current {current_version}). Reload and try again."
    )


async def remove_keys_from_config(session: AsyncSession, keys: set[str]) -> tuple[str | None, int] | None:
    """
    Remove given keys from the feature_flags config. Used when deprecating definitions.
    Increments version on change. Returns (updated_at, new_version) or None if no row/no change.
    """
    if not keys:
        return None
    result = await session.execute(
        select(FeatureFlagsORM).where(FeatureFlagsORM.id == CONFIG_ROW_ID)
    )
    row = result.scalar_one_or_none()
    if not row or not row.config:
        return None
    config = json.loads(row.config)
    changed = False
    for k in keys:
        if k in config:
            del config[k]
            changed = True
    if not changed:
        return (row.updated_at, getattr(row, "version", 0))
    now = datetime.now(timezone.utc).isoformat()
    row.config = json.dumps(config)
    row.updated_at = now
    row.version = getattr(row, "version", 0) + 1
    await session.flush()
    return (now, row.version)
