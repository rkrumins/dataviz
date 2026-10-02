"""Admin CRUD: ``idp_group_role_mappings`` (Phase 3 — both target types).

Mounted at ``/api/v1/admin/idp-group-mappings``. Every endpoint
requires ``system:admin``. Two creation flows reflect the two target
types:

  * ``POST /role-binding`` — IdP group -> RoleBinding (Phase 2 shape).
  * ``POST /group-membership`` — IdP group -> internal Group membership.

Listing returns rows of either shape; the ``target_type`` field tells
consumers which path to render. Validation lives in the repo: role
existence + workspace-scope bindability for role_binding targets,
group existence + ``is_protected`` check for group_membership targets,
and the universal ``system:admin`` refusal.
"""
from __future__ import annotations

import logging
from typing import Optional

from fastapi import APIRouter, Depends, HTTPException, Query, status
from pydantic import BaseModel, ConfigDict, Field
from sqlalchemy.ext.asyncio import AsyncSession

from backend.app.auth.dependencies import requires
from backend.app.db.engine import get_db_session
from backend.app.db.repositories import idp_group_mapping_repo, user_repo
from backend.app.db.repositories.idp_group_mapping_repo import (
    ForbiddenSsoRoleError,
    MappingValidationError,
)
from backend.auth_service.interface import User

logger = logging.getLogger(__name__)

router = APIRouter()


# ── DTOs ──────────────────────────────────────────────────────────────


class IdpGroupRoleMappingDTO(BaseModel):
    """Single mapping row — supports both target shapes."""
    model_config = ConfigDict(populate_by_name=True, from_attributes=True)

    id: str
    provider_id: Optional[str] = Field(default=None, alias="providerId")
    idp_group: str = Field(alias="idpGroup")
    target_type: str = Field(alias="targetType")
    # role_binding fields (NULL for group_membership)
    scope_type: Optional[str] = Field(default=None, alias="scopeType")
    scope_id: Optional[str] = Field(default=None, alias="scopeId")
    role_name: Optional[str] = Field(default=None, alias="roleName")
    # group_membership field (NULL for role_binding)
    target_group_id: Optional[str] = Field(default=None, alias="targetGroupId")
    created_at: str = Field(alias="createdAt")
    created_by: Optional[str] = Field(default=None, alias="createdBy")


def _to_dto(row) -> IdpGroupRoleMappingDTO:
    return IdpGroupRoleMappingDTO(
        id=row.id,
        provider_id=row.provider_id,
        idp_group=row.idp_group,
        target_type=row.target_type,
        scope_type=row.scope_type,
        scope_id=row.scope_id,
        role_name=row.role_name,
        target_group_id=row.target_group_id,
        created_at=row.created_at,
        created_by=row.created_by,
    )


class CreateRoleBindingMappingRequest(BaseModel):
    model_config = ConfigDict(populate_by_name=True)
    idp_group: str = Field(alias="idpGroup", min_length=1, max_length=256)
    role_name: str = Field(alias="roleName", min_length=1, max_length=128)
    scope_type: str = Field(alias="scopeType")
    scope_id: Optional[str] = Field(default=None, alias="scopeId")
    provider_id: Optional[str] = Field(default=None, alias="providerId")


class CreateGroupMembershipMappingRequest(BaseModel):
    model_config = ConfigDict(populate_by_name=True)
    idp_group: str = Field(alias="idpGroup", min_length=1, max_length=256)
    target_group_id: str = Field(alias="targetGroupId", min_length=1)
    provider_id: Optional[str] = Field(default=None, alias="providerId")


class UpdateMappingRequest(BaseModel):
    """Full replacement of one rule — a rule is one sentence, so the
    whole sentence is validated, exactly as on create. ``targetType``
    picks which target fields must be present."""
    model_config = ConfigDict(populate_by_name=True)
    idp_group: str = Field(alias="idpGroup", min_length=1, max_length=256)
    target_type: str = Field(alias="targetType")
    role_name: Optional[str] = Field(default=None, alias="roleName", max_length=128)
    scope_type: Optional[str] = Field(default=None, alias="scopeType")
    scope_id: Optional[str] = Field(default=None, alias="scopeId")
    target_group_id: Optional[str] = Field(default=None, alias="targetGroupId")
    provider_id: Optional[str] = Field(default=None, alias="providerId")


