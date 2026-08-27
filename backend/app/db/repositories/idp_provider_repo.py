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


VALID_KINDS = {"oidc", "saml2", "custom", "custom_profile", "backchannel"}
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
    "jwt_shared_secret",  # backchannel HS256 verification key
    # NOT jwt_public_key: a PEM public key is not a secret, and hiding
    # it would only stop operators comparing what they pasted.
    # Whole dicts, not individual keys inside them: a backchannel row
    # puts whatever its gateway wants into these — an app id, a client
    # secret, an API key — and we cannot know which of an operator's
    # own header names is the sensitive one. Redacting the container is
    # the only rule that holds for a shape we do not control.
    "gateway_headers",
    "exchange_headers",
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


def validate_button_icon(icon: Optional[str]) -> None:
    """Refuse an icon the login page could never render.

    The app serves ``img-src 'self' data: blob:`` (see
    ``middleware/security_headers.py``), so a ``https://cdn.example/logo.png``
    is silently blocked by the browser and the operator sees a broken image
    with nothing explaining why. Better to refuse it here, where we can say
    so, than to store a value that cannot work.

    A remote URL would also make every anonymous hit on the login page fetch
    a third-party asset, handing that third party the IP of everyone who
    loads it — not something to enable by accident on an internal
    deployment.
    """
    if not icon:
        return
    value = icon.strip()
    if value.startswith("data:image/"):
        return
    if value.startswith("/") and not value.startswith("//"):
        return
    raise ProviderValidationError(
        "button_icon must be a data: image URI or a same-origin path "
        "starting with '/'. Remote URLs are blocked by the app's "
        "Content-Security-Policy (img-src 'self' data: blob:) and would "
        "render as a broken image."
    )


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


REDACTION_MARKER = "********"


def redact_settings(settings: dict) -> dict:
    """Return a shallow copy with secret fields replaced by
    ``REDACTION_MARKER`` so the admin UI can show that *something* is
    configured without leaking the actual value. The presence of the marker
    also lets the UI know to render a "rotate secret" button instead of an
    edit box."""
    out = dict(settings)
    for key in list(out.keys()):
        if key in _SECRET_FIELDS and out[key]:
            out[key] = REDACTION_MARKER
    return out


def _reject_redaction_marker(settings: dict) -> None:
    """Refuse a write that would store the redaction marker as a real value.

    ``redact_settings`` puts ``"********"`` on the wire for every secret
    field, and ``update_provider`` MERGES settings — so the natural
    GET-mutate-PATCH round-trip a script or Terraform provider performs would
    write the mask over the actual secret and silently brick that IdP. The
    admin UI strips these client-side, but a client-side guard is not an
    invariant. 400 is the right answer: it tells the caller to omit the field
    (keep the existing secret) or send a new value (rotate it).
    """
    offenders = sorted(
        k for k, v in settings.items()
        if k in _SECRET_FIELDS and v == REDACTION_MARKER
    )
    if offenders:
        raise ProviderValidationError(
            f"settings {offenders} still hold the redaction marker "
            f"'{REDACTION_MARKER}'. Omit a secret field to keep its stored "
            "value, or send a new value to rotate it."
        )


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
    email_domains: Optional[list] = None,
    lifecycle: str = "live",
    created_by: Optional[str] = None,
) -> IdpProviderORM:
    _validate_shape(
        slug=slug, display_name=display_name, kind=kind,
        linking_policy=linking_policy, priority=priority,
    )
    # Also guarded on create: cloning an existing provider by GET-then-POST is
    # the other obvious way to store the mask as a real secret.
    _reject_redaction_marker(settings or {})
    validate_button_icon(button_icon)
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
        email_domains=_encode_domains(email_domains),
        # Defaults LIVE, and the admin endpoint overrides it to "draft".
        #
        # The policy "a provider a human just created is unproven" belongs at
        # the human boundary, not here. The boot seeder (main.py) migrates
        # env-var deployments into rows, and those are already serving
        # traffic — defaulting to draft here would silently switch SSO off
        # for every existing env-based deployment on upgrade, which is the
        # same failure the migration's server_default='live' avoids.
        lifecycle=lifecycle,
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
    email_domains: Optional[list] = None,
    updated_by: Optional[str] = None,
) -> Optional[IdpProviderORM]:
    row = await get_provider(session, provider_id)
    if row is None:
        return None
    if display_name is not None:
        # Same rule as creation, which refuses a blank one. Without this
        # an edit could empty the field a create could not, and the login
        # page would be left with nothing to call the connection but its
        # slug.
        if not display_name.strip():
            raise ProviderValidationError("display_name is required")
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
        _reject_redaction_marker(settings)
        # Merge instead of replace so the admin UI can PATCH a single
        # secret without round-tripping every other field.
        existing = decrypt_settings(row.settings)
        merged = {**existing, **settings}
        # Sentinel: passing ``None`` for a key removes it.
        merged = {k: v for k, v in merged.items() if v is not None}
        row.settings = encrypt_settings(merged)
    if claim_mapping is not None:
        row.claim_mapping = json.dumps(claim_mapping or {}, sort_keys=True)
    # An empty (or blank) string CLEARS these two; ``None`` means "not
    # in this PATCH". The distinction matters: the editor's clear-it
    # affordance is blanking the field, and a null that reads as
    # omitted made the old label immortal.
    if button_label is not None:
        row.button_label = button_label.strip() or None
    if button_icon is not None:
        validate_button_icon(button_icon)
        row.button_icon = button_icon.strip() or None
    if email_domains is not None:
        row.email_domains = _encode_domains(email_domains)
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


