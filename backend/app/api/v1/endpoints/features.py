"""
Admin Features endpoints — GET/PATCH for global feature flags and UI copy; CRUD for definitions.
Schema and categories from DB (feature_definitions, feature_categories); values in feature_flags;
experimental notice from feature_registry_meta.

Public endpoint:
    GET /api/v1/features/values — read-only flag values (no auth, no schema/categories overhead)
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
from backend.app.auth.dependencies import get_current_user
from backend.app.changes import topics as change_topics
from backend.app.changes.publish import publish_change_after_commit
from backend.app.db.engine import get_db_session
from backend.app.db.repositories import feature_flags_repo, feature_registry_repo
from backend.app.db.repositories.feature_flags_repo import ConcurrencyConflictError
from backend.app.services import feature_impact
from backend.app.services.feature_flags import feature_flags as _flag_service

router = APIRouter()

# Unauthenticated read-only values (mounted at /api/v1/features — no /admin prefix).
# Flags are UI behaviour toggles, never secrets: this router exposes ONLY the merged
# value map (no schema, categories, or admin hints), mirroring branding.public_router.
public_router = APIRouter()


@public_router.get("/values")
async def get_feature_values(
    session: AsyncSession = Depends(get_db_session),
):
    """Read-only flag values for app bootstrap (no auth, no schema/categories overhead)."""
    values = await _flag_service.get_all(session)
    return {
        "values": values,
        "version": _flag_service.cached_version,
        "updatedAt": _flag_service.cached_updated_at,
    }


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
        # "Turned off by Rinalds, 2 days ago" — next to the switch, not buried in an audit page.
        # One query for the whole page: twelve round-trips to render a line of text each is how a
        # settings screen ends up feeling slow for no reason anyone can name.
        "lastChanges": await feature_flags_repo.get_last_changes(session),
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
    user=Depends(get_current_user),
):
    """
    Update feature flags and the experimental-notice copy.
    Payload may include: feature keys (validated) and "experimentalNotice":
    { "enabled", "title", "message" }.

    "implemented" is REFUSED — it is derived from config/feature_wiring.py. See below.
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

    # `implemented` is no longer something anyone can SAY.
    #
    # It records whether a flag is actually wired — a fact about the source tree — and it used
    # to be a checkbox on this page. Predictably, it was wrong: it marked `signupEnabled` and
    # `traceEnabled` unimplemented when both were wired, and marked eight decorative toggles as
    # real when they gated nothing at all. Ticking a box cannot make a gate exist, so the box is
    # gone: the value is derived from `config/feature_wiring.py` and reconciled into the row on
    # every startup. We refuse the field loudly rather than ignoring it, so an old client that
    # still sends it learns why instead of silently believing it worked.
    if implemented_body is not None:
        raise HTTPException(
            status_code=400,
            detail={
                "detail": (
                    "'implemented' is derived from the code (config/feature_wiring.py) and "
                    "cannot be set from the API — it describes whether a flag is actually "
                    "enforced, which the database has no way to know."
                ),
                "code": "READ_ONLY",
                "field": "implemented",
            },
        )

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
    # What the flags were BEFORE this save — the other half of "who turned it off".
    before, _, _ = await feature_flags_repo.get_feature_flags(session, include_deprecated=True)

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

    # Who did it, and what moved. Only keys that actually CHANGED are recorded: the payload is a
    # full merged config, so logging it wholesale would write twelve rows per save, eleven of them
    # saying nothing happened — and a history where most entries are noise is one nobody reads.
    actor_name = " ".join(
        p for p in (getattr(user, "first_name", None), getattr(user, "last_name", None)) if p
    ) or getattr(user, "email", None)
    await feature_flags_repo.record_changes(
        session,
        before=before,
        after=merged,
        actor_id=getattr(user, "id", None),
        actor_name=actor_name,
    )

    # Bust cached flag values so subsequent reads see the new state immediately.
    # ``invalidate()`` only clears THIS process's copy, and production runs
    # eight of them — the other seven kept serving the old values until
    # their own 30s TTL lapsed. The change bump closes that: every worker's
    # clients are told to re-read, so a flag flip reaches the whole fleet
    # instead of whichever worker happened to serve the PATCH.
    _flag_service.invalidate()
    publish_change_after_commit(session, change_topics.FEATURES)

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
        # Fresh, so the attribution line updates in place instead of showing the previous editor
        # until someone reloads.
        "lastChanges": await feature_flags_repo.get_last_changes(session),
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
    optional options, helpUrl, adminHint, impactWhenOff, sortOrder.

    A definition created here has no gate in the code, so it reports implemented=false
    until someone actually wires it. That is not a limitation — it is the point.
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
            options=options_str,
            help_url=body.get("helpUrl"),
            admin_hint=body.get("adminHint"),
            sort_order=int(body.get("sortOrder", 99)),
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
    Body can include: name, description, category, type, default, options, helpUrl,
    adminHint, impactWhenOff, sortOrder, deprecated.

    NOT "implemented" — that is a fact about the code, derived from config/feature_wiring.py.
    """
    mapping = {
        "name": "name",
        "description": "description",
        "category": "category_id",
        "type": "type",
        "default": "default_value",
        "options": "options",
        "helpUrl": "help_url",
        "adminHint": "admin_hint",
        "impactWhenOff": "impact_when_off",
        "sortOrder": "sort_order",
        "deprecated": "deprecated",
    }
    fields = {}
    for api_key, col in mapping.items():
        v = body.get(api_key)
        if v is None and api_key in ("helpUrl", "adminHint", "impactWhenOff", "options"):
            fields[col] = None
            continue
        if v is None:
            continue
        if api_key == "default":
            fields[col] = json.dumps(v) if not isinstance(v, str) else v
        elif api_key == "options":
            fields[col] = json.dumps(v) if v is not None and not isinstance(v, str) else v
        elif api_key in ("deprecated",):
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
    _flag_service.invalidate()
    publish_change_after_commit(session, change_topics.FEATURES)
    return await _full_response(session)


# --------------------------------------------------------------------------- #
# Per-flag history and blast radius
#
# Declared after the /definitions/* routes on purpose: these take a `{key}` in the FIRST segment,
# and FastAPI matches in declaration order, so a wildcard registered earlier would swallow
# "/definitions/...". Route-order collisions have shipped in this codebase before.
# --------------------------------------------------------------------------- #


@router.get("/{key}/history")
async def get_feature_history(
    key: str,
    limit: int = 20,
    session: AsyncSession = Depends(get_db_session),
):
    """Everything that has happened to one flag, newest first.

    Not gated on the key existing in the registry: a flag that was deprecated or renamed still has
    a past, and "this switch has no history" would be a lie about a switch that had plenty.
    """
    return {"key": key, "history": await feature_flags_repo.get_history(session, key, limit=limit)}


@router.get("/{key}/impact")
async def get_feature_impact(
    key: str,
    session: AsyncSession = Depends(get_db_session),
):
    """What turning this flag off would touch, COUNTED against this estate.

    The confirmation dialog already says what a feature does when it's off. That sentence is true
    and it comes from a config file — it reads the same on a deployment with four views and one
    with four thousand. This is the other half: the fact that actually decides the question.

    `known: false` means WE DO NOT KNOW — either the probe failed, or this flag has no honest count
    behind it (see feature_impact.py: `traceEnabled` has no usage telemetry, so there is no
    truthful answer to "how many people would lose trace", so we invent nothing). It does NOT mean
    "nothing would be affected", and the UI must not render it as reassurance.
    """
    return await feature_impact.probe(session, key)
