"""
Admin Features endpoints — GET/PATCH for global feature flags.
Schema and categories from DB (feature_definitions, feature_categories); values in feature_flags.
"""
import time
from collections import defaultdict

from fastapi import APIRouter, Body, Depends, HTTPException, Request
from sqlalchemy.ext.asyncio import AsyncSession

from backend.app.config.features import ValidationError, validate_and_merge_values
from backend.app.db.engine import get_db_session
from backend.app.db.repositories import feature_flags_repo, feature_registry_repo

router = APIRouter()

# PATCH rate limit: 30 requests per 60 seconds per IP
_RATE_LIMIT_WINDOW = 60.0
_RATE_LIMIT_MAX = 30
_patch_timestamps: dict[str, list[float]] = defaultdict(list)


def _check_patch_rate_limit(client_ip: str) -> None:
    now = time.monotonic()
    window = _patch_timestamps[client_ip]
    window[:] = [t for t in window if now - t < _RATE_LIMIT_WINDOW]
    if len(window) >= _RATE_LIMIT_MAX:
        raise HTTPException(
            status_code=429,
            detail={
                "detail": "Too many updates. Please wait a moment before saving again.",
                "code": "RATE_LIMIT",
                "retryAfter": int(_RATE_LIMIT_WINDOW),
            },
        )
    window.append(now)


@router.get("")
async def get_features(
    session: AsyncSession = Depends(get_db_session),
):
    """
    Get feature flag schema and current values.
    Schema and categories from DB; values from feature_flags (or defaults from definitions).
    """
    values, updated_at = await feature_flags_repo.get_feature_flags(session)
    schema = await feature_registry_repo.get_all_definitions(session, include_deprecated=False)
    categories = await feature_registry_repo.get_all_categories(session)
    return {
        "schema": schema,
        "categories": categories,
        "values": values,
        "updatedAt": updated_at,
    }


@router.patch("")
async def patch_features(
    request: Request,
    payload: dict = Body(...),
    session: AsyncSession = Depends(get_db_session),
):
    """
    Update feature flags. Payload is partial or full; validated against DB definitions.
    Rate limited (30/min per IP).
    """
    client_ip = request.client.host if request.client else "unknown"
    _check_patch_rate_limit(client_ip)

    definitions = await feature_registry_repo.get_all_definitions(session, include_deprecated=True)
    try:
        merged = validate_and_merge_values(definitions, payload)
    except ValidationError as e:
        raise HTTPException(
            status_code=400,
            detail={
                "detail": e.message,
                "code": e.code,
                "field": e.field,
            },
        )
    updated_at = await feature_flags_repo.upsert_feature_flags(session, merged)
    schema = await feature_registry_repo.get_all_definitions(session, include_deprecated=False)
    categories = await feature_registry_repo.get_all_categories(session)
    return {
        "schema": schema,
        "categories": categories,
        "values": merged,
        "updatedAt": updated_at,
    }
