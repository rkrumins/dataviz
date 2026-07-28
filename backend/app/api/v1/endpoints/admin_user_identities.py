"""Admin link / unlink CRUD for ``user_identities``.

Mounted at ``/api/v1/admin/users/{user_id}/identities``. Used by
operators to:

  * Surface a user's current SSO links (for support tickets).
  * Manually link a known ``external_id`` to an existing user — e.g.
    when SCIM provisioning hasn't been hooked up yet and the operator
    has a CSV of (email, IdP subject) pairs to apply.
  * Unlink an identity that's been compromised, with the
    ``enforce_last_authenticator`` invariant intentionally bypassed
    (admins are expected to set a new password / re-invite the user
    if this is the last credential).

All actions emit outbox events so the auth_audit_log captures who
touched whose identities.
"""
from __future__ import annotations

import logging
from typing import Optional

from fastapi import APIRouter, Depends, HTTPException, Path, status
from pydantic import BaseModel, ConfigDict, Field
from sqlalchemy.exc import IntegrityError
from sqlalchemy.ext.asyncio import AsyncSession

from backend.app.auth.dependencies import requires
from backend.app.db.engine import get_db_session
from backend.app.db.repositories import (
    idp_provider_repo,
    user_identity_repo,
    user_repo,
)
from backend.app.db.repositories.user_identity_repo import IdentityNotFound
from backend.auth_service.interface import User

logger = logging.getLogger(__name__)

router = APIRouter()


class AdminIdentityDTO(BaseModel):
    model_config = ConfigDict(populate_by_name=True)
    id: str
    user_id: str = Field(alias="userId")
    provider_id: str = Field(alias="providerId")
    provider_slug: str = Field(alias="providerSlug")
    provider_kind: str = Field(alias="providerKind")
    external_id: str = Field(alias="externalId")
    email_at_link: Optional[str] = Field(default=None, alias="emailAtLink")
    created_at: str = Field(alias="createdAt")
    last_login_at: Optional[str] = Field(default=None, alias="lastLoginAt")


class AdminLinkRequest(BaseModel):
    model_config = ConfigDict(populate_by_name=True)
    provider_id: str = Field(alias="providerId")
    external_id: str = Field(alias="externalId", min_length=1)
    email_at_link: Optional[str] = Field(default=None, alias="emailAtLink")


async def _to_dto(session: AsyncSession, ident) -> AdminIdentityDTO:
    provider = await idp_provider_repo.get_provider(session, ident.provider_id)
    return AdminIdentityDTO(
        id=ident.id,
        user_id=ident.user_id,
        provider_id=ident.provider_id,
        provider_slug=provider.slug if provider else "",
        provider_kind=provider.kind if provider else "",
        external_id=ident.external_id,
        email_at_link=ident.email_at_link,
        created_at=ident.created_at,
        last_login_at=ident.last_login_at,
    )


@router.get(
    "",
    response_model=list[AdminIdentityDTO],
    response_model_by_alias=True,
)
async def list_user_identities(
    user_id: str = Path(...),
    _admin: User = Depends(requires("system:admin")),
    session: AsyncSession = Depends(get_db_session),
):
    user = await user_repo.get_user_by_id(session, user_id)
    if user is None:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "User not found")
    identities = await user_identity_repo.list_for_user(session, user_id)
    return [await _to_dto(session, i) for i in identities]


@router.post(
    "",
    response_model=AdminIdentityDTO,
    response_model_by_alias=True,
    status_code=status.HTTP_201_CREATED,
)
async def admin_link_identity(
    body: AdminLinkRequest,
    user_id: str = Path(...),
    admin: User = Depends(requires("system:admin")),
    session: AsyncSession = Depends(get_db_session),
):
    user = await user_repo.get_user_by_id(session, user_id)
    if user is None:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "User not found")
    provider = await idp_provider_repo.get_provider(session, body.provider_id)
    if provider is None:
        raise HTTPException(status.HTTP_400_BAD_REQUEST, "Provider not found")
    try:
        ident = await user_identity_repo.create_identity(
            session,
            user_id=user_id, provider_id=body.provider_id,
            external_id=body.external_id,
            email_at_link=body.email_at_link or user.email,
        )
    except IntegrityError:
        raise HTTPException(
            status.HTTP_409_CONFLICT,
            "That (provider, external_id) is already linked OR the user "
            "already has an identity at this provider.",
        )
    await user_repo.create_outbox_event(
        session, event_type="user.identity.admin_linked",
        payload={"user_id": user_id, "identity_id": ident.id,
                 "provider_id": body.provider_id,
                 "external_id": body.external_id, "actor_id": admin.id},
    )
    return await _to_dto(session, ident)


@router.delete("/{identity_id}", status_code=status.HTTP_204_NO_CONTENT)
async def admin_unlink_identity(
    user_id: str = Path(...),
    identity_id: str = Path(...),
    admin: User = Depends(requires("system:admin")),
    session: AsyncSession = Depends(get_db_session),
):
    """Admin unlink. Bypasses the ``last_authenticator`` invariant —
    admins can leave a user with no credentials (and should follow up
    with a password reset or re-invite)."""
    ident = await user_identity_repo.get_by_id(session, identity_id)
    if ident is None or ident.user_id != user_id:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "Identity not found")
    try:
        await user_identity_repo.delete_identity(
            session, identity_id=identity_id,
            enforce_last_authenticator=False,
        )
    except IdentityNotFound:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "Identity not found")
    await user_repo.create_outbox_event(
        session, event_type="user.identity.admin_unlinked",
        payload={"user_id": user_id, "identity_id": identity_id,
                 "actor_id": admin.id},
    )
    return None
