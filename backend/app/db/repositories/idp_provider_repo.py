"""Repository: ``idp_providers``.

One row per configured IdP. The settings blob is Fernet-encrypted at
rest using the same envelope as ``connection_repo`` so we only have
one key-management surface across the project.

The hot-path runtime caller is
``backend.auth_service.providers.registry`` which materialises a
provider object per row (with TTL cache). Admin CRUD comes through
``backend.app.api.v1.endpoints.admin_idp_providers``.

Secret handling rules:
  * NEVER read ``IdpProviderORM.settings`` directly. Always go through
    ``decrypt_settings()`` / ``encrypt_settings()`` so the Fernet wrap
    stays consistent.
  * Settings dicts returned to the admin UI MUST scrub secret fields
    (``client_secret``, ``sp_private_key``); use ``redact_settings()``
    on the way out.
"""
from __future__ import annotations

import json
import logging
import re
from datetime import datetime, timezone
from typing import Iterable, Optional

from sqlalchemy import delete, select
from sqlalchemy.ext.asyncio import AsyncSession

from backend.app.db.models import IdpProviderORM
# Reuse the existing Fernet helper rather than introducing a second
# envelope. ``_get_fernet`` reads CREDENTIAL_ENCRYPTION_KEY.
from backend.app.db.repositories.connection_repo import (
    _get_fernet,
    require_encryption_or_plaintext_ok,
)

logger = logging.getLogger(__name__)


VALID_KINDS = {"oidc", "saml2", "custom", "custom_profile"}
VALID_LINKING_POLICIES = {"strict", "allow_verified", "manual_only", "disabled"}

# Fields whose values must never be sent to the UI. The set is
# intentionally generous; admins rotate secrets through dedicated
# rotate endpoints, not by reading the existing value back.
_SECRET_FIELDS = frozenset({
    "client_secret",
    "sp_private_key",
    "idp_x509_cert",   # not strictly secret but redacted to discourage tampering
    "sp_x509_cert",
    "shared_secret",   # custom_profile HS256 signing key
})

_SLUG_RE = re.compile(r"^[a-z0-9][a-z0-9-]{1,62}[a-z0-9]$")


class ProviderValidationError(ValueError):
    """Reusable structured error for the admin layer to turn into 400s."""


def _now() -> str:
    return datetime.now(timezone.utc).isoformat()


def _validate_shape(
    *,
    slug: str,
    display_name: str,
    kind: str,
    linking_policy: str,
    priority: int,
) -> None:
    if not _SLUG_RE.match(slug):
        raise ProviderValidationError(
            f"slug must be 3-64 chars, lowercase alphanumerics + dashes "
            f"(not '{slug}')"
        )
    if not display_name or not display_name.strip():
        raise ProviderValidationError("display_name is required")
    if kind not in VALID_KINDS:
        raise ProviderValidationError(
            f"kind must be one of {sorted(VALID_KINDS)}, got '{kind}'"
        )
    if linking_policy not in VALID_LINKING_POLICIES:
        raise ProviderValidationError(
            f"linking_policy must be one of {sorted(VALID_LINKING_POLICIES)}, "
            f"got '{linking_policy}'"
        )
    if priority < 0 or priority > 10_000:
        raise ProviderValidationError("priority must be between 0 and 10000")


def encrypt_settings(settings: dict) -> str:
    """Serialise + Fernet-encrypt the settings dict.

    Falls back to plaintext JSON when ``CREDENTIAL_ENCRYPTION_KEY`` is
    unset — matches ``connection_repo._encrypt``. Operators MUST set
    the key in production; the fallback exists for dev/test only.
    """
    raw = json.dumps(settings, sort_keys=True)
    fernet = _get_fernet()
    if fernet is None:
        require_encryption_or_plaintext_ok()  # fail closed in prod
        logger.warning(
            "idp_providers: CREDENTIAL_ENCRYPTION_KEY unset — storing "
            "settings as plaintext JSON. DO NOT run this configuration "
            "in production."
        )
        return raw
    return fernet.encrypt(raw.encode()).decode()


def decrypt_settings(blob: Optional[str]) -> dict:
    """Inverse of ``encrypt_settings``. Returns ``{}`` for empty input
    or on decrypt failure (logged) so a malformed row does not crash
    the registry — the provider self-reports ``enabled=False`` and
    routes 404 cleanly."""
    if not blob or blob == "{}":
        return {}
    fernet = _get_fernet()
    try:
        if fernet is not None:
            return json.loads(fernet.decrypt(blob.encode()))
        return json.loads(blob)
    except Exception as exc:  # noqa: BLE001 — corrupt blob is a config error
        logger.warning("idp_providers: decrypt_settings failed: %s", exc)
        return {}


def redact_settings(settings: dict) -> dict:
    """Return a shallow copy with secret fields replaced by ``"********"``
    so the admin UI can show that *something* is configured without
    leaking the actual value. The presence of the marker also lets the
    UI know to render a "rotate secret" button instead of an edit
    box."""
    out = dict(settings)
    for key in list(out.keys()):
        if key in _SECRET_FIELDS and out[key]:
            out[key] = "********"
    return out