# ── Endpoints ─────────────────────────────────────────────────────────


@router.get("", response_model=list[IdpGroupRoleMappingDTO],
            response_model_by_alias=True)
async def list_mappings(
    _admin: User = Depends(requires("system:admin")),
    idp_group: Optional[str] = Query(default=None, alias="idpGroup"),
    provider_id: Optional[str] = Query(default=None, alias="providerId"),
    target_type: Optional[str] = Query(default=None, alias="targetType"),
    session: AsyncSession = Depends(get_db_session),
):
    rows = await idp_group_mapping_repo.list_mappings(
        session, provider_id=provider_id, idp_group=idp_group,
        target_type=target_type,
    )
    return [_to_dto(r) for r in rows]


@router.post(
    "/role-binding",
    response_model=IdpGroupRoleMappingDTO,
    response_model_by_alias=True,
    status_code=status.HTTP_201_CREATED,
)
async def create_role_binding_mapping(
    body: CreateRoleBindingMappingRequest,
    admin: User = Depends(requires("system:admin")),
    session: AsyncSession = Depends(get_db_session),
):
    try:
        row = await idp_group_mapping_repo.create_role_binding_mapping(
            session,
            idp_group=body.idp_group,
            role_name=body.role_name,
            scope_type=body.scope_type,
            scope_id=body.scope_id,
            provider_id=body.provider_id,
            created_by=admin.id,
        )
    except ForbiddenSsoRoleError as exc:
        raise HTTPException(status.HTTP_400_BAD_REQUEST, str(exc))
    except (MappingValidationError, ValueError) as exc:
        raise HTTPException(status.HTTP_400_BAD_REQUEST, str(exc))
    await user_repo.create_outbox_event(
        session, event_type="rbac.sso_mapping.created",
        payload={"mapping_id": row.id, "target_type": "role_binding",
                 "idp_group": row.idp_group, "role_name": row.role_name,
                 "scope_type": row.scope_type, "scope_id": row.scope_id,
                 "provider_id": row.provider_id, "actor_id": admin.id},
    )
    return _to_dto(row)


@router.post(
    "/group-membership",
    response_model=IdpGroupRoleMappingDTO,
    response_model_by_alias=True,
    status_code=status.HTTP_201_CREATED,
)
async def create_group_membership_mapping(
    body: CreateGroupMembershipMappingRequest,
    admin: User = Depends(requires("system:admin")),
    session: AsyncSession = Depends(get_db_session),
):
    try:
        row = await idp_group_mapping_repo.create_group_membership_mapping(
            session,
            idp_group=body.idp_group,
            target_group_id=body.target_group_id,
            provider_id=body.provider_id,
            created_by=admin.id,
        )
    except (MappingValidationError, ValueError) as exc:
        raise HTTPException(status.HTTP_400_BAD_REQUEST, str(exc))
    await user_repo.create_outbox_event(
        session, event_type="rbac.sso_mapping.created",
        payload={"mapping_id": row.id, "target_type": "group_membership",
                 "idp_group": row.idp_group,
                 "target_group_id": row.target_group_id,
                 "provider_id": row.provider_id, "actor_id": admin.id},
    )
    return _to_dto(row)


