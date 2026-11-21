"""Identity-provider links: the requests to link a group, and the identity-provider
groups people's sign-ins asserted.

What a link is, who makes one and what the snapshots are:
``backend.app.services.idp_links``.

Routes (mounted from ``api.py``):

  GET    /api/v1/admin/idp-link-requests?status=pending|all   system:admin
  POST   /api/v1/admin/idp-link-requests/{id}/link            make the link asked for
  POST   /api/v1/admin/idp-link-requests/{id}/decline
  GET    /api/v1/idp-groups/suggestions?q=&limit=             any signed-in user: their own
                                                              sign-ins' groups (everyone's,
                                                              with counts, for system:admin)
  GET    /api/v1/admin/idp-groups/preview?idpGroup=           system:admin: who has it
"""
from __future__ import annotations

from typing import Optional

from fastapi import APIRouter, Depends, HTTPException, Path, Query
from sqlalchemy.ext.asyncio import AsyncSession

from backend.app.auth.dependencies import get_current_user, get_permission_claims, requires
from backend.app.db.engine import get_db_session
from backend.app.db.repositories import idp_link_request_repo
from backend.app.services import idp_links as service
from backend.app.services.permission_service import PermissionClaims, has_permission
from backend.auth_service.interface import User
from backend.common.models.rbac import (
    IdpGroupPreview,
    IdpGroupSuggestion,
    IdpLinkRequestDecline,
    IdpLinkRequestLink,
    IdpLinkRequestResponse,
)

_platform_admin = requires(service.LINK_PERMISSION)

requests_router = APIRouter()   # /admin/idp-link-requests   (system:admin)
groups_router = APIRouter()     # /idp-groups                 (any signed-in user)
admin_groups_router = APIRouter()   # /admin/idp-groups       (system:admin)


@requests_router.get("", response_model=list[IdpLinkRequestResponse], response_model_by_alias=True)
async def list_idp_link_requests(
    status_filter: Optional[str] = Query(default="pending", alias="status"),
    _admin: User = Depends(_platform_admin),
    session: AsyncSession = Depends(get_db_session),
):
    """``?status=pending`` (the default), ``all``, or one status; newest first."""
    try:
        rows = await idp_link_request_repo.list_by_status(session, status=status_filter)
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc
    return await service.to_responses(session, rows)


@requests_router.post("/{request_id}/link", response_model=IdpLinkRequestResponse, response_model_by_alias=True)
async def link_idp_link_request(
    request_id: str = Path(...),
    body: Optional[IdpLinkRequestLink] = None,
    admin: User = Depends(_platform_admin),
    session: AsyncSession = Depends(get_db_session),
):
    """Link the group, from ``providerId`` — else the connection asked for, else any.
    409 ``wrong_status`` once it is answered."""
    row = await service.link_request(session, admin, request_id, body.provider_id if body else None)
    return (await service.to_responses(session, [row]))[0]


@requests_router.post("/{request_id}/decline", response_model=IdpLinkRequestResponse,
                      response_model_by_alias=True)
async def decline_idp_link_request(
    request_id: str = Path(...),
    body: Optional[IdpLinkRequestDecline] = None,
    admin: User = Depends(_platform_admin),
    session: AsyncSession = Depends(get_db_session),
):
    row = await service.decline_request(session, admin, request_id, body.reason if body else None)
    return (await service.to_responses(session, [row]))[0]


@groups_router.get("/suggestions", response_model=list[IdpGroupSuggestion], response_model_by_alias=True,
                   response_model_exclude_none=True)
async def suggest_idp_groups(
    q: Optional[str] = Query(default=None, max_length=200),
    limit: int = Query(default=20, ge=1, le=50),
    user: User = Depends(get_current_user),
    claims: PermissionClaims = Depends(get_permission_claims),
    session: AsyncSession = Depends(get_db_session),
):
    """Identity-provider groups whose name holds ``q``: from your own sign-ins — never
    anyone else's — or, for a platform administrator, from everyone's with
    ``seenCount``."""
    return await service.suggestions(session, user, everyone=has_permission(claims, service.LINK_PERMISSION),
                                     q=q, limit=limit)


@admin_groups_router.get("/preview", response_model=IdpGroupPreview, response_model_by_alias=True)
async def preview_idp_group(
    idp_group: str = Query(..., alias="idpGroup", max_length=200),
    _admin: User = Depends(_platform_admin),
    session: AsyncSession = Depends(get_db_session),
):
    return await service.preview(session, idp_group)
