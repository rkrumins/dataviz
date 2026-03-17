"""
Admin Features endpoints — GET/PATCH for global feature flags and UI copy; CRUD for definitions.
Schema and categories from DB (feature_definitions, feature_categories); values in feature_flags;
experimental notice from feature_registry_meta.
"""
import json
import time
from collections import defaultdict

from fastapi import APIRouter, Body, Depends, HTTPException, Request
from sqlalchemy.ext.asyncio import AsyncSession

from backend.app.config.features import (
    DEFAULT_EXPERIMENTAL_NOTICE_ENABLED,
    DEFAULT_EXPERIMENTAL_NOTICE_MESSAGE,
    DEFAULT_EXPERIMENTAL_NOTICE_TITLE,
    ValidationError,
    validate_and_merge_values,
)
from backend.app.db.engine import get_db_session
from backend.app.db.repositories import feature_flags_repo, feature_registry_repo
from backend.app.db.repositories.feature_flags_repo import ConcurrencyConflictError

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
    Get feature flag schema, categories, current values, and experimental notice.
    Schema/categories from DB; values from feature_flags; notice from feature_registry_meta (or config defaults if no row).
    """
    values, updated_at, version = await feature_flags_repo.get_feature_flags(session, include_deprecated=False)
    schema = await feature_registry_repo.get_all_definitions(session, include_deprecated=False)
    categories = await feature_registry_repo.get_all_categories(session)
    meta = await feature_registry_repo.get_ui_meta(session)
    return {
        "schema": schema,
        "categories": categories,
        "values": values,
        "updatedAt": updated_at,
        "version": version,
        "experimentalNotice": _build_experimental_notice(meta),
    }


# Validation limits for experimental notice (PATCH)
EXPERIMENTAL_NOTICE_TITLE_MAX_LEN = 200
EXPERIMENTAL_NOTICE_MESSAGE_MAX_LEN = 2000


def _build_experimental_notice(meta: dict | None) -> dict | None:
    """Build experimentalNotice for API response from meta row or defaults.
    When disabled, returns { enabled: false, title, message } so the UI can show 'Enable' and re-enable with same text.
    """
    if meta and meta.get("experimentalNoticeTitle"):
        out = {
            "enabled": bool(meta.get("experimentalNoticeEnabled", True)),
            "title": meta["experimentalNoticeTitle"],
            "message": meta.get("experimentalNoticeMessage") or "",
        }
        if out["enabled"] and meta.get("experimentalNoticeUpdatedAt"):
            out["updatedAt"] = meta["experimentalNoticeUpdatedAt"]
        return out
    if meta is None and DEFAULT_EXPERIMENTAL_NOTICE_ENABLED and DEFAULT_EXPERIMENTAL_NOTICE_TITLE:
        return {
            "enabled": True,
            "title": DEFAULT_EXPERIMENTAL_NOTICE_TITLE,
            "message": DEFAULT_EXPERIMENTAL_NOTICE_MESSAGE or "",
        }
    return None


def _validate_experimental_notice(body: dict) -> None:
    """Raise HTTPException if title/message exceed limits."""
    title = body.get("title")
    if title is not None and len(str(title)) > EXPERIMENTAL_NOTICE_TITLE_MAX_LEN:
        raise HTTPException(
            status_code=400,
            detail={
                "detail": f"experimentalNotice.title must be at most {EXPERIMENTAL_NOTICE_TITLE_MAX_LEN} characters",
                "code": "EXPERIMENTAL_NOTICE_VALIDATION",
                "field": "experimentalNotice.title",
            },
        )
    message = body.get("message")
    if message is not None and len(str(message)) > EXPERIMENTAL_NOTICE_MESSAGE_MAX_LEN:
        raise HTTPException(
            status_code=400,
            detail={
                "detail": f"experimentalNotice.message must be at most {EXPERIMENTAL_NOTICE_MESSAGE_MAX_LEN} characters",
                "code": "EXPERIMENTAL_NOTICE_VALIDATION",
                "field": "experimentalNotice.message",
            },
        )


@router.patch("")
async def patch_features(
    request: Request,
    payload: dict = Body(...),
    session: AsyncSession = Depends(get_db_session),
):
    """
    Update feature flags, experimental notice copy, and/or per-feature "implemented" (not-yet-wired) status.
    Payload may include: feature keys (validated), "experimentalNotice": { "enabled", "title", "message" },
    "implemented": { "featureKey": true/false, ... }.
    Rate limited (30/min per IP).
    """
    client_ip = request.client.host if request.client else "unknown"
    _check_patch_rate_limit(client_ip)

    payload = dict(payload)
    experimental_notice_body = payload.pop("experimentalNotice", None)
    implemented_body = payload.pop("implemented", None)
    version_from_client = payload.pop("version", None)
    if version_from_client is not None and not isinstance(version_from_client, int):
        try:
            version_from_client = int(version_from_client)
        except (TypeError, ValueError):
            version_from_client = None

    definitions = await feature_registry_repo.get_all_definitions(session, include_deprecated=True)
    categories = await feature_registry_repo.get_all_categories(session)
    valid_feature_keys = {d["key"] for d in definitions}

    if implemented_body is not None and isinstance(implemented_body, dict):
        invalid = set(implemented_body.keys()) - valid_feature_keys
        if invalid:
            raise HTTPException(
                status_code=400,
                detail={
                    "detail": f"Unknown feature key(s) in implemented: {sorted(invalid)}",
                    "code": "VALIDATION",
                    "field": "implemented",
                },
            )
        values_ok = all(isinstance(v, bool) or v in (0, 1) for v in implemented_body.values())
        if not values_ok:
            raise HTTPException(
                status_code=400,
                detail={
                    "detail": "implemented values must be boolean",
                    "code": "VALIDATION",
                    "field": "implemented",
                },
            )
        await feature_registry_repo.update_definitions_implemented(
            session, {k: bool(v) for k, v in implemented_body.items()}
        )
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
    if version_from_client is None:
        raise HTTPException(
            status_code=400,
            detail={
                "detail": "version is required for PATCH (optimistic concurrency). Send the version from the last GET.",
                "code": "VALIDATION",
                "field": "version",
            },
        )
    try:
        updated_at, new_version = await feature_flags_repo.upsert_feature_flags(
            session, merged, version_from_client
        )
    except ConcurrencyConflictError as e:
        raise HTTPException(
            status_code=409,
            detail={
                "detail": str(e),
                "code": "CONFLICT",
                "field": "version",
            },
        )

    meta = None
    if experimental_notice_body is not None and isinstance(experimental_notice_body, dict):
        if any(k in experimental_notice_body for k in ("enabled", "title", "message")):
            try:
                _validate_experimental_notice(experimental_notice_body)
            except HTTPException:
                raise
            meta = await feature_registry_repo.upsert_ui_meta(
                session,
                experimental_notice_enabled=experimental_notice_body.get("enabled"),
                experimental_notice_title=experimental_notice_body.get("title"),
                experimental_notice_message=experimental_notice_body.get("message"),
            )
    if meta is None:
        meta = await feature_registry_repo.get_ui_meta(session)

    schema = [d for d in definitions if not d.get("deprecated")]
    schema_keys = {d["key"] for d in schema}
    values_response = {k: v for k, v in merged.items() if k in schema_keys}
    return {
        "schema": schema,
        "categories": categories,
        "values": values_response,
        "updatedAt": updated_at,
        "version": new_version,
        "experimentalNotice": _build_experimental_notice(meta),
    }


async def _full_response(session: AsyncSession) -> dict:
    """Build the same shape as GET for use after create/update/deprecate."""
    values, updated_at, version = await feature_flags_repo.get_feature_flags(session, include_deprecated=False)
    schema = await feature_registry_repo.get_all_definitions(session, include_deprecated=False)
    categories = await feature_registry_repo.get_all_categories(session)
    meta = await feature_registry_repo.get_ui_meta(session)
    return {
        "schema": schema,
        "categories": categories,
        "values": values,
        "updatedAt": updated_at,
        "version": version,
        "experimentalNotice": _build_experimental_notice(meta),
    }


@router.post("/definitions")
async def create_definition(
    body: dict = Body(...),
    session: AsyncSession = Depends(get_db_session),
):
    """
    Create a new feature definition. Body: key, name, description, category (id), type, default (value),
    optional userOverridable, options, helpUrl, adminHint, sortOrder, implemented.
    """
    key = body.get("key")
    if not key or not isinstance(key, str):
        raise HTTPException(status_code=400, detail={"detail": "key is required (string)", "code": "VALIDATION", "field": "key"})
    key = str(key).strip()
    if not key:
        raise HTTPException(status_code=400, detail={"detail": "key cannot be empty", "code": "VALIDATION", "field": "key"})
    name = body.get("name")
    description = body.get("description")
    category_id = body.get("category")
    if not category_id:
        category_id = body.get("category_id")
    ftype = body.get("type")
    default = body.get("default")
    if name is None or description is None or category_id is None or ftype is None or default is None:
        raise HTTPException(
            status_code=400,
            detail={"detail": "name, description, category, type, default are required", "code": "VALIDATION", "field": None},
        )
    if ftype not in ("boolean", "string[]"):
        raise HTTPException(status_code=400, detail={"detail": "type must be boolean or string[]", "code": "VALIDATION", "field": "type"})
    default_value = json.dumps(default) if not isinstance(default, str) else default
    options = body.get("options")
    options_str = json.dumps(options) if options is not None else None
    try:
        definition = await feature_registry_repo.create_definition(
            session,
            key=key,
            name=str(name),
            description=str(description),
            category_id=str(category_id),
            type=ftype,
            default_value=default_value,
            user_overridable=bool(body.get("userOverridable", False)),
            options=options_str,
            help_url=body.get("helpUrl"),
            admin_hint=body.get("adminHint"),
            sort_order=int(body.get("sortOrder", 99)),
            implemented=bool(body.get("implemented", False)),
        )
    except ValueError as e:
        raise HTTPException(status_code=400, detail={"detail": str(e), "code": "VALIDATION", "field": None})
    # Persist feature_flags so the new key has its default in config (OCC: use current version)
    current_values, _, current_version = await feature_flags_repo.get_feature_flags(session, include_deprecated=True)
    try:
        await feature_flags_repo.upsert_feature_flags(session, current_values, current_version)
    except ConcurrencyConflictError:
        raise HTTPException(
            status_code=409,
            detail={"detail": "Feature flags were updated elsewhere. Reload and try again.", "code": "CONFLICT", "field": "version"},
        )
    return await _full_response(session)


@router.patch("/definitions/{key}")
async def patch_definition(
    key: str,
    body: dict = Body(...),
    session: AsyncSession = Depends(get_db_session),
):
    """
    Update a feature definition (metadata). Partial update: only provided fields are changed.
    Body can include: name, description, category, type, default, userOverridable, options, helpUrl, adminHint, sortOrder, deprecated, implemented.
    """
    mapping = {
        "name": "name",
        "description": "description",
        "category": "category_id",
        "type": "type",
        "default": "default_value",
        "userOverridable": "user_overridable",
        "options": "options",
        "helpUrl": "help_url",
        "adminHint": "admin_hint",
        "sortOrder": "sort_order",
        "deprecated": "deprecated",
        "implemented": "implemented",
    }
    fields = {}
    for api_key, col in mapping.items():
        v = body.get(api_key)
        if v is None and api_key in ("helpUrl", "adminHint", "options"):
            fields[col] = None
            continue
        if v is None:
            continue
        if api_key == "default":
            fields[col] = json.dumps(v) if not isinstance(v, str) else v
        elif api_key == "options":
            fields[col] = json.dumps(v) if v is not None and not isinstance(v, str) else v
        elif api_key in ("userOverridable", "deprecated", "implemented"):
            fields[col] = bool(v)
        elif api_key == "sortOrder":
            fields[col] = int(v)
        else:
            fields[col] = v
    try:
        updated = await feature_registry_repo.update_definition(session, key, **fields)
    except ValueError as e:
        raise HTTPException(status_code=400, detail={"detail": str(e), "code": "VALIDATION", "field": None})
    if updated is None:
        raise HTTPException(status_code=404, detail={"detail": f"Feature not found: {key}", "code": "NOT_FOUND"})
    return await _full_response(session)


@router.post("/definitions/{key}/deprecate")
async def deprecate_definition(
    key: str,
    session: AsyncSession = Depends(get_db_session),
):
    """
    Soft-delete a feature: set deprecated=true and remove its value from feature_flags.
    The definition remains in the DB but is excluded from schema and values.
    """
    ok = await feature_registry_repo.set_definition_deprecated(session, key, deprecated=True)
    if not ok:
        raise HTTPException(status_code=404, detail={"detail": f"Feature not found: {key}", "code": "NOT_FOUND"})
    await feature_flags_repo.remove_keys_from_config(session, {key})
    return await _full_response(session)