async def create_provider(
    session: AsyncSession,
    *,
    slug: str,
    display_name: str,
    kind: str,
    settings: dict,
    claim_mapping: Optional[dict] = None,
    linking_policy: str = "strict",
    priority: int = 100,
    enabled: bool = True,
    button_label: Optional[str] = None,
    button_icon: Optional[str] = None,
    created_by: Optional[str] = None,
) -> IdpProviderORM:
    _validate_shape(
        slug=slug, display_name=display_name, kind=kind,
        linking_policy=linking_policy, priority=priority,
    )
    row = IdpProviderORM(
        slug=slug.strip().lower(),
        display_name=display_name.strip(),
        kind=kind,
        enabled=enabled,
        priority=priority,
        settings=encrypt_settings(settings or {}),
        claim_mapping=json.dumps(claim_mapping or {}, sort_keys=True),
        linking_policy=linking_policy,
        button_label=(button_label or None) and button_label.strip(),
        button_icon=(button_icon or None) and button_icon.strip(),
        created_at=_now(),
        created_by=created_by,
        updated_at=_now(),
        updated_by=created_by,
    )
    session.add(row)
    await session.flush()
    return row


async def update_provider(
    session: AsyncSession,
    provider_id: str,
    *,
    display_name: Optional[str] = None,
    enabled: Optional[bool] = None,
    priority: Optional[int] = None,
    settings: Optional[dict] = None,
    claim_mapping: Optional[dict] = None,
    linking_policy: Optional[str] = None,
    button_label: Optional[str] = None,
    button_icon: Optional[str] = None,
    updated_by: Optional[str] = None,
) -> Optional[IdpProviderORM]:
    row = await get_provider(session, provider_id)
    if row is None:
        return None
    if display_name is not None:
        row.display_name = display_name.strip()
    if enabled is not None:
        row.enabled = enabled
    if priority is not None:
        if priority < 0 or priority > 10_000:
            raise ProviderValidationError("priority must be between 0 and 10000")
        row.priority = priority
    if linking_policy is not None:
        if linking_policy not in VALID_LINKING_POLICIES:
            raise ProviderValidationError(
                f"linking_policy must be one of {sorted(VALID_LINKING_POLICIES)}"
            )
        row.linking_policy = linking_policy
    if settings is not None:
        # Merge instead of replace so the admin UI can PATCH a single
        # secret without round-tripping every other field.
        existing = decrypt_settings(row.settings)
        merged = {**existing, **settings}
        # Sentinel: passing ``None`` for a key removes it.
        merged = {k: v for k, v in merged.items() if v is not None}
        row.settings = encrypt_settings(merged)
    if claim_mapping is not None:
        row.claim_mapping = json.dumps(claim_mapping or {}, sort_keys=True)
    if button_label is not None:
        row.button_label = (button_label or None) and button_label.strip()
    if button_icon is not None:
        row.button_icon = (button_icon or None) and button_icon.strip()
    row.updated_at = _now()
    row.updated_by = updated_by
    await session.flush()
    return row


async def get_provider(
    session: AsyncSession, provider_id: str,
) -> Optional[IdpProviderORM]:
    result = await session.execute(
        select(IdpProviderORM).where(IdpProviderORM.id == provider_id)
    )
    return result.scalar_one_or_none()


async def get_provider_by_slug(
    session: AsyncSession, slug: str,
) -> Optional[IdpProviderORM]:
    result = await session.execute(
        select(IdpProviderORM).where(IdpProviderORM.slug == slug.lower())
    )
    return result.scalar_one_or_none()


async def list_providers(
    session: AsyncSession,
    *,
    only_enabled: bool = False,
    kinds: Optional[Iterable[str]] = None,
) -> list[IdpProviderORM]:
    stmt = select(IdpProviderORM)
    if only_enabled:
        stmt = stmt.where(IdpProviderORM.enabled.is_(True))
    if kinds:
        stmt = stmt.where(IdpProviderORM.kind.in_(list(kinds)))
    stmt = stmt.order_by(
        IdpProviderORM.priority.asc(), IdpProviderORM.slug.asc()
    )
    result = await session.execute(stmt)
    return list(result.scalars().all())


async def delete_provider(
    session: AsyncSession, provider_id: str,
) -> bool:
    """Hard-delete a provider. The FK on ``user_identities.provider_id``
    is RESTRICT, so this fails when any user is linked to the
    provider — admins must unlink first. The mapping FK is CASCADE so
    derived group mappings clean up automatically."""
    result = await session.execute(
        delete(IdpProviderORM).where(IdpProviderORM.id == provider_id)
    )
    return (result.rowcount or 0) > 0


def parse_claim_mapping(row: IdpProviderORM) -> dict:
    """Decode the ``claim_mapping`` JSON column. Returns ``{}`` on
    parse failure so a malformed value reverts to the kind's defaults
    (handled by ``claim_mapper.apply_claim_mapping``)."""
    raw = row.claim_mapping or "{}"
    try:
        data = json.loads(raw)
    except (ValueError, TypeError):
        logger.warning(
            "idp_providers: provider %s has invalid claim_mapping JSON; "
            "falling back to defaults", row.id,
        )
        return {}
    return data if isinstance(data, dict) else {}
