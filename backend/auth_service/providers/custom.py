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
from typing import Optional

import jwt as pyjwt

from ..core.tokens import decode_mock_identity_token
from .base import ProviderCredentials, ProviderIdentity

logger = logging.getLogger(__name__)


class CustomIdentityError(Exception):
    """Any failure in the custom-IdP envelope (missing/bad signature,
    expired, malformed payload). Mapped to a generic 401 by the route."""


class CustomIdentityProvider:
    """Custom (cookie-mock) IdP. Registered as ``custom`` only when the
    feature flag is on (see ``providers/__init__.py``).

    Stateless. The cookie / header parsing happens here; the route just
    pulls the raw envelope string and hands it over.
    """

    name = "custom"

    def __init__(self) -> None:
        # No settings — everything is sourced from the cookie payload.
        pass

    @property
    def enabled(self) -> bool:
        # The provider is registered only when enabled, so this is True
        # whenever an instance exists. Kept on the surface for parity
        # with the OIDC / SAML providers (whose registration is
        # unconditional).
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

        external_id = _required_str(payload, "external_id")
        email = _required_str(payload, "email").lower()
        first_name = _optional_str(payload, "first_name")
        last_name = _optional_str(payload, "last_name")

        groups_raw = payload.get("groups") or []
        if not isinstance(groups_raw, (list, tuple)):
            raise CustomIdentityError("groups_must_be_list")
        groups = tuple(
            g.strip() for g in groups_raw
            if isinstance(g, str) and g.strip()
        )

        claims = payload.get("claims")
        if claims is not None and not isinstance(claims, dict):
            raise CustomIdentityError("claims_must_be_object")

        auth_time = payload.get("auth_time")
        auth_time_int: Optional[int]
        if auth_time is None:
            auth_time_int = None
        else:
            try:
                auth_time_int = int(auth_time)
            except (TypeError, ValueError):
                raise CustomIdentityError("auth_time_must_be_int")

        return ProviderIdentity(
            provider="custom",
            external_id=external_id,
            email=email,
            first_name=first_name,
            last_name=last_name,
            raw_claims={
                "claims": claims or {},
                "groups": list(groups),
                "source": "custom_mock",
            },
            groups=groups,
            auth_time=auth_time_int,
        )


def _required_str(payload: dict, key: str) -> str:
    v = payload.get(key)
    if not isinstance(v, str) or not v.strip():
        raise CustomIdentityError(f"missing_{key}")
    return v.strip()


def _optional_str(payload: dict, key: str) -> str:
    v = payload.get(key)
    if v is None:
        return ""
    if not isinstance(v, str):
        raise CustomIdentityError(f"{key}_must_be_string")
    return v.strip()
