"""Admin CRUD: idp_group_role_mappings.

Mounted at ``/api/v1/admin/idp-group-mappings``. Every endpoint requires
``system:admin``. The mappings drive the SSO group->role reconciler
(``permission_service.reconcile_sso_role_bindings``): on every SSO
login the reconciler reads every mapping whose ``idp_group`` is in the
user's IdP-asserted group set and ensures matching ``source='sso'``
RoleBindings exist; bindings whose source group is no longer asserted
are soft-revoked.

``system:admin`` is explicitly forbidden as an auto-mappable role —
admin grants must remain a deliberate human action with an audit trail.
"""
from __future__ import annotations

import logging
from typing import Optional

from fastapi import APIRouter, Depends, HTTPException, Query, status
from pydantic import BaseModel, ConfigDict, Field
from sqlalchemy.ext.asyncio import AsyncSession

from backend.app.auth.dependencies import requires
from backend.app.db.engine import get_db_session
from backend.app.db.repositories import idp_group_mapping_repo
from backend.app.db.repositories.idp_group_mapping_repo import (
    ForbiddenSsoRoleError,
)
from backend.auth_service.interface import User

logger = logging.getLogger(__name__)

router = APIRouter()


# ── DTOs ──────────────────────────────────────────────────────────────


class IdpGroupRoleMappingDTO(BaseModel):
    """Response shape — JSON-camelCase via the alias, snake_case in
    Python following the project convention."""
    model_config = ConfigDict(populate_by_name=True, from_attributes=True)

    id: str
    idp_group: str = Field(alias="idpGroup")
    scope_type: str = Field(alias="scopeType")
    scope_id: Optional[str] = Field(default=None, alias="scopeId")
    role_name: str = Field(alias="roleName")
    created_at: str = Field(alias="createdAt")
    created_by: Optional[str] = Field(default=None, alias="createdBy")


class CreateMappingRequest(BaseModel):
    """Body for ``POST /admin/idp-group-mappings``."""
    model_config = ConfigDict(populate_by_name=True)

    idp_group: str = Field(alias="idpGroup", min_length=1, max_length=256)
    scope_type: str = Field(alias="scopeType")
    scope_id: Optional[str] = Field(default=None, alias="scopeId")
    role_name: str = Field(alias="roleName", min_length=1, max_length=128)


def _to_dto(row) -> IdpGroupRoleMappingDTO:
    return IdpGroupRoleMappingDTO(
        id=row.id,
        idp_group=row.idp_group,
        scope_type=row.scope_type,
        scope_id=row.scope_id,
        role_name=row.role_name,
        created_at=row.created_at,
        created_by=row.created_by,
    )


# ── Endpoints ─────────────────────────────────────────────────────────


@router.get(
    "",
    response_model=list[IdpGroupRoleMappingDTO],
    response_model_by_alias=True,
)
async def list_mappings(
    _admin: User = Depends(requires("system:admin")),
    idp_group: Optional[str] = Query(default=None, alias="idpGroup"),
    session: AsyncSession = Depends(get_db_session),
):
    """Return every mapping (optionally filtered by group name).

    No pagination yet — mapping counts are expected to remain small
    (one row per IdP group × role pair). Add cursor pagination when
    the admin UI surfaces an "all mappings" view at scale.
    """
    rows = await idp_group_mapping_repo.list_mappings(
        session, idp_group=idp_group,
    )
    return [_to_dto(r) for r in rows]


@router.post(
    "",
    response_model=IdpGroupRoleMappingDTO,
    response_model_by_alias=True,
    status_code=status.HTTP_201_CREATED,
)
async def create_mapping(
    body: CreateMappingRequest,
    admin: User = Depends(requires("system:admin")),
    session: AsyncSession = Depends(get_db_session),
):
    """Create a new mapping. Returns 400 for invalid scope/role inputs
    or when the mapping targets the forbidden auto-role
    (``system:admin``)."""
    try:
        row = await idp_group_mapping_repo.create_mapping(
            session,
            idp_group=body.idp_group,
            scope_type=body.scope_type,
            scope_id=body.scope_id,
            role_name=body.role_name,
            created_by=admin.id,
        )
    except ForbiddenSsoRoleError as exc:
        raise HTTPException(status.HTTP_400_BAD_REQUEST, str(exc))
    except ValueError as exc:
        raise HTTPException(status.HTTP_400_BAD_REQUEST, str(exc))
    return _to_dto(row)


@router.delete("/{mapping_id}", status_code=status.HTTP_204_NO_CONTENT)
async def delete_mapping(
    mapping_id: str,
    _admin: User = Depends(requires("system:admin")),
    session: AsyncSession = Depends(get_db_session),
):
    """Remove a mapping. Existing RoleBindings derived from it remain
    until the affected users next SSO-login (the reconciler will then
    soft-revoke them because the mapping's target tuple is no longer in
    the target set). Operators wanting immediate revocation should call
    ``revoke_all_user_sessions`` for the affected users from the
    admin-users surface — out of scope for this endpoint."""
    ok = await idp_group_mapping_repo.delete_mapping(session, mapping_id)
    if not ok:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "mapping not found")
    return None
