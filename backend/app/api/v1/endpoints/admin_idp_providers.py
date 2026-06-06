"""Admin CRUD: ``idp_providers``.

Mounted at ``/api/v1/admin/idp-providers``. Every endpoint requires
``system:admin``. The ``settings`` field in the response is always
redacted — operators rotate secrets through the dedicated PATCH
endpoint, not by reading the existing value back. The ``/test``
endpoint runs the claim mapper against a paste-in claims blob so
admins can iterate on the mapping config without involving real users.
"""
from __future__ import annotations

import logging
from typing import Optional

from fastapi import APIRouter, Body, Depends, HTTPException, Path, status
from pydantic import BaseModel, ConfigDict, Field
from sqlalchemy.ext.asyncio import AsyncSession
from sqlalchemy.exc import IntegrityError

from backend.app.auth.dependencies import requires
from backend.app.db.engine import get_db_session
from backend.app.db.repositories import idp_provider_repo, user_repo
from backend.app.db.repositories.idp_provider_repo import (
    ProviderValidationError,
)
from backend.auth_service.interface import User
from backend.auth_service.providers import (
    apply_claim_mapping,
    ClaimMappingError,
    DEFAULT_OIDC,
    DEFAULT_SAML,
    DEFAULT_CUSTOM,
    get_registry,
)

logger = logging.getLogger(__name__)

router = APIRouter()


# ── DTOs ──────────────────────────────────────────────────────────────


class ProviderDTO(BaseModel):
    """Public-safe view of a provider row. ``settings`` is redacted
    (secret fields show ``********``); the operator-defined
    ``claim_mapping`` is exposed verbatim because it contains no
    secrets."""
    model_config = ConfigDict(populate_by_name=True, from_attributes=True)

    id: str
    slug: str
    display_name: str = Field(alias="displayName")
    kind: str
    enabled: bool
    priority: int
    settings: dict
    claim_mapping: dict = Field(alias="claimMapping")
    linking_policy: str = Field(alias="linkingPolicy")
    button_label: Optional[str] = Field(default=None, alias="buttonLabel")
    button_icon: Optional[str] = Field(default=None, alias="buttonIcon")
    created_at: str = Field(alias="createdAt")
    updated_at: str = Field(alias="updatedAt")


class CreateProviderRequest(BaseModel):
    model_config = ConfigDict(populate_by_name=True)
    slug: str
    display_name: str = Field(alias="displayName")
    kind: str
    settings: dict = Field(default_factory=dict)
    claim_mapping: dict = Field(default_factory=dict, alias="claimMapping")
    linking_policy: str = Field(default="strict", alias="linkingPolicy")
    priority: int = 100
    enabled: bool = True
    button_label: Optional[str] = Field(default=None, alias="buttonLabel")
    button_icon: Optional[str] = Field(default=None, alias="buttonIcon")


class UpdateProviderRequest(BaseModel):
    """Partial-update body. Pass only the fields you want to change;
    ``settings`` is merged into the existing encrypted blob (use a
    ``None`` value to remove a key)."""
    model_config = ConfigDict(populate_by_name=True)
    display_name: Optional[str] = Field(default=None, alias="displayName")
    enabled: Optional[bool] = None
    priority: Optional[int] = None
    settings: Optional[dict] = None
    claim_mapping: Optional[dict] = Field(default=None, alias="claimMapping")
    linking_policy: Optional[str] = Field(default=None, alias="linkingPolicy")
    button_label: Optional[str] = Field(default=None, alias="buttonLabel")
    button_icon: Optional[str] = Field(default=None, alias="buttonIcon")


class TestMappingRequest(BaseModel):
    """Body for ``POST /admin/idp-providers/{id}/test``.

    ``claims`` is the IdP-asserted blob — paste in a real id_token
    payload or SAML attribute statement. ``override`` lets admins
    preview a mapping change without saving."""
    model_config = ConfigDict(populate_by_name=True)
    claims: dict
    override: Optional[dict] = None


def _to_dto(row) -> ProviderDTO:
    settings = idp_provider_repo.decrypt_settings(row.settings)
    return ProviderDTO(
        id=row.id,
        slug=row.slug,
        display_name=row.display_name,
        kind=row.kind,
        enabled=bool(row.enabled),
        priority=int(row.priority or 100),
        settings=idp_provider_repo.redact_settings(settings),
        claim_mapping=idp_provider_repo.parse_claim_mapping(row),
        linking_policy=row.linking_policy,
        button_label=row.button_label,
        button_icon=row.button_icon,
        created_at=row.created_at,
        updated_at=row.updated_at,
    )


# ── Endpoints ─────────────────────────────────────────────────────────


@router.get("", response_model=list[ProviderDTO], response_model_by_alias=True)
async def list_providers(
    _admin: User = Depends(requires("system:admin")),
    session: AsyncSession = Depends(get_db_session),
):
    rows = await idp_provider_repo.list_providers(session)
    return [_to_dto(r) for r in rows]