@router.put(
    "/{mapping_id}",
    response_model=IdpGroupRoleMappingDTO,
    response_model_by_alias=True,
)
async def update_mapping(
    mapping_id: str,
    body: UpdateMappingRequest,
    admin: User = Depends(requires("system:admin")),
    session: AsyncSession = Depends(get_db_session),
):
    """Edit a live rule in place.

    Every guard the create paths run runs here too — the privileged-role
    floor, the protected-group refusal, provider assurance — so an edit
    can never reach a target a create could not. The row keeps its id
    and provenance; grants made under the old rule adjust at each
    person's next sign-in or session refresh, exactly as after a delete.
    """
    before = await idp_group_mapping_repo.get_mapping(session, mapping_id)
    if before is None:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "mapping not found")
    was = {
        "idp_group": before.idp_group, "target_type": before.target_type,
        "role_name": before.role_name, "scope_type": before.scope_type,
        "scope_id": before.scope_id,
        "target_group_id": before.target_group_id,
        "provider_id": before.provider_id,
    }
    try:
        row = await idp_group_mapping_repo.update_mapping(
            session, mapping_id,
            idp_group=body.idp_group,
            target_type=body.target_type,
            role_name=body.role_name,
            scope_type=body.scope_type,
            scope_id=body.scope_id,
            target_group_id=body.target_group_id,
            provider_id=body.provider_id,
        )
    except ForbiddenSsoRoleError as exc:
        raise HTTPException(status.HTTP_400_BAD_REQUEST, str(exc))
    except (MappingValidationError, ValueError) as exc:
        raise HTTPException(status.HTTP_400_BAD_REQUEST, str(exc))
    if row is None:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "mapping not found")

    # If this edit removed the last mapping reaching the OLD target, the
    # grants made under it fall outside every future reconcile — sweep
    # them now. A target the row (or any other rule) still reaches is
    # left alone; the repo re-checks.
    swept = await idp_group_mapping_repo.remove_orphaned_sso_grants(
        session,
        role_keys=(
            [(was["scope_type"], was["scope_id"], was["role_name"])]
            if was["target_type"] == "role_binding" and was["role_name"]
            and was["scope_type"] else []
        ),
        group_ids=(
            [was["target_group_id"]]
            if was["target_type"] == "group_membership"
            and was["target_group_id"] else []
        ),
    )
    await user_repo.create_outbox_event(
        session, event_type="rbac.sso_mapping.updated",
        payload={
            "mapping_id": row.id, "actor_id": admin.id,
            "before": was,
            "after": {
                "idp_group": row.idp_group, "target_type": row.target_type,
                "role_name": row.role_name, "scope_type": row.scope_type,
                "scope_id": row.scope_id,
                "target_group_id": row.target_group_id,
                "provider_id": row.provider_id,
            },
            "stale_grants_cleared": swept,
        },
    )
    return _to_dto(row)


@router.delete("/{mapping_id}", status_code=status.HTTP_204_NO_CONTENT)
async def delete_mapping(
    mapping_id: str,
    admin: User = Depends(requires("system:admin")),
    session: AsyncSession = Depends(get_db_session),
):
    row = await idp_group_mapping_repo.get_mapping(session, mapping_id)
    if row is None:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "mapping not found")
    # Captured before the delete: afterwards the ORM instance is
    # deleted state and its attributes are not to be trusted.
    old_target_type, old_idp_group = row.target_type, row.idp_group
    old_role_keys = (
        [(row.scope_type, row.scope_id, row.role_name)]
        if row.target_type == "role_binding" and row.role_name
        and row.scope_type else []
    )
    old_group_ids = (
        [row.target_group_id]
        if row.target_type == "group_membership"
        and row.target_group_id else []
    )
    ok = await idp_group_mapping_repo.delete_mapping(session, mapping_id)
    if not ok:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "mapping not found")
    # Same orphan sweep as an edit: with the last route to this target
    # gone, its grants would outlive every future reconcile.
    swept = await idp_group_mapping_repo.remove_orphaned_sso_grants(
        session, role_keys=old_role_keys, group_ids=old_group_ids,
    )
    await user_repo.create_outbox_event(
        session, event_type="rbac.sso_mapping.deleted",
        payload={"mapping_id": mapping_id, "target_type": old_target_type,
                 "idp_group": old_idp_group, "actor_id": admin.id,
                 "stale_grants_cleared": swept},
    )
    return None
