"""
Freshness Cockpit API — the operator-facing read + refresh surface over
the aggregation freshness signals.

Three routes, mounted under ``/api/v1/admin`` next to the aggregation
router (they share its proxy plumbing and per-data-source manage gate):

  * ``GET /freshness`` — fleet view. ONE SQL pass over the web tier's own
    synced state (``public.workspace_data_sources`` ⋈ ``providers``) then
    ONE Redis pipeline for the cache signals. Zero provider / FalkorDB
    work, so it is served in-process in BOTH direct and proxy mode (like
    the ontology-resolution read — the web tier owns this data).
  * ``GET /data-sources/{ds_id}/freshness`` — per-source detail. Adds a
    bounded LKG SCAN and, only under ``probe=true``, ONE provider
    ``get_schema_stats`` call. Proxy-aware: in proxy mode the probe runs
    on the Control Plane (its short-timeout registry), so the whole route
    forwards there.
  * ``POST /data-sources/{ds_id}/refresh`` — the unified refresh verb.
    Delegates to ``AggregationService.refresh_source``; proxy-aware.

Reads reuse the Ingestion-surface visibility gate; the refresh mutation
reuses the aggregation router's ``_REQUIRE_DS_MANAGE``.
"""
import json as _json
import logging
from typing import Optional

from fastapi import APIRouter, Depends, HTTPException, Query, Request, status
from sqlalchemy.ext.asyncio import AsyncSession

from backend.app.api.v1.endpoints.aggregation import (
    _PROXY_ENABLED,
    _REQUIRE_DS_MANAGE,
    _get_svc,
    _proxy,
)
from backend.app.auth.dependencies import (
    get_current_user,
    get_permission_claims,
    requires,
)
from backend.app.db.engine import (
    get_db_session,
    get_graph_read_db_session,
    get_readonly_db_session,
)
from backend.app.services.aggregation.schemas import (
    BatchStatus,
    FreshnessDoc,
    FreshnessFleetResponse,
    FreshnessSettingsRequest,
    FreshnessSettingsResponse,
    RefreshRequest,
    RefreshResponse,
)
from backend.app.services.permission_service import (
    PermissionClaims,
    has_permission_any_workspace,
)
from backend.auth_service.interface import User

logger = logging.getLogger(__name__)

router = APIRouter()


# ── Read gate: the Ingestion surface's visibility perms ─────────────
# Mirrors nav_catalogue.py "ingestion": any of these, held globally or in
# ANY one workspace, unlocks the read. The cockpit is a cross-workspace
# operator surface, so the gate is any-workspace rather than per-ds.

_INGESTION_READ_PERMS = (
    "system:admin",
    "system:org-admin",
    "workspace:provider:read",
    "workspace:datasource:manage",
)


async def _require_ingestion_read(
    user: User = Depends(get_current_user),
    claims: PermissionClaims = Depends(get_permission_claims),
) -> User:
    """Grant when the caller holds any Ingestion-surface permission
    (globally or in any workspace). 403 otherwise."""
    if any(has_permission_any_workspace(claims, p) for p in _INGESTION_READ_PERMS):
        return user
    raise HTTPException(
        status_code=status.HTTP_403_FORBIDDEN,
        detail={
            "error": "missing_permission",
            "permission": " | ".join(_INGESTION_READ_PERMS),
            "scope": {"type": "global", "id": None},
            "message": "Missing Ingestion access",
        },
    )


# ── Provider batch-refresh gate: platform-admin only ─────────────────
#
# A provider's data sources can span workspaces the caller has no access
# to, so this can't be the per-ds ``workspace:datasource:manage`` gate
# (there's no single ``ds_id`` to resolve a workspace from). Mirrors
# ``providers.py``'s ``_REQUIRES_SYSTEM_ADMIN``: provider-scoped mutations
# stay platform-admin-only (``workspace:provider`` deliberately has no
# ``:manage`` leaf — see ``permission_service.py``).
_REQUIRE_PROVIDER_MANAGE = requires("system:admin")


# ── GET /freshness — fleet view ─────────────────────────────────────

@router.get(
    "/freshness",
    response_model=FreshnessFleetResponse,
    summary="Fleet freshness overview (paged)",
    dependencies=[Depends(_require_ingestion_read)],
)
async def list_freshness(
    session: AsyncSession = Depends(get_readonly_db_session),
    workspace_id: Optional[str] = Query(None, alias="workspaceId"),
    provider_id: Optional[str] = Query(None, alias="providerId"),
    stale_only: bool = Query(False, alias="staleOnly"),
    page: int = Query(1, ge=1),
    page_size: int = Query(50, ge=1, le=200, alias="pageSize"),
):
    """Assemble one page of fleet freshness rows. Pure SQL + Redis; served
    in-process in both proxy and direct mode (web-tier-owned data)."""
    from backend.app.services.aggregation.service import assemble_fleet_freshness

    return await assemble_fleet_freshness(
        session,
        workspace_id=workspace_id,
        provider_id=provider_id,
        stale_only=stale_only,
        page=page,
        page_size=page_size,
    )


# ── GET /data-sources/{ds_id}/freshness — per-source detail ─────────

