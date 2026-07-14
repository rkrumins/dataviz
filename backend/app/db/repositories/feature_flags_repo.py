"""
Repository for feature_flags (single-row config). Defaults come from feature_definitions in DB.
Values are only returned for non-deprecated definitions by default.
"""
import json
from datetime import datetime, timezone
from typing import Any

from sqlalchemy import desc, select, update
from sqlalchemy.ext.asyncio import AsyncSession

from ..models import FeatureFlagChangeORM, FeatureFlagsORM
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
                    version=new_version,
                )
            )
            await session.flush()
            return (now, new_version)
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


# --------------------------------------------------------------------------- #
# feature_flag_changes — who turned it off, and when
#
# The config row carries a value and a version. It has never carried an ACTOR, so the page could
# say a flag was off and never who did it, when, or what it was before. On a surface where any
# admin can silently take a capability away from every user, "someone, at some point" is not an
# answer to the only question anyone asks when something stops working.
# --------------------------------------------------------------------------- #


def _row_to_change(row: FeatureFlagChangeORM) -> dict[str, Any]:
    def _load(raw: str | None) -> Any:
        if raw is None:
            return None
        try:
            return json.loads(raw)
        except (TypeError, ValueError):
            return raw

    return {
        "id": row.id,
        "key": row.feature_key,
        "from": _load(row.old_value),
        "to": _load(row.new_value),
        "actorId": row.actor_id,
        # Falls back rather than showing a blank line. An unattributed change is still a change,
        # and "we don't know who" is information — it is not the same as "nothing happened".
        "actorName": row.actor_name or "Unknown",
        "at": row.created_at,
    }


async def record_changes(
    session: AsyncSession,
    *,
    before: dict[str, Any],
    after: dict[str, Any],
    actor_id: str | None,
    actor_name: str | None,
) -> int:
    """Write one row per flag whose value actually MOVED. Returns how many were written.

    Diffed rather than logged-on-write because the PATCH payload is a full merged config: every
    save would otherwise record twelve "changes", eleven of which changed nothing, and a history
    where every entry is noise is a history nobody reads.
    """
    changed = [k for k, v in after.items() if before.get(k) != v]
    for key in changed:
        session.add(
            FeatureFlagChangeORM(
                feature_key=key,
                old_value=json.dumps(before[key]) if key in before else None,
                new_value=json.dumps(after[key]),
                actor_id=actor_id,
                actor_name=actor_name,
            )
        )
    if changed:
        await session.flush()
    return len(changed)


async def get_history(
    session: AsyncSession, feature_key: str, limit: int = 20
) -> list[dict[str, Any]]:
    """Everything that has happened to one flag, newest first."""
    r = await session.execute(
        select(FeatureFlagChangeORM)
        .where(FeatureFlagChangeORM.feature_key == feature_key)
        .order_by(desc(FeatureFlagChangeORM.created_at), desc(FeatureFlagChangeORM.id))
        .limit(limit)
    )
    return [_row_to_change(row) for row in r.scalars()]


async def get_last_changes(session: AsyncSession) -> dict[str, dict[str, Any]]:
    """The most recent change per flag — what the page shows beside each switch.

    One query for the whole page rather than one per feature: twelve round-trips to render a line
    of text each is how a settings page ends up feeling slow for no reason a user could name.
    """
    r = await session.execute(
        select(FeatureFlagChangeORM).order_by(
            desc(FeatureFlagChangeORM.created_at), desc(FeatureFlagChangeORM.id)
        )
    )
    latest: dict[str, dict[str, Any]] = {}
    for row in r.scalars():
        latest.setdefault(row.feature_key, _row_to_change(row))
    return latest
