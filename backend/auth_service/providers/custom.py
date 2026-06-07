"""
Custom identity provider — dev/demo mock that surfaces AD-style attributes
from a signed cookie / header.

Purpose: validate the JIT-provisioning + group->role-reconciliation path
end-to-end without standing up a real IdP. The cookie/header payload
simulates what a corporate IdP (or an attribute-injecting reverse proxy
in front of the app) would assert about the user:

    {
        "external_id": "S-1-5-21-...-1001",
        "email":       "alice@corp.example",
        "first_name":  "Alice",
        "last_name":   "Doe",
        "claims":      { "department": "Eng", "title": "Staff Eng" },
        "groups":      ["DataViz-Admins", "Eng-All"],
        "auth_time":   1729712345
    }

The envelope is signed with the platform JWT secret (HS256, 10-min TTL)
so a casual hand-rolled cookie can't masquerade as a user. The provider
is *additionally* hard-gated by ``AUTH_CUSTOM_PROVIDER_ENABLED`` and the
``ENV`` prod-guard in ``core/config.py`` — even with a valid signature
the routes 404 in production. Treat this as a **dev/test seam**; never
ship it enabled.

The HTTP routes live in ``api/router.py`` under
``/api/v1/auth/custom/{login,mock}``.
"""
from __future__ import annotations

import logging
from dataclasses import dataclass, field
from typing import Optional

import jwt as pyjwt

from ..core.tokens import decode_mock_identity_token
from .base import ProviderCredentials, ProviderIdentity
from .claim_mapper import apply_claim_mapping, ClaimMappingError
from .registry import ProviderConfigSnapshot

logger = logging.getLogger(__name__)


class CustomIdentityError(Exception):
    """Any failure in the custom-IdP envelope (missing/bad signature,
    expired, malformed payload). Mapped to a generic 401 by the route."""


@dataclass(frozen=True)
class CustomSettings:
    """Per-provider settings for the dev/demo Custom IdP. The claim
    mapping override carries through to ``apply_claim_mapping`` like
    the other kinds. No actual secrets — the envelope signature uses
    the platform ``JWT_SECRET_KEY``."""
    provider_id: str = "test-custom"
    provider_slug: str = "default-custom"
    claim_mapping_override: dict = field(default_factory=dict)
    linking_policy: str = "strict"


def settings_from_snapshot(snap: ProviderConfigSnapshot) -> CustomSettings:
    return CustomSettings(
        provider_id=snap.id,
        provider_slug=snap.slug,
        claim_mapping_override=snap.claim_mapping or {},
        linking_policy=snap.linking_policy,
    )


class CustomIdentityProvider:
    """Custom (cookie-mock) IdP. Registered as ``custom`` only when the
    feature flag is on (see ``providers/__init__.py``).

    Stateless. The cookie / header parsing happens here; the route just
    pulls the raw envelope string and hands it over.
    """

    name = "custom"

    def __init__(self, settings: CustomSettings | None = None) -> None:
        self._s = settings or CustomSettings()

    @property
    def settings(self) -> CustomSettings:
        return self._s

    @property
    def slug(self) -> str:
        return self._s.provider_slug

    @property
    def provider_id(self) -> str:
        return self._s.provider_id

    @property
    def enabled(self) -> bool:
        return True

    # ── IdentityProvider protocol ────────────────────────────────────
    async def authenticate(
        self, credentials: ProviderCredentials, *, get_user_by_email,
    ) -> Optional[ProviderIdentity]:
        return None

    # ── Envelope -> ProviderIdentity ─────────────────────────────────

    def fetch_identity(self, token: str) -> ProviderIdentity:
        """Validate the signed envelope and return a verified identity.

        Raises ``CustomIdentityError`` on any failure.
        """
        try:
            payload = decode_mock_identity_token(token)
        except pyjwt.ExpiredSignatureError as exc:
            raise CustomIdentityError("envelope_expired") from exc
        except pyjwt.InvalidTokenError as exc:
            raise CustomIdentityError(f"envelope_invalid:{exc}") from exc

        if not isinstance(payload, dict):
            raise CustomIdentityError("envelope_malformed")

        # Hoist the operator's "claims" dict into the top-level claims
        # namespace so the configurable mapper can reach it via the
        # same path syntax as OIDC. Then delegate every field
        # extraction to apply_claim_mapping.
        claims = {**payload}
        nested = payload.get("claims")
        if isinstance(nested, dict):
            for k, v in nested.items():
                claims.setdefault(k, v)

        try:
            return apply_claim_mapping(
                claims,
                kind="custom",
                provider_slug=self._s.provider_slug,
                override=self._s.claim_mapping_override,
            )
        except ClaimMappingError as exc:
            raise CustomIdentityError(str(exc)) from exc


def build_custom_provider(snap: ProviderConfigSnapshot) -> CustomIdentityProvider:
    """Factory for the registry."""
    return CustomIdentityProvider(settings_from_snapshot(snap))
