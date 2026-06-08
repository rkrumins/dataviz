"""Branding endpoints — white-label application identity.

Two surfaces under different routers so the auth posture is explicit:

  * ``public_router`` — ``GET /api/v1/branding``. **Unauthenticated.**
    The login page, browser tab title and favicon all need branding
    *before* a session exists, so this must answer without a cookie.
    No secrets are exposed — only the public brand identity.

  * ``admin_router`` — ``PATCH /api/v1/admin/branding`` and the two
    upload endpoints. Gated ``system:admin``. Mirrors
    ``admin_sso_config``: camelCase DTO aliases, optimistic-version
    concurrency (409 on mismatch), and an audit outbox event.

Logo/favicon uploads are stored base64 in the singleton row (no
external object store needed); the public GET emits them as ``data:``
URIs so the frontend consumes one ``logoUrl``/``faviconUrl`` field
regardless of whether the admin pasted a URL or uploaded a file.
"""
from __future__ import annotations

import base64
import logging
from typing import Optional

from fastapi import (
    APIRouter, Depends, File, HTTPException, UploadFile, status,
)
from pydantic import BaseModel, ConfigDict, Field
from sqlalchemy.ext.asyncio import AsyncSession

from backend.app.auth.dependencies import requires
from backend.app.db.engine import get_db_session
from backend.app.db.repositories import branding_repo, user_repo
from backend.app.db.repositories.branding_repo import ConflictingVersion
from backend.auth_service.interface import User

logger = logging.getLogger(__name__)

public_router = APIRouter()
admin_router = APIRouter()

# Upload guards. Logos are small; cap at 1 MiB and an SVG/raster allow-list.
_MAX_UPLOAD_BYTES = 1024 * 1024
_ALLOWED_IMAGE_MIME = {
    "image/svg+xml", "image/png", "image/jpeg", "image/webp", "image/x-icon",
    "image/vnd.microsoft.icon",
}


class BrandingDTO(BaseModel):
    """Public branding payload. ``version`` is the optimistic-concurrency
    token the admin UI echoes back on PATCH."""
    model_config = ConfigDict(populate_by_name=True)
    app_name: str = Field(alias="appName")
    short_name: str = Field(alias="shortName")
    description: str = Field(alias="description")
    logo_url: str = Field(alias="logoUrl")
    favicon_url: str = Field(alias="faviconUrl")
    accent_color: str = Field(alias="accentColor")
    copyright_text: str = Field(alias="copyrightText")
    support_email: str = Field(alias="supportEmail")
    login_tagline: str = Field(alias="loginTagline")
    version: int
    updated_at: str = Field(alias="updatedAt")


class BrandingPatch(BaseModel):
    """Partial-update body. All fields optional; pass ``expectedVersion``
    to bind the change to the version the admin saw. An empty string
    clears a value (falling back to the env default on read)."""
    model_config = ConfigDict(populate_by_name=True)
    app_name: Optional[str] = Field(default=None, alias="appName")
    short_name: Optional[str] = Field(default=None, alias="shortName")
    description: Optional[str] = Field(default=None, alias="description")
    logo_url: Optional[str] = Field(default=None, alias="logoUrl")
    favicon_url: Optional[str] = Field(default=None, alias="faviconUrl")
    # Raw image fields — only the UI's "remove uploaded image" action sends
    # these (as empty strings) so a pasted URL / the default mark can take
    # over. Uploading a new image goes through the dedicated POST endpoints.
    logo_data: Optional[str] = Field(default=None, alias="logoData")
    logo_mime: Optional[str] = Field(default=None, alias="logoMime")
    favicon_data: Optional[str] = Field(default=None, alias="faviconData")
    favicon_mime: Optional[str] = Field(default=None, alias="faviconMime")
    accent_color: Optional[str] = Field(default=None, alias="accentColor")
    copyright_text: Optional[str] = Field(default=None, alias="copyrightText")
    support_email: Optional[str] = Field(default=None, alias="supportEmail")
    login_tagline: Optional[str] = Field(default=None, alias="loginTagline")
    expected_version: Optional[int] = Field(default=None, alias="expectedVersion")


