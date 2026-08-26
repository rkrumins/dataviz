"""Self-service identity management.

Mounted at ``/api/v1/me/identities``. Each endpoint requires the user
to be authenticated (any auth method). Linking is initiated here but
*completed* by the regular SSO callback in
``backend.auth_service.api.router`` — the link-mode bit is carried in
a short-lived signed cookie.
"""
from __future__ import annotations

import logging
from typing import Optional

from fastapi import APIRouter, Depends, HTTPException, Request, Response, status
from fastapi.responses import RedirectResponse
from pydantic import BaseModel, ConfigDict, Field
from sqlalchemy.ext.asyncio import AsyncSession

from backend.app.auth.dependencies import get_current_user
from backend.app.db.engine import get_db_session
from backend.app.db.repositories import (
    idp_provider_repo,
    user_identity_repo,
    user_repo,
)
from backend.app.db.repositories.user_identity_repo import (
    IdentityNotFound,
    LastAuthenticatorError,
)
from backend.auth_service.core.password import is_password_set
from backend.auth_service.interface import User

logger = logging.getLogger(__name__)

router = APIRouter()


# ── DTOs ──────────────────────────────────────────────────────────────


class IdentityProviderRef(BaseModel):
    model_config = ConfigDict(populate_by_name=True)
    id: str
    slug: str
    display_name: str = Field(alias="displayName")
    kind: str


class IdentityDTO(BaseModel):
    """One linked identity on the current user."""
    model_config = ConfigDict(populate_by_name=True)
    id: str
    provider: IdentityProviderRef
    external_id: str = Field(alias="externalId")
    email_at_link: Optional[str] = Field(default=None, alias="emailAtLink")
    created_at: str = Field(alias="createdAt")
    last_login_at: Optional[str] = Field(default=None, alias="lastLoginAt")


class IdentitiesResponse(BaseModel):
    """Listing returned by ``GET /me/identities``."""
    model_config = ConfigDict(populate_by_name=True)
    password_set: bool = Field(alias="passwordSet")
    identities: list[IdentityDTO]


# ── Endpoints ─────────────────────────────────────────────────────────


@router.get(
    "",
    response_model=IdentitiesResponse,
    response_model_by_alias=True,
)
async def list_my_identities(
    current: User = Depends(get_current_user),
    session: AsyncSession = Depends(get_db_session),
):
    user = await user_repo.get_user_by_id(session, current.id)
    if user is None:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "User not found")
    identities = await user_identity_repo.list_for_user(session, current.id)
    dtos: list[IdentityDTO] = []
    for ident in identities:
        provider = await idp_provider_repo.get_provider(session, ident.provider_id)
        if provider is None:
            continue
        dtos.append(IdentityDTO(
            id=ident.id,
            provider=IdentityProviderRef(
                id=provider.id, slug=provider.slug,
                display_name=provider.display_name, kind=provider.kind,
            ),
            external_id=ident.external_id,
            email_at_link=ident.email_at_link,
            created_at=ident.created_at,
            last_login_at=ident.last_login_at,
        ))
    return IdentitiesResponse(
        password_set=is_password_set(user.password_hash),
        identities=dtos,
    )


@router.delete("/{identity_id}", status_code=status.HTTP_204_NO_CONTENT)
async def unlink_identity(
    identity_id: str,
    current: User = Depends(get_current_user),
    session: AsyncSession = Depends(get_db_session),
):
    """Remove one of the current user's identities.

    Refuses (409) when this would leave the user with no way to log in
    (no password, no other identities). Operators stuck in that
    corner can ask an admin to do the unlink instead, which uses the
    ``admin_user_identities`` route with the enforce flag off.
    """
    identity = await user_identity_repo.get_by_id(session, identity_id)
    if identity is None or identity.user_id != current.id:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "Identity not found")
    try:
        await user_identity_repo.delete_identity(
            session, identity_id=identity_id, enforce_last_authenticator=True,
        )
    except IdentityNotFound:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "Identity not found")
    except LastAuthenticatorError as exc:
        raise HTTPException(
            status.HTTP_409_CONFLICT,
            detail={"error": "last_authenticator", "message": str(exc)},
        )
    # With the link gone this provider will never re-assert the profile
    # fields it owned, so the name-lock it held is released. Scoped: a
    # lock held by a different provider stays.
    await user_repo.clear_idp_managed_snapshot(
        session, current.id, provider_id=identity.provider_id,
    )
    await user_repo.create_outbox_event(
        session, event_type="user.identity.unlinked",
        payload={"user_id": current.id, "identity_id": identity_id,
                 "via": "self_service"},
    )
    return None


# ── Self-service link initiation ─────────────────────────────────────


from backend.auth_service.core.tokens import create_link_intent_token
from backend.auth_service.cookies import set_link_intent_cookie


@router.post("/link/{provider_slug}/start")
async def start_link(
    provider_slug: str,
    request: Request,
    response: Response,
    current: User = Depends(get_current_user),
    session: AsyncSession = Depends(get_db_session),
):
    """Begin a self-service link flow.

    Returns a JSON envelope with the location the FE should send the
    user to. The link-intent cookie carries the (user_id, provider_id)
    pair so the SSO callback can bind the identity to the right user
    instead of provisioning a new one.

    Returns JSON instead of a 302 so the FE can decide whether to
    open the IdP in the same tab or a popup. The actual IdP redirect
    URL is the standard ``/auth/{slug}/login`` route.
    """
    provider = await idp_provider_repo.get_provider_by_slug(session, provider_slug)
    if provider is None or not provider.enabled:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "Provider not found")
    if provider.kind not in {
        "oidc", "saml2", "custom", "custom_profile", "backchannel",
    }:
        raise HTTPException(status.HTTP_400_BAD_REQUEST, "Unsupported provider kind")

    token = create_link_intent_token(
        user_id=current.id, provider_id=provider.id,
    )
    set_link_intent_cookie(response, token)
    return {
        "loginUrl": f"/api/v1/auth/{provider.slug}/login?next=/me/identities",
        "providerSlug": provider.slug,
        "providerKind": provider.kind,
    }
