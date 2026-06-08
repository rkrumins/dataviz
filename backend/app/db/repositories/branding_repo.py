"""Repository: ``application_branding`` (singleton).

One row per deployment carrying the white-label branding. The shape
mirrors ``app_auth_config_repo``: upsert with an optimistic ``version``
bump so two admins racing on the Branding settings page can't silently
overwrite each other.

The :func:`get_snapshot` resolver applies the ``APP_BRAND_*`` env
defaults (see ``backend.app.config.branding``) for any missing row OR
NULL column — this is the seam that makes env vars the *default* source
while the DB row *overrides* them. A bare deployment that only sets env
vars therefore renders correctly even before an admin touches the UI.
"""
from __future__ import annotations

from dataclasses import dataclass
from datetime import datetime, timezone
from typing import Optional

from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from backend.app.config.branding import get_branding_defaults
from backend.app.db.models import ApplicationBrandingORM


_SINGLETON_ID = "singleton"


@dataclass(frozen=True)
class BrandingSnapshot:
    """Resolved branding the public endpoint serves. Every field is
    non-null: NULLs in the row are filled from the env defaults."""
    app_name: str
    short_name: str
    description: str
    logo_url: str
    favicon_url: str
    accent_color: str
    copyright_text: str
    support_email: str
    login_tagline: str
    version: int
    updated_at: str


class ConflictingVersion(RuntimeError):
    """The PATCH submitted an outdated version. The admin layer turns
    this into a 409 so the FE can refresh and retry."""


def _now() -> str:
    return datetime.now(timezone.utc).isoformat()


def _coalesce(value: Optional[str], default: str) -> str:
    """DB value wins when present and non-empty; else the env default."""
    if value is None:
        return default
    value = value.strip()
    return value if value else default


async def get_row(session: AsyncSession) -> Optional[ApplicationBrandingORM]:
    result = await session.execute(
        select(ApplicationBrandingORM).where(
            ApplicationBrandingORM.id == _SINGLETON_ID
        )
    )
    return result.scalar_one_or_none()


async def get_snapshot(session: AsyncSession) -> BrandingSnapshot:
    """Resolve the branding the public endpoint serves, layering the
    DB row over the ``APP_BRAND_*`` env defaults. Falls back entirely
    to env defaults if the row is missing (defensive — the migration
    seeds it, but a partial upgrade shouldn't blank the brand).

    Logo/favicon resolve uploaded base64 data ahead of the URL: when a
    ``*_data`` blob is present it's emitted as a ``data:`` URI so the
    frontend consumes a single ``logoUrl``/``faviconUrl`` regardless of
    source.
    """
    defaults = get_branding_defaults()
    row = await get_row(session)
    if row is None:
        return BrandingSnapshot(
            app_name=defaults.app_name,
            short_name=defaults.short_name,
            description=defaults.description,
            logo_url=defaults.logo_url,
            favicon_url=defaults.favicon_url,
            accent_color=defaults.accent_color,
            copyright_text=defaults.copyright_text,
            support_email=defaults.support_email,
            login_tagline=defaults.login_tagline,
            version=0,
            updated_at="",
        )

    return BrandingSnapshot(
        app_name=_coalesce(row.app_name, defaults.app_name),
        short_name=_coalesce(row.short_name, defaults.short_name),
        description=_coalesce(row.description, defaults.description),
        logo_url=_resolve_image(
            row.logo_data, row.logo_mime, row.logo_url, defaults.logo_url
        ),
        favicon_url=_resolve_image(
            row.favicon_data, row.favicon_mime, row.favicon_url,
            defaults.favicon_url,
        ),
        accent_color=_coalesce(row.accent_color, defaults.accent_color),
        copyright_text=_coalesce(row.copyright_text, defaults.copyright_text),
        support_email=_coalesce(row.support_email, defaults.support_email),
        login_tagline=_coalesce(row.login_tagline, defaults.login_tagline),
        version=int(row.version or 1),
        updated_at=row.updated_at or "",
    )


def _resolve_image(
    data: Optional[str],
    mime: Optional[str],
    url: Optional[str],
    default_url: str,
) -> str:
    """Uploaded base64 data (as a ``data:`` URI) wins over a pasted URL,
    which wins over the env default."""
    if data and mime:
        return f"data:{mime};base64,{data}"
    return _coalesce(url, default_url)


async def update_config(
    session: AsyncSession,
    *,
    expected_version: Optional[int] = None,
    updated_by: Optional[str] = None,
    **fields: Optional[str],
) -> ApplicationBrandingORM:
    """Update one or more branding fields with optimistic concurrency.

    ``fields`` accepts any subset of the writable columns (app_name,
    short_name, description, logo_url, logo_data, logo_mime,
    favicon_url, favicon_data, favicon_mime, accent_color,
    copyright_text, support_email, login_tagline). A field passed as
    ``None`` is left unchanged; pass an empty string to clear a value.

    When ``expected_version`` is supplied and doesn't match the stored
    value, raises :class:`ConflictingVersion`.
    """
    row = await get_row(session)
    if row is None:
        # Seeder didn't run; create the singleton inline.
        row = ApplicationBrandingORM(
            id=_SINGLETON_ID, version=1, updated_at=_now(),
            updated_by=updated_by,
        )
        session.add(row)
        await session.flush()

    if (
        expected_version is not None
        and int(row.version or 1) != expected_version
    ):
        raise ConflictingVersion(
            f"version mismatch: expected {expected_version}, got {row.version}"
        )

    _WRITABLE = {
        "app_name", "short_name", "description",
        "logo_url", "logo_data", "logo_mime",
        "favicon_url", "favicon_data", "favicon_mime",
        "accent_color", "copyright_text", "support_email", "login_tagline",
    }
    for key, value in fields.items():
        if key in _WRITABLE and value is not None:
            setattr(row, key, value)

    row.version = int(row.version or 1) + 1
    row.updated_at = _now()
    row.updated_by = updated_by
    await session.flush()
    return row
