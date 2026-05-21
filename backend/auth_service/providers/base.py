"""
Identity provider protocol — the seam where SSO/SAML2/OIDC integrations
plug in. The local username+password provider is one implementation; SSO
providers will be added as separate modules and registered in
``providers/__init__.py``.

A provider's job is narrow: given some credentials (or a callback from an
external IdP), confirm the identity and return enough information for the
``IdentityService`` to look up or provision the corresponding ``User``.
"""
from __future__ import annotations

from dataclasses import dataclass, field
from typing import Optional, Protocol, runtime_checkable


@dataclass(frozen=True)
class ProviderCredentials:
    """Credentials handed to a provider's ``authenticate`` call.

    For ``local``: email + password are populated.
    For ``oidc`` / ``saml2`` / ``custom``: ``external_token`` carries
    the ID token / SAML response / signed envelope; ``email`` /
    ``password`` are unused.
    """
    email: Optional[str] = None
    password: Optional[str] = None
    external_token: Optional[str] = None


@dataclass(frozen=True)
class ProviderIdentity:
    """The minimal identity payload a provider returns on success.

    ``IdentityService`` uses this to find or provision the matching
    ``UserORM`` row (matched on ``provider`` + ``external_id`` for SSO,
    or on ``email`` for local).

    ``groups`` is the list of IdP-asserted group memberships at this
    login (OIDC ``groups`` claim, SAML group attribute, or custom
    payload). The auth service persists it on the user row and feeds
    it to the group->role reconciler so RoleBindings track what the
    IdP currently says. Empty when the provider can't or won't supply
    groups.

    ``auth_time`` (epoch seconds) is the provider-attested moment the
    user actually authenticated. Used to enforce the 24h SSO re-auth
    ceiling on every /refresh. ``None`` for local password sessions.
    """
    provider: str          # 'local' | 'oidc' | 'saml2' | 'custom' | ...
    external_id: str       # for SSO: the IdP-assigned subject; for local: the user_id
    email: str
    first_name: str
    last_name: str
    raw_claims: dict       # full IdP claims for audit / metadata storage
    groups: tuple[str, ...] = field(default_factory=tuple)
    auth_time: Optional[int] = None


@runtime_checkable
class IdentityProvider(Protocol):
    """Pluggable per-protocol authenticator.

    Implementations live in sibling modules (``local.py``, future ``oidc.py``,
    ``saml2.py``) and are registered in ``providers/__init__.py``.
    """

    name: str  # 'local', 'oidc', 'saml2', ...

    async def authenticate(
        self, credentials: ProviderCredentials, *, get_user_by_email,
    ) -> Optional[ProviderIdentity]:
        """Verify the credentials and return the asserted identity.

        Returns ``None`` when authentication fails (wrong password,
        invalid token, etc.). Never raises for bad credentials — that
        decision is the service layer's to surface as a user-facing
        error after constant-time checks complete.

        ``get_user_by_email`` is an injected callable so providers don't
        need to import the repository directly.
        """
        ...
