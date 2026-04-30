"""Endpoints under ``/api/v1/me`` — current-user introspection.

Phase 1 ships ``GET /me/permissions`` so the frontend can hydrate its
permissions store at login and on every silent refresh. The endpoint
re-emits the permission claims that are already in the access JWT —
the JWT is HttpOnly so the frontend can't decode it directly, and a
dedicated endpoint keeps that boundary clean.

The classic ``GET /auth/me`` (returns the User DTO) lives in the auth
service router and is unaffected by this module.
"""
from __future__ import annotations

from fastapi import APIRouter, Depends
from pydantic import BaseModel, Field

from backend.app.auth.dependencies import get_permission_claims
from backend.app.services.permission_service import PermissionClaims


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
