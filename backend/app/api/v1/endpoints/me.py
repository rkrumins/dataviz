"""Endpoints under ``/api/v1/me`` — current-user introspection.

Phase 1 ships ``GET /me/permissions`` so the frontend can hydrate its
permissions store at login and on every silent refresh. The endpoint
re-emits the permission claims that are already in the access JWT —
the JWT is HttpOnly so the frontend can't decode it directly, and a
dedicated endpoint keeps that boundary clean.

Phase 4.2 adds ``GET /me/access`` — the same payload an admin sees on
the "By user" tab, but keyed off the caller's own ``user_id``. Powers
the self-service "My access" page so end users can answer the
question "what can I do, and how did I get that?" without filing a
ticket.

The classic ``GET /auth/me`` (returns the User DTO) lives in the auth
service router and is unaffected by this module.
"""
from __future__ import annotations

from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel, Field
from sqlalchemy.ext.asyncio import AsyncSession

from backend.app.api.v1.endpoints.permissions_admin import compute_user_access
from backend.app.auth.dependencies import get_current_user, get_permission_claims
from backend.app.db.engine import get_db_session
from backend.app.services.permission_service import PermissionClaims
from backend.auth_service.interface import User
from backend.common.models.rbac import UserAccessResponse


router = APIRouter()


class PermissionsResponse(BaseModel):
    """Wire shape of ``GET /me/permissions``.

    Field names mirror the JWT claim shape so the FE store can be
    populated by spreading the response object directly.
    """
    sid: str
    global_perms: list[str] = Field(default_factory=list, alias="global")
    ws: dict[str, list[str]] = Field(default_factory=dict)

    model_config = {
        "populate_by_name": True,
    }


@router.get(
    "/permissions",
    response_model=PermissionsResponse,
    response_model_by_alias=True,
)
async def get_my_permissions(
    claims: PermissionClaims = Depends(get_permission_claims),
) -> PermissionsResponse:
    """Return the caller's effective permissions across all scopes.

    Read directly from the access JWT — no DB hit. The frontend uses
    this to gate UI controls (hide the admin link, show the Share
    button only when the user can change visibility, etc.). Backend
    enforcement still happens in ``requires(...)``; the frontend
    treats this response as advisory.
    """
    return PermissionsResponse(
        sid=claims.sid,
        global_perms=list(claims.global_perms),
        ws={ws_id: list(perms) for ws_id, perms in claims.ws_perms.items()},
    )


@router.get(
    "/access",
    response_model=UserAccessResponse,
    response_model_by_alias=True,
)
async def get_my_access(
    user: User = Depends(get_current_user),
    session: AsyncSession = Depends(get_db_session),
) -> UserAccessResponse:
    """Return the caller's own access map.

    Same shape as the admin ``GET /admin/users/{user_id}/access`` —
    every binding (direct + via group), the resolved effective
    permission map, and the user's group memberships. Differs only in
    that ``user_id`` is taken from the authenticated session, never
    the URL, so a non-admin user can never read someone else's access.
    Backs the "My access" self-service page.
    """
    response = await compute_user_access(session, user.id)
    if response is None:
        # The current_user dependency only succeeds on a live session,
        # so the user must exist. A None here means the row was deleted
        # mid-request; treat as 404 rather than 500.
        raise HTTPException(status_code=404, detail="User not found")
    return response