@router.get("/defaults/{kind}")
async def get_default_mapping(
    kind: str = Path(...),
    _admin: User = Depends(requires("system:admin")),
):
    """Return the default claim mapping for a kind so the admin UI can
    pre-fill the editor when an operator starts a fresh provider."""
    defaults = {"oidc": DEFAULT_OIDC, "saml2": DEFAULT_SAML, "custom": DEFAULT_CUSTOM}
    mapping = defaults.get(kind)
    if mapping is None:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "Unknown kind")
    return mapping


@router.post(
    "",
    response_model=ProviderDTO,
    response_model_by_alias=True,
    status_code=status.HTTP_201_CREATED,
)
async def create_provider(
    body: CreateProviderRequest,
    admin: User = Depends(requires("system:admin")),
    session: AsyncSession = Depends(get_db_session),
):
    try:
        row = await idp_provider_repo.create_provider(
            session,
            slug=body.slug,
            display_name=body.display_name,
            kind=body.kind,
            settings=body.settings,
            claim_mapping=body.claim_mapping,
            linking_policy=body.linking_policy,
            priority=body.priority,
            enabled=body.enabled,
            button_label=body.button_label,
            button_icon=body.button_icon,
            created_by=admin.id,
        )
    except ProviderValidationError as exc:
        raise HTTPException(status.HTTP_400_BAD_REQUEST, str(exc))
    except IntegrityError:
        raise HTTPException(
            status.HTTP_409_CONFLICT,
            f"A provider with slug '{body.slug}' already exists",
        )
    await user_repo.create_outbox_event(
        session, event_type="idp.provider.created",
        payload={"provider_id": row.id, "slug": row.slug, "kind": row.kind,
                 "actor": admin.id},
    )
    # Bust the registry cache so the new provider is live immediately.
    try:
        await get_registry().invalidate(row.id)
    except RuntimeError:
        pass
    return _to_dto(row)


@router.patch(
    "/{provider_id}",
    response_model=ProviderDTO,
    response_model_by_alias=True,
)
async def update_provider(
    provider_id: str,
    body: UpdateProviderRequest,
    admin: User = Depends(requires("system:admin")),
    session: AsyncSession = Depends(get_db_session),
):
    try:
        row = await idp_provider_repo.update_provider(
            session,
            provider_id,
            display_name=body.display_name,
            enabled=body.enabled,
            priority=body.priority,
            settings=body.settings,
            claim_mapping=body.claim_mapping,
            linking_policy=body.linking_policy,
            button_label=body.button_label,
            button_icon=body.button_icon,
            updated_by=admin.id,
        )
    except ProviderValidationError as exc:
        raise HTTPException(status.HTTP_400_BAD_REQUEST, str(exc))
    if row is None:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "Provider not found")
    await user_repo.create_outbox_event(
        session, event_type="idp.provider.updated",
        payload={"provider_id": row.id, "slug": row.slug, "actor": admin.id,
                 "fields": [k for k, v in body.model_dump().items() if v is not None]},
    )
    try:
        await get_registry().invalidate(row.id)
    except RuntimeError:
        pass
    return _to_dto(row)


@router.delete("/{provider_id}", status_code=status.HTTP_204_NO_CONTENT)
async def delete_provider(
    provider_id: str,
    admin: User = Depends(requires("system:admin")),
    session: AsyncSession = Depends(get_db_session),
):
    row = await idp_provider_repo.get_provider(session, provider_id)
    if row is None:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "Provider not found")
    try:
        ok = await idp_provider_repo.delete_provider(session, provider_id)
    except IntegrityError:
        raise HTTPException(
            status.HTTP_409_CONFLICT,
            "Provider has linked user identities — unlink them first",
        )
    if not ok:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "Provider not found")
    await user_repo.create_outbox_event(
        session, event_type="idp.provider.deleted",
        payload={"provider_id": provider_id, "slug": row.slug,
                 "actor": admin.id},
    )
    try:
        await get_registry().invalidate(provider_id)
    except RuntimeError:
        pass
    return None


@router.post("/{provider_id}/test")
async def test_provider_mapping(
    provider_id: str,
    body: TestMappingRequest = Body(...),
    _admin: User = Depends(requires("system:admin")),
    session: AsyncSession = Depends(get_db_session),
):
    """Dry-run the configured (or overridden) claim mapping against a
    paste-in claims blob. Returns the resolved fields — including any
    ``extras`` — without persisting anything. Useful for debugging
    "why isn't department coming through?" without dragging in an end
    user."""
    row = await idp_provider_repo.get_provider(session, provider_id)
    if row is None:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "Provider not found")
    override = (
        body.override if body.override is not None
        else idp_provider_repo.parse_claim_mapping(row)
    )
    try:
        identity = apply_claim_mapping(
            body.claims, kind=row.kind, provider_slug=row.slug,
            override=override,
        )
    except ClaimMappingError as exc:
        raise HTTPException(status.HTTP_400_BAD_REQUEST, str(exc))
    return {
        "providerId": provider_id,
        "providerSlug": row.slug,
        "resolved": {
            "external_id": identity.external_id,
            "email": identity.email,
            "first_name": identity.first_name,
            "last_name": identity.last_name,
            "groups": list(identity.groups),
            "auth_time": identity.auth_time,
            "attributes": identity.attributes,
        },
    }