@router.get(
    "/data-sources/{ds_id}/freshness",
    response_model=FreshnessDoc,
    summary="Per-source freshness detail",
    dependencies=[Depends(_require_ingestion_read)],
)
async def get_source_freshness(
    ds_id: str,
    request: Request,
    svc=Depends(_get_svc),
    # Bulkhead pool: the probe path holds this across an outbound provider
    # call, isolating a slow FalkorDB from the WEB pool (WS0.2).
    session: AsyncSession = Depends(get_graph_read_db_session),
    probe: bool = Query(False),
):
    if _PROXY_ENABLED:
        return await _proxy(
            "GET", f"/aggregation/data-sources/{ds_id}/freshness", request,
        )
    doc = await svc.assemble_source_freshness(ds_id, session, probe=probe)
    if doc is None:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND,
            detail=f"Data source {ds_id!r} not found",
        )
    return doc


# ── POST /data-sources/{ds_id}/refresh — unified refresh verb ───────

@router.post(
    "/data-sources/{ds_id}/refresh",
    response_model=RefreshResponse,
    summary="Refresh a data source (auto | read-caches | rollups | full)",
)
async def refresh_data_source(
    ds_id: str,
    request: Request,
    # Also the manage gate — returns the authenticated user so we can
    # attribute the audit event to them.
    user: User = Depends(_REQUIRE_DS_MANAGE),
    svc=Depends(_get_svc),
    session: AsyncSession = Depends(get_db_session),
):
    if _PROXY_ENABLED:
        # Inject the authenticated user id so the Control Plane audits the
        # refresh as the user, not "internal" — production runs proxy mode,
        # so without this every UI refresh would lose its actor. Force
        # origin="api" too (the direct branch hard-codes it): a ds:manage
        # caller must not be able to label their UI refresh as
        # connector/script in the audit trail.
        raw = await request.body()
        forwarded = _json.loads(raw) if raw else {}
        forwarded["actor"] = user.id
        forwarded["origin"] = "api"
        return await _proxy(
            "POST", f"/aggregation/data-sources/{ds_id}/refresh", request,
            body=_json.dumps(forwarded).encode(),
        )
    from backend.app.services.aggregation.service import NotFoundError

    raw = await request.body()
    req = RefreshRequest(**(_json.loads(raw) if raw else {}))
    try:
        return await svc.refresh_source(
            ds_id, session,
            scope=req.scope, force=req.force, reason=req.reason,
            actor=user.id, origin="api", wait=req.wait,
        )
    except NotFoundError as e:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail=str(e))


# ── PATCH /data-sources/{ds_id}/freshness-settings — cadence override ──

@router.patch(
    "/data-sources/{ds_id}/freshness-settings",
    response_model=FreshnessSettingsResponse,
    summary="Set or clear a data source's rebuild-cadence override",
    dependencies=[Depends(_REQUIRE_DS_MANAGE)],
)
async def patch_freshness_settings(
    ds_id: str,
    body: FreshnessSettingsRequest,
    request: Request,
    svc=Depends(_get_svc),
    session: AsyncSession = Depends(get_db_session),
):
    """Persist the per-source rebuild-interval override (``None`` clears it).
    The body carries only the interval — there is no client-controlled
    actor/origin here — and it is validated (0–86400) by
    ``FreshnessSettingsRequest`` before this handler runs, in both modes."""
    if _PROXY_ENABLED:
        raw = await request.body()
        return await _proxy(
            "PATCH", f"/aggregation/data-sources/{ds_id}/freshness-settings",
            request,
            body=raw or _json.dumps(body.model_dump(by_alias=True)).encode(),
        )
    from backend.app.services.aggregation.service import NotFoundError

    try:
        stored = await svc.set_source_rebuild_interval(
            ds_id, body.rebuild_min_interval_secs, session,
        )
    except NotFoundError as e:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail=str(e))
    return FreshnessSettingsResponse(
        data_source_id=ds_id, rebuild_min_interval_secs=stored,
    )


# ── POST /providers/{provider_id}/refresh — guarded batch refresh ───

@router.post(
    "/providers/{provider_id}/refresh",
    response_model=BatchStatus,
    status_code=status.HTTP_202_ACCEPTED,
    summary="Guarded batch refresh across a provider's live data sources",
)
async def refresh_provider_batch(
    provider_id: str,
    request: Request,
    # Also the manage gate — returns the authenticated user so we can
    # attribute the batch (and every item's audit event) to them.
    user: User = Depends(_REQUIRE_PROVIDER_MANAGE),
):
    """The runner is a Control Plane background job (its own
    ``asyncio.create_task`` + session factory) — there is no in-process
    equivalent, so unlike the per-ds refresh route this always proxies,
    regardless of ``_PROXY_ENABLED``."""
    raw = await request.body()
    forwarded = _json.loads(raw) if raw else {}
    # Same trust rule as the per-ds refresh route: the client body never
    # decides actor/origin, even in the internal channel to the CP.
    forwarded["actor"] = user.id
    forwarded["origin"] = "api"
    return await _proxy(
        "POST", f"/aggregation/providers/{provider_id}/refresh-batch", request,
        body=_json.dumps(forwarded).encode(),
    )


# ── GET /refresh-batches/{batch_id} — batch progress ─────────────────

@router.get(
    "/refresh-batches/{batch_id}",
    response_model=BatchStatus,
    summary="Guarded provider refresh batch progress",
    dependencies=[Depends(_require_ingestion_read)],
)
async def get_refresh_batch(batch_id: str, request: Request):
    return await _proxy("GET", f"/aggregation/refresh-batches/{batch_id}", request)