async def list_public_providers(
    session: AsyncSession,
) -> list[IdpProviderORM]:
    """Providers the outside world may see: enabled AND published.

    The one definition of "public", so the answer cannot drift between the
    login catalog, the login-context endpoint and email-domain routing. A
    provider is visible only when BOTH are true:

      * ``enabled``   — the operational switch, off during an incident.
      * ``lifecycle == 'live'`` — readiness, set by an explicit publish.

    A draft is fully rehearsable through the dry-run but reaches no
    unauthenticated surface, which is what makes "configure it, prove it,
    then publish it" safe rather than aspirational.
    """
    rows = await list_providers(session, only_enabled=True)
    return [r for r in rows if getattr(r, "lifecycle", "live") == "live"]


async def publish_provider(
    session: AsyncSession, provider_id: str, *, updated_by: Optional[str] = None,
) -> Optional[IdpProviderORM]:
    """Promote a draft to live. Idempotent — publishing a live provider is
    a no-op rather than an error, so a double-click cannot fail."""
    row = await get_provider(session, provider_id)
    if row is None:
        return None
    row.lifecycle = "live"
    row.updated_at = _now()
    row.updated_by = updated_by
    await session.flush()
    return row


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

# ── Email-domain routing (Home Realm Discovery) ──────────────────────


def _encode_domains(domains: Optional[list]) -> Optional[str]:
    """Normalise and store as a JSON array. Strips a leading ``@`` and
    lower-cases, so ``@Corp.Example`` and ``corp.example`` are one thing."""
    if domains is None:
        return None
    cleaned = sorted({
        d.strip().lower().lstrip("@")
        for d in domains if isinstance(d, str) and d.strip()
    })
    return json.dumps(cleaned)


def parse_email_domains(row) -> list[str]:
    """Domains that route to this provider, lower-cased. Tolerant of a
    malformed blob — a bad value must not break the login page."""
    raw = getattr(row, "email_domains", None)
    if not raw:
        return []
    try:
        parsed = json.loads(raw)
    except (ValueError, TypeError):
        return []
    if not isinstance(parsed, list):
        return []
    return [d.strip().lower().lstrip("@") for d in parsed
            if isinstance(d, str) and d.strip()]


async def find_by_email_domain(
    session: AsyncSession, domain: str,
) -> Optional[IdpProviderORM]:
    """The enabled provider claiming *domain*, or None.

    Scans the enabled set rather than querying by predicate: the row count
    is small (a handful of IdPs), and a LIKE against a JSON blob would be
    both slower to reason about and wrong on substrings —
    ``corp.example.com`` must not match a provider claiming ``example.com``.
    """
    needle = (domain or "").strip().lower().lstrip("@")
    if not needle:
        return None
    rows = await list_public_providers(session)
    for row in rows:
        if needle in parse_email_domains(row):
            return row
    return None


# ── Last assertion (claim-mapping aid) ───────────────────────────────


#: Claim names whose values are never useful for mapping and are worth not
#: keeping. The identity claims themselves ARE the point and are retained.
_ASSERTION_REDACT_HINTS = (
    "token", "secret", "password", "assertion", "credential", "signature",
)


def redact_assertion(claims: dict) -> dict:
    """Drop credential-shaped values before storing an assertion.

    An operator maps ``employeeId`` and ``emailAddress``; nobody maps an
    embedded access token. Keys are kept so the shape stays visible —
    only the value is replaced.
    """
    out: dict = {}
    for key, value in (claims or {}).items():
        lowered = str(key).lower()
        if any(hint in lowered for hint in _ASSERTION_REDACT_HINTS):
            out[key] = "********"
        elif isinstance(value, dict):
            out[key] = redact_assertion(value)
        else:
            out[key] = value
    return out


async def record_last_assertion(
    session: AsyncSession, provider_id: str, claims: dict,
) -> None:
    """Store the most recent assertion, encrypted at rest.

    Reuses the ``settings`` Fernet envelope: this is identity data about a
    real person and must not sit in the clear next to it.
    """
    row = await get_provider(session, provider_id)
    if row is None:
        return
    row.last_assertion = encrypt_settings(redact_assertion(claims or {}))
    row.last_assertion_at = _now()


async def read_last_assertion(
    session: AsyncSession, provider_id: str,
) -> tuple[Optional[dict], Optional[str]]:
    """Decrypt the stored assertion. Returns ``(claims, captured_at)``."""
    row = await get_provider(session, provider_id)
    if row is None or not row.last_assertion:
        return None, None
    return decrypt_settings(row.last_assertion), row.last_assertion_at