def _to_dto(snap: branding_repo.BrandingSnapshot) -> BrandingDTO:
    return BrandingDTO(
        app_name=snap.app_name,
        short_name=snap.short_name,
        description=snap.description,
        logo_url=snap.logo_url,
        favicon_url=snap.favicon_url,
        accent_color=snap.accent_color,
        copyright_text=snap.copyright_text,
        support_email=snap.support_email,
        login_tagline=snap.login_tagline,
        version=snap.version,
        updated_at=snap.updated_at,
    )


# ── Public ────────────────────────────────────────────────────────────
@public_router.get("", response_model=BrandingDTO, response_model_by_alias=True)
async def get_branding(session: AsyncSession = Depends(get_db_session)):
    """Public brand identity — no auth. Always answers (env defaults
    fill any missing row/column)."""
    snap = await branding_repo.get_snapshot(session)
    return _to_dto(snap)


# ── Admin ─────────────────────────────────────────────────────────────
@admin_router.get("", response_model=BrandingDTO, response_model_by_alias=True)
async def get_branding_admin(
    _admin: User = Depends(requires("system:admin")),
    session: AsyncSession = Depends(get_db_session),
):
    """Same payload as the public GET; separate route so the admin UI
    can read behind the same gate it writes through."""
    snap = await branding_repo.get_snapshot(session)
    return _to_dto(snap)


@admin_router.patch("", response_model=BrandingDTO, response_model_by_alias=True)
async def update_branding(
    body: BrandingPatch,
    admin: User = Depends(requires("system:admin")),
    session: AsyncSession = Depends(get_db_session),
):
    """Update branding fields with optimistic concurrency."""
    fields = body.model_dump(exclude={"expected_version"}, exclude_none=True)
    try:
        row = await branding_repo.update_config(
            session,
            expected_version=body.expected_version,
            updated_by=admin.id,
            **fields,
        )
    except ConflictingVersion as exc:
        raise HTTPException(status.HTTP_409_CONFLICT, str(exc))

    await _audit(session, admin.id, int(row.version or 1))
    return _to_dto(await branding_repo.get_snapshot(session))


@admin_router.post(
    "/logo", response_model=BrandingDTO, response_model_by_alias=True,
)
async def upload_logo(
    file: UploadFile = File(...),
    admin: User = Depends(requires("system:admin")),
    session: AsyncSession = Depends(get_db_session),
):
    """Upload a logo image; stored base64 in the singleton row."""
    return await _store_image(session, admin, file, kind="logo")


@admin_router.post(
    "/favicon", response_model=BrandingDTO, response_model_by_alias=True,
)
async def upload_favicon(
    file: UploadFile = File(...),
    admin: User = Depends(requires("system:admin")),
    session: AsyncSession = Depends(get_db_session),
):
    """Upload a favicon image; stored base64 in the singleton row."""
    return await _store_image(session, admin, file, kind="favicon")


async def _store_image(
    session: AsyncSession, admin: User, file: UploadFile, *, kind: str,
) -> BrandingDTO:
    mime = (file.content_type or "").lower()
    if mime not in _ALLOWED_IMAGE_MIME:
        raise HTTPException(
            status.HTTP_415_UNSUPPORTED_MEDIA_TYPE,
            detail=f"Unsupported image type '{mime}'. Allowed: "
                   f"{', '.join(sorted(_ALLOWED_IMAGE_MIME))}.",
        )
    raw = await file.read()
    if len(raw) > _MAX_UPLOAD_BYTES:
        raise HTTPException(
            status.HTTP_413_REQUEST_ENTITY_TOO_LARGE,
            detail=f"Image exceeds {_MAX_UPLOAD_BYTES // 1024} KiB limit.",
        )
    encoded = base64.b64encode(raw).decode("ascii")
    row = await branding_repo.update_config(
        session, updated_by=admin.id,
        **{f"{kind}_data": encoded, f"{kind}_mime": mime},
    )
    await _audit(session, admin.id, int(row.version or 1))
    return _to_dto(await branding_repo.get_snapshot(session))


async def _audit(session: AsyncSession, actor: str, version: int) -> None:
    """Best-effort audit event — a failed audit must not block the
    change (the row update is committed already)."""
    try:
        await user_repo.create_outbox_event(
            session, event_type="branding.updated",
            payload={"actor": actor, "version": version},
        )
    except Exception:  # noqa: BLE001
        pass
